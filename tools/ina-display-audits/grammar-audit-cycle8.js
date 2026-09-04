#!/usr/bin/env node
"use strict";

/*
 * Independent cycle-8 grammar/flow audit.
 *
 * The JSONL inventories are the source-of-truth occurrence records.  The
 * current artifact and template are rendered again only to recover exact
 * anchor positions, so this audit can compare the source wording with the
 * displayed wording without guessing where a repeated label occurs.  It
 * never edits application, parser, corpus, or generated HTML files.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readArtifact, collectFields } = require("../audit-inline-references");
const { runtime, plain, contextFor } = require("../audit-ina-display");
const embedded = require("../embedded-references");
const { statuteRunInMarkers } = require("../statute-run-ins");

const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CURRENT = path.join(ROOT, "tmp/ina-display-verified-final/display.jsonl");
const DEFAULT_BASELINE = path.join(ROOT, "tmp/ina-display-baseline/display.jsonl");
const DEFAULT_ARTIFACT = path.join(ROOT, "INASearch-Uncompressed.html");
const DEFAULT_TEMPLATE = path.join(ROOT, "src/INASearch.template.html");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function fieldKey(row) { return [row.scope, row.sourcePath, row.field].join("|"); }
function excerpt(text, start, end, radius = 180) {
  return String(text || "").slice(Math.max(0, start - radius), Math.min(String(text || "").length, end + radius)).replace(/\s+/g, " ").trim();
}
function addFlag(flags, kind, row, extra = {}) {
  flags.push({ kind, scope: row.scope, sourceId: row.sourceId, sourcePath: row.sourcePath, field: row.field, ...extra });
}

// Return plain-text positions of every generated legal-reference anchor.  A
// source-text search is insufficient here because notes contain many repeated
// “(a)”/“section” strings before the actual anchor.
function renderedAnchors(html) {
  const anchors = [];
  let htmlCursor = 0;
  let plainCursor = 0;
  const re = /<a\b([^>]*data-legal-reference[^>]*)>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(re)) {
    plainCursor += plain(html.slice(htmlCursor, match.index)).length;
    const text = plain(match[2]);
    const sourceAttr = match[1].match(/data-reference-source-text="([^"]*)"/);
    anchors.push({
      start: plainCursor,
      end: plainCursor + text.length,
      text,
      sourceText: sourceAttr ? plain(sourceAttr[1]) : ""
    });
    plainCursor += text.length;
    htmlCursor = match.index + match[0].length;
  }
  plainCursor += plain(html.slice(htmlCursor)).length;
  return { anchors, plainLength: plainCursor };
}

function mask(text, spans) {
  let output = "";
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.start < cursor) continue;
    output += text.slice(cursor, span.start) + "⟦CITATION⟧";
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

function compareTarget(reference, link) {
  if (!link) return false;
  let linkPath;
  try { linkPath = JSON.parse(link.path || "[]").map(String); } catch { linkPath = null; }
  return link.family === reference.family &&
    String(link.section || "") === String(reference.targetSection || "") &&
    JSON.stringify(linkPath) === JSON.stringify((reference.targetPath || []).map(String));
}

function groupMembers(row, group) {
  return row.references.filter(reference => reference.start >= group.start && reference.end <= group.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function allowedGroupEnvelope(source, group, members) {
  const prefix = source.slice(group.start, members[0].start);
  const suffix = source.slice(members.at(-1).end, group.end);
  const prefixOk = /^(?:sections?\s+)?$/i.test(prefix);
  const suffixOk = /^(?:\s+of (?:this title|This Title|the Act|the INA|the Immigration and Nationality Act))?$/i.test(suffix);
  return { prefix, suffix, prefixOk, suffixOk };
}

function allRefsMask(row, anchors, groups) {
  const grouped = new Set();
  const sourceSpans = [];
  const displaySpans = [];
  for (const group of groups) {
    const members = groupMembers(row, group);
    const indexes = members.map(reference => row.references.indexOf(reference));
    if (!indexes.length) continue;
    indexes.forEach(index => grouped.add(index));
    sourceSpans.push({ start: group.start, end: group.end });
    displaySpans.push({ start: anchors[indexes[0]].start, end: anchors[indexes.at(-1)].end });
  }
  row.references.forEach((reference, index) => {
    if (grouped.has(index)) return;
    sourceSpans.push({ start: reference.start, end: reference.end });
    displaySpans.push({ start: anchors[index].start, end: anchors[index].end });
  });
  return { sourceSpans, displaySpans };
}

function segmentRanges(field) {
  if (field.scope !== "usc-operative" || !["text", "preamble"].includes(field.field)) return [];
  const markers = statuteRunInMarkers(field.text, field.currentLabel);
  if (!markers.length) return [];
  const ranges = [];
  const initial = field.text.slice(0, markers[0].start).trimEnd();
  if (initial.length) ranges.push({ start: 0, end: initial.length });
  markers.forEach((marker, index) => {
    const nextStart = markers[index + 1]?.start ?? field.text.length;
    const nested = Boolean(markers[index + 1]?.nestedAfterPrevious);
    const raw = nested ? "" : field.text.slice(marker.end, nextStart);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = marker.end + leading;
    const end = nested ? start : Math.max(start, nextStart - trailing);
    if (end > start) ranges.push({ start, end });
  });
  return ranges;
}

function audit(currentFile, baselineFile, artifactFile, templateFile, outFlags, outReport) {
  const current = readJsonl(currentFile);
  const baseline = readJsonl(baselineFile);
  const currentByKey = new Map(current.map(row => [fieldKey(row), row]));
  const baselineByKey = new Map(baseline.map(row => [fieldKey(row), row]));
  const corpus = readArtifact(artifactFile);
  const template = fs.readFileSync(templateFile, "utf8");
  const api = runtime(template, corpus);
  const fields = collectFields(corpus);
  const flags = [];
  const stats = {
    fields: current.length, baselineFields: baseline.length, references: 0, baselineReferences: baseline.reduce((sum, row) => sum + row.references.length, 0), links: 0,
    sourceOccurrencesAdded: 0, sourceOccurrencesDropped: 0,
    groups: { "numbered-section-list": 0, "repeated-section-list": 0, "cfr-act-list": 0 },
    groupMembers: 0, relativeCandidates: 0, relativeStandalone: 0,
    relativeNested: 0, relativeMemberCoverage: 0,
    footnoteFields: 0, footnotes: 0, segmentedFields: 0, segments: 0,
    changedSourceFields: 0, changedSourceOccurrences: 0
  };
  const checks = {
    fieldKeysStable: true, sourceTextStable: true, sourceReferencesPreserved: true,
    anchorPlainParity: true, anchorCountsStable: true, anchorSourcesOrdered: true,
    linkMetadataStable: true, residualProseStable: true, groupIntegrity: true,
    groupEnvelopes: true, groupConnectorsStable: true, relativeGrammarStable: true,
    footnotesStable: true, segmentedRenderingStable: true
  };
  const sourceOccurrences = rows => rows.flatMap(row => row.references.map(reference => ({ key: `${fieldKey(row)}\t${reference.start}\t${reference.end}\t${reference.text}`, row, reference })));
  const baseOccurrences = new Set(sourceOccurrences(baseline).map(item => item.key));
  const currentOccurrences = new Set(sourceOccurrences(current).map(item => item.key));
  stats.sourceOccurrencesAdded = [...currentOccurrences].filter(key => !baseOccurrences.has(key)).length;
  stats.sourceOccurrencesDropped = [...baseOccurrences].filter(key => !currentOccurrences.has(key)).length;
  for (const key of baseOccurrences) if (!currentOccurrences.has(key)) {
    checks.sourceReferencesPreserved = false;
    const [scope, sourcePath, field, start, end, ...textParts] = key.split("\t");
    addFlag(flags, "source-reference-dropped", { scope, sourcePath, field, sourceId: baselineByKey.get([scope, sourcePath, field].join("|"))?.sourceId || "" }, { start: Number(start), end: Number(end), text: textParts.join("\t") });
  }

  const fieldLookup = new Map(fields.map(field => [fieldKey(field), field]));
  for (const row of current) {
    const base = baselineByKey.get(fieldKey(row));
    const field = fieldLookup.get(fieldKey(row));
    if (!field) { checks.fieldKeysStable = false; addFlag(flags, "field-missing-from-artifact", row); continue; }
    if (!base) { checks.fieldKeysStable = false; addFlag(flags, "field-missing-from-baseline", row); }
    if (base && base.original !== row.original) { checks.sourceTextStable = false; stats.changedSourceFields++; addFlag(flags, "source-text-changed", row, { before: base.original, after: row.original }); }
    stats.references += row.references.length; stats.links += row.links.length;
    for (const group of row.groups) stats.groups[group.grammar] = (stats.groups[group.grammar] || 0) + 1;

    const html = api.linkifyStatutoryText(row.original, row.references, 0, undefined, null, [], contextFor(field, corpus));
    const rendered = renderedAnchors(html);
    if (plain(html) !== row.displayed) { checks.anchorPlainParity = false; addFlag(flags, "plain-display-mismatch", row, { expected: row.displayed, actual: plain(html) }); }
    const anchors = rendered.anchors;
    if (anchors.length !== row.references.length || row.links.length !== row.references.length) {
      checks.anchorCountsStable = false;
      addFlag(flags, "anchor-count-mismatch", row, { references: row.references.length, inventoryLinks: row.links.length, renderedAnchors: anchors.length });
      continue;
    }
    for (let index = 0; index < row.references.length; index++) {
      const reference = row.references[index];
      const link = row.links[index];
      if (row.original.slice(reference.start, reference.end) !== reference.text) { checks.sourceReferencesPreserved = false; addFlag(flags, "reference-span-mismatch", row, { index, start: reference.start, end: reference.end, text: reference.text }); }
      if (!compareTarget(reference, link) || link.sourceText !== reference.text || anchors[index].sourceText !== reference.text) {
        checks.linkMetadataStable = false; checks.anchorSourcesOrdered = false;
        addFlag(flags, "link-source-target-order-mismatch", row, { index, reference: { text: reference.text, family: reference.family, section: reference.targetSection, path: reference.targetPath }, link, anchor: anchors[index] });
      }
    }

    const masks = allRefsMask(row, anchors, row.groups);
    if (mask(row.original, masks.sourceSpans) !== mask(row.displayed, masks.displaySpans)) {
      checks.residualProseStable = false;
      addFlag(flags, "prose-or-punctuation-changed-outside-citations", row, {
        context: excerpt(row.original, 0, row.original.length),
        originalResidual: mask(row.original, masks.sourceSpans),
        displayedResidual: mask(row.displayed, masks.displaySpans)
      });
    }

    let previousGroup = null;
    for (const group of row.groups) {
      const members = groupMembers(row, group);
      stats.groupMembers += members.length;
      const indexes = members.map(reference => row.references.indexOf(reference));
      const integrity = members.length === (group.labels || []).length && group.text === row.original.slice(group.start, group.end) && indexes.every((index, position) => index === indexes[0] + position);
      if (!integrity) { checks.groupIntegrity = false; addFlag(flags, "group-boundary-or-member-mismatch", row, { start: group.start, end: group.end, grammar: group.grammar, text: group.text, labels: group.labels, members: members.map(reference => reference.text) }); }
      if (previousGroup && group.start < previousGroup.end) { checks.groupIntegrity = false; addFlag(flags, "overlapping-groups", row, { previous: previousGroup, current: group }); }
      previousGroup = group;
      const envelope = members.length ? allowedGroupEnvelope(row.original, group, members) : { prefixOk: false, suffixOk: false };
      if (!envelope.prefixOk || !envelope.suffixOk) { checks.groupEnvelopes = false; addFlag(flags, "unexpected-group-envelope", row, { start: group.start, end: group.end, grammar: group.grammar, ...envelope }); }
      for (let index = 1; index < indexes.length; index++) {
        const sourceGap = row.original.slice(members[index - 1].end, members[index].start);
        const displayGap = row.displayed.slice(anchors[indexes[index - 1]].end, anchors[indexes[index]].start);
        if (sourceGap !== displayGap) { checks.groupConnectorsStable = false; addFlag(flags, "group-connector-or-punctuation-changed", row, { grammar: group.grammar, memberIndex: index, sourceGap, displayGap, groupText: group.text }); }
      }
    }

    // Relative-unit syntax is deliberately not folded into a leading INA
    // list.  Enumerate it anyway and verify every member and connector in its
    // native trailing-container position.
    for (const candidate of embedded.parseCoordinatedSectionReferences(row.original).filter(item => item.grammar === "relative-unit-list")) {
      stats.relativeCandidates++;
      const memberRefs = candidate.members.map(member => row.references.find(reference => reference.start <= member.start && reference.end >= member.end));
      if (memberRefs.some(reference => !reference)) { checks.relativeGrammarStable = false; addFlag(flags, "relative-member-not-covered", row, { start: candidate.start, end: candidate.end, text: candidate.text, members: candidate.members.map(member => member.text) }); continue; }
      stats.relativeMemberCoverage += memberRefs.length;
      const nested = row.groups.some(group => group.start < candidate.end && group.end > candidate.start);
      if (nested) stats.relativeNested++; else stats.relativeStandalone++;
      const all = [...memberRefs];
      const base = row.references.find(reference => reference.start <= candidate.base.start && reference.end >= candidate.base.end);
      if (base && !all.includes(base)) all.push(base);
      const indexes = all.map(reference => row.references.indexOf(reference)).sort((a, b) => a - b);
      for (let index = 1; index < indexes.length; index++) {
        const left = row.references[indexes[index - 1]], right = row.references[indexes[index]];
        const sourceGap = row.original.slice(left.end, right.start);
        const displayGap = row.displayed.slice(anchors[indexes[index - 1]].end, anchors[indexes[index]].start);
        if (sourceGap !== displayGap) { checks.relativeGrammarStable = false; addFlag(flags, "relative-connector-or-order-changed", row, { start: candidate.start, end: candidate.end, text: candidate.text, sourceGap, displayGap, nested }); }
      }
    }

    const footnoteReferences = field.owner?.[`${field.field}FootnoteReferences`] || [];
    if (footnoteReferences.length) {
      stats.footnoteFields++; stats.footnotes += footnoteReferences.length;
      const footnoteHtml = api.linkifyStatutoryText(row.original, row.references, 0, undefined, null, footnoteReferences, contextFor(field, corpus));
      const markers = [...footnoteHtml.matchAll(/data-house-footnote-jump="([^"]+)"[^>]*aria-label="House editorial footnote ([^"]+)"/g)].map(match => ({ id: match[1], number: match[2] }));
      const expected = [...footnoteReferences].sort((a, b) => a.offset - b.offset).map(reference => ({ id: String(reference.id), number: String(reference.number) }));
      if (plain(footnoteHtml) !== row.displayed || JSON.stringify(markers) !== JSON.stringify(expected)) {
        checks.footnotesStable = false; addFlag(flags, "footnote-placement-or-display-mismatch", row, { expected, actual: markers, plainMatches: plain(footnoteHtml) === row.displayed });
      }
    }

    const segments = segmentRanges(field);
    if (segments.length) {
      stats.segmentedFields++; stats.segments += segments.length;
      for (const segment of segments) {
        const refs = row.references.filter(reference => reference.start >= segment.start && reference.end <= segment.end);
        const footnotes = footnoteReferences.filter(reference => reference.offset >= segment.start && reference.offset <= segment.end);
        const segmentHtml = api.linkifyStatutoryText(row.original, refs, segment.start, segment.end, null, footnotes, contextFor(field, corpus));
        const segmentAnchors = renderedAnchors(segmentHtml).anchors;
        const segmentGroups = api.coordinatedStatutoryInaLists(row.original, refs, segment.start, segment.end, contextFor(field, corpus));
        const grouped = new Set(segmentGroups.flatMap(group => group.members));
        const sourceSpans = [], displaySpans = [];
        for (const group of segmentGroups) {
          const members = group.members;
          const first = refs.indexOf(members[0]), last = refs.indexOf(members.at(-1));
          if (first < 0 || last < 0) continue;
          sourceSpans.push({ start: group.start, end: group.end });
          displaySpans.push({ start: segmentAnchors[first].start, end: segmentAnchors[last].end });
        }
        refs.forEach((reference, index) => {
          if (grouped.has(reference)) return;
          sourceSpans.push({ start: reference.start, end: reference.end });
          displaySpans.push({ start: segmentAnchors[index].start, end: segmentAnchors[index].end });
        });
        if (segmentAnchors.length !== refs.length || mask(row.original.slice(segment.start, segment.end), sourceSpans.map(span => ({ start: span.start - segment.start, end: span.end - segment.start }))) !== mask(plain(segmentHtml), displaySpans)) {
          checks.segmentedRenderingStable = false;
          addFlag(flags, "segmented-rendering-mismatch", row, { segment, references: refs.map(reference => reference.text), anchors: segmentAnchors });
        }
      }
    }
  }

  const result = {
    inputs: {
      currentInventory: { file: path.relative(ROOT, currentFile), sha256: sha256(currentFile) },
      baselineInventory: { file: path.relative(ROOT, baselineFile), sha256: sha256(baselineFile) },
      artifact: { file: path.relative(ROOT, artifactFile), sha256: sha256(artifactFile) },
      template: { file: path.relative(ROOT, templateFile), sha256: sha256(templateFile) }
    },
    stats, checks, flags
  };
  fs.writeFileSync(outFlags, JSON.stringify(flags, null, 2) + "\n");
  const report = [
    "# Cycle 8 grammar and source-order audit", "",
    `Inputs: \`${result.inputs.currentInventory.file}\` (${result.inputs.currentInventory.sha256}), baseline \`${result.inputs.baselineInventory.file}\` (${result.inputs.baselineInventory.sha256}), artifact \`${result.inputs.artifact.sha256}\`, template \`${result.inputs.template.sha256}\`.`, "",
    `The audit examined ${stats.fields.toLocaleString()} fields, ${stats.references.toLocaleString()} references, and ${stats.links.toLocaleString()} generated links; the baseline has ${stats.baselineFields.toLocaleString()} fields and ${stats.baselineReferences.toLocaleString()} references. The source occurrence comparison found ${stats.sourceOccurrencesAdded} additions and ${stats.sourceOccurrencesDropped} removals. It rendered the current template to recover anchor positions, then checked exact source spans, link source/target metadata, source order, and all non-citation prose and punctuation after masking only citation spans and known group envelopes.`, "",
    `It checked ${stats.groups["numbered-section-list"]} numbered groups, ${stats.groups["repeated-section-list"]} repeated complete-citation groups, and ${stats.groups["cfr-act-list"]} CFR Act-list groups (${stats.groupMembers.toLocaleString()} members). Every group's source envelope and each inter-member connector were compared character-for-character.`, "",
    `The parser also exposed ${stats.relativeCandidates} relative-unit constructions that are intentionally left in native trailing-container order (${stats.relativeStandalone} standalone and ${stats.relativeNested} nested under a rendered group). All ${stats.relativeMemberCoverage} relative members were covered and their connectors/order were checked.`, "",
    `Footnote-aware rendering covered ${stats.footnoteFields} fields and ${stats.footnotes} markers. Run-in segmented rendering covered ${stats.segmentedFields} fields and ${stats.segments} segments.`, "",
    `Machine-assisted flags: ${flags.length}. The flag file is \`${path.relative(ROOT, outFlags)}\`. With zero flags, there were no new occurrence-level grammar or flow candidates requiring contextual adjudication; the report does not claim manual legal reading of every reference. Source-authored wording and typos remain source text and were not treated as display defects.`, "",
    "All checks are reproducible with:", "", `\`node ${path.relative(ROOT, __filename)} ${path.relative(ROOT, currentFile)} ${path.relative(ROOT, baselineFile)} ${path.relative(ROOT, artifactFile)} ${path.relative(ROOT, templateFile)} ${path.relative(ROOT, outFlags)} ${path.relative(ROOT, outReport)}\``, ""
  ].join("\n");
  fs.writeFileSync(outReport, report + "\n");
  return result;
}

if (require.main === module) {
  const current = path.resolve(process.argv[2] || DEFAULT_CURRENT);
  const baseline = path.resolve(process.argv[3] || DEFAULT_BASELINE);
  const artifact = path.resolve(process.argv[4] || DEFAULT_ARTIFACT);
  const template = path.resolve(process.argv[5] || DEFAULT_TEMPLATE);
  const flags = path.resolve(process.argv[6] || path.join(__dirname, "grammar-flags-cycle8.json"));
  const report = path.resolve(process.argv[7] || path.join(__dirname, "grammar-review-cycle8.md"));
  const result = audit(current, baseline, artifact, template, flags, report);
  process.stdout.write(JSON.stringify({ inputs: result.inputs, stats: result.stats, checks: result.checks, flags: result.flags.length }, null, 2) + "\n");
}

module.exports = { audit, renderedAnchors, mask, segmentRanges };
