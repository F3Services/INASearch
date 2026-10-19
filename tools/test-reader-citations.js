#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");

const fs = require("node:fs"), vm = require("node:vm");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require("node:path").join(__dirname, "../src/INASearch.template.html"), "utf8");
// Arrival syntax must not choose a reader heading's citation system.
const headingContext = vm.createContext({
  state: { statuteHierarchyAuthority: "ina" },
  profile: { preferences: { statutoryLinkCitationSystem: "view" } },
  escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
});
for (const name of ["uscBase", "statutoryLinksUseIna", "statuteReaderCitationBase"]) {
  vm.runInContext(functionSource(template, name), headingContext);
}
const headingSection = { id: "8-1101", title: 8, section: "1101" };
const headingMapping = { inaSection: "101", uscSection: "1101" };
for (const [preference, view, expected] of [
  ["view", "ina", "INA 101"], ["view", "usc", "8 U.S.C. 1101"],
  ["ina", "ina", "INA 101"], ["ina", "usc", "INA 101"],
  ["usc", "ina", "8 U.S.C. 1101"], ["usc", "usc", "8 U.S.C. 1101"]
]) {
  headingContext.profile.preferences.statutoryLinkCitationSystem = preference;
  headingContext.state.statuteHierarchyAuthority = view;
  for (const arrival of [{ type: "ina", label: "INA 101(a)" }, { type: "usc", label: "8 U.S.C. 1101(a)" }, null]) {
    assert.equal(headingContext.statuteReaderCitationBase(headingSection, arrival, null, headingMapping), expected,
      `Reader heading follows ${preference}/${view} after ${arrival?.type || "search"} navigation`);
  }
}
for (const name of ["legalUnitTriggerHtml", "statuteReaderCitationHtml"]) {
  vm.runInContext(functionSource(template, name), headingContext);
}
const visibleHeading = html => html.replace(/<template>[\s\S]*?<\/template>/g, "").replace(/<[^>]+>/g, "");
for (const [preference, view, expected] of [
  ["view", "ina", "INA 101"], ["view", "usc", "8 U.S.C. 1101"],
  ["ina", "usc", "INA 101"], ["usc", "ina", "8 U.S.C. 1101"]
]) {
  headingContext.profile.preferences.statutoryLinkCitationSystem = preference;
  headingContext.state.statuteHierarchyAuthority = view;
  const html = headingContext.statuteReaderCitationHtml(headingSection, null, headingMapping);
  assert.equal(visibleHeading(html), expected, "The visible heading uses the shared display preference");
  assert.equal((html.match(/<button\b/g) || []).length, 1, "The heading keeps one selection button when its citation changes");
  if (preference === "view") {
    assert(html.includes(`data-citation-display="${view}"`), "Follow View headings participate in live citation swaps");
    assert.match(html, /<button[^>]+data-legal-unit-path="\[\]"[^>]*>.*data-citation-display=/, "The whole-section selection action stays outside the swapped text");
    assert.equal(visibleHeading(html.match(/<template>([\s\S]*)<\/template>/)[1]), view === "ina" ? "8 U.S.C. 1101" : "INA 101");
  } else assert(!html.includes("data-citation-display"), "Always/Never headings do not change with the view button");
}
headingContext.profile.preferences.statutoryLinkCitationSystem = "view";
headingContext.state.statuteHierarchyAuthority = "ina";
for (const [section, transfer, mapping, expected] of [
  [{ id: "8-1252c", title: 8, section: "1252c" }, null, null, "8 U.S.C. 1252c"],
  [{ id: "18-16", title: 18, section: "16" }, null, null, "18 U.S.C. 16"],
  [{ id: "8-31", title: 8, section: "31" }, { source: "31", title: 52, section: "10101" }, null, "8 U.S.C. 31"]
]) {
  const html = headingContext.statuteReaderCitationHtml(section, transfer, mapping);
  assert.equal(visibleHeading(html), expected, "Unmapped and transferred headings retain their exact source citation");
  assert(!html.includes("data-citation-display"), "Identical citation forms do not need a live alternate");
}
console.log("PASS reader heading citation follows display preferences independently of arrival syntax");

