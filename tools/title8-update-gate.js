#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { readArtifact, collectFields } = require("./audit-inline-references");

const assigned = name => {
  const text = fs.readFileSync(name, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
};
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function legalSource(value) {
  if (Array.isArray(value)) return value.map(legalSource);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["source", "sourceCreditSource", "url"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, legalSource(item)]));
}
function correctedProjection(section) {
  const fields = [];
  function visit(node, location) {
    const item = { location };
    if (node.label !== undefined) item.label = node.label;
    if (node.u !== undefined) item.unitType = node.u;
    if (node.path !== undefined) item.path = node.path;
    for (const field of ["heading", "text", "preamble", "continuation", "sourceCredit"]) {
      if (typeof node[field] !== "string") continue;
      const property = field === "text" ? "references" : `${field}References`;
      item[field] = node[field];
      item[property] = (node[property] || []).map(reference => Object.fromEntries(
        ["start", "end", "text", "family", "targetTitle", "targetSection", "targetPath", "targetEdition", "targetKind", "ruleId", "resolution"]
          .filter(key => reference[key] !== undefined).map(key => [key, reference[key]])
      ));
    }
    fields.push(item);
    for (const key of ["body", "children", "notes"]) (node[key] || []).forEach((child, index) => visit(child, `${location}/${key}/${index}`));
  }
  visit(section, section.section);
  return { fields, runInPaths: section.runInPaths || [] };
}
function snapshot() {
  const authored = assigned("src/INASearch-Corpus.js");
  const built = readArtifact("INASearch.html");
  const generated = assigned("src/INASearch-Statute-References.js");
  const sections = new Map([...(built.historicalUsc?.groupSources || []), ...built.title8.sections].map(section => [section.section, section]));
  return {
    sections: Object.fromEntries(authored.title8.sections.map(section => [section.section, {
      sourceHash: hash(legalSource(section)), corrected: correctedProjection(sections.get(section.section))
    }])),
    skippedHouseReferences: generated.extraction.skipped,
  };
}
function verify(before) {
  const after = snapshot();
  let unchanged = 0;
  for (const [number, source] of Object.entries(before.sections)) {
    if (source.sourceHash !== after.sections[number]?.sourceHash) continue;
    assert.deepEqual(after.sections[number].corrected, source.corrected, `Unchanged §${number} lost a corrected child address or citation`);
    unchanged++;
  }
  const allowedSkips = new Set(before.skippedHouseReferences.map(item => JSON.stringify(item)));
  for (const skipped of after.skippedHouseReferences) {
    assert(allowedSkips.has(JSON.stringify(skipped)), `New unmapped House reference: ${skipped.sourceKey}`);
  }
  const corpus = readArtifact("INASearch.html");
  verifyCorpusIdentity(corpus);
  // Every reviewed exact-span override must remain identifiable. A changed
  // source note needs new review instead of silently losing its correction.
  const rows = verifyReviewed(corpus);
  console.log(`PASS update preservation: ${unchanged} unchanged sections retain corrected addresses/references; ${rows} reviewed locators reapplied`);
}
function verifyCorpusIdentity(corpus) {
  // The standalone build adds reviewed source-order and presentation revisions
  // after choosing the new source identity. Both must remain in the cache key.
  assert.equal(corpus.corpusVersion, corpus.title8Update.corpusVersion + "-usc-order.1-uslm.1", "Fresh law must invalidate the old browser corpus cache");
  assert.equal(corpus.sources.title8.sourceSha256, corpus.title8Update.xmlSha256);
}
function verifyReviewed(corpus) {
  const rows = JSON.parse(fs.readFileSync("sources/legal/historical-reference-locators.json", "utf8"));
  const fields = collectFields(corpus);
  for (const row of rows) {
    const matches = fields.filter(field => field.field === row.field &&
      (row.kind === "usc" ? field.sourcePath.startsWith(`title8.sections[${row.section}]`) : field.sourceId === `cfr-${row.title}:${row.section}`) &&
      crypto.createHash("sha256").update(field.text).digest("hex") === row.sourceSha256);
    assert(matches.length > 0, `Reviewed historical correction ${row.id} requires renewed source review`);
    for (const match of matches) {
      const reference = match.references.find(item => item.start === row.start && item.end === row.end && item.text === row.text);
      assert.equal(reference?.ruleId, "historical-reviewed-reference", `Reviewed correction ${row.id} was not reapplied`);
    }
  }
  return rows.length;
}
if (require.main === module) {
  if (process.argv[2] === "snapshot") fs.writeFileSync(process.argv[3], JSON.stringify(snapshot()));
  else if (process.argv[2] === "verify") verify(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
  else throw new Error("Usage: title8-update-gate.js snapshot|verify FILE");
}
module.exports = { correctedProjection, legalSource, verifyReviewed, verifyCorpusIdentity };
