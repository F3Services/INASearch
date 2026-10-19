#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(path.join(__dirname, "../src/INASearch.template.html"), "utf8");

for (const everything of [false, true]) {
  test(`${everything ? "content" : "settings"} reset waits for confirmation and leaves cancellation untouched`, async () => {
    const profile = { preferences: { theme: "dark" }, notes: [{ text: "Keep this note" }] };
    let closeListener;
    const dialog = {
      open: false, returnValue: "confirm",
      addEventListener(type, listener) { assert.equal(type, "close"); closeListener = listener; },
      showModal() { this.open = true; },
      close(value) { this.open = false; this.returnValue = value; closeListener(); }
    };
    const requestReset = vm.runInNewContext(`(${functionSource(template, "requestReset")})`, {
      confirm: () => true,
      els: { resetConfirmationDialog: dialog, resetConfirmationTitle: {}, resetConfirmationMessage: {} },
      resetSettingsToDefaults: () => { profile.preferences = { theme: "light" }; },
      resetEverythingToDefaults: () => { profile.preferences = { theme: "light" }; profile.notes = []; }
    });
    const canceledReset = requestReset(everything);
    assert.equal(profile.preferences.theme, "dark", "Reset ran before the confirmation dialog was answered.");
    assert(dialog.open, "Reset did not show its in-page confirmation.");
    assert.equal(dialog.returnValue, "cancel", "A previous confirmation can make Escape approve the next reset.");
    dialog.close("cancel");
    await canceledReset;
    assert.equal(profile.preferences.theme, "dark", "Cancel changed the preferences.");
    assert.equal(profile.notes.length, 1, "Cancel deleted content.");
    const confirmedReset = requestReset(everything);
    dialog.close("confirm");
    await confirmedReset;
    assert.equal(profile.preferences.theme, "light", "Confirm did not restore settings.");
    assert.equal(profile.notes.length, everything ? 0 : 1, "The wrong reset scope was applied.");
  });
}

test("sidebar copy controls stay visible and disabled in searches without a selected citation", () => {
  const element = () => ({ hidden: false, dataset: {}, setAttribute() {}, removeAttribute() {}, matches: () => false, contains: () => false });
  const copies = element(), authority = element(), official = element(), region = element();
  const buttons = ["copy-citation", "copy-text"].map(action => ({ ...element(), dataset: { liveCitationAction: action } }));
  const actions = element();
  const state = { mainOccurrencePane: { searchState: {}, entry: {} }, statuteHierarchyAuthority: "ina" };
  const sync = vm.runInNewContext(`(${functionSource(template, "syncMainReaderActionTarget")})`, {
    state, els: { mainReaderActions: actions }, document: { activeElement: null },
    $: selector => ({ ".main-reader-authority": authority, ".live-citation-copies": copies,
      ".official-source-action": official, ".reader-action-preview": region }[selector] || element()),
    $$: () => buttons,
    mainReaderActionTarget: () => null, mainReaderPrintTarget: () => null, hierarchyActionNode: () => null
  });
  for (const focused of [false, true]) {
    state.focusedPaneContext = focused ? { entry: { mode: "search-tree" }, readerActions: actions } : null;
    sync();
    assert.equal(copies.hidden, false, "A search hid the persistent sidebar copy controls.");
    assert(buttons.every(button => button.disabled), "Copy controls without a citation must be disabled.");
  }
});