const markerHtml = vm.runInNewContext(`(${functionSource(template, "legalUnitTriggerHtml")})`, { escapeHtml: String });
assert.doesNotMatch(markerHtml("usc", "s", ["a"], "INA 212(a)", "(a)"), /aria-haspopup|aria-expanded|Citation actions/, "unit labels select a citation without advertising the retired menu");
assert.doesNotMatch(template, /id="legalUnitMenu"|openLegalUnitMenu\(/, "the legacy citation menu is removed");
const selections = [];
let selectedPane = null;
const selectionState = { view: "search", statuteNavigationLocation: { view: "reader" }, selected: { kind: "usc", item: { id: "s" } } };
const selectUnit = vm.runInNewContext(`(${functionSource(template, "selectLegalUnitTrigger")})`, {
  state: selectionState, els: { detail: { contains: () => true } },
  applyNavigationQuery: query => { selections.push(query); return true; },
  focusedPaneForElement: () => selectedPane,
  withFocusedCitationPane: (pane, select) => { selections.push(pane.id); return select(); },
  selectLegalCitationLocation: (...args) => { selections.push(args); return true; }
});
const clickedUnit = { dataset: { legalUnitKind: "usc", legalUnitSection: "s", legalUnitPath: '["a","1"]' }, closest: () => null };
assert.equal(selectUnit(clickedUnit), true);
assert.deepEqual(JSON.parse(JSON.stringify(selections)), [["usc", "s", ["a", "1"], null]], "clicking a unit selects its exact citation for the sidebar");
selectedPane = { id: "pane-cfr" };
selectionState.selected = { kind: "cfr", item: { id: "8:103.2" } };
clickedUnit.dataset = { legalUnitKind: "cfr", legalUnitSection: "8:103.2", legalUnitPath: '["b","1"]' };
clickedUnit.closest = selector => selector === "[data-cfr-block-path]" ? { dataset: { cfrBlockPath: "2.0" } } : null;
assert.equal(selectUnit(clickedUnit), true);
assert.deepEqual(JSON.parse(JSON.stringify(selections.slice(1))), ["pane-cfr", ["cfr", "8:103.2", ["b", "1"], [2, 0]]], "pane unit selection preserves the CFR occurrence and pane context");
selectedPane = null;
selectionState.view = "definitions";
clickedUnit.dataset.legalUnitCitation = "INA 101(b)(1)(A)";
assert.equal(selectUnit(clickedUnit), true);
assert.equal(selections.at(-1), "INA 101(b)(1)(A)", "a definition marker opens its reader instead of retargeting a hidden reader");
selectionState.view = "search";
selectionState.selected = { kind: "definition", item: { id: "definition-child" } };
assert.equal(selectUnit(clickedUnit), true);
assert.equal(selections.at(-1), "INA 101(b)(1)(A)", "a definition search preview opens the citation reader");
clickedUnit.dataset.legalUnitPath = "invalid";
assert.equal(selectUnit(clickedUnit), false);
const host = {}, detail = {};
const marker = path => ({ dataset: { legalUnitSection: "s", legalUnitPath: JSON.stringify(path) },
  closest: selector => selector.includes("detail-content") ? host : null,
  getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 60, bottom: 88, height: 28 }) });
const selectedMarker = marker(["b"]), fallback = marker(["c"]);
let selectedTop = 300, highlighted = true;
const selectedHost = { closest: () => null, getBoundingClientRect: () => ({ top: selectedTop, bottom: selectedTop + 100, height: 100 }) };
const state = { selected: { item: { title: 8, section: "1182" } }, statuteHierarchyAuthority: "ina", statuteNavigationLocation: { view: "reader", sectionId: "s", path: ["b"] } };
const context = { state, els: { detail, statuteNavigator: { hidden: true } }, window: { innerHeight: 800 },
  legalReaderBusy: () => false, mainLiveCitationLocation: () => ({ kind: "usc", sectionId: "s" }),
  $: (selector, root) => root === selectedHost ? selectedMarker : { getBoundingClientRect: () => ({ bottom: 60 }) },
  $$: selector => selector.startsWith(".statutory-node.target") ? (highlighted ? [selectedHost] : []) : [fallback],
  statuteReadingLine: () => 200, legalCitationSelectionForElement: () => host,

  citationBannerControllers: new Map(),
  uscMapping: () => ({ inaSection: "212" }), canonicalPath: path => path.map(x => `(${x})`).join("") };
