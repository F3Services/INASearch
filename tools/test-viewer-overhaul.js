#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "src", "INASearch.template.html"), "utf8");
const buildSource = fs.readFileSync(path.join(root, "tools", "build-standalone.js"), "utf8");
const command = require(path.join(root, "src", "INASearch-Command"));

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignedObject(fileName, propertyName) {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", fileName), "utf8"), context, { filename: fileName });
  return plain(context.window[propertyName]);
}

function between(startMarker, endMarker, source = template) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `Could not extract source between ${startMarker} and ${endMarker}.`);
  return source.slice(start, end);
}

function extractedFunction(name, _nextName, context = {}) {
  const source = require("./test-function-source")(template, name);
  return vm.runInNewContext(`(${source})`, { Array, Boolean, Date, JSON, Map, Math, Number, Object, Set, String, ...context });
}

function count(source, expression) {
  return (source.match(expression) || []).length;
}

function testRuntimeBlocks() {
  const runtimes = [
    ["INSERTIONS", "inaSearchInsertionsRuntime", "INASearch-Insertions.js", "INA_SEARCH_INSERTIONS"],
    ["ANNOTATIONS", "inaSearchAnnotationsRuntime", "INASearch-Annotations.js", "INA_SEARCH_ANNOTATIONS"],
    ["COMMAND", "inaSearchCommandRuntime", "INASearch-Command.js", "INA_SEARCH_COMMAND"],
    ["WORKSPACE", "inaSearchWorkspaceRuntime", "INASearch-Workspace.js", "INA_SEARCH_WORKSPACE"],
    ["OCCURRENCE", "inaSearchOccurrenceRuntime", "INASearch-Occurrence.js", "INA_SEARCH_OCCURRENCE"],
    ["QUERY", "inaSearchQueryRuntime", "INASearch-Query.js", "INA_SEARCH_QUERY"]
  ];
  let previousOffset = -1;
  for (const [name, id, fileName, globalName] of runtimes) {
    const start = `<!-- INA_SEARCH_${name}_RUNTIME_START -->`;
    const end = `<!-- INA_SEARCH_${name}_RUNTIME_END -->`;
    assert.strictEqual(count(template, new RegExp(start, "g")), 1, `${name} has an ambiguous runtime start block.`);
    assert.strictEqual(count(template, new RegExp(end, "g")), 1, `${name} has an ambiguous runtime end block.`);
    assert(template.includes(`<script id="${id}"></script>`), `${name} has no inert template script target.`);
    assert(template.indexOf(start) > previousOffset, `${name} is embedded out of dependency order.`);
    previousOffset = template.indexOf(start);
    assert(buildSource.includes(`replaceRuntimeBlock(template, "${name}", "${id}", fs.readFileSync(path.join(sourceDir, "${fileName}"), "utf8"))`), `${name} is not embedded by the standalone builder.`);
    assert(template.includes(`globalThis.${globalName}`) || template.includes(`window.${globalName}`), `${name} is embedded but unused by the viewer.`);
  }
  assert.strictEqual(typeof require(path.join(root, "src", "INASearch-Insertions")).ReferenceInsertionSession, "function");
  assert.strictEqual(typeof require(path.join(root, "src", "INASearch-Workspace")).blankWorkspaceSpec, "function");
  assert.strictEqual(typeof require(path.join(root, "src", "INASearch-Occurrence")).createSearchSession, "function");
  assert(template.includes('id="inaSearchSearchWorkerRuntime" type="text/plain"'), "The search worker is not embedded as inert standalone source.");
  assert(buildSource.includes('replaceInertRuntimeBlock(template, "SEARCH_WORKER", "inaSearchSearchWorkerRuntime"'), "The standalone builder does not embed the search worker.");
  assert(template.includes("worker-src blob:"), "The standalone CSP does not allow its embedded Blob worker.");
}

function testProfileContracts() {
  const profile = assignedObject("INASearch-Profile.js", "INA_SEARCH_PROFILE");
  assert.strictEqual(profile.schemaVersion, 5, "The simplified annotation system did not publish profile schema version 5.");
  assert.deepStrictEqual(profile.highlights, []);
  assert.deepStrictEqual(profile.annotationOrdinals, {});
  assert.strictEqual(profile.preferences.noteDisplayPosition, undefined);
  assert.strictEqual(profile.preferences.notesUseHandwrittenFont, false);
  assert.deepStrictEqual(plain({
    statutoryNavigationSystem: profile.preferences.statutoryNavigationSystem,
    splitAuthoritySearchPanes: profile.preferences.splitAuthoritySearchPanes,
    legalNavigatorVisibility: profile.preferences.legalNavigatorVisibility,
    scrollUpdatesSearch: profile.preferences.scrollUpdatesSearch,
    pageViewOffsetPercent: profile.preferences.pageViewOffsetPercent,
    mainNavigatorCollapsed: profile.preferences.mainNavigatorCollapsed,
    expandSearchResultsByDefault: profile.preferences.expandSearchResultsByDefault,
    showCfrChapterSubchapterInSearchHierarchy: profile.preferences.showCfrChapterSubchapterInSearchHierarchy,
    syncCfrCommonDepthFromStatute: profile.preferences.syncCfrCommonDepthFromStatute,
    persistInlineReferenceInsertions: profile.preferences.persistInlineReferenceInsertions,
    hideLocalShareWarning: profile.preferences.hideLocalShareWarning
  }), {
    statutoryNavigationSystem: "ina",
    splitAuthoritySearchPanes: false,
    legalNavigatorVisibility: "single",
    scrollUpdatesSearch: false,
    pageViewOffsetPercent: 3,
    mainNavigatorCollapsed: false,
    expandSearchResultsByDefault: true,
    showCfrChapterSubchapterInSearchHierarchy: false,
    syncCfrCommonDepthFromStatute: true,
    persistInlineReferenceInsertions: false,
    hideLocalShareWarning: false
  });
  assert.strictEqual(Object.hasOwn(profile.preferences, "navigationUpdatesSearch"), false, "The retired explicit-navigation preference remains public.");
  assert.deepStrictEqual(profile.referenceInsertions, { schemaVersion: 1, records: [] });

  for (const id of [
    "splitAuthoritySearchPanesToggle", "legalNavigatorVisibilitySelect",
    "scrollUpdatesSearchToggle", "syncCfrCommonDepthFromStatuteToggle", "expandSearchResultsByDefaultToggle", "showCfrChapterSubchapterInSearchHierarchyToggle", "persistInlineReferenceInsertionsToggle",
    "referenceInsertionsUnavailableCount", "removeUnavailableReferenceInsertionsButton", "statuteNavigationDepthSelect", "cfrNavigationDepthSelect", "pageViewOffsetInput",
    "notesUseHandwrittenFontToggle"
  ]) assert(template.includes(`id="${id}"`), `Missing overhaul setting control ${id}.`);
  for (const key of ["emptySearchView", "closeBlankCompanionOnSectionOpen"]) {
    assert(!Object.hasOwn(profile.preferences, key), `Retired home preference ${key} remains in blank profiles.`);
    assert(!template.includes(`normalized.preferences.${key} =`), `Retired preference ${key} is revived on import.`);
  }
  assert(!template.includes('id="emptySearchViewSelect"') && !template.includes('id="closeBlankCompanionOnSectionOpenToggle"'), "Retired home settings remain visible.");
  assert(template.includes("normalized.preferences.splitAuthoritySearchPanes = normalized.preferences.splitAuthoritySearchPanes === true;"), "Profile normalization does not preserve an explicit split-search opt-in while defaulting omitted values off.");
  assert(template.includes('Object.hasOwn(defaults.preferences, key)'), "Unknown/retired preferences are not removed during profile normalization.");
  assert(template.includes("--search-hit: #ffd866") && template.includes("--search-hit-ink: #241a00")
    && template.includes(".occurrence-row-text mark { border-radius: 2px; padding: 0 1px; color: var(--search-hit-ink); background: var(--search-hit); }"), "Search-hit highlighting does not use an explicit contrasting foreground/background pair.");
}

