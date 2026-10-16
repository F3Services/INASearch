"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const functionSource = require("./test-function-source");
const { createParser } = require("./test-mixed-citations");

const { api, corpus } = createParser();
const source = fs.readFileSync(path.join(__dirname, "../src/INASearch.template.html"), "utf8");
const sectionsById = new Map(corpus.title8.sections.map(section => [section.id, section]));
const context = vm.createContext({
  String, Math, Set, Number, Map,
  INA_SEARCH_OCCURRENCE: require("../src/INASearch-Occurrence"),
  normCitationPart: api.normCitationPart,
  componentTokens: value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]),
  compactStatutePathIndex: api.compactStatutePathIndex,
  uscSectionById: sectionsById,
  uscMapping: () => null,
  uscBase: section => `8 U.S.C. ${section.section}`,
  statuteNodeAtPath: (section, tokens) => {
    let nodes = section?.body || [], node = null;
    for (const token of tokens) {
      node = nodes.find(item => item.label === token);
      if (!node) return null;
      nodes = node.children || [];
    }
    return node;
  },
  statuteReferenceUnitIndexCache: new WeakMap(),
  pathStartsWith: (pathParts, prefix) => prefix.every((token, index) => pathParts[index] === token)
});
for (const name of [
  "indexedStatutePathExists", "structuralStatutePathExists", "statutoryRunInMarkers",
  "resolvedRunInStatutePath", "statutoryRunInSegments", "statuteReferencePathKey",
  "statuteReferenceUnitIndex", "statuteReferenceSelection"
]) vm.runInContext(functionSource(source, name), context);

for (const [number, requestedPath] of [
  ["1251", ["a", "4"]], ["1251", ["a", "4", "B"]],
  ["137", ["2", "A"]], ["1375", ["a", "3"]]
]) {
  const section = corpus.title8.sections.find(item => item.section === number);
  assert(section?.body?.[0]?.label === "", `§${number} is not a flat-body fixture`);
  const selection = context.statuteReferenceSelection(section, requestedPath);
  assert(selection?.kind === "virtual" && selection.segments.length, `§${number}${requestedPath.map(token => `(${token})`).join("")} has no exact preview`);
  assert(selection.segments.every(segment => requestedPath.every((token, index) => segment.path[index] === token)),
    `§${number} preview includes a sibling outside ${requestedPath.join("/")}`);
  assert.deepEqual([...selection.ownerPath], [], `§${number} blank body node became a phantom citation unit`);
}

let audited = 0;
for (const section of corpus.title8.sections.filter(item => item.body?.length === 1 && item.body[0].label === "" && item.runInPaths?.length)) {
  const indexed = new Set(section.runInPaths.map(tokens => tokens.join("/")));
  const segments = context.statutoryRunInSegments(section.body[0].text, "", {
    sectionId: section.id, currentPath: [], parentPath: [], citationBase: `8 U.S.C. ${section.section}`, targetPath: []
  });
  for (const segment of segments) {
    assert(indexed.has(segment.path.join("/")), `§${section.section}${segment.address} rendered at unindexed ${segment.path.join("/")}`);
    audited++;
  }
}

Object.assign(context, {
  escapeHtml: text => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
  canonicalPath: parts => parts.filter(Boolean).map(part => `(${part})`).join(""),
  statuteDefinitionContext: () => null,
  linkifyStatutoryText: text => text,
  HOUSE_FOOTNOTE_STATEMENT: "House editorial content."
});
for (const name of ["houseFootnoteReferenceId", "renderHouseEditorialFootnotes"])
  vm.runInContext(functionSource(source, name), context);
for (const [number, citation] of [["1231", "INA 241(a)(4)(B)(i)(I)"], ["1255", "INA 245(c)(5)"]]) {
  const section = corpus.title8.sections.find(item => item.section === number);
  const html = context.renderHouseEditorialFootnotes(section, null, citation.split("(")[0]);
  assert(html.includes(`data-show-citation="${citation}"`), `Inline footnote origins must navigate to the complete citation: ${citation}`);
  assert(html.includes(`>${citation.slice(citation.indexOf("("))}</a>`), `Footnotes must identify their inline statutory unit: ${citation}`);
}
console.log(`PASS flat statute reference previews: ${audited} rendered markers retain indexed paths and exact previews.`);

Object.assign(context, {
  uscSection: (_title, number) => corpus.title8.sections.find(section => section.section === number),
  legalCitationSelectionAttributes: () => "",
  legalUnitTriggerHtml: (_kind, _section, _path, _citation, contents) => contents,
  legalAugmentationSlotHtml: () => "",
  statuteRunInHeading: () => ""
});
for (const name of ["renderSearchHighlightedText", "formatStatutoryRunInText", "renderStatutoryNode"])
  vm.runInContext(functionSource(source, name), context);