const target = vm.runInNewContext(`(${functionSource(template, "mainReaderActionTarget")})`, context);
assert.equal(target().query, "INA 212(b)", "the highlighted citation is the shared action target");
selectedTop = -200;
assert.equal(target().query, "INA 212(b)", "an offscreen highlight remains the action target");
highlighted = false;
assert.equal(target().query, "INA 212", "without a highlight every action targets the section");
assert.deepEqual(Array.from(target().path), []);
highlighted = true;
selectedTop = 100;
state.statuteNavigationLocation.path = [];
selectedHost.dataset = { legalUnitKind: "usc" };
assert.equal(target().query, "INA 212", "a visible selected section heading copies the whole section");
assert.equal(target().trigger, selectedHost);
selectedTop = -200;
assert.equal(target().query, "INA 212", "an offscreen selected section heading still targets the section");
state.copyActionPreview = { pane: null, target: { query: "frozen" } };
assert.equal(target().query, "frozen", "hover scrolling must not retarget a pending copy");
console.log("PASS reader action target: offscreen selection, whole section fallback, and frozen hover preview");

context.mainReaderActionTarget = target;
const printTarget = vm.runInNewContext(`(${functionSource(template, "mainReaderPrintTarget")})`, context);
state.copyActionPreview = null;
state.statuteNavigationLocation.path = ["b"];
selectedTop = -200;
assert.equal(printTarget().query, "INA 212(b)", "Printing keeps the highlighted citation even when it is offscreen");
assert.equal(printTarget().printHighlighted, true);
highlighted = false;
assert.equal(printTarget().query, "INA 212", "Without a highlight, print the section rather than the reading-line child");
assert.equal(printTarget().path.length, 0);
assert.equal(printTarget().printHighlighted, false);
state.copyActionPreview = { pane: null, action: "print", target: { query: "frozen print", path: ["b"], printHighlighted: true } };
assert.equal(printTarget().query, "frozen print", "A print preview must freeze its target through scrolling and clicking");
console.log("PASS reader print target: offscreen highlight, whole section, and frozen preview");

