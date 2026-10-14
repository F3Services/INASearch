"use strict";
const assert = require("node:assert/strict");
const { generatedReferences, legalReferenceContext } = require("./legal-references");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");
const corpus = { title8: { sections: [
  { section: "1101", breadcrumb: [{ kind: "chapter", number: "12" }, { kind: "subchapter", number: "I" }], body: [] },
  { section: "1151", breadcrumb: [{ kind: "chapter", number: "12" }, { kind: "subchapter", number: "II" }], body: [] },
  { section: "1401", breadcrumb: [{ kind: "chapter", number: "12" }, { kind: "subchapter", number: "III" }], body: [] }
] }, inaCrosswalk: [], cfr: {}, uscHierarchyLinks: require("../sources/legal/usc-hierarchy-links.json") };
const context = { ...legalReferenceContext(corpus), kind: "usc", title: "8", section: "1101", sourceId: "fixture", sourceField: "text" };
const targets = text => generatedReferences(text, { ...context, sourceText: text }).filter(r => r.targetChapter).map(r => [r.text, r.targetTitle, r.targetChapter, r.targetSubchapter || "", r.resolution]);
assert.deepEqual(targets("chapter 45 of title 41,"), [["chapter 45", "41", "45", "", "official-source-only"]]);
assert.deepEqual(targets("Chapter 35 of title 44"), [["Chapter 35", "44", "35", "", "official-source-only"]]);
assert.deepEqual(targets("chapter 109A, 110 (other than section 2257, 2257A, or 2258), or 117, of title 18"), [["chapter 109A", "18", "109A", "", "official-source-only"], ["110", "18", "110", "", "official-source-only"], ["117", "18", "117", "", "official-source-only"]]);
assert.deepEqual(targets("subchapter II of chapter 12 of title 8"), [["subchapter II", "8", "12", "II", "local"], ["chapter 12", "8", "12", "", "local"]]);
assert.deepEqual(targets("subchapters II and III of this chapter"), [["subchapters II", "8", "12", "II", "local"], ["III", "8", "12", "III", "local"]]);
assert.deepEqual(targets("chapters 83 or 84 of title 5"), [["chapters 83", "5", "83", "", "official-source-only"], ["84", "5", "84", "", "official-source-only"]]);
assert.deepEqual(targets("chapter 51 and subchapter III of chapter 53 of title 5"), [["chapter 51", "5", "51", "", "official-source-only"], ["subchapter III", "5", "53", "III", "official-source-only"], ["chapter 53", "5", "53", "", "official-source-only"]]);
assert.deepEqual(targets("subchapter II (§ 1151 et seq.) of this chapter"), [["subchapter II", "8", "12", "II", "local"]]);
assert.deepEqual(targets("chapter 4 of title II of the Immigration and Nationality Act"), []);
assert.deepEqual(targets("chapter 16 of the USMCA"), []);
assert.deepEqual(targets("chapter 2534, Thirty-fourth Statutes, page 1229"), []);
assert.deepEqual(targets("subchapter III"), [["subchapter III", "8", "12", "III", "local"]]);
assert.deepEqual(targets("this chapter and this subchapter"), [["this chapter", "8", "12", "", "local"], ["this subchapter", "8", "12", "I", "local"]]);
for (const container of ["title", "chapter", "subchapter"]) {
  const value = `section 1151 of this ${container}`;
  const refs = generatedReferences(value, { ...context, sourceText: value });
  assert.deepEqual(refs.map(r => [r.text, r.targetTitle, r.targetSection]), [["section 1151", "8", "1151"]], `Only the section is linked in ${value}`);
  const externalValue = `section 923(d) of this ${container}`;
  const externalRefs = generatedReferences(externalValue, { ...context, title: "18", sourceText: externalValue });
  assert.deepEqual(externalRefs.map(r => [r.text, r.targetTitle, r.targetSection, r.targetPath]), [["923(d)", "18", "923", ["d"]]], `An uncached section still owns the reference in ${externalValue}`);
  if (container !== "title") {
    const simpleValue = `section 923 of this ${container}`;
    assert.deepEqual(generatedReferences(simpleValue, { ...context, title: "18", sourceText: simpleValue }).map(r => [r.text, r.targetTitle, r.targetSection]), [["923", "18", "923"]]);
  }
}
const externalSection = { title: "26", section: "3121", breadcrumb: [{ kind: "chapter", number: "21" }, { kind: "subchapter", number: "C" }], body: [] };
const externalContext = { ...context, title: "26", section: "3121", uscSections: new Map([["26:3121", externalSection]]), uscHierarchyLinks: { targets: Object.fromEntries(["26:21:A", "26:43:", "22:4:", "22:5:"].map(key => [key, { url: "https://uscode.house.gov/browse.html" }])) } };
const hierarchyRefs = (value, extra = {}) => generatedReferences(value, { ...externalContext, ...extra, sourceText: value }).filter(r => r.targetChapter);
assert.deepEqual(require("./embedded-references").parseNumberedSectionReferences("section(s) of this chapter"), []);
assert.deepEqual(hierarchyRefs("employment under this chapter or subchapter A of chapter 9 of the Internal Revenue Code of 1939").map(r => [r.text, r.targetTitle, r.targetChapter]), [["this chapter", "26", "21"]]);
assert.deepEqual(hierarchyRefs("chapter 4 or 5 part II of that Act", { title: "22" }), []);
assert.deepEqual(hierarchyRefs("chapter 43 of title 38, United States Code, as required by such chapter 43").map(r => [r.targetTitle, r.targetChapter]), [["38", "43"], ["38", "43"]]);
externalSection.body = [{ label: "a", text: "Rights under chapter 43 of title 38, United States Code.", continuation: "Contributions required by such chapter 43." }];
assert.deepEqual(hierarchyRefs(externalSection.body[0].continuation, { path: ["a"], sourceField: "continuation" }).map(r => [r.targetTitle, r.targetChapter]), [["38", "43"]]);
const noteText = "This chapter of the Act establishes a program.";
assert(!generatedReferences(noteText, { ...context, sourceKind: "usc-note", sourceText: noteText }).some(r => r.targetChapter), "A quoted Act's this-chapter language must not inherit the Code location of its editorial note");
const text = "subchapter II of chapter 12 of title 8; chapter 45 of title 41; subchapter X of chapter 28 of title 20";
const references = generatedReferences(text, { ...context, sourceText: text });
const packed = { title8: { sections: [{ section: "1101", body: [{ label: "a", text, references }] }] } };
packLegalReferences(packed);
const browserPacked = JSON.parse(JSON.stringify(packed));
unpackLegalReferences(packed);
assert.deepEqual(packed.title8.sections[0].body[0].references.map(r => [r.targetChapter, r.targetSubchapter || "", r.targetKind, r.officialUrl]), references.map(r => [r.targetChapter, r.targetSubchapter || "", r.targetKind, r.officialUrl]), "Delivery must retain hierarchy destinations and official links");
const historical = packed.title8.sections[0].body[0].references.find(r => r.targetSubchapter === "X");
assert.equal(historical.targetEdition, "1996");
assert(historical.officialUrl.endsWith("USCODE-1996-title20.pdf#page=553"));
assert(historical.citationNote.includes("Former subchapter X"));
console.log("PASS USC chapter and subchapter references");

