"use strict";
const assert = require("node:assert/strict");
const { applyStatuteFootnotes } = require("./statute-footnotes");
const { indexStatuteRunIns, statuteRunInMarkers } = require("./statute-run-ins");
const { correctedProjection, correctedSourceProjection, verifyCorpusIdentity } = require("./title8-update-gate");
const freshIdentity = { corpusVersion: "title8-119-121-source-usc-order.1-uslm.1", title8Update: { corpusVersion: "title8-119-121-source", xmlSha256: "source" }, sources: { title8: { sourceSha256: "source" } } };
verifyCorpusIdentity(freshIdentity);
assert.throws(() => verifyCorpusIdentity({ ...freshIdentity, corpusVersion: "older-usc-order.1-uslm.1" }), /corpus cache/);
assert.throws(() => verifyCorpusIdentity({ ...freshIdentity, corpusVersion: "title8-119-121-source-unreviewed" }), /corpus cache/);
const projection = correctedProjection({ section: "1", heading: "Example", notes: [{ text: "Note" }] });
assert.deepEqual(projection, JSON.parse(JSON.stringify(projection)), "Preservation snapshots must survive JSON serialization");
const group = { id: "8-1 to 2", section: "1 to 2" };
const children = [
  { section: "1", combinedHouseRecord: group.id, text: "First historical provision." },
  { section: "2", combinedHouseRecord: group.id, text: "Second historical provision." }
];
assert.deepEqual(correctedSourceProjection(group, children), children.map(correctedProjection),
  "Update preservation must check every delivered child of a combined House record");
assert.throws(() => correctedSourceProjection(group, []), /missing.*1 to 2/i,
  "An absent source record must fail the update gate instead of losing preservation coverage");

// A later release may legitimately contain a different number of footnotes.
const corpus = { title8: { sections: [{ section: "1101", preamble: "Law1 Note.", body: [] }] } };
const overlay = {
  schemaVersion: 1, corpusSchemaVersion: 3, sourceReleasePoint: "119-103",
  extraction: { footnotes: 1, references: 1, affectedFields: 1 },
  sections: { "1101": [{ id: "new-note", xmlId: "new-note", text: "Note." }] },
  fields: { "1101:preamble": { preamble: {
    flattenedText: "Law1 Note.", cleanText: "Law",
    footnoteReferences: [{ id: "new-note", xmlId: "new-note", offset: 3, flattenedInsertion: "1 Note." }]
  } } }
};
assert.equal(applyStatuteFootnotes(structuredClone(corpus), overlay).title8.houseFootnoteMetadata.footnotes, 1);
assert.throws(() => applyStatuteFootnotes(structuredClone(corpus), { ...overlay, extraction: { ...overlay.extraction, references: 2 } }), /count mismatch/i);
assert.throws(() => applyStatuteFootnotes(structuredClone(corpus), { ...overlay, extraction: { ...overlay.extraction, footnotes: -1 } }), /incomplete/i);
assert.throws(() => applyStatuteFootnotes({ title8: { sections: [{ section: "1101", preamble: "Changed law" }] } }, overlay), /source mismatch/i);

// Run the very same parser used by the standalone builder on fresh-source text.
assert.deepEqual(statuteRunInMarkers("See paragraph (1)(A)(i) of this subsection."), []);
const sample = { title8: { sections: [{ section: "9000", body: [{ label: "a", text: "(1)(A) First child. (B) Second child." }] }] } };
indexStatuteRunIns(sample);
assert(sample.title8.sections[0].runInPaths.some(path => path.join("/") === "a/1/A"));
assert(sample.title8.sections[0].runInPaths.some(path => path.join("/") === "a/1/B"));
console.log("PASS Title 8 updater: release-independent footnote integrity and fresh-source nested citation parsing");