// Selecting a legal unit may change the highlight without replacing the user's query.
for (const paneMode of [false, true]) for (const updatesSearch of [undefined, false, true]) {
  const original = "INA 212(a)", section = { id: "s", title: 8, section: "1182" };
  const root = { scrollTop: 900, scrollLeft: 0, scrollTo: () => {} };
  const pane = paneMode ? { id: "pane", entry: { text: original }, input: { value: original }, scrollRoot: root } : null;
  const selection = vm.createContext({
    state: { query: original, selected: { item: section }, statuteHierarchyAuthority: "ina" },
    profile: { preferences: { selectionUpdatesSearch: updatesSearch } },
    els: { search: { value: original }, detail: {} },
    corpus: { cfr: { sections: [] } }, uscSectionById: new Map([["s", section]]),
    window: { scrollY: 900, scrollX: 0, scrollTo: () => {} }, focusedPaneById: () => pane,
    uscMapping: () => ({ inaSection: "212" }), uscBase: () => "8 U.S.C. 1182",
    canonicalPath: path => path.map(token => `(${token})`).join(""),
    formatNavigationCitationLike: (previous, next) => next,
    parseCitation: query => ({ valid: true, label: query, path: ["b"] }),
    focusedCitationRecord: () => ({ item: section }), legalReaderBusy: () => false,
    cancelLegalReaderScroll: () => {}, adoptPromotedNavigationHistory: () => {}, commitMainSearchHistoryEdit: () => {},
    normalizedStatuteHistoryLocation: (sectionId, path, kind) => ({ view: "reader", sectionId, path, kind }),
    recordExplicitStatuteMove: () => {}, renderCfrNavigation: () => {}, renderStatuteNavigation: () => {},
    focusedPaneHistorySnapshot: () => ({}), replaceFocusedCitationSegment: () => {}, focusedCitationIdentity: () => "pane",
    renderFocusedPaneCitationActions: () => {}, pushFocusedPaneCommandHistory: () => {},
    renderCitationFeedback: () => {}, updateSearchSuggestionVisibility: () => {}, syncMainShareWarning: () => {},
    activateNavigationLocation: location => { selection.state.statuteNavigationLocation = location; },
    captureStatuteHistoryPresentation: () => {}, highlightScrolledLegalTarget: (kind, path) => { selection.highlight = Array.from(path); },
    syncMainReaderToolbar: () => {}, requestAnimationFrame: callback => callback()
  });
  vm.runInContext(functionSource(template, "clearScrolledSearchLocation"), selection);
  vm.runInContext(functionSource(template, "selectLegalCitationLocation"), selection);
  assert.equal(selection.selectLegalCitationLocation("usc", "s", ["b"]), true);
  const expected = updatesSearch === false ? original : "INA 212(b)";
  assert.equal(pane ? pane.input.value : selection.els.search.value, expected,
    `${paneMode ? "Pane" : "Main"} selection respects the default-on search update preference (${updatesSearch})`);
  assert.equal(selection.state.query, "INA 212(b)", "History keeps the selected query independently of displayed text");
  assert.deepEqual(Array.from(selection.state.statuteNavigationLocation.path), ["b"], "The selected target remains independent of the search text");
  assert.deepEqual(selection.highlight, ["b"]);
}
console.log("PASS reader selection search updates: default on, opt out, and independent highlights in main and pane readers");

const historyContext = vm.createContext({
  $$: () => [], document: {}, copyPreviewReadingScrollTop: () => 900, updateFocusedPaneHistoryButtons: () => {}
});
for (const name of ["focusedPaneHistorySnapshot", "pushFocusedPaneCommandHistory"]) vm.runInContext(functionSource(template, name), historyContext);
const historyPane = { entry: { mode: "reader", text: "INA 212(a)", authority: "statute" },
  result: { label: "INA 212(a)", path: ["a"] }, readerState: {}, commandHistory: [], commandHistoryIndex: -1 };
const firstSelection = historyContext.focusedPaneHistorySnapshot(historyPane);
historyPane.result = { label: "INA 212(b)", path: ["b"] };
const secondSelection = historyContext.focusedPaneHistorySnapshot(historyPane);
assert.equal(secondSelection.command, "INA 212(a)", "Pane history retains the displayed search text");
assert.equal(secondSelection.query, "INA 212(b)", "Pane history separately retains the selected citation");
historyContext.pushFocusedPaneCommandHistory(historyPane, null, firstSelection);
historyContext.pushFocusedPaneCommandHistory(historyPane, firstSelection, secondSelection);
assert.equal(historyPane.commandHistory.length, 2, "Selecting another highlight remains a distinct Back/Forward destination with search updates off");
console.log("PASS reader history separates selected citations from displayed search text");