test("global search Tab targets a visible comparison pane even when the old main search is retained", () => {
  const input = {}, hiddenMain = {}, visibleSearch = { entry: { mode: "search-tree" } };
  const state = { focusedCitationMode: true, mainOccurrencePane: hiddenMain,
    focusedCitationPanes: [{ entry: { mode: "reader" } }, visibleSearch] };
  const listeners = {};
  let targetPane;
  const context = vm.createContext({
    state, els: { search: input }, focusedPaneForElement: () => null,
    document: { addEventListener(type, handler) { listeners[type] = handler; } },
    scheduleVisibleOccurrenceSections() {}, handleOccurrenceResultTab(pane) { targetPane = pane; }
  });
  const start = template.indexOf('      document.addEventListener("focusin", event => {\n        const pane =');
  const end = template.indexOf('      window.addEventListener("scroll",', start);
  assert(start >= 0 && end > start);
  if (template.includes('function occurrenceKeyboardPaneForElement('))
    vm.runInContext(functionSource(template, 'occurrenceKeyboardPaneForElement'), context);
  vm.runInContext(template.slice(start, end), context);
  listeners.keydown({ key: 'Tab', target: input });
  assert.equal(targetPane, visibleSearch, "Tab was routed to hidden main results instead of a visible search pane.");
});

function renderingContext(values = {}) {
  const context = vm.createContext(values);
  vm.runInContext(functionSource(template, "escapeHtml"), context);
  return context;
}

test("citations in saved notes render native links while preserving the original wording", () => {
  const context = renderingContext();
  vm.runInContext(functionSource(template, "noteReferenceHtml"), context);
  const html = context.noteReferenceHtml({ text: "See 245a; keep <text>.", textReferences: {
    spans: [{ start: 4, end: 8, raw: "245a", citation: "INA 245(a)" }]
  } });
  assert.match(html, /<a\b[^>]*href="\?q=INA%20245\(a\)"[^>]*>245a<\/a>/,
    "A note citation must expose a link that native keyboard activation can follow.");
  assert(html.includes("keep &lt;text&gt;."), "Note text must remain escaped.");
});

test("defined terms expose a button and its controlled definition dialog", () => {
  const context = renderingContext({ definedTermHighlightingEnabled: () => true,
    scopedDefinitionMatches: () => [{ start: 0, end: 9, entryIds: ["definition-1"] }] });
  for (const name of ["renderSearchHighlightedText", "renderScopedDefinitionAnnotatedText"])
    vm.runInContext(functionSource(template, name), context);
  const html = context.renderScopedDefinitionAnnotatedText("immigrant", null);
  assert.match(html, /role="button"/, "A focusable defined term must advertise its activation behavior.");
  assert.match(html, /aria-controls="scopedDefinitionPopover"/);
  assert.match(html, /aria-expanded="false"/);
});

test("statutory subheadings retain heading navigation at nested and deep levels", () => {
  const context = renderingContext({
    uscSection: () => null, canonicalPath: values => values.map(value => `(${value})`).join(""),
    legalCitationSelectionAttributes: () => "", legalUnitTriggerHtml: () => "",
    linkifyStatutoryText: value => value, formatStatutoryRunInText: value => value
  });
  vm.runInContext(functionSource(template, "renderStatutoryNode"), context);
  const node = { label: "a", heading: "Family allocation", text: "Parent text.",
    children: [{ label: "1", heading: "Children", text: "Child text." }] };
  const headingLevels = html => [...html.matchAll(/<span\b([^>]*class="node-heading"[^>]*)>/g)].map(match => {
    assert.match(match[1], /role="heading"/, "A visually styled subheading lost its heading role.");
    return Number(match[1].match(/aria-level="(\d+)"/)?.[1]);
  });
  assert.deepEqual(headingLevels(context.renderStatutoryNode(node, [], [], 0)), [3, 4]);
  assert.deepEqual(headingLevels(context.renderStatutoryNode(node, [], [], 7)), [6, 6]);
});

test("hierarchy rows expose list items and nested child lists", () => {
  const startup = fs.readFileSync(path.join(__dirname, "../src/INASearch-Startup.js"), "utf8");
  const context = renderingContext();
  vm.runInContext(functionSource(startup, "hierarchyRowHtml"), context);
  const child = context.hierarchyRowHtml({ id: "section", citation: "INA 101", label: "Definitions", size: "section", expandable: false });
  const html = context.hierarchyRowHtml({ id: "title", citation: "Title I", label: "General", size: "top", expanded: true, children: child });
  const rows = [...html.matchAll(/<article\b([^>]*)>/g)];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row[1], /role="listitem"/, "Index cards must be exposed as list items.");
  assert.match(html, /<div\b[^>]*class="hierarchy-children"[^>]*role="list"/,
    "Expanded children need a list parent of their own.");
});

