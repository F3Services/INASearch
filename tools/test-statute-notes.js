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
const context = vm.createContext({ escapeHtml, console, INA_SEARCH_OCCURRENCE: require("../src/INASearch-Occurrence") });
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
let richBodyCalls = 0;
const richBodyRenderer = context.renderStatuteNoteBody;
context.renderStatuteNoteBody = (...args) => { richBodyCalls++; return richBodyRenderer(...args); };
const deferred = context.renderStatuteSupplements({ notes: [{ ...note, id: "deferred" }] }, null, null, true);
assert.equal(richBodyCalls, 0, "Closed supplements must not build rich note bodies");
assert.match(deferred, /data-reader-note-body="0"/, "Deferred notes must remain addressable");
assert(deferred.includes("First.Second."), "Deferred notes must retain searchable source text outside a template");
assert.doesNotMatch(deferred, /<template data-reader-note-body/, "Native Find must be able to search deferred note text");
const selectedDeferred = context.renderStatuteSupplements({ notes: [{ ...note, id: "deferred" }] }, { kind: "notes", noteIndex: 0, subfield: "text" }, null, true);
assert.equal(richBodyCalls, 1, "A selected note must render immediately for exact search highlighting and scrolling");
assert.doesNotMatch(selectedDeferred, /data-reader-note-body/);
context.renderStatuteNoteBody = richBodyRenderer;
const closedDetails = { tagName: "DETAILS", open: false, parentElement: null };
const openDetails = { tagName: "DETAILS", open: true, parentElement: null };
const hiddenSlot = { parentElement: closedDetails, closest: () => null };
const visibleSlot = { parentElement: openDetails, closest: () => null };
const deferredBodies = new WeakMap([[hiddenSlot, () => "closed legal text"], [visibleSlot, () => "visible legal text"]]);
const filled = [];
const materializing = vm.createContext({ $$: () => [hiddenSlot, visibleSlot], deferredStatuteNoteBodies: deferredBodies,
  focusedPaneForElement: () => null, replaceReaderSlot: (slot, html) => filled.push([slot, html]) });