// Scroll-follow uses its own depth and never replaces explicit reader/history state.
for (const paneMode of [false, true]) for (const kind of ["statute", "cfr"]) {
  const committed = kind === "cfr" ? "8 CFR 212.4(b)" : "INA 212(b)";
  const section = { id: "section", title: 8, section: kind === "cfr" ? "212.4" : "1182" };
  const selected = { item: section }, result = { label: committed, path: ["b"] };
  const pane = paneMode ? { entry: { text: committed }, input: { value: committed }, result,
    record: selected, readerState: {}, index: 1, detail: {} } : null;
  const history = [{ query: committed, path: ["b"] }];
  const scope = vm.createContext({
    state: { query: committed, citation: result, selected, statuteHierarchyAuthority: "ina", statuteNavigationLocation: history[0],
      statuteNavigationHistory: history, statuteNavigationHistoryIndex: 0, focusedPaneContext: pane },
    profile: { preferences: { scrollUpdatesSearch: true, scrollSearchDepth: 2 } },
    els: { search: { value: pane ? `INA 101, ${committed}` : committed } }, document: { activeElement: null },
    navigationDepthValue: () => 1, // The breadcrumb depth must not limit scroll-follow.
    uscMapping: () => ({ inaSection: "212" }), uscBase: () => "8 U.S.C. 1182",
    canonicalPath: path => path.map(token => `(${token})`).join(""),
    focusedPaneById: () => pane, isMainLegalReader: () => !paneMode,
    formatNavigationCitationLike: (previous, next) => next,
    parseCitation: query => ({ valid: true, label: query, path: query.match(/\(([^)]+)\)/g)?.map(x => x.slice(1, -1)) || [] }),
    focusedCitationRecord: value => ({ citationResult: value, item: section }),
    replaceFocusedCitationSegment: () => assert.fail("Scrolling must not replace a pane's committed citation"),
    focusedCitationSegments: value => require("../src/INASearch-Command").scanCommandSegments(value).segments,
    focusedWorkspaceExpression: () => assert.fail("The existing active pane segment should be updated in place"),
    renderFocusedPaneCitationActions: () => {}, renderCitationFeedback: () => {}, updateSearchSuggestionVisibility: () => {},
    syncMainReaderToolbar: () => {}, updateStatuteHistoryButtons: () => {}, updateFocusedPaneHistoryButtons: () => {}
  });
  for (const name of ["normalizedStatuteHistoryLocation", "normalizeScrollSearchDepth", "scrollSearchDepthValue", "replaceFocusedCitationSegmentText", "syncSearchToScrolledLegalLocation"]) {
    vm.runInContext(functionSource(template, name), scope);
  }
  const originalHistory = JSON.stringify(history);
  scope.document.activeElement = pane ? pane.input : scope.els.search; // Enter can leave the committed input focused.
  if (pane) {
    pane.scrollSearchPinned = true;
    assert.equal(scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "1", "A"]), false,
      "An explicit pane navigation must not become a scroll update before the user scrolls");
    assert.equal(pane.input.value, committed);
    pane.scrollSearchPinned = false;
  }
  assert.equal(scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "1", "A", "ii"]), true);
  const base = kind === "cfr" ? "8 CFR 212.4" : "INA 212";
  const input = pane ? pane.input : scope.els.search;
  assert.equal(input.value, `${base}(a)(1)`, "The selected paragraph limit applies in main and pane readers for both authorities");
  assert.equal(scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "1", "B"]), false, "Deeper children do not change the scroll citation");
  assert.equal(scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "2", "A"]), true);
  assert.equal(input.value, `${base}(a)(2)`);
  assert.equal(scope.state.query, committed, "Scroll updates retain the committed query");
  assert.equal(scope.state.citation, result, "Scroll updates retain the committed parsed citation");
  assert.equal(scope.state.selected, selected, "Scroll updates retain the highlighted reader target");
  assert.equal(JSON.stringify(history), originalHistory, "Scroll updates do not change logged destinations");
  if (pane) {
    assert.equal(pane.entry.text, committed);
    assert.equal(pane.result, result);
    assert.equal(scope.els.search.value, `INA 101, ${base}(a)(2)`, "Only the active pane search segment changes while the other pane stays intact");
  }
  scope.profile.preferences.scrollSearchDepth = 1;
  scope.state.lastScrollSyncedCitation = "";
  scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "3", "C"]);
  assert.equal(input.value, `${base}(a)`, "Subsection maps to the first CFR paragraph");
  scope.profile.preferences.scrollSearchDepth = 0;
  scope.state.lastScrollSyncedCitation = "";
  scope.syncSearchToScrolledLegalLocation(kind, section, ["a", "3", "C"]);
  assert.equal(input.value, base, "Section suppresses all lower-unit updates");
  scope.profile.preferences.scrollUpdatesSearch = false;
  assert.equal(scope.syncSearchToScrolledLegalLocation(kind, section, ["c", "1"]), false);
  assert.equal(input.value, base, "Scroll-follow remains opt-in");
}
console.log("PASS scroll-search: main/pane INA/CFR depth caps, stable highlighted target, and untouched interaction history");

