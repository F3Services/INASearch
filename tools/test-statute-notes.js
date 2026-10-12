"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const source = require("./test-function-source");
const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const referenceId = vm.runInNewContext(`(${source(template, "houseFootnoteReferenceId")})`);
const marker = vm.runInNewContext(`(${source(template, "houseFootnoteReferenceHtml")})`, { escapeHtml, houseFootnoteReferenceId: referenceId });
const { applyStatuteFootnotes } = require("./statute-footnotes");
function assigned(name, property) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src", name), "utf8"), context);
  return context.window[property];
}
const corpus = assigned("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
const overlay = assigned("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES");
applyStatuteFootnotes(corpus, overlay);
const section = corpus.title8.sections.find(s => s.section === "1101");
const funds = section.notes.find(n => n.heading === "Availability of Funds");
assert.equal(section.houseEditorialFootnotes.find(n => n.number === "3").targetNoteId, funds.id);
const categories = section.notes.filter(n => n.role === "crossHeading");
assert.equal(categories.length, 3);
assert(categories.every(n => !n.text.slice(n.bodyStart).trim()), "Category headings cannot double as their own note body");
const ambiguous = { title8: { sections: [{ section: "1", notes: [{ id: "a", heading: "Same", text: "A" }, { id: "b", heading: "Same", text: "B" }] }] } };
applyStatuteFootnotes(ambiguous, { extraction: { footnotes: 1, references: 0, affectedFields: 0 }, sections: { 1: [{ id: "f", text: "See Same note below." }] } });
assert.equal(ambiguous.title8.sections[0].houseEditorialFootnotes[0].targetNoteId, undefined, "Ambiguous headings must not be guessed");
const html = marker({ id: "usc-1101-f3", number: "3", offset: 26, targetNoteId: "8-1101-note-64" });
assert.match(html, /href="#house-footnote-usc-1101-f3"/, "Every embedded marker must stop at its full editorial footnote, even when an onward note is resolved");
assert.match(marker({ id: "f11", number: "11", offset: 9 }), />11<\/a>/, "True multidigit numbers must remain intact");
assert.match(marker({ id: "f1", number: "1", offset: 9 }), /href="#house-footnote-f1"/, "Unresolved notes must retain a reachable footnote destination");
const first = marker({ id: "f3", number: "3", offset: 26, sourceLocation: { sourceKey: "1101:a/27/C/ii/II", field: "text" } });
const repeated = marker({ id: "f3", number: "3", offset: 26, sourceLocation: { sourceKey: "1101:a/27/C/ii/III", field: "text" } });
assert.notEqual(first.match(/id="([^"]+)"/)[1], repeated.match(/id="([^"]+)"/)[1], "Repeated footnotes at the same text offset need distinct return destinations");
const context = vm.createContext({ escapeHtml, console });
for (const name of ["statuteNoteBodyStart", "statuteNoteGroups", "formatStatuteNoteBody"])
  vm.runInContext(source(template, name), context);
const note = { heading: "Funds", text: "FundsFirst.Second.", bodyStart: 5, layout: [{ tag: "p", start: 5, end: 11 }, { tag: "p", start: 11, end: 18 }] };
assert.equal(context.formatStatuteNoteBody(note, (a, b) => note.text.slice(a, b), true), "First.\n\nSecond.", "Copying a note must preserve paragraph breaks without repeating its heading");
const rendered = context.formatStatuteNoteBody(note, (a, b) => note.text.slice(a, b));
assert.equal((rendered.match(/class="note-paragraph"/g) || []).length, 2);
assert(!rendered.includes("Funds"));
const groups = context.statuteNoteGroups(section);
assert.equal(groups.find(g => g.heading === "Editorial Notes").entries.length, 3, "Cross headings must own their following notes");
assert(groups.find(g => g.heading === "Statutory Notes and Related Subsidiaries").entries.some(e => e.note.id === funds.id));
for (const item of corpus.title8.sections) for (const n of item.notes || []) {
  let visited = "";
  context.formatStatuteNoteBody(n, (a, b) => { visited += n.text.slice(a, b); return ""; });
  assert.equal(visited, n.text.slice(context.statuteNoteBodyStart(n)), `${n.id}: formatting must visit every body character once, in source order`);
}
Object.assign(context, {
  linkifyStatutoryText: (text, _refs, start = 0, end = text.length) => escapeHtml(text.slice(start, end)),
  titleCaseTopic: value => value,
  houseFootnoteReferenceId: referenceId,
  renderHouseEditorialFootnotes: () => ""
});
for (const name of ["renderStatuteNoteBody", "renderStatuteNote", "renderStatuteSupplements"])
  vm.runInContext(source(template, name), context);
const empty = { id: "empty", heading: "Empty note", text: "Empty note", bodyStart: 10, layout: [] };
const emptyHtml = context.renderStatuteNote({}, empty, 0, null, null);
assert(!emptyHtml.includes("<details"));
assert.match(emptyHtml, /None/);
for (const length of [749, 750, 751]) {
  const boundary = { id: `length-${length}`, heading: "Title", text: "Title" + "x".repeat(length - 5), bodyStart: 5 };
  const result = context.renderStatuteNote({}, boundary, 0, null, null, true);
  assert.equal(/^<details[^>]* open>/.test(result), length <= 750, `${length} characters including the title must use the correct initial expansion`);
}
const separateHeading = { id: "separate-heading", heading: "Title", text: "x".repeat(746), bodyStart: 0 };
assert(!/^<details[^>]* open>/.test(context.renderStatuteNote({}, separateHeading, 0, null, null)), "A separately stored title must count toward the limit");
assert(/^<details[^>]* open>/.test(context.renderStatuteNote({}, separateHeading, 0, { kind: "notes", noteIndex: 0 }, null)), "A search target must remain expanded even when long");
const supplements = context.renderStatuteSupplements({ notes: [{ id: "cat", role: "crossHeading", heading: "Editorial Notes" }, {...note, id: "funds"}], sourceCredit: "Credit" }, null, null);
assert.equal((supplements.match(/class="statute-supplements"/g) || []).length, 1);
assert(supplements.indexOf("Notes and supplementary material") < supplements.indexOf("Editorial Notes"));
const searched = context.renderStatuteSupplements({ notes: [{ id: "cat", role: "crossHeading", heading: "Editorial Notes" }, {...note, id: "funds"}] }, {kind:"notes",noteIndex:1,subfield:"text"}, null);
assert.match(searched, /class="statute-supplements" open/);
assert.match(searched, /class="statute-note-group" open/);
assert.match(searched, /data-statute-note="funds" tabindex="-1" open/);
Object.assign(context, {
  statuteDefinitionContext: () => null,
  uscMapping: () => null,
  uscBase: s => `8 U.S.C. ${s.section}`,
  canonicalPath: parts => parts.map(part => `(${part})`).join(""),
  statutoryRunInSegments: () => [], // Inline citations are exercised with the real parser in test-flat-statute-reference-preview.
  HOUSE_FOOTNOTE_STATEMENT: "House editorial content."
});
vm.runInContext(source(template, "renderHouseEditorialFootnotes"), context);
const footnoteList = context.renderHouseEditorialFootnotes(section, null, "INA 101");
const fundsRow = footnoteList.match(/<li[^>]*id="house-footnote-usc-1101-fn002002"[\s\S]*?<\/li>/)[0];
assert.match(fundsRow, />\(a\)\(27\)\(C\)\(ii\)\(II\)<\/a>/, "Footnote 3 must identify its first cited provision without repeating the section");
assert.match(fundsRow, />\(a\)\(27\)\(C\)\(ii\)\(III\)<\/a>/, "Footnote 3 must also identify its repeated use without repeating the section");
assert.match(fundsRow, /href="#statute-note-8-1101-note-75"/, "The footnote list must retain its onward link to the substantive note");
const compoundText = "The original wording contains an error. See Availability of Funds note below.";
const compound = { ...section.houseEditorialFootnotes.find(n => n.number === "3"), text: compoundText };
assert.match(marker(compound), /href="#house-footnote-usc-1101-fn002002"/, "An explanatory footnote must never be bypassed by embedded-marker navigation");
assert(context.renderHouseEditorialFootnotes({ ...section, houseEditorialFootnotes: [compound] }, null, "INA 101").includes(compoundText), "The full explanation preceding an onward direction must remain readable");
for (const citation of ["INA 101(a)(27)(C)(ii)(II)", "INA 101(a)(27)(C)(ii)(III)"]) {
  assert(fundsRow.includes(`data-show-citation="${citation}"`), "A footnote citation must use ordinary citation navigation instead of jumping to its superscript marker");
}
const origins = [...fundsRow.matchAll(/data-house-footnote-origin="(house-footnote-reference-[^"]+)"/g)].map(match => match[1]);
assert.equal(origins.length, 2);
assert.equal(new Set(origins).size, 2, "Each cited provision must retain its distinct marker for onward-note return navigation");
assert.doesNotMatch(footnoteList, /<details|data-house-footnote-return=/, "Footnotes stay visible and their citation destinations must not be rewritten by return navigation");
assert.doesNotMatch(context.renderStatuteSupplements(section, null, null), /House editorial footnotes/, "The visible footnotes must be outside the supplemental disclosure");
const preambleFootnote = { id: "preamble-footnote", number: "1", text: "Section context." };
const preambleHtml = context.renderHouseEditorialFootnotes({ id: "usc-1", section: "1", preambleFootnoteReferences: [preambleFootnote], houseEditorialFootnotes: [preambleFootnote] }, null, "8 U.S.C. 1");
assert.match(preambleHtml, /data-show-citation="8 U.S.C. 1"/, "Section-level footnotes must use section navigation without an invented subsection");
console.log("Statute note navigation checks passed.");
