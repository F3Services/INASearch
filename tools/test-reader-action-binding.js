#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const functionSource = require("./test-function-source");

const template = fs.readFileSync(require("node:path").join(__dirname, "../src/INASearch.template.html"), "utf8");
assert.ok(/function bindReaderActions\(/.test(template), "Main and pane readers need the shared action binder");

// Keep the real action dispatcher and clipboard payload formatting. Only the DOM,
// navigation, clipboard and print boundaries are supplied by this event harness.
class Control extends EventTarget {
  constructor(action = "", authority = false) {
    super();
    this.dataset = { liveCitationAction: action };
    this.disabled = false;
    this.authority = authority;
    this.hovered = false;
    this.focusVisible = true;
  }
  matches(selector) {
    if (selector === ":hover") return this.hovered;
    if (selector === ":focus-visible") return this.focusVisible;
    return selector.includes(".main-reader-authority") && this.authority;
  }
  closest(selector) {
    if (selector === "button" || this.matches(selector)) return this;
    return this.dataset.liveCitationAction && selector.includes(`[data-live-citation-action="${this.dataset.liveCitationAction}"]`) ? this : null;
  }
}
class Rail extends EventTarget {
  constructor() {
    super();
    this.buttons = [new Control("", true), ...["copy-citation", "copy-text", "print", "open"].map(action => new Control(action))];
    this.hovered = false;
  }
  contains(element) { return this.buttons.includes(element); }
  matches(selector) { return selector === ":hover" && this.hovered; }
  button(action) { return this.buttons.find(button => button.dataset.liveCitationAction === action); }
}
function fire(target, type, properties = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}
const plain = value => JSON.parse(JSON.stringify(value));
function harness(paneMode = false) {
  const rail = new Rail(), pane = paneMode ? { id: "pane-cfr", readerActions: rail } : null;
  const context = { kind: paneMode ? "cfr" : "usc", sectionId: paneMode ? "8:212.4" : "8-1101", path: ["a", "1"],
    occurrenceBlockPath: paneMode ? [7] : null, citation: paneMode ? "8 CFR 212.4(a)(1)" : "8 U.S.C. 1101(a)(1)",
    cfrCitation: paneMode ? "8 CFR 212.4(a)(1)" : "", uscCitation: paneMode ? "" : "8 U.S.C. 1101(a)(1)",
    text: "(1) Original source text.", heading: "Heading", noun: paneMode ? "Regulation" : "Statute", url: "https://example.test/source" };
  const copies = [], selections = [], prints = [], opened = [], previews = [], syncs = [], hover = [], hierarchy = [], frames = [];
  const scope = vm.createContext({
    state: { statuteHierarchyAuthority: "usc", focusedCitationMode: paneMode, focusedPaneContext: null, view: "search",
      statuteNavigationKind: context.kind, statuteNavigationSectionId: context.sectionId,
      statuteNavigationLocation: { view: "reader" }, selected: { item: { id: context.sectionId } } },
    profile: { preferences: { citationCopyPreface: "[citation] - [text]" } }, document: { activeElement: null },
    $$: (selector, root) => root.buttons.filter(button => selector.includes(`[data-live-citation-action="${button.dataset.liveCitationAction}"]`)),
    withFocusedCitationPane: (activePane, callback) => {
      const previous = scope.state.focusedPaneContext;
      scope.state.focusedPaneContext = activePane;
      try { return callback(); } finally { scope.state.focusedPaneContext = previous; }
    },
    syncMainReaderActionTarget: () => syncs.push(scope.state.focusedPaneContext?.id || "main"),
    setLegalCitationHover: selection => hover.push(selection), requestAnimationFrame: callback => frames.push(callback),
    beginCopyActionPreview: (activePane, action) => { previews.push([activePane?.id || "main", action]); scope.frozen = context; },
    endCopyActionPreview: () => { scope.frozen = null; },
    mainReaderActionContext: target => target || scope.frozen || scope.current,
    mainReaderPrintTarget: () => scope.printTarget,
    setStatuteHierarchyAuthority: value => { scope.state.statuteHierarchyAuthority = value; },
    adoptPromotedNavigationHistory: () => {},
    selectLegalCitationLocation: (...args) => selections.push({ pane: scope.state.focusedPaneContext?.id || "main", args: plain(args) }),
    copyLegalText: async value => { copies.push(value); return true; },
    printLegalUnit: value => prints.push(plain(value)), safeOpen: value => opened.push(value), toast: () => {},
    handleHierarchySourceAction: action => hierarchy.push(action)
  });
  scope.current = context;
  scope.printTarget = { ...context, path: ["b"], citation: context.citation.replace("(a)(1)", "(b)"), text: "(b) Highlighted print text." };
  for (const name of ["isMainLegalReader", "commitMainLegalContext", "preferredLegalUnitCitation", "legalUnitCopyText", "citationCopyPreface", "citationWithLegalText", "handleLegalUnitAction", "bindCopyActionPreview", "bindReaderActions"]) {
    vm.runInContext(functionSource(template, name), scope);
  }
  scope.bindReaderActions(rail, pane);
  return { rail, pane, scope, context, copies, selections, prints, opened, previews, syncs, hover, hierarchy, frames };
}

async function checkHost(paneMode) {
  const h = harness(paneMode), host = paneMode ? "pane-cfr" : "main";
  fire(h.rail, "mouseenter");
  fire(h.rail, "focusin");
  assert.deepEqual(h.syncs, [host, host], "Action target refreshes in the rail's own reader context");

  const copy = h.rail.button("copy-text");
  fire(copy, "mouseenter");
  assert.deepEqual(h.previews, [[host, "copy"]]);
  h.scope.current = { ...h.context, text: "Wrong target after preview scrolling." };
  const click = fire(h.rail, "click", { target: copy });
  await Promise.resolve();
  assert.equal(click.defaultPrevented, true);
  assert.equal(h.copies[0], `${paneMode ? "8 CFR 212.4(a)(1)" : "8 U.S.C. 1101(a)(1)"} - (1) Original source text.`,
    "The text action keeps citation formatting and the frozen copy target");
  assert.deepEqual(h.selections[0], { pane: host, args: [h.context.kind, h.context.sectionId, ["a", "1"], paneMode ? [7] : null] },
    "The action commits exactly once, including a pane's occurrence locator");
  assert.equal(h.selections.length, 1);

  fire(h.rail, "click", { target: h.rail.button("print") });
  assert.equal(h.prints[0].text, "(b) Highlighted print text.", "Print uses the separate highlighted target");
  assert.deepEqual(h.selections[1].args[2], ["b"]);
  fire(h.rail, "click", { target: h.rail.button("open") });
  assert.deepEqual(h.opened, ["https://example.test/source"]);

  const before = h.selections.length;
  copy.disabled = true;
  fire(copy, "mouseenter");
  fire(h.rail, "click", { target: copy });
  assert.equal(h.copies.length, 1, "Disabled actions cannot copy or retarget either reader");
  assert.equal(h.selections.length, before);
  assert.equal(h.previews.length, 1);

  h.scope.frozen = null;
  h.scope.current = null;
  fire(h.rail, "click", { target: h.rail.button("open") });
  assert.deepEqual(h.hierarchy, ["open"], "Hierarchy sources remain available without a section context");
  assert.equal(h.selections.length, before);

  const authorityClick = fire(h.rail, "click", { target: h.rail.buttons[0] });
  assert.equal(h.scope.state.statuteHierarchyAuthority, "ina", "The authority toggle remains available without a copy target");
  assert.equal(authorityClick.defaultPrevented, paneMode, "The main toggle retains its document-level dismissal behavior");
  h.rail.buttons[0].disabled = true;
  fire(h.rail, "click", { target: h.rail.buttons[0] });
  assert.equal(h.scope.state.statuteHierarchyAuthority, "ina");

  h.scope.document.activeElement = h.rail.button("print");
  fire(h.rail, "focusout"); h.frames.shift()();
  assert.equal(h.hover.length, 0, "Moving focus inside the rail retains the preview");
  h.scope.document.activeElement = null;
  h.rail.hovered = true;
  fire(h.rail, "focusout"); h.frames.shift()();
  assert.equal(h.hover.length, 0, "Pointer hover retains the preview after focus leaves");
  h.rail.hovered = false;
  fire(h.rail, "focusout"); h.frames.shift()();
  fire(h.rail, "mouseleave");
  assert.deepEqual(h.hover, [null, null], "The preview clears after focus and pointer both leave");
  assert.equal(h.scope.state.focusedPaneContext, null, "Pane actions restore the outer reader context");
}
(async () => {
  await checkHost(false);
  await checkHost(true);
  console.log("PASS reader action binding: main/pane context, frozen copy target, print target, occurrence commit, source action, disabled controls and hover lifetime");
})().catch(error => { console.error(error); process.exitCode = 1; });
