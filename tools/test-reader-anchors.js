#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
const fn = require("./test-function-source");
let observer, queries = 0, rectangles = 0;
const element = (top, classes, dataset = {}, options = {}) => ({
  dataset, parentElement: options.parent || null,
  classList: { contains: name => classes.includes(name) },
  closest: selector => selector.startsWith(".cfr-subtree") ? options.scope || null : options.inserted ? {} : null,
  querySelector: () => options.units ? {} : null,
  getBoundingClientRect: () => { rectangles++; return { top }; }
});
const heading = element(20, ["detail-heading-row"]);
const scope = element(50, ["cfr-block", "cfr-subtree"], { cfrPath: "(a)", cfrBlockPath: "0" });
const paragraph = element(50, ["cfr-block"], { cfrPath: "(a)", cfrBlockPath: "0" }, { units: true });
const first = element(50, ["cfr-unit-wrapper"], { cfrPath: "(a)", cfrBlockPath: "0" });
const second = element(90, ["cfr-unit-wrapper"], { cfrPath: "(a)(1)", cfrBlockPath: "1" });
const repeated = element(140, ["cfr-unit-wrapper"], { cfrPath: "(a)(1)", cfrBlockPath: "9" });
const continuation = element(165, ["cfr-unit-wrapper"], { cfrBlockPath: "11" },
  { scope: { dataset: { cfrPath: "(a)(1)", cfrBlockPath: "9" } } });
const inserted = element(100, ["statutory-line"], {}, { inserted: true, parent: { dataset: { statutePath: '["z"]' } } });
const future = element(180, ["cfr-unit-wrapper"], { cfrPath: "(a)(2)", cfrBlockPath: "10" });
let candidates = [heading, scope, paragraph, first, second, inserted, repeated, continuation, future];
const root = { querySelectorAll: () => { queries++; return candidates; } };
const api = vm.createContext({ legalReaderAnchorIndexes: new WeakMap(),
  componentTokens: require("../src/INASearch-CFR-Hierarchy").tokens,
  MutationObserver: class { constructor(callback) { this.callback = callback; this.records = []; observer = this; }
    observe() {} takeRecords() { return this.records.splice(0); } },
  els: { detail: root }, state: { statuteNavigationSectionId: "s" }, statuteReadingLine: () => 155 });
for (const name of ["legalReaderAnchors", "legalReaderReadingPosition", "currentLegalReaderAnchor", "currentStatutePathAtReadingLine", "currentCfrPathAtReadingLine"])
  vm.runInContext(fn(source, name), api);
const anchors = api.legalReaderAnchors(root);
assert.deepEqual(Array.from(anchors, anchor => anchor.element), [heading, first, second, repeated, continuation, future],
  "Only canonical physical anchors participate; permanent scope wrappers and inserted excerpts do not");
assert.equal(queries, 1);
const position = api.legalReaderReadingPosition(root, 175, "cfr");
assert.equal(position.before.element, continuation, "An unnumbered continuation inherits its enclosing legal scope");
assert.equal(position.before.occurrenceBlockPath.join("."), "9", "A continuation retains its repeated scope's origin rather than its own source row");
assert.equal(position.after.element, future);
assert.equal(rectangles, 5, "Each physical anchor is measured once and scanning stops at the next anchor");
assert.equal(queries, 1, "Scrolling reuses the element index");
assert.equal(api.currentCfrPathAtReadingLine().join("/"), "a/1");
const statute = element(100, ["statutory-line"], {}, { parent: { dataset: { statutePath: '["b","2"]' } } });
candidates = [heading, statute];
observer.records.push({ type: "childList" });
assert.equal(api.currentStatutePathAtReadingLine().join("/"), "b/2", "Structural changes invalidate the same shared index before the next read");
assert.equal(queries, 2);
const above = api.legalReaderReadingPosition(root, 1, "usc");
assert.equal(above.before, null, "Content below the reading line does not become the live citation early");
assert.equal(above.after.element, statute);
console.log("PASS reader anchors: physical source index, occurrence identity, bounded geometry and structural invalidation");
