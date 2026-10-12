#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { applyStatuteFootnotes } = require("./statute-footnotes");
const { applyStatuteReferences } = require("./statute-references");
const { applyHistoricalIna } = require("./historical-ina");
const { applyStatuteStatusMetadata } = require("./statute-status");
const { applyHistoricalUsc } = require("./historical-usc");
const { indexStatuteRunIns } = require("./statute-run-ins");
const { applyGeneratedLegalReferences } = require("./legal-references");

const root = path.resolve(__dirname, "..");
const readObject = (file, key) => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", file), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window[key]));
};
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function generatedCorpus(includeOldSections) {
  const corpus = readObject("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
  corpus.inaHierarchy = readObject("INASearch-INA-Hierarchy.js", "INA_SEARCH_INA_HIERARCHY");
  corpus.legalReferencePolicy = readObject("INASearch-Legal-Reference-Policy.js", "INA_SEARCH_LEGAL_REFERENCE_POLICY");
  applyStatuteFootnotes(corpus, readObject("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES"));
  corpus.cfr = readObject("INASearch-CFR.js", "INA_SEARCH_CFR");
  applyStatuteReferences(corpus, readObject("INASearch-Statute-References.js", "INA_SEARCH_STATUTE_REFERENCES"));
  applyHistoricalIna(corpus);
  applyStatuteStatusMetadata(corpus);
  if (includeOldSections) applyHistoricalUsc(corpus);
  indexStatuteRunIns(corpus);
  corpus.referencedUsc = readJson("sources/legal/referenced-usc/corpus.json");
  indexStatuteRunIns({ title8: { sections: corpus.referencedUsc.titles.flatMap(title => title.sections) } });
  corpus.legalReferenceExceptions = readJson("sources/legal/embedded-reference-exceptions.json");
  corpus.historicalLocatorCorrections = readJson("sources/legal/historical-reference-locators.json");
  applyGeneratedLegalReferences(corpus);
  return corpus;
}

const affectedIds = new Set([
  "usc-8-1612-fnv1a-20780e0d-3397", "usc-8-1612-fnv1a-20780e0d-6059",
  "usc-8-1613-fnv1a-4d598d52-1329", "usc-8-1622-fnv1a-2b3e2ae3-155",
  "usc-8-1641-fnv1a-ebc2546a-611", "usc-8-1252-fnv1a-867a6c09-160",
  "usc-8-1101-fnv1a-234f0bd6-2696", "usc-8-1255-fnv1a-d74a2a18-3508",
  "usc-8-1101-fnv1a-18e8f355-3461", "usc-8-1101-fnv1a-d88bdc0f-4194",
  "usc-8-1101-fnv1a-d88bdc0f-4524", "usc-8-1101-fnv1a-d88bdc0f-4719",
  "usc-8-1101-fnv1a-d88bdc0f-5320"
]);
const corrections = readJson("sources/legal/historical-reference-locators.json").filter(row => affectedIds.has(row.id));
assert.equal(corrections.length, affectedIds.size);

function reviewedReference(corpus, row) {
  const section = corpus.title8.sections.find(item => item.section === row.section);
  const notes = (section?.notes || []).filter(note => sha256(note[row.field] || "") === row.sourceSha256);
  assert.equal(notes.length, 1, `${row.id}: reviewed source text must remain identifiable`);
  const note = notes[0];
  const property = row.field === "text" ? "references" : `${row.field}References`;
  const reference = (note[property] || []).find(item => item.start === row.start && item.end === row.end && item.text === row.text);
  assert(reference, `${row.id}: exact reviewed span must survive generation`);
  return { sourceText: note[row.field], reference };
}

const before = generatedCorpus(false);
const after = generatedCorpus(true);
assert(after.title8.sections.some(section => section.section === "243" && section.historical));
for (const row of corrections) {
  const original = reviewedReference(before, row);
  const expanded = reviewedReference(after, row);
  assert.equal(expanded.sourceText, original.sourceText, `${row.id}: current source note changed`);
  for (const { reference } of [original, expanded]) {
    assert.equal(reference.ruleId, "historical-reviewed-reference", row.id);
    assert.equal(reference.targetTitle, String(row.target.title), row.id);
    assert.equal(reference.targetSection, row.target.section, row.id);
    assert.deepEqual(reference.targetPath, row.target.path, row.id);
    assert.equal(reference.targetEdition, row.target.edition, row.id);
  }
}
console.log(`PASS historical reference stability: ${corrections.length} reviewed current-text locators survive individual old USC sections.`);
