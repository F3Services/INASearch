#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { readBuildCorpus } = require("./read-build-corpus");
const { runtime } = require("./audit-ina-display");
const functionSource = require("./test-function-source");
const occurrence = require("../src/INASearch-Occurrence");
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const corpus = { title8: { sections: [] }, inaCrosswalk: [] };
const api = runtime(template, corpus);
api.INA_SEARCH_OCCURRENCE = occurrence;
Object.assign(api, {
  statutoryRunInMarkers: require("./statute-run-ins").statuteRunInMarkers,
  legalCitationSelectionAttributes: () => "",
  legalUnitTriggerHtml: (_kind, _id, _path, _citation, number) => number,
  legalAugmentationSlotHtml: () => ""
});
for (const name of ["superscriptNumber", "textWithHouseFootnoteMarkers", "statuteTextRangeWithHouseFootnotes", "legalFieldPlainText", "statuteNodePlainText", "statuteReferencePreviewNodeHtml", "insertedStatuteNodeHtml"]) vm.runInContext(functionSource(template, name), api);
for (const name of ["formatStatutoryRunInText", "renderStatutoryNode"]) vm.runInContext(functionSource(template, name), api);
const node = { label: "a", text: "Start Middle End", childTextOffsets: [5, 12], children: [
  { label: "1", text: "One" }, { label: "2", text: "Two" }
] };
const squeeze = text => text.replace(/\s+/g, "");
const plain = html => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const expected = "(a)Start(1)OneMiddle(2)TwoEnd";
const { applyStatuteFootnotes } = require("./statute-footnotes");
const footnoteCorpus = { title8: { sections: [{ section: "9000", body: [{ label: "a", text: "Start11Editorial. End", childTextOffsets: [17], children: [{ label: "1", text: "One" }] }] }] } };
applyStatuteFootnotes(footnoteCorpus, {
  extraction: { footnotes: 1, references: 1, affectedFields: 1 },
  fields: { "9000:a": { text: { flattenedText: "Start11Editorial. End", cleanText: "Start End", childTextOffsets: [5], footnoteReferences: [{ id: "note", number: "1", offset: 5, flattenedInsertion: "11Editorial." }] } } },
  sections: { "9000": [{ id: "note", text: "Editorial." }] }
});
assert.deepEqual(footnoteCorpus.title8.sections[0].body[0].childTextOffsets, [5], "Footnote removal must remap child positions");
const boundary = { label: "a", text: "Start End", childTextOffsets: [5], children: [{ label: "1", text: "One" }], textFootnoteReferences: [
  { id: "before", number: "1", offset: 5, afterChild: 0 },
  { id: "after", number: "2", offset: 5, afterChild: 1 }
] };
assert.equal(squeeze(api.statuteNodePlainText(boundary)), "(a)Start¹(1)One²End", "Equal footnote offsets must retain their side of the child boundary");
assert.equal(squeeze(api.statuteNodePlainText(boundary, 0, new Set(), {})), "(a)Start¹(1)One²End");
assert.equal(squeeze(plain(api.statuteReferencePreviewNodeHtml(boundary))), "(a)Start¹(1)One²End");
const markerOnly = { ...boundary, childTextOffsets: [5, 5], children: [...boundary.children, { label: "2", text: "Two" }] };
assert.equal(squeeze(api.statuteNodePlainText(markerOnly)), "(a)Start¹(1)One²(2)TwoEnd", "A footnote-only continuation must retain its position between children");
assert.equal(squeeze(plain(api.statuteReferencePreviewNodeHtml(markerOnly))), "(a)Start¹(1)One²(2)TwoEnd");
api.houseFootnoteReferenceId = reference => reference.id;
for (const html of [api.insertedStatuteNodeHtml(boundary, {}, { remaining: 1000 }), api.renderStatutoryNode(boundary, [], [], 0, null, "8 U.S.C. 9000", "8-9000")]) {
  assert.equal(squeeze(plain(html)), "(a)Start1(1)One2End", "Reader and insertion must keep boundary footnotes on their source side");
}
assert.equal(squeeze(api.statuteNodePlainText(node)), expected, "Copy must preserve middle and trailing parent text");
assert.equal(squeeze(api.statuteNodePlainText(node, 0, new Set(), {})), expected, "Formatted copy must preserve source order");
assert.equal(squeeze(plain(api.statuteReferencePreviewNodeHtml(node))), expected, "Preview must preserve source order");
assert(plain(api.statuteReferencePreviewNodeHtml({ ...node, heading: "Scope" })).includes("Scope Start"), "Split-parent preview must separate its heading from its opening text");
assert.equal(squeeze(plain(api.insertedStatuteNodeHtml(node, {}, { remaining: 1000 }))), expected, "Inserted excerpt must preserve source order");
for (const deferred of [null, '<template data-reader-children></template>']) {
  const html = api.renderStatutoryNode(node, [], [], 0, { kind: "node-text", path: ["a"], match: { start: 6, end: 12 } }, "8 U.S.C. 9000", "8-9000", null, deferred);
  assert.equal(squeeze(plain(html)), expected, "Reader and incremental reader must preserve source order");
  assert(html.indexOf('data-statute-search-match') > html.indexOf('One') && html.indexOf('data-statute-search-match') < html.indexOf('Two'), "Continuation search highlight belongs between the children");
  assert(!html.includes('data-reader-children'), "Ordered subtree cannot leave deferred children in the wrong slot");
}
const budget = { remaining: 8 };
const excerpt = squeeze(plain(api.insertedStatuteNodeHtml(node, {}, budget)));
assert.equal(excerpt, "(a)Start(1)One", "Truncation must consume source order, not the whole parent field first");
assert(budget.truncated);
const sample = { ...corpus, title8: { sections: [{ id: "8-9000", section: "9000", heading: "Test", body: [node] }] } };
const projection = occurrence.buildProjection(sample);
assert.deepEqual(projection.fragments.filter(f => f.kind === "statute-node").map(f => f.text.trim()), ["Start", "One", "Middle", "Two", "End"], "Search must follow source order and split nonadjacent parent text");
assert.deepEqual(projection.fragments.filter(f => f.kind === "statute-node" && f.path.length === 1).map(f => f.source.start), [0, 5, 12], "Search targets must retain original field offsets");