vm.runInContext(source(template, "materializeStatuteNotes"), materializing);
materializing.materializeStatuteNotes({});
assert.deepEqual(filled.map(([, html]) => html), ["visible legal text"], "Opening a group must render only notes with every ancestor open");
materializing.materializeStatuteNotes({});
assert.equal(filled.length, 1, "Repeated disclosure events must not rebuild existing note bodies");
materializing.materializeStatuteNotes({}, true);
assert.equal(filled[1][1], "closed legal text", "Find and print must materialize closed notes too");
assert(!deferredBodies.has(hiddenSlot) && !deferredBodies.has(visibleSlot));
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
assert.doesNotMatch(footnoteList, /<details/, "Footnotes stay visible outside disclosures");
assert.match(fundsRow, /class="house-footnote-return"[^>]*data-house-footnote-return=/, "Editorial footnotes need a separate return control alongside their citation links");
assert.doesNotMatch(context.renderStatuteSupplements(section, null, null), /House editorial footnotes/, "The visible footnotes must be outside the supplemental disclosure");
const preambleFootnote = { id: "preamble-footnote", number: "1", text: "Section context." };
const preambleHtml = context.renderHouseEditorialFootnotes({ id: "usc-1", section: "1", preambleFootnoteReferences: [preambleFootnote], houseEditorialFootnotes: [preambleFootnote] }, null, "8 U.S.C. 1");
assert.match(preambleHtml, /data-show-citation="8 U.S.C. 1"/, "Section-level footnotes must use section navigation without an invented subsection");
// Exercise the real click branches with a reader that moves independently of
// the marker's destination. Return must restore the pre-jump position, rather
// than put the superscript at the configured citation reading line.
const clickStart = template.indexOf('        const notesExpansion = event.target.closest("[data-statute-notes-expand]");');
const clickEnd = template.indexOf('        const citationSelection = ', clickStart);
assert(clickStart >= 0 && clickEnd > clickStart);
const reader = { scrollY: 840, scrollX: 11, scrollTo({ top, left = 0 }) { this.scrollY = top; this.scrollX = left; } };
const ref = { id: "marker", tagName: "A", jumpTop: 300, focus() {} };
const onward = { id: "onward-note", tagName: "DETAILS", jumpTop: 21000, dataset: {}, matches: () => false, focus() {} };
const entry = { id: "footnote", tagName: "LI", jumpTop: 20000, dataset: {}, matches: () => true, focus() {} };
const returnLink = { dataset: {}, href: "#marker", setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name]; } };
const nodes = new Map([[ref.id, ref], [entry.id, entry], [onward.id, onward]]);
const navigation = vm.createContext({
  window: reader, document: { getElementById: id => nodes.get(id) }, els: { detail: {} },
  houseFootnoteReturnPositions: new WeakMap(),
  materializeStatuteNotes() {},
  $$: () => [returnLink], legalReaderScrollRequest: () => ({ root: reader }),
  cancelLegalReaderScroll() {}, scrollStatuteAnchorToReadingLine: target => reader.scrollTo({ top: target.jumpTop })
});
vm.runInContext(source(template, "revealStatuteNoteTarget"), navigation);
const click = vm.runInContext(`(function(event) { ${template.slice(clickStart, clickEnd)} })`, navigation);
const event = matches => ({ preventDefault() {}, target: { closest: selector => matches[selector] || null } });
const markerClick = { ...ref, dataset: { houseFootnoteJump: "footnote" }, getAttribute: () => "#footnote", closest: () => null };
// Keep the exact marker element as the reference used by the real handler.
nodes.set(ref.id, markerClick);
click(event({ "[data-house-footnote-jump]": markerClick }));
assert.equal(reader.scrollY, 20000, "The marker first opens its editorial footnote");
click(event({ "[data-house-footnote-jump]": { dataset: { houseFootnoteJump: "footnote" }, getAttribute: () => "#onward-note", closest: () => entry } }));
assert.equal(reader.scrollY, 21000, "An onward note remains reachable");
click(event({ "[data-house-footnote-return]": returnLink }));
assert.deepEqual([reader.scrollY, reader.scrollX], [840, 11], "Returning through an onward note must restore the original reading position");
const supplementsControl = { open: true }, nested = [{ open: true }, { open: true }];
navigation.$$ = () => nested;
click(event({ "[data-statute-notes-expand]": { dataset: { statuteNotesExpand: "false" }, closest: () => supplementsControl } }));
assert.equal(supplementsControl.open, false, "Collapse all must close the supplements container itself");
assert(nested.every(detail => !detail.open), "Collapse all must also close nested notes");
click(event({ "[data-statute-notes-expand]": { dataset: { statuteNotesExpand: "true" }, closest: () => supplementsControl } }));
assert(supplementsControl.open && nested.every(detail => detail.open), "Expand all must reopen the container and its notes");
const scopedMarker = { id: "marker" };
const scopedOrigin = { dataset: { houseFootnoteOrigin: "marker", houseFootnoteReturn: "marker" }, getAttribute: () => "#marker", setAttribute(name, value) { this[name] = value; } };
const scoping = vm.createContext({ $$: selector => selector === '[id]' ? [scopedMarker] : [scopedOrigin] });
vm.runInContext(source(template, "scopeFocusedPaneIds"), scoping);
scoping.scopeFocusedPaneIds({ id: "pane-2", detail: {} });
assert.equal(scopedOrigin.dataset.houseFootnoteOrigin, "pane-2-marker", "Onward-note returns must use the marker in their own viewer pane");
assert.equal(scopedOrigin.dataset.houseFootnoteReturn, "pane-2-marker");
console.log("Statute note navigation checks passed.");