function occurrenceRoutingHarness(state, classification, { citation = null, splitAuthoritySearchPanes = false } = {}) {
  const events = [];
  const tryRunOccurrenceSearch = extractedFunction("tryRunOccurrenceSearch", "runSearch", {
    state,
    profile: { preferences: { splitAuthoritySearchPanes } },
    parseCitation: () => citation,
    INA_SEARCH_COMMAND: { classifyInput: () => ({ ...classification, ok: classification.status === "valid" }) },
    resolveStructuredQuery: ast => ({ branches: ast.branches.map(b => ({ ...b, scopes: b.locations.map(l => ({ family: /cfr/i.test(l) ? "cfr" : "usc" })) })) }),
    structuredSearchGroups: extractedFunction("structuredSearchGroups", "renderStructuredSearchPane"),
    commandCitationClassifier: () => ({ valid: false }),
    showSearchResults: () => events.push(["show"]),
    dualOccurrenceWorkspace: (query, ast) => ({ kind: "dual", query, ast }),
    enterFocusedCitationMode: workspace => events.push(["dual", workspace]),
    renderMainCommonSearchControl: context => events.push(["common", context]),
    commandWithoutCommonModifiers: value => value,
    checkTutorialPractice: () => events.push(["tutorial"]),
    exitFocusedCitationMode: () => events.push(["exit"]),
    mainOccurrencePane: (descriptor, scope) => ({ kind: "single", descriptor, scope }),
    renderMainOccurrencePane: pane => { events.push(["single", pane]); },
    legalAuthoritiesForAst: ast => ast.scope ? ast.scope.authorities || [ast.scope.authority].filter(Boolean) : ["statute", "cfr"],
    artifactKindsForAst: () => [],
    renderCitationFeedback: () => {},
    renderAuthorityBrowseHeader: () => {},
    els: { searchWorkspace: { classList: { remove() {} } } }
  });
  return { accepted: tryRunOccurrenceSearch(), events };
}

function testOccurrenceRouting() {
  const dualAst = command.parseCommand("the term");
  const classify = ast => ({ mode: "search", status: "valid", ast });
  const combined = occurrenceRoutingHarness({ query: "the term" }, classify(dualAst));
  const combinedEvent = combined.events.find(event => event[0] === "single")?.[1];
  assert.strictEqual(combined.accepted, true);
  assert.strictEqual(combinedEvent?.descriptor?.authority, "combined");
  assert.deepStrictEqual(plain(combinedEvent?.descriptor?.authorities), ["statute", "cfr"]);
  assert(!combined.events.some(event => event[0] === "dual"));
  assert.strictEqual(combined.events.find(event => event[0] === "common")?.[1]?.mode, "stream");
  const split = occurrenceRoutingHarness({ query: "the term" }, classify(dualAst), { splitAuthoritySearchPanes: true });
  assert.strictEqual(split.events.filter(event => event[0] === "dual").length, 1);
  assert.deepStrictEqual(plain(split.events.find(event => event[0] === "dual")[1].entries.map(e => e.queryGroup)), ["ina", "cfr", "notes"]);
  for (const input of ['in:CFR "the term"', 'in:237 cites:212', 'cites:212 in:237']) {
    const scoped = occurrenceRoutingHarness({ query: input, focusedCitationMode: true }, classify(command.parseCommand(input)));
    const pane = scoped.events.find(event => event[0] === "single")?.[1];
    assert.strictEqual(scoped.accepted, true);
    assert.deepStrictEqual(plain(pane.descriptor.ast.scopeGroups), command.parseCommand(input).scopeGroups);
    assert.deepStrictEqual(plain(pane.descriptor.ast.citationGroups), command.parseCommand(input).citationGroups);
    assert(scoped.events.some(event => event[0] === "exit"));
  }
  const citationPrefix = occurrenceRoutingHarness({ query: "INA 212" }, { mode: "navigation-prefix" });
  assert.strictEqual(citationPrefix.accepted, false);

  const runSearchSource = between("    function runSearch(", "\n\n    function shouldDeferBroadSearch(");
  assert(runSearchSource.indexOf("parseLegalWorkspaceInput") < runSearchSource.indexOf("tryRunOccurrenceSearch"), "Legal pane expressions are not routed before ordinary search.");
  assert(runSearchSource.includes("if (tryRunOccurrenceSearch()) return"), "Ordinary text is not routed through occurrence search.");
}

function testCommonControls() {
  const commandWithoutCommonModifiers = extractedFunction("commandWithoutCommonModifiers", "commandWithCommonLevels", { INA_SEARCH_COMMAND: command });
  const commandWithCommonLevels = extractedFunction("commandWithCommonLevels", "renderMainCommonSearchControl", { INA_SEARCH_COMMAND: command, commandWithoutCommonModifiers });
  assert.strictEqual(commandWithoutCommonModifiers('common:subsection in:INA "common:CFR"'), 'in:INA "common:CFR"', "Quoted Common text was stripped as a modifier.");
  assert.strictEqual(commandWithCommonLevels('in:INA common:section "common:CFR"', ["statute"], { statute: "subsection" }), 'common:subsection in:INA "common:CFR"');

  assert(template.includes('id="mainCommonSearchControl"') && template.includes('id="mainCommonStatuteRow"') && template.includes('id="mainCommonCfrRow"'), "The main Common controls are absent.");
  assert(template.includes('class="statute-nav-depth-handle" id="mainCommonSearchSummary"')
    && template.includes('class="focused-pane-common" hidden><summary class="statute-nav-depth-handle"'), "Common controls do not reuse the classic depth-handle icon.");
  const commonChoiceSource = between("    function commonChoiceButtons(", "\n\n    function commandWithoutCommonModifiers(");
  assert(commonChoiceSource.includes('role="menuitemradio"') && commonChoiceSource.includes('data-common-authority=') && commonChoiceSource.includes('data-common-level='), "Common controls do not expose their choices directly.");
  const focusedCommonRenderSource = between("    function renderFocusedPaneCommonControl(", "\n\n    function paneHierarchyRows(");
  assert(!focusedCommonRenderSource.includes("<select") && focusedCommonRenderSource.includes("commonChoiceButtons(authority, level)"), "A child Common menu still nests a select inside its trigger menu.");
  assert(template.includes('.global-search { display: flex; grid-column: 2; min-width: 0; align-items: center; gap: 8px; margin-top: 0;')
    && template.includes('id="mainShareButton"')
    && template.includes('.main-share-button { position: relative; display: grid; width: 38px; height: 29px;')
    && template.includes('class="main-share-icon"')
    && template.includes('id="mainShareLocalWarning"')
    && !template.includes('id="mainNavigationDepthControls"'), "The search row does not use the compact icon-only share control in place of the retired depth controls.");
  assert(template.includes('id="statuteNavigationDepthSelect"') && template.includes('id="cfrNavigationDepthSelect"')
    && template.includes('function syncNavigationDepthSettings()'), "The smallest-unit preferences were not moved into Settings.");
  assert(template.includes("syncAcrossAuthorities: profile.preferences.syncCfrCommonDepthFromStatute !== false"), "The main dual Common selector ignores its synchronization preference.");
  assert(template.includes("syncAcrossAuthorities: false"), "A single child Common selection can incorrectly drive another authority.");

  const synchronized = command.applyCommonSelection({ statute: "section", cfr: "section" }, "statute", "subsubitem", { authorities: ["statute", "cfr"], syncCfrFromStatute: true });
  assert.deepStrictEqual(plain(synchronized.levels), { statute: "subsubitem", cfr: "paragraph-6" });
  assert(synchronized.adjustments.some(adjustment => adjustment.clamped), "Statute-to-CFR Common clamping is not exposed to the UI.");
  const cfrOnlyChange = command.applyCommonSelection(synchronized.levels, "cfr", "paragraph-2", { authorities: ["statute", "cfr"], syncAcrossAuthorities: true });
  assert.strictEqual(cfrOnlyChange.levels.statute, "paragraph", "A CFR Common change did not drive the statute selector to the analogous level.");

  const childCommonSource = between("    function setFocusedPaneCommonLevel(", "\n\n    function renderFocusedCitationPane(");
  assert(childCommonSource.includes('state.focusedWorkspaceOrigin === "dual-search"')
    && childCommonSource.includes("candidate.sharedQuery === state.focusedWorkspaceSymmetricQuery")
    && childCommonSource.includes("return setMainCommonLevel(authority, level)"), "A child Common change in a symmetric dual search does not use the atomic one-way synchronization path.");
  assert(childCommonSource.includes("syncAcrossAuthorities: false"), "A diverged/single child Common change can incorrectly drive another authority.");
}