const fs = require("node:fs"), vm = require("node:vm");
const template = fs.readFileSync(require("node:path").join(__dirname, "../src/INASearch.template.html"), "utf8");
const api = require("./audit-ina-display").runtime(template, corpus);
vm.runInContext(require("./test-function-source")(template, "corpusRequiresEmbeddedUpgrade"), api);
const release = { cfrHierarchyVersion: 5, uscHierarchyVersion: 2, statuteRunInRevision: 2 };
const oldCache = { legalReferenceMetadata: { cfrHierarchyVersion: 5 }, title8: { runInRevision: 2 } };
assert(api.corpusRequiresEmbeddedUpgrade(oldCache, release), "Existing browser caches must receive rebuilt hierarchy references");
oldCache.legalReferenceMetadata.uscHierarchyVersion = 1;
assert(api.corpusRequiresEmbeddedUpgrade(oldCache, release), "Previous hierarchy caches must receive the revised parser targets");
oldCache.legalReferenceMetadata.uscHierarchyVersion = 2;
assert.equal(api.corpusRequiresEmbeddedUpgrade(oldCache, release), false, "A matching cache must remain reusable");
api.hydratedLegalReferenceRoots = new WeakSet();
vm.runInContext(require("./test-function-source")(template, "hydrateLegalReferences"), api);
api.hydrateLegalReferences(browserPacked, browserPacked);
assert.deepEqual(JSON.parse(JSON.stringify(browserPacked.title8.sections[0].body[0].references)), packed.title8.sections[0].body[0].references, "Browser decoding must preserve the same hierarchy targets as build decoding");
const local = references[0], external = references.find(r => r.targetTitle === "41");
assert.equal(api.legalReferenceCitation(local), "8 U.S.C. Chapter 12 Subchapter II");
assert.equal(api.legalReferenceCitation(external), "41 U.S.C. Chapter 45");
const html = api.legalReferenceHtml(local, local.text);
assert(html.includes('data-reference-chapter="12"') && html.includes('data-reference-subchapter="II"'));
assert(html.includes('data-show-citation="INA Title II"'));
assert(api.legalReferenceHtml(external, external.text).includes('reference-official-only'));
const parser = require("./test-mixed-citations").createParser().api;
const functionSource = require("./test-function-source");
parser.titleCaseTopic = value => value[0].toUpperCase() + value.slice(1);
for (const node of [
  { id: "usc:title:8", kind: "title", number: "8", children: ["ch12"] },
  { id: "ch12", parentId: "usc:title:8", kind: "chapter", number: "12", children: ["subII"] },
  { id: "subII", parentId: "ch12", kind: "subchapter", number: "II", heading: "Immigration", children: [] }
]) parser.authorityHierarchyNodes.set(node.id, { authority: "usc", ...node });
for (const name of ["hierarchyUnitKind", "hierarchyNodeAncestors", "hierarchyNodeCitation", "hierarchyOfficialUrl", "hierarchyBrowseResult", "hierarchyDescendants", "hierarchyUnitMatches", "hierarchyResultForUnits", "parseUscHierarchy", "isHierarchyBrowse"])
  vm.runInContext(functionSource(template, name), parser);
api.parseCitation = parser.parseCitation;
api.isHierarchyBrowse = parser.isHierarchyBrowse;
let navigated = "";
api.applyNavigationQuery = query => { navigated = query; return true; };
vm.runInContext(require("./test-function-source")(template, "navigateToLocalLegalReference"), api);
assert(api.navigateToLocalLegalReference({ dataset: { referenceResolution: "local", referenceFamily: "usc", referenceChapter: "12", referenceSubchapter: "II", referenceTitle: "8", referenceCitation: "8 U.S.C. Chapter 12 Subchapter II" } }));
assert.equal(navigated, "8 U.S.C. Chapter 12 Subchapter II");
console.log("PASS USC hierarchy link labels and table-of-contents navigation");
