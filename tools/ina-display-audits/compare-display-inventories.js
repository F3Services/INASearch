#!/usr/bin/env node
"use strict";

/*
 * Compare two frozen outputs from audit-ina-display.js.
 *
 * The source reference arrays are the detection inventory.  Link identity is
 * compared by family, target section/path, and the exact source span text;
 * link contents and citation metadata are tracked separately as presentation
 * changes.  Baseline links are aligned from the end so repeated identical
 * references stay attached to the last occurrence they rendered (the old
 * relative-unit-list renderer could suppress earlier occurrences).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function fieldKey(row) {
  return [row.scope, row.sourcePath, row.field].join("|");
}

function pathValue(value) {
  if (Array.isArray(value)) return value.map(String);
  try { return JSON.parse(value || "[]").map(String); } catch { return []; }
}

function referenceKey(row) {
  return JSON.stringify([
    row.family || "",
    row.targetSection || "",
    pathValue(row.targetPath),
    row.text || ""
  ]);
}

function linkKey(row) {
  return JSON.stringify([
    row.family || "",
    row.section || "",
    pathValue(row.path),
    row.sourceText || ""
  ]);
}

function sourceOccurrenceKey(row) {
  return JSON.stringify([row.start, row.end, row.text || ""]);
}

function targetIdentity(row) {
  return JSON.stringify([row.family || "", row.targetTitle || row.title || "", row.targetSection || row.section || "", pathValue(row.targetPath ?? row.path)]);
}

function excerpt(text, start, end, radius = 180) {
  return String(text || "").slice(Math.max(0, start - radius), Math.min(String(text || "").length, end + radius)).replace(/\s+/g, " ").trim();
}

function sourceReference(reference) {
  return {
    start: reference.start,
    end: reference.end,
    text: reference.text,
    family: reference.family,
    resolution: reference.resolution,
    targetTitle: reference.targetTitle,
    targetSection: reference.targetSection,
    targetPath: pathValue(reference.targetPath),
    ruleId: reference.ruleId,
    provenance: reference.provenance
  };
}

function linkView(link) {
  if (!link) return null;
  return {
    text: link.text,
    family: link.family,
    section: link.section,
    path: pathValue(link.path),
    sourceText: link.sourceText,
    ina: link.ina,
    citation: link.citation,
    navigation: link.navigation
  };
}

function counts(values, keyFn) {
  const result = new Map();
  for (const value of values) {
    const key = keyFn(value);
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

function alignLinksToReferences(references, links) {
  // audit-ina-display emits links in reference order.  Align from the end so
  // duplicate source spans map to the final occurrence that was rendered.
  const mapping = new Map();
  let referenceIndex = references.length - 1;
  for (let linkIndex = links.length - 1; linkIndex >= 0; linkIndex--) {
    const key = linkKey(links[linkIndex]);
    while (referenceIndex >= 0 && referenceKey(references[referenceIndex]) !== key) referenceIndex--;
    if (referenceIndex < 0) break;
    mapping.set(referenceIndex, linkIndex);
    referenceIndex--;
  }
  return mapping;
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

function compare(baselineFile, currentFile, outputDirectory, cycle = "cycle1") {
  const baseline = readJsonl(baselineFile);
  const current = readJsonl(currentFile);
  const baselineByField = new Map(baseline.map(row => [fieldKey(row), row]));
  const currentByField = new Map(current.map(row => [fieldKey(row), row]));
  const flags = [];
  const presentationChanges = [];
  const records = [];
  const summary = {
    baseline: { file: path.resolve(baselineFile), sha256: sha256(baselineFile), records: baseline.length },
    current: { file: path.resolve(currentFile), sha256: sha256(currentFile), records: current.length },
    fieldKeys: { baseline: baselineByField.size, current: currentByField.size, onlyBaseline: 0, onlyCurrent: 0 },
    sourceReferences: { baseline: 0, current: 0, exactArrayDifferences: 0, added: 0, dropped: 0, changedOccurrences: 0, changedDimensions: {} },
    renderedLinks: { baseline: 0, current: 0, added: 0, dropped: 0, targetDifferences: 0, falsePositiveLinks: 0, lostDetections: 0, orderMismatches: 0 },
    fields: { linkDifferences: 0, displayedTextDifferences: 0, groupDifferences: 0 },
    presentationChanges: { count: 0, byScope: {}, byDimension: {} },
    addedClassifications: {},
    droppedClassifications: {},
    checks: { currentLinksMatchSourceReferences: true, currentLinksAreOrdered: true, sourceReferenceArraysStable: true }
  };

  for (const key of baselineByField.keys()) if (!currentByField.has(key)) summary.fieldKeys.onlyBaseline++;
  for (const key of currentByField.keys()) if (!baselineByField.has(key)) summary.fieldKeys.onlyCurrent++;

  const allKeys = [...new Set([...baselineByField.keys(), ...currentByField.keys()])];
  for (const key of allKeys) {
    const before = baselineByField.get(key);
    const after = currentByField.get(key);
    if (!before || !after) continue;
    summary.sourceReferences.baseline += before.references.length;
    summary.sourceReferences.current += after.references.length;
    summary.renderedLinks.baseline += before.links.length;
    summary.renderedLinks.current += after.links.length;
    const referencesEqual = JSON.stringify(before.references) === JSON.stringify(after.references);
    if (!referencesEqual) {
      summary.sourceReferences.exactArrayDifferences++;
      summary.checks.sourceReferenceArraysStable = false;
    }
    const beforeByOccurrence = new Map(before.references.map(reference => [sourceOccurrenceKey(reference), reference]));
    const afterByOccurrence = new Map(after.references.map(reference => [sourceOccurrenceKey(reference), reference]));
    for (const [occurrenceKey, beforeReference] of beforeByOccurrence) {
      const afterReference = afterByOccurrence.get(occurrenceKey);
      if (!afterReference || JSON.stringify(beforeReference) === JSON.stringify(afterReference)) continue;
      const changeDimensions = [];
      for (const dimension of ["resolution", "family", "targetTitle", "targetSection", "targetPath", "ruleId", "provenance", "officialUrl"]) {
        if (JSON.stringify(beforeReference[dimension]) !== JSON.stringify(afterReference[dimension])) changeDimensions.push(dimension);
      }
      summary.sourceReferences.changedOccurrences++;
      for (const dimension of changeDimensions) increment(summary.sourceReferences.changedDimensions, dimension);
      flags.push({ type: "source-reference-changed", verdict: "reference-change", field: key,
        beforeReference: sourceReference(beforeReference), afterReference: sourceReference(afterReference),
        changeDimensions, context: excerpt(after.original, afterReference.start, afterReference.end) });
    }
    const beforeReferenceKeys = counts(before.references, referenceKey);
    const afterReferenceKeys = counts(after.references, referenceKey);
    for (const [referenceKeyValue, count] of afterReferenceKeys) {
      const delta = count - (beforeReferenceKeys.get(referenceKeyValue) || 0);
      if (delta <= 0) continue;
      summary.sourceReferences.added += delta;
      for (let occurrence = 0; occurrence < delta; occurrence++) {
        const reference = after.references.find(row => referenceKey(row) === referenceKeyValue);
        flags.push({ type: "detected-reference-added", verdict: "detection-delta", field: key, sourceReference: sourceReference(reference), context: excerpt(after.original, reference.start, reference.end) });
      }
    }
    for (const [referenceKeyValue, count] of beforeReferenceKeys) {
      const delta = count - (afterReferenceKeys.get(referenceKeyValue) || 0);
      if (delta <= 0) continue;
      summary.sourceReferences.dropped += delta;
      for (let occurrence = 0; occurrence < delta; occurrence++) {
        const reference = before.references.find(row => referenceKey(row) === referenceKeyValue);
        flags.push({ type: "detected-reference-dropped", verdict: "detection-delta", field: key, sourceReference: sourceReference(reference), context: excerpt(before.original, reference.start, reference.end) });
      }
    }

    const afterToReference = alignLinksToReferences(after.references, after.links);
    const beforeToReference = alignLinksToReferences(before.references, before.links);
    const beforeLinkByOccurrence = new Map([...beforeToReference].map(([referenceIndex, linkIndex]) => [sourceOccurrenceKey(before.references[referenceIndex]), linkIndex]));
    const afterLinkByOccurrence = new Map([...afterToReference].map(([referenceIndex, linkIndex]) => [sourceOccurrenceKey(after.references[referenceIndex]), linkIndex]));
    const currentExpected = after.references.map(referenceKey);
    const currentActual = after.links.map(linkKey);
    if (JSON.stringify(currentExpected) !== JSON.stringify(currentActual)) {
      summary.renderedLinks.orderMismatches++;
      summary.checks.currentLinksAreOrdered = false;
    }
    for (let index = 0; index < after.links.length; index++) {
      if (!afterToReference.has(index)) {
        summary.renderedLinks.falsePositiveLinks++;
        summary.checks.currentLinksMatchSourceReferences = false;
        flags.push({ type: "false-positive-link", verdict: "unbacked-link", field: key, currentLink: linkView(after.links[index]), context: after.original });
      }
    }
    for (const [referenceIndex, linkIndex] of afterToReference) {
      const reference = after.references[referenceIndex];
      const link = after.links[linkIndex];
      if (referenceKey(reference) !== linkKey(link)) {
        summary.renderedLinks.falsePositiveLinks++;
        summary.checks.currentLinksMatchSourceReferences = false;
        flags.push({ type: "false-positive-link", verdict: "link-target-or-span-mismatch", field: key, sourceReference: sourceReference(reference), currentLink: linkView(link), context: excerpt(after.original, reference.start, reference.end) });
      }
    }

    for (const [referenceIndex, linkIndex] of afterToReference) {
      const reference = after.references[referenceIndex];
      const currentLink = after.links[linkIndex];
      const beforeLinkIndex = beforeLinkByOccurrence.get(sourceOccurrenceKey(reference));
      const baselineLink = beforeLinkIndex === undefined ? null : before.links[beforeLinkIndex];
      if (!baselineLink) {
        summary.renderedLinks.added++;
        const coveringGroups = before.groups.filter(group => group.start <= reference.start && group.end >= reference.end).map(group => group.grammar);
        const classification = coveringGroups.includes("relative-unit-list")
          ? "restored-reference-previously-suppressed-by-relative-unit-list"
          : after.scope === "cfr" && reference.family === "ina" && reference.ruleId === "context-cfr-ina-act-section"
            ? "restored-cfr-act-continuation-reference"
          : "unexpected-rendered-link";
        increment(summary.addedClassifications, classification);
        flags.push({
          type: "rendered-link-added",
          verdict: classification === "unexpected-rendered-link" ? "suspect" : "valid-restoration",
          classification,
          field: key,
          sourceReference: sourceReference(reference),
          currentLink: linkView(currentLink),
          baselineGroups: before.groups.filter(group => coveringGroups.includes(group.grammar) && group.start <= reference.start && group.end >= reference.end),
          context: excerpt(after.original, reference.start, reference.end)
        });
      }
      if (baselineLink) {
        if (targetIdentity(baselineLink) !== targetIdentity(currentLink)) {
          summary.renderedLinks.targetDifferences++;
          flags.push({ type: "rendered-link-target-changed", verdict: "target-difference", field: key, sourceReference: sourceReference(reference), baselineLink: linkView(baselineLink), currentLink: linkView(currentLink), context: excerpt(after.original, reference.start, reference.end) });
        }
        const dimensions = [];
        if (baselineLink.text !== currentLink.text) dimensions.push("text");
        if (baselineLink.citation !== currentLink.citation) dimensions.push("citation");
        if (dimensions.length) {
          summary.presentationChanges.count++;
          for (const dimension of dimensions) increment(summary.presentationChanges.byDimension, dimension);
          increment(summary.presentationChanges.byScope, after.scope);
          presentationChanges.push({ type: "presentation-change", dimensions, field: key, sourceReference: sourceReference(reference), baselineLink: linkView(baselineLink), currentLink: linkView(currentLink), context: excerpt(after.original, reference.start, reference.end) });
        }
      }
    }

    for (const [referenceIndex, linkIndex] of beforeToReference) {
      const reference = before.references[referenceIndex];
      if (afterLinkByOccurrence.has(sourceOccurrenceKey(reference))) continue;
      summary.renderedLinks.dropped++;
      summary.renderedLinks.lostDetections++;
      increment(summary.droppedClassifications, "lost-rendered-reference");
      flags.push({ type: "rendered-link-dropped", verdict: "lost-rendered-reference", classification: "lost-rendered-reference", field: key, sourceReference: sourceReference(reference), baselineLink: linkView(before.links[linkIndex]), context: excerpt(before.original, reference.start, reference.end) });
    }

    const linksDiffer = JSON.stringify(before.links) !== JSON.stringify(after.links);
    const displayedDiffer = before.displayed !== after.displayed;
    const groupsDiffer = JSON.stringify(before.groups) !== JSON.stringify(after.groups);
    if (linksDiffer) summary.fields.linkDifferences++;
    if (displayedDiffer) summary.fields.displayedTextDifferences++;
    if (groupsDiffer) summary.fields.groupDifferences++;
    records.push({ field: key, linksDiffer, displayedDiffer, groupsDiffer, baselineLinks: before.links.length, currentLinks: after.links.length });
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, `diff-flags-${cycle}.json`), `${JSON.stringify({ summary, flags, presentationChanges }, null, 2)}\n`);
  return { summary, flags, presentationChanges, records };
}

if (require.main === module) {
  const [baseline, current, output, cycle] = process.argv.slice(2);
  if (!baseline || !current || !output) {
    console.error("Usage: node tools/ina-display-audits/compare-display-inventories.js <baseline-dir/display.jsonl> <current-dir/display.jsonl> <output-dir>");
    process.exit(2);
  }
  const result = compare(baseline, current, output, cycle || "cycle1");
  console.log(JSON.stringify(result.summary, null, 2));
}

module.exports = { compare, readJsonl, referenceKey, linkKey, alignLinksToReferences };
