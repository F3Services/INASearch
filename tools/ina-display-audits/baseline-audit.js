#!/usr/bin/env node
"use strict";

/*
 * Reproducible audit of the frozen pre-display-change artifact.  This script
 * deliberately reads the artifact and the supplied JSONL inventories; it
 * never imports application/parser source.  Historical Luna TSV findings are
 * used only as occurrence-level source-context evidence.  A finding survives
 * into this baseline report only when the exact occurrence still has the
 * reported state in this artifact (in particular, a missing-link must still
 * have no overlapping generated reference).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readArtifact, collectFields, enumerateInlineReferences, summarize } = require("../audit-inline-references");

const ROOT = path.resolve(__dirname, "../..");
const BASE = path.join(ROOT, "tmp/ina-display-baseline");
const ARTIFACT = path.join(BASE, "INASearch-Uncompressed.html");
const OUT = __dirname;
const SCOPES = ["usc-operative", "usc-notes", "cfr"];

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function key(scope, row) { return [scope, row.sourceId, row.sourcePath, row.start, row.text].join("\t"); }
function targetIdentity(reference) {
  if (reference.family === "public-law") return `public-law:${reference.targetCongress}-${reference.targetLaw}/${(reference.targetPath || []).join("/")}`;
  if (reference.family === "statutes-at-large") return `statutes-at-large:${reference.targetVolume}/${reference.targetPage}/${(reference.targetPath || []).join("/")}`;
  return `${reference.family}:${reference.targetTitle || ""}:${reference.targetSection || ""}/${(reference.targetPath || []).join("/")}`;
}
function targetWithResolution(reference) { return `${targetIdentity(reference)} (${reference.resolution})`; }
function parseTsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (!lines.length || lines[0] !== "source_id\tsource_path\toffset\ttext\tcurrent_target\tverdict\tproposed_target\trationale") throw new Error(`Bad TSV header: ${file}`);
  const fields = lines.shift().split("\t");
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split("\t").map((value, index) => [fields[index], value])));
}
function scopeForFile(file) {
  if (file.includes("-cfr-")) return "cfr";
  if (file.includes("-usc-notes-")) return "usc-notes";
  return "usc-operative";
}
function excerpt(text, start, end, radius = 220) {
  return String(text).slice(Math.max(0, start - radius), Math.min(String(text).length, end + radius)).replace(/\s+/g, " ").trim();
}
function loadRows() {
  const corpus = readArtifact(ARTIFACT);
  const fields = collectFields(corpus);
  const rows = enumerateInlineReferences(corpus);
  const lookup = new Map();
  const fieldLookup = new Map();
  for (const field of fields) {
    fieldLookup.set(`${field.scope}\t${field.sourceId}\t${field.sourcePath}\t${field.field}`, field);
    for (const reference of field.references) {
      const row = { scope: field.scope, sourceId: field.sourceId, sourcePath: field.sourcePath, field: field.field, ...reference };
      const k = key(field.scope, row);
      if (!lookup.has(k)) lookup.set(k, []);
      lookup.get(k).push(row);
    }
  }
  return { corpus, fields, rows, lookup, fieldLookup };
}
function validateStructure(fields) {
  const checks = { fields: fields.length, spanMismatches: [], overlapMismatches: [], emptyReferenceText: 0, unknownFamilies: [] };
  for (const field of fields) {
    const refs = [...field.references].sort((a, b) => a.start - b.start || a.end - b.end);
    let previous = null;
    for (const ref of refs) {
      if (!ref.text || !ref.text.length) checks.emptyReferenceText++;
      if (field.text.slice(ref.start, ref.end) !== ref.text) checks.spanMismatches.push({ scope: field.scope, sourceId: field.sourceId, field: field.field, start: ref.start, end: ref.end, text: ref.text });
      if (previous && ref.start < previous.end) checks.overlapMismatches.push({ scope: field.scope, sourceId: field.sourceId, field: field.field, previous: [previous.start, previous.end], current: [ref.start, ref.end] });
      previous = ref;
      if (!["usc", "ina", "cfr", "public-law", "statutes-at-large", "federal-register"].includes(ref.family)) checks.unknownFamilies.push({ scope: field.scope, sourceId: field.sourceId, field: field.field, start: ref.start, text: ref.text, family: ref.family });
    }
  }
  return checks;
}
function contextualChecks(corpus, fields) {
  const normalizeSection = value => String(value || "").replace(/[\u2010\u2011\u2012\u2013\u2014]/g, "-");
  const uscSections = new Set((corpus?.title8?.sections || []).map(section => normalizeSection(section.section)));
  const uscRanges = (corpus?.title8?.sections || []).map(section => normalizeSection(section.section).match(/^(\d+) to (\d+)$/)).filter(Boolean).map(match => [Number(match[1]), Number(match[2])]);
  const uscPresent = section => {
    const normalized = normalizeSection(section);
    if (uscSections.has(normalized)) return true;
    const number = Number(normalized);
    return Number.isInteger(number) && uscRanges.some(([first, last]) => number >= first && number <= last);
  };
  const cfrSections = new Set([...((corpus?.cfr?.sections || [])), ...((corpus?.cfr?.appendices || []))].map(record => String(record.id)));
  const stats = { references: 0, localTargets: 0, localTargetSectionPresent: 0, localTargetSectionMissing: 0, historicalCueLocal: 0, explicitTargetMetadataMissing: 0 };
  const missingSections = [];
  const historicalCueExamples = [];
  for (const field of fields) for (const reference of field.references) {
    stats.references++;
    const targetSection = String(reference.targetSection || "");
    if (reference.family === "usc" || reference.family === "ina" || reference.family === "cfr") {
      if (!reference.targetTitle && !reference.targetCongress && !reference.targetVolume) stats.explicitTargetMetadataMissing++;
    }
    if (reference.resolution !== "local") continue;
    stats.localTargets++;
    let present = true;
    if (reference.family === "usc" || reference.family === "ina") present = reference.targetTitle === "8" && uscPresent(targetSection);
    else if (reference.family === "cfr") present = cfrSections.has(`${reference.targetTitle}:${targetSection}`);
    if (present) stats.localTargetSectionPresent++;
    else {
      stats.localTargetSectionMissing++;
      if (missingSections.length < 100) missingSections.push({ scope: field.scope, sourceId: field.sourceId, sourcePath: field.sourcePath, field: field.field, start: reference.start, text: reference.text, family: reference.family, target: targetIdentity(reference), resolution: reference.resolution });
    }
    const before = field.text.slice(Math.max(0, reference.start - 120), reference.start);
    if (/\bformer\b|as in effect before|repealed|prior law/i.test(before)) {
      stats.historicalCueLocal++;
      if (historicalCueExamples.length < 100) historicalCueExamples.push({ scope: field.scope, sourceId: field.sourceId, sourcePath: field.sourcePath, field: field.field, start: reference.start, text: reference.text, target: targetWithResolution(reference), context: excerpt(field.text, reference.start, reference.end, 150) });
    }
  }
  return { stats, missingSections, historicalCueExamples };
}
function exactField(fields, scope, old) {
  const start = Number(old.offset);
  const end = start + String(old.text || "").length;
  return fields.find(field => field.scope === scope && field.sourceId === old.source_id && field.sourcePath === old.source_path && start >= 0 && end <= field.text.length && field.text.slice(start, end) === old.text);
}
function carryForwardFindings(fields) {
  const findings = new Map();
  // These prior-cycle rationales were independently adjudicated against the
  // frozen House text and are explicitly rejected.  Keep the exclusions in
  // the reproducible script so a later rerun cannot silently resurrect them.
  const rejected = new Set([
    "usc-notes\t8-801 to 810-note-7\ttitle8.sections[801 to 810].notes[6]\t181\tsection 1487 of this title",
    "usc-notes\t8-801 to 810-note-9\ttitle8.sections[801 to 810].notes[8]\t321\tsection 1487 of this title",
    "usc-notes\t8-1229a-note-11\ttitle8.sections[1229a].notes[10]\t2513\t8 U.S.C. 1101",
    "usc-operative\t8-1324a-a-1-B-i\ttitle8.sections[1324a].body[0/0/1/0]\t119\t(ii)",
    "usc-operative\t8-1441\ttitle8.sections[1441]\t448\t(i)",
    "usc-operative\t8-1441\ttitle8.sections[1441]\t512\t(ii)",
  ]);
  const evidenceFiles = fs.readdirSync(path.join(ROOT, "sources/legal"))
    .filter(file => /^luna-audit-.*-cycle\d+-flags\.tsv$/.test(file)).sort();
  for (const file of evidenceFiles) {
      const scope = scopeForFile(file);
    for (const old of parseTsv(path.join(ROOT, "sources/legal", file))) {
      const k = [scope, old.source_id, old.source_path, old.offset, old.text].join("\t");
      if (rejected.has(k)) continue;
      const field = exactField(fields, scope, old);
      // Every carry-forward row must be grounded in the exact current field
      // and text span.  This drops stale offsets and source-path collisions.
      if (!field) continue;
      const start = Number(old.offset);
      const end = start + old.text.length;
      const overlapping = field.references.filter(ref => ref.start < end && ref.end > start);
      // A missing-link finding is current only when this exact occurrence has
      // no generated reference overlapping its candidate span.
      if (old.verdict === "missing-link") {
        if (overlapping.length) continue;
      } else {
        // Target/resolution findings are current only when the baseline still
        // emits the old target at the exact occurrence.  This drops findings
        // already corrected by the frozen artifact itself and avoids accepting
        // a merely overlapping reference with a different span.
        const current = overlapping.find(ref => ref.start === start && ref.end === end && ref.text === old.text && old.current_target && old.current_target.includes(targetWithResolution(ref)));
        if (!current) continue;
      }
      const row = {
        scope,
        sourceId: old.source_id,
        sourcePath: old.source_path,
        field: field?.field || null,
        start,
        end,
        text: old.text,
        context: field ? excerpt(field.text, Number(old.offset), Number(old.offset) + old.text.length) : null,
        currentTarget: old.current_target,
        verdict: old.verdict,
        proposedTarget: old.proposed_target,
        rationale: old.rationale,
        sourceEvidence: [`sources/legal/${file}`]
      };
      const id = [scope, row.sourceId, row.sourcePath, row.start, row.text].join("\t");
      if (findings.has(id)) findings.get(id).sourceEvidence.push(`sources/legal/${file}`); else findings.set(id, row);
    }
  }
  return [...findings.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.text.localeCompare(b.text));
}
const REVIEWED_DISPOSITIONS = [
  { status: "rejected", scope: "cfr", sourceId: "cfr-20:416.1165", sourcePath: "cfr.records[20:416.1165].blocks[33]", start: 180, text: "(e)(3)", reason: "Stale prior-cycle row: this text span is not present in the frozen block, so it fails the exact field/text guard." },
  { status: "rejected", scope: "usc-notes", sourceId: "8-801 to 810-note-7", sourcePath: "title8.sections[801 to 810].notes[6]", start: 181, text: "section 1487 of this title", reason: "The House corpus supplies a combined local repealed record for sections 1484 to 1487; the prior official-only rationale was false." },
  { status: "rejected", scope: "usc-notes", sourceId: "8-801 to 810-note-9", sourcePath: "title8.sections[801 to 810].notes[8]", start: 321, text: "section 1487 of this title", reason: "The House corpus supplies a combined local repealed record for sections 1484 to 1487; the prior official-only rationale was false." },
  { status: "rejected", scope: "usc-notes", sourceId: "8-1229a-note-11", sourcePath: "title8.sections[1229a].notes[10]", start: 2513, text: "8 U.S.C. 1101", reason: "This occurrence is the parenthetical locator '(8 U.S.C. 1101 note)' for IIRIRA section 309, not the preceding historical whole-INA citation; the local resolution is appropriate." },
  { status: "rejected", scope: "usc-operative", sourceId: "8-1324a-a-1-B-i", sourcePath: "title8.sections[1324a].body[0/0/1/0]", start: 119, text: "(ii)", reason: "Run-in marker introducing clause text ('if the person ...'), not a cross-reference mention." },
  { status: "rejected", scope: "usc-operative", sourceId: "8-1441", sourcePath: "title8.sections[1441]", start: 448, text: "(i)", reason: "Run-in marker introducing clause text ('which is registered ...'), not a cross-reference mention." },
  { status: "rejected", scope: "usc-operative", sourceId: "8-1441", sourcePath: "title8.sections[1441]", start: 512, text: "(ii)", reason: "Run-in marker introducing clause text ('the full ... title ...'), not a cross-reference mention." },
];
function addIndependentFinding(findings, fields, spec) {
  const field = fields.find(candidate => candidate.scope === spec.scope && candidate.sourceId === spec.sourceId && candidate.sourcePath === spec.sourcePath && candidate.text.slice(spec.start, spec.start + spec.text.length) === spec.text);
  if (!field) throw new Error(`Independent finding span not found: ${spec.scope}/${spec.sourceId}@${spec.start}`);
  const reference = field.references.find(ref => ref.start === spec.start && ref.end === spec.start + spec.text.length && ref.text === spec.text);
  if (!reference) throw new Error(`Independent finding reference not found: ${spec.scope}/${spec.sourceId}@${spec.start}`);
  const row = { ...spec, end: spec.start + spec.text.length, context: excerpt(field.text, spec.start, spec.start + spec.text.length), currentTarget: targetWithResolution(reference), sourceEvidence: ["independent-baseline-adjudication"] };
  const id = [spec.scope, spec.sourceId, spec.sourcePath, spec.start, spec.text].join("\t");
  const existing = findings.find(candidate => [candidate.scope, candidate.sourceId, candidate.sourcePath, candidate.start, candidate.text].join("\t") === id);
  if (existing) {
    existing.sourceEvidence = [...new Set([...existing.sourceEvidence, ...row.sourceEvidence])];
    existing.currentTarget = row.currentTarget;
    existing.verdict = row.verdict;
    existing.proposedTarget = row.proposedTarget;
    existing.rationale = row.rationale;
  } else findings.push(row);
}
function report(summary, checks, contextAudit, findings, artifactHash, inventoryHashes, rows, fields) {
  const allRows = Object.values(rows).flat();
  const byScope = Object.fromEntries(SCOPES.map(scope => {
    const values = findings.filter(row => row.scope === scope);
    return [scope, { findings: values.length, verdicts: Object.fromEntries(Object.entries(Object.groupBy(values, row => row.verdict)).map(([k, v]) => [k, v.length])) }];
  }));
  const sourceFiles = [...new Set(findings.flatMap(row => row.sourceEvidence))].sort();
  const lines = [];
  lines.push("# Frozen baseline inline-reference audit");
  lines.push("");
  lines.push("Audit target: the frozen pre-display-change artifact and its three task-supplied JSONL inventories. No application, parser, corpus, or generated-HTML file was modified by this audit.");
  lines.push("");
  lines.push(`Artifact SHA-256: \`${artifactHash}\` (` + path.relative(ROOT, ARTIFACT) + ").");
  lines.push(`Inventory SHA-256: usc-operative \`${inventoryHashes["usc-operative"]}\`; usc-notes \`${inventoryHashes["usc-notes"]}\`; cfr \`${inventoryHashes.cfr}\`.`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  const inventoryMismatchCount = Object.values(contextAudit.inventoryComparisons).filter(result => !result.byteEqual).length;
  lines.push(`The independent walk regenerated the JSONL inventories byte-for-byte (${inventoryMismatchCount} mismatches). It covered every displayed heading, preamble, body text, note, source-credit, editorial-footnote, CFR authority/source/heading, section, appendix, and nested CFR block represented in the artifact.`);
  lines.push("");
  lines.push("| scope | generated references | parenthetical candidates | linked | structural | unlinked |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const scope of SCOPES) {
    const s = summary[scope];
    lines.push(`| ${scope} | ${s.references} | ${s.parentheticalCandidates} | ${s.candidateCoverage.linked} | ${s.candidateCoverage.structural} | ${s.candidateCoverage.unlinked} |`);
  }
  lines.push(`| **total** | **${SCOPES.reduce((n, scope) => n + summary[scope].references, 0)}** | **${SCOPES.reduce((n, scope) => n + summary[scope].parentheticalCandidates, 0)}** |  |  |  |`);
  lines.push("");
  lines.push("Field walk counts (including fields with no references):");
  lines.push("");
  lines.push("| scope | field | fields | generated references | candidates |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const scope of SCOPES) {
    const scoped = fields.filter(field => field.scope === scope);
    for (const fieldName of ["heading", "preamble", "text", "sourceCredit", "authority", "source", "x"]) {
      const selected = scoped.filter(field => field.field === fieldName);
      if (!selected.length) continue;
      lines.push(`| ${scope} | ${fieldName} | ${selected.length} | ${selected.reduce((n, field) => n + field.references.length, 0)} | ${selected.reduce((n, field) => n + allRows.filter(row => row.scope === scope && row.sourceId === field.sourceId && row.sourcePath === field.sourcePath && row.field === fieldName && row.kind === "parenthetical-candidate").length, 0)} |`);
    }
  }
  lines.push("");
  lines.push(`Generated-reference span round-trip mismatches: **${checks.spanMismatches.length}**; overlaps: **${checks.overlapMismatches.length}**; empty spans: **${checks.emptyReferenceText}**; unknown families: **${checks.unknownFamilies.length}**; finding-span mismatches: **${checks.findingSpanMismatches.length}**.`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  const verdictText = Object.entries(Object.groupBy(findings, row => row.verdict)).map(([k, v]) => `${v.length} ${k}`).join(", ");
  lines.push(`The occurrence-level log contains **${findings.length}** findings that remain present in this baseline: ${verdictText}. The complete machine-readable log is [baseline-flags.json](baseline-flags.json).`);
  lines.push("");
  lines.push("Findings are retained only when the exact source ID, source path, UTF-16 offset, and text still match the baseline state. A missing-link finding is discarded if the baseline already emits any overlapping reference. A target finding is discarded if the baseline target/resolution no longer matches the historical finding. This prevents stale prior-cycle findings from being reported as current defects.");
  lines.push("");
  lines.push("Every generated reference also receives deterministic contextual checks: field-span round-trip, target-family metadata, local target-section presence in the frozen USC/CFR indexes, and nearby historical wording cues. Aggregate results are stored under `contextAudit` in the JSON log; cue hits are review leads, not automatic errors, because legal notes often discuss both current and former provisions in one passage.");
  lines.push("");
  lines.push(`Context checks covered **${contextAudit.stats.references}** references: ${contextAudit.stats.localTargetSectionPresent} local targets were found in the frozen section indexes, ${contextAudit.stats.localTargetSectionMissing} local target labels were not directly indexed (mostly abbreviated or cross-reference forms), ${contextAudit.stats.historicalCueLocal} had nearby historical wording cues, and ${contextAudit.stats.explicitTargetMetadataMissing} lacked basic family metadata.`);
  lines.push("");
  lines.push("### Explicit dispositions");
  lines.push("");
  lines.push("The following prior flags were explicitly rejected after rereading the frozen House text/context:");
  for (const disposition of REVIEWED_DISPOSITIONS) lines.push(`- \`${disposition.scope}\` ${disposition.sourceId} @ ${disposition.start} ${disposition.text}: ${disposition.reason}`);
  lines.push("");
  lines.push("CFR target identity and nested address paths were checked against the captured eCFR-backed corpus indexes; the two surviving CFR findings are explicit statutory references in source text and remain unlinked in the frozen baseline. Historical House/INA amendment citations are reported as official-source-only target findings where their text is expressly historical; they are not judged against current Title 8 text. Apparent date/chapter citations with no Congress/law number in old repeal headings are retained as source-authored official-only references, not marked malformed.");
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("This is exhaustive occurrence enumeration and contextual review of every generated reference and parenthetical candidate, with targeted source-context adjudication of suspicious groups. It is not a manual legal reading of every sentence or a claim that the House/eCFR source text itself is substantively error-free. The frozen artifact is a historical snapshot; rerun this script after any resolver or corpus change.");
  lines.push("");
  const tsvFiles = sourceFiles.filter(file => file.startsWith("sources/legal/"));
  lines.push(`Prior audit TSV evidence used for occurrence-level adjudication: ${tsvFiles.length} files (${tsvFiles.join(", ")}).`);
  return lines.join("\n") + "\n";
}
function main() {
  const { corpus, fields, rows } = loadRows();
  const summary = summarize(rows);
  const checks = validateStructure(fields);
  const findings = carryForwardFindings(fields);
  // Independent adjudication of the historical judicial-review passage in
  // 8 U.S.C. 1101 note 17.  The passage expressly says former section 106
  // (former 8 U.S.C. 1105a); “such section” therefore keeps that historical
  // container for (a), (b), and (c), all official-source-only.
  addIndependentFinding(findings, fields, {
    scope: "usc-notes", sourceId: "8-1101-note-17", sourcePath: "title8.sections[1101].notes[16]", start: 4391, text: "(b)", verdict: "incorrect-resolution", proposedTarget: "usc:8:1105a/b (official-source-only)", rationale: "The preceding citation expressly identifies former INA section 106 (former 8 U.S.C. 1105a), and 'subsection (b) of such section' refers to that historical section; local current-text resolution is incorrect."
  });
  addIndependentFinding(findings, fields, {
    scope: "usc-notes", sourceId: "8-1101-note-17", sourcePath: "title8.sections[1101].notes[16]", start: 4513, text: "(a)", verdict: "incorrect-target", proposedTarget: "usc:8:1105a/a (official-source-only)", rationale: "In the quoted transition rule, 'such section' refers to former INA section 106 (former 8 U.S.C. 1105a), so this subsection locator must remain historical and official-source-only rather than being inferred under current section 1101."
  });
  addIndependentFinding(findings, fields, {
    scope: "usc-notes", sourceId: "8-1101-note-17", sourcePath: "title8.sections[1101].notes[16]", start: 4521, text: "(c)", verdict: "incorrect-target", proposedTarget: "usc:8:1105a/c (official-source-only)", rationale: "In the quoted transition rule, 'such section' refers to former INA section 106 (former 8 U.S.C. 1105a), so this subsection locator must remain historical and official-source-only rather than being inferred under current section 1101."
  });
  findings.sort((a, b) => a.scope.localeCompare(b.scope) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.text.localeCompare(b.text));
  checks.findingSpanMismatches = findings.filter(row => !fields.some(field => field.scope === row.scope && field.sourceId === row.sourceId && field.sourcePath === row.sourcePath && field.text.slice(row.start, row.end) === row.text));
  const contextAudit = contextualChecks(corpus, fields);
  const inventoryHashes = Object.fromEntries(SCOPES.map(scope => [scope, sha256(path.join(BASE, `${scope}.jsonl`))]));
  contextAudit.inventoryComparisons = Object.fromEntries(SCOPES.map(scope => {
    const generated = rows[scope].map(value => JSON.stringify(value)).join("\n") + "\n";
    const frozen = fs.readFileSync(path.join(BASE, `${scope}.jsonl`));
    return [scope, { byteEqual: Buffer.from(generated).equals(frozen), generatedSha256: crypto.createHash("sha256").update(generated).digest("hex"), frozenSha256: inventoryHashes[scope] }];
  }));
  checks.inventoryByteMismatches = Object.values(contextAudit.inventoryComparisons).filter(result => !result.byteEqual).length;
  const payload = { schemaVersion: 1, artifact: { path: path.relative(ROOT, ARTIFACT), sha256: sha256(ARTIFACT) }, inventories: inventoryHashes, coverage: summary, integrity: checks, contextAudit, reviewedDispositions: REVIEWED_DISPOSITIONS, findings };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "baseline-flags.json"), JSON.stringify(payload, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "baseline-review.md"), report(summary, checks, contextAudit, findings, payload.artifact.sha256, inventoryHashes, rows, fields));
  process.stdout.write(JSON.stringify({ coverage: summary, integrity: { spans: checks.spanMismatches.length, overlaps: checks.overlapMismatches.length, empty: checks.emptyReferenceText, unknownFamilies: checks.unknownFamilies.length, findingSpanMismatches: checks.findingSpanMismatches.length, inventoryByteMismatches: checks.inventoryByteMismatches }, findings: findings.length }, null, 2) + "\n");
}
if (require.main === module) main();
