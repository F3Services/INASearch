#!/usr/bin/env node
"use strict";

// Reproducible, occurrence-level audit of the current INA display renderer.
// The large inventories remain in ignored tmp/ directories. This script only
// emits compact findings and checksums under tools/ina-display-audits.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "../..");
const priorFlagFiles = [
  "sources/legal/luna-audit-usc-operative-cycle11-flags.tsv",
  "sources/legal/luna-audit-cfr-cycle11-flags.tsv",
  "sources/legal/luna-audit-usc-notes-cycle11-flags.tsv"
].map(file => path.join(root, file));

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map(JSON.parse);
}
function target(ref) {
  const family = ref.family || "unknown";
  if (family === "public-law") return `public-law:${ref.targetCongress || ""}-${ref.targetLaw || ""}/${(ref.targetPath || []).join("/")}`;
  if (family === "statutes-at-large") return `statutes-at-large:${ref.targetVolume || ""}/${ref.targetPage || ""}/${(ref.targetPath || []).join("/")}`;
  return `${family}:${ref.targetTitle || ""}:${ref.targetSection || ""}/${(ref.targetPath || []).join("/")}`;
}
function targetWithResolution(ref) { return `${target(ref)} (${ref.resolution || "unknown"})`; }
function fieldKey(row) { return `${row.sourceId}\t${row.sourcePath}`; }
function parseFlags(file) {
  return fs.readFileSync(file, "utf8").trim().split(/\n/).slice(1).map(line => {
    const [sourceId, sourcePath, offset, text, currentTarget, verdict, proposedTarget, rationale] = line.split("\t");
    return { sourceId, sourcePath, offset: Number(offset), text, currentTarget, verdict, proposedTarget, rationale, priorFile: path.relative(root, file) };
  });
}
function mapPriorFlags(records) {
  const byKey = new Map(records.map(row => [fieldKey(row), row]));
  const flags = [], skipped = [];
  for (const file of priorFlagFiles) for (const old of parseFlags(file)) {
    const row = byKey.get(`${old.sourceId}\t${old.sourcePath}`);
    const span = row && row.original.slice(old.offset, old.offset + old.text.length) === old.text;
    // A later renderer may wrap the same source occurrence in a larger link
    // (for example, "Section 101(a)(27)(I) (i)"). Treat any overlapping
    // generated reference as covering the old candidate, then compare the
    // enclosing target. This prevents stale missing-link rows from being
    // carried forward after a wrapper was added.
    const overlapping = span && row.references.filter(item => item.start < old.offset + old.text.length && item.end > old.offset);
    const ref = overlapping && (overlapping.find(item => item.start === old.offset && item.text === old.text) || overlapping[0]);
    const priorTarget = old.currentTarget.replace(/ \((?:local|official-source-only)\)$/, "");
    const targetStillMatches = ref ? target(ref) === priorTarget : false;
    const explicitlyMissing = span && overlapping && overlapping.length === 0 && /^(?:none|UNLINKED)/i.test(old.currentTarget);
    if (span && (targetStillMatches || explicitlyMissing)) {
      flags.push({
        scope: row.scope, sourceId: old.sourceId, sourcePath: old.sourcePath, field: row.field,
        start: old.offset, end: old.offset + old.text.length, text: old.text,
        context: row.original.slice(Math.max(0, old.offset - 180), Math.min(row.original.length, old.offset + old.text.length + 180)).replace(/\s+/g, " ").trim(),
        currentTarget: ref ? targetWithResolution(ref) : "none (no generated link)",
        verdict: old.verdict, proposedTarget: old.proposedTarget, rationale: old.rationale,
        carriedFrom: old.priorFile
      });
    } else skipped.push({ ...old, reason: !row ? "field absent" : !span ? "source text/offset changed" : ref ? "target corrected" : "not a missing-link row" });
  }
  return { flags, skipped };
}