// Back first returns to the most recent interaction, without logging the live citation.
const paneHistory = [{ command: "INA 212(a)", query: "INA 212(a)" }, { command: "INA 212(b)", query: "INA 212(b)" }];
const returnPane = { entry: { mode: "reader", text: "INA 212(b)" }, result: { label: "INA 212(b)", path: ["b"] },
  readerState: { scrollSearchLocation: { query: "INA 212(c)", path: ["c"] } },
  commandHistory: paneHistory, commandHistoryIndex: 1 };
const openedHistoryQueries = [];
const returnScope = vm.createContext({
  state: {}, document: {}, $$: () => [], copyPreviewReadingScrollTop: () => 900,
  clearTimeout: () => {}, structuredCloneSafe: value => JSON.parse(JSON.stringify(value)),
  focusedPaneDescriptor: () => ({ ok: true }), withFocusedCitationPane: (pane, callback) => callback(),
  applyFocusedPaneCommand: (pane, query) => { openedHistoryQueries.push(query); pane.readerState.scrollSearchLocation = null; return true; },
  updateFocusedPaneHistoryButtons: () => {}, requestAnimationFrame: () => {}
});
for (const name of ["focusedPaneHistorySnapshot", "navigateFocusedPaneCommandHistory"]) vm.runInContext(functionSource(template, name), returnScope);
assert.equal(returnScope.navigateFocusedPaneCommandHistory(returnPane, -1), true);
assert.deepEqual(openedHistoryQueries, ["INA 212(b)"], "Back from a scroll update returns to the last interaction");
assert.equal(returnPane.commandHistoryIndex, 1, "Returning from live scroll does not consume a history entry");
assert.equal(returnScope.navigateFocusedPaneCommandHistory(returnPane, -1), true);
assert.deepEqual(openedHistoryQueries, ["INA 212(b)", "INA 212(a)"], "A second Back goes to the previous interaction");
assert.equal(paneHistory.length, 2, "The scroll citation never becomes a logged destination");
returnPane.commandHistoryIndex = 1;
returnPane.readerState.scrollSearchLocation = { query: "INA 212(c)" };
returnScope.applyFocusedPaneCommand = () => false;
assert.equal(returnScope.navigateFocusedPaneCommandHistory(returnPane, -1), false);
assert.equal(returnPane.scrollSearchRestorePending, false, "A blocked history action must not leave scroll-follow permanently paused");
// Older interaction destinations must jump to the citation, not the later reading position saved while leaving it.
returnScope.profile = { preferences: { scrollUpdatesSearch: true } };
paneHistory[0].mode = "reader";
returnPane.commandHistoryIndex = 1;
returnPane.readerState.scrollSearchLocation = null;
returnPane.scrollRoot = { scrollTop: 5000 };
returnPane.detail = {};
returnScope.applyFocusedPaneCommand = (pane, query) => { pane.entry = { text: query, mode: "reader" }; return true; };
returnScope.navigateFocusedPaneCommandHistory(returnPane, -1);
const restoreFrames = [], restoredCitations = [];
returnScope.requestAnimationFrame = callback => restoreFrames.push(callback);
returnScope.legalReaderBusy = () => false;
returnScope.parseCitation = query => ({ label: query });
returnScope.shareCitationAnchor = (root, citation) => citation;
returnScope.scrollStatuteAnchorToReadingLine = citation => restoredCitations.push(citation.label);
vm.runInContext(functionSource(template, "consumeFocusedPaneHistoryRestore"), returnScope);
returnScope.consumeFocusedPaneHistoryRestore(returnPane);
while (restoreFrames.length) restoreFrames.shift()();
assert.deepEqual(restoredCitations, ["INA 212(a)"], "Back must position the older interacted citation instead of restoring a scroll-only position");
console.log("PASS scroll-search history: return to latest interaction, then earlier interaction");

