#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const functionSource = require("./test-function-source");
const { runtime, plain } = require("./audit-ina-display");
const { readBuildCorpus } = require("./read-build-corpus");
const { unpackLegalReferences } = require("./pack-legal-references");
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const api = runtime(template, { title8: { sections: [] }, inaCrosswalk: [] });
api.profile.preferences.statutoryLinkCitationSystem = "usc";
api.houseFootnoteReferenceId = reference => reference.id;
// The publisher places an editorial marker inside wording that our linkifier
// recognizes as one citation. Read its actual position instead of duplicating
// the original sentence or trusting generated overlay offsets.
const original = JSON.parse(execFileSync("python3", ["-c", `
import json, re, xml.etree.ElementTree as E
r=E.parse('sources/legal/raw/usc08@119-102.xml').getroot()
n=next(n for n in r.iter() if n.get('identifier')=='/us/usc/t8/s1158/c/3')
p=next(n for n in n.iter() if n.tag.endswith('}p'))
text=''; marker=None
def walk(n):
 global text,marker
 text+=n.text or ''
 for c in n:
  tag=c.tag.rsplit('}',1)[-1]
  if tag=='ref' and c.get('class')=='footnoteRef':marker={'id':c.get('idref'),'number':''.join(c.itertext()),'offset':len(re.sub(r'\\s+',' ',text).strip())}
  elif tag!='note':walk(c)
  text+=c.tail or ''
walk(p)
print(json.dumps({'text':re.sub(r'\\s+',' ',text).strip(),'marker':marker}))
`], { encoding: "utf8" }));
const start = original.text.indexOf("section 1182(a)");
const reference = { start, end: start + "section 1182(a)".length, text: "section 1182(a)", family: "usc", targetTitle: "8", targetSection: "1182", targetPath: ["a"], resolution: "official-source-only" };
const html = api.linkifyStatutoryText(original.text, [reference], 0, undefined, null, [original.marker]);
assert.equal((html.match(/class="house-footnote-reference"/g) || []).length, 1, "Original §1158(c)(3) marker must survive an overlapping citation");
assert(html.indexOf('class="house-footnote-reference"') > html.indexOf("section"));
assert(html.indexOf('class="house-footnote-reference"') < html.lastIndexOf("1182(a)"), "Marker must remain after section, before its number");
let anchorDepth = 0;
for (const match of html.matchAll(/<\/?a\b[^>]*>/g)) {
  anchorDepth += match[0].startsWith("</") ? -1 : 1;
  assert(anchorDepth >= 0 && anchorDepth <= 1, "Footnotes must not create nested links");
}
assert.equal(anchorDepth, 0);
console.log("PASS USLM rendering: original editorial marker survives citation overlap");

const corpus = unpackLegalReferences(readBuildCorpus("INASearch.html"));
const previewApi = runtime(template, corpus);
for (const name of ["superscriptNumber", "textWithHouseFootnoteMarkers", "statuteTextRangeWithHouseFootnotes"])
  vm.runInContext(functionSource(template, name), previewApi);
const visibleText = html => plain(html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, ""));
for (const [sectionNumber, path, convertedCitation] of [
  ["1182", ["n", "2", "C", "vii", "II"], "INA 214(c)(1)"],
  ["1184", ["c", "1"], "INA 218"]
]) {
  const section = corpus.title8.sections.find(section => section.section === sectionNumber);
  let node = { children: section.body };
  for (const token of path) node = node.children.find(child => child.label === token);
  const context = { kind: "usc", uscSection: sectionNumber, path,
    sourceHost: { kind: "usc", title: 8, section: sectionNumber, path } };
  for (const preference of ["ina", "usc", "view"]) for (const view of ["ina", "usc"]) {
    previewApi.profile.preferences.statutoryLinkCitationSystem = preference;
    previewApi.state.statuteHierarchyAuthority = view;
    const native = previewApi.linkifyStatutoryText(node.text, node.references, 0, undefined, null, [],
      { ...context, sourceLayout: node.textLayout, sourcePresentation: node.textPresentation });
    const preview = previewApi.statuteFieldPreviewHtml(node, "text", 0, node.text.length, new Set(), null, context);
    assert.equal(visibleText(native).includes(convertedCitation), preference === "ina" || preference === "view" && view === "ina",
      "The native reader fixture must exercise the selected citation display setting");
    assert.equal(visibleText(preview), visibleText(native),
      `${sectionNumber}${path.join("/")}: hover text must match native citation formatting (${preference}/${view})`);
  }
}
console.log("PASS hover citation formatting: reported INA 212 reference and INA 214(c)(1) target follow all three view settings");

// Open a complete preview from a cold, packed section, as hovering does before
// the native reader has ever visited the target.
const packed = readBuildCorpus("INASearch.html");
const coldPreview = runtime(template, packed);
Object.assign(coldPreview, {
  hydratedLegalReferenceRoots: new WeakSet(), statuteReferenceUnitIndexCache: new WeakMap(),
  compactStatutePathIndex: require("./test-mixed-citations").createParser().api.compactStatutePathIndex,
  pathStartsWith: (path, prefix) => prefix.every((token, index) => path[index] === token)
});
for (const name of ["componentTokens", "statuteNodeAtPath", "statuteDefinitionContext", "expandPackedHouseHref", "hydrateLegalReferences",
  "superscriptNumber", "statutoryRunInMarkers", "indexedStatutePathExists", "structuralStatutePathExists", "resolvedRunInStatutePath",
  "statutoryRunInSegments", "statuteReferencePathKey", "statuteReferenceUnitIndex", "statuteReferenceSelection",
  "statuteReferenceRunInLineHtml", "statuteReferencePreviewNodeHtml", "statuteExcerptFootnotesHtml", "statuteReferencePreviewHtml"])
  vm.runInContext(functionSource(template, name), coldPreview);
const targetSection = packed.title8.sections.find(section => section.section === "1184");
const targetNode = coldPreview.statuteNodeAtPath(targetSection, ["c", "1"]);
assert(targetNode._lr && !targetNode.references, "The cold-preview fixture must start with packed references");
for (const view of ["ina", "usc"]) {
  coldPreview.profile.preferences.statutoryLinkCitationSystem = "view";
  coldPreview.state.statuteHierarchyAuthority = view;
  const preview = coldPreview.statuteReferencePreviewHtml(targetSection, ["c", "1"]);
  assert.equal(visibleText(preview).includes("INA 218"), view === "ina", "The full hover preview must apply Follow View to hydrated references");
  assert(!preview.includes("data-legal-reference"), "Formatting preview text must not introduce nested citation hover triggers");
}
assert(targetNode.references.length > 0, "Hovering must hydrate the previously unopened target's citations");
console.log("PASS complete hover preview: cold packed target, source context and Follow View");
