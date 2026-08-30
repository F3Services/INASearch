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

function extractedFunction(name, nextName, context = {}) {
  const source = between(`    function ${name}(`, `\n\n    function ${nextName}(`).trim();
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
    ["OCCURRENCE", "inaSearchOccurrenceRuntime", "INASearch-Occurrence.js", "INA_SEARCH_OCCURRENCE"]
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
}

function testProfileContracts() {
  const profile = assignedObject("INASearch-Profile.js", "INA_SEARCH_PROFILE");
  assert.strictEqual(profile.schemaVersion, 4, "The annotation overhaul did not publish profile schema version 4.");
  assert.deepStrictEqual(profile.highlights, []);
  assert.deepStrictEqual(profile.annotationOrdinals, {});
  assert.strictEqual(profile.preferences.lastNoteColor, "yellow");
  assert.strictEqual(profile.preferences.notesUseRuleFont, false);
  assert.deepStrictEqual(plain({
    emptySearchView: profile.preferences.emptySearchView,
    splitAuthoritySearchPanes: profile.preferences.splitAuthoritySearchPanes,
    closeBlankCompanionOnSectionOpen: profile.preferences.closeBlankCompanionOnSectionOpen,
    legalNavigatorVisibility: profile.preferences.legalNavigatorVisibility,
    scrollUpdatesSearch: profile.preferences.scrollUpdatesSearch,
    expandSearchResultsByDefault: profile.preferences.expandSearchResultsByDefault,
    showCfrChapterSubchapterInSearchHierarchy: profile.preferences.showCfrChapterSubchapterInSearchHierarchy,
    syncCfrCommonDepthFromStatute: profile.preferences.syncCfrCommonDepthFromStatute,
    persistInlineReferenceInsertions: profile.preferences.persistInlineReferenceInsertions,
    hideLocalShareWarning: profile.preferences.hideLocalShareWarning
  }), {
    emptySearchView: "ina",
    splitAuthoritySearchPanes: false,
    closeBlankCompanionOnSectionOpen: true,
    legalNavigatorVisibility: "single",
    scrollUpdatesSearch: false,
    expandSearchResultsByDefault: true,
    showCfrChapterSubchapterInSearchHierarchy: false,
    syncCfrCommonDepthFromStatute: true,
    persistInlineReferenceInsertions: false,
    hideLocalShareWarning: false
  });
  assert.strictEqual(Object.hasOwn(profile.preferences, "navigationUpdatesSearch"), false, "The retired explicit-navigation preference remains public.");
  assert.deepStrictEqual(profile.referenceInsertions, { schemaVersion: 1, records: [] });

  for (const id of [
    "emptySearchViewSelect", "splitAuthoritySearchPanesToggle", "closeBlankCompanionOnSectionOpenToggle", "legalNavigatorVisibilitySelect",
    "scrollUpdatesSearchToggle", "syncCfrCommonDepthFromStatuteToggle", "expandSearchResultsByDefaultToggle", "showCfrChapterSubchapterInSearchHierarchyToggle", "persistInlineReferenceInsertionsToggle",
    "referenceInsertionsUnavailableCount", "removeUnavailableReferenceInsertionsButton", "statuteNavigationDepthSelect", "cfrNavigationDepthSelect"
  ]) assert(template.includes(`id="${id}"`), `Missing overhaul setting control ${id}.`);
  assert(template.includes('const companionSettingEnabled = profile.preferences.emptySearchView === "both"')
    && template.includes("els.closeBlankCompanionOnSectionOpenToggle.disabled = !companionSettingEnabled"), "The companion-close setting is not conditionally disabled.");
  assert(template.includes("normalized.preferences.splitAuthoritySearchPanes = normalized.preferences.splitAuthoritySearchPanes === true;"), "Profile normalization does not preserve an explicit split-search opt-in while defaulting omitted values off.");
  assert(template.includes('legacyFieldName("navigation", "Updates", "Search")'), "Legacy navigationUpdatesSearch is not explicitly retired during profile normalization.");
  assert(template.includes("--search-hit: #ffd866") && template.includes("--search-hit-ink: #241a00")
    && template.includes(".occurrence-row-text mark { border-radius: 2px; padding: 0 1px; color: var(--search-hit-ink); background: var(--search-hit); }"), "Search-hit highlighting does not use an explicit contrasting foreground/background pair.");
}