const installBanners = vm.runInNewContext(`(${functionSource(template, "installCitationBanners")})`, {
  citationBannerControllers: new Map(),
  citationUnitRecords: () => { assert.fail("Readers without note banners must not scan, wrap, or position every citation marker"); }
});
installBanners({}, []);
console.log("PASS reader layout: no citation marker layout work for sections without banners");

// CFR source paragraphs are flat siblings, including compound markers and
// unnumbered continuations. Hover must preview the legal scope, not just a row.
const cfrHierarchy = require("../src/INASearch-CFR-Hierarchy");
const hoverSection = { id: "8:214.2", blocks: [
  { t: "p", a: "(a)", x: "(a) Parent." },
  { t: "p", a: "(a)(1)(i)", x: "(1) First. (i) Child.", u: [{ a: "(a)(1)", s: 0, e: 3 }, { a: "(a)(1)(i)", s: 11, e: 14 }] },
  { t: "p", a: "(a)(1)(ii)", x: "(ii) Second child." },
  { t: "p", c: "(a)(1)(ii)", x: "Continuation." },
  { t: "table", rows: [[{ x: "Included table" }]] },
  { t: "graphic" },
  { t: "p", a: "(a)(2)", x: "(2) Sibling." },
  { t: "p", a: "(a)(1)", x: "(1) Repeated source designation." },
  { t: "p", a: "(a)(1)(i)", x: "(i) Repeated child." },
  { t: "p", a: "(a)(2)", x: "(2) Next repeated sibling." }
] };
const hoverContext = vm.createContext({
  INASearchCfrHierarchy: cfrHierarchy,
  componentTokens: cfrHierarchy.tokens
});
for (const name of ["sameBlockPath", "cfrBodySegments", "cfrSelectionInset"]) {
  vm.runInContext(functionSource(template, name), hoverContext);
}
const plain = value => JSON.parse(JSON.stringify(value));
const readerSegments = plain(hoverContext.cfrBodySegments(hoverSection, ""));
assert.deepEqual(readerSegments.filter(segment => segment.i === 1).map(({ start, end }) => [start, end]), [[0, 11], [11, 21]],
  "Compound paragraphs have stable source fragments before the first hover");
const scopeRanges = (path, locator) => readerSegments.filter(segment => segment.groups.some(group => group.path === path && group.locator.join(".") === locator.join(".")))
  .map(({ i, start, end }) => [i, start, end]);
assert.deepEqual(scopeRanges("(a)(1)", [1]), [[1, 0, 11], [1, 11, 21], [2, 0, 18], [3, 0, 13], [4, 0, 0], [5, 0, 0]],
  "A stable CFR scope includes children, continuation text, tables and graphics, stopping before its sibling");
assert.deepEqual(scopeRanges("(a)(1)(i)", [1]), [[1, 11, 21]], "A compound child has its own exact source fragment");
assert.equal(readerSegments.find(segment => segment.i === 1 && segment.start === 11).groups.at(-1).depth, 3,
  "A compound child highlight starts at the child fragment indentation");
assert.deepEqual(scopeRanges("(a)(1)", [7]), [[7, 0, 32], [8, 0, 19]], "Repeated source designations have separate scope hosts");
const selectedSegments = plain(hoverContext.cfrBodySegments(hoverSection, "(a)(1)(i)", [1]));
assert.deepEqual(selectedSegments.filter(segment => segment.selected).map(({ i, start, end }) => [i, start, end]), [[1, 11, 21]],
  "Hover and selection share the same prebuilt compound fragment");
assert.deepEqual(selectedSegments.map(({i, start, end}) => [i, start, end]), readerSegments.map(({i, start, end}) => [i, start, end]),
  "Changing the selection never changes source fragment boundaries");
assert.deepEqual(readerSegments.find(segment => segment.i === 1 && segment.start === 11).groups.map(group => group.path), ["(a)", "(a)(1)", "(a)(1)(i)"],
  "Permanent parent and child hosts allow nested highlights without regrouping content");