test("hierarchy pages group their index lists without creating an empty outer list", () => {
  const attributes = {};
  const resultList = { setAttribute(name, value) { attributes[name] = value; } };
  const node = { id: "cfr:root", heading: "Code of Federal Regulations" };
  const context = renderingContext({
    state: { query: "CFR", hierarchyPageNodeId: node.id, hierarchyExpanded: new Set() },
    els: { resultList, authorityBrowseHeader: {}, resultsPanel: { setAttribute() {} } },
    authorityHierarchyNodes: new Map([[node.id, node]]),
    hierarchyDisplayResult: result => result, isStackedHome: () => false,
    hierarchyPageNodeIds: () => ["cfr:title:8"], renderHierarchyRows: () => '<article role="listitem">Title 8</article>',
    hierarchyOfficialUrl: () => "", hierarchyNodeCitation: () => "CFR", hierarchySourceLabel: () => "eCFR",
    cfrPartAlternativesHtml: () => "", authorityBrowseHeading: () => "", hierarchyNoteMarkers: () => "",
    navigationTitleCase: value => value, INASearchStartup: { adoptOpeningIndex: () => false },
    updateSearchResultLayout() {}, renderHierarchyNavigation() {}, activateNavigationLocation() {}
  });
  for (const name of ["hierarchyPageRowsHtml", "renderHierarchyPage"])
    vm.runInContext(functionSource(template, name), context);
  context.renderHierarchyPage({ hierarchyNodeId: node.id, type: "cfr" });
  assert.equal(attributes.role, "group", "The page wrapper must not create a list whose only child is another list.");
  assert.match(resultList.innerHTML, /<div class="hierarchy-list" role="list"><article role="listitem">/);
});

for (const key of ["Enter", " ", "ArrowDown"]) {
  test(`defined-term ${JSON.stringify(key)} activation pins the preview and enters its controls`, () => {
    const trigger = { closest: () => trigger };
    const state = {}, closeButton = {};
    let active, prevented = false;
    closeButton.focus = () => { active = closeButton; };
    const handle = vm.runInNewContext(`(${functionSource(template, "handleScopedDefinitionKeydown")})`, {
      state, els: { scopedDefinitionPopover: { hidden: true }, scopedDefinitionPopoverClose: closeButton },
      openScopedDefinitionPopover(target, pinned) { assert.equal(target, trigger); state.pinned = pinned; return true; }
    });
    assert.equal(handle({ key, target: trigger, preventDefault() { prevented = true; } }), true);
    assert.equal(state.pinned, true, "The preview must stay open while its controls are used.");
    assert.equal(active, closeButton, "Keyboard activation must move into the preview.");
    assert.equal(prevented, true);
  });
}

test("closing a definition preview returns focus without reopening the focus preview", () => {
  const cleared = [];
  const state = { scopedDefinitionPreviewTimer: 1, scopedDefinitionCloseTimer: 2 };
  let expanded = "true", focused = false;
  const trigger = { setAttribute(name, value) { if (name === "aria-expanded") expanded = value; },
    focus() { focused = true; state.scopedDefinitionPreviewTimer = 3; } };
  state.scopedDefinitionContext = { trigger, pinned: true };
  const popover = { hidden: false };
  const close = vm.runInNewContext(`(${functionSource(template, "closeScopedDefinitionPopover")})`, {
    state, els: { scopedDefinitionPopover: popover }, clearTimeout: timer => cleared.push(timer)
  });
  close(true, true);
  assert.equal(popover.hidden, true);
  assert.equal(expanded, "false");
  assert.equal(focused, true, "Close must return focus to the defined term.");
  assert(cleared.includes(3), "Returning focus must cancel the preview it would otherwise reopen.");
});