function testQuoteSafeLegacyScopeExtraction() {
  const extractCitationFilterTag = extractedFunction("extractCitationFilterTag", "extractSearchScopeTag", { INA_SEARCH_COMMAND: command });
  assert.strictEqual(extractCitationFilterTag('in:CFR "the term"'), null, "A content-scope in: modifier was mistaken for the legacy citation-scope editor.");
  assert.strictEqual(extractCitationFilterTag('in:notes president'), null, "An artifact content scope was mistaken for a citation scope.");
  assert.deepStrictEqual(plain(extractCitationFilterTag("alpha in: INA 101  waiver")), {
    query: "alpha waiver", scope: "INA 101", mode: "in", authorityWide: false
  });
  assert.deepStrictEqual(plain(extractCitationFilterTag("cites:INA 101  immigrant")), {
    query: "immigrant", scope: "INA 101", mode: "cites", authorityWide: false
  });
  for (const input of ['"in:CFR the term"', '(alpha in:CFR)', 'alpha \\in:CFR', '"scope, in:INA" OR alpha']) {
    assert.strictEqual(extractCitationFilterTag(input), null, `A quoted, grouped, or escaped scope was extracted: ${input}`);
  }
}

function occurrenceRoutingHarness(state, classification, { citation = null, splitAuthoritySearchPanes = false } = {}) {
  const events = [];
  const tryRunOccurrenceSearch = extractedFunction("tryRunOccurrenceSearch", "runSearch", {
    state,
    profile: { preferences: { splitAuthoritySearchPanes } },
    parseCitation: () => citation,
    INA_SEARCH_COMMAND: { classifyInput: () => classification },
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
  const dualAst = { status: "valid", ok: true, scope: null, clauses: [{ alternatives: [{ value: "term" }] }], common: { levels: { statute: "deepest", cfr: "deepest" } } };
  const combined = occurrenceRoutingHarness({ query: "the term", searchScopeActive: false, searchScopeMode: "in", searchScope: null, focusedCitationMode: false }, { mode: "search", status: "valid", ast: dualAst });
  const combinedEvent = combined.events.find(event => event[0] === "single")?.[1];
  assert.strictEqual(combined.accepted, true, "An unscoped ordinary search did not enter occurrence search.");
  assert.strictEqual(combinedEvent?.descriptor?.authority, "combined", "The default unscoped search did not route to the single combined authority stream.");
  assert.deepStrictEqual(plain(combinedEvent?.descriptor?.authorities), ["statute", "cfr"], "The combined search stream does not preserve INA-before-CFR source order.");
  assert(!combined.events.some(event => event[0] === "dual"), "The default unscoped search opened the optional split workspace.");
  assert.strictEqual(combined.events.find(event => event[0] === "common")?.[1]?.mode, "stream", "The combined search did not configure its Common control for stream mode.");

  const split = occurrenceRoutingHarness({ query: "the term", searchScopeActive: false, searchScopeMode: "in", searchScope: null, focusedCitationMode: false }, { mode: "search", status: "valid", ast: dualAst }, { splitAuthoritySearchPanes: true });
  assert.strictEqual(split.accepted, true, "An opted-in split search did not enter occurrence search.");
  assert.strictEqual(split.events.filter(event => event[0] === "dual").length, 1, "An opted-in split search did not create exactly one dual workspace.");
  assert.strictEqual(split.events.filter(event => event[0] === "single").length, 0, "An opted-in split search also created the combined occurrence stream.");

  const scopedAst = { ...dualAst, scope: { authority: "cfr", citationSystem: "cfr" }, common: { levels: { cfr: "section" } } };
  const scoped = occurrenceRoutingHarness({ query: 'in:CFR "the term"', searchScopeActive: false, searchScopeMode: "in", searchScope: null, focusedCitationMode: true }, { mode: "search", status: "valid", ast: scopedAst });
  const singleEvent = scoped.events.find(event => event[0] === "single");
  assert.strictEqual(scoped.accepted, true, "An authority-scoped ordinary search did not enter occurrence search.");
  assert.strictEqual(singleEvent?.[1]?.descriptor?.authority, "cfr", "A CFR-scoped search was routed to the wrong authority.");
  assert(scoped.events.some(event => event[0] === "exit"), "A singleton scoped search retained an obsolete comparison workspace.");
  assert(!scoped.events.some(event => event[0] === "dual"), "A scoped search incorrectly opened both authorities.");

  const legacyScope = { valid: true, family: "cfr", label: "8 CFR 204.1" };
  const legacy = occurrenceRoutingHarness({ query: "petition", searchScopeActive: true, searchScopeMode: "in", searchScope: legacyScope, focusedCitationMode: false }, { mode: "search", status: "valid", ast: dualAst });
  const legacySingle = legacy.events.find(event => event[0] === "single")?.[1];
  assert.strictEqual(legacySingle?.descriptor?.authority, "cfr", "A legacy citation fence lost its CFR authority.");
  assert.strictEqual(legacySingle?.scope, legacyScope, "A legacy citation fence was not passed to the occurrence engine.");

  const cites = occurrenceRoutingHarness({ query: "term", searchScopeActive: true, searchScopeMode: "cites", searchScope: { valid: true }, focusedCitationMode: false }, { mode: "search", status: "valid", ast: dualAst });
  assert.strictEqual(cites.accepted, false, "cites: was incorrectly routed into primary legal-text occurrence search.");
  const citationPrefix = occurrenceRoutingHarness({ query: "INA 212", searchScopeActive: false, searchScopeMode: "in", searchScope: null, focusedCitationMode: false }, { mode: "search", status: "valid", ast: dualAst }, { citation: { recognized: true } });
  assert.strictEqual(citationPrefix.accepted, false, "A recognized citation prefix was scanned as ordinary text.");

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
  const extractCitationFilterTag = extractedFunction("extractCitationFilterTag", "extractSearchScopeTag", { INA_SEARCH_COMMAND: command });
  const inaScope = { valid: true, family: "usc", authority: "ina", sectionIds: new Set(["8-1101"]), pathsBySection: new Map() };
  const parseSearchScope = value => value === "INA 101" ? inaScope : { valid: false, message: "Bad scope" };
  const focusedPaneHardScope = extractedFunction("focusedPaneHardScope", "focusedPaneDescriptor", { extractCitationFilterTag, parseSearchScope });
  const hardScope = focusedPaneHardScope('in:INA 101  "term"', { child: true });
  assert.strictEqual(hardScope?.tagged?.query, '"term"', "A child hard scope retained its citation as query text.");
  assert.strictEqual(hardScope?.scope, inaScope, "A child hard scope did not retain the parsed citation fence.");
  assert.strictEqual(hardScope?.authority, "statute", "An INA child hard scope selected the wrong occurrence authority.");
  assert.strictEqual(focusedPaneHardScope('in:CFR "term"', { child: true }), null, "An authority-wide child in: modifier was mistaken for a citation fence.");
  assert.strictEqual(focusedPaneHardScope('"in:INA 101  term"', { child: true }), null, "A quoted child phrase was mistaken for a citation fence.");

  const focusedPaneDescriptor = extractedFunction("focusedPaneDescriptor", "parseLegalWorkspaceInput", {
    INA_SEARCH_COMMAND: command,
    parseCitation: () => null,
    authorityForCitationResult: () => null,
    focusedCitationRecord: () => null,
    isAuthorityBrowse: () => false,
    citationInputCanContinue: () => false,
    focusedPaneHardScope,
    commandCitationClassifier: () => ({ valid: false })
  });
  const descriptor = focusedPaneDescriptor('in:INA 101  "term"', { child: true, childAuthority: "cfr", requireAuthority: true });
  assert.strictEqual(descriptor.ok, true, "A valid child citation fence was rejected.");
  assert.strictEqual(descriptor.authority, "statute", "A child citation fence did not override the pane's prior authority.");
  assert.strictEqual(descriptor.scope, inaScope, "The parsed child citation fence was dropped from its descriptor.");
  assert.deepStrictEqual(plain(descriptor.ast.clauses.map(clause => clause.alternatives.map(atom => atom.value))), [["term"]], "Citation-scope text leaked into the occurrence query clauses.");

  const occurrencePaneSource = between("    async function renderFocusedOccurrencePane(", "\n\n    function occurrenceReaderTarget(");
  assert(occurrencePaneSource.includes("scope: pane.entry.scope || undefined"), "A child citation fence is not passed to the occurrence session.");
  const expressionSource = between("    function focusedWorkspaceExpression(", "\n\n    function syncFocusedWorkspaceExpression(");
  assert(expressionSource.includes("!pane.entry.scope"), "The compositor prepends a second authority scope to child hard-fence commands.");
  const normalizeSource = between("    function normalizeFocusedPaneEntry(", "\n\n    function focusedCitationRecord(");
  assert(normalizeSource.includes("scope: entry?.scope || descriptor.scope || null"), "Child hard-fence state is lost during pane normalization.");
}

function testSectionMaterializationHooks() {
  const calls = [];
  const sectionIds = ["cfr:8:204.1", "cfr:8:204.2"];
  const containers = sectionIds.map(sectionId => ({ dataset: { occurrenceSectionRows: encodeURIComponent(sectionId) }, innerHTML: "" }));
  const details = sectionIds.map(sectionId => ({ dataset: { occurrenceSection: encodeURIComponent(sectionId) }, open: false }));
  const $$ = selector => selector === "[data-occurrence-section-rows]" ? containers : selector === "[data-occurrence-section]" ? details : [];
  const declarations = between("    const OCCURRENCE_EAGER_ROW_LIMIT", "\n\n    function scheduleVisibleOccurrenceSections(");
  const unitCorpus = { title8: { sections: [{ id: "8-1101" }] }, cfr: { sections: [], appendices: [] } };
  const helpers = vm.runInNewContext(`${declarations}\n({ occurrenceRowCitationLabel, occurrenceRowUnitText, renderOccurrenceRows, renderAllOccurrenceSections })`, {
    $$, $: () => null,
    corpus: unitCorpus,
    escapeHtml: value => String(value),
    occurrenceSectionDomToken: encodeURIComponent,
    occurrenceSectionIdFromToken: decodeURIComponent,
    occurrenceRowTextHtml: () => "snippet",
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
  helpers.renderOccurrenceRows(pane, 0, sectionIds[0], { windowed: true, limit: 80 });
  helpers.renderOccurrenceRows(pane, 0, sectionIds[1], { windowed: true, limit: 80, activate: false });
  assert.deepStrictEqual(plain(calls[0]), { sectionId: sectionIds[0], start: 0, limit: 80, contextCharacters: 60 }, "A large section did not use a bounded viewport window.");
  assert.strictEqual(pane.searchState.visibleRows.length, 160, "Nearby section windows cannot remain populated together.");
  assert.strictEqual(count(containers[0].innerHTML, /data-occurrence-row=/g), 80, "The first nearby section was evicted when another section populated.");
  assert.strictEqual(count(containers[1].innerHTML, /data-occurrence-row=/g), 80, "The second nearby section did not populate.");
  assert.strictEqual(count(containers[0].innerHTML, /data-occurrence-copy=/g), 160, "Each result row does not expose both directional copy actions.");
  assert(containers[0].innerHTML.includes("occurrence-row-copy-arrow\" aria-hidden=\"true\">←</span><span class=\"occurrence-row-copy-icon\" aria-hidden=\"true\">⧉")
    && containers[0].innerHTML.includes("⧉</span><span class=\"occurrence-row-copy-arrow\" aria-hidden=\"true\">→"), "Directional copy buttons do not point outward from the copied cell.");
  assert(containers[0].innerHTML.includes("occurrence-row-citation") && containers[0].innerHTML.includes("occurrence-row-text"), "Occurrence hits are not rendered as citation/text columns.");
  assert(details.every(item => item.open), "Materializing rows did not leave both sections expanded.");

  calls.length = 0;
  result.totalOccurrences = 53;
  result.sections[0].totalOccurrences = 20;
  result.sections[1].totalOccurrences = 33;
  pane.searchState = { result, offset: 0, activeSectionId: sectionIds[0], sectionOffsets: new Map(), rowsBySection: new Map(), visibleRows: [], virtualizedRows: false };
  result.materializeOccurrences = options => {
    calls.push(options);
    const total = options.sectionId === sectionIds[0] ? 20 : 33;
    return { total, returned: total, rows: Array.from({ length: total }, (_, index) => ({ citation: `Hit ${index}` })) };
  };
  helpers.renderAllOccurrenceSections(pane);
  assert.strictEqual(pane.searchState.visibleRows.length, 53, "A 53-hit search was not rendered completely.");
  assert.strictEqual(count(containers.map(container => container.innerHTML).join(""), /data-occurrence-row=/g), 53, "Small-result rows were omitted from the DOM.");

  const hierarchySource = between("    function occurrenceHierarchyHtml(", "\n\n    function occurrenceSectionDomToken(");
  assert(hierarchySource.includes("node.totalOccurrences") && hierarchySource.includes("section.totalOccurrences"), "Search trees do not display both ancestor and section occurrence totals.");
  assert(hierarchySource.includes('class="occurrence-section"') && !hierarchySource.includes("result?.buckets"), "The bottom hierarchy level is not the section-level hit list.");
  assert(hierarchySource.includes('expandResults ? " open" : ""'), "Search result branches do not honor the default-expansion preference.");
  const hierarchyProfile = { preferences: { showCfrChapterSubchapterInSearchHierarchy: false } };
  const occurrenceHierarchyHtml = vm.runInNewContext(`(${hierarchySource.trim()})`, {
    profile: hierarchyProfile,
    escapeHtml: value => String(value),
    titleCaseTopic: value => String(value).replace(/(^|-)([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`).replaceAll("-", " "),
    occurrenceSectionDomToken: value => String(value),
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
  assert(template.includes('.occurrence-section-label small { display: inline;') && hierarchySource.includes('<small>— ${escapeHtml(section.heading)}</small>'), "Section citations and titles are not kept on one header row.");
  assert(hierarchySource.includes('class="occurrence-section-disclosure"')
    && hierarchySource.includes('button class="occurrence-section-label"')
    && hierarchySource.includes('data-occurrence-section-open='), "Section result headers do not separate disclosure from section navigation.");
  const sectionOpenSource = between("    function openFocusedOccurrenceSection(", "\n\n    function setFocusedPaneCommonLevel(");
  assert(sectionOpenSource.includes("focusedPaneHistorySnapshot(pane)")
    && sectionOpenSource.includes("openMainOccurrenceSection")
    && template.includes("openFocusedOccurrenceSection(pane, section)")
    && template.includes("openMainOccurrenceSection(pane, section)"), "Clicking a result section does not open its reader while preserving search history.");
  assert(template.includes('grid-template-columns: clamp(76px, 15%, 106px) 62px minmax(0, 1fr)')
    && template.includes('align-items: center')
    && template.includes('.occurrence-row-text { min-width: 0; font: 12px/1.45'), "Result rows did not receive the tuned citation width, vertical centering, and larger typography.");
  assert(template.includes('.occurrence-row-copy { position: relative; display: inline-flex; width: 28px; height: 22px;')
    && template.includes('.occurrence-row-copy[data-occurrence-copy="text"] { color: var(--ink);')
    && template.includes('content: attr(data-copy-tooltip)')
    && template.includes('data-copy-tooltip="Copy Citation"')
    && template.includes('data-copy-tooltip="Copy Text"')
    && template.includes('title="Copy Citation"')
    && template.includes('title="Copy Text"'), "Result copy controls are not compact, theme-aware, and concisely explained on hover.");
  assert(template.includes('.occurrence-row:has([data-occurrence-copy="citation"]:hover) .occurrence-row-citation')
    && template.includes('.occurrence-row:has([data-occurrence-copy="text"]:hover) .occurrence-row-text'), "Copy-button hover does not highlight the cell it targets.");
  assert(template.includes('id="searchScopeClear" type="button" tabindex="-1"')
    && template.includes('event.key === "Tab" && !event.shiftKey')
    && template.includes('els.search.focus();'), "Forward Tab from the scope editor is not guaranteed to enter the main search field.");
  const copySource = between("    async function copyOccurrenceRowData(", "\n\n    function renderOccurrenceRows(");
  assert(copySource.includes("occurrenceRowUnitText(row)") && copySource.includes("row.citation"), "Result copy actions do not distinguish full citation from complete unit text.");
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

  const legalAuthoritiesForAst = extractedFunction("legalAuthoritiesForAst", "annotationTextMatchesAst");
  assert.deepStrictEqual(plain(legalAuthoritiesForAst({ scope: { authorities: ["cfr", "statute"] } })), ["statute", "cfr"], "A reversed in:CFR,INA modifier can reorder the required INA→CFR stream.");

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
  assert(template.includes('pane.input.addEventListener("input", () => handleFocusedPaneInput(pane))')
    && template.includes('pane.input.addEventListener("blur", () => commitFocusedPaneInput(pane))')
    && template.includes('event.key === "Enter"'), "Pane typing is not committed on idle, blur, and Enter.");

  const descriptorSource = between("    function focusedPaneDescriptor(", "\n\n    function parseLegalWorkspaceInput(");
  for (const mode of ["reader", "hierarchy", "search-tree"]) assert(descriptorSource.includes(`mode: "${mode}"`), `Pane descriptor mode ${mode} is missing.`);
  assert(descriptorSource.includes("options.requireAuthority === true"), "A standalone pane search can lose its authority fence.");
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
  assert(immediateEvents.some(event => event[0] === "commit" && event[1] === "reader"), "Changing 8cfr205.2 to 8cfr205.2b does not commit synchronously.");

  const focusedPaneHistorySnapshot = extractedFunction("focusedPaneHistorySnapshot", "updateFocusedPaneHistoryButtons", {
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
    hierarchyExpanded: ["ina:title:I"], searchState: { offset: 250, sectionId: "section-1", bucketId: "section-1", totalOccurrences: 900 }, scrollTop: 42
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
  const blankWorkspaceSource = between("    function openClearedSearchHierarchy(", "\n\n    function openTopLevelStatuteHierarchy(");
  for (const [label, source] of [["dual search", occurrenceRoutingSource], ["composed workspace", runSearchSource], ["blank Both workspace", blankWorkspaceSource]]) {
    assert(source.includes("resetHistories: true"), `A main-bar ${label} rebuild retains stale child histories.`);
  }

  const indexBuildSource = between("    async function buildIndexRecords(", "\n\n    function inaMappedSection(");
  assert(indexBuildSource.includes("!state.focusedCitationMode && !state.mainOccurrencePane"),
    "Completing the citation-source index can replay an active pane workspace and erase pane-local history.");
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
  assert(statuteRender.includes("legalAugmentationSlotHtml") && statuteRender.includes("section.sourceCredit"), "The statute reader lacks section-level insertion placement or source details.");
  const sourceCreditOffset = statuteRender.indexOf("section.sourceCredit");
  assert(statuteRender.lastIndexOf("legalAugmentationSlotHtml", sourceCreditOffset) >= 0, "Section inserted references do not precede source/editorial details.");

  const excerptSource = between("    function insertedStatuteNodeHtml(", "\n\n    function insertionRecordFromTrigger(");
  assert(excerptSource.includes("insideInsertedReference: true"), "Inserted descendants do not suppress recursive insertion actions.");
  assert(!excerptSource.includes('class="statutory-node') && !excerptSource.includes('class="cfr-block'), "Inserted excerpts reuse active-reader selector classes.");
  const groupSource = between("    function renderInsertedReferenceGroups(", "\n\n    function insertionSlotForContext(");
  assert(!/pushFocusedPaneCommandHistory|recordExplicitStatuteMove|syncFocusedWorkspaceExpression/.test(groupSource), "Insertion rendering mutates navigation/history/composition state.");
  assert(groupSource.includes("api.compareSourceOrder"), "Multiple insertions have no source-order contract.");
}

function main() {
  testRuntimeBlocks();
  testProfileContracts();
  testQuoteSafeLegacyScopeExtraction();
  testOccurrenceRouting();
  testCommonControls();
  testChildHardScopes();
  testSectionMaterializationHooks();
  testAuthorityStreamAndLegacySearchRetirement();
  testPaneModesAndHistory();
  testInsertionExclusions();
  console.log("Viewer overhaul tests passed.");
}

main();