Object.assign(hoverContext, {
  escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
  canonicalPath: cfrHierarchy.address,
  cfrBlockUnitPaths: cfrHierarchy.units, sameBlockPath: () => false,
  renderCfrStyledRange: (block, start, end) => block.x.slice(start, end), legalAugmentationSlotHtml: () => ""
});
for (const name of ["cfrGraphicHtml", "cfrReferenceContext", "legalUnitTriggerHtml", "legalCitationSelectionAttributes", "renderCfrParagraphContents", "renderCfrBlock"]) {
  vm.runInContext(functionSource(template, name), hoverContext);
}
const clippedChild = hoverContext.renderCfrBlock(hoverSection.blocks[1], [1], "", null, hoverSection, "8 CFR 214.2", null, "", { start: 11, end: 21 });
assert.match(clippedChild, /^<div[^>]*data-legal-citation-path="\[&quot;a&quot;,&quot;1&quot;,&quot;i&quot;\]"/, "The padding of a split compound child must select that child, rather than its parent");
// Verify the permanent reader wrappers against every occurrence in the shipped
// corpus, including source notes and shared reserved designations.
const cfrCorpusContext = { window: {} };
vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname, "../src/INASearch-CFR.js"), "utf8"), cfrCorpusContext);
let verifiedScopes = 0;
for (const section of [...cfrCorpusContext.window.INA_SEARCH_CFR.sections, ...cfrCorpusContext.window.INA_SEARCH_CFR.appendices]) {
  const segments = hoverContext.cfrBodySegments(section, ""), actual = new Map();
  for (const segment of segments) for (const group of segment.groups) {
    if (!actual.has(group.key)) actual.set(group.key, []);
    const ranges = actual.get(group.key), previous = ranges.at(-1);
    if (previous && previous[0] === segment.i && previous[2] === segment.start) previous[2] = segment.end;
    else ranges.push([segment.i, segment.start, segment.end]);
  }
  for (const node of cfrHierarchy.index(section).nodes) {
    const expected = cfrHierarchy.scope(section, node.path, node.row.blockPath).map(range => [range.blockPath[0], range.start, range.end]);
    // A note keeps one source container in the reader, even when its source
    // representation has several internal rows.
    const normalize = ranges => ranges.map(([i, start, end]) => section.blocks[i].t === "note" ? [i, 0, 0] : [i, start, end])
      .filter((range, i, list) => !i || range.join(":") !== list[i - 1].join(":"));
    assert.deepEqual(normalize(plain(actual.get(String(node.start)) || [])), normalize(plain(expected)),
      `${section.id}${node.path}: permanent reader host matches the legal occurrence scope`);
    verifiedScopes++;
  }
}
console.log(`PASS CFR citation hover: stable parent/child hosts and ${verifiedScopes} corpus scopes`);

// A pinned preview lives outside the reader, but its Follow View fragments
// must take part in the same authority change.
const displayReaderRoot = {}, displayPreviewRoot = {};
const displayWrapper = () => ({
  dataset: { citationDisplay: "usc" },
  firstElementChild: { childNodes: [], append() {} },
  lastElementChild: { content: { append() {} } },
  closest: () => null
});
const readerDisplay = displayWrapper(), previewDisplay = displayWrapper();
const swapScope = vm.createContext({
  els: { detail: displayReaderRoot, legalReferencePopoverContent: displayPreviewRoot },
  profile: { highlights: [] }, document: { createDocumentFragment: () => ({ append() {} }) },
  $$: (selector, root) => selector === "[data-citation-display]"
    ? root === displayReaderRoot ? [readerDisplay] : root === displayPreviewRoot ? [previewDisplay] : [] : [],
  restoreCitationDisplayAnchor() {}
});
vm.runInContext(functionSource(template, "swapCitationDisplayFragments"), swapScope);
for (const authority of ["ina", "usc"]) {
  swapScope.swapCitationDisplayFragments(authority, null);
  assert.equal(readerDisplay.dataset.citationDisplay, authority);
  assert.equal(previewDisplay.dataset.citationDisplay, authority, "A pinned hover preview must follow the reader authority toggle");
}
console.log("PASS Follow View swaps: reader and pinned hover preview stay in the same citation system");