// Prior Luna flags are useful candidate seeds, but several were intentionally
// superseded by later renderer work or were conservative review notes. Keep
// the durable result limited to independently confirmed, occurrence-level
// defects found in the frozen inventory.
function confirmedFlags(records) {
  const flags = [];
  const add = (row, start, text, currentTarget, verdict, proposedTarget, rationale) => flags.push({
    scope: row.scope, sourceId: row.sourceId, sourcePath: row.sourcePath,
    field: row.field, start, end: start + text.length, text,
    context: row.original.slice(Math.max(0, start - 180), Math.min(row.original.length, start + text.length + 180)).replace(/\s+/g, " ").trim(),
    currentTarget, verdict, proposedTarget, rationale
  });
  for (const row of records) {
    // In INA 212(a)(2)(C)(iii), the four occurrences of clause (i)/(ii) are
    // internal cross-references. The trailing title-38 citation applies only
    // to section 1304, so inheriting its target onto these clauses is wrong.
    if (row.sourceId === "8-1612-a-2-C-iii" || row.sourceId === "8-1612-b-2-C-iii") {
      for (const ref of row.references.filter(ref => ref.targetTitle === "38" && ref.targetSection === "1304" && (ref.targetPath || []).length === 1 && ["i", "ii"].includes(ref.targetPath[0]))) {
        add(row, ref.start, ref.text, targetWithResolution(ref), "incorrect-target", `usc:8:1612/${row.sourceId.includes("-b-") ? "b" : "a"}/2/C/${ref.text.slice(1, -1)}`,
          "Clause (i)/(ii) refers to the preceding clauses in the same Title 8 subparagraph; the phrase qualifying the surviving spouse ends with the separate section 1304 of title 38 citation. The generated title-38 target incorrectly captures the internal clause reference.");
      }
    }
    // CFR § 240.66 and § 1240.66 contain an explicit statutory citation
    // section 212(a)(2), followed by a separate deportability list. The old
    // greedy Act suffix candidate left its (a)(2) occurrence unlinked.
    if ((row.sourceId === "cfr-8:240.66" || row.sourceId === "cfr-8:1240.66") && /blocks\[2\]$/.test(row.sourcePath)) {
      const start = row.original.indexOf("(a)(2)");
      const covered = start >= 0 && row.references.some(ref => ref.start < start + 6 && ref.end > start);
      if (start >= 0 && !covered) add(row, start, "(a)(2)", "none (no generated link)", "missing-link", "ina:8:1182/a/2 (local)",
        "The source text expressly cites section 212(a)(2) of the Act. No generated reference covers the parenthetical, while the following section 237 list is a separate authority.");
    }
    // This quoted former section 106 reference is followed by “such section”
    // continuations. They must retain former 8 U.S.C. 1105a and official-only
    // resolution; resolving the continuations into current 8 U.S.C. 1101 is
    // a historical-context error.
    if (row.sourceId === "8-1101-note-17") {
      for (const start of [4391, 4513, 4521]) {
        const ref = row.references.find(ref => ref.start === start);
        if (!ref) continue;
        const expectedPath = start === 4391 ? ["b"] : [start === 4513 ? "a" : "c"];
        if (ref.targetSection !== "1105a" || ref.resolution !== "official-source-only") add(row, start, ref.text, targetWithResolution(ref), "incorrect-resolution", `usc:8:1105a/${expectedPath.join("/")} (official-source-only)`,
          "The surrounding House text identifies former 8 U.S.C. 1105a and then refers to “such section”; the continuation must inherit that former section and remain official-source-only.");
      }
    }
  }
  return flags;
}

function statutePaths(corpus) {
  const sections = new Set((corpus.title8?.sections || []).map(section => String(section.section)));
  const paths = new Set();
  for (const section of corpus.title8?.sections || []) {
    const visit = (nodes, parent = []) => { for (const node of nodes || []) { const p = [...parent, String(node.label)]; paths.add(`${section.section}/${p.join("/")}`); visit(node.children, p); } };
    visit(section.body);
  }
  return { sections, paths };
}

function cfrPaths(corpus) {
  const sections = new Set(), paths = new Set();
  const tokens = value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  const visit = (value, title, section) => {
    if (!value || typeof value !== "object") return;
    if (value.id && value.title && value.section) sections.add(`${value.title}:${value.section}`);
    for (const token of tokens(value.a)) paths.add(`${title}:${section}/${token}`);
    for (const unit of value.u || []) for (const token of tokens(unit.a)) paths.add(`${title}:${section}/${token}`);
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child, title, section);
  };
  for (const record of [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])]) {
    const section = String(record.section || record.id || "").replace(/^\d+:/, "");
    sections.add(`${record.title}:${section}`); visit(record, record.title, section);
  }
  return { sections, paths };
}