const rawContext = { window: {} };
vm.runInNewContext(fs.readFileSync("src/INASearch-Corpus.js", "utf8"), rawContext);
const authoritySection = rawContext.window.INA_SEARCH_CORPUS.title8.sections.find(section => section.section === "1357");
require("./statute-run-ins").indexStatuteRunIns({ title8: { sections: [authoritySection] } });
const authorityNode = authoritySection.body.find(node => node.label === "a");
const continuationPaths = require("./statute-run-ins").statuteRunInPathMarkers(authoritySection, authorityNode, ["a"]).map(marker => marker.path.join("/"));
assert.deepEqual(continuationPaths, ["a/i", "a/ii", "a/iii", "a/iv"], "USLM continuation clauses must stay within their source parent");
const authorityProjection = occurrence.buildProjection({ ...corpus, title8: { sections: [authoritySection] } });
assert(authorityProjection.fragments.some(fragment => fragment.path.join("/") === "a/iv" && fragment.text.includes("internal investigations")), "Search must retain the final continuation clause in its parent");
api.uscSectionById.set(authoritySection.id, authoritySection);
Object.assign(api, {
  componentTokens: value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]),
  statuteReferenceUnitIndexCache: new WeakMap(),
  pathStartsWith: (path, prefix) => prefix.every((token, index) => path[index] === token),
  indexedStatutePathExists: () => false,
  structuralStatutePathExists: () => false
});
for (const name of ["resolvedRunInStatutePath", "statutoryRunInSegments", "statuteReferencePathKey", "statuteReferenceUnitIndex", "statuteReferenceSelection"]) vm.runInContext(functionSource(template, name), api);
assert.equal(api.statuteReferenceSelection(authoritySection, ["a"]).textEnd, authorityNode.text.length, "Selecting a parent must retain its entire continuation");

