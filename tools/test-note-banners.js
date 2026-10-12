#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const functionSource = require("./test-function-source");
const annotations = require("../src/INASearch-Annotations");
const template = fs.readFileSync(path.join(__dirname, "../src/INASearch.template.html"), "utf8");
const a = { family: "usc", title: 8, start: { unit: "1182", path: [] }, label: "INA 212" };
const b = { family: "usc", title: 8, start: { unit: "1183", path: [] }, label: "INA 213" };
const note = { id: "note", text: "Saved note", associations: [a, b], textReferences: { spans: [] } };
const context = vm.createContext({
  state: { inlineNoteEditor: null, focusedActivePaneId: null },
  associationKey: a => `${a.family}:${a.title}:${a.start.unit}:${a.start.path.join("/")}`,
  associationLabel: a => a.label,
  associationListText: as => as.map(a => a.label).join("; "),
  escapeHtml: s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  noteReferenceHtml: n => n.text,
});
const render = vm.runInContext(`(${functionSource(template, "citationNoteHtml")})`, context);
let html = render(note, a);
assert.doesNotMatch(html, /Shared with:|citation-note-sharing|data-note-sharing-help|citation-note-help-panel/, "saved banners must omit the entire sharing row and help");
assert.doesNotMatch(html, /<textarea|data-note-delete|data-note-save|data-note-discard|data-note-sharing-edit/, "saved banners must hide editing controls, including Edit");
context.state.inlineNoteEditor = { noteId: "note", associationKey: context.associationKey(a), paneId: null, draft: new annotations.NoteDraft(note), sharingOpen: false };
html = render(note, a);
assert.match(html, /Shared with:/);
assert.match(html, /INA 213/);
assert.doesNotMatch(html, /INA 212/);
assert.match(html, /<a[^>]+data-note-shared-citation="INA 213"/, "shared citations must be links");
assert.match(html, /<button[^>]+data-note-sharing-help/, "sharing help must be an actionable button");
assert.match(html, /popover="auto"/, "sharing help must have a readable dismissible popover");
assert.doesNotMatch(html, /title="Share this same note/, "sharing help must not depend on the delayed browser tooltip");
context.state.inlineNoteEditor.draft = new annotations.NoteDraft({ ...note, associations: [a] });
html = render(note, a);
assert.match(html, /None/);
context.state.inlineNoteEditor = { noteId: "note", associationKey: context.associationKey(a), paneId: null, draft: new annotations.NoteDraft(note), sharingOpen: false };
html = render(note, a);
assert.match(html, /<textarea/);
assert.match(html, /data-note-sharing-edit/);
for (const action of ["save", "discard", "delete"]) assert.match(html, new RegExp(`data-note-${action}`));
assert.doesNotMatch(html, /data-note-associations-input/, "the sharing field only appears after Edit");
context.state.inlineNoteEditor.sharingOpen = true;
context.state.inlineNoteEditor.associationInput = "INA 213";
assert.match(render(note, a), /data-note-associations-input/);
assert.doesNotMatch(render(note, b), /<textarea|Shared with:|data-note-sharing-help/, "only the clicked instance enters editing or shows sharing");
console.log("PASS note banners: shared citation context and draft-only editing controls");

const helpButton = { attrs: { "aria-controls": "help" }, getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; }, getBoundingClientRect: () => ({ left: 280, bottom: 700 }) };
const helpPanel = { hidden: true, style: {}, open: false, showPopover() { this.open = true; }, hidePopover() { this.open = false; }, getBoundingClientRect: () => ({ width: 300, height: 220 }) };
const showHelp = vm.runInNewContext(`(${functionSource(template, "showNoteSharingHelp")})`, {
  document: { getElementById: id => id === "help" ? helpPanel : null }, window: { innerWidth: 390, innerHeight: 844 }
});
showHelp(helpButton);
assert.equal(helpPanel.open, true, "help opens immediately on activation");
assert.equal(helpButton.attrs["aria-expanded"], "true");
assert.equal(helpPanel.style.left, "78px", "help stays inside a narrow viewport");
assert.equal(helpPanel.style.top, "612px", "help stays above the bottom edge");
showHelp(helpButton, false);
assert.equal(helpPanel.open, false);
assert.equal(helpPanel.hidden, true);
assert.equal(helpButton.attrs["aria-expanded"], "false");