function testChildHardScopes() {
  const resolveStructuredQuery = extractedFunction("resolveStructuredQuery", "structuredSearchGroups", { INA_SEARCH_QUERY: require("../src/INASearch-Query"), parseSearchScope: value => ({ valid: true, family: /cfr/i.test(value) ? "cfr" : "usc", label: value, sectionIds: new Set(["one"]), pathsBySection: new Map() }) });
  const focusedPaneDescriptor = extractedFunction("focusedPaneDescriptor", "parseLegalWorkspaceInput", {
    INA_SEARCH_COMMAND: command, parseCitation: () => null, authorityForCitationResult: () => null,
    focusedCitationRecord: () => null, isAuthorityBrowse: () => false, citationInputCanContinue: () => false,
    resolveStructuredQuery, commandCitationClassifier: () => ({ valid: false })
  });
  for (const input of ['in:237 cites:212', 'cites:212 in:237', 'in:INA 101 "term"']) {
    const descriptor = focusedPaneDescriptor(input, { child: true, childAuthority: "cfr", requireAuthority: true });
    assert.strictEqual(descriptor.ok, true);
    assert.deepStrictEqual(plain(descriptor.ast.scopeGroups), command.parseCommand(input).scopeGroups);
    assert.deepStrictEqual(plain(descriptor.ast.citationGroups), command.parseCommand(input).citationGroups);
  }
  const paneSource = between("    async function renderFocusedOccurrencePane(", "\n\n    function occurrenceReaderTarget(");
  assert(paneSource.includes("renderStructuredSearchPane(pane)"), "Pane and main queries must share execution.");
  const expressionSource = between("    function focusedWorkspaceExpression(", "\n\n    function syncFocusedWorkspaceExpression(");
  assert(expressionSource.includes("!pane.entry.ast?.queryVersion"));

}

