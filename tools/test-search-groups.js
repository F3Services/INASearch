#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const occurrence = require("../src/INASearch-Occurrence");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
const section = (number, status = "current") => ({ id: `8-${number}`, section: number, status, heading: `Provision ${number}`, body: [{ label: "a", text: "groupneedle law" }] });
const corpus = {
  schemaVersion: 1, corpusVersion: "search-groups-fixture",
  title8: { sections: [section("1101"), section("1611"), section("2", "repealed"), { ...section("1252a", "transferred"), historical: { versionLabel: "Former law" } }] },
  inaCrosswalk: [{ inaSection: "101", uscSection: "1101", localSection: "1101" }, { inaSection: "242A", uscSection: "1252a", localSection: "1252a" }],
  referencedUsc: { titles: [{ number: 18, name: "Crimes", sections: [{ id: "18-16", title: 18, section: "16", heading: "Crime of violence", body: [{ label: "a", text: "groupneedle external" }] }] }] },
  cfr: { sections: [{ id: "8:1.1", title: 8, section: "1.1", blocks: [{ t: "p", a: "(a)", x: "groupneedle regulation" }] }], appendices: [] }
};

(async () => {
  const projection = occurrence.buildProjection(corpus);
  const result = occurrence.search(projection, "groupneedle");
  assert.deepEqual(result.sections.map(s => s.recordId).sort(), ["18-16", "8-1101", "8-1252a", "8-1611", "8-2", "8:1.1"], "Search must include non-INA Title 8 and historical transferred text exactly once.");
  const asyncProjection = await occurrence.buildProjectionAsync(corpus, { sliceMs: 0, yieldControl: () => Promise.resolve() });
  assert.deepEqual(asyncProjection.fragments, projection.fragments, "Worker and direct search must index the same full Title 8 text.");
  assert.deepEqual(occurrence.search(projection, "groupneedle", { authorities: "ina" }).sections.map(s => s.recordId), ["8-1101", "8-1252a"], "An explicit INA scope must exclude non-INA Title 8.");

  const records = [...corpus.title8.sections, ...corpus.referencedUsc.titles.flatMap(t => t.sections)];
  const hierarchy = new Map([
    ["usc:root", { id: "usc:root", kind: "authority", authority: "usc", children: ["usc:title:8", "usc:title:18"] }],
    ["usc:title:8", { id: "usc:title:8", kind: "title", number: "8", authority: "usc", parentId: "usc:root", children: ["usc:chapter:12"] }],
    ["usc:chapter:12", { id: "usc:chapter:12", kind: "chapter", number: "12", authority: "usc", parentId: "usc:title:8", children: corpus.title8.sections.map(s => `usc:section:${s.id}`) }],
    ["usc:title:18", { id: "usc:title:18", kind: "title", number: "18", authority: "usc", parentId: "usc:root", children: ["usc:section:18-16"] }]
  ]);
  for (const record of records) hierarchy.set(`usc:section:${record.id}`, { id: `usc:section:${record.id}`, kind: "section", number: record.section, authority: "usc", heading: record.heading, parentId: Number(record.title || 8) === 8 ? "usc:chapter:12" : "usc:title:18", children: [] });
  const state = { statuteHierarchyAuthority: "ina", citation: {}, hierarchyExpanded: new Set(["usc:chapter:12", "cfr:title:8"]) };
  const context = vm.createContext({ state, corpus, authorityHierarchyNodes: hierarchy, uscSectionById: new Map(records.map(s => [s.id, s])),
    uscBase: record => `${record.title || 8} U.S.C. ${record.section}`, escapeHtml: String,
    emptyOccurrenceResult: () => ({ sections: [], hierarchy: [], totalOccurrences: 0 }),
    hierarchyPageNodeIds: () => ["usc:chapter:12"], refreshHierarchyRows() {} });
  for (const name of ["namespaceOccurrenceResult", "combineAuthorityOccurrenceResults", "occurrenceDisplayGroups", "occurrenceResultStatus", "hierarchyActionRowIds", "hierarchyExpandableNodeIds", "handleHierarchyPageActions"]) vm.runInContext(functionSource(template, name), context);
  const combined = context.combineAuthorityOccurrenceResults([{ authority: "ina", result: occurrence.search(projection, "groupneedle", { authorities: "statute" }) }, { authority: "cfr", result: occurrence.search(projection, "groupneedle", { authorities: "cfr" }) }]);
  const display = () => JSON.parse(JSON.stringify(context.occurrenceDisplayGroups(combined)));
  let groups = display();
  assert.deepEqual(groups.map(g => g.authority), ["ina", "non-ina-title8", "cfr", "referenced-usc"]);
  assert.deepEqual(groups.map(g => g.result.totalOccurrences), [2, 2, 1, 1], "Group totals must describe only the sections in each group.");
  assert.deepEqual(groups[1].result.sections.map(s => s.recordId), ["8-1611", "8-2"], "Non-INA Title 8 needs its own section before CFR in INA mode.");
  assert.deepEqual(groups[3].result.sections.map(s => s.recordId), ["18-16"], "The final group must contain only non-Title 8 Code provisions.");
  assert.equal(groups[0].result.sections[1].citation, "INA 242A");
  state.statuteHierarchyAuthority = "usc";
  groups = display();
  assert.deepEqual(groups.map(g => g.authority), ["title8", "cfr", "referenced-usc"]);
  assert.deepEqual(groups.map(g => g.result.totalOccurrences), [4, 1, 1]);
  assert.deepEqual(groups[0].result.sections.map(s => s.citation), ["8 U.S.C. 1101", "8 U.S.C. 1252a", "8 U.S.C. 1611", "8 U.S.C. 2"]);
  assert(groups[0].result.hierarchy.some(n => n.kind === "chapter" && n.number === "12" && n.totalOccurrences === 4), "Title 8 mode must use the U.S. Code hierarchy and correct aggregate counts.");
  assert.equal(combined.sections[0].citation, "INA 101", "View changes must preserve the stored source result.");
  assert.deepEqual(groups.flatMap(g => g.result.sections.map(s => s.id)).sort(), combined.sections.map(s => s.id).sort(), "Regrouping must preserve navigation and lazy row identities.");
  assert.equal(context.occurrenceResultStatus({ recordId: "8-2", authority: "usc" }), "repealed");
  assert.equal(context.occurrenceResultStatus({ recordId: "8-1252a", authority: "ina" }), "transferred");
  assert.equal(context.occurrenceResultStatus({ recordId: "18-16", authority: "usc" }), "current");

  const duplicateProjection = occurrence.buildProjection({ ...corpus, inaCrosswalk: [...corpus.inaCrosswalk, { inaSection: "102", uscSection: "1101", localSection: "1101" }] });
  const duplicateResult = context.combineAuthorityOccurrenceResults([{ authority: "ina", result: occurrence.search(duplicateProjection, "groupneedle", { authorities: "statute" }) }, { authority: "notes", result: { sections: [], hierarchy: [], totalOccurrences: 0 } }]);
  state.statuteHierarchyAuthority = "ina";
  const duplicateGroups = context.occurrenceDisplayGroups(duplicateResult);
  assert.deepEqual(Array.from(duplicateGroups, group => group.authority), ["ina", "non-ina-title8", "referenced-usc"], "Empty notes must not add another search section.");
  assert.equal(duplicateGroups[0].result.totalOccurrences, 2, "Multiple INA mappings must not count the same passage twice.");
  const duplicateRoot = duplicateGroups[0].result.hierarchy.find(node => node.kind === "authority");
  assert.equal(duplicateRoot.totalOccurrences, 2, "Shared ancestors must count each matching passage once.");
  state.statuteHierarchyAuthority = "usc";
  assert.equal(context.occurrenceDisplayGroups(duplicateResult)[0].result.sections.length, 4, "Code view must show a shared Code section once.");

  let actionSyncs = 0;
  const renderContext = vm.createContext({ state: { mainOccurrencePane: null }, profile: { preferences: { expandSearchResultsByDefault: false } }, OCCURRENCE_EAGER_ROW_LIMIT: 200,
    endShareViewPreview() {}, occurrenceDisplayGroups: context.occurrenceDisplayGroups, occurrenceAuthorityStreamHtml: () => "", consumePromotedHistoryRestore() {}, consumeFocusedPaneHistoryRestore() {}, syncMainReaderActionTarget() { actionSyncs += 1; } });
  vm.runInContext(functionSource(template, "renderOccurrenceSearchResult"), renderContext);
  const pane = { element: { isConnected: true }, entry: { text: "groupneedle" }, detail: {} };
  renderContext.state.mainOccurrencePane = pane;
  renderContext.renderOccurrenceSearchResult(pane, combined);
  assert.equal(actionSyncs, 1, "The first search render must update its copy controls after search state exists.");

  const displayedId = context.occurrenceDisplayGroups(duplicateResult)[0].result.sections.find(section => section.recordId === "8-1101").id;
  const aliasId = duplicateResult.sections.find(section => section.recordId === "8-1101" && section.id !== displayedId).id;
  let restoredId;
  let restoredButtonFocused = false;
  const restoredElement = { scrollIntoView() {}, querySelector(selector) { assert.equal(selector, '[data-occurrence-open]'); return { focus() { restoredButtonFocused = true; } }; } };
  const restoredContainer = { closest: () => null };
  const restorePane = { detail: { isConnected: true }, searchState: { result: duplicateResult, rowsBySection: new Map() } };
  const restoreContext = vm.createContext({ occurrenceDisplayGroups: context.occurrenceDisplayGroups, occurrenceSectionById: (result, id) => result.sections.find(section => section.id === id),
    occurrenceSectionRowsContainer: (_pane, id) => id === displayedId ? restoredContainer : null,
    async renderOccurrenceRows(_pane, _offset, id) { restoredId = id; },
    $: (_selector, container) => { assert(container, "History must not query a missing alias container."); return restoredElement; },
    selectOccurrenceRow() {}, scheduleVisibleOccurrenceSections() {} });
  vm.runInContext(functionSource(template, "restoreOccurrenceResult"), restoreContext);
  assert.equal(await restoreContext.restoreOccurrenceResult(restorePane, { sectionId: aliasId, index: 0 }), true);
  assert.equal(restoredId, displayedId, "History must restore an INA alias through its displayed Code section.");
  assert(restoredButtonFocused, "History must restore keyboard focus to the result's opening button.");

  const click = expand => ({ target: { closest: () => ({ hasAttribute: () => expand, dataset: expand ? { hierarchyExpandAll: "referenced-usc" } : { hierarchyCollapseAll: "referenced-usc" }, isConnected: true }) } });
  context.handleHierarchyPageActions(click(true));
  assert(state.hierarchyExpanded.has("usc:title:18"), "Referenced U.S. Code must expand independently.");
  context.handleHierarchyPageActions(click(false));
  assert(!state.hierarchyExpanded.has("usc:title:18"));
  assert(state.hierarchyExpanded.has("usc:chapter:12") && state.hierarchyExpanded.has("cfr:title:8"), "Referenced U.S. Code controls must preserve INA/Title 8 and CFR expansion.");
  console.log("PASS search groups: full Title 8, view-specific grouping, historical status and independent contents controls");
})().catch(error => { console.error(error); process.exitCode = 1; });
