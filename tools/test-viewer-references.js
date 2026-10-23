#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
const { api: parser } = require("./test-mixed-citations").createParser();
const noteContext = vm.createContext({ parseCitation: parser.parseCitation, citationCrosswalk: () => null });
for (const name of ["associationFromCitationResult", "prepareNoteReferenceTrigger"]) vm.runInContext(functionSource(template, name), noteContext);
for (const [input, family, title, section] of [
  ["8 USC 1153(a)(1)", "usc", "8", "1153"], ["18 USC 16", "usc", "18", "16"],
  ["INA 203(a)(1)", "usc", "8", "1153"], ["8 CFR 214.2(a)(1)", "cfr", "8", "214.2"]
]) {
  const trigger = { dataset: { noteReference: input }, removeAttribute() {}, textContent: input };
  assert.equal(noteContext.prepareNoteReferenceTrigger(trigger), true);
  assert.equal(trigger.dataset.referenceFamily, family, `${input}: one canonical reference family`);
  assert.equal(trigger.dataset.referenceTitle, title, `${input}: preserve the source title`);
  assert.equal(trigger.dataset.referenceSection, section, `${input}: use the section number, not the parser's section object`);
}
console.log("PASS note reference targets: shared INA/USC/CFR normalization");

const section = { id: "8-9000", section: "9000", body: [{ label: "a", text: "Alpha.",
  textFootnoteReferences: [{ id: "editorial-1", number: "3", offset: 5 }] }],
  houseEditorialFootnotes: [{ id: "editorial-1", number: "3", text: "See Source note below.", targetNoteId: "source-note" }],
  notes: [{ id: "source-note", heading: "Source", text: "Full related explanation.", bodyStart: 0 }] };
const fixture = { inaCrosswalk: [], title8: { sections: [section] } };
const api = require("./audit-ina-display").runtime(template, fixture);
Object.assign(api, {
  statuteReferenceUnitIndexCache: new WeakMap(),
  statutoryRunInMarkers: require("./statute-run-ins").statuteRunInMarkers,
  pathStartsWith: (path, prefix) => prefix.every((token, index) => path[index] === token),
  statuteDefinitionContext: () => null
});
for (const name of ["statutoryRunInSegments", "statuteReferencePathKey", "statuteReferenceUnitIndex", "statuteReferenceSelection",
  "houseFootnoteReferenceId", "statuteNoteBodyStart", "formatStatuteNoteBody", "renderStatuteNoteBody",
  "statuteExcerptFootnotesHtml", "insertedStatuteNodeHtml", "insertedStatuteExcerptHtml"]) vm.runInContext(functionSource(template, name), api);
const target = { kind: "usc", section, path: ["a"] };
const excerpt = api.insertedStatuteExcerptHtml(target, false, "test-card");
assert(excerpt.includes("See Source note below."), "An inserted footnote marker must include its editorial explanation");
assert(excerpt.includes("Full related explanation."), "An onward source-note destination must accompany its inserted footnote");
assert.match(excerpt, /<details[^>]*id="test-card-statute-note-source-note"[\s\S]*?data-house-footnote-return=/,
  "An onward source note must let the reader return to the exact inserted marker");
const ids = new Set([...excerpt.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const href of [...excerpt.matchAll(/href="#([^"]+)"/g)].map(match => match[1])) {
  assert(ids.has(href), `Inserted excerpt link has no local destination: ${href}`);
}
const second = api.insertedStatuteExcerptHtml(target, false, "second-card");
for (const id of [...second.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])) assert(!ids.has(id), "Repeated excerpts must have instance-scoped footnote IDs");
console.log("PASS inserted footnotes: complete explanation, onward notes, local destinations and independent instances");

const clippedSection = { id: "8-9001", section: "9001", body: [{ label: "a", text: "x".repeat(13000),
  textFootnoteReferences: [{ id: "early", number: "1", offset: 10 }, { id: "late", number: "2", offset: 12500 }] }],
  houseEditorialFootnotes: [{ id: "early", number: "1", text: "Visible explanation." }, { id: "late", number: "2", text: "Later explanation." }] };
const clippedTarget = { kind: "usc", section: clippedSection, path: [] };
const clipped = api.insertedStatuteExcerptHtml(clippedTarget, false, "clipped-card");
assert(clipped.includes("Visible explanation."));
assert(!clipped.includes("Later explanation."), "A clipped excerpt must not include explanations for markers outside its visible text");
assert(api.insertedStatuteExcerptHtml(clippedTarget, true, "full-card").includes("Later explanation."),
  "Show full must restore the explanation for a newly visible marker");
console.log("PASS clipped footnotes: append only explanations belonging to rendered source text");

const secondOrigin = { id: "pane-two-second-marker" };
const localReturn = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
const excerptEntry = { tagName: "LI", dataset: {}, parentElement: null,
  matches: selector => selector.split(/,\s*/).includes(".legal-reference-preview-footnotes li"), focus() {} };
const navigation = vm.createContext({ els: { detail: {} }, $$: () => [localReturn], materializeStatuteNotes() {}, scrollStatuteAnchorToReadingLine() {} });
vm.runInContext(functionSource(template, "revealStatuteNoteTarget"), navigation);
navigation.revealStatuteNoteTarget(excerptEntry, secondOrigin);
assert.equal(excerptEntry.dataset.houseFootnoteActiveReference, secondOrigin.id,
  "An inserted footnote must retain the clicked occurrence for its onward note, including a second marker in another pane");