function crosswalkMap(corpus) {
  const byUsc = new Map(), byIna = new Map();
  for (const row of corpus.inaCrosswalk || []) { byUsc.set(String(row.uscSection).toLowerCase(), row); byIna.set(String(row.inaSection).toLowerCase(), row); }
  return { byUsc, byIna };
}

function audit(inventoryFile, artifactFile, baselineFile) {
  const records = readJsonl(inventoryFile);
  const corpus = require("../audit-inline-references").readArtifact(artifactFile);
  const statute = statutePaths(corpus), cfr = cfrPaths(corpus), maps = crosswalkMap(corpus);
  const counts = { fields: records.length, references: 0, links: 0, groups: {}, changedFields: 0 };
  const checks = { spanMismatch: 0, linkCountMismatch: 0, linkSourceMismatch: 0, linkTargetMismatch: 0, linkFamilyMismatch: 0, groupMismatch: 0, baselineReferenceChanges: 0 };
  const details = [];
  const add = (kind, row, extra) => details.push({ kind, sourceId: row.sourceId, sourcePath: row.sourcePath, field: row.field, ...extra });
  for (const row of records) {
    counts.references += row.references.length; counts.links += row.links.length; if (row.displayed !== row.original) counts.changedFields++;
    for (const group of row.groups) counts.groups[group.grammar] = (counts.groups[group.grammar] || 0) + 1;
    if (row.links.length !== row.references.length) { checks.linkCountMismatch++; add("link-count", row, { references: row.references.length, links: row.links.length }); }
    for (let i = 0; i < row.references.length; i++) {
      const ref = row.references[i], link = row.links[i];
      if (row.original.slice(ref.start, ref.end) !== ref.text) { checks.spanMismatch++; add("reference-span", row, { start: ref.start, text: ref.text }); }
      if (!link || link.sourceText !== ref.text) { checks.linkSourceMismatch++; add("link-source", row, { index: i, reference: ref.text, link: link?.sourceText || null }); continue; }
      let linkPath; try { linkPath = JSON.parse(link.path || "[]"); } catch { linkPath = null; }
      if (link.family !== ref.family) { checks.linkFamilyMismatch++; add("link-family", row, { index: i, reference: ref.family, link: link.family }); }
      if (String(link.section || "") !== String(ref.targetSection || "") || JSON.stringify(linkPath) !== JSON.stringify(ref.targetPath || [])) {
        checks.linkTargetMismatch++; add("link-target", row, { index: i, text: ref.text, reference: target(ref), link: `${link.family}:${link.section}/${link.path}` });
      }
    }
    for (const group of row.groups) {
      const members = row.references.filter(ref => ref.start >= group.start && ref.end <= group.end);
      if (!group.labels || group.labels.length !== members.length || group.text !== row.original.slice(group.start, group.end)) { checks.groupMismatch++; add("group-integrity", row, { start: group.start, text: group.text, labels: group.labels, members: members.length }); }
    }
  }
  if (baselineFile) {
    const baseline = readJsonl(baselineFile), n = Math.min(records.length, baseline.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(records[i].references) !== JSON.stringify(baseline[i].references)) checks.baselineReferenceChanges++;
  }
  const mapped = mapPriorFlags(records);
  return { inventory: { file: path.relative(root, inventoryFile), sha256: sha256(inventoryFile) }, artifact: { file: path.relative(root, artifactFile), sha256: sha256(artifactFile) }, baseline: baselineFile ? { file: path.relative(root, baselineFile), sha256: sha256(baselineFile) } : null, counts, checks, details, flags: confirmedFlags(records), priorCandidateCount: mapped.flags.length, skippedPriorFlags: mapped.skipped };
}

if (require.main === module) {
  const inventory = path.resolve(process.argv[2] || path.join(root, "tmp/ina-display-cycle4-frozen/display.jsonl"));
  const artifact = path.resolve(process.argv[3] || path.join(root, "INASearch-Uncompressed.html"));
  const baseline = process.argv[4] ? path.resolve(process.argv[4]) : path.join(root, "tmp/ina-display-cycle1-frozen/display.jsonl");
  const result = audit(inventory, artifact, baseline);
  const out = path.resolve(process.argv[5] || path.join(__dirname, "new-flags-cycle1.json"));
  fs.writeFileSync(out, JSON.stringify(result.flags, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ...result, flags: undefined }, null, 2) + "\n");
}

module.exports = { audit, mapPriorFlags };
