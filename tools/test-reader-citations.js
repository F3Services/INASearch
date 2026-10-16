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
assert.equal(target().query, "INA 212(b)", "a visible highlighted citation overrides the reading-line target");
selectedTop = -200;
assert.equal(target().query, "INA 212(c)", "a highlight outside the viewport yields to the reading-line unit");
highlighted = false;
assert.equal(target().trigger, fallback);
assert.equal(target().preview, host, "copy hover retains the reading-line unit's original text host");
highlighted = true;
selectedTop = 100;
state.statuteNavigationLocation.path = [];
selectedHost.dataset = { legalUnitKind: "usc" };
assert.equal(target().query, "INA 212", "a visible selected section heading copies the whole section");
assert.equal(target().trigger, selectedHost);
selectedTop = -200;
assert.equal(target().query, "INA 212(c)", "the reading-line target resumes after the selected section heading scrolls out of view");
state.copyActionPreview = { pane: null, target: { query: "frozen" } };
assert.equal(target().query, "frozen", "hover scrolling must not retarget a pending copy");
console.log("PASS reader citation copy target: visible selection override, offscreen selection, and frozen hover preview");

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
state.copyActionPreview = { pane: null, action: "print", target: { query: "frozen print", printHighlighted: true } };
assert.equal(printTarget().query, "frozen print", "A print preview must freeze its target through scrolling and clicking");
console.log("PASS reader print target: offscreen highlight, whole section, and frozen preview");

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