assert.equal(localReturn.href, "#pane-two-second-marker", "The footnote return link must follow the exact local marker");
console.log("PASS excerpt footnote navigation: retain the clicked occurrence through onward notes");

const collapsedCard = { dataset: { expanded: "false" } };
const clippedFootnoteTarget = { parentElement: null, matches: () => false,
  closest: selector => selector === ".inserted-reference-card" ? collapsedCard : null,
  focus() {} };
navigation.revealStatuteNoteTarget(clippedFootnoteTarget);
assert.equal(collapsedCard.dataset.footnoteRevealed, "true",
  "Jumping to an inserted footnote must reveal content behind the excerpt's collapsed boundary");

const regulation = { id: "8:999.1", title: 8, section: "999.1", heading: "Table fixture", blocks: [
  { t: "p", a: "(a)", x: "(a) Source text." },
  { t: "table", c: "(a)", rows: [[{ h: true, x: "Designation" }, { x: "Requirement" }]] },
  { t: "graphic", c: "(a)", mime: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", alt: "Source diagram" },
  { t: "graphic", c: "(a)", src: "source-diagram.gif", alt: "Unavailable diagram" },
  { t: "p", a: "(b)", x: "(b) Other provision." },
  { t: "graphic", c: "(b)", data: "excluded", alt: "Other diagram" }
] };
Object.assign(api, {
  INASearchCfrHierarchy: require("../src/INASearch-CFR-Hierarchy"),
  INA_SEARCH_INSERTIONS: require("../src/INASearch-Insertions"),
  cfrSectionIdMap: new Map([[regulation.id, regulation]]),
  cfrDefinitionContext: () => null,
  componentTokens: value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1])
});
api.hydratedLegalReferenceRoots = new WeakSet();
const cfrPreviewFunctions = ["expandPackedHouseHref", "hydrateLegalReferences", "cfrGraphicHtml", "cfrBlockPlainText", "flattenedCfrBlocks", "cfrUnitText", "legalReferenceContextForElement", "linkifyCfrText",
  "renderCfrStyledRange", "insertedCfrTextRanges", "insertedCfrBlockHtml", "insertedCfrExcerptHtml", "cfrReferencePreviewHtml"];
for (const name of cfrPreviewFunctions) vm.runInContext(functionSource(template, name), api);
const cfrPreview = api.legalReferenceContextForElement({ dataset: { referenceFamily: "cfr", referenceResolution: "local", referenceTitle: "8", referenceSection: "999.1", referencePath: '["a"]' } });
assert(cfrPreview.previewHtml.includes("<table>"), "CFR reference previews retain the same table structure as inserted excerpts");
assert(cfrPreview.previewHtml.includes("Designation"));
assert(cfrPreview.text.includes("Requirement"), "Rich previews retain complete source text for copy actions");
assert.match(cfrPreview.previewHtml, /<img[^>]*alt="Source diagram"/,
  "A scoped rich preview must preserve graphics within the cited provision");
assert(cfrPreview.previewHtml.includes("source-diagram.gif"), "An unavailable graphic must retain its source warning");
assert(!cfrPreview.previewHtml.includes("Other diagram"), "A scoped preview must exclude a sibling provision's graphic");
assert(!cfrPreview.previewHtml.includes('class="cfr-block'), "Preview graphics must not become main reader citation hosts");
console.log("PASS CFR previews: shared rich excerpt rendering retains tables and scoped graphics");
for (const [family,title,section,edition,label] of [['cfr','20','655.202','2013','CFR'],['usc','8','1254','1994','U.S. Code']]) {
  const archived=api.legalReferenceContextForElement({dataset:{referenceFamily:family,referenceResolution:'official-source-only',referenceTitle:title,referenceSection:section,referencePath:'["b","6"]',referenceEdition:edition}});
  assert(archived.historicalTarget.message.includes(`${edition} ${label} edition`),'Historical preview must name the cited authority family');
  if(family==='cfr')assert(!archived.historicalTarget.message.includes('U.S. Code'),'Archived CFR preview cannot describe a Code edition');
}

const packedCorpus = require("./read-build-corpus").readBuildCorpus(require.resolve("../INASearch.html"));
const coldSection = packedCorpus.cfr.sections.find(item => item.id === "8:212.4");
assert(coldSection && JSON.stringify(coldSection).includes('"_lr"'), "The cold-preview fixture must retain its packed legal references");
const coldApi = require("./audit-ina-display").runtime(template, packedCorpus);
Object.assign(coldApi, { INASearchCfrHierarchy: api.INASearchCfrHierarchy, INA_SEARCH_INSERTIONS: api.INA_SEARCH_INSERTIONS,
  cfrDefinitionContext: () => null, componentTokens: api.componentTokens, pathStartsWith: api.pathStartsWith,
  hydratedLegalReferenceRoots: new WeakSet() });
for (const name of cfrPreviewFunctions) vm.runInContext(functionSource(template, name), coldApi);
const coldHtml = coldApi.cfrReferencePreviewHtml(coldSection, ["a", "1"]);
assert.equal((coldHtml.match(/\bdata-legal-reference\b/g) || []).length, 3,
  "Opening a CFR preview before its reader must decode and retain all three packed citation links");
coldApi.hydrateLegalReferences(coldSection);
assert.equal(coldApi.cfrReferencePreviewHtml(coldSection, ["a", "1"]), coldHtml,
  "A cold CFR preview must match the same preview after normal reader hydration");
console.log("PASS cold CFR previews: packed references hydrate before rich rendering");
