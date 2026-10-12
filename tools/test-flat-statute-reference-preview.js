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
