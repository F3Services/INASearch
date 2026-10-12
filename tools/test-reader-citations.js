#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");

const fs = require("node:fs"), vm = require("node:vm");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require("node:path").join(__dirname, "../src/INASearch.template.html"), "utf8");
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

const installBanners = vm.runInNewContext(`(${functionSource(template, "installCitationBanners")})`, {
  citationBannerControllers: new Map(),
  citationUnitRecords: () => { assert.fail("Readers without note banners must not scan, wrap, or position every citation marker"); }
});
installBanners({}, []);
console.log("PASS reader layout: no citation marker layout work for sections without banners");
