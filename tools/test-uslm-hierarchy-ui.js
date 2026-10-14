#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const functionSource = require("./test-function-source");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const data = { window: {} };
for (const name of ["Corpus", "INA-Hierarchy", "Statute-Footnotes"])
  vm.runInNewContext(fs.readFileSync(path.join(root, `src/INASearch-${name}.js`), "utf8"), data);
const corpus = data.window.INA_SEARCH_CORPUS;
corpus.inaHierarchy = data.window.INA_SEARCH_INA_HIERARCHY;
require("./statute-footnotes").applyStatuteFootnotes(corpus, data.window.INA_SEARCH_STATUTE_FOOTNOTES);
const api = require("./audit-ina-display").runtime(template, corpus);
api.hydratedLegalReferenceRoots = new WeakSet();
api.authorityHierarchyNodes = new Map();
api.hierarchyLeafByReader = new Map();
api.cfrPartHierarchyNode = new Map();
api.INA_SOURCE_URL = corpus.sources.inaCrosswalk.url;
api.normalize = value => String(value || "").toLowerCase();
api.navigationTitleCase = value => value;
api.titleCaseTopic = value => String(value || "").replace(/\b\w/g, letter => letter.toUpperCase());
api.state.hierarchyExpanded = new Set();
vm.runInContext(fs.readFileSync(path.join(root, "src/INASearch-Startup.js"), "utf8"), api);
for (const name of ["hierarchyUnitKind", "hierarchyNodeId", "createHierarchyNode", "hierarchySourceHeading", "inaMappedSection", "addReferencedUscHierarchy", "buildAuthorityHierarchies"])
  vm.runInContext(functionSource(template, name), api);
api.buildAuthorityHierarchies();
const chapter = api.authorityHierarchyNodes.get("usc:title:8:chapter:7");
assert.equal(chapter?.notes?.length, 2, "Chapter notes must be attached to the U.S. Code hierarchy node");
assert.equal(chapter.identifier, "/us/usc/t8/ch7");
const affected = ["ina:section:103", "ina:section:104", "ina:section:105", "ina:section:106", "ina:title:II:chapter:4", "ina:section:272", "ina:section:276"];
assert.equal(affected.reduce((sum, id) => sum + (api.authorityHierarchyNodes.get(id)?.tocFootnoteReferences?.length || 0), 0), 7);

for (const name of ["expandPackedHouseHref", "hydrateLegalReferences", "hierarchyNodeAncestors", "hierarchyNodeCitation", "hierarchyRowCitation", "statuteStatusLabel", "hierarchyStatusReplacesHeading", "hierarchyStatusBadge", "statuteNoteBodyStart", "formatStatuteNoteBody", "renderStatuteNoteBody", "hierarchyTocFootnoteMarkers", "renderHierarchyTocNotes", "renderHierarchyDivisionNotes", "renderInaTocNotes", "renderHierarchyRows", "hierarchyPageNodeIds", "isStatuteRootHierarchy", "isStackedHome", "hierarchyPageRowsHtml"])
  vm.runInContext(functionSource(template, name), api);
// The shared note formatter may use presentation helpers; include the actual
// runtime helpers when present rather than substituting a display mock.
for (const name of ["statuteNotePresentationAttributes", "statuteNoteInlineLayout", "renderStatuteNoteHeading"])
  if (template.includes(`function ${name}(`)) vm.runInContext(functionSource(template, name), api);

for (const name of ["hierarchyNoteEntries", "hierarchyNoteMarkers", "renderHierarchyNoteContent"])
  if (template.includes(`function ${name}(`)) vm.runInContext(functionSource(template, name), api);
let bodies = 0, markers = 0;
for (const id of affected) {
  const node = api.authorityHierarchyNodes.get(id);
  const html = api.renderHierarchyRows([id]);
  for (const ref of node.tocFootnoteReferences) {
    assert(html.includes(`aria-label="Table of contents footnote ${ref.number}"`), `${id}: source marker missing from row`);
    markers++;
  }
  for (const note of node.tocFootnotes) {
    assert(!html.includes(api.escapeHtml(note.text)), `${id}: a hierarchy row must not display the note body`);
    const content = api.renderHierarchyNoteContent(node, `toc:${node.tocFootnoteReferences.findIndex(ref => ref.noteId === note.id)}`);
    assert(content.includes(api.escapeHtml(note.text)), `${id}: hover content must retain the exact source note`);
    assert(content.includes(`data-ina-toc-footnote="${note.id}"`));
    bodies++;
  }
  const navigation = html.match(/<button class="hierarchy-open"[^>]*>([\s\S]*?)<\/button>/);
  assert(navigation?.[0].includes(`data-hierarchy-open="${id}"`), "Existing row navigation must remain actionable");
  assert(navigation[0].includes('aria-label="'), "Row navigation must retain an accessible name");
  assert(!navigation[1].includes("<a ") && !navigation[1].includes("data-hierarchy-note-key"), "Note controls must be separate from the hierarchy navigation button");
  assert(html.includes(`${api.escapeHtml(node.heading)}<span class="hierarchy-note-markers">`), `${id}: note numbers must immediately follow their title`);
  assert(html.includes('aria-controls="hierarchyNotePopover"'), "The marker must expose its preview for keyboard and touch access");
}
assert.equal(bodies, 6);
assert.equal(markers, 7);
const dangling = api.renderHierarchyNoteContent(api.authorityHierarchyNodes.get("ina:section:276"), "toc:0");
assert(dangling.includes("Footnote body unavailable in the source table of contents."));
assert(!dangling.includes("data-ina-toc-footnote="), "A dangling marker must not acquire another entry's footnote body");