// Nested inline citations own their text; their ancestors must not highlight it again.
const host = { contains: other => other === childHost };
const childHost = {};
const ownText = { nodeValue: "parent text", parentElement: { closest: selector => selector.includes("script") ? null : host } };
const childText = { nodeValue: "child text", parentElement: { closest: selector => selector.includes("script") ? null : childHost } };
const nonNavigableText = { nodeValue: "unnumbered run-in text", parentElement: { closest: selector => selector.includes("script") ? null : selector.includes("[data-statute-inline-path]") ? host : childHost } };
const textNodes = vm.runInNewContext(`(${functionSource(template, "userHighlightTextNodes")})`, {
  NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
  document: { createTreeWalker(root, kind, filter) {
    const accepted = [ownText, childText, nonNavigableText].filter(node => filter.acceptNode(node) === 1);
    return { currentNode: null, nextNode() { this.currentNode = accepted.shift(); return Boolean(this.currentNode); } };
  } }
});
assert.deepEqual(Array.from(textNodes(host)), [ownText, nonNavigableText], "ancestor hosts must exclude nested citations while retaining non-navigable run-in text");

// Non-reader panes participate in shared-note refreshes, without a detail-content element.
const renderEmptyPane = vm.runInNewContext(`(${functionSource(template, "renderInlineLegalNotes")})`, {
  state: { view: "search" }, profile: { notes: [] }, els: { detail: { querySelector: () => null } },
  document: { activeElement: null }, $: (selector, root) => root.querySelector(selector), $$: () => [],
  reconcileStatuteRunInAnnotations() {}, activeCitationNoteCard: () => null,
  captureCitationNoteDraft() {}, destroyCitationBanners() {}, installCitationBanners() {}, renderUserHighlights() {}
});
assert.doesNotThrow(() => renderEmptyPane(), "shared-note refresh must support search and hierarchy panes");

const boundaryNode = { trailingContinuation: true };
const boundary = vm.runInNewContext(`(${functionSource(template, "legalUnitNoteBoundary")})`);
assert.equal(boundary({ closest: selector => selector.includes(".statutory-line") ? {} : boundaryNode }), boundaryNode,
  "subsection boundaries must include the complete node, including continuation text");
console.log("PASS note boundaries: nested text ownership, mixed panes, and complete citation text");

const saved = [];
const draftContext = vm.createContext({
  state: { inlineNoteEditor: null }, captureCitationNoteDraft() {}, activeCitationNoteCard: () => null,
  associationKey: context.associationKey, refreshVisibleCitationNotes() {},
  parseAssociatedWith: value => value === "invalid" ? { valid: false, message: "Invalid citation" } : { valid: true, associations: value ? [a, b, b] : [] },
  upsertNote: value => saved.push(value)
});
const finish = vm.runInContext(`(${functionSource(template, "finishCitationNoteDraft")})`, draftContext);
const session = () => ({ noteId: note.id, associationKey: context.associationKey(a), draft: new annotations.NoteDraft(note), sharingOpen: true, associationInput: "INA 213", error: "" });
draftContext.state.inlineNoteEditor = session();
draftContext.state.inlineNoteEditor.draft.value.text = "Edited text";
assert.equal(finish(), true);
assert.equal(saved[0].text, "Edited text");
assert.equal(saved[0].associations.length, 2, "saving must retain the current association and deduplicate equivalent citations");
assert.equal(draftContext.state.inlineNoteEditor, null);
draftContext.state.inlineNoteEditor = session();
draftContext.state.inlineNoteEditor.associationInput = "invalid";
draftContext.state.inlineNoteEditor.draft.value.text = "Retained draft";
assert.equal(finish(), false);
assert.equal(draftContext.state.inlineNoteEditor.draft.value.text, "Retained draft");
assert.equal(draftContext.state.inlineNoteEditor.error, "Invalid citation");
assert.equal(saved.length, 1, "invalid sharing must not commit a partial draft");
assert.equal(finish(true), true);
assert.equal(saved.length, 1, "discard must not save either text or sharing changes");
draftContext.state.inlineNoteEditor = { ...session(), draft: new annotations.NoteDraft(note, true) };
assert.equal(finish(true), true);
assert.equal(saved.length, 1, "discarding a new note must not create a saved record");
assert.equal(note.text, "Saved note", "draft editing must leave the saved shared record untouched");
console.log("PASS note drafts: valid saves, deduplication, invalid sharing, and discard");

const paneState = { focusedActivePaneId: null, inlineNoteEditor: null };
const startFromMenu = vm.runInNewContext(`(${functionSource(template, "startInlineNoteEditor")})`, {
  state: paneState, profile: { notes: [] }, INA_SEARCH_ANNOTATIONS: annotations,
  focusedPaneForElement: () => ({ id: "right-reader" }), finishCitationNoteDraft: () => true,
  locationFromLegalUnitTrigger: () => a, associationForLocation: () => a,
  associationKey: context.associationKey, associationListText: () => "", makeId: () => "new-note",
  refreshVisibleCitationNotes() {}, requestAnimationFrame() {}
});
assert.equal(startFromMenu({}), true);
assert.equal(paneState.inlineNoteEditor.paneId, "right-reader", "a global citation menu must edit in the trigger's original pane");