const separatedRunIn = { label: "A", text: "(i) First Tail", childTextOffsets: [9], children: [{ label: "II", text: "Child" }] };
const splitSection = { id: "8-9001", section: "9001", body: [{ label: "a", children: [{ label: "1", children: [separatedRunIn] }] }] };
api.uscSectionById.set(splitSection.id, splitSection);
const splitSelection = api.statuteReferenceSelection(splitSection, ["a", "1", "A", "i"]);
assert.equal(splitSelection.segments[0].contentEnd, 9, "Virtual clauses must stop at a structural child boundary");
const splitProjection = occurrence.buildProjection({ ...corpus, title8: { sections: [splitSection] } });
assert.equal(splitProjection.fragments.find(fragment => fragment.text.trim() === "Tail")?.path.join("/"), "a/1/A", "Unnumbered continuation prose must retain its structural parent in search");

separatedRunIn.textFootnoteReferences = [{ id: "boundary-inline", number: "1", offset: 9, afterChild: 0 }];
Object.assign(api, { hydrateLegalReferences: () => {}, statuteDefinitionContext: () => null });
for (const name of ["statuteFootnoteAppendix", "statuteReferenceRunInLineHtml", "statuteUnitText", "insertedStatuteExcerptHtml"]) vm.runInContext(functionSource(template, name), api);
assert.equal(squeeze(plain(api.statuteReferenceRunInLineHtml(separatedRunIn, splitSelection.segments[0], ["a", "1", "A"]))), "(i)First¹", "An inline preview must retain a footnote before the structural child");
for (const format of ["source", "ina"]) assert.equal(squeeze(api.statuteUnitText(splitSection, ["a", "1", "A", "i"], format)), "(i)First¹", "Inline copy must preserve its boundary footnote");
assert.equal(squeeze(plain(api.insertedStatuteExcerptHtml({ section: splitSection, path: ["a", "1", "A", "i"] }))), "(i)First1", "An inline excerpt must preserve its boundary footnote");

if (!process.argv.includes("--unit-only")) {
  const oracle = JSON.parse(execFileSync("python3", ["-B", "tools/usc-source-order-oracle.py"], { maxBuffer: 20 * 1024 * 1024 }));
  for (const file of ["INASearch.html", "INASearch-Uncompressed.html"]) {
    const built = readBuildCorpus(file);
    let checked = 0;
    for (const expected of oracle.title8) {
      const section = built.title8.sections.find(s => s.section === expected.section);
      if (!section && !expected.text) continue; // Disposition groups are expanded into historical members.
      assert(section, `Missing section ${expected.section}`);
      // Historical replacements have separate historical-source regression tests;
      // the current USLM correctly contains no former operative text for them.
      if (section.historical) continue;
      const text = occurrence.statuteContentParts(section, "preamble", "body").map(part => part.kind === "child"
        ? api.statuteNodePlainText(part.node)
        : api.statuteTextRangeWithHouseFootnotes(section[part.field], occurrence.statutePartFootnotes(section, part), part.start, part.end)).join(" ");
      assert.equal(squeeze(text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, "")), expected.text, `${file}: source order in 8 USC ${section.section}`);
      checked++;
    }
    for (const expected of oracle.referenced) {
      const section = built.referencedUsc.titles.find(t => t.number === expected.title).sections.find(s => s.section === expected.section);
      const text = [section.preamble, ...(section.body || []).map(node => api.statuteNodePlainText(node))].filter(Boolean).join(" ");
      assert.equal(squeeze(text), expected.text, `${file}: source order in ${expected.title} USC ${expected.section}`);
    }
    console.log(`PASS ${file}: ${checked} sections compared directly with original USLM; ${oracle.referenced.length} cross-title sections with original HTML`);
  }
}
console.log("PASS USC reading order: footnotes, copy, formatted copy, preview, inserted excerpt and search");