async function testSectionMaterializationHooks() {
  const calls = [];
  const focusedDocument = { activeElement: null };
  const sectionIds = ["cfr:8:204.1", "cfr:8:204.2"];
  const containers = sectionIds.map(sectionId => ({ dataset: { occurrenceSectionRows: encodeURIComponent(sectionId) }, innerHTML: "", setAttribute() {}, removeAttribute() {} }));
  containers.forEach(container => { container.contains = element => element?.container === container; });
  const firstButtons = containers.map(container => ({ container, focus() { focusedDocument.activeElement = this; }, scrollIntoView() {} }));
  const lastButtons = containers.map(container => ({ container, focus() { focusedDocument.activeElement = this; }, scrollIntoView() {} }));
  const details = sectionIds.map(sectionId => ({ dataset: { occurrenceSection: encodeURIComponent(sectionId) }, open: false }));
  details.forEach((detail, index) => { detail.querySelector = () => containers[index]; });
  containers.forEach((container, index) => { container.closest = () => details[index]; });
  const $$ = (selector, container) => ['[data-occurrence-open]', '[data-occurrence-row] button:not(:disabled)'].includes(selector) ? container.tabControls || [firstButtons[containers.indexOf(container)], lastButtons[containers.indexOf(container)]]
    : selector === 'button:not(:disabled)' ? container.controls
    : selector === "[data-occurrence-section-rows]" ? containers : selector === "[data-occurrence-section]" ? details : [];
  const declarations = between("    const OCCURRENCE_EAGER_ROW_LIMIT", "\n\n    function scheduleVisibleOccurrenceSections(");
  const unitCorpus = { title8: { sections: [{ id: "8-1101" }] }, cfr: { sections: [], appendices: [] } };
  const helpers = vm.runInNewContext(`${declarations}\n({ occurrenceRowCitationLabel, occurrenceRowUnitText, renderOccurrenceRows, renderAllOccurrenceSections, showOccurrencePage, handleOccurrenceResultTab: typeof handleOccurrenceResultTab === 'function' ? handleOccurrenceResultTab : null })`, {
    legalCopyDescription: label => label, scheduleVisibleOccurrenceSections: () => {},
    $$, $: (selector, container) => selector === '[data-occurrence-open]' ? firstButtons[containers.indexOf(container)] : null,
    document: focusedDocument,
    corpus: unitCorpus,
    uscSectionById: new Map(unitCorpus.title8.sections.map(section => [section.id, section])),
    escapeHtml: value => String(value),
    occurrenceSectionDomToken: encodeURIComponent,
    occurrenceSectionIdFromToken: decodeURIComponent,
    occurrenceRowTextHtml: () => "snippet",
    occurrenceResultStatus: () => "current",
    statuteUnitText: (_section, path) => `Complete statute unit ${path.join("/")}`,
    cfrUnitText: () => "", cfrBlockPlainText: block => String(block?.x || ""),
    componentTokens: () => [], pathStartsWith: () => false, cfrBlockUnitPaths: () => [],
    copyLegalText: async () => true, toast: () => {}
  });
  assert.strictEqual(helpers.occurrenceRowCitationLabel({ citation: "INA 101(a)(6)" }), "(a)(6)", "A result row retained its redundant INA section prefix.");
  assert.strictEqual(helpers.occurrenceRowCitationLabel({ citation: "8 CFR 204.2(c)(1)" }), "(c)(1)", "A result row retained its redundant CFR section prefix.");
  assert.strictEqual(helpers.occurrenceRowCitationLabel({ citation: "8 U.S.C. 1101", kind: "statute-section-heading" }), "Heading", "A section-heading hit has no useful within-section label.");
  assert.strictEqual(helpers.occurrenceRowUnitText({ authority: "ina", recordId: "8-1101", path: ["a", "6"] }), "Complete statute unit a/6", "Result text copying does not resolve the complete cited unit from the corpus.");
  const result = {
    totalOccurrences: 240,
    sections: sectionIds.map(id => ({ id, totalOccurrences: 120 })),
    materializeOccurrences(options) {
      calls.push(options);
      const returned = Math.min(options.limit, 120 - options.start);
      return { total: 120, returned, rows: Array.from({ length: returned }, (_, index) => ({ citation: `8 CFR hit ${options.start + index}` })) };
    }
  };
  const pane = { detail: {}, searchState: { result, offset: 0, activeSectionId: sectionIds[0], sectionOffsets: new Map(), rowsBySection: new Map(), visibleRows: [], virtualizedRows: true } };
  await Promise.all([
    helpers.renderOccurrenceRows(pane, 0, sectionIds[0], { windowed: true, limit: 80 }),
    helpers.renderOccurrenceRows(pane, 0, sectionIds[1], { windowed: true, limit: 80, activate: false })
  ]);
  assert.deepStrictEqual(plain(calls[0]), { sectionId: sectionIds[0], start: 0, limit: 80, contextCharacters: 60 }, "A large section did not use a bounded viewport window.");
  assert.strictEqual(pane.searchState.visibleRows.length, 160, "Nearby section windows cannot remain populated together.");
  assert.strictEqual(count(containers[0].innerHTML, /data-occurrence-row=/g), 80, "The first nearby section was evicted when another section populated.");
  assert.strictEqual(count(containers[1].innerHTML, /data-occurrence-row=/g), 80, "The second nearby section did not populate.");
  assert(containers[0].innerHTML.includes("occurrence-row-citation") && containers[0].innerHTML.includes("occurrence-row-text"), "Occurrence hits are not rendered as citation/text columns.");
  assert(containers[0].innerHTML.includes('role="list"') && containers[0].innerHTML.includes('role="listitem"'), "Search hits must expose a list with separately operable controls.");
  assert(!containers[0].innerHTML.includes('role="option"') && !/role="listitem"[^>]*tabindex="0"/.test(containers[0].innerHTML), "Each hit still adds a duplicate composite-widget tab stop.");
  assert(containers[0].innerHTML.includes('aria-describedby=') && containers[0].innerHTML.includes('aria-posinset="1"') && containers[0].innerHTML.includes('aria-setsize="120"'), "A hit does not expose its snippet and position in the complete section.");
  assert(containers[0].innerHTML.includes('data-occurrence-page="80"'), "The unrendered hits cannot be reached through an explicit Next results action.");
  assert(details.every(item => item.open), "Materializing rows did not leave both sections expanded.");

  const searchInput = { matches: selector => selector === '#searchInput, .focused-citation-pane-search', closest: () => null };
  pane.input = searchInput;
  focusedDocument.activeElement = searchInput;
  let enteredDirectly = false;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: searchInput, preventDefault() { enteredDirectly = true; } });
  assert(enteredDirectly && focusedDocument.activeElement === firstButtons[0], "One Tab from the search input must focus the first actual hit, not a toolbar or hierarchy header.");

  const immediateMaterialize = result.materializeOccurrences;
  let completeOldEntry;
  result.materializeOccurrences = options => new Promise(resolve => { completeOldEntry = () => resolve(immediateMaterialize(options)); });
  focusedDocument.activeElement = searchInput;
  const outdatedEntry = helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: searchInput, preventDefault() {} });
  pane.occurrenceGeneration = (pane.occurrenceGeneration || 0) + 1;
  completeOldEntry();
  await outdatedEntry;
  assert(focusedDocument.activeElement === searchInput, "An old Tab-entry response interrupted input editing after the search generation changed.");
  result.materializeOccurrences = immediateMaterialize;
  let usedOldResults = false;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: searchInput, preventDefault() { usedOldResults = true; } });
  assert(!usedOldResults && focusedDocument.activeElement === searchInput, "Tab entered retained results while a replacement search was still loading.");
  pane.searchState.generation = pane.occurrenceGeneration;

  await helpers.renderOccurrenceRows(pane, 80, sectionIds[0], { windowed: true, paged: true, limit: 80 });
  assert.strictEqual(calls.at(-1).start, 80, "Next results shifted backward instead of reaching the remaining hits.");
  assert.strictEqual(count(containers[0].innerHTML, /data-occurrence-row=/g), 40, "The final page lost or repeated the section's remaining hits.");
  assert(containers[0].innerHTML.includes('aria-posinset="81"') && containers[0].innerHTML.includes('Results 81–120 of 120'), "The final page does not describe its actual range.");
  assert(/data-occurrence-page="120" disabled/.test(containers[0].innerHTML), "Next results remains enabled after the final hit.");

  const materialize = result.materializeOccurrences;
  let finishPage;
  result.materializeOccurrences = options => new Promise(resolve => { finishPage = () => resolve(materialize(options)); });
  const focusedMarkup = containers[0].innerHTML;
  const automaticPage = helpers.renderOccurrenceRows(pane, 0, sectionIds[0], { windowed: true, activate: false });
  focusedDocument.activeElement = firstButtons[0];
  finishPage();
  await automaticPage;
  assert(containers[0].innerHTML === focusedMarkup, "A pending automatic page removed a control after keyboard focus entered its section.");

  const nextButton = { container: containers[0], dataset: { occurrencePage: "80" }, closest: () => containers[0] };
  focusedDocument.activeElement = nextButton;
  const explicitPage = helpers.showOccurrencePage(pane, nextButton);
  const outsideControl = {};
  focusedDocument.activeElement = outsideControl;
  finishPage();
  await explicitPage;
  assert(focusedDocument.activeElement === outsideControl, "A pending Next results response stole focus after the user left the section.");
  focusedDocument.activeElement = nextButton;
  const focusedPage = helpers.showOccurrencePage(pane, nextButton);
  finishPage();
  await focusedPage;
  assert(focusedDocument.activeElement === firstButtons[0], "Next results did not place keyboard focus on its newly rendered first hit.");
  result.materializeOccurrences = materialize;
  focusedDocument.activeElement = null;

  // Native Tab must enter a section even when its worker response is delayed.
  pane.searchState.rowsBySection.delete(sectionIds[1]);
  containers[1].innerHTML = "";
  details[1].querySelector = () => containers[1];
  const header = { matches: selector => selector === '[data-occurrence-section-open]', closest: () => details[1] };
  focusedDocument.activeElement = header;
  result.materializeOccurrences = options => new Promise(resolve => { finishPage = () => resolve(materialize(options)); });
  let prevented = false;
  const entering = helpers.handleOccurrenceResultTab?.(pane, { key: 'Tab', shiftKey: false, target: header, preventDefault() { prevented = true; } });
  assert(prevented, "Tab skipped the hits in an unloaded section instead of waiting to enter them.");
  finishPage();
  await entering;
  assert(focusedDocument.activeElement === firstButtons[1], "Tab from the header did not focus the first loaded hit.");

  pane.searchState.rowsBySection.delete(sectionIds[1]);
  focusedDocument.activeElement = header;
  const canceledEntry = helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: header, preventDefault() {} });
  focusedDocument.activeElement = outsideControl;
  finishPage();
  await canceledEntry;
  assert(focusedDocument.activeElement === outsideControl, "Delayed keyboard entry stole focus after the user left.");
  result.materializeOccurrences = materialize;

  const edgeRow = { dataset: { occurrenceRow: '79' } };
  const edgeButton = { matches: selector => ['[data-occurrence-open]', '[data-occurrence-open], [data-artifact-repair], [data-artifact-delete]'].includes(selector), closest: selector => selector === '[data-occurrence-row]' ? edgeRow : details[0], focus() { focusedDocument.activeElement = this; }, scrollIntoView() {} };
  edgeRow.controls = [edgeButton];
  focusedDocument.activeElement = edgeButton;
  await helpers.renderOccurrenceRows(pane, 0, sectionIds[0]);
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: edgeButton, preventDefault() {} });
  assert.equal(pane.searchState.rowsBySection.get(sectionIds[0]).start, 80, "Tab left the section before reaching all its hits.");
  assert(focusedDocument.activeElement === firstButtons[0], "Tab across a page boundary did not focus the next hit.");
  edgeRow.dataset.occurrenceRow = '0';
  focusedDocument.activeElement = edgeButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: true, target: edgeButton, preventDefault() {} });
  assert.equal(pane.searchState.rowsBySection.get(sectionIds[0]).start, 0, "Shift+Tab did not reach the previous result page.");
  assert(focusedDocument.activeElement === lastButtons[0], "Shift+Tab across a page boundary did not focus the previous hit.");

  pane.searchState.rowsBySection.delete(sectionIds[0]);
  const summary = { matches: () => false, closest: () => details[1] };
  details[1].firstElementChild = summary;
  details[1].previousElementSibling = details[0];
  details[0].matches = () => true;
  focusedDocument.activeElement = summary;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: true, target: summary, preventDefault() {} });
  assert.equal(pane.searchState.rowsBySection.get(sectionIds[0]).start, 40, "Shift+Tab skipped an unloaded previous section instead of loading its final hits.");
  assert(focusedDocument.activeElement === lastButtons[0], "Backward entry did not focus the previous section's final hit.");

  await helpers.renderOccurrenceRows(pane, 40, sectionIds[0]);
  focusedDocument.activeElement = edgeButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: true, target: edgeButton, preventDefault() {} });
  const backwardWindow = pane.searchState.rowsBySection.get(sectionIds[0]);
  assert.equal(backwardWindow.start + backwardWindow.rows.length, 40, "Shift+Tab from an automatically positioned window jumped forward instead of to the immediately preceding hit.");

  await helpers.renderOccurrenceRows(pane, 40, sectionIds[1]);
  focusedDocument.activeElement = header;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: header, preventDefault() {} });
  assert.equal(pane.searchState.rowsBySection.get(sectionIds[1]).start, 0, "Tab from a section header skipped hits before an already loaded middle window.");

  await helpers.renderOccurrenceRows(pane, 0, sectionIds[0]);
  focusedDocument.activeElement = summary;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: true, target: summary, preventDefault() {} });
  const previousSectionEnd = pane.searchState.rowsBySection.get(sectionIds[0]);
  assert.equal(previousSectionEnd.start + previousSectionEnd.rows.length, 120, "Shift+Tab skipped the end of a previous section whose first page was already loaded.");

  await helpers.renderOccurrenceRows(pane, 0, sectionIds[0]);
  const beforeCanceledPage = containers[0].innerHTML;
  edgeRow.dataset.occurrenceRow = '79';
  focusedDocument.activeElement = edgeButton;
  result.materializeOccurrences = options => new Promise(resolve => { finishPage = () => resolve(materialize(options)); });
  const abandonedPage = helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: edgeButton, preventDefault() {} });
  focusedDocument.activeElement = firstButtons[0];
  finishPage();
  await abandonedPage;
  assert.equal(containers[0].innerHTML, beforeCanceledPage, "A pending keyboard page removed another hit that received focus in the same section.");
  result.materializeOccurrences = materialize;

  const repairButton = { ...edgeButton }, deleteButton = { ...edgeButton };
  edgeRow.controls = [edgeButton, repairButton, deleteButton];
  containers[0].tabControls = edgeRow.controls;
  focusedDocument.activeElement = edgeButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: edgeButton, preventDefault() {} });
  assert(focusedDocument.activeElement === repairButton, "Tab skipped the last hit's Repair control.");
  focusedDocument.activeElement = deleteButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: deleteButton, preventDefault() {} });
  assert.equal(pane.searchState.rowsBySection.get(sectionIds[0]).start, 80, "Tab after the last repair control did not continue to the next hit.");
  delete containers[0].tabControls;
  edgeRow.controls = [edgeButton];

  // An ordinary loaded hit must explicitly focus its successor too: some browsers
  // otherwise include summaries in sequential navigation while skipping buttons.
  containers[0].tabControls = [edgeButton, firstButtons[0]];
  focusedDocument.activeElement = edgeButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: edgeButton, preventDefault() {} });
  assert(focusedDocument.activeElement === firstButtons[0], "Tab delegated ordinary hit-to-hit focus back to the browser.");
  delete containers[0].tabControls;

  edgeRow.dataset.occurrenceRow = '39';
  focusedDocument.activeElement = edgeButton;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: edgeButton, preventDefault() {} });
  assert(focusedDocument.activeElement === firstButtons[1], "Tab from a section's final hit must enter the next section's first hit, not its header.");
  focusedDocument.activeElement = null;

  calls.length = 0;
  result.totalOccurrences = 53;
  result.sections[0].totalOccurrences = 20;
  result.sections[1].totalOccurrences = 33;
  pane.searchState = { result, generation: pane.occurrenceGeneration, offset: 0, activeSectionId: sectionIds[0], sectionOffsets: new Map(), rowsBySection: new Map(), visibleRows: [], virtualizedRows: false };
  result.materializeOccurrences = options => {
    calls.push(options);
    const total = options.sectionId === sectionIds[0] ? 20 : 33;
    return { total, returned: total, rows: Array.from({ length: total }, (_, index) => ({ citation: `Hit ${index}` })) };
  };
  await helpers.renderAllOccurrenceSections(pane);
  assert.strictEqual(pane.searchState.visibleRows.length, 53, "A 53-hit search was not rendered completely.");
  assert.strictEqual(count(containers.map(container => container.innerHTML).join(""), /data-occurrence-row=/g), 53, "Small-result rows were omitted from the DOM.");

  const closedParent = { open: false };
  details[0].open = false;
  details[0].parentElement = { closest: () => closedParent };
  focusedDocument.activeElement = searchInput;
  await helpers.handleOccurrenceResultTab(pane, { key: 'Tab', shiftKey: false, target: searchInput, preventDefault() {} });
  assert(focusedDocument.activeElement === firstButtons[0] && details[0].open && closedParent.open,
    "One Tab from a small search did not reveal and focus the first hit inside collapsed ancestors.");
  details[0].parentElement = null;
  focusedDocument.activeElement = null;

  const hierarchySource = between("    function occurrenceHierarchyHtml(", "\n\n    function occurrenceSectionDomToken(");
  assert(hierarchySource.includes("node.totalOccurrences") && hierarchySource.includes("section.totalOccurrences"), "Search trees do not display both ancestor and section occurrence totals.");
  assert(hierarchySource.includes('class="occurrence-section"') && !hierarchySource.includes("result?.buckets"), "The bottom hierarchy level is not the section-level hit list.");
  assert(hierarchySource.includes('expandResults ? " open" : ""'), "Search result branches do not honor the default-expansion preference.");
  const hierarchyProfile = { preferences: { showCfrChapterSubchapterInSearchHierarchy: false } };
  const hierarchyLabels = {
    navigationTitleCase: extractedFunction("navigationTitleCase", "statuteStatus"),
    titleCaseTopic: extractedFunction("titleCaseTopic", "navigationTitleCase")
  };
  const occurrenceHierarchyHtml = vm.runInNewContext(`(${hierarchySource.trim()})`, {
    profile: hierarchyProfile,
    escapeHtml: value => String(value),
    navigationTitleCase: extractedFunction("navigationTitleCase", "statuteStatus"),
    titleCaseTopic: value => String(value).replace(/(^|-)([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`).replaceAll("-", " "),
    hierarchyRowCitation: extractedFunction("hierarchyRowCitation", "hierarchyRowHeading", hierarchyLabels),
    hierarchyRowHeading: extractedFunction("hierarchyRowHeading", "hierarchyStatusReplacesHeading", hierarchyLabels),
    occurrenceSectionDomToken: value => String(value),
    occurrenceResultStatus: () => "current",
    Map, Number, String
  });
  const cfrHierarchyFixture = {
    totalOccurrences: 2,
    hierarchy: [
      { id: "root", parentId: null, kind: "authority", number: "CFR", totalOccurrences: 2 },
      { id: "title", parentId: "root", kind: "title", number: "8", totalOccurrences: 2 },
      { id: "chapter", parentId: "title", kind: "chapter", number: "I", totalOccurrences: 2 },
      { id: "subchapter", parentId: "chapter", kind: "subchapter", number: "B", totalOccurrences: 2 },
      { id: "part", parentId: "subchapter", kind: "part", number: "245", totalOccurrences: 2 },
      { id: "subpart", parentId: "part", kind: "subpart", number: "A", totalOccurrences: 2 },
      { id: "section", parentId: "subpart", kind: "section", number: "245.1", totalOccurrences: 2 }
    ],
    sections: [{ id: "8:245.1", hierarchyId: "section", citation: "8 CFR 245.1", heading: "Adjustment of status", totalOccurrences: 2 }]
  };
  const compactCfrHierarchy = occurrenceHierarchyHtml(cfrHierarchyFixture, true, "cfr");
  assert(compactCfrHierarchy.includes("Title 8") && compactCfrHierarchy.includes("Part 245") && compactCfrHierarchy.includes("8 CFR 245.1"), "The compact CFR result hierarchy does not retain Title → Part → Section.");
  assert(!compactCfrHierarchy.includes("Authority CFR") && !compactCfrHierarchy.includes("Chapter I") && !compactCfrHierarchy.includes("Subchapter B") && !compactCfrHierarchy.includes("Subpart A"), "The compact CFR result hierarchy retains redundant or disabled levels.");
  hierarchyProfile.preferences.showCfrChapterSubchapterInSearchHierarchy = true;
  const detailedCfrHierarchy = occurrenceHierarchyHtml(cfrHierarchyFixture, true, "cfr");
  assert(detailedCfrHierarchy.includes("Chapter I") && detailedCfrHierarchy.includes("Subchapter B") && !detailedCfrHierarchy.includes("Subpart A"), "The detailed CFR result hierarchy does not add only Chapter and Subchapter.");
  cfrHierarchyFixture.hierarchy.splice(-1, 0, { id: "topic", parentId: "subpart", kind: "subject-group", number: "ECFR123456789abcdef", heading: "Application Procedures", totalOccurrences: 2 });
  cfrHierarchyFixture.hierarchy.at(-1).parentId = "topic";
  const topicSearchHierarchy = occurrenceHierarchyHtml(cfrHierarchyFixture, true);
  assert(topicSearchHierarchy.includes("Application Procedures") && !topicSearchHierarchy.includes("ECFR123456789abcdef"), "A displayed topic heading must not expose its eCFR identifier.");
  assert(template.includes('.occurrence-section-label small { display: inline;') && hierarchySource.includes('<small>— ${escapeHtml(navigationTitleCase(section.heading))}</small>'), "Section citations and titles are not kept on one header row.");
  assert(hierarchySource.includes('class="occurrence-section-disclosure"')
    && hierarchySource.includes('button class="occurrence-section-label"')
    && hierarchySource.includes('data-occurrence-section-open='), "Section result headers do not separate disclosure from section navigation.");
  const sectionOpenSource = between("    function openFocusedOccurrenceSection(", "\n\n    function setFocusedPaneCommonLevel(");
  assert(sectionOpenSource.includes("focusedPaneHistorySnapshot(pane)")
    && sectionOpenSource.includes("openMainOccurrenceSection")
    && template.includes("openFocusedOccurrenceSection(pane, section)")
    && template.includes("openMainOccurrenceSection(pane, section)"), "Clicking a result section does not open its reader while preserving search history.");
  assert(template.includes('id="searchScopeClear" type="button" tabindex="-1"')
    && template.includes('event.key === "Tab" && !event.shiftKey')
    && template.includes('els.search.focus();'), "Forward Tab from the scope editor is not guaranteed to enter the main search field.");
  const resultSource = between("    function renderOccurrenceSearchResult(", "\n\n    async function renderFocusedOccurrencePane(");
  assert(resultSource.includes('class="occurrence-search-summary"') && resultSource.includes('hitCount === 1 ? "hit" : "hits"') && resultSource.includes('sectionCount === 1 ? "section" : "sections"'), "Search result totals are not integrated as ‘N hits in M sections’ with singular handling.");
  assert(!resultSource.includes("INA matches") && !resultSource.includes("CFR matches") && !resultSource.includes("Each expanded section"), "Search result panes retain redundant authority headings or explanatory copy.");
  assert(resultSource.includes("OCCURRENCE_EAGER_ROW_LIMIT") && resultSource.includes("renderAllOccurrenceSections"), "Small searches are not eagerly rendered as complete expanded section lists.");
  assert(template.includes(".occurrence-search-summary strong { color: var(--blue); font-family: var(--mono); font-size: 15px;"), "Search result totals do not emphasize their blue numbers with larger type.");
  const schedulerSource = between("    function scheduleVisibleOccurrenceSections(", "\n\n    function renderOccurrenceSearchResult(");
  assert(schedulerSource.includes("OCCURRENCE_WINDOW_OVERSCAN_PX") && schedulerSource.includes("OCCURRENCE_WINDOW_DOM_LIMIT") && schedulerSource.includes("retained"), "Large searches are not windowed around the viewport with a global DOM budget.");
}

function testAuthorityStreamAndLegacySearchRetirement() {
  assert(template.includes('.occurrence-authority-header {')
    && template.includes('position: sticky;')
    && template.includes('top: calc(var(--topbar-height, 0px) + var(--statute-nav-height, 0px));'), "Combined-search authority headers are not sticky below the application navigation.");
  assert(template.includes('.occurrence-authority-group { position: relative;'), "Authority groups do not bound their sticky headers so the next source can displace the prior header.");

  const legalAuthoritiesForAst = extractedFunction("legalAuthoritiesForAst", "resolveStructuredQuery");
  assert.deepStrictEqual(plain(legalAuthoritiesForAst({ scope: { authorities: ["cfr", "statute"] } })), ["cfr", "statute"], "Legacy scopes retain their authorities; the stream controls display order.");

  const namespaceOccurrenceResult = extractedFunction("namespaceOccurrenceResult", "combineAuthorityOccurrenceResults", {
    emptyOccurrenceResult: () => ({ sections: [], hierarchy: [], totalOccurrences: 0, materializeOccurrences: () => ({ rows: [], total: 0, returned: 0 }) })
  });
  const combineSource = between("    function combineAuthorityOccurrenceResults(", "\n\n    function occurrenceHierarchyHtml(").trim();
  const combineAuthorityOccurrenceResults = vm.runInNewContext(`(${combineSource})`, { namespaceOccurrenceResult, Number });
  const result = authority => ({
    totalOccurrences: 1,
    hierarchy: [{ id: `${authority}-root`, parentId: "", kind: "authority", totalOccurrences: 1 }],
    sections: [{ id: `${authority}-section`, hierarchyId: `${authority}-root`, citation: authority, totalOccurrences: 1 }],
    materializeOccurrences: () => ({ rows: [], total: 0, returned: 0 })
  });
  const combined = combineAuthorityOccurrenceResults([
    { authority: "statute", result: result("INA") },
    { authority: "cfr", result: result("CFR") }
  ]);
  assert.deepStrictEqual(plain(combined.authorityGroups.map(group => group.authority)), ["statute", "cfr"], "The combined result reordered CFR ahead of INA.");
  assert(combined.sections[0].id.startsWith("authority-stream:statute:") && combined.sections[1].id.startsWith("authority-stream:cfr:"), "Authority-stream section IDs are not isolated across sources.");

  const streamSource = between("    function occurrenceAuthorityStreamHtml(", "\n\n    function renderOccurrenceSearchResult(");
  assert(streamSource.includes('data-occurrence-authority=') && streamSource.includes('class="occurrence-authority-header"'), "The combined result does not render a distinct header for each authority.");
  assert(streamSource.includes("occurrenceHierarchyHtml(group.result, expandResults, group.authority)"), "Each authority header is not followed by its own result hierarchy.");

  for (const retiredId of ["searchFilterBar", "citationResultsNotification", "citationResultsNotificationCount", "secondaryOccurrencePanel", "secondaryOccurrenceList"]) {
    assert(!template.includes(`id="${retiredId}"`), `Retired legacy search UI #${retiredId} remains in the document.`);
  }
  for (const retiredRuntime of ["renderSecondaryOccurrenceResults", "renderSecondaryOccurrencePage", "updateCitationResultsNotification", "citationOtherResultCount"]) {
    assert(!template.includes(`function ${retiredRuntime}`) && !template.includes(`async function ${retiredRuntime}`), `Retired legacy search runtime ${retiredRuntime} remains bundled.`);
  }

  const splitState = {
    focusedWorkspaceOrigin: "dual-search", focusedCitationMode: true, focusedWorkspaceSymmetricQuery: "president",
    focusedCitationPanes: [
      { entry: { mode: "search-tree" }, sharedQuery: null },
      { entry: { mode: "search-tree" }, sharedQuery: "president" }
    ],
    query: "in:INA president alien, in:CFR president", mainOccurrencePane: null
  };
  const focusedWorkspaceIsSymmetricAuthoritySearch = extractedFunction("focusedWorkspaceIsSymmetricAuthoritySearch", "focusedWorkspaceExpression", { state: splitState, Boolean });
  assert.strictEqual(focusedWorkspaceIsSymmetricAuthoritySearch(), false, "An independently edited pane is still treated as an automatic symmetric split search.");
  const splitEvents = [];
  const splitProfile = { preferences: { splitAuthoritySearchPanes: true } };
  const setSplitAuthoritySearchPanes = extractedFunction("setSplitAuthoritySearchPanes", "setLegalNavigatorVisibility", {
    state: splitState, profile: splitProfile, focusedWorkspaceIsSymmetricAuthoritySearch,
    markProfileChanged: () => splitEvents.push("save"), renderSavingMenu: () => splitEvents.push("render"),
    toast: message => splitEvents.push(["toast", message]), exitFocusedCitationMode: () => splitEvents.push("exit"),
    runSearch: () => splitEvents.push("run"), els: { search: { value: splitState.query } }, String, Boolean
  });
  setSplitAuthoritySearchPanes(false);
  assert.strictEqual(splitProfile.preferences.splitAuthoritySearchPanes, false, "The split-search preference was not saved after an independent workspace edit.");
  assert(!splitEvents.includes("exit") && !splitEvents.includes("run"), "Turning off automatic split search discarded an independently edited workspace.");
  assert(splitEvents.some(event => Array.isArray(event) && event[0] === "toast"), "The preserved independent workspace is not explained after split search is disabled.");
}

function testPaneModesAndHistory() {
  assert(template.includes("const FOCUSED_PANE_TYPING_COMMIT_DELAY = 750"), "Heavy pane searches lost their coalescing delay.");
  assert(template.includes('cancelLegalReaderScroll(pane.scrollRoot); handleFocusedPaneInput(pane);')
    && template.includes('pane.input.addEventListener("blur", () => commitFocusedPaneInput(pane))')
    && template.includes('event.key === "Enter"'), "Pane typing is not committed on idle, blur, and Enter.");

  const descriptorSource = between("    function focusedPaneDescriptor(", "\n\n    function parseLegalWorkspaceInput(");
  for (const mode of ["reader", "hierarchy", "search-tree"]) assert(descriptorSource.includes(`mode: "${mode}"`), `Pane descriptor mode ${mode} is missing.`);
  assert(descriptorSource.includes("resolveStructuredQuery(ast)"), "Pane scopes must use the shared resolver.");
  const commitSource = between("    function commitFocusedPaneInput(", "\n\n    function handleFocusedPaneInput(");
  assert(commitSource.includes("Use the main search bar to add or compose another pane"), "Child panes do not reject pane-spawning commas with guidance.");
  const inputSource = between("    function handleFocusedPaneInput(", "\n\n    function navigateFocusedPaneCommandHistory(");
  assert(inputSource.includes('["reader", "hierarchy"].includes(descriptor.mode)')
    && inputSource.includes("commitFocusedPaneInput(pane, descriptor)"), "Complete child-pane citations still wait for the heavy-search debounce before updating.");
  const immediateEvents = [];
  const immediatePane = {
    input: { value: "8cfr205.2b" }, entry: { text: "8cfr205.2", authority: "cfr" },
    editSourceSnapshot: null, lastAcceptedCommand: "8cfr205.2", typingCommitTimer: "old"
  };
  const handleFocusedPaneInput = extractedFunction("handleFocusedPaneInput", "navigateFocusedPaneCommandHistory", {
    clearScrolledSearchLocation: extractedFunction("clearScrolledSearchLocation", "syncSearchToScrolledLegalLocation", { state: {} }),
    invalidatePaneSearchWork: () => immediateEvents.push(["cancel"]),
    String,
    FOCUSED_PANE_TYPING_COMMIT_DELAY: 750,
    topLevelCommandCommaIndex: () => -1,
    focusedPaneHistorySnapshot: () => ({ command: "8cfr205.2" }),
    replaceFocusedCitationSegmentText: (_pane, value) => immediateEvents.push(["expression", value]),
    setFocusedPaneStatus: () => {},
    clearTimeout: timer => immediateEvents.push(["clear", timer]),
    setTimeout: () => { throw new Error("A complete CFR citation was incorrectly delayed."); },
    focusedPaneDescriptor: value => ({ ok: value === "8cfr205.2b", mode: "reader" }),
    commitFocusedPaneInput: (_pane, descriptor) => immediateEvents.push(["commit", descriptor.mode])
  });
  handleFocusedPaneInput(immediatePane);
  assert.equal(immediateEvents[0][0], "cancel", "Pane input must invalidate obsolete work before classification or rendering.");
  assert(immediateEvents.some(event => event[0] === "commit" && event[1] === "reader"), "Changing 8cfr205.2 to 8cfr205.2b does not commit synchronously.");

  const copyPreviewReadingScrollTop = extractedFunction("copyPreviewReadingScrollTop", "bindCopyActionPreview", {
    state: { copyActionPreview: null }, window: { scrollY: 0 }
  });
  const focusedPaneHistorySnapshot = extractedFunction("focusedPaneHistorySnapshot", "updateFocusedPaneHistoryButtons", {
    copyPreviewReadingScrollTop,
    $$: () => [{ dataset: { paneHierarchyNode: "ina:title:I" } }],
    document: {}
  });
  const snapshot = focusedPaneHistorySnapshot({
    entry: { text: 'in:INA "term"', mode: "search-tree", authority: "statute" },
    result: { path: ["a", "1"] }, readerState: { explicitOccurrenceTarget: { occurrenceKey: "hit-1" } },
    searchState: { offset: 250, activeSectionId: "section-1", result: { totalOccurrences: 900 } },
    scrollRoot: { scrollTop: 42 }, detail: {}
  });
  assert.deepStrictEqual(plain({
    command: snapshot.command, raw: snapshot.raw, mode: snapshot.mode, authority: snapshot.authority,
    targetPath: snapshot.targetPath, targetOccurrence: snapshot.targetOccurrence,
    hierarchyExpanded: snapshot.hierarchyExpanded, searchState: snapshot.searchState, scrollTop: snapshot.scrollTop
  }), {
    command: 'in:INA "term"', raw: 'in:INA "term"', mode: "search-tree", authority: "statute",
    targetPath: ["a", "1"], targetOccurrence: { occurrenceKey: "hit-1" },
    hierarchyExpanded: ["ina:title:I"], searchState: { offset: 250, sectionId: "section-1", bucketId: "section-1", selectedResult: null, totalOccurrences: 900 }, scrollTop: 42
  });

  const pushFocusedPaneCommandHistory = extractedFunction("pushFocusedPaneCommandHistory", "focusedCitationSegments", { updateFocusedPaneHistoryButtons: () => {} });
  const pane = { commandHistory: [{ command: "INA 101", raw: "INA 101" }], commandHistoryIndex: 0, suppressCommandHistory: false };
  assert.strictEqual(pushFocusedPaneCommandHistory(pane, { command: "INA 101", scrollTop: 80 }, { command: "INA 212", targetPath: ["a"] }), true);
  assert.deepStrictEqual(plain(pane.commandHistory), [
    { command: "INA 101", raw: "INA 101", scrollTop: 80 },
    { command: "INA 212", targetPath: ["a"] }
  ], "A same-pane click did not preserve exact source and destination states.");
  assert.strictEqual(pushFocusedPaneCommandHistory(pane, null, { command: "INA 212", targetPath: ["a", "1"] }), false, "An equivalent command created another history transition.");

  const occurrenceClickSource = between("    function openFocusedOccurrenceRow(", "\n\n    function setFocusedPaneCommonLevel(");
  assert(occurrenceClickSource.includes("const source = focusedPaneHistorySnapshot(pane)") && occurrenceClickSource.includes("historySource: source"), "An occurrence click does not retain its complete search-tree source state.");
  const scrollSource = between("    function syncSearchToScrolledLegalLocation(", "\n\n    function scheduleStatuteNavigationUpdate(");
  assert(!/pushFocusedPaneCommandHistory|recordExplicitStatuteMove|highlightScrolledLegalTarget/.test(scrollSource), "A scroll update mutates pane history or explicit highlighting.");

  const enterSource = between("    function enterFocusedCitationMode(", "\n\n    function exitFocusedCitationMode(");
  assert(enterSource.includes("const resetHistories = options.resetHistories === true")
    && enterSource.includes("resetHistories || previousCommand !== entry.text"), "A main workspace rebuild cannot reset history for unchanged/reused child panes.");
  const occurrenceRoutingSource = between("    function tryRunOccurrenceSearch(", "\n\n    function runSearch(");
  const runSearchSource = between("    function runSearch(", "\n\n    function shouldDeferBroadSearch(");
  for (const [label, source] of [["dual search", occurrenceRoutingSource], ["composed workspace", runSearchSource]]) {
    assert(source.includes("resetHistories: true"), `A main-bar ${label} rebuild retains stale child histories.`);
  }

  assert(!template.includes("function buildIndexRecords("), "The retired general search index is still present.");
}

function testInsertionExclusions() {
  assert(template.includes('id="insertLegalReferenceButton"')
    && template.includes('class="legal-reference-insert-icon"')
    && template.includes('d="M22 11h-7m3-3-3 3 3 3"')
    && template.includes('class="legal-reference-preview-action-label">Copy</span>')
    && template.includes('class="legal-reference-preview-action-label">Split</span>')
    && template.includes('class="legal-reference-preview-action-label">Insert</span>')
    && template.includes("Insert after citing provision")
    && template.includes("Remove inserted excerpt"), "The preview's insertion action or insertion-position icon is incomplete.");
  assert((template.match(/data-tool-tooltip=/g) || []).length >= 3
    && template.includes("content: attr(data-tool-tooltip)"), "The three reference-preview tools do not expose visible hover/focus explanations.");
  const recordSource = between("    function legalReferenceInsertionRecord(", "\n\n    function legalReferenceSourceAttributes(");
  assert(recordSource.includes("sourceContext.insideInsertedReference"), "References inside inserted excerpts can recursively create insertions.");
  assert(recordSource.includes("!target || !sourceHost || !sourceRecord"), "Insertion records can be created without an exact source anchor.");

  const eligibilitySource = between("    function updateLegalReferenceInsertButton(", "\n\n    function insertionReadingAnchors(");
  for (const requirement of ['context?.resolution === "local"', "context?.text", "context?.insertionRecord", "insertionSlotForContext(context)", '.closest?.(".inserted-reference-card")']) {
    assert(eligibilitySource.includes(requirement), `Insertion eligibility omits ${requirement}.`);
  }
  assert(!eligibilitySource.includes("button.textContent") && eligibilitySource.includes('visibleLabel.textContent = inserted ? "Remove" : "Insert"') && eligibilitySource.includes("button.dataset.toolTooltip"), "Updating insertion state destroys its icon, leaves its visible label stale, or fails to update its tooltip.");
  const sourceResolution = between("    function sourceRecordReferenceDetails(", "\n\n    function currentSourceHostForReference(");
  assert(sourceResolution.includes('!["", "ordinary"].includes(block.noteType || "ordinary")'), "Editorial/effective-date CFR notes can resolve saved insertion sources.");

  const cfrRender = between("    function renderCfrBlock(", "\n\n    function renderCfr(");
  assert(cfrRender.includes('containerNoteType === "ordinary"'), "CFR editorial/effective-date note descendants receive insertion slots.");
  assert(cfrRender.includes('block.t === "footnote" ? "cfr-footnote"') && cfrRender.includes('"cfr-table-cell"'), "CFR footnotes or table cells lack exact insertion anchors.");
  const statuteRender = between("    function renderStatute(", "\n\n    function scrollToRenderedStatuteTarget(");
  assert(statuteRender.includes("legalAugmentationSlotHtml") && statuteRender.includes("renderStatuteSupplements"), "The statute reader lacks section-level insertion placement or source details.");
  const statuteTemplate = statuteRender.slice(statuteRender.indexOf('els.detail.innerHTML = `<div class="detail-content" data-statute-start>'));
  assert(statuteTemplate.indexOf("legalAugmentationSlotHtml") >= 0 && statuteTemplate.indexOf("legalAugmentationSlotHtml") < statuteTemplate.indexOf("${footer("), "Section inserted references do not precede source/editorial details.");

  const excerptSource = between("    function insertedStatuteNodeHtml(", "\n\n    function insertionRecordFromTrigger(");
  assert(excerptSource.includes("insideInsertedReference: true"), "Inserted descendants do not suppress recursive insertion actions.");
  assert(!excerptSource.includes('class="statutory-node') && !excerptSource.includes('class="cfr-block'), "Inserted excerpts reuse active-reader selector classes.");
  const groupSource = between("    function renderInsertedReferenceGroups(", "\n\n    function insertionSlotForContext(");
  assert(!/pushFocusedPaneCommandHistory|recordExplicitStatuteMove|syncFocusedWorkspaceExpression/.test(groupSource), "Insertion rendering mutates navigation/history/composition state.");
  assert(groupSource.includes("api.compareSourceOrder"), "Multiple insertions have no source-order contract.");
}

async function main() {
  testRuntimeBlocks();
  testProfileContracts();
  testOccurrenceRouting();
  testCommonControls();
  testChildHardScopes();
  await testSectionMaterializationHooks();
  testAuthorityStreamAndLegacySearchRetirement();
  testPaneModesAndHistory();
  testInsertionExclusions();
  console.log("Viewer overhaul tests passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