const page = api.hierarchyPageRowsHtml({ hierarchyNodeId: chapter.id });
assert(!page.includes("Former chapter 7 of this title"), "Chapter note prose must not interrupt the list of sections");
const chapterMarkers = api.hierarchyNoteMarkers(chapter);
assert(chapterMarkers.includes('data-hierarchy-note-key="division:1"'));
const chapterNote = api.renderHierarchyNoteContent(chapter, "division:1");
assert(chapterNote.includes("Former chapter 7 of this title included the provisions of the several Chinese Exclusion acts"));
assert(chapterNote.indexOf("Editorial Notes") < chapterNote.indexOf("Codification"));
assert(page.includes('data-hierarchy-open="usc:section:8-261"'), "Adding chapter notes must preserve child navigation");
const section = corpus.title8.sections.find(section => section.section === "1103");
const reader = api.renderInaTocNotes(section);
assert(reader.includes("There was no conforming amendment to the table of contents."));
assert(reader.includes("INA 103"), "A section reader must identify the INA entry whose heading the note qualifies");
assert.equal(api.renderInaTocNotes({ title: 18, section: "1103" }), "", "Other Code titles must not inherit Title 8 TOC caveats");
assert.equal(api.renderInaTocNotes(corpus.title8.sections.find(section => section.section === "1101")), "");
assert(api.renderInaTocNotes(corpus.inaCrosswalk.find(row => row.inaSection === "105")).includes("No conforming amendment was made to the table of contents."));
const packed = { title8: { divisionNotes: { chapter: { notes: [{ id: "packed-note", heading: "Codification", text: "See 22 Stat. 58.", references: [{ start: 4, end: 15, text: "22 Stat. 58.", houseHref: "/us/stat/22/58", family: "statutes-at-large", resolution: "official-source-only", targetVolume: "22", targetPage: "58" }] }] } } } };
require("./pack-legal-references").packLegalReferences(packed);
assert(packed.title8.divisionNotes.chapter.notes[0]._lr, "The fixture must exercise delivery-packed note references");
api.corpus = packed;
const packedHtml = api.renderHierarchyDivisionNotes({ ...chapter, notes: packed.title8.divisionNotes.chapter.notes });
api.corpus = corpus;
assert(packedHtml.includes('data-reference-family="statutes-at-large"'), "Division notes must hydrate their packed legal links before rendering");
const ina103 = api.authorityHierarchyNodes.get("ina:section:103");
const originalHeading = ina103.heading;
ina103.heading = "Repealed";
ina103.status = "repealed";
assert(api.renderHierarchyRows([ina103.id]).includes('aria-label="Table of contents footnote 2"'), "Replacing a disposition heading with a status badge must retain its source marker");
ina103.heading = originalHeading;
ina103.status = "current";

api.URL = URL;
api.allowedHosts = new Set(corpus.approvedDomains);
for (const name of ["safeUrl", "authoritySourceLink", "hierarchyOfficialUrl", "hierarchyPageActions"])
  vm.runInContext(functionSource(template, name), api);
const title = api.authorityHierarchyNodes.get("usc:title:8");
title.notes = [{ id: "title-note", topic: "miscellaneous", heading: "Title note", text: "Title noteA substantive title annotation." }];
assert(!api.hierarchyPageRowsHtml({ hierarchyNodeId: title.id, home: true }).includes("A substantive title annotation."));
assert(api.hierarchyNoteMarkers(title).includes('data-hierarchy-note-key="division:0"'));
assert(api.renderHierarchyNoteContent(title, "division:0").includes("A substantive title annotation."));
console.log("PASS USLM hierarchy UI: House division notes; all 6 TOC bodies / 7 markers; reader context; source-dangling marker");