context.linkifyStatutoryText = (text, _references, start = 0, end, match) => context.renderSearchHighlightedText(text, match, start, end);
const searchSection = corpus.title8.sections.find(section => section.section === "1363a");
const searchTarget = { kind: "node-text", path: ["a", "1", "C"], match: { start: 0, end: 7 } };
const searchHtml = context.renderStatutoryNode(searchSection.body[0], searchTarget.path, [], 0, searchTarget, "8 U.S.C. 1363a", searchSection.id, { sourceHost: { title: 8, section: "1363a" } });
const searchMarks = [...searchHtml.matchAll(/<mark\b[^>]*>([^<]*)<\/mark>/g)].map(match => match[1]);
assert.deepEqual(searchMarks, ["chapter"], "A child hit must not apply its offsets to parent text");
const flat = corpus.title8.sections.find(section => section.section === "1251");
const inlineSelection = context.statuteReferenceSelection(flat, ["a", "4", "B"]);
const inlineStart = inlineSelection.segments[0].contentStart;
const inlineTarget = { kind: "node-text", path: ["a", "4", "B"], match: { start: inlineStart, end: inlineStart + 8 } };
const inlineHtml = context.renderStatutoryNode(flat.body[0], inlineTarget.path, [], 0, inlineTarget, "8 U.S.C. 1251", flat.id, { sourceHost: { title: 8, section: "1251" } });
assert(inlineHtml.includes('<mark class="statute-search-match"'), "Virtual inline units must retain their hit highlight");
console.log("PASS search hits highlight only their owning statutory text");

// An unnumbered table is physical content of its labelled legal parent, not a
// second legal unit with permission to overwrite that parent's copy scope.
const tableParent = { label: "iii", heading: "Special rule", text: "A defined benefit plan must meet this table:", children: [
  { label: "", text: "If the participant's age is— The percentage is— 30 or less 2", table: {
    rows: [["If the participant's age is—", "The percentage is—"], ["30 or less", "2"]]
  }, children: [] }
] };
const tableSection = { id: "usc:26:9000", title: 26, section: "9000", body: [{ label: "x", children: [tableParent] }] };
const existingUscSection = context.uscSection;
context.uscSection = (title, number) => Number(title) === 26 && number === "9000" ? tableSection : existingUscSection(title, number);
context.uscSectionById.set(tableSection.id, tableSection);
assert.equal(context.statuteReferenceSelection(tableSection, ["x", "iii"]).node, tableParent,
  "An anonymous table must not replace the labelled parent legal-unit scope");
const tableTarget = { kind: "node-text", path: ["x", "iii"], sourceNode: tableParent.children[0], match: { start: 7, end: 24 } };
context.statutoryTableHtml = vm.runInContext(`(${functionSource(source, "statutoryTableHtml")})`, context);
const tableHtml = context.renderStatutoryNode(tableSection.body[0], [], [], 0, tableTarget, "26 U.S.C. 9000", tableSection.id, { sourceHost: { title: 26, section: "9000" } });
assert.deepEqual([...tableHtml.matchAll(/<mark\b[^>]*>([^<]*)<\/mark>/g)].map(match => match[1]), ["participant's age"],
  "A physical table hit highlights its cell instead of applying cell offsets to the parent's prose");
const selectedTable = context.renderStatutoryNode(tableSection.body[0], ["x", "iii"], [], 0, null, "26 U.S.C. 9000", tableSection.id, { sourceHost: { title: 26, section: "9000" } });
assert.equal((selectedTable.match(/class="statutory-node target"/g) || []).length, 1,
  "The labelled parent owns one selection box around prose and its anonymous table");
vm.runInContext(functionSource(source, "occurrenceReaderTarget"), context);
const exactTarget = context.occurrenceReaderTarget({ authority: "usc", recordId: tableSection.id, path: ["x", "iii"],
  target: { field: "body", subfield: "text", recordPath: [0, 0, 0], start: 0 }, snippet: { matchStart: 7, matchEnd: 24 } });
assert.deepEqual([...exactTarget.target.recordPath], [0, 0, 0], "The reader retains the search projection's separate physical source locator");
const ordinaryTarget = context.occurrenceReaderTarget({ authority: "ina", recordId: "8-1101", path: ["a", "15", "H", "ii", "a"], target: { field: "body", subfield: "text" } });
assert.deepEqual([...ordinaryTarget.target.path], ["a", "15", "H", "ii", "a"]);
assert.equal(Object.hasOwn(ordinaryTarget.target, "recordPath"), false, "Ordinary citations without a physical locator do not acquire extra identifier fields");
console.log("PASS statute targets: legal parent scope, exact physical table hits and optional occurrence metadata");
