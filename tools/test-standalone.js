#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { performance } = require("perf_hooks");
const { buildDefinitionCatalog, definitionStatementGroups, deriveInaCatalog } = require("./definition-catalog");
const { applyStatuteReferences, statuteSourceMap } = require("./statute-references");
const { applyStatuteFootnotes, reconstructFlattenedField } = require("./statute-footnotes");
const { applyGeneratedLegalReferences, generatedReferences, legalReferenceContext } = require("./legal-references");
const { compactHouseHref, expandHouseHref, packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");
const { indexStatuteRunIns, statuteRunInMarkers } = require("./statute-run-ins");
const { applyStatuteStatusMetadata } = require("./statute-status");
const { FORMAT: CORPUS_PACKING_FORMAT, packCorpusForDelivery, hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");

const root = path.resolve(__dirname, "..");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sourceCorpus() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Corpus.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-CFR.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Definitions.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-USCIS-Glossary.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Statute-References.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Statute-Footnotes.js"), "utf8"), sandbox);
  const corpus = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_CORPUS));
  const statuteFootnotes = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_STATUTE_FOOTNOTES));
  applyStatuteFootnotes(corpus, statuteFootnotes);
  corpus.cfr = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_CFR));
  const definitions = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_DEFINITIONS));
  const uscisGlossary = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_USCIS_GLOSSARY));
  const statuteReferences = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_STATUTE_REFERENCES));
  applyStatuteReferences(corpus, statuteReferences);
  applyGeneratedLegalReferences(corpus);
  indexStatuteRunIns(corpus);
  applyStatuteStatusMetadata(corpus);
  corpus.definitions = buildDefinitionCatalog(corpus, definitions, uscisGlossary);
  packLegalReferences(corpus);
  return corpus;
}

function sourceProfile() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Profile.js"), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_PROFILE));
}

function sourceDefinitions() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Definitions.js"), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_DEFINITIONS));
}

function scriptBody(html, id) {
  const expression = new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`);
  const match = html.match(expression);
  assert(match, `Missing ${id} script block.`);
  return match[1];
}

function jsonBlock(html, id) {
  return JSON.parse(scriptBody(html, id));
}

function payloadBlock(html) {
  return scriptBody(html, "inaSearchCorpusData").replace(/\s+/g, "");
}

function corpusPayloadText(html) {
  return scriptBody(html, "inaSearchCorpusData");
}

function readBuild(fileName) {
  const filePath = path.join(root, fileName);
  const html = fs.readFileSync(filePath, "utf8");
  const manifest = jsonBlock(html, "inaSearchCorpusManifest");
  const payload = corpusPayloadText(html);
  const compressed = manifest.compression === "gzip" ? Buffer.from(payload.replace(/\s+/g, ""), "base64") : null;
  const uncompressed = compressed ? zlib.gunzipSync(compressed) : Buffer.from(payload, "utf8");
  if (compressed) {
    assert.strictEqual(compressed.byteLength, manifest.compressedBytes, `${fileName}: compressed byte count`);
    assert.strictEqual(sha256(compressed), manifest.compressedSha256, `${fileName}: compressed SHA-256`);
  } else {
    assert.strictEqual(manifest.compression, "none", `${fileName}: unsupported corpus compression`);
    assert.strictEqual(manifest.encoding, "utf-8", `${fileName}: unsupported uncompressed encoding`);
  }
  assert.strictEqual(uncompressed.byteLength, manifest.uncompressedBytes, `${fileName}: uncompressed byte count`);
  assert.strictEqual(sha256(uncompressed), manifest.uncompressedSha256, `${fileName}: uncompressed SHA-256`);
  const deliveryCorpus = JSON.parse(uncompressed.toString("utf8"));
  const corpus = hydratePackedCorpus(deliveryCorpus);
  return {
    fileName,
    filePath,
    html,
    bytes: Buffer.byteLength(html),
    build: jsonBlock(html, "inaSearchBuildData"),
    profile: jsonBlock(html, "inaSearchProfileData"),
    manifest,
    payload,
    compressed,
    corpus
  };
}

function executableScripts(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(match => !/type="application\/(?:json|gzip)"/.test(match[1]))
    .map(match => match[2]);
}

async function runBootstrap(build, overrides = {}) {
  const scripts = executableScripts(build.html);
  assert.strictEqual(scripts.length, 5, `${build.fileName}: executable script count`);
  const manifestAttributes = Object.fromEntries(Object.entries({
    "schema-version": String(build.manifest.schemaVersion),
    "corpus-schema-version": String(build.manifest.corpusSchemaVersion),
    "corpus-version": build.manifest.corpusVersion,
    encoding: build.manifest.encoding,
    compression: build.manifest.compression,
    "media-type": build.manifest.mediaType,
    "content-type": build.manifest.contentType,
    charset: build.manifest.charset,
    "compressed-bytes": String(build.manifest.compressedBytes),
    "uncompressed-bytes": String(build.manifest.uncompressedBytes),
    "compressed-sha256": build.manifest.compressedSha256,
    "uncompressed-sha256": build.manifest.uncompressedSha256,
    "delivery-packing": build.manifest.deliveryPacking
  }).filter(([, value]) => value !== undefined && value !== "undefined"));
  const embeddedElement = (value, attributes = {}) => {
    const element = overrides.scriptTextOnly
      ? { text: value, textContent: "", innerHTML: "" }
      : { text: value, textContent: value, innerHTML: value };
    element.getAttribute = name => Object.hasOwn(attributes, name.replace(/^data-/, "")) ? attributes[name.replace(/^data-/, "")] : null;
    return element;
  };
  const elements = {
    inaSearchBuildData: embeddedElement(JSON.stringify(build.build)),
    inaSearchCorpusManifest: embeddedElement(overrides.manifestTextUnreadable ? "" : JSON.stringify(overrides.manifest || build.manifest)),
    inaSearchCorpusData: embeddedElement(overrides.payload !== undefined ? overrides.payload : build.payload, manifestAttributes),
    inaSearchProfileData: embeddedElement(JSON.stringify(build.profile))
  };
  const context = {
    window: {},
    document: { getElementById: id => elements[id] },
    DecompressionStream: overrides.missingDecompressionStream ? undefined : globalThis.DecompressionStream,
    Blob: globalThis.Blob,
    Response: globalThis.Response,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    Uint8Array,
    atob: globalThis.atob,
    crypto: globalThis.crypto
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(scripts[0], { filename: `${build.fileName}:storage` }).runInContext(context);
  new vm.Script(scripts[1], { filename: `${build.fileName}:corpus-packing` }).runInContext(context);
  new vm.Script(scripts[3], { filename: `${build.fileName}:bootstrap` }).runInContext(context);
  const corpus = await context.INA_SEARCH_CORPUS_READY;
  return { corpus, profile: context.INA_SEARCH_PROFILE, errors: context.INA_SEARCH_LOAD_ERRORS };
}

function replaceProfileOnly(html, profile) {
  const start = "<!-- INA_SEARCH_PROFILE_DATA_START -->";
  const end = "<!-- INA_SEARCH_PROFILE_DATA_END -->";
  const safe = JSON.stringify(profile, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return html.replace(
    new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n  <script id="inaSearchProfileData" type="application/json">${safe}</script>\n  ${end}`
  );
}

function extractedFunction(source, name, nextName, context = {}) {
  const expression = new RegExp(`function ${name}\\([\\s\\S]*?\\n    }\\n(?:\\n)?    (?:async )?function ${nextName}\\(`);
  const match = source.match(expression);
  assert(match, `Could not extract ${name} from the application source.`);
  const functionSource = match[0].replace(new RegExp(`\\n(?:\\n)?    (?:async )?function ${nextName}\\($`), "");
  return vm.runInNewContext(`(${functionSource})`, { JSON, String, ...context });
}

function profileMigrationFunctions(source) {
  const start = source.indexOf("    function normalizeCourseStructure(");
  const end = source.indexOf("\n\n    let profile =", start);
  assert(start >= 0 && end > start, "Could not extract the profile normalization functions.");
  const declarations = source.slice(start, end);
  const tutorialCatalog = [
    ["quick-start", 5], ["advanced-search", 4], ["legal-reader", 4],
    ["definitions", 3], ["notes", 3], ["saving-progress", 3]
  ].map(([id, revision]) => ({ id, revision }));
  return vm.runInNewContext(`${declarations}\n({ normalizeCourseStructure, normalizeCoursePlacement, isValidProfile, normalizeProfile })`, {
    Array,
    Date,
    JSON,
    Map,
    Number,
    Set,
    String,
    TUTORIAL_CATALOG: tutorialCatalog,
    TUTORIAL_BY_ID: new Map(tutorialCatalog.map(module => [module.id, module])),
    TUTORIAL_STATUS_RANK: Object.freeze({ "not-started": 0, "in-progress": 1, viewed: 2, completed: 3 }),
    DEFAULT_STARTUP_QUERY: "INA 203b1a",
    corpus: null,
    makeId: () => "synthetic-default-id",
    structuredCloneSafe: value => JSON.parse(JSON.stringify(value))
  });
}

function tutorialProgressFunctions(source) {
  const start = source.indexOf("    function normalizeTutorialProgress(");
  const end = source.indexOf("\n\n    const defaultProfile", start);
  assert(start >= 0 && end > start, "Could not extract tutorial progress normalization.");
  const declarations = source.slice(start, end);
  const catalog = [
    ["quick-start", 5], ["advanced-search", 4], ["legal-reader", 4],
    ["definitions", 3], ["notes", 3], ["saving-progress", 3]
  ].map(([id, revision]) => ({ id, revision }));
  return vm.runInNewContext(`${declarations}\n({ normalizeTutorialProgress, mergeTutorialProgress })`, {
    Array,
    Date,
    JSON,
    Map,
    Number,
    Object,
    Set,
    String,
    TUTORIAL_CATALOG: catalog,
    TUTORIAL_BY_ID: new Map(catalog.map(module => [module.id, module])),
    TUTORIAL_STATUS_RANK: Object.freeze({ "not-started": 0, "in-progress": 1, viewed: 2, completed: 3 }),
    structuredCloneSafe: value => JSON.parse(JSON.stringify(value))
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function statutoryNode(corpus, sectionNumber, pathParts) {
  const section = corpus.title8.sections.find(item => String(item.section) === String(sectionNumber));
  assert(section, `Missing 8 U.S.C. ${sectionNumber}.`);
  let nodes = section.body || [];
  let node = null;
  for (const part of pathParts) {
    node = nodes.find(item => String(item.label) === String(part));
    assert(node, `Missing 8 U.S.C. ${sectionNumber}${pathParts.map(value => `(${value})`).join("")}.`);
    nodes = node.children || [];
  }
  return node;
}

function statuteNavigationFunctions(source, context = {}) {
  const start = source.indexOf("    function sameStatuteHierarchyItem(");
  const end = source.indexOf("\n\n    function renderStatute(", start);
  assert(start >= 0 && end > start, "Could not extract the statute navigation functions.");
  const declarations = source.slice(start, end);
  return vm.runInNewContext(`${declarations}\n({ sameStatuteHierarchyItem, sectionMatchesStatuteBreadcrumb, statuteNodeAtPath, statuteSiblingNodes, statutePathLevelLabel, statuteNavigationSegments })`, {
    Array,
    Boolean,
    JSON,
    Map,
    Math,
    String,
    ...context
  });
}

function statuteHistoryFunctions(source, context = {}) {
  const start = source.indexOf("    function normalizedStatuteHistoryLocation(");
  const end = source.indexOf("\n\n    function normalizedSearchText(", start);
  assert(start >= 0 && end > start, "Could not extract the statute history functions.");
  const declarations = source.slice(start, end);
  return vm.runInNewContext(`${declarations}\n({ normalizedStatuteHistoryLocation, sameStatuteHistoryLocation, addStatuteHistoryLocation, recordExplicitStatuteMove, navigateToStatuteLocation, navigateToStatuteCitation, navigateStatuteHistory, openCfrLocation, navigateToCfrLocation, navigateToCfrCitation })`, {
    Array,
    Boolean,
    JSON,
    Map,
    Math,
    Number,
    String,
    ...context
  });
}

function compactCitationPathFunctions(source, context = {}) {
  const start = source.indexOf("    const compactStatutePathIndexes = new Map();");
  const end = source.indexOf("\n\n    function structuredCloneSafe(", start);
  assert(start >= 0 && end > start, "Could not extract the compact citation-path resolver.");
  const declarations = source.slice(start, end);
  return vm.runInNewContext(`${declarations}\n({ compactStatutePathIndex, romanICaseMatches, compareCompactCitationPaths, citationWithRomanCase, resolveIndexedCompactStatutePath })`, {
    Array,
    Map,
    String,
    ...context
  });
}

function searchScopeParsingFunctions(source, context = {}) {
  const start = source.indexOf("    function searchScopeDescriptor(");
  const end = source.indexOf("\n\n    function mappedUscResultForIna(", start);
  assert(start >= 0 && end > start, "Could not extract the citation-scope parser.");
  const declarations = source.slice(start, end);
  return vm.runInNewContext(`${declarations}\n({ searchScopeDescriptor, inferredSearchScopeEndpoint, searchScopeRange, parseSearchScope })`, {
    Map,
    Number,
    Set,
    String,
    ...context
  });
}

async function main() {
  const fullSource = sourceCorpus();
  const rawDefinitionSource = sourceDefinitions();
  const blankProfile = sourceProfile();
  const full = readBuild("INASearch.html");
  const uncompressed = readBuild("INASearch-Uncompressed.html");

  assert.strictEqual(blankProfile.schemaVersion, 3, "Blank profiles must use saved-data schema v3.");
  assert.strictEqual(Object.hasOwn(blankProfile, "courseStructure"), false, "Blank profiles must not retain the retired course structure.");
  assert.deepStrictEqual(blankProfile.tutorialProgress, { schemaVersion: 1, modules: {} }, "Blank profiles must include optional, empty tutorial progress.");
  assert.strictEqual(blankProfile.preferences.statutoryLinkCitationSystem, "usc", "Blank profiles must default statutory link labels to the source U.S. Code wording.");
  assert.strictEqual(blankProfile.preferences.highlightDefinedTerms, false, "Blank profiles must disable experimental defined-term highlighting by default.");
  assert.strictEqual(blankProfile.preferences.automaticCfrUpdates, true, "Blank profiles must enable automatic CFR updates by default.");
  assert.strictEqual(blankProfile.preferences.defaultStartupQuery, "INA 203b1a", "Blank profiles must retain the existing startup citation by default.");
  assert.strictEqual(fs.existsSync(path.join(root, "INASearch-no-USC.html")), false, "The retired no-USC build still exists.");
  assert.strictEqual(fs.existsSync(path.join(root, "INASearch-AU.html")), false, "The retired all-unlocked build still exists.");
  assert.strictEqual(fs.existsSync(path.join(root, "INASearch-AU-Uncompressed.html")), false, "The retired all-unlocked uncompressed build still exists.");
  for (const retiredSource of ["INASearch-Visa-Tables.js", "INASearch-Form-Questions.js"]) assert.strictEqual(fs.existsSync(path.join(root, "src", retiredSource)), false, `${retiredSource} still exists.`);
  assert.strictEqual(fs.existsSync(path.join(root, "tools", "generate-visa-tables.js")), false, "The retired classification-table generator still exists.");

  assert(full.bytes <= 8_000_000, "INASearch.html exceeds 8 MB acceptance limit.");
  assert(uncompressed.bytes <= 35_300_000, "INASearch-Uncompressed.html exceeds 35.3 MB acceptance limit.");
  const retiredProfileFields = ["unlocks", "visaSummaryUnlocks", "visaChallengeLockouts", "visaFactUnlocks", "visaFactChallengeLockouts", "resourceUnlocks", "resourceChallengeLockouts"];
  for (const field of retiredProfileFields) assert.strictEqual(Object.hasOwn(blankProfile, field), false, `Blank profile still exports ${field}.`);
  for (const preference of ["quizCursorKey", "quizClassification"]) assert.strictEqual(Object.hasOwn(blankProfile.preferences, preference), false, `Blank profile still exports ${preference}.`);
  for (const build of [full, uncompressed]) {
    for (const fragment of ["visaCategories", "visaQuizGroups", "visaSummaryUnlocks", "visaFactUnlocks", "resourceUnlocks", "quizCursorKey", "quizClassification", "unlockGroupId", 'id="view-visas"', 'id="view-immigrants"', 'id="view-quiz"', "INASearch-AU", "INASearch-progress-"]) {
      assert.strictEqual(build.html.includes(fragment), false, `${build.fileName} contains retired implementation fragment ${fragment}.`);
    }
    for (const label of ["Import saved data", "Download JSON backup", "Saving &amp; data"]) assert(build.html.includes(label), `${build.fileName} is missing ${label}.`);
  }
  let persistenceRequests = 0;
  const storageContext = {
    globalThis: null, Blob, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto,
    navigator: { storage: { persisted: async () => false, persist: async () => { persistenceRequests += 1; return true; } } }
  };
  storageContext.globalThis = storageContext;
  vm.createContext(storageContext);
  new vm.Script(scriptBody(full.html, "inaSearchStorageRuntime"), { filename: "inaSearchStorageRuntime" }).runInContext(storageContext);
  const cachedFixtureCorpus = { schemaVersion: full.corpus.schemaVersion, corpusVersion: full.corpus.corpusVersion, fixture: true };
  const cachedFixtureBytes = new TextEncoder().encode(JSON.stringify(cachedFixtureCorpus));
  const cachedFixtureRecord = {
    recordSchemaVersion: 1,
    storageFormat: "json",
    corpusSchemaVersion: cachedFixtureCorpus.schemaVersion,
    corpusVersion: cachedFixtureCorpus.corpusVersion,
    bytes: cachedFixtureBytes.byteLength,
    sha256: sha256(cachedFixtureBytes),
    payload: new Blob([cachedFixtureBytes], { type: "application/json" })
  };
  assert.deepStrictEqual(plain(await storageContext.INASearchStorage.decodeCorpusRecord(cachedFixtureRecord)), cachedFixtureCorpus, "A valid uncompressed IndexedDB corpus record did not round-trip.");
  await assert.rejects(() => storageContext.INASearchStorage.decodeCorpusRecord({ ...cachedFixtureRecord, sha256: "0".repeat(64) }), /integrity check/, "A corrupted IndexedDB corpus record passed its SHA-256 check.");
  const persistenceResult = plain(await storageContext.INASearchStorage.requestPersistentStorage());
  assert(!Number.isNaN(Date.parse(persistenceResult.checkedAt)), "The storage-persistence check did not record its time.");
  delete persistenceResult.checkedAt;
  assert.deepStrictEqual(persistenceResult, { supported: true, persisted: true, requested: true }, "The storage-persistence request did not report a granted persistent bucket.");
  assert.strictEqual(persistenceRequests, 1, "The storage-persistence fixture did not exercise the browser persistence request exactly once.");
  for (const retiredCorpusKey of ["visaCategories", "visaQuizGroups", "visaTables"]) assert.strictEqual(Object.hasOwn(full.corpus, retiredCorpusKey), false, `Corpus still contains ${retiredCorpusKey}.`);
  assert(/id="tutorialMenuButton"/.test(full.html), "The explicit tutorial launcher is missing.");
  assert(/id="definedTermHighlightingToggle"/.test(full.html), "The defined-term highlighting setting is missing.");
  assert(full.html.includes("A highlighted word may be used in a different grammatical or contextual sense from its legal definition"), "The experimental defined-term warning does not explain the risk of a misleading match.");
  assert(/id="automaticCfrUpdatesToggle"[^>]*type="checkbox"[^>]*role="switch"/.test(full.html), "The automatic CFR update setting is missing.");
  assert(/class="settings-info-button"[^>]*aria-describedby="automaticCfrUpdatesHelp"/.test(full.html), "The automatic CFR update setting is missing its compact information control.");
  assert(full.html.includes("Turn this off for a local-only workflow") && full.html.includes("INASearch makes no network requests"), "The automatic CFR update information does not explain local-only mode.");
  assert(/id="tutorialHubModal" hidden/.test(full.html), "The tutorial hub is not closed at startup.");
  assert(/id="tutorialCoach"[^>]*aria-modal="false"[^>]*hidden/.test(full.html), "The nonmodal tutorial coach is not closed at startup.");
  assert(/id="tutorialMenuButton"[^>]*aria-describedby="tutorialStartPromptText"[\s\S]{0,700}id="tutorialStartPromptTitle">New to INASearch\?[\s\S]{0,250}id="tutorialStartPromptBody">Start with the basic tutorial here\.[\s\S]{0,250}id="tutorialStartPromptClose"[^>]*aria-label="Dismiss Quick Start message"/.test(full.html), "An unfinished Quick Start does not display a large, dismissible message pointing to the tutorial button.");
  assert(/id="tutorialMenuButton"[\s\S]{0,1200}id="corpusStatus"[\s\S]{0,300}id="saveStatus"[\s\S]{0,300}id="settingsMenuButton"/.test(full.html), "The Tutorials button is not the leftmost application-status button.");
  assert(/\.tutorial-start-prompt\s*\{[^}]*position:\s*absolute[^}]*width:\s*min\(300px,[^}]*font-size/s.test(full.html) || full.html.includes(".tutorial-start-prompt-copy strong { color: var(--navy); font-size: 14px;"), "The Quick Start message is still rendered as a small inline status pill.");
  assert(!/\b(?:localStorage|sessionStorage)\b/.test(full.html), "Tutorial progress must not rely on hidden browser storage.");
  const tutorialCatalogSource = full.html.slice(full.html.indexOf("const TUTORIAL_CATALOG"), full.html.indexOf("const TUTORIAL_BY_ID"));
  const tutorialModuleIds = [...tutorialCatalogSource.matchAll(/\n\s{8}id:\s*"([^"]+)"/g)].map(match => match[1]);
  assert.deepStrictEqual(tutorialModuleIds, ["quick-start", "advanced-search", "legal-reader", "definitions", "notes", "saving-progress"], "The tutorial catalog does not contain the intentionally compact lesson set in its intended order.");
  for (const moduleId of ["advanced-search", "legal-reader", "definitions", "notes", "saving-progress"]) {
    assert(full.html.includes(`data-tutorial-module="${moduleId}"`) || full.html.includes(`data-tutorial-module=\\"${moduleId}\\"`), `Missing passive ${moduleId} tutorial entry point.`);
  }
  for (const removedModule of ["lettered-citations", "former-provisions", "cfr-updates", "source-literacy"]) assert(!tutorialCatalogSource.includes(`id: "${removedModule}"`), `${removedModule} remains as an unnecessary standalone tutorial.`);
  assert(!tutorialCatalogSource.includes("lettered-units") && !tutorialCatalogSource.includes("Part 274 and Part 274A"), "Letter-suffixed citations remain tutorial material after being removed from the lesson plan.");
  assert(tutorialCatalogSource.includes("Notice former provisions") && tutorialCatalogSource.includes("sticky warning") && tutorialCatalogSource.includes("reviewed transfer destination"), "The Legal Reader tutorial is missing its brief former-provision warning.");
  assert(!full.html.includes('data-tutorial-module="source-literacy"') && !full.html.includes('data-tutorial-module="cfr-updates"'), "A removed source or update tutorial still has an entry point.");
  assert((tutorialCatalogSource.match(/setup: "blank-search"/g) || []).length >= 4, "Search tutorials do not consistently clear a loaded startup citation before practice.");
  assert(tutorialCatalogSource.includes('target: ".global-search .search-field-shell", focus: "#searchInput"'), "Search tutorials still highlight the input over the INA/U.S.C. crosswalk instead of the complete search shell.");
  const tutorialSetupSource = full.html.slice(full.html.indexOf("function runTutorialSetup"), full.html.indexOf("function restoreTutorialState"));
  assert(tutorialSetupSource.includes('setup === "blank-search"') && tutorialSetupSource.includes("resetSearchState()") && tutorialSetupSource.includes('tutorialSwitchView("search")'), "The blank tutorial search setup is incomplete.");
  assert(tutorialSetupSource.includes('setup === "about-page"') && tutorialSetupSource.includes('tutorialSwitchView("sources")'), "Quick Start cannot open the About page for its contextual explanation.");
  assert(tutorialCatalogSource.includes('title: "Start with the citation from your work"') && tutorialCatalogSource.includes("The same search box accepts all three citation formats."), "Quick Start does not begin from the citation an officer or attorney already has in front of them.");
  assert(tutorialCatalogSource.includes('title: "Open INA 203"') && tutorialCatalogSource.includes("Type INA 203 in the search box. As soon as INASearch recognizes the citation") && tutorialCatalogSource.includes("immigrant visa preference categories"), "Quick Start does not describe the live citation lookup clearly and in context.");
  assert(!tutorialCatalogSource.includes("temporarily clears") && !tutorialCatalogSource.includes("sample citation") && !tutorialCatalogSource.includes("original citation"), "Quick Start exposes irrelevant tutorial-state mechanics or refers to an unexplained sample.");
  assert(tutorialCatalogSource.includes('id: "crosswalk"') && tutorialCatalogSource.includes("INA 203 is codified at 8 U.S.C. 1153"), "Quick Start does not explain the citation crosswalk when it first appears.");
  assert(tutorialCatalogSource.includes('id: "reader"') && tutorialCatalogSource.includes("local copy included with INASearch"), "Quick Start does not identify the matching legal text the user is seeing.");
  assert(tutorialCatalogSource.includes('id: "hierarchy"') && tutorialCatalogSource.includes("This bar places INA 203 within Title 8") && tutorialCatalogSource.includes("When you open a subsection or paragraph, those levels appear here too."), "Quick Start does not explain the hierarchy that is actually visible after opening INA 203.");
  for (const [pageStep, setup, heading] of [["definitions-page", "definitions-page", "#definitionsHeading"], ["notes-page", "notes-page", "#notesHeading"], ["about-page", "about-page", "#sourcesHeading"]]) {
    assert(tutorialCatalogSource.includes(`id: "${pageStep}"`) && tutorialCatalogSource.includes(`target: "${heading}", setup: "${setup}"`), `Quick Start does not open and explain ${pageStep} as its own page.`);
  }
  assert(!tutorialCatalogSource.includes("offerModules: true"), "Quick Start still piles the remaining tutorial catalog onto a first-time user at completion.");
  const tutorialLauncherSource = full.html.slice(full.html.indexOf("function quickStartCompleted"), full.html.indexOf("function renderTutorialHub"));
  assert(tutorialLauncherSource.includes('tutorialProgressEntry("quick-start").status === "completed"'), "The Tutorials launcher does not require actual Quick Start completion.");
  assert(tutorialLauncherSource.includes("const promptVisible = !completed && !active && !state.tutorialPromptDismissed") && tutorialLauncherSource.includes("els.tutorialStartPrompt.hidden = !promptVisible") && tutorialLauncherSource.includes('classList.toggle("needs-introduction", !completed)'), "The Quick Start prompt and emphasized launcher do not track completion or dismissal.");
  const openTutorialHubSource = full.html.slice(full.html.indexOf("function openTutorialHub"), full.html.indexOf("function closeTutorialHub"));
  assert(openTutorialHubSource.includes("if (!quickStartCompleted())") && openTutorialHubSource.includes('startTutorial("quick-start"'), "The Tutorials button can open the catalog before starting or resuming Quick Start.");
  const tutorialPauseSource = full.html.slice(full.html.indexOf("function pauseTutorial"), full.html.indexOf("function finishTutorial"));
  assert(tutorialPauseSource.includes("endTutorial(openHub && quickStartCompleted())"), "Pausing an unfinished Quick Start still opens the tutorial catalog.");
  const tutorialFinishSource = full.html.slice(full.html.indexOf("function finishTutorial"), full.html.indexOf("function advanceTutorial"));
  assert(tutorialFinishSource.includes("else if (quickStartCompleted())") && tutorialFinishSource.includes("openTutorialHub(returnFocus)"), "The tutorial catalog is not gated until Quick Start completion.");
  const attachEventsSource = full.html.slice(full.html.indexOf("function attachEvents"), full.html.indexOf("function reloadUpdatedCorpus"));
  assert(attachEventsSource.includes('tutorialStartPromptClose.addEventListener("click"') && attachEventsSource.includes("state.tutorialPromptDismissed = true") && attachEventsSource.includes("renderTutorialLauncher()"), "The Quick Start message close button does not dismiss the callout for the current tab.");
  assert(!tutorialCatalogSource.includes("recap:") && !full.html.includes("tutorial-answer-list") && !full.html.includes("Skip check"), "End-of-tutorial quiz questions remain in the tutorial system.");
  assert(!full.html.includes("tutorial-practice-feedback") && !full.html.includes("That worked. Continue when you are ready."), "Practice completion still waits on low-contrast feedback instead of advancing.");
  const tutorialPracticeSource = full.html.slice(full.html.indexOf("function tutorialPracticeSatisfied"), full.html.indexOf("function renderTutorialStep"));
  assert(tutorialPracticeSource.includes("setTimeout(() =>") && tutorialPracticeSource.includes("advanceTutorial()") && tutorialPracticeSource.includes("submittedSearch"), "Successful tutorial practice does not automatically advance.");
  const runSearchSource = full.html.slice(full.html.indexOf("function runSearch()"), full.html.indexOf("function shouldDeferBroadSearch"));
  assert(runSearchSource.includes("showCurrentSearchResults(direct || state.results[0]);") && runSearchSource.includes("checkTutorialPractice();"), "A live citation result does not notify the active tutorial after it opens.");
  assert(!/\.tutorial-highlight\s*\{[^}]*z-index:/s.test(full.html), "A highlighted reader panel can still rise above and cover the sticky search bar.");
  assert(tutorialCatalogSource.includes("Highlight defined terms is off by default") && tutorialCatalogSource.includes("different meaning in context"), "The revised Definitions tutorial omits the optional, context-sensitive highlighting warning.");
  assert(tutorialCatalogSource.includes("connect INASearch_Data.json") && !tutorialCatalogSource.includes("durable in-file notes"), "The saving tutorials still describe profile data as living inside the HTML file.");
  const initializeSource = full.html.slice(full.html.indexOf("function initialize()"), full.html.indexOf("window.INASearchTest"));
  assert(!initializeSource.includes("startTutorial("), "A tutorial is started automatically during initialization.");
  assert(/function captureTutorialState\(/.test(full.html) && /function restoreTutorialState\(/.test(full.html), "Tutorial state snapshot and restore support is incomplete.");
  assert(/savingMenuEnableButton[\s\S]{0,200}savingMenuImportButton[\s\S]{0,200}savingMenuDownloadButton/.test(full.html), "Saving tutorial safeguards are incomplete.");
  assert.strictEqual(full.build.variant, "standard");
  assert.strictEqual(full.build.hasLocalUscCache, true);
  assert.strictEqual(full.build.corpusCompression, "gzip");
  assert.strictEqual(uncompressed.build.variant, "uncompressed");
  assert.strictEqual(uncompressed.build.hasLocalUscCache, true);
  assert.strictEqual(uncompressed.build.corpusCompression, "none");
  assert.strictEqual(uncompressed.manifest.encoding, "utf-8");
  assert.strictEqual(uncompressed.manifest.mediaType, "application/json");
  assert.strictEqual(Object.hasOwn(uncompressed.manifest, "compressedBytes"), false, "The uncompressed manifest advertises compressed bytes.");
  assert(/id="inaSearchCorpusData" type="application\/json"/.test(uncompressed.html), "The uncompressed corpus is not embedded as plain JSON.");
  assert.deepStrictEqual(full.profile, blankProfile);
  assert.deepStrictEqual(uncompressed.profile, blankProfile, "The uncompressed build must retain the standard unanswered profile.");
  assert.strictEqual(full.manifest.deliveryPacking, CORPUS_PACKING_FORMAT, "The standard build does not advertise its compact delivery format.");
  assert.strictEqual(Object.hasOwn(uncompressed.manifest, "deliveryPacking"), false, "The uncompressed build advertises compact delivery packing.");
  assert.deepStrictEqual(uncompressed.corpus, fullSource, "Uncompressed corpus round trip changed data.");
  assert(full.corpus.title8.sections.every(section => section.status), "Compact corpus hydration did not restore implied statutory status values.");
  const statuteStatusCounts = Object.fromEntries(["current", "repealed", "transferred", "omitted"].map(status => [status, full.corpus.title8.sections.filter(section => section.status === status).length]));
  assert.deepStrictEqual(statuteStatusCounts, { current: 286, repealed: 57, transferred: 18, omitted: 15 }, "Unexpected Title 8 disposition-status inventory.");
  const transferredSections = full.corpus.title8.sections.filter(section => section.status === "transferred");
  assert.strictEqual(transferredSections.flatMap(section => section.transferTargets || []).length, 44, "The reviewed transferred-section index does not contain all 44 source destinations.");
  assert(full.corpus.title8.sections.filter(section => section.status !== "transferred").every(section => !Object.hasOwn(section, "transferTargets")), "Transfer destinations were duplicated onto non-transferred records.");
  const transferTarget = (sectionLabel, source) => transferredSections.find(section => section.section === sectionLabel)?.transferTargets?.find(target => target.source === source);
  assert.deepStrictEqual(plain(transferTarget("31, 32", "31")), { source: "31", title: 52, section: "10101" }, "8 U.S.C. 31 does not point to its reviewed current destination.");
  assert.deepStrictEqual(plain(transferTarget("100, 101", "100")), { source: "100", title: 8, section: "1551" }, "8 U.S.C. 100 does not point to its reviewed current destination.");
  assert.deepStrictEqual(plain(transferTarget("724a–1", "724a–1")), { source: "724a–1", title: 8, section: "1440", placement: "note" }, "The note placement for former 8 U.S.C. 724a–1 was lost.");
  assert.deepStrictEqual(plain(transferTarget("109a to 109d", "109d")), { source: "109d", title: 8, section: "1555", relation: "see" }, "The House 'see' disposition for 8 U.S.C. 109d was flattened into a literal transfer.");
  assert.deepStrictEqual(plain(transferTarget("53 to 56", "55")), { source: "55", title: 42, section: "1993", former: true }, "The former-destination qualifier for 8 U.S.C. 55 was lost.");
  const packedStatusCorpus = packCorpusForDelivery(fullSource);
  const packedCurrentSection = packedStatusCorpus.title8.sections.find(section => section.section === "1101");
  const packedTransferredSection = packedStatusCorpus.title8.sections.find(section => section.section === "31, 32");
  assert(!Object.hasOwn(packedCurrentSection, "status"), "The compact payload restates the implied current statutory status.");
  assert(!Object.hasOwn(packedTransferredSection, "transferTargets") && Array.isArray(packedTransferredSection._t), "Transferred destinations were not stored in their compact tuple form.");
  assert.strictEqual(JSON.stringify(packedTransferredSection._t), '[["31",52,"10101"],["32",52,"10102"]]', "Unexpected compact transfer tuple encoding.");
  assert(full.corpus.title8.sections.flatMap(section => section.body || []).every(node => Array.isArray(node.path)), "Compact corpus hydration did not restore top-level statutory paths.");
  const hydratedSource = unpackLegalReferences(JSON.parse(JSON.stringify(fullSource)));
  for (const href of ["/us/usc/t8/s1101/a/15/H/i/b", "/us/pl/104/208", "/us/stat/110/3009", "/us/act/1952-06-27/ch477"]) {
    assert.strictEqual(expandHouseHref(compactHouseHref(href)), href, `Packed House href did not round-trip: ${href}`);
  }
  assert.strictEqual(full.corpus.title8.sections.length, 376);
  assert.strictEqual(uncompressed.corpus.title8.sections.length, 376);
  assert(full.corpus.title8.sections.some(section => Array.isArray(section.body)), "Full corpus has no cached Title 8 bodies.");
  assert(uncompressed.corpus.title8.sections.some(section => Array.isArray(section.body)), "Uncompressed build has no cached Title 8 bodies.");
  assert.strictEqual(full.corpus.schemaVersion, 4, "The combined corpus schema was not upgraded after retiring classification-study data.");
  assert.strictEqual(full.corpus.cfr.ptarYear, 2025, "Unexpected CFR Parallel Table year.");
  assert.strictEqual(full.corpus.cfr.coverage.sectionCount, 3039, "Unexpected cached CFR section count.");
  assert.strictEqual(full.corpus.cfr.sections.length, 3039, "CFR section records do not match the manifest.");
  assert.strictEqual(full.corpus.cfr.appendices.length, 10, "Unexpected cached CFR appendix count.");
  assert.strictEqual(full.corpus.cfr.graphics.length, 15, "Unexpected referenced CFR graphic count.");
  assert.strictEqual(full.corpus.cfr.coverage.embeddedGraphicsCount, 15, "Unexpected embedded CFR graphic count.");
  assert.deepStrictEqual(full.corpus.cfr.coverage.unavailableGraphics, [], "A referenced CFR graphic is unavailable offline.");
  const fallbackGraphic = full.corpus.cfr.graphics.find(graphic => graphic.sourcePath === "/graphics/er15ja25.063.gif");
  assert(fallbackGraphic.available && fallbackGraphic.fallbackSource?.page === 46 && /^[a-f0-9]{64}$/.test(fallbackGraphic.fallbackSource.sha256), "The GovInfo-PDF fallback graphic lacks reviewed provenance.");
  assert(full.corpus.cfr.sources.every(source => source.bytes > 0 && /^[a-f0-9]{64}$/.test(source.sha256)), "A CFR source is missing its byte count or SHA-256.");
  const cachedUscSections = new Set(full.corpus.title8.sections.map(section => String(section.section).toLowerCase()));
  const mappedLocatorIntersects = locator => {
    const value = String(locator).toLowerCase().replace(" et seq", "").replace(" note", "");
    if (!value.includes("--")) return cachedUscSections.has(value);
    const [start, end] = value.split("--").map(Number);
    return [...cachedUscSections].some(section => /^\d+$/.test(section) && Number(section) >= start && Number(section) <= end);
  };
  assert(full.corpus.cfr.parts.every(part => (part.uscMappings || []).every(mappedLocatorIntersects)), "A stored PTAR mapping does not intersect the cached Title 8 U.S.C. records.");
  const expectedCrossTitleParts = {
    6: ["19", "115"], 19: ["4"], 20: ["416", "654", "655", "656"],
    22: ["22", "40", "41", "42", "46", "50", "51", "53", "62", "89", "131", "172"],
    28: ["8", "9", "44", "65", "68", "1100"], 29: ["501", "502", "503", "504", "506", "507", "508"],
    31: ["501", "597"], 34: ["676", "692"], 42: ["34"], 45: ["50", "51", "400", "401", "410"]
  };
  for (const [title, expectedParts] of Object.entries(expectedCrossTitleParts)) {
    const actual = full.corpus.cfr.parts.filter(part => part.title === Number(title)).map(part => part.part).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    assert.deepStrictEqual(actual, [...expectedParts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), `Unexpected PTAR-selected parts for Title ${title}.`);
  }
  assert.strictEqual(full.corpus.cfr.removedParts.length, 1, "Unexpected removed CFR mapping count.");
  assert.deepStrictEqual({ ...full.corpus.cfr.removedParts[0], sourceBytes: undefined, sourceSha256: undefined }, { id: "45:402", title: 45, part: "402", status: "removed", removedOn: "2026-05-26", uscMappings: ["1255a note"], historyUrl: "https://www.ecfr.gov/api/versioner/v1/versions/title-45.json?part=402", sourceBytes: undefined, sourceSha256: undefined, message: "This mapped part has been removed from the current eCFR; no outdated regulatory text is included." });
  assert(full.corpus.cfr.removedParts[0].sourceBytes > 0 && /^[a-f0-9]{64}$/.test(full.corpus.cfr.removedParts[0].sourceSha256), "Removed-part version history lacks its byte count or source hash.");
  assert(full.corpus.cfr.titleMetadata.bytes > 0 && /^[a-f0-9]{64}$/.test(full.corpus.cfr.titleMetadata.sha256), "eCFR title metadata lacks its byte count or source hash.");
  assert(!full.corpus.cfr.parts.some(part => part.id === "45:402"), "Removed 45 CFR Part 402 was retained as current prose.");
  for (const id of ["8:1.2", "8:214.2", "22:41.12", "22:42.11"]) assert(full.corpus.cfr.sections.some(section => section.id === id), `Missing cached CFR section ${id}.`);
  assert(full.corpus.cfr.parts.some(part => part.id === "22:62"), "22 CFR Part 62 is missing from the cache.");
  const cfr2142 = full.corpus.cfr.sections.find(section => section.id === "8:214.2");
  assert(cfr2142.blocks.some(block => block.a === "(h)(13)(iii)(A)"), "Nested 8 CFR 214.2(h)(13)(iii)(A) path was not normalized.");
  assert(cfr2142.blocks.some(block => block.a === "(h)(6)(xiv)(A)(1)(iii)"), "Six-level CFR paragraph paths are not preserved.");
  assert(cfr2142.blocks.some(block => block.a === "(a)(6)(iii)"), "A CFR sibling after a deep branch was incorrectly left under that branch.");
  assert(!cfr2142.blocks.some(block => block.a === "(a)(5)(ii)(E)(6)"), "The former malformed 8 CFR 214.2(a)(6) path remains in the corpus.");
  const cfr2142RunIn = cfr2142.blocks.find(block => block.a === "(a)(1)");
  assert.deepStrictEqual(cfr2142RunIn?.u?.map(unit => ({ path: unit.a, marker: cfr2142RunIn.x.slice(unit.s, unit.e) })), [
    { path: "(a)", marker: "(a)" },
    { path: "(a)(1)", marker: "(1)" }
  ], "Run-in CFR paragraph units were not separately indexed at their exact text positions.");
  const allCfrBlocks = [];
  const collectCfrBlocks = blocks => { for (const block of blocks || []) { allCfrBlocks.push(block); if (block.t === "note") collectCfrBlocks(block.blocks); } };
  for (const item of [...full.corpus.cfr.sections, ...full.corpus.cfr.appendices]) collectCfrBlocks(item.blocks);
  assert(allCfrBlocks.some(block => block.t === "table" && block.rows?.length), "No CFR table survived normalization.");
  assert(allCfrBlocks.some(block => block.t === "note"), "No CFR note survived normalization.");
  assert(allCfrBlocks.some(block => block.t === "footnote"), "No CFR footnote survived normalization.");
  assert(allCfrBlocks.some(block => block.r?.some(run => run.s)), "No CFR inline formatting runs survived normalization.");
  assert(allCfrBlocks.filter(block => block.r?.length).every(block => block.r.map(run => run.x).join("") === block.x), "CFR formatting runs do not align with the normalized text offsets.");
  const cfrUnitDepths = allCfrBlocks.flatMap(block => (block.u || []).map(unit => (unit.a.match(/\(/g) || []).length));
  assert.strictEqual(Math.max(...cfrUnitDepths), 6, "The CFR corpus does not retain the complete six-level paragraph hierarchy.");
  assert(allCfrBlocks.every(block => (block.u || []).every(unit => /^\([A-Za-z0-9]+\)$/.test(String(block.x || "").slice(unit.s, unit.e)))), "A CFR unit offset does not point to its displayed marker.");
  assert.strictEqual(allCfrBlocks.filter(block => block.t === "graphic").length, 15, "Referenced CFR graphics were not retained in document order.");
  assert.strictEqual(full.corpus.forms.length, 105);
  assert.strictEqual(full.corpus.namedActs.length, 5);
  assert.deepStrictEqual(full.corpus.verification, {}, "Retired classification verification counters remain in the corpus.");
  assert(full.corpus.inaCrosswalk.length > 0);
  assert(full.corpus.policyManual.catalog.length > 0);
  assert.strictEqual(hydratedSource.title8.referenceMetadata.generatedReferences, 14799, "Unexpected House legal-reference count.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.localReferences, 3400, "Unexpected locally resolved House reference count.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.officialSourceOnlyReferences, 11399, "Unexpected official-source-only House reference count.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.sourcesWithReferences, 3135, "Unexpected count of statutory fields with House references.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.nodesWithReferences, 1233, "Unexpected count of operative statutory fields with House references.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.notesWithReferences, 1557, "Unexpected count of statutory-note fields with House references.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.preamblesWithReferences, 55, "Unexpected count of preamble fields with House references.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.houseFootnotesWithReferences, 4, "Unexpected count of House footnote fields containing references.");
  assert.strictEqual(hydratedSource.title8.referenceMetadata.unitTypes, 6973, "Not every cached House statutory unit received its source element type.");
  assert.deepStrictEqual(hydratedSource.title8.referenceMetadata.unitTypeCounts, {
    subsection: 965,
    paragraph: 1817,
    subparagraph: 1973,
    clause: 1391,
    subclause: 614,
    level: 7,
    item: 178,
    subitem: 23,
    subsubitem: 5
  });
  assert.strictEqual(statutoryNode(hydratedSource, "1101", ["a", "15", "O", "ii", "III", "a"]).u, 8);
  assert.deepStrictEqual(hydratedSource.title8.houseFootnoteMetadata, {
    schemaVersion: 1,
    sourceUrl: "https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip",
    sourceReleasePoint: "119-102",
    capturedAt: "2026-08-02",
    footnotes: 118,
    references: 118,
    affectedFields: 116,
    statement: "House editorial footnotes are publisher-supplied editorial content and are not operative statutory text."
  });
  const allHouseFootnotes = hydratedSource.title8.sections.flatMap(section => section.houseEditorialFootnotes || []);
  assert.strictEqual(allHouseFootnotes.length, 118, "Not all House footnotes were extracted structurally.");
  const houseSourceMap = statuteSourceMap(hydratedSource);
  const affectedHouseLocations = new Set(allHouseFootnotes.map(footnote => `${footnote.sourceLocation.sourceKey}.${footnote.sourceLocation.field}`));
  const affectedHouseFields = [...affectedHouseLocations].map(location => {
    const separator = location.lastIndexOf(".");
    const key = location.slice(0, separator);
    const fieldName = location.slice(separator + 1);
    const source = houseSourceMap.get(key);
    const footnoteReferences = source?.[`${fieldName}FootnoteReferences`] || [];
    assert(source, `${key}.${fieldName}: missing cleaned House footnote field.`);
    assert(!/\b\d{1,2}\d{1,2}\s+(?:So in original|See )/.test(String(source[fieldName] || "")), `${key}.${fieldName}: flattened House footnote text remains inline.`);
    return { key, fieldName, source, footnoteReferences };
  });
  assert.strictEqual(affectedHouseFields.length, 116, "Unexpected count of cleaned House footnote fields.");
  assert.strictEqual(affectedHouseFields.reduce((sum, field) => sum + field.footnoteReferences.length, 0), 118, "Unexpected count of offset-based House footnote references.");
  let verifiedHouseReferences = 0;
  const verifyLegalField = (source, field, label) => {
    const property = field === "text" ? "references" : `${field}References`;
    let cursor = 0;
    for (const reference of source?.[property] || []) {
      assert.strictEqual(String(source[field] || "").slice(reference.start, reference.end), reference.text, `${label}.${field}: legal-reference offsets no longer match the displayed text.`);
      assert(reference.start >= cursor, `${label}.${field}: legal references overlap.`);
      cursor = reference.end;
      assert(reference.provenance && reference.ruleId, `${label}.${field}: a generated legal reference lacks provenance.`);
      if (reference.provenance === "house-uslm-ref") verifiedHouseReferences++;
    }
  };
  const verifyStatuteNodes = (section, nodes, path = []) => {
    for (const node of nodes || []) {
      const nodePath = [...path, node.label];
      verifyLegalField(node, "heading", `8 U.S.C. ${section.section}${nodePath.map(value => `(${value})`).join("")}`);
      verifyLegalField(node, "text", `8 U.S.C. ${section.section}${nodePath.map(value => `(${value})`).join("")}`);
      verifyStatuteNodes(section, node.children, nodePath);
    }
  };
  for (const section of hydratedSource.title8.sections) {
    verifyLegalField(section, "heading", `8 U.S.C. ${section.section}`);
    verifyLegalField(section, "preamble", `8 U.S.C. ${section.section}`);
    verifyLegalField(section, "sourceCredit", `8 U.S.C. ${section.section}`);
    verifyStatuteNodes(section, section.body);
    (section.notes || []).forEach((note, index) => { verifyLegalField(note, "heading", `8 U.S.C. ${section.section} note ${index + 1}`); verifyLegalField(note, "text", `8 U.S.C. ${section.section} note ${index + 1}`); });
    (section.houseEditorialFootnotes || []).forEach(footnote => verifyLegalField(footnote, "text", footnote.id));
  }
  assert.strictEqual(verifiedHouseReferences, 14799, "Not every House USLM reference was attached to its exact displayed source span.");
  assert(hydratedSource.legalReferenceMetadata.generatedReferences > 15_000, "The deterministic legal-reference audit did not run across the included corpus.");
  assert(hydratedSource.legalReferenceMetadata.suppressedSelfReferences > 8_000, "The build did not audit and suppress the corpus-wide self-reference set.");
  assert(!hydratedSource.legalReferenceMetadata.rules.includes("context-this-unit"), "The bare self-referential unit rule remains advertised as navigable.");
  const retainedBareSelfReferences = [];
  const collectRetainedBareSelfReferences = value => {
    if (!value || typeof value !== "object") return;
    if (value.ruleId === "context-this-unit") retainedBareSelfReferences.push(value);
    for (const child of Object.values(value)) collectRetainedBareSelfReferences(child);
  };
  collectRetainedBareSelfReferences(hydratedSource);
  assert.strictEqual(retainedBareSelfReferences.length, 0, "The built corpus still contains a bare self-referential link record.");
  const retainedAncestorReferences = [];
  const inspectOperativeReferences = (source, properties, kind, title, section, sourcePath, label) => {
    for (const property of properties) for (const reference of source?.[property] || []) {
      const targetPath = reference.targetPath || [];
      const sameAuthority = reference.resolution === "local" && reference.family === kind && String(reference.targetTitle) === String(title) && String(reference.targetSection) === String(section);
      const ancestor = targetPath.length <= sourcePath.length && targetPath.every((token, index) => String(token).toLowerCase() === String(sourcePath[index]).toLowerCase());
      if (sameAuthority && ancestor) retainedAncestorReferences.push(`${label}.${property}: ${reference.text}`);
    }
  };
  const inspectStatuteAncestors = (section, nodes, path = []) => {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      inspectOperativeReferences(node, ["headingReferences", "references"], "usc", "8", String(section.section), nodePath, `8 U.S.C. ${section.section}${nodePath.map(value => `(${value})`).join("")}`);
      inspectStatuteAncestors(section, node.children, nodePath);
    }
  };
  for (const section of hydratedSource.title8.sections) {
    inspectOperativeReferences(section, ["headingReferences", "preambleReferences"], "usc", "8", String(section.section), [], `8 U.S.C. ${section.section}`);
    inspectStatuteAncestors(section, section.body);
  }
  const inspectCfrAncestors = (section, blocks) => {
    for (const block of blocks || []) {
      const blockPath = [...String(block.a || block.u?.at(-1)?.a || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
      inspectOperativeReferences(block, ["xReferences"], "cfr", String(section.title), String(section.section || ""), blockPath, `${section.title} CFR ${section.section}`);
      if (block.t === "table") for (const row of block.rows || []) for (const cell of row) inspectOperativeReferences(cell, ["xReferences"], "cfr", String(section.title), String(section.section || ""), blockPath, `${section.title} CFR ${section.section} table`);
      if (block.t === "note") inspectCfrAncestors(section, block.blocks);
    }
  };
  for (const section of [...hydratedSource.cfr.sections, ...hydratedSource.cfr.appendices]) {
    inspectOperativeReferences(section, ["headingReferences"], "cfr", String(section.title), String(section.section || ""), [], `${section.title} CFR ${section.section}`);
    inspectCfrAncestors(section, section.blocks);
  }
  assert.deepStrictEqual(retainedAncestorReferences, [], "The built corpus retains verified links to the current operative unit or one of its ancestors.");
  const sharedLegalContext = legalReferenceContext(hydratedSource);
  const fixtureContext = {
    ...sharedLegalContext,
    kind: "usc", title: "8", section: "1154", path: ["b", "1", "A"], sourceId: "fixture",
    inaMap: new Map([["204", { inaSection: "204", uscSection: "1154" }]]),
    uscPaths: new Set([...sharedLegalContext.uscPaths, "1154:b/1", "1154:b/2", "1154:a/2"])
  };
  const familyFixture = "8 U.S.C. 1154(b); INA 204(b); 8 CFR 214.2(h); Pub. L. 104-208; 110 Stat. 3009; 87 FR 70715.";
  const familyReferences = generatedReferences(familyFixture, fixtureContext);
  assert.deepStrictEqual([...new Set(familyReferences.map(reference => reference.family))].sort(), ["cfr", "federal-register", "ina", "public-law", "statutes-at-large", "usc"], "A supported legal citation family was not generated.");
  assert(familyReferences.every(reference => familyFixture.slice(reference.start, reference.end) === reference.text), "An explicit citation fixture lost its exact source span.");
  const relativeFixture = "paragraphs (1) and (2) of this subsection; (a)(2) of this section; such paragraph";
  const relativeReferences = generatedReferences(relativeFixture, fixtureContext);
  assert.deepStrictEqual(relativeReferences.filter(reference => reference.ruleId === "context-named-unit").map(reference => reference.targetPath), [["b", "1"], ["b", "2"]], "A contextual statutory list did not produce a separate target for each written unit.");
  assert(relativeReferences.some(reference => reference.ruleId === "context-path-this-section" && reference.targetPath.join("/") === "a/2"), "A chained path relative to this section was not resolved.");
  assert(relativeReferences.some(reference => reference.ruleId === "ambiguous-antecedent" && reference.resolution === "unresolved"), "An uncertain antecedent was guessed instead of marked unresolved.");
  const bareSelfAudit = { suppressedSelfReferences: 0, suppressedByRule: {}, suppressedByFamily: {} };
  assert.strictEqual(generatedReferences("Transport is forbidden by this section.", { ...fixtureContext, referenceAudit: bareSelfAudit }).length, 0, "A bare reference to its own section remains clickable.");
  assert.strictEqual(bareSelfAudit.suppressedByRule["context-this-unit"], 1, "The bare self-reference was not recorded in the build audit.");
  const ancestorSelfAudit = { suppressedSelfReferences: 0, suppressedByRule: {}, suppressedByFamily: {} };
  assert.strictEqual(generatedReferences("See (b)(1) of this section.", { ...fixtureContext, suppressSelfReferences: true, referenceAudit: ancestorSelfAudit }).length, 0, "A verified link to the current operative unit's ancestor remains clickable.");
  assert.strictEqual(ancestorSelfAudit.suppressedByRule["context-path-this-section"], 1, "The resolved ancestor self-reference was not recorded in the build audit.");
  const title8ActReference = generatedReferences("For purposes of the Act, this section applies.", { ...fixtureContext, kind: "cfr", title: "8", section: "214.2", path: ["h"] });
  assert(title8ActReference.some(reference => reference.text === "the Act" && reference.family === "ina" && reference.resolution === "official-source-only"), "Title 8 CFR context did not recognize ‘the Act’ as the INA.");
  assert(!title8ActReference.some(reference => reference.text.toLowerCase() === "this section"), "A bare CFR self-reference remains clickable.");
  const actFixtureContext = { ...sharedLegalContext, kind: "cfr", title: "8", part: "245", section: "245.1", path: ["b", "4", "ii"], sourceId: "act-fixture" };
  const actSectionFixture = "A special immigrant as defined in section 101(a)(27)(H) or (J) of the Act;";
  const actSectionReferences = generatedReferences(actSectionFixture, actFixtureContext)
    .filter(reference => reference.ruleId === "context-cfr-ina-act-section");
  assert.deepStrictEqual(plain(actSectionReferences.map(reference => ({ text: reference.text, inaSection: reference.inaSection, targetSection: reference.targetSection, targetPath: reference.targetPath, resolution: reference.resolution }))), [
    { text: "section 101(a)(27)(H)", inaSection: "101", targetSection: "1101", targetPath: ["a", "27", "H"], resolution: "local" },
    { text: "(J)", inaSection: "101", targetSection: "1101", targetPath: ["a", "27", "J"], resolution: "local" }
  ], "A CFR citation with an abbreviated alternative did not resolve each exact INA target separately.");
  const multiLevelContinuationFixture = "section 101(a)(15)(A)(i), (G)(i), and (N) of the Act";
  assert.deepStrictEqual(plain(generatedReferences(multiLevelContinuationFixture, { ...actFixtureContext, part: "214" })
    .filter(reference => reference.ruleId === "context-cfr-ina-act-section")
    .map(reference => reference.targetPath)), [["a", "15", "A", "i"], ["a", "15", "G", "i"], ["a", "15", "N"]], "Abbreviated INA alternatives were attached to the wrong structural depth.");
  const invalidContinuationReferences = generatedReferences("section 101(a)(27)(H) or (ZZ) of the Act", actFixtureContext)
    .filter(reference => reference.ruleId === "context-cfr-ina-act-section");
  assert.deepStrictEqual(invalidContinuationReferences.map(reference => reference.text), ["section 101(a)(27)(H)"], "An abbreviated INA target absent from the indexed statute was guessed from its typography.");
  assert(!generatedReferences("section 1110(b) of the Act", { ...actFixtureContext, title: "20", part: "416", section: "416.250" }).some(reference => reference.ruleId === "context-cfr-ina-act-section"), "A Social Security Act reference was mistaken for an INA reference outside an INA-defined CFR scope.");
  assert(!generatedReferences("section 3 of the Act of February 5, 1917", actFixtureContext).some(reference => reference.ruleId === "context-cfr-ina-act-section"), "A citation to a named historical Act was mistaken for an INA citation merely because it appears in Title 8 CFR.");
  assert(generatedReferences("section 101(a)(27)(H) of the Immigration and Nationality Act", { ...actFixtureContext, title: "28", part: "65" }).some(reference => reference.ruleId === "context-cfr-ina-act-section" && reference.targetPath.join("/") === "a/27/H"), "A CFR citation naming the Immigration and Nationality Act explicitly was not recognized across titles.");
  assert.strictEqual(generatedReferences("Form I-130 requires 3 years of evidence.", fixtureContext).length, 0, "A known noncitation pattern produced a false legal reference.");

  const findCfrBlock = (section, fragment) => {
    let found = null;
    const visit = blocks => {
      for (const block of blocks || []) {
        if (String(block.x || "").includes(fragment)) { found = block; return; }
        if (block.t === "note") visit(block.blocks);
        if (found) return;
      }
    };
    visit(section?.blocks);
    return found;
  };
  const cfr2451 = hydratedSource.cfr.sections.find(section => section.id === "8:245.1");
  const immediateRelativeBlock = findCfrBlock(cfr2451, "An immediate relative as defined in section 201(b) of the Act");
  const specialImmigrantBlock = findCfrBlock(cfr2451, "A special immigrant as defined in section 101(a)(27)(H) or (J) of the Act");
  const immediateRelativeActReferences = immediateRelativeBlock.xReferences.filter(reference => reference.ruleId === "context-cfr-ina-act-section");
  const specialImmigrantActReferences = specialImmigrantBlock.xReferences.filter(reference => reference.ruleId === "context-cfr-ina-act-section");
  assert.deepStrictEqual(plain(immediateRelativeActReferences.map(reference => ({ text: reference.text, targetSection: reference.targetSection, targetPath: reference.targetPath, resolution: reference.resolution }))), [
    { text: "section 201(b)", targetSection: "1151", targetPath: ["b"], resolution: "local" }
  ], "8 CFR 245.1(b)(4)(i) did not receive its local INA 201(b) link.");
  assert.deepStrictEqual(plain(specialImmigrantActReferences.map(reference => ({ text: reference.text, targetSection: reference.targetSection, targetPath: reference.targetPath, resolution: reference.resolution }))), [
    { text: "section 101(a)(27)(H)", targetSection: "1101", targetPath: ["a", "27", "H"], resolution: "local" },
    { text: "(J)", targetSection: "1101", targetPath: ["a", "27", "J"], resolution: "local" }
  ], "8 CFR 245.1(b)(4)(ii) did not retain both independently hoverable statutory targets through packing.");
  assert(hydratedSource.legalReferenceMetadata.rules.includes("context-cfr-ina-act-section"), "The CFR-to-INA parser rule is absent from the build audit metadata.");

  let verifiedCfrReferences = 0;
  const verifyCfrBlocks = (section, blocks) => {
    for (const block of blocks || []) {
      verifyLegalField(block, "x", section.id);
      verifiedCfrReferences += block.xReferences?.length || 0;
      if (block.t === "table") for (const row of block.rows || []) for (const cell of row) { verifyLegalField(cell, "x", `${section.id} table`); verifiedCfrReferences += cell.xReferences?.length || 0; }
      if (block.t === "note") verifyCfrBlocks(section, block.blocks);
    }
  };
  for (const section of [...hydratedSource.cfr.sections, ...hydratedSource.cfr.appendices]) { verifyLegalField(section, "heading", section.id); verifyCfrBlocks(section, section.blocks); }
  assert(verifiedCfrReferences > 10_000, "The build-time CFR reference audit did not cover the regulation blocks.");
  assert.strictEqual(full.corpus.definitions.entries.length, 498, "Unexpected definition record count.");
  assert.strictEqual(full.corpus.definitions.schemaVersion, 3, "The definitions catalog schema was not upgraded for machine-readable applicability targets.");
  assert.strictEqual(full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "uscis-glossary").length, 267, "Unexpected USCIS Glossary definition count.");
  assert.strictEqual(full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "ina").length, 199, "Unexpected indexed INA term count.");
  assert.strictEqual(full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "cfr").length, 32, "Unexpected 8 CFR 1.2 definition count.");
  assert.strictEqual(full.corpus.definitions.glossaryVerification.entries, 267, "USCIS Glossary verification metadata does not match the catalog.");
  assert.deepStrictEqual(full.corpus.definitions.inaVerification, {
    mappedSections: 176,
    lexicalFields: 168,
    definitionFields: 167,
    definitionStatements: 170,
    definitionEntries: 199,
    indexedTerms: 199,
    excludedMentions: [{
      citation: "INA 245A(g)(1)(A)",
      uscCitation: "8 U.S.C. 1255a(g)(1)(A)",
      text: "regulations establishing a definition of the term “resided continuously”, as used in this section, and the evidence needed to establish that an alien has resided continuously in the United States for purposes of this section, and"
    }],
    unresolvedScopes: []
  }, "The embedded INA definition completeness audit changed or left an unresolved scope.");
  const independentInaCatalog = deriveInaCatalog(hydratedSource, rawDefinitionSource);
  assert.deepStrictEqual(independentInaCatalog.audit, full.corpus.definitions.inaVerification, "A fresh scan of the House-backed INA corpus does not reproduce the embedded definition audit.");
  assert.strictEqual(independentInaCatalog.entries.reduce((total, entry) => total + entry.aliases.length, 0), 199, "The INA scan did not index every quoted term in multi-term definition statements.");
  assert.strictEqual(new Set(independentInaCatalog.entries.map(entry => entry.sourceFilter)).size, 41, "The Defined-in registry does not cover every INA section containing a definition.");
  assert.deepStrictEqual(definitionStatementGroups('The terms “Commissioner” and “Deputy Commissioner” mean the two offices, respectively.').map(group => group.terms), [["Commissioner", "Deputy Commissioner"]], "A shared multi-term definition is not indexed under every quoted term.");
  assert.deepStrictEqual(definitionStatementGroups('The term “United States” as used in this section includes the territory. The term “person” as used in this section shall be deemed to mean an individual.').map(group => group.terms), [["United States"], ["person"]], "Two distinct definitions in one legal field were merged.");
  assert.deepStrictEqual(definitionStatementGroups('The term “capital”—', true).map(group => group.terms), [["capital"]], "A definition completed by statutory descendants was rejected for lacking a prose verb.");
  const structuralDefinitionFixture = definitionStatementGroups('The term “child” means a person who is—', true)[0];
  assert(structuralDefinitionFixture.structural && structuralDefinitionFixture.childInsertionOffset === structuralDefinitionFixture.text.length, "A definition verb before an em dash still drops its statutory descendants.");
  const structuralPostambleFixture = definitionStatementGroups('The term “example” means any person who— This trailing sentence remains part of the definition.', true)[0];
  assert(structuralPostambleFixture.structural && structuralPostambleFixture.childInsertionOffset < structuralPostambleFixture.text.length, "A structural definition cannot preserve text that follows its child list.");
  const structuralColonFixture = definitionStatementGroups('The term “facility” means a hospital under 42 U.S.C. 1395ww that meets the following requirements:', true)[0];
  assert(structuralColonFixture.structural && structuralColonFixture.childInsertionOffset === structuralColonFixture.text.length, "A colon-introduced statutory definition list was not retained.");
  assert.deepStrictEqual(definitionStatementGroups('regulations establishing a definition of the term “resided continuously”, as used in this section, and the required evidence.'), [], "A direction to create a regulatory definition was mistaken for statutory definition text.");
  assert.deepStrictEqual(definitionStatementGroups('The term “Consular Report of Birth” refers to the report designated as a “Report of Birth Abroad”.').map(group => group.terms), [["Consular Report of Birth"]], "Quoted wording inside a definition was mistaken for another defined term.");
  const mappedInaByUsc = new Map(hydratedSource.inaCrosswalk.filter(item => item.hasEquivalent && !item.isNote).map(item => [String(item.uscSection), item]));
  let independentlyScannedLexicalFields = 0;
  let independentlyScannedDefinitionFields = 0;
  const independentlyExcludedDefinitionMentions = [];
  for (const section of hydratedSource.title8.sections) {
    const mapping = mappedInaByUsc.get(String(section.section));
    if (!mapping) continue;
    for (const [field, value] of [["heading", section.heading], ["preamble", section.preamble]]) assert(!/\bthe terms?\s+[“"]/i.test(String(value || "")), `INA ${mapping.inaSection} ${field} contains unscanned definition language.`);
    const walk = nodes => {
      for (const node of nodes || []) {
        if (/\bthe terms?\s+[“"]/i.test(node.heading || "")) throw new Error(`INA ${mapping.inaSection}${node.path.map(part => `(${part})`).join("")} heading contains unscanned definition language.`);
        if (/\bthe terms?\s+[“"]/i.test(node.text || "")) {
          independentlyScannedLexicalFields++;
          const groups = definitionStatementGroups(node.text, Boolean(node.children?.length));
          if (groups.length) independentlyScannedDefinitionFields++;
          else independentlyExcludedDefinitionMentions.push(`INA ${mapping.inaSection}${node.path.map(part => `(${part})`).join("")}`);
        }
        walk(node.children);
      }
    };
    walk(section.body);
  }
  assert.strictEqual(independentlyScannedLexicalFields, 168, "The full INA field scan found a new or missing ‘the term’ field.");
  assert.strictEqual(independentlyScannedDefinitionFields, 167, "The full INA field scan found a new or missing qualifying definition field.");
  assert.deepStrictEqual(independentlyExcludedDefinitionMentions, ["INA 245A(g)(1)(A)"], "A lexical ‘the term’ field was omitted without the reviewed non-definition exception.");

  const definitionScopes = new Map(full.corpus.definitions.scopes.map(scope => [scope.id, scope]));
  assert.strictEqual(definitionScopes.get("uscis-policy")?.label, "USCIS Policy", "The USCIS glossary applicability is missing.");
  assert.strictEqual(definitionScopes.get("ina-chapter")?.label, "Entire INA", "The chapter-wide INA definition scope is not plainly labeled.");
  assert.strictEqual(definitionScopes.get("cfr-chapter-i")?.label, "Regulation (8 CFR Chapter I)", "The regulation scope does not use the official Roman-numeral chapter label.");
  assert(full.corpus.definitions.scopes.filter(scope => scope.category === "law").every(scope => Array.isArray(scope.targets) && scope.targets.length), "A legal definition scope lacks machine-readable applicability targets.");
  assert.deepStrictEqual(plain(definitionScopes.get("ina-subchapters-i-ii").targets), [{ kind: "subchapter", number: "I" }, { kind: "subchapter", number: "II" }], "The family-law child definition scope does not preserve its two statutory subchapters.");
  assert.deepStrictEqual(plain(definitionScopes.get("ina-subchapter-iii").targets), [{ kind: "subchapter", number: "III" }], "The nationality child definition scope does not remain isolated to subchapter III.");
  assert.deepStrictEqual(plain(definitionScopes.get("cfr-chapter-i").targets), [{ kind: "cfr-chapter", title: "8", number: "I" }], "The 8 CFR 1.2 scope is not isolated to Title 8, Chapter I.");
  const substantialDefinition = full.corpus.definitions.entries.find(entry => entry.citation === "INA 101(a)(45)" && entry.term === "substantial");
  const extraordinaryAbilityDefinition = full.corpus.definitions.entries.find(entry => entry.citation === "INA 101(a)(46)" && entry.term === "extraordinary ability");
  assert.deepStrictEqual(plain(substantialDefinition.annotationTargets), [{ kind: "ina", inaSection: "101", path: ["a", "15", "E"] }], "The substantial definition can leak beyond the treaty-trader classification path.");
  assert.deepStrictEqual(plain(extraordinaryAbilityDefinition.annotationTargets), [{ kind: "ina", inaSection: "101", path: ["a", "15", "O", "i"] }], "The arts-specific extraordinary-ability definition can leak beyond its classification path.");
  assert(!full.corpus.definitions.scopes.some(scope => scope.label === "INA generally"), "The ambiguous INA generally label remains in the definition scopes.");
  assert(full.corpus.definitions.sourceFilters.some(filter => filter.id === "law" && filter.label === "Law"), "Defined-in filters are missing the Law category.");
  assert(full.corpus.definitions.scopeFilters.some(filter => filter.id === "law" && filter.label === "Law"), "Applicability filters are missing the Law category.");
  const sourceFilters = new Map(full.corpus.definitions.sourceFilters.map(filter => [filter.id, filter]));
  assert.deepStrictEqual(sourceFilters.get("ina-statute"), { id: "ina-statute", label: "Statute", parentId: "law" }, "Defined-in Statute is not nested under Law.");
  assert.deepStrictEqual(sourceFilters.get("ina-101-h"), { id: "ina-101-h", label: "INA 101(h)", parentId: "ina-statute" }, "INA 101(h) is not a second-level Defined-in option.");
  assert.deepStrictEqual(sourceFilters.get("ina-212"), { id: "ina-212", label: "INA 212", parentId: "ina-statute" }, "A newly indexed INA section is missing from the Defined-in hierarchy.");
  assert.deepStrictEqual(sourceFilters.get("8-cfr-1-2"), { id: "8-cfr-1-2", label: "Regulation (8 CFR 1.2)", parentId: "law" }, "The regulatory source filter is not plainly labeled or nested under Law.");
  const scopeFilters = new Map(full.corpus.definitions.scopeFilters.map(filter => [filter.id, filter]));
  assert.deepStrictEqual(scopeFilters.get("ina-any"), { id: "ina-any", label: "Statute (Any part of INA)", parentId: "law" }, "The any-part INA applicability option is not nested under Law.");
  assert.strictEqual(scopeFilters.get("ina-chapter")?.parentId, "ina-any", "Entire INA is not a second-level applicability option.");
  assert.strictEqual(scopeFilters.get("cfr-chapter-i")?.parentId, "law", "The regulation applicability scope is not directly nested under Law.");
  for (const entry of full.corpus.definitions.entries) {
    assert(entry.id && entry.term && entry.text && entry.locator && entry.url && entry.captureDate, `Incomplete definition provenance for ${entry.id || entry.term}.`);
    assert(Array.isArray(entry.aliases) && entry.aliases.length > 0, `Definition ${entry.id} has no searchable term aliases.`);
    assert(definitionScopes.has(entry.scopeId), `Definition ${entry.id} has an unknown applicability scope.`);
    assert(/^https:\/\/(?:uscode\.house\.gov|www\.ecfr\.gov|www\.uscis\.gov)\//.test(entry.url), `Definition ${entry.id} uses an unapproved source URL.`);
    if (entry.specificScope) assert(entry.text.includes(entry.specificScope), `Definition ${entry.id} has scope text that is not quoted from its source.`);
  }
  const definitionsFor = term => full.corpus.definitions.entries.filter(entry => entry.aliases.some(alias => alias.toLowerCase() === term.toLowerCase()));
  assert.deepStrictEqual(definitionsFor("child").map(entry => entry.citation), ["USCIS Glossary", "INA 101(b)(1)", "INA 101(c)(1)"], "USCIS Glossary is not the first of the three child definitions.");
  assert.deepStrictEqual(definitionsFor("aggravated felony").map(entry => entry.citation), ["INA 101(a)(43)", "8 CFR 1.2"], "Statutory and regulatory aggravated-felony definitions were not retained separately.");
  assert.deepStrictEqual(definitionsFor("lawfully admitted for permanent residence").map(entry => entry.citation), ["INA 101(a)(20)", "8 CFR 1.2"], "Duplicate LPR definitions were not retained separately.");
  assert.strictEqual(definitionsFor("ineligible to citizenship").length, 1, "Quoted statutory punctuation leaked into the term index.");
  assert(definitionsFor("immediate relatives").some(entry => entry.citation === "INA 201(b)(2)(A)(i)"), "INA 201's immediate-relative definition was not added.");
  assert.deepStrictEqual(definitionsFor("specialty occupation").filter(entry => entry.sourceFamily === "ina").map(entry => entry.citation), ["INA 214(i)(1)", "INA 214(i)(3)"], "The two differently scoped specialty-occupation definitions were not kept separate.");
  assert(definitionsFor("alien child").some(entry => entry.citation === "INA 216A(f)(2)"), "A second term sharing a definition statement was not indexed.");
  assert.deepStrictEqual(["Commissioner", "Deputy Commissioner"].map(term => definitionsFor(term).find(entry => entry.citation === "INA 101(a)(8)")?.term), ["Commissioner", "Deputy Commissioner"], "Jointly defined INA 101(a)(8) terms are not separately browsable catalog entries.");
  assert(definitionsFor("burglary").some(entry => entry.citation === "INA 236(c)(2)"), "One of INA 236's six jointly defined terms was not indexed.");
  assert.deepStrictEqual(definitionsFor("domestic violence").filter(entry => entry.sourceFamily === "ina").map(entry => entry.citation), ["INA 214(d)(3)(A)", "INA 214(r)(5)(A)"], "Repeated multi-term definitions with different applicability were merged or omitted.");

  const inaDefinitions = hydratedSource.definitions.entries.filter(entry => entry.sourceFamily === "ina");
  assert.deepStrictEqual(independentInaCatalog.entries, inaDefinitions, "The embedded INA definition records do not exactly match a fresh corpus derivation.");
  const statuteSectionsById = new Map(hydratedSource.title8.sections.map(section => [section.id, section]));
  const sectionLegalText = section => {
    const values = [section.preamble || ""];
    const walk = nodes => { for (const node of nodes || []) { values.push(node.text || ""); walk(node.children); } };
    walk(section.body);
    return values.join("\n");
  };
  let structuralInaDefinitionCount = 0;
  for (const entry of inaDefinitions) {
    const section = statuteSectionsById.get(entry.sectionId);
    assert(section, `${entry.citation}: definition has no source section.`);
    const node = statutoryNode(hydratedSource, section.section, entry.path);
    assert(Number.isInteger(entry.textStart) && Number.isInteger(entry.textEnd) && entry.textEnd > entry.textStart, `${entry.citation}: definition has no exact source range.`);
    assert.strictEqual(entry.text, node.text.slice(entry.textStart, entry.textEnd), `${entry.citation}: definition text is not an exact substring of the cached House text.`);
    const sourceGroup = definitionStatementGroups(node.text, Boolean(node.children?.length)).find(group => group.textStart === entry.textStart && group.textEnd === entry.textEnd);
    assert(sourceGroup, `${entry.citation}: definition range is not reproduced by the qualifying-statement parser.`);
    assert.deepStrictEqual(entry.aliases, [entry.term], `${entry.citation}: an INA term entry carries unrelated aliases.`);
    assert(sourceGroup.terms.includes(entry.term), `${entry.citation}: catalog term is not quoted in its source statement.`);
    assert.deepStrictEqual(entry.children, [], `${entry.citation}: the definition catalog duplicates statutory child text instead of linking the authoritative source hierarchy.`);
    assert.strictEqual(entry.childInsertionOffset, sourceGroup.childInsertionOffset, `${entry.citation}: the statutory child-list insertion point changed during catalog generation.`);
    if (sourceGroup.structural) {
      structuralInaDefinitionCount++;
      assert(node.children?.length, `${entry.citation}: a structural definition has no statutory child units.`);
      assert(/[—:]$/.test(entry.text.slice(0, entry.childInsertionOffset)), `${entry.citation}: the linked child units are not inserted after the source list introducer.`);
    }
    assert(sectionLegalText(section).includes(entry.sourceScope), `${entry.citation}: source-scope wording is not exact text from its source section.`);
    for (const reference of entry.references || []) assert.strictEqual(entry.text.slice(reference.start, reference.end), reference.text, `${entry.citation}: a cropped legal-reference offset no longer matches its source span.`);
  }
  assert.strictEqual(structuralInaDefinitionCount, 42, "The corpus-wide structural-definition audit found a new incomplete or misclassified child list.");
  const definitionsBySourceNode = new Map();
  for (const entry of inaDefinitions) {
    const key = `${entry.sectionId}:${entry.path.join(".")}`;
    if (!definitionsBySourceNode.has(key)) definitionsBySourceNode.set(key, []);
    definitionsBySourceNode.get(key).push(entry);
  }
  for (const entries of definitionsBySourceNode.values()) {
    const sourceRanges = [...new Map(entries.map(entry => [`${entry.textStart}:${entry.textEnd}`, entry])).values()];
    if (sourceRanges.length < 2) continue;
    const section = statuteSectionsById.get(entries[0].sectionId);
    const node = statutoryNode(hydratedSource, section.section, entries[0].path);
    assert.strictEqual(sourceRanges.sort((left, right) => left.textStart - right.textStart).map(entry => entry.text).join(" "), node.text, `${entries[0].citation}: multiple definitions at one citation do not reconstruct the exact source field.`);
  }
  const scopeLabelFor = (term, citation) => {
    const matches = definitionsFor(term).filter(entry => entry.citation === citation);
    const entry = matches.find(candidate => candidate.term.toLowerCase() === term.toLowerCase()) || matches[0];
    return definitionScopes.get(entry?.scopeId)?.label;
  };
  assert.strictEqual(scopeLabelFor("2–A floor", "INA 202(a)(4)(A)(ii)"), "INA 202(a)(4) only", "A ‘this paragraph’ definition resolved to the wrong statutory level.");
  assert.strictEqual(scopeLabelFor("subsection (e) ceiling", "INA 202(a)(4)(B)(ii)"), "INA 202(a)(4)(B)(i) only", "A definition applying in a sibling clause resolved to itself.");
  assert.strictEqual(scopeLabelFor("terrorist activity", "INA 212(a)(3)(B)(iii)"), "Entire INA", "A chapter-wide definition was narrowed to its source provision.");
  assert.strictEqual(scopeLabelFor("facility", "INA 212(m)(6)"), "INA 212(m) and INA 101(a)(15)(H)(i)(c) only", "A definition with two applicability targets lost one target.");
  assert.strictEqual(scopeLabelFor("longshore work", "INA 258(b)(2)"), "INA 258 only", "A sibling exception to a section-wide definition was assigned the wrong scope.");
  assert.strictEqual(definitionScopes.get(definitionsFor("parent").find(entry => entry.citation === "INA 101(b)(2)" && entry.scopeId.startsWith("ina-scope-"))?.scopeId)?.label, "INA 101(b)(1)(F) and INA 101(b)(1)(G)(i) only", "The narrower second parent definition at INA 101(b)(2) lost its two applicability targets.");
  assert.strictEqual(definitionScopes.get("ina-chapter").text, statutoryNode(fullSource, "1101", ["a"]).text);
  assert.strictEqual(definitionScopes.get("ina-subchapters-i-ii").text, statutoryNode(fullSource, "1101", ["b"]).text);
  assert.strictEqual(definitionScopes.get("ina-subchapter-iii").text, statutoryNode(fullSource, "1101", ["c"]).text);

  for (const build of [full, uncompressed]) {
    const scripts = executableScripts(build.html);
    assert.strictEqual(scripts.length, 5);
    scripts.forEach((source, index) => new vm.Script(source, { filename: `${build.fileName}:script-${index + 1}` }));
    assert(!/<script[^>]+src=/i.test(build.html), `${build.fileName}: external script detected.`);
    assert(build.html.includes('const ECFR_ORIGIN = "https://www.ecfr.gov";'), `${build.fileName}: direct eCFR updater missing.`);
    assert(!/fetch\s*\([^)]*(?:github|inasearch)/i.test(build.html), `${build.fileName}: updater references a non-authoritative distribution source.`);
    const started = performance.now();
    const loaded = await runBootstrap(build);
    const elapsed = performance.now() - started;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(loaded.corpus)), build.corpus, `${build.fileName}: browser-standard loader changed data.`);
    assert.strictEqual(loaded.errors.corpus, false);
    assert(elapsed < 3000, `${build.fileName}: bootstrap corpus loading took ${elapsed.toFixed(0)} ms.`);

    const safariScriptText = await runBootstrap(build, { scriptTextOnly: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(safariScriptText.corpus)), build.corpus, `${build.fileName}: script-text fallback changed data.`);
    assert.strictEqual(safariScriptText.errors.corpus, false);

    const attributeManifestFallback = await runBootstrap(build, { manifestTextUnreadable: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(attributeManifestFallback.corpus)), build.corpus, `${build.fileName}: manifest-attribute fallback changed data.`);
    assert.strictEqual(attributeManifestFallback.errors.corpus, false);

    const unsupported = await runBootstrap(build, { missingDecompressionStream: true });
    if (build.manifest.compression === "gzip") {
      assert.strictEqual(unsupported.corpus, null);
      assert.strictEqual(unsupported.errors.corpus, true);
      assert.match(unsupported.errors.corpusMessage, /does not support the standard gzip decompression API/);

      const badBase64 = await runBootstrap(build, { payload: `!${payloadBlock(build.html).slice(1)}` });
      assert.strictEqual(badBase64.corpus, null);
      assert.strictEqual(badBase64.errors.corpus, true);

      const corruptedBytes = Buffer.from(build.compressed);
      corruptedBytes[Math.floor(corruptedBytes.length / 2)] ^= 1;
      const badGzip = await runBootstrap(build, { payload: corruptedBytes.toString("base64") });
      assert.strictEqual(badGzip.corpus, null);
      assert.strictEqual(badGzip.errors.corpus, true);
      assert.match(badGzip.errors.corpusMessage, /SHA-256 integrity check/);
    } else {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(unsupported.corpus)), build.corpus, `${build.fileName}: uncompressed loading incorrectly requires DecompressionStream.`);
      assert.strictEqual(unsupported.errors.corpus, false);
      const badJson = await runBootstrap(build, { payload: `!${build.payload.slice(1)}` });
      assert.strictEqual(badJson.corpus, null);
      assert.strictEqual(badJson.errors.corpus, true);
      assert.match(badJson.errors.corpusMessage, /SHA-256 integrity check/);
    }

    const corpusBlockBefore = build.html.match(/<!-- INA_SEARCH_CORPUS_DATA_START -->[\s\S]*?<!-- INA_SEARCH_CORPUS_DATA_END -->/)[0];
    const manifestBlockBefore = build.html.match(/<!-- INA_SEARCH_CORPUS_MANIFEST_DATA_START -->[\s\S]*?<!-- INA_SEARCH_CORPUS_MANIFEST_DATA_END -->/)[0];
    const edited = JSON.parse(JSON.stringify(build.profile));
    edited.notes = [{ id: "test", title: "", body: "Corpus safety </script> \u2028 test", tags: [], links: [] }];
    const rewritten = replaceProfileOnly(build.html, edited);
    assert.strictEqual(rewritten.match(/<!-- INA_SEARCH_CORPUS_DATA_START -->[\s\S]*?<!-- INA_SEARCH_CORPUS_DATA_END -->/)[0], corpusBlockBefore);
    assert.strictEqual(rewritten.match(/<!-- INA_SEARCH_CORPUS_MANIFEST_DATA_START -->[\s\S]*?<!-- INA_SEARCH_CORPUS_MANIFEST_DATA_END -->/)[0], manifestBlockBefore);
    assert.strictEqual(jsonBlock(rewritten, "inaSearchProfileData").notes[0].body, edited.notes[0].body);

    if (build.compressed) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ina-search-audit-"));
      const gzipPath = path.join(temp, "INASearch-Corpus.json.gz");
      fs.writeFileSync(gzipPath, build.compressed);
      const ordinaryGzip = spawnSync("/usr/bin/gzip", ["-dc", gzipPath], { encoding: null, maxBuffer: 40_000_000 });
      assert.strictEqual(ordinaryGzip.status, 0, ordinaryGzip.stderr?.toString());
      assert.strictEqual(sha256(ordinaryGzip.stdout), build.manifest.uncompressedSha256);
    }
  }

  const updaterTimers = [];
  const updaterStatuses = [];
  let updaterFetchCalls = 0, lastUpdaterSignal = null;
  const updaterStorage = {
    loadActiveCorpus: async () => null,
    getMetadata: async () => null,
    setMetadata: async () => null,
    ensureActiveCorpus: async () => null
  };
  const updaterContext = {
    globalThis: null,
    AbortController,
    Blob,
    TextEncoder,
    URL,
    URLSearchParams,
    performance: { now: () => 0 },
    navigator: {},
    structuredClone,
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; updaterTimers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch(_url, options) {
      updaterFetchCalls += 1;
      lastUpdaterSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    },
    INASearchStorage: updaterStorage
  };
  updaterContext.globalThis = updaterContext;
  vm.createContext(updaterContext);
  new vm.Script(scriptBody(full.html, "inaSearchUpdaterRuntime"), { filename: "inaSearchUpdaterRuntime" }).runInContext(updaterContext);
  const updaterFixtureCorpus = { schemaVersion: 4, corpusVersion: "fixture", cfr: { parts: [], sections: [], appendices: [], currentThrough: {} } };
  let updaterEnabled = false;
  let stopUpdater = updaterContext.INASearchUpdater.start(updaterFixtureCorpus, { enabled: () => updaterEnabled, startDelayMs: 0, onStatus: status => updaterStatuses.push(plain(status)) });
  await updaterTimers.shift().callback();
  assert.strictEqual(updaterFetchCalls, 0, "Local-only startup made an eCFR request.");
  stopUpdater();

  updaterEnabled = true;
  stopUpdater = updaterContext.INASearchUpdater.start(updaterFixtureCorpus, { enabled: () => updaterEnabled, startDelayMs: 0, onStatus: status => updaterStatuses.push(plain(status)) });
  const activeRun = updaterTimers.shift().callback();
  for (let attempt = 0; attempt < 10 && updaterFetchCalls === 0; attempt += 1) await Promise.resolve();
  assert.strictEqual(updaterFetchCalls, 1, "The enabled updater did not begin its eCFR check.");
  updaterEnabled = false;
  stopUpdater();
  await activeRun;
  assert.strictEqual(lastUpdaterSignal.aborted, true, "Turning automatic updates off did not abort the active HTTP request.");
  assert.strictEqual(updaterStatuses.at(-1)?.state, "disabled", "Cancelling an active update did not report local-only mode.");
  assert.strictEqual(updaterStatuses.at(-1)?.networkActivity, false, "The disabled updater status does not promise zero automatic network activity.");

  const fullPayload = payloadBlock(full.html);
  const uncompressedPayload = corpusPayloadText(uncompressed.html);
  const rebuild = spawnSync(process.execPath, [path.join(root, "tools", "build-standalone.js")], { cwd: root, encoding: "utf8" });
  assert.strictEqual(rebuild.status, 0, rebuild.stderr);
  assert.strictEqual(payloadBlock(fs.readFileSync(full.filePath, "utf8")), fullPayload, "Full gzip output is not deterministic.");
  assert.strictEqual(corpusPayloadText(fs.readFileSync(uncompressed.filePath, "utf8")), uncompressedPayload, "Uncompressed JSON output is not deterministic.");

  const fallbackSource = fs.readFileSync(path.join(root, "src", "INASearch.template.html"), "utf8");
  assert(fallbackSource.includes('id="noteAssociations"') && fallbackSource.includes('data-note-unit-kind='), "The citation-associated Notes editor or legal-unit note buttons are missing.");
  assert(!fallbackSource.includes('id="courseStructureEditor"') && !fallbackSource.includes('data-note-week='), "Retired course-note controls remain in the application shell.");
  const tutorialPracticeState = { citation: null, view: "search", filter: "all", searchScopeActive: false, searchScopeMode: "in", searchScope: null };
  const tutorialPracticeElements = {
    search: { value: "INA 203" },
    definitionTermFilter: { value: "" },
    noteBody: { value: "" }
  };
  const tutorialPracticeSatisfied = extractedFunction(fallbackSource, "tutorialPracticeSatisfied", "checkTutorialPractice", {
    state: tutorialPracticeState,
    els: tutorialPracticeElements,
    normalize: value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim(),
    Boolean,
    Number
  });
  assert.strictEqual(tutorialPracticeSatisfied({ kind: "search-exact", expected: "INA 203" }), false, "Exact text completes a citation-search tutorial step before INASearch recognizes a valid citation.");
  tutorialPracticeState.citation = { valid: true };
  assert.strictEqual(tutorialPracticeSatisfied({ kind: "search-exact", expected: "INA 203" }), true, "A recognized live result does not complete its tutorial step unless the user presses an unnecessary extra key.");
  tutorialPracticeElements.noteBody.value = "A short practice note";
  assert.strictEqual(tutorialPracticeSatisfied({ kind: "note-draft", minLength: 8 }), true, "A sufficient practice note does not complete its tutorial step.");
  const tutorialAutoAdvanceState = { tutorialActive: { moduleId: "quick-start", stepIndex: 0, passedSteps: new Set() } };
  const tutorialAutoAdvanceModule = { id: "quick-start", steps: [{ id: "practice-citation", practice: { kind: "search-exact", expected: "INA 203" } }] };
  let tutorialAdvanceCount = 0;
  let tutorialProgressCount = 0;
  const checkTutorialPractice = extractedFunction(fallbackSource, "checkTutorialPractice", "renderTutorialStep", {
    state: tutorialAutoAdvanceState,
    TUTORIAL_BY_ID: new Map([[tutorialAutoAdvanceModule.id, tutorialAutoAdvanceModule]]),
    tutorialPracticeSatisfied: () => true,
    updateTutorialProgress: () => { tutorialProgressCount += 1; },
    setTimeout: callback => { callback(); return 1; },
    advanceTutorial: () => { tutorialAdvanceCount += 1; tutorialAutoAdvanceState.tutorialActive.stepIndex += 1; }
  });
  checkTutorialPractice({ type: "keydown", key: "Enter" });
  assert(tutorialAutoAdvanceState.tutorialActive.passedSteps.has("practice-citation"), "Successful tutorial practice is not recorded before advancing.");
  assert.strictEqual(tutorialProgressCount, 1, "Successful tutorial practice does not update progress exactly once.");
  assert.strictEqual(tutorialAdvanceCount, 1, "Successful tutorial practice does not advance automatically exactly once.");
  const tutorialPromptState = { tutorialActive: null, tutorialPromptDismissed: false };
  const tutorialPromptProgress = { status: "not-started" };
  const tutorialPromptAttributes = new Map();
  const tutorialPromptElements = {
    tutorialStartPrompt: { hidden: true },
    tutorialStartPromptTitle: { textContent: "" },
    tutorialStartPromptBody: { textContent: "" },
    tutorialMenuButton: {
      title: "",
      classList: { toggle: () => {} },
      setAttribute: (name, value) => tutorialPromptAttributes.set(name, value),
      removeAttribute: name => tutorialPromptAttributes.delete(name)
    }
  };
  let quickStartCompleteForPrompt = false;
  const renderTutorialLauncher = extractedFunction(fallbackSource, "renderTutorialLauncher", "updateTutorialProgress", {
    tutorialProgressEntry: () => tutorialPromptProgress,
    quickStartCompleted: () => quickStartCompleteForPrompt,
    state: tutorialPromptState,
    els: tutorialPromptElements
  });
  renderTutorialLauncher();
  assert.strictEqual(tutorialPromptElements.tutorialStartPrompt.hidden, false, "The Quick Start callout is not visible to a new user.");
  assert.strictEqual(tutorialPromptElements.tutorialStartPromptTitle.textContent, "New to INASearch?", "The new-user callout has the wrong heading.");
  assert.strictEqual(tutorialPromptAttributes.get("aria-describedby"), "tutorialStartPromptText", "The Tutorials button is not associated with its visible callout.");
  tutorialPromptState.tutorialPromptDismissed = true;
  renderTutorialLauncher();
  assert.strictEqual(tutorialPromptElements.tutorialStartPrompt.hidden, true, "Closing the Quick Start callout does not keep it dismissed in the current tab.");
  assert.strictEqual(tutorialPromptAttributes.has("aria-describedby"), false, "A dismissed callout remains in the Tutorials button accessibility description.");
  quickStartCompleteForPrompt = true;
  tutorialPromptState.tutorialPromptDismissed = false;
  renderTutorialLauncher();
  assert.strictEqual(tutorialPromptElements.tutorialStartPrompt.hidden, true, "The Quick Start callout returns after the tutorial is completed.");
  let quickStartCompleteForHub = false;
  let tutorialStartedFromLauncher = null;
  let tutorialHubRenderCount = 0;
  const tutorialHubState = { tutorialActive: null, tutorialReturnFocus: null };
  const tutorialHubModal = { hidden: true };
  const tutorialLauncherButton = {};
  const openTutorialHub = extractedFunction(fallbackSource, "openTutorialHub", "closeTutorialHub", {
    quickStartCompleted: () => quickStartCompleteForHub,
    state: tutorialHubState,
    pauseTutorial: () => assert.fail("The inactive launcher tried to pause a tutorial."),
    startTutorial: (moduleId, returnFocus) => { tutorialStartedFromLauncher = { moduleId, returnFocus }; },
    document: { activeElement: null },
    els: { tutorialMenuButton: tutorialLauncherButton, tutorialHubModal },
    renderTutorialHub: () => { tutorialHubRenderCount += 1; },
    setTimeout: callback => { callback(); return 1; },
    $: () => null
  });
  const tutorialLauncherFocus = {};
  openTutorialHub(tutorialLauncherFocus);
  assert.deepStrictEqual(tutorialStartedFromLauncher, { moduleId: "quick-start", returnFocus: tutorialLauncherFocus }, "The first Tutorials-button click did not start Quick Start directly.");
  assert.strictEqual(tutorialHubRenderCount, 0, "The tutorial catalog rendered before Quick Start was completed.");
  assert.strictEqual(tutorialHubModal.hidden, true, "The tutorial catalog opened before Quick Start was completed.");
  quickStartCompleteForHub = true;
  tutorialStartedFromLauncher = null;
  openTutorialHub(tutorialLauncherFocus);
  assert.strictEqual(tutorialStartedFromLauncher, null, "The Tutorials button restarted Quick Start after it was completed.");
  assert.strictEqual(tutorialHubRenderCount, 1, "The tutorial catalog did not render after Quick Start was completed.");
  assert.strictEqual(tutorialHubModal.hidden, false, "The tutorial catalog stayed closed after Quick Start was completed.");
  const splitAssociationEntries = extractedFunction(fallbackSource, "splitAssociationEntries", "inheritedAssociationCitation", { String });
  assert.deepStrictEqual(plain(splitAssociationEntries("INA 203(b)(1)(A)(i)–(iii); 8 CFR 214.2(h)(1), 8 U.S.C. 1154\nINA 204")), [
    "INA 203(b)(1)(A)(i)–(iii)", "8 CFR 214.2(h)(1)", "8 U.S.C. 1154", "INA 204"
  ], "Associated-with entries were not split at top-level separators.");
  const associationNorm = value => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const sameAssociationLocation = extractedFunction(fallbackSource, "sameAssociationLocation", "associationCoversLocation", { normCitationPart: associationNorm });
  const associationPathStartsWith = (pathParts, prefix) => prefix.length <= pathParts.length && prefix.every((token, index) => associationNorm(token) === associationNorm(pathParts[index]));
  const rangeRanks = new Map(["b/1/a/i", 1, "b/1/a/ii", 2, "b/1/a/iii", 3, "b/1/a/iii/i", 4, "b/1/b", 5].reduce((pairs, value, index, values) => index % 2 ? pairs : pairs.concat([[value, values[index + 1]]]), []));
  const compareAssociationLocations = (_family, _title, left, right) => (Number(left.unit) - Number(right.unit)) || ((rangeRanks.get((left.path || []).map(associationNorm).join("/")) || 0) - (rangeRanks.get((right.path || []).map(associationNorm).join("/")) || 0));
  const associationCoversLocation = extractedFunction(fallbackSource, "associationCoversLocation", "upgradeProfileCitationLinks", { sameAssociationLocation, compareAssociationLocations, pathStartsWith: associationPathStartsWith, normCitationPart: associationNorm, Number });
  const exactAssociation = { family: "usc", title: 8, start: { unit: "1153", path: ["b", "1", "A"] } };
  assert(associationCoversLocation(exactAssociation, { family: "usc", title: 8, unit: "1153", path: ["b", "1", "A"] }), "An exact association did not match its legal unit.");
  assert(!associationCoversLocation(exactAssociation, { family: "usc", title: 8, unit: "1153", path: ["b", "1", "A", "i"] }), "An exact association incorrectly matched a descendant.");
  const rangeAssociation = { family: "usc", title: 8, start: { unit: "1153", path: ["b", "1", "A", "i"] }, end: { unit: "1153", path: ["b", "1", "A", "iii"] } };
  assert(associationCoversLocation(rangeAssociation, { family: "usc", title: 8, unit: "1153", path: ["b", "1", "A", "ii"] }), "A deep range omitted an intervening subitem.");
  assert(associationCoversLocation(rangeAssociation, { family: "usc", title: 8, unit: "1153", path: ["b", "1", "A", "iii", "I"] }), "A deep range omitted the ending endpoint's descendants.");
  assert(!associationCoversLocation(rangeAssociation, { family: "usc", title: 8, unit: "1153", path: ["b", "1", "B"] }), "A deep range extended beyond its ending subtree.");
  const migratedCitation = { family: "usc", title: 8, citationSystem: "usc", start: { unit: "1153", path: ["b", "1", "A"] }, label: "8 U.S.C. 1153(b)(1)(A)" };
  const upgradeProfileCitationLinks = extractedFunction(fallbackSource, "upgradeProfileCitationLinks", "legalUnitNoteLocation", {
    parseAssociatedWith: value => String(value).includes("1153") ? { valid: true, associations: [migratedCitation] } : { valid: false, associations: [] },
    associationKey: association => `${association.family}:${association.start.unit}:${association.start.path.join("/")}`
  });
  const linkMigrationProfile = { notes: [{ associations: [], links: [{ kind: "usc", citation: "8 U.S.C. 1153(b)(1)(A)", label: "statute" }, { kind: "legacy", id: "legacy:h-1b", label: "H-1B" }] }] };
  upgradeProfileCitationLinks(linkMigrationProfile);
  assert.deepStrictEqual(plain(linkMigrationProfile.notes[0].associations), [migratedCitation], "A legacy citation link did not become a structured association.");
  assert.deepStrictEqual(plain(linkMigrationProfile.notes[0].links.map(link => link.kind)), ["legacy"], "A non-citation related item was removed during migration.");
  const expandPackedHouseHref = extractedFunction(fallbackSource, "expandPackedHouseHref", "hydrateLegalReferences", { String });
  for (const [packed, expanded] of [
    ["u8/s1184/i/1", "/us/usc/t8/s1184/i/1"],
    ["p104/208", "/us/pl/104/208"],
    ["s110/3009", "/us/stat/110/3009"],
    ["a1952-06-27/ch477", "/us/act/1952-06-27/ch477"]
  ]) assert.strictEqual(expandPackedHouseHref(packed), expanded, `The browser did not expand packed House target ${packed}.`);
  const hydrateStart = fallbackSource.indexOf("    function hydrateLegalReferences(");
  const hydrateEnd = fallbackSource.indexOf("\n    if (corpus) hydrateLegalReferences(corpus);", hydrateStart);
  assert(hydrateStart >= 0 && hydrateEnd > hydrateStart, "Could not extract the browser legal-reference hydrator.");
  const hydrateLegalReferences = vm.runInNewContext(`(${fallbackSource.slice(hydrateStart, hydrateEnd).trim()})`, {
    expandPackedHouseHref,
    componentTokens: () => [],
    houseSectionUrl: (section, title = 8) => `https://uscode.house.gov/view.xhtml?req=${encodeURIComponent(`granuleid:USC-prelim-title${title}-section${section}`)}&num=0&edition=prelim`,
    encodeURIComponent,
    Array,
    Number,
    Object,
    String
  });
  const runtimeHouseReferenceText = "section 1184(i)(1) of this title";
  const runtimeHouseReferenceFixture = {
    legalReferencePacking: { houseHrefs: ["u8/s1184/i/1"], legalTargets: [] },
    source: { text: runtimeHouseReferenceText, _lr: { t: [[0, 0, runtimeHouseReferenceText.length, 0, 1]] } }
  };
  hydrateLegalReferences(runtimeHouseReferenceFixture);
  assert.deepStrictEqual(plain(runtimeHouseReferenceFixture.source.references[0]), {
    start: 0,
    end: runtimeHouseReferenceText.length,
    houseHref: "/us/usc/t8/s1184/i/1",
    resolution: "local",
    targetPath: ["i", "1"],
    text: runtimeHouseReferenceText,
    provenance: "house-uslm-ref",
    ruleId: "house-uslm-ref",
    family: "usc",
    targetKind: "usc",
    targetTitle: "8",
    targetSection: "1184",
    officialUrl: "https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title8-section1184&num=0&edition=prelim"
  }, "The browser-side hydrator lost a packed local House target while retaining its local-resolution flag.");
  const runtimeCfrInaText = "section 101(a)(27)(H)";
  const runtimeCfrInaFixture = {
    source: { text: runtimeCfrInaText, references: [{ start: 0, end: runtimeCfrInaText.length, text: runtimeCfrInaText, family: "ina", resolution: "local", targetKind: "usc", targetTitle: "8", targetSection: "1101", targetPath: ["a", "27", "H"], inaSection: "101", provenance: "deterministic-context", ruleId: "context-cfr-ina-act-section" }] }
  };
  packLegalReferences(runtimeCfrInaFixture);
  hydrateLegalReferences(runtimeCfrInaFixture);
  assert.strictEqual(runtimeCfrInaFixture.source.references[0].ruleId, "context-cfr-ina-act-section", "The browser-side hydrator lost the packed CFR-to-INA parser rule.");
  assert(!fallbackSource.includes("scheduledStudy") && !fallbackSource.includes("studyAccessLocked"), "Scheduled study locking remains in the application.");
  assert(fallbackSource.includes("https://www.ecfr.gov/current/title-"));
  assert(fallbackSource.includes("state.saveTimer = setTimeout(queueProfileWrite, 500);"));
  assert(fallbackSource.includes('suggestedName: "INASearch_Data.json"'));
  assert(fallbackSource.includes('format: "INASearchData"'));
  assert(fallbackSource.includes("Allow on every visit") && fallbackSource.includes("requestPersistentStorage"), "The vault reconnection flow does not explain persistent file permission or request persistent browser storage.");
  assert(full.html.includes('Date.parse(result?.nextCheckAfter || "")') && full.html.includes("scheduledAt - Date.now()"), "A long-running copy does not schedule its next eCFR check from the cached authority deadline.");
  assert(!fallbackSource.includes("showDirectoryPicker("), "Saving must not request access to a parent directory.");
  assert(fallbackSource.includes('id="savingMenuModal"'));
  assert(fallbackSource.includes('id="settingsMenuButton"') && fallbackSource.includes('<h2 id="savingMenuTitle">Settings</h2>'), "The saving controls were not moved into the gear-accessed Settings menu.");
  assert(fallbackSource.includes('id="inaCitationLinksToggle"') && fallbackSource.includes('Show INA citations in statutory links'), "The Settings menu lacks the INA statutory-link display preference.");
  assert(fallbackSource.includes('id="defaultStartupQueryInput"') && fallbackSource.includes('Default citation on startup'), "Settings lacks the configurable startup citation.");
  assert(fallbackSource.includes('id="clearDefaultStartupQueryButton"') && fallbackSource.includes('Clear this field to open with an empty search bar'), "Settings does not provide a clear empty-startup path.");
  assert(fallbackSource.includes('els.profileSetupNotice.hidden = mode !== "unsaved";'));
  assert(fallbackSource.includes('els.saveStatus.disabled = false;'));
  assert(fallbackSource.includes('button.status-chip { cursor: pointer; font-family: inherit; font-size: 11px; }'), "The Saving status button lost its compact status typography.");
  assert(fallbackSource.includes("Import saved data") && fallbackSource.includes("Download JSON backup"));
  assert(fallbackSource.includes("AuthoritySearch-Profile.js"), "The renamed build no longer explains how to import an older three-file AuthoritySearch profile.");
  const vaultDeclarationsStart = fallbackSource.indexOf("    function makeVaultId(");
  const vaultDeclarationsEnd = fallbackSource.indexOf("\n\n    function applyVaultProfile(", vaultDeclarationsStart);
  assert(vaultDeclarationsStart >= 0 && vaultDeclarationsEnd > vaultDeclarationsStart, "Could not extract the JSON vault functions.");
  const vaultState = { vaultId: "vault-fixture-1234", vaultRevision: 0 };
  const vaultFunctions = vm.runInNewContext(`${fallbackSource.slice(vaultDeclarationsStart, vaultDeclarationsEnd)}\n({ validateVaultDocument, vaultFromText, serializeVault })`, {
    Date,
    JSON,
    Number,
    String,
    globalThis: { crypto: { randomUUID: () => "vault-fixture-1234" } },
    makeId: () => "vault-fixture-1234",
    state: vaultState,
    isValidProfile: value => Boolean(value && value.schemaVersion === 3 && Array.isArray(value.notes) && value.preferences),
    normalizeProfile: value => JSON.parse(JSON.stringify(value))
  });
  const vaultText = vaultFunctions.serializeVault(blankProfile, 0);
  const vaultRoundTrip = plain(vaultFunctions.vaultFromText(vaultText));
  assert.strictEqual(vaultRoundTrip.format, "INASearchData", "The saved-data file lacks its format discriminator.");
  assert.strictEqual(vaultRoundTrip.schemaVersion, 1, "The saved-data file lacks a stable vault schema.");
  assert.strictEqual(vaultRoundTrip.vaultId, vaultState.vaultId, "The saved-data vault identity did not round-trip.");
  assert.deepStrictEqual(vaultRoundTrip.profile, blankProfile, "The JSON vault changed the saved profile.");
  assert.throws(() => vaultFunctions.vaultFromText(JSON.stringify({ format: "INASearchData", schemaVersion: 1, vaultId: "different-vault", revision: 0, profile: {} })), /valid profile/, "An invalid JSON vault was accepted.");
  let fakeVaultText = vaultText, pendingVaultText = null;
  const fakeVaultHandle = {
    async getFile() { return { async text() { return fakeVaultText; } }; },
    async createWritable() {
      return {
        async write(value) { pendingVaultText = String(value); },
        async close() { fakeVaultText = pendingVaultText; pendingVaultText = null; }
      };
    }
  };
  const writeVaultStart = fallbackSource.indexOf("    async function writeVaultSnapshot(");
  const writeVaultEnd = fallbackSource.indexOf("\n\n    async function queueProfileWrite(", writeVaultStart);
  const writeVaultSnapshot = vm.runInNewContext(`(${fallbackSource.slice(writeVaultStart, writeVaultEnd).trim()})`, {
    state: { ...vaultState, fileHandle: fakeVaultHandle },
    vaultFromText: vaultFunctions.vaultFromText,
    serializeVault: vaultFunctions.serializeVault
  });
  const writtenRevision = await writeVaultSnapshot(blankProfile, 7);
  assert.strictEqual(writtenRevision, 7, "A verified vault write did not return its queued profile revision.");
  assert.strictEqual(vaultFunctions.vaultFromText(fakeVaultText).revision, 1, "The verified vault write did not advance its file revision.");
  fakeVaultText = JSON.stringify({ ...vaultFunctions.vaultFromText(fakeVaultText), revision: 9 });
  await assert.rejects(() => writeVaultSnapshot(blankProfile, 8), /changed in another window or device/, "A newer external vault revision was silently overwritten.");
  assert(fallbackSource.includes('id="view-definitions"'));
  assert(fallbackSource.includes('data-view="definitions"'));
  assert(/<nav class="main-nav"[^>]*>\s*<button class="nav-button" data-view="definitions" aria-current="false">Definitions<\/button>/.test(fallbackSource), "Definitions is not the leftmost primary-page control or is incorrectly marked current on startup.");
  assert(fallbackSource.includes('id="view-search" aria-label="Search results"'), "Search is not the default visible view.");
  assert(fallbackSource.includes('id="view-definitions" hidden aria-labelledby="definitionsHeading"'), "Definitions remains the default visible view.");
  assert(fallbackSource.includes('view: "search"') && fallbackSource.includes('contentViewBeforeSearch: "definitions"'), "The startup state does not open search while retaining Definitions as the close destination.");
  assert(!/id="view-(?:visas|immigrants|quiz)"/.test(fallbackSource), "A retired classification-study view remains in the application.");
  assert(/<div class="search-field-shell">[\s\S]*?<input class="search-input"[\s\S]*?<button class="search-suggestion-inline" id="searchSuggestionButton"/.test(fallbackSource), "The rotating suggestion is not integrated into the main search field.");
  assert(/id="impliedUscTitle"[\s\S]*?>8<\/span>[\s\S]*?id="searchInput"/.test(fallbackSource), "The implied Title 8 marker is not positioned before the typed U.S.C. citation.");
  assert(fallbackSource.includes("No U.S.C. title was entered. INASearch is assuming Title 8 for this lookup."), "The implied Title 8 warning is missing.");
  assert(fallbackSource.includes("updateSearchSuggestionVisibility();"), "The integrated search suggestion does not hide when a query is present.");
  assert(fallbackSource.includes('id="searchScopeToken"') && fallbackSource.includes('id="searchScopeLabel"') && fallbackSource.includes('id="searchScopeInput"'), "The inline citation-filter editor is missing from the main search field.");
  assert(fallbackSource.includes("background: rgba(46,110,156,.22)") && fallbackSource.includes("has-search-scope"), "The inline in: citation editor is not presented as a subtle blue embedded field.");
  assert(!/id="searchScopeInput"[^>]*placeholder=/.test(fallbackSource), "The empty in: citation editor still displays flavor text that resembles a prefilled range.");
  const extractCitationFilterTag = extractedFunction(fallbackSource, "extractCitationFilterTag", "extractSearchScopeTag", { String });
  const extractSearchScopeTag = extractedFunction(fallbackSource, "extractSearchScopeTag", "startupSearchQuery", { String, extractCitationFilterTag });
  assert.deepStrictEqual(plain(extractSearchScopeTag("in: ina 101-215  unlawful presence")), { query: "unlawful presence", scope: "ina 101-215" }, "A pasted in: range did not retain its internal citation space or split at the double-space escape.");
  assert.deepStrictEqual(plain(extractSearchScopeTag("adjustment in: INA 245(c)(2)")), { query: "adjustment", scope: "INA 245(c)(2)" }, "An in: tag following search terms did not become a citation scope.");
  assert.strictEqual(extractSearchScopeTag("inside the statute"), null, "Ordinary words beginning with ‘in’ were mistaken for the in: tag.");
  assert.deepStrictEqual(plain(extractCitationFilterTag("cites:INA101a15s")), { query: "", scope: "INA101a15s", mode: "cites" }, "A compact cites: target was not extracted from the main search field.");
  assert.deepStrictEqual(plain(extractCitationFilterTag("waiver cites: INA 101-212  discretion")), { query: "waiver discretion", scope: "INA 101-212", mode: "cites" }, "A cites: range did not use the in: tag's double-space formatting rules.");
  assert.strictEqual(extractSearchScopeTag("cites: INA 101"), null, "The compatibility in: extractor silently treated cites: as a text-within scope.");
  const doubleSpaceScopeInput = { value: "INA 101-215 " };
  const doubleSpaceMainInput = { value: "unlawful presence", focused: false, selection: null, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selection = [start, end]; } };
  let doubleSpacePrevented = false;
  let doubleSpaceRefreshes = 0;
  const escapeSearchScopeOnSecondSpace = extractedFunction(fallbackSource, "escapeSearchScopeOnSecondSpace", "resetSearchState", {
    els: { searchScopeInput: doubleSpaceScopeInput, search: doubleSpaceMainInput },
    refreshSearchScope: () => { doubleSpaceRefreshes += 1; }
  });
  assert(escapeSearchScopeOnSecondSpace({ key: " ", altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => { doubleSpacePrevented = true; } }), "The second consecutive space did not exit the citation editor.");
  assert.strictEqual(doubleSpaceScopeInput.value, "INA 101-215", "The first escape-space was not erased from the citation field.");
  assert(doubleSpacePrevented && doubleSpaceMainInput.focused && doubleSpaceRefreshes === 1, "The double-space escape did not return focus to the main search field and refresh the scope.");
  const scopeValidationClasses = new Set();
  const scopeShellClasses = new Set();
  const scopeValidationAttributes = {};
  const scopeValidationState = { searchScopeActive: true, searchScopeEditing: true, searchScopeText: "ina101-", searchScope: { valid: false, message: "Enter a valid ending citation for this range." }, searchScopeMode: "in" };
  const scopeValidationShell = {
    classList: { toggle: (name, active) => active ? scopeShellClasses.add(name) : scopeShellClasses.delete(name) },
    style: { removeProperty: () => {} }
  };
  const scopeValidationElements = {
    search: { closest: () => scopeValidationShell },
    searchScopeToken: { hidden: false, classList: { toggle: (name, active) => active ? scopeValidationClasses.add(name) : scopeValidationClasses.delete(name) } },
    searchScopeLabel: { textContent: "" },
    searchScopeInput: { title: "", setAttribute(name, value) { scopeValidationAttributes[name] = value; } },
    searchScopeClear: { setAttribute(name, value) { scopeValidationAttributes[`clear-${name}`] = value; } }
  };
  const renderSearchScopeEditor = extractedFunction(fallbackSource, "renderSearchScopeEditor", "refreshSearchScope", {
    state: scopeValidationState,
    els: scopeValidationElements,
    syncSearchScopeEditorWidth: () => {},
    updateSearchSuggestionVisibility: () => {}
  });
  renderSearchScopeEditor();
  assert(!scopeValidationClasses.has("invalid") && scopeValidationAttributes["aria-invalid"] === "false", "An incomplete citation range turns red while its field is actively being edited.");
  scopeValidationState.searchScopeEditing = false;
  renderSearchScopeEditor();
  assert(scopeValidationClasses.has("invalid") && scopeValidationAttributes["aria-invalid"] === "true", "An incomplete citation range is not marked invalid after the user leaves its field.");
  scopeValidationState.searchScopeEditing = true;
  scopeValidationState.searchScope = { valid: true, label: "INA 101–212" };
  renderSearchScopeEditor();
  assert(!scopeValidationClasses.has("invalid"), "A completed valid range retained invalid styling while still focused.");
  scopeValidationState.searchScopeMode = "cites";
  renderSearchScopeEditor();
  assert.strictEqual(scopeValidationElements.searchScopeLabel.textContent, "cites:", "The shared citation editor did not identify citation-source mode.");
  assert(/results must cite/i.test(scopeValidationAttributes["aria-label"]), "The cites: editor retained the in: accessibility label.");
  assert(fallbackSource.includes('els.searchScopeInput.addEventListener("focus"') && fallbackSource.includes('els.searchScopeInput.addEventListener("blur"'), "The citation editor does not explicitly defer and restore validation styling across focus changes.");
  const startupSearchQuery = extractedFunction(fallbackSource, "startupSearchQuery", "showSearchResults", { URLSearchParams, String, DEFAULT_STARTUP_QUERY: "INA 203b1a", profile: { preferences: { defaultStartupQuery: "INA 203b1a" } } });
  assert.strictEqual(startupSearchQuery({ search: "?q=22%20CFR%2042.11" }, "INA 245"), "22 CFR 42.11", "The startup query does not give URL citations priority over the configured default.");
  assert.strictEqual(startupSearchQuery({ search: "?q=%20INA%20215(a)%20" }, "INA 245"), " INA 215(a) ", "Formatting explicitly supplied in the URL query is not preserved for the editable field.");
  assert.strictEqual(startupSearchQuery({ search: "?q=" }, "INA 245"), "", "An explicitly empty q argument was replaced by the configured default citation.");
  assert.strictEqual(startupSearchQuery({ search: "?other=value" }, "22 CFR 42"), "22 CFR 42", "A URL without q did not receive the configured default citation.");
  assert.strictEqual(startupSearchQuery({ search: "" }, ""), "", "Clearing the configured default did not produce an empty startup search.");
  assert.strictEqual(startupSearchQuery({ search: "?q=INA%20203" }, ""), "INA 203", "A q value did not override an intentionally empty configured default.");
  assert.strictEqual(startupSearchQuery({ search: "" }), "INA 203b1a", "The no-argument startup citation is not the profile default.");
  assert.strictEqual(startupSearchQuery({ search: `?q=${"a".repeat(600)}` }, "INA 245").length, 500, "The startup query is not length-limited.");
  assert(fallbackSource.includes("if (startupQuery) applySearchQuery(startupQuery, false, true);"), "Initialization does not synchronously preserve the displayed formatting of the startup query.");
  const startupEditableSearch = { value: "" };
  const startupApplyState = { query: "", searchScopeActive: false };
  let startupActivatedScope = null;
  const applyStartupSearchQuery = extractedFunction(fallbackSource, "applySearchQuery", "openSearchRecord", {
    String,
    els: { search: startupEditableSearch },
    state: startupApplyState,
    extractCitationFilterTag,
    activateSearchScope: (scope, focus, mode) => { startupApplyState.searchScopeActive = true; startupActivatedScope = { scope, focus, mode }; },
    deactivateSearchScope: () => { startupApplyState.searchScopeActive = false; },
    updateSearchSuggestionVisibility: () => {},
    closeSearchResults: () => {},
    showSearchResults: () => {},
    runSearch: () => {}
  });
  applyStartupSearchQuery(" INA 215(a) ", false, true);
  assert.strictEqual(startupEditableSearch.value, " INA 215(a) ", "Startup query formatting is canonicalized before it reaches the editable field.");
  applyStartupSearchQuery(" INA 215(a) ", false);
  assert.strictEqual(startupEditableSearch.value, "INA 215(a)", "Ordinary non-startup query normalization unexpectedly changed.");
  applyStartupSearchQuery("cites:INA101a15s", false);
  assert.deepStrictEqual(startupActivatedScope, { scope: "INA101a15s", focus: false, mode: "cites" }, "A supplied cites: query did not activate citation-source mode with its compact target intact.");
  assert.strictEqual(startupEditableSearch.value, "", "A bare cites: query leaked its tag into the ordinary text-search field.");
  assert(!fallbackSource.includes('data-filter="authorities"'), "The obsolete Authorities result filter remains visible.");
  for (const filter of ["statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "policy", "forms", "notes"]) {
    assert(fallbackSource.includes(`data-filter="${filter}"`), `The ${filter} result filter is missing.`);
  }
  assert(!fallbackSource.includes('class="search-results-tools"') && !fallbackSource.includes('id="closeSearchResultsButton"'), "The redundant lookup-status panel remains in the search view.");
  assert(fallbackSource.includes('id="searchWorkspace"') && fallbackSource.includes('id="resultsPanel"'), "The single-result reading layout cannot target the search workspace and result panel.");
  assert(fallbackSource.includes('id="authorityBrowseHeader"') && fallbackSource.includes('.workspace.authority-browse .results-panel .panel-head, .workspace.authority-browse .detail-panel { display: none; }'), "Authority browse headings and lists are not integrated into one results panel.");
  assert(!fallbackSource.includes("data-cfr-part-overview"), "The obsolete separate CFR part overview card remains in the detail panel.");
  assert(fallbackSource.includes("activate && record?.authorityBrowseRecord") && fallbackSource.includes("applySearchQuery(record.cite, false);"), "Authority browse choices do not drill into the selected local page.");
  assert(fallbackSource.includes('const primaryMeta = browseRow ? record.cite || "" : kindLabel(record.kind);') && fallbackSource.includes('const secondaryMeta = browseRow ? kindLabel(record.kind) : record.cite || "";'), "Authority browse rows do not lead with the specific INA/CFR citation and move the generic page type to the right.");
  assert(fallbackSource.includes('class="authority-browse-source"') && fallbackSource.includes('data-open-url="${escapeHtml(safe)}"'), "Browse authority labels are not linked to their official sources.");
  assert(!fallbackSource.includes('openButton(part.url, "Current eCFR")'), "The separate CFR browse source button was not removed.");
  assert(fallbackSource.includes('id="citationResultsNotification"') && fallbackSource.includes('id="citationResultsNotificationCount"'), "The citation reader has no notification for other matching material.");
  assert(fallbackSource.includes("const collapsedAuthorityBrowse = isAuthorityBrowse() && !state.citationResultsExpanded;") && fallbackSource.includes("!collapsedAuthorityBrowse && !readingOnly"), "The ordinary filter strip is not suppressed while a curated authority list is displayed.");
  for (const filter of ["all", "statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "policy", "forms", "notes"]) {
    assert(new RegExp(`data-filter="${filter}"[^>]*>[\\s\\S]*?data-filter-count`).test(fallbackSource), `The ${filter} filter does not display a result count.`);
  }
  assert(fallbackSource.includes("state.citationResultsExpanded = true;") && fallbackSource.includes("showCurrentSearchResults(state.selected);"), "The citation-result notification does not reveal the full result pane.");
  const isSingleLegalResult = extractedFunction(fallbackSource, "isSingleLegalResult", "directCitationResult", { state: { results: [] } });
  assert(isSingleLegalResult([{ kind: "usc" }]) && isSingleLegalResult([{ kind: "cfr" }]), "A lone statute or regulation does not activate reading-only layout.");
  assert(!isSingleLegalResult([{ kind: "cfr" }, { kind: "cfr" }]) && !isSingleLegalResult([{ kind: "definition" }]), "Reading-only layout hides result choices that are still needed.");
  const directCitationState = {
    citation: { valid: true, record: { key: "usc:1153", kind: "usc" } },
    allResults: [{ key: "usc:1153", kind: "usc" }, { key: "policy:one", kind: "policy" }],
    selected: { key: "usc:1153" },
    citationResultsExpanded: false,
    authorityBrowseExtraResults: []
  };
  const directCitationResult = extractedFunction(fallbackSource, "directCitationResult", "citationOtherResultCount", { state: directCitationState });
  assert.strictEqual(directCitationResult().key, "usc:1153", "A valid citation is not retained as the direct reading result.");
  let authorityBrowseNotificationMode = false;
  const citationOtherResultCount = extractedFunction(fallbackSource, "citationOtherResultCount", "updateCitationResultsNotification", { state: directCitationState, directCitationResult, isAuthorityBrowse: () => authorityBrowseNotificationMode });
  assert.strictEqual(citationOtherResultCount(), 1, "The citation notification does not exclude the citation itself from its count.");
  authorityBrowseNotificationMode = true;
  directCitationState.authorityBrowseExtraResults = [{ key: "note:one" }, { key: "policy:one" }];
  assert.strictEqual(citationOtherResultCount(), 2, "The authority-browse notification count includes curated pages instead of only non-curated matches.");
  directCitationState.authorityBrowseExtraResults = [];
  assert.strictEqual(citationOtherResultCount(), 0, "An authority browse with no extra matches still requests a notification square.");
  authorityBrowseNotificationMode = false;
  const isCitationReadingMode = extractedFunction(fallbackSource, "isCitationReadingMode", "updateSearchResultLayout", { state: directCitationState, directCitationResult });
  assert(isCitationReadingMode(), "A direct citation does not default to reading mode.");
  directCitationState.citationResultsExpanded = true;
  assert(!isCitationReadingMode(), "Opening the other results does not reveal the search pane.");
  const corpusStatusClasses = new Map();
  const corpusStatusElement = {
    hidden: false, disabled: false, innerHTML: "", title: "", attributes: {},
    classList: { remove(name) { corpusStatusClasses.set(name, false); }, toggle(name, enabled) { corpusStatusClasses.set(name, enabled); } },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; if (name === "title") this.title = ""; }
  };
  const updateCorpusStatus = extractedFunction(fallbackSource, "updateCorpusStatus", "disabledCorpusMaintenanceStatus", {
    corpus: { corpusVersion: "2026.08.02-7", capturedAt: "2026-07-30", verifiedAt: "2026-07-31" },
    els: { corpusStatus: corpusStatusElement },
    loadErrors: {},
    window: {},
    escapeHtml: value => String(value ?? "")
  });
  updateCorpusStatus();
  assert.strictEqual(corpusStatusElement.hidden, true, "A successful corpus load still occupies the top bar with a routine status.");
  updateCorpusStatus({ state: "updated", reloadRequired: true, changedParts: ["5:1", "5:2", "8:1", "8:2", "8:3"], message: "5 CFR parts updated directly from eCFR. Reload to use the verified local copy.", metrics: { elapsedMs: 12400 } });
  assert.strictEqual(corpusStatusElement.hidden, false, "A ready CFR update is hidden from the top bar.");
  assert.strictEqual(corpusStatusElement.disabled, false, "The ready CFR update action is not clickable.");
  assert.strictEqual(corpusStatusClasses.get("update-ready"), true, "The ready CFR update action lacks its actionable styling.");
  assert(corpusStatusElement.innerHTML.includes("↻") && corpusStatusElement.innerHTML.includes("Reload 5 CFR parts"), "The ready CFR update action does not show an explicit refresh icon and count.");
  assert(corpusStatusElement.attributes["aria-label"].includes("Activate to reload now") && corpusStatusElement.title.includes("Click to reload now"), "The ready CFR update action does not state what clicking it will do.");
  assert(!fallbackSource.includes("Direct eCFR update ready:"), "The ready-to-reload notice remains buried and duplicated on the About page.");
  let corpusReloads = 0;
  const reloadState = { profileChanged: false, fileConnected: false };
  const reloadWindow = { INA_SEARCH_UPDATE_STATUS: { state: "updated" } };
  const reloadUpdatedCorpus = extractedFunction(fallbackSource, "reloadUpdatedCorpus", "updateCorpusStatus", {
    window: reloadWindow,
    state: reloadState,
    confirm: () => true,
    location: { reload() { corpusReloads += 1; } }
  });
  assert.strictEqual(reloadUpdatedCorpus(), true, "The update-ready action did not start a reload.");
  assert.strictEqual(corpusReloads, 1, "The update-ready action did not reload exactly once.");
  assert(!fallbackSource.includes('>Corpus Loaded</span>'), "The removed Corpus Loaded success chip remains in the interface.");
  const saveStatusClasses = new Map();
  const saveStatusElement = {
    innerHTML: "",
    disabled: true,
    attributes: {},
    classList: { toggle(name, enabled) { saveStatusClasses.set(name, enabled); } },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const saveStatusState = { fileConnected: false, profileChanged: false };
  const updateSaveStatus = extractedFunction(fallbackSource, "updateSaveStatus", "updateProfileSummary", {
    state: saveStatusState,
    els: { saveStatus: saveStatusElement, savingMenuModal: { hidden: true } },
    escapeHtml: value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]),
    renderProfileSetupNotice: () => {},
    renderSavingMenu: () => {}
  });
  updateSaveStatus("Autosaving off", "warn");
  assert.strictEqual(saveStatusElement.innerHTML, '<span class="status-dot warn"></span>Saving Off', "The disconnected saving chip does not use the requested short label.");
  assert.strictEqual(saveStatusElement.attributes["aria-label"], "Saving is off. Open settings.", "The disconnected saving chip has an inaccurate accessible label.");
  saveStatusState.fileConnected = true;
  updateSaveStatus("Autosave queued", "warn");
  assert.strictEqual(saveStatusElement.innerHTML, '<span class="status-dot warn"></span>Saving On', "The connected saving chip exposes internal queue wording instead of the requested short label.");
  assert.strictEqual(saveStatusElement.attributes["aria-label"], "Saving is on. Autosave queued. Open settings.", "The connected saving chip lost its detailed accessible status.");
  assert(/<div class="brand" id="inaSearchBrand"[\s\S]*?<span class="brand-mark"[\s\S]*?<strong>INASearch<\/strong><small>Statutes &amp; Regulations<\/small>[\s\S]*?id="brandTribute"/.test(fallbackSource), "The tribute hover area does not continuously wrap the full INASearch brand.");
  assert(fallbackSource.includes("Inspired by the excellent work of 2604"), "The INASearch tribute text is missing.");
  assert(fallbackSource.includes('els.brand.addEventListener("mouseenter", beginBrandTributeHover);'), "The tribute timer is not attached to the continuous brand area.");
  assert(fallbackSource.includes('els.brand.addEventListener("mouseleave", endBrandTributeHover);'), "The tribute popup is not dismissed when the pointer leaves the brand area.");
  const brandTributeState = { brandTributeTimer: null };
  const brandTributeElement = { hidden: true };
  let brandTributeTimeoutCalls = 0;
  let brandTributeCallback = null;
  let brandTributeDelay = null;
  const clearedBrandTributeTimers = [];
  const beginBrandTributeHover = extractedFunction(fallbackSource, "beginBrandTributeHover", "endBrandTributeHover", {
    state: brandTributeState,
    els: { brandTribute: brandTributeElement },
    setTimeout: (callback, delay) => {
      brandTributeTimeoutCalls += 1;
      brandTributeCallback = callback;
      brandTributeDelay = delay;
      return `brand-timer-${brandTributeTimeoutCalls}`;
    }
  });
  const endBrandTributeHover = extractedFunction(fallbackSource, "endBrandTributeHover", "attachEvents", {
    state: brandTributeState,
    els: { brandTribute: brandTributeElement },
    clearTimeout: timer => clearedBrandTributeTimers.push(timer)
  });
  beginBrandTributeHover();
  beginBrandTributeHover();
  assert.strictEqual(brandTributeTimeoutCalls, 1, "Movement within the brand area restarted the tribute timer.");
  assert.strictEqual(brandTributeDelay, 2000, "The tribute popup does not wait exactly two seconds.");
  brandTributeCallback();
  assert.strictEqual(brandTributeElement.hidden, false, "The tribute popup did not appear after two seconds in the brand area.");
  endBrandTributeHover();
  assert.strictEqual(brandTributeElement.hidden, true, "The tribute popup remained visible after leaving the brand area.");
  beginBrandTributeHover();
  const pendingBrandTributeTimer = brandTributeState.brandTributeTimer;
  endBrandTributeHover();
  assert(clearedBrandTributeTimers.includes(pendingBrandTributeTimer), "Leaving the brand area did not cancel its pending tribute timer.");
  assert(fallbackSource.includes('id="statuteNavigator"'), "The live statute hierarchy navigation is missing.");
  assert(fallbackSource.includes('data-statute-history="back"') && fallbackSource.includes('data-statute-history="forward"'), "The statute navigation bar is missing Back and Forward controls.");
  assert(fallbackSource.includes('event.target.closest("[data-statute-history]")'), "The statute history controls are not connected to delegated navigation events.");
  assert(fallbackSource.includes('data-statute-path='), "Rendered statutory nodes do not expose their hierarchy paths.");
  assert(fallbackSource.includes('<button class="nav-button" data-view="sources">About</button>'), "The top navigation does not use the shortened About label.");
  assert(!fallbackSource.includes('<button class="nav-button" data-view="sources">Sources &amp; About</button>'), "The former Sources & About top-navigation label remains visible.");
  assert(fallbackSource.includes('id="legalUnitMenu"') && fallbackSource.includes('data-legal-unit-action="copy-usc-citation"'), "The structural legal-unit action menu is missing.");
  for (const label of ["Copy Statute", "Print Statute", "Open in House.gov"]) assert(fallbackSource.includes(label), `The legal-unit menu is missing ${label}.`);
  assert(!fallbackSource.includes('>Copy USC Citation</button>') && !fallbackSource.includes('>Copy INA Citation</button>'), "Redundant textual citation-copy menu items remain visible.");
  const legalUnitMenuStart = fallbackSource.indexOf('id="legalUnitMenu"');
  const legalUnitMenuEnd = fallbackSource.indexOf('<section class="legal-reference-popover" id="legalReferencePopover"', legalUnitMenuStart);
  const legalUnitMenuMarkup = fallbackSource.slice(legalUnitMenuStart, legalUnitMenuEnd);
  assert((legalUnitMenuMarkup.match(/<span aria-hidden="true">⧉<\/span>/g) || []).length === 2, "The two legal-unit citation rows do not use symbol-only copy controls.");
  assert(fallbackSource.includes('id="legalUnitMenuCrosswalkCitation"') && fallbackSource.includes('context.inaCitation') && fallbackSource.includes('data-legal-unit-action="copy-ina-citation"'), "Statutory units do not expose their crosswalked citation as a second copyable row.");
  assert(fallbackSource.includes('event.target.closest("[data-legal-unit-kind]")'), "Structural citation markers do not open the legal-unit menu.");
  assert(fallbackSource.includes('.legal-unit-note-button[data-note-unit-kind] {') && fallbackSource.includes('visibility: hidden;') && fallbackSource.includes('pointer-events: none;'), "Per-unit note controls are not hidden by default.");
  assert(fallbackSource.includes('.note-unit-current') && fallbackSource.includes('.note-unit-hovered'), "Contextual note controls do not distinguish the live-navigation unit from the hovered unit.");
  assert(fallbackSource.includes('sameContextualNotePath(path, state.statuteNavigationPath || [])'), "The live hierarchy path is not connected to contextual note-control visibility.");
  assert(fallbackSource.includes('contextualNoteButtonForElement(event.target)'), "Hovering inside a legal unit does not reveal its contextual note control.");
  assert(!fallbackSource.includes("note-unit-current-host") && !fallbackSource.includes("note-unit-hovered-host"), "Contextual note visibility still changes host classes and can rewrap legal text.");
  assert(fallbackSource.includes('.statutory-node > .statutory-line { position: relative; padding: 5px 26px 7px 7px; }'), "Statutory text lines do not reserve one fixed compact note-control gutter.");
  assert(fallbackSource.includes('.detail-heading-row > div:first-child, .cfr-block { padding-inline-end: 26px; }'), "Legal headings and CFR blocks do not reserve a fixed compact note-control gutter.");
  assert(fallbackSource.includes('html{color-scheme:light}') && fallbackSource.includes('background:#fff'), "Legal-unit printing does not force a light text-only page.");
  assert(fallbackSource.includes('Math.max(0, window.innerHeight - navigatorBottom) * .1'), "The statute reading line is not one tenth of the statute viewport.");
  assert(fallbackSource.includes('.statutory-node { position: relative; margin: 5px 0 5px 15px; padding: 0; border-radius: 6px; }'), "Nested statutory nodes do not use one fixed indentation increment without stacking horizontal padding.");
  assert(fallbackSource.includes('.statute-body > .statutory-node { margin-inline-start: 0; }'), "Top-level statutory nodes retain an unnecessary indentation increment.");
  assert(/\.statutory-runin-line \{ position: relative; margin: 5px 0 5px min\(calc\(var\(--depth, 0\) \* 15px\), 90px\); padding: 5px 7px 7px; border-radius: 6px; \}/.test(fallbackSource), "Run-in statutory units lost their independent source-address indentation.");
  assert(/\.statutory-node\.target,\s*\.statutory-runin-line\.citation-target \{/.test(fallbackSource), "Run-in statutory targets do not share the standard target styling.");
  assert(!/\.statutory-runin-line \{[^}]*border-left/.test(fallbackSource) && !fallbackSource.includes("padding-left: 13px"), "Run-in statutory units still use a source-markup indentation bar.");
  assert(fallbackSource.includes('.definition-filter-option[data-depth="1"]'), "First-level definition checkbox indentation is missing.");
  assert(fallbackSource.includes('.definition-filter-option[data-depth="2"]'), "Second-level definition checkbox indentation is missing.");
  assert(fallbackSource.includes('class="definition-applicability-warning"'), "Out-of-applicability definitions do not render a warning.");
  assert(fallbackSource.includes('@keyframes statute-nav-value-flash'), "Changed statute hierarchy values do not flash blue.");
  assert(fallbackSource.includes('previousValues[index] !== segment.value'), "Statute hierarchy changes are not detected by segment value.");
  assert(fallbackSource.includes('.statute-nav-option { display: flex;'), "Statute dropdown rows are not compact single-line layouts.");
  assert(fallbackSource.includes('text-overflow: ellipsis; white-space: nowrap;'), "Statute dropdown descriptions are not constrained to one truncated line.");
  assert(fallbackSource.includes('.search-filter-bar .filters { width: min(1580px, 100%); margin: 0 auto; overflow: visible; flex-wrap: wrap; }'), "Search filters still clip or horizontally hide buttons instead of wrapping.");
  assert(fallbackSource.includes('class="results-scroll-cue">Scrollable pane</span>'), "The nested results scroller lacks a visible pane cue.");
  assert(fallbackSource.includes('.results-panel { width: min(720px, calc(100% - 44px));'), "The tablet results pane does not preserve page-scroll gutters.");
  assert(fallbackSource.includes('kind: "definition-index"'));
  assert(fallbackSource.includes('accept=".html,.htm,.json,.js,text/html,application/json,text/javascript"'), "Profile file control does not accept legacy JavaScript profiles.");
  assert(!/\$\("#filters"\)[^\n]+markProfileChanged\(\)/.test(fallbackSource), "Search filtering still marks the profile as changed.");

  const parseDefinitionCommand = extractedFunction(fallbackSource, "parseDefinitionCommand", "definitionMatchesQuery", { String });
  assert.deepStrictEqual(plain(parseDefinitionCommand("define:child")), { query: "child" });
  assert.deepStrictEqual(plain(parseDefinitionCommand(" DEFINE :  admitted ")), { query: "admitted" });
  assert.deepStrictEqual(plain(parseDefinitionCommand("define:")), { query: "" });
  assert.strictEqual(parseDefinitionCommand("definitions"), null);
  const definitionMatchesQuery = extractedFunction(fallbackSource, "definitionMatchesQuery", "definedTermHighlightingEnabled", {
    normalize: value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  });
  const childDefinition = definitionsFor("child")[0];
  assert.strictEqual(definitionMatchesQuery(childDefinition, "hil"), true, "Definition substring matching failed.");
  assert.strictEqual(definitionMatchesQuery(childDefinition, "alien"), false, "Definition term filter searched the definition body instead of term aliases.");
  const definitionFilterDescendantLeaves = extractedFunction(fallbackSource, "definitionFilterDescendantLeaves", "normalizedDefinitionFilterSelection", { Array });
  const normalizedDefinitionFilterSelection = extractedFunction(fallbackSource, "normalizedDefinitionFilterSelection", "definitionFilterSelectionState", { Array, Set, definitionFilterDescendantLeaves });
  const definitionFilterSelectionState = extractedFunction(fallbackSource, "definitionFilterSelectionState", "nextDefinitionFilterSelection", { Set, normalizedDefinitionFilterSelection, definitionFilterDescendantLeaves });
  const nextDefinitionFilterSelection = extractedFunction(fallbackSource, "nextDefinitionFilterSelection", "selectedDefinitionFilterIds", { Set, normalizedDefinitionFilterSelection, definitionFilterDescendantLeaves });
  const sourceFilterRecords = full.corpus.definitions.sourceFilters;
  const scopeFilterRecords = full.corpus.definitions.scopeFilters;
  const definitionFiltersForKind = kind => kind === "source" ? sourceFilterRecords : scopeFilterRecords;
  const definitionFilterDefinitionCount = extractedFunction(fallbackSource, "definitionFilterDefinitionCount", "renderDefinitionCheckboxTree", {
    Set,
    corpus: full.corpus,
    definitionFiltersForKind,
    definitionFilterDescendantLeaves
  });
  assert.strictEqual(definitionFilterDefinitionCount("source", "all"), 498, "The all-sources count does not include every definition record.");
  assert.strictEqual(definitionFilterDefinitionCount("source", "uscis-glossary"), 267, "The USCIS Glossary source count is wrong.");
  assert.strictEqual(definitionFilterDefinitionCount("source", "law"), 231, "The Defined-in Law count is wrong.");
  assert.strictEqual(definitionFilterDefinitionCount("source", "ina-statute"), 199, "The Defined-in Statute count is wrong.");
  assert.strictEqual(definitionFilterDefinitionCount("scope", "ina-any"), 199, "The any-part INA applicability count is wrong.");
  assert.strictEqual(definitionFilterDefinitionCount("scope", "cfr-chapter-i"), 32, "The regulation applicability count is wrong.");
  assert.deepStrictEqual(plain(definitionFilterDescendantLeaves(sourceFilterRecords, "ina-statute")), [...new Set(inaDefinitions.map(entry => entry.sourceFilter))], "Defined-in Statute does not cover every INA source leaf.");
  assert.deepStrictEqual(plain(definitionFilterDescendantLeaves(scopeFilterRecords, "ina-any")), full.corpus.definitions.scopes.filter(scope => scope.category === "law" && scope.id.startsWith("ina-")).map(scope => scope.id), "Any-part INA applicability does not cover every INA scope leaf.");
  let checkboxSelection = plain(nextDefinitionFilterSelection(sourceFilterRecords, ["all"], "ina-101-h", false));
  assert.strictEqual(definitionFilterSelectionState(sourceFilterRecords, checkboxSelection, "ina-statute").checked, false, "Unchecking a lower-level source did not uncheck Statute.");
  assert.strictEqual(definitionFilterSelectionState(sourceFilterRecords, checkboxSelection, "ina-statute").indeterminate, true, "A partially selected Statute parent is not indeterminate.");
  assert.strictEqual(definitionFilterSelectionState(sourceFilterRecords, checkboxSelection, "law").checked, false, "Unchecking a lower-level source did not uncheck Law.");
  checkboxSelection = plain(nextDefinitionFilterSelection(sourceFilterRecords, checkboxSelection, "ina-101-h", true));
  assert.deepStrictEqual(checkboxSelection, ["all"], "Checking the final lower-level source did not restore all fully selected parents.");
  checkboxSelection = plain(nextDefinitionFilterSelection(sourceFilterRecords, ["all"], "ina-statute", false));
  assert.deepStrictEqual(checkboxSelection, ["uscis-glossary", "8-cfr-1-2"], "Unchecking Statute did not uncheck every specific INA source.");
  checkboxSelection = plain(nextDefinitionFilterSelection(sourceFilterRecords, checkboxSelection, "ina-statute", true));
  assert.deepStrictEqual(checkboxSelection, ["all"], "Checking Statute did not check every specific INA source.");
  const definitionFilterState = { definitionQuery: "", definitionSourceFilters: ["all"], definitionScopeFilters: ["all"] };
  const selectedDefinitionFilterIds = kind => normalizedDefinitionFilterSelection(
    kind === "source" ? sourceFilterRecords : scopeFilterRecords,
    kind === "source" ? definitionFilterState.definitionSourceFilters : definitionFilterState.definitionScopeFilters
  );
  const definitionSourceMatches = extractedFunction(fallbackSource, "definitionSourceMatches", "definitionApplicabilityMatches", { selectedDefinitionFilterIds });
  const definitionApplicabilityMatches = extractedFunction(fallbackSource, "definitionApplicabilityMatches", "filteredDefinitionGroups", { selectedDefinitionFilterIds });
  const filterEntries = [
    { id: "policy-child", term: "Child", aliases: ["Child"], sourceCategory: "policy", sourceFilter: "uscis-glossary", scopeCategory: "policy", scopeId: "uscis-policy", sourcePriority: 0, locator: "USCIS Glossary — Child" },
    { id: "law-child", term: "Child", aliases: ["Child"], sourceCategory: "law", sourceFilter: "ina-101-b", scopeCategory: "law", scopeId: "ina-subchapters-i-ii", sourcePriority: 1, locator: "INA 101(b)(1)" },
    { id: "law-alien", term: "Alien", aliases: ["Alien"], sourceCategory: "law", sourceFilter: "ina-101-a", scopeCategory: "law", scopeId: "ina-chapter", sourcePriority: 1, locator: "INA 101(a)(3)" },
    { id: "law-day", term: "Day", aliases: ["Day"], sourceCategory: "law", sourceFilter: "8-cfr-1-2", scopeCategory: "law", scopeId: "cfr-chapter-i", sourcePriority: 1, locator: "8 CFR 1.2 — Day" }
  ];
  const filteredDefinitionGroups = extractedFunction(fallbackSource, "filteredDefinitionGroups", "filteredDefinitions", {
    corpus: { definitions: { entries: filterEntries } },
    state: definitionFilterState,
    definitionMatchesQuery,
    definitionSourceMatches,
    definitionApplicabilityMatches,
    definitionGroupTerm: entry => entry.term,
    normalize: value => String(value || "").toLowerCase()
  });
  definitionFilterState.definitionScopeFilters = ["uscis-policy"];
  let filteredGroups = plain(filteredDefinitionGroups());
  assert.deepStrictEqual(filteredGroups.map(group => group.term), ["Child"], "A term with no definition in the selected applicability remained visible.");
  assert.deepStrictEqual(filteredGroups[0].entries.map(entry => entry.id), ["policy-child", "law-child"], "A duplicate outside the selected applicability was removed or the glossary was not first.");
  assert.strictEqual(definitionApplicabilityMatches(filterEntries[1]), false, "Law definition was treated as USCIS Policy.");
  definitionFilterState.definitionScopeFilters = plain(nextDefinitionFilterSelection(scopeFilterRecords, [], "law", true));
  filteredGroups = plain(filteredDefinitionGroups());
  assert.deepStrictEqual(filteredGroups.find(group => group.term === "Child").entries.map(entry => entry.id), ["policy-child", "law-child"], "USCIS definition was removed from a term that has a matching Law definition.");
  definitionFilterState.definitionScopeFilters = plain(nextDefinitionFilterSelection(scopeFilterRecords, [], "ina-any", true));
  filteredGroups = plain(filteredDefinitionGroups());
  assert.deepStrictEqual(filteredGroups.map(group => group.term), ["Alien", "Child"], "Any-part INA applicability did not show exactly the terms applicable somewhere in the INA.");
  definitionFilterState.definitionScopeFilters = ["ina-chapter"];
  filteredGroups = plain(filteredDefinitionGroups());
  assert.deepStrictEqual(filteredGroups.map(group => group.term), ["Alien"], "Entire INA applicability included a definition limited to another part of the INA.");
  definitionFilterState.definitionSourceFilters = plain(nextDefinitionFilterSelection(sourceFilterRecords, [], "law", true));
  definitionFilterState.definitionScopeFilters = ["all"];
  filteredGroups = plain(filteredDefinitionGroups());
  assert.deepStrictEqual(filteredGroups.find(group => group.term === "Child").entries.map(entry => entry.id), ["law-child"], "Defined-in Law did not remove the USCIS Glossary definition.");
  assert.strictEqual(definitionSourceMatches(filterEntries[0]), false, "USCIS Glossary definition was treated as defined in Law.");
  assert(fallbackSource.includes('type="checkbox" data-definition-filter-kind='), "Definition filters are not rendered as checkboxes.");
  assert(fallbackSource.includes('class="definition-filter-dropdown" id="definitionSourceDropdown"'), "The Defined-in checkbox tree is not inside a collapsible dropdown.");
  assert(fallbackSource.includes('class="definition-filter-dropdown" id="definitionScopeDropdown"'), "The Applicable-in checkbox tree is not inside a collapsible dropdown.");
  assert(fallbackSource.includes('if (!event.target.closest(".definition-filter-dropdown"))'), "Definition filter dropdowns do not collapse when clicking outside.");
  assert(fallbackSource.includes('class="definition-filter-count">(${count})'), "Definition filter options do not render their definition counts.");
  assert(fallbackSource.includes('input:indeterminate { accent-color: var(--warning); }'), "Indeterminate definition filter checkboxes are not yellow.");
  const searchNormalize = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const testCompactLookup = value => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const searchScoreContext = extractedFunction(fallbackSource, "searchScoreContext", "scoreRecord", {
    normalize: searchNormalize,
    compactLookup: testCompactLookup,
    compactFormLookup: testCompactLookup
  });
  const scoreRecord = extractedFunction(fallbackSource, "scoreRecord", "searchResultCounts", {
    state: { searchScopeActive: false },
    normalize: searchNormalize,
    filterMatches: () => true,
    scopedStatuteRecordText: record => record.text,
    scopedCfrSearchFields: record => record.cfrFields,
    compactLookup: testCompactLookup,
    compactFormLookup: testCompactLookup,
    searchScoreContext,
    Math
  });
  const definitionsLandingScore = scoreRecord({ kind: "definition-index", title: "Definitions", cite: "498 source records", text: "definitions defined terms" }, "definitions");
  const statuteDefinitionsScore = scoreRecord({ kind: "usc", title: "Definitions", cite: "8 U.S.C. 1101", text: "8 usc 1101 definitions" }, "definitions");
  assert(definitionsLandingScore > statuteDefinitionsScore, "The Definitions page is not the top result for an exact definitions search.");
  const unrelatedPolicyScore = scoreRecord({ kind: "policy", title: "I-92", cite: "form", text: "i 92 forms chapter 7 privacy and confidentiality" }, "special situation");
  const matchingPolicyScore = scoreRecord({ kind: "policy", title: "Special Situations", cite: "chapter", text: "special situations" }, "special situation");
  assert.strictEqual(unrelatedPolicyScore, 0, "Search ranking treated an unmatched Policy Manual record as a hit.");
  assert(matchingPolicyScore > 0, "Search ranking removed a genuine Policy Manual text match.");

  const escapeStatutoryHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const statutoryNormPart = value => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const statutoryCanonicalPath = pathParts => (pathParts || []).map(value => `(${value})`).join("");
  const houseSectionUrl = extractedFunction(fallbackSource, "houseSectionUrl", "houseSubstructureFragment", { encodeURIComponent, String });
  const statuteStatus = extractedFunction(fallbackSource, "statuteStatus", "statuteStatusLabel", { String });
  const statuteStatusLabel = extractedFunction(fallbackSource, "statuteStatusLabel", "statuteSectionForRecord");
  const statuteSectionForRecord = extractedFunction(fallbackSource, "statuteSectionForRecord", "statuteRecordStatus", { inaMappedSection: row => row?.mappedSection || null });
  const statuteRecordStatus = extractedFunction(fallbackSource, "statuteRecordStatus", "transferTargetLabel", { statuteStatus, statuteSectionForRecord });
  const transferTargetLabel = extractedFunction(fallbackSource, "transferTargetLabel", "transferTargetUrl");
  const transferTargetUrl = extractedFunction(fallbackSource, "transferTargetUrl", "transferSourceKey", { houseSectionUrl });
  const transferSourceKey = extractedFunction(fallbackSource, "transferSourceKey", "transferTargetForSource", { normCitationPart: value => String(value || "").replace(/[^a-z0-9-]/gi, "").toLowerCase(), String });
  const transferTargetForSource = extractedFunction(fallbackSource, "transferTargetForSource", "transferRecord", { transferSourceKey });
  const transferRecord = extractedFunction(fallbackSource, "transferRecord", "transferStatusMessage", { normalize: searchNormalize, transferSourceKey, transferTargetLabel });
  const transferStatusMessage = extractedFunction(fallbackSource, "transferStatusMessage", "statuteReaderCitationBase", { transferTargetLabel });
  const statuteReaderCitationBase = extractedFunction(fallbackSource, "statuteReaderCitationBase", "safeUrl");
  const repealedStatusSection = full.corpus.title8.sections.find(section => section.status === "repealed");
  const transferredStatusSection = full.corpus.title8.sections.find(section => section.section === "31, 32");
  const currentStatusSection = full.corpus.title8.sections.find(section => section.section === "1101");
  assert.strictEqual(statuteStatus({}), "current", "An absent statutory status is not treated as implied current law.");
  assert.strictEqual(statuteStatusLabel("transferred"), "Transferred", "The transferred-result badge label is unavailable.");
  assert.strictEqual(statuteRecordStatus({ kind: "statutory-note", item: { section: repealedStatusSection } }), "repealed", "A child statutory note did not inherit its top-level section's repealed status.");
  assert.strictEqual(statuteRecordStatus({ kind: "usc", item: currentStatusSection }), "current", "A current section was marked exceptional.");
  assert.strictEqual(transferTargetLabel({ title: 8, section: "1440", placement: "note" }), "a note under 8 U.S.C. 1440", "A transferred note destination is mislabeled as operative text.");
  assert.strictEqual(transferSourceKey("724a–1"), transferSourceKey("724a-1"), "A typographic dash and keyboard hyphen do not resolve to the same transferred source section.");
  assert.strictEqual(statuteReaderCitationBase(currentStatusSection, { type: "usc", label: "8 U.S.C. 1101(a)(15)" }, null, null), "8 U.S.C. 1101", "A deep citation was reused as the reader's section base and would duplicate its paragraph path.");
  assert.strictEqual(statuteReaderCitationBase(transferredStatusSection, { type: "usc" }, { source: "31", title: 52, section: "10101" }, null), "8 U.S.C. 31", "A transferred reader landing did not preserve the exact former source citation.");
  assert.strictEqual(statuteReaderCitationBase(currentStatusSection, { type: "ina" }, null, { inaSection: "101" }), "INA 101", "An INA reader landing lost its citation system.");
  assert(transferRecord(transferredStatusSection, transferredStatusSection.transferTargets[0]).text.includes("8 usc 31"), "A transferred source section was not pre-indexed under its exact former citation.");
  const statuteStatusWarning = extractedFunction(fallbackSource, "statuteStatusWarning", "renderStatutoryNote", {
    statuteStatus,
    transferTargetLabel,
    transferTargetUrl,
    transferStatusMessage,
    sectionMap: new Map([["1551", currentStatusSection]]),
    normCitationPart: statutoryNormPart,
    escapeHtml: escapeStatutoryHtml,
    Number
  });
  assert.strictEqual(statuteStatusWarning(currentStatusSection), "", "A current section renders an unnecessary status warning.");
  const repealedWarning = statuteStatusWarning(repealedStatusSection);
  assert(repealedWarning.includes("has been repealed and is not current law") && repealedWarning.includes("existing official House source record"), "The repealed-statute warning does not explain status and source limits.");
  const internalTransferWarning = statuteStatusWarning(full.corpus.title8.sections.find(section => section.section === "100, 101"), { source: "100", title: 8, section: "1551" });
  assert(internalTransferWarning.includes('data-show-citation="8 U.S.C. 1551"') && internalTransferWarning.includes("was transferred and is not current at this location"), "An internal transferred-section warning does not link to the indexed destination.");
  const externalTransferWarning = statuteStatusWarning(transferredStatusSection, transferredStatusSection.transferTargets[0]);
  assert(externalTransferWarning.includes("data-open-url=") && externalTransferWarning.includes("52 U.S.C. 10101"), "A cross-title transferred-section warning does not link to the official destination.");
  assert(/\.legal-status-warning\s*\{[\s\S]*?position:\s*sticky/.test(fallbackSource), "Exceptional statutory warnings are not sticky while the reader scrolls.");
  let redirectedTransferQuery = "";
  let openedTransferUrl = "";
  const transferToasts = [];
  const openTransferDestination = extractedFunction(fallbackSource, "openTransferDestination", "selectRecord", {
    transferTargetLabel,
    transferTargetUrl,
    sectionMap: new Map([["1551", currentStatusSection]]),
    normCitationPart: statutoryNormPart,
    applySearchQuery: query => { redirectedTransferQuery = query; },
    safeOpen: url => { openedTransferUrl = url; },
    toast: message => { transferToasts.push(message); },
    Number
  });
  assert(openTransferDestination({ cite: "8 U.S.C. 100", dispositionTarget: { source: "100", title: 8, section: "1551" } }), "An internal transfer destination was not actionable.");
  assert.strictEqual(redirectedTransferQuery, "8 U.S.C. 1551", "Clicking an internal transferred result does not navigate to its current location.");
  assert.strictEqual(openedTransferUrl, "", "An internal transferred result unnecessarily opened an external tab.");
  assert(openTransferDestination({ cite: "8 U.S.C. 31", dispositionTarget: { source: "31", title: 52, section: "10101" } }), "A cross-title transfer destination was not actionable.");
  assert(openedTransferUrl.includes("title52-section10101"), "Clicking a cross-title transferred result does not open its official House destination.");
  assert.strictEqual(transferToasts.length, 2, "Transferred-result navigation did not provide confirmation for each path.");
  const houseSubstructureFragment = extractedFunction(fallbackSource, "houseSubstructureFragment", "officialTextFragment", { String });
  const officialTextFragment = extractedFunction(fallbackSource, "officialTextFragment", "cfrOfficialTextFragment", { houseSectionUrl, houseSubstructureFragment, decodeURIComponent, URL, String });
  const cfrOfficialTextFragment = extractedFunction(fallbackSource, "cfrOfficialTextFragment", "legalUnitTriggerHtml", { canonicalPath: statutoryCanonicalPath, String });
  assert.strictEqual(houseSubstructureFragment(["a", "15", "H", "i"]), "#substructure-location_a_15_H_i", "House deep links do not use the publisher's structural anchors.");
  assert.strictEqual(houseSectionUrl("1153"), "https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title8-section1153&num=0&edition=prelim", "The House URL builder does not follow the publisher's documented direct-link format.");
  assert.strictEqual(officialTextFragment("https://uscode.house.gov/view.xhtml?req=section1101", ["a", "15", "H"]), "https://uscode.house.gov/view.xhtml?req=section1101#substructure-location_a_15_H", "A House unit link does not target the exact statutory structure.");
  assert.strictEqual(officialTextFragment("https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title8-section1153", ["b", "1", "A"]), "https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title8-section1153&num=0&edition=prelim#substructure-location_b_1_A", "A cached House URL was not normalized to the documented deep-link form.");
  assert.strictEqual(cfrOfficialTextFragment({ section: "214.2", url: "https://www.ecfr.gov/current/title-8/section-214.2" }, ["h", "13", "iii", "A"]), "https://www.ecfr.gov/current/title-8/section-214.2#p-214.2(h)(13)(iii)(A)", "An eCFR unit link does not target the exact paragraph ID.");
  assert.strictEqual(cfrOfficialTextFragment({ label: "Appendix A to Part 19", url: "https://www.ecfr.gov/current/title-6/part-19" }, ["a"]), "https://www.ecfr.gov/current/title-6/part-19/appendix-Appendix%20A%20to%20Part%2019", "A CFR appendix action does not open the publisher's appendix route.");
  assert(!fallbackSource.includes("#:~:text="), "Fragile browser text fragments remain in official statutory links.");
  const normalizedSearchText = extractedFunction(fallbackSource, "normalizedSearchText", "searchTextMatch", { String });
  const searchTextMatch = extractedFunction(fallbackSource, "searchTextMatch", "cfrSearchTarget", { normalize: searchNormalize, normalizedSearchText, String });
  const cfrSectionMap = new Map(full.corpus.cfr.sections.map(section => [`${section.title}:${statutoryNormPart(section.section)}`, section]));
  const cfrSectionIdMap = new Map(full.corpus.cfr.sections.map(section => [section.id, section]));
  const cfrAppendixIdMap = new Map(full.corpus.cfr.appendices.map(appendix => [appendix.id, appendix]));
  const cfrPartMap = new Map(full.corpus.cfr.parts.map(part => [`${part.title}:${statutoryNormPart(part.part)}`, part]));
  const cfrPartsByTitle = new Map();
  for (const part of full.corpus.cfr.parts) {
    if (!cfrPartsByTitle.has(Number(part.title))) cfrPartsByTitle.set(Number(part.title), []);
    cfrPartsByTitle.get(Number(part.title)).push(part);
  }
  const cfrRemovedPartMap = new Map(full.corpus.cfr.removedParts.map(part => [`${part.title}:${statutoryNormPart(part.part)}`, part]));
  const INA_TITLE_ROMAN = ["", "I", "II", "III", "IV", "V"];
  const INA_SOURCE_URL = full.corpus.sources.inaCrosswalk.url;
  const inaTitleGroups = [];
  for (const row of full.corpus.inaCrosswalk) {
    const number = Number(String(row.inaSection || "").match(/^[1-5]/)?.[0]);
    let title = inaTitleGroups.find(item => item.number === number);
    if (!title) {
      title = { number, roman: INA_TITLE_ROMAN[number], label: row.group, rows: [] };
      inaTitleGroups.push(title);
    }
    title.rows.push(row);
  }
  const inaBrowseSectionMap = new Map(full.corpus.title8.sections.map(section => [statutoryNormPart(section.section), section]));
  const inaMappedSection = row => row && !row.isNote && row.hasEquivalent && row.uscSection ? inaBrowseSectionMap.get(statutoryNormPart(row.uscSection)) || null : null;
  const inaSourceRecord = row => row ? { key: `ina:${row.inaSection}`, kind: "ina", group: "ina", cite: `INA ${row.inaSection}`, title: row.title || row.uscLabel || `INA ${row.inaSection}`, item: row, text: searchNormalize([row.title, row.uscLabel].join(" ")) } : null;
  const cfrBlockText = block => block?.t === "table" ? [block.caption, ...(block.rows || []).flat().map(cell => cell.x)].join(" ") : block?.t === "note" ? (block.blocks || []).map(cfrBlockText).join(" ") : block?.x || block?.alt || "";
  const cfrBlockUnitPaths = block => [...new Set([...(block?.u || []).map(unit => unit.a), block?.a].filter(Boolean))];
  const cfrSearchFields = extractedFunction(fallbackSource, "cfrSearchFields", "cfrBlockUnitPaths", { normalize: searchNormalize, cfrBlockText, cfrBlockUnitPaths });
  const cfrComponentTokens = value => {
    const text = String(value || "").trim();
    if (!text) return [];
    const tokens = [...text.matchAll(/\(([^()]+)\)/g)].map(match => match[1].trim());
    return tokens.length && text.replace(/\([^()]+\)/g, "").trim() === "" ? tokens : null;
  };
  const cfrBlockPlainText = extractedFunction(fallbackSource, "cfrBlockPlainText", "flattenedCfrBlocks", { String });
  const flattenedCfrBlocks = extractedFunction(fallbackSource, "flattenedCfrBlocks", "sameCitationPath", { Array });
  const sameCitationPath = extractedFunction(fallbackSource, "sameCitationPath", "citationPathStartsWith", { normCitationPart: statutoryNormPart });
  const citationPathStartsWith = extractedFunction(fallbackSource, "citationPathStartsWith", "cfrUnitText", { normCitationPart: statutoryNormPart });
  const cfrUnitText = extractedFunction(fallbackSource, "cfrUnitText", "legalUnitContextForTrigger", { flattenedCfrBlocks, sameCitationPath, citationPathStartsWith, componentTokens: cfrComponentTokens, cfrBlockPlainText, cfrBlockUnitPaths });
  const legalUnitContextForTrigger = extractedFunction(fallbackSource, "legalUnitContextForTrigger", "legalReferenceCitation", {
    corpus: hydratedSource,
    uscToIna: new Map([["1101", { inaSection: "101", uscSection: "1101" }]]),
    normCitationPart: statutoryNormPart,
    canonicalPath: statutoryCanonicalPath,
    statuteNodeAtPath: (section, pathParts) => pathParts.reduce((nodes, token, index) => (index ? nodes?.children : section.body)?.find(node => String(node.label) === String(token)), null),
    statuteUnitText: () => "selected statute text",
    officialTextFragment,
    houseSectionUrl,
    cfrSectionIdMap,
    cfrUnitText,
    cfrOfficialTextFragment,
    JSON
  });
  const h1bUnitContext = plain(legalUnitContextForTrigger({
    dataset: { legalUnitKind: "usc", legalUnitSection: hydratedSource.title8.sections.find(section => section.section === "1101").id, legalUnitPath: '["a","15","H","i","b"]', legalUnitCitation: "INA 101(a)(15)(H)(i)(b)" },
    closest: () => null
  }));
  assert.strictEqual(h1bUnitContext.uscCitation, "8 U.S.C. 1101(a)(15)(H)(i)(b)", "Copy USC Citation does not use the unit's complete U.S.C. path.");
  assert.strictEqual(h1bUnitContext.inaCitation, "INA 101(a)(15)(H)(i)(b)", "Copy INA Citation does not use the crosswalked unit path.");
  const legalUnitCitationRows = extractedFunction(fallbackSource, "legalUnitCitationRows", "openLegalUnitMenu", { Boolean });
  assert.deepStrictEqual(plain(legalUnitCitationRows(h1bUnitContext)), [
    { system: "INA", citation: "INA 101(a)(15)(H)(i)(b)", action: "copy-ina-citation" },
    { system: "USC", citation: "8 U.S.C. 1101(a)(15)(H)(i)(b)", action: "copy-usc-citation" }
  ], "An INA-opened statutory menu does not show the selected citation followed by its U.S.C. crosswalk.");
  const legalUnitPrintHtml = extractedFunction(fallbackSource, "legalUnitPrintHtml", "printLegalUnit", { escapeHtml: escapeStatutoryHtml, legalUnitCitationRows });
  const h1bPrintHtml = legalUnitPrintHtml(h1bUnitContext);
  assert(h1bPrintHtml.includes("INA 101(a)(15)(H)(i)(b)") && h1bPrintHtml.includes("8 U.S.C. 1101(a)(15)(H)(i)(b)"), "A statutory printout does not display both INA and U.S.C. citations.");
  assert(h1bPrintHtml.includes("background:#fff") && !h1bPrintHtml.includes("background:#0"), "A statutory printout no longer forces a light text-only background.");
  const cfr2142Text = cfrUnitText(full.corpus.cfr.sections.find(section => section.id === "8:214.2"), ["a", "2"]);
  assert(cfr2142Text.startsWith("(2) Definition of A-1 or A-2 dependent."), "CFR unit copying does not begin at the selected paragraph.");
  assert(cfr2142Text.includes("(i) Spouse;"), "CFR unit copying omits a selected paragraph's descendants.");
  assert(!cfr2142Text.includes("(3) Applicability of a formal bilateral agreement"), "CFR unit copying leaks into the next sibling paragraph.");
  const cfr2142RunInText = cfrUnitText(full.corpus.cfr.sections.find(section => section.id === "8:214.2"), ["a", "1"]);
  assert(cfr2142RunInText.startsWith("(a) Foreign government officials—(1) General."), "CFR unit copying cannot start at a run-in paragraph.");
  assert(!cfr2142RunInText.includes("(2) Definition of A-1 or A-2 dependent"), "Run-in CFR unit copying leaks into the next sibling paragraph.");
  const cfrCanonicalPath = parts => (parts || []).map(part => `(${part})`).join("");
  const renderCfrParagraphContents = extractedFunction(fallbackSource, "renderCfrParagraphContents", "renderCfrBlock", {
    String, Number,
    renderCfrStyledRange: (block, start, end) => escapeStatutoryHtml(String(block?.x || "").slice(start, end)),
    componentTokens: cfrComponentTokens,
    canonicalPath: cfrCanonicalPath,
    escapeHtml: escapeStatutoryHtml,
    legalUnitTriggerHtml: (_kind, _sectionId, path, _citation, contents) => `<button data-test-cfr-unit="${path.join(".")}">${contents}</button>`
  });
  const runInUnitHtml = renderCfrParagraphContents(cfr2142RunIn, null, { id: "8:214.2" }, "8 CFR 214.2");
  assert(runInUnitHtml.includes('data-test-cfr-unit="a"') && runInUnitHtml.includes('data-test-cfr-unit="a.1"'), "The CFR renderer does not make both outer and run-in unit markers interactive.");
  assert(fallbackSource.includes('function cfrPathLevelLabel(index)') && fallbackSource.includes('`Paragraph level ${index + 1}`'), "The CFR navigator still uses statutory unit names for regulatory paragraph levels.");
  assert(fallbackSource.includes('.cfr-block[data-cfr-depth="6"]'), "Deep CFR paragraph indentation styling is missing.");
  const cfrItemText = item => (item?.blocks || []).map(block => block.x || (block.rows || []).flat().map(cell => cell.x).join(" ") || "").join(" ");
  const cfrBlockPaths = blocks => (blocks || []).flatMap(block => [...cfrBlockUnitPaths(block), ...(block.t === "note" ? cfrBlockPaths(block.blocks) : [])]);
  const letteredIdentifierFamily = extractedFunction(fallbackSource, "letteredIdentifierFamily", "statuteSectionFamilyResult", { normCitationPart: statutoryNormPart });
  const statuteSectionFamilyResult = extractedFunction(fallbackSource, "statuteSectionFamilyResult", "componentTokens", {
    String,
    corpus: hydratedSource,
    letteredIdentifierFamily,
    INA_SOURCE_URL
  });
  const parseCfr = extractedFunction(fallbackSource, "parseCfr", "parseAct", {
    Number, String, Set,
    cfrSectionMap, cfrSectionIdMap, cfrPartMap, cfrPartsByTitle, cfrRemovedPartMap,
    componentTokens: cfrComponentTokens,
    compactHierarchyTokens: cfrComponentTokens,
    canonicalPath: cfrCanonicalPath,
    normCitationPart: statutoryNormPart,
    normalize: searchNormalize,
    letteredIdentifierFamily,
    cfrItemText, cfrBlockPaths,
    cachedCfrBlockPaths: section => [...new Set(cfrBlockPaths(section?.blocks))]
  });
  const nestedCfr = parseCfr("8", "214.2(h)(13)(iii)(A)");
  assert(nestedCfr.valid && nestedCfr.level === "section" && !nestedCfr.external && nestedCfr.record.item.id === "8:214.2", "Nested cached CFR citation did not resolve locally.");
  assert.strictEqual(nestedCfr.message, "Section and paragraph found in this edition.");
  assert.strictEqual(parseCfr("8", "214.2(h)(13)(iii)(Z)").valid, false, "Invalid cached CFR paragraph path was accepted.");
  assert.strictEqual(parseCfr("22", "41.12").record.item.id, "22:41.12");
  assert.strictEqual(parseCfr("22", "42.11").record.item.id, "22:42.11");
  assert.strictEqual(parseCfr("42", "34.1").record.item.id, "42:34.1");
  const title22 = parseCfr("22", "");
  assert(title22.valid && title22.level === "title" && !title22.external && title22.parts.length === 12, "22 CFR does not resolve to its 12 authoritative indexed parts.");
  const parseCitationForCfrTitle = extractedFunction(fallbackSource, "parseCitation", "pathStartsWith", {
    parseCfr,
    parseLocalStatute: () => null,
    parseIna: () => null,
    parseAct: () => null
  });
  for (const raw of ["22cfr", "22 CFR", "22 C.F.R."]) {
    const titleResult = parseCitationForCfrTitle(raw);
    assert(titleResult?.valid && titleResult.level === "title" && titleResult.parts.length === 12, `Indexed CFR title syntax did not open the part list: ${raw}`);
  }
  const uncachedCfrTitle = parseCfr("26", "");
  assert(uncachedCfrTitle.valid && uncachedCfrTitle.level === "title" && uncachedCfrTitle.external, "An uncached CFR title did not retain the current-eCFR fallback.");
  for (const raw of ["41", "Part 41", "part41"]) {
    const partResult = parseCfr("22", raw);
    assert(partResult.valid && partResult.level === "part" && partResult.part.id === "22:41", `Cached CFR part syntax did not resolve locally: ${raw}`);
  }
  assert(parseCfr("22", "42").valid && parseCfr("22", "42").level === "part", "22 CFR Part 42 is not treated as a valid local part.");
  const cfr274Family = parseCfr("8", "274");
  assert(cfr274Family.valid && cfr274Family.level === "part-family", "Bare 8 CFR 274 does not open its letter-suffixed part family.");
  assert.deepStrictEqual(plain(cfr274Family.parts.map(part => String(part.part).toLowerCase())), ["274", "274a"], "8 CFR 274 does not include Part 274A as a separate matching part.");
  assert(parseCfr("8", "Part 274").valid && parseCfr("8", "Part 274").level === "part" && parseCfr("8", "Part 274").part.part === "274", "Explicit 8 CFR Part 274 no longer selects the exact part.");
  assert(parseCfr("8", "274A").valid && parseCfr("8", "274A").level === "part" && String(parseCfr("8", "274A").part.part).toLowerCase() === "274a", "Exact 8 CFR 274A no longer selects the lettered part.");
  assert.strictEqual(parseCfr("8", "274(a)").valid, false, "8 CFR 274(a) was confused with the separate lettered Part 274A.");
  const reservedCfrPart = parseCfr("8", "109");
  assert(reservedCfrPart.valid && reservedCfrPart.level === "part" && reservedCfrPart.part.sectionIds.length === 0, "A reserved CFR part is not retained as a valid local part.");
  const rangedReservedCfrPart = parseCfr("8", "Part 242-243");
  assert(rangedReservedCfrPart.valid && rangedReservedCfrPart.part.id === "8:242-243", "A locally indexed ranged CFR part identifier did not resolve.");
  const removedCfrPart = parseCfr("45", "402");
  assert(removedCfrPart.removed && removedCfrPart.level === "part" && !removedCfrPart.valid, "Removed 45 CFR Part 402 does not surface its tombstone.");
  const uncachedCfrPart = parseCfr("26", "Part 1");
  assert(uncachedCfrPart.valid && uncachedCfrPart.level === "part" && uncachedCfrPart.external, "An uncached explicit CFR part did not retain the current-eCFR fallback.");
  const uncachedCfr = parseCfr("26", "1.1");
  assert(uncachedCfr.valid && uncachedCfr.level === "section" && uncachedCfr.external && /not included/i.test(uncachedCfr.message), "Outside-coverage CFR lookup does not use the explicit eCFR fallback.");
  const cfrPartBrowseRecords = extractedFunction(fallbackSource, "cfrPartBrowseRecords", "citationScopeMatchingTargets", {
    cfrSectionIdMap,
    cfrAppendixIdMap,
    cachedCfrSearchFields: () => [],
    legalReferenceTargets: () => [],
    normalize: searchNormalize
  });
  const cfrTitleBrowseRecords = extractedFunction(fallbackSource, "cfrTitleBrowseRecords", "statuteSectionFamilyBrowseRecords", {
    normalize: searchNormalize
  });
  const statuteSectionFamilyBrowseRecords = extractedFunction(fallbackSource, "statuteSectionFamilyBrowseRecords", "cfrPartBrowseRecords", {
    normalize: searchNormalize,
    inaMappedSection
  });
  const title22Records = cfrTitleBrowseRecords(title22.parts);
  assert.strictEqual(title22Records.length, 12, "The 22 CFR title browser omits authoritative indexed parts.");
  assert.deepStrictEqual(plain(title22Records.map(record => record.cite)), plain(title22.parts.map(part => `22 CFR Part ${part.part}`)), "The CFR title browser does not preserve official corpus order.");
  assert(title22Records.some(record => record.cite === "22 CFR Part 42" && record.title === cfrPartMap.get("22:42").heading), "The CFR title browser does not use the authoritative stored Part 42 heading.");
  const cfr274Records = cfrTitleBrowseRecords(cfr274Family.parts);
  assert.deepStrictEqual(plain(cfr274Records.map(record => record.cite)), ["8 CFR Part 274", "8 CFR Part 274a"], "The CFR lettered-part browser does not expose both separate parts.");
  const inaAuthorityBrowseRecords = extractedFunction(fallbackSource, "inaAuthorityBrowseRecords", "inaTitleBrowseRecords", { normalize: searchNormalize });
  const inaTitleBrowseRecords = extractedFunction(fallbackSource, "inaTitleBrowseRecords", "cfrTitleBrowseRecords", { normalize: searchNormalize, inaMappedSection });
  assert.deepStrictEqual(plain(inaTitleGroups.map(title => [title.number, title.label, title.rows.length])), [
    [1, "Title I: General Provisions", 6],
    [2, "Title II: Immigration", 97],
    [3, "Title III: Nationality and Naturalization", 62],
    [4, "Title IV: Refugee Assistance", 11],
    [5, "Title V: Alien Terrorist Removal Procedures", 7]
  ], "The INA authority browser does not preserve the five authoritative USCIS title groups and counts.");
  const inaAuthorityRecords = inaAuthorityBrowseRecords(inaTitleGroups);
  assert.strictEqual(inaAuthorityRecords.length, 5, "Bare INA does not expose all five authoritative titles.");
  assert.deepStrictEqual(plain(inaAuthorityRecords.map(record => record.cite)), ["INA Title I", "INA Title II", "INA Title III", "INA Title IV", "INA Title V"], "The INA title choices are not in USCIS corpus order.");
  const inaTitleTwoRecords = inaTitleBrowseRecords(inaTitleGroups[1].rows);
  assert.strictEqual(inaTitleTwoRecords.length, 97, "INA Title II does not expose every authoritative crosswalk entry.");
  assert(inaTitleTwoRecords.some(record => record.cite === "INA 203" && record.title === "Allocation of immigrant visas." && record.item.uscLabel === "8 U.S.C. 1153"), "INA Title II omits the authoritative INA 203 crosswalk entry.");
  const inaTitleFourRecords = inaTitleBrowseRecords(inaTitleGroups[3].rows);
  assert(inaTitleFourRecords.find(record => record.cite === "INA 404")?.inaSourceOnly, "A note-only INA entry is incorrectly treated as local operative text.");
  assert(inaTitleFourRecords.find(record => record.cite === "INA 401")?.inaSourceOnly, "An INA entry with no U.S.C. equivalent is incorrectly treated as local operative text.");
  const ina274Records = statuteSectionFamilyBrowseRecords({
    type: "ina",
    rows: letteredIdentifierFamily("274", hydratedSource.inaCrosswalk, row => row.inaSection)
  });
  assert.deepStrictEqual(plain(ina274Records.map(record => record.cite)), ["INA 274", "INA 274A", "INA 274B", "INA 274C", "INA 274D"], "The INA lettered-section browser does not expose every separate section.");
  assert(ina274Records.every(record => record.authorityBrowseDirect), "Lettered statute-family results do not open their selected section directly.");
  const authorityBrowseExplicitMatch = extractedFunction(fallbackSource, "authorityBrowseExplicitMatch", "authorityBrowseExtraRecords", { normalize: searchNormalize, compactLookup: testCompactLookup });
  assert(!authorityBrowseExplicitMatch({ cite: "8 U.S.C. 1571", text: searchNormalize("INA amendment enacted in 2009") }, "INA 200"), "A title-browse shortcut loosely matched a year or unrelated INA text as an extra result.");
  assert(authorityBrowseExplicitMatch({ cite: "My note", text: searchNormalize("Research attached to INA 200") }, "INA 200"), "An outside result containing the exact browsed citation is not recognized as extra material.");
  const authorityBrowseAssociationMatches = extractedFunction(fallbackSource, "authorityBrowseAssociationMatches", "authorityBrowseExplicitMatch", {
    isInaAuthorityBrowse: result => result?.type === "ina" && result.level === "authority",
    isInaTitleBrowse: result => result?.type === "ina" && result.level === "title",
    isCfrTitleBrowse: result => result?.type === "cfr" && result.level === "title",
    isCfrPartBrowse: result => result?.type === "cfr" && result.level === "part",
    normCitationPart: statutoryNormPart,
    cfrSectionIdMap: new Map(),
    Set,
    Number
  });
  const titleTwoLinkedNote = { kind: "user-note", item: { associations: [{ family: "usc", title: 8, citationSystem: "ina", start: { unit: "1153", path: [] } }] } };
  assert(authorityBrowseAssociationMatches(titleTwoLinkedNote, { type: "ina", level: "title", rows: inaTitleGroups[1].rows }), "A user note linked to an INA Title II section is not counted as extra Title II material.");
  assert(!authorityBrowseAssociationMatches(titleTwoLinkedNote, { type: "ina", level: "title", rows: inaTitleGroups[2].rows }), "An INA Title II user note leaks into another curated title's extra count.");
  const possibleAuthorityExtras = [
    { key: "ina:201", group: "ina", title: "Curated INA row", testScore: 100 },
    { key: "cfr:related", group: "regulations", title: "Related regulation", testScore: 70 },
    { key: "user-note:linked", group: "notes", title: "Linked note", testScore: 90 },
    { key: "policy:unmatched", group: "policy", title: "Unmatched policy", testScore: 0 }
  ];
  const authorityBrowseExtraRecords = extractedFunction(fallbackSource, "authorityBrowseExtraRecords", "showCurrentSearchResults", {
    state: { citation: null, query: "INA 200" },
    isAuthorityBrowse: () => true,
    searchScoreContext: () => ({}),
    activeSearchRecords: () => possibleAuthorityExtras,
    authorityBrowseAssociationMatches: record => record.group === "notes",
    authorityBrowseExplicitMatch: record => record.testScore > 0,
    scoreRecord: record => record.testScore
  });
  assert.deepStrictEqual(plain(authorityBrowseExtraRecords({ type: "ina" }).map(record => record.key)), ["user-note:linked", "cfr:related"], "INA title browsing counts curated crosswalk rows as extra matches or omits genuine outside matches.");
  assert.deepStrictEqual(plain(authorityBrowseExtraRecords({ type: "cfr" }).map(record => record.key)), ["user-note:linked", "ina:201"], "CFR browsing counts curated regulation rows as extra matches or omits genuine outside matches.");
  const part41Records = cfrPartBrowseRecords(cfrPartMap.get("22:41"));
  assert.strictEqual(part41Records.length, 50, "22 CFR Part 41 does not expose all 50 section pages.");
  assert.deepStrictEqual(plain(part41Records.slice(0, 6).map(record => record.cite)), ["22 CFR 41.0", "22 CFR 41.1", "22 CFR 41.2", "22 CFR 41.3", "22 CFR 41.11", "22 CFR 41.12"], "Part 41 pages are not in official corpus order.");
  assert(part41Records.some(record => record.cite === "22 CFR 41.12" && record.title === "Classification symbols."), "Part 41 omits its classification-symbols page or title.");
  const part42Records = cfrPartBrowseRecords(cfrPartMap.get("22:42"));
  assert.strictEqual(part42Records.length, 36, "22 CFR Part 42 does not expose all 36 section pages.");
  assert(part42Records.some(record => record.cite === "22 CFR 42.11" && record.title === "Classification symbols."), "Part 42 omits its classification-symbols page or title.");
  const part62Records = cfrPartBrowseRecords(cfrPartMap.get("22:62"));
  assert.strictEqual(part62Records.length, 43, "22 CFR Part 62 does not expose all 40 sections and 3 appendices.");
  assert(part62Records.slice(-3).every(record => record.kind === "cfr-appendix"), "Part appendices are not listed after numbered sections.");
  const part416Records = cfrPartBrowseRecords(cfrPartMap.get("20:416"));
  assert.strictEqual(part416Records.length, 608, "A large CFR part does not expose its complete child-page list.");
  const partResultState = { filter: "all", allResults: [], resultCounts: {}, filteredResultCount: 0, results: [] };
  const setPartSearchResults = extractedFunction(fallbackSource, "setSearchResults", "isCfrPartBrowse", {
    state: partResultState,
    searchResultCounts: records => ({ all: records.length, regulations: records.length }),
    updateSearchFilterCounts: () => {},
    Map,
    Math,
    Number
  });
  setPartSearchResults(part416Records, { limit: Infinity });
  assert.strictEqual(partResultState.results.length, 608, "The generic 100-result cap truncates a CFR part browse list.");
  const cfrSearchTarget = extractedFunction(fallbackSource, "cfrSearchTarget", "statuteSearchTarget", { normalize: searchNormalize, searchTextMatch, cfrSearchFields });
  const searchRouteGroups = extractedFunction(fallbackSource, "searchRouteGroups", "filterMatches", { Set, String });
  for (const query of ["8 c", "8 cf", "8 CFR 214", "8 USC 1101", "INA 101", "Pub. L. 104-208", "special situation"]) {
    const groups = searchRouteGroups(query, "all");
    assert(groups.has("statutes") && groups.has("regulations") && groups.has("policy"), `Citation-shaped query “${query}” does not search the complete corpus for related material.`);
  }
  assert.deepStrictEqual([...searchRouteGroups("8 CFR 214", "regulations")], ["regulations"], "An explicit result filter no longer narrows the displayed source group.");
  assert.deepStrictEqual([...searchRouteGroups("", "all", "cites")], ["statutes", "regulations"], "A cites: search still scans nonlegal source groups.");
  const routedState = {
    activeSearchGroups: new Set(["statutes", "regulations"]),
    records: [{ key: "all-record" }],
    recordsByGroup: new Map([
      ["statutes", [{ key: "usc-record" }]],
      ["regulations", [{ key: "cfr-record" }]]
    ])
  };
  const activeSearchRecords = extractedFunction(fallbackSource, "activeSearchRecords", "searchScoreContext", { state: routedState });
  assert.deepStrictEqual(plain(activeSearchRecords().map(record => record.key)), ["usc-record", "cfr-record"], "Citation search does not retain both direct and related source buckets.");
  const scopeFilterState = { searchScopeActive: true, searchScope: { valid: true, family: "usc", sectionIds: new Set(["inside-section"]), pathsBySection: new Map() } };
  const searchScopeMatchesRecord = extractedFunction(fallbackSource, "searchScopeMatchesRecord", "searchScopePathForRecord", { state: scopeFilterState });
  assert(searchScopeMatchesRecord({ kind: "usc", item: { id: "inside-section" } }), "A U.S.C. record inside an INA citation scope was filtered out.");
  assert(!searchScopeMatchesRecord({ kind: "usc", item: { id: "outside-section" } }), "A statute beyond the citation range remained searchable.");
  assert(!searchScopeMatchesRecord({ kind: "ina", item: { id: "inside-section" } }) && !searchScopeMatchesRecord({ kind: "user-note", item: { id: "inside-section" } }), "Crosswalk or note records leaked into a law-text-only citation scope.");
  const cfrPartScopeFilterState = { searchScopeActive: true, searchScope: { valid: true, family: "cfr", sectionIds: new Set(["part-section", "part-appendix"]), pathsBySection: new Map() } };
  const cfrPartSearchScopeMatchesRecord = extractedFunction(fallbackSource, "searchScopeMatchesRecord", "searchScopePathForRecord", { state: cfrPartScopeFilterState });
  assert(cfrPartSearchScopeMatchesRecord({ kind: "cfr", item: { id: "part-section" } }), "A CFR section was filtered out of its part scope.");
  assert(cfrPartSearchScopeMatchesRecord({ kind: "cfr-appendix", item: { id: "part-appendix" } }), "A CFR appendix was filtered out of its part scope.");
  const testPathStartsWith = (path, prefix) => prefix.length <= path.length && prefix.every((token, index) => statutoryNormPart(token) === statutoryNormPart(path[index]));
  const citesScopeState = { searchScopeActive: true, searchScopeMode: "cites", searchScope: { valid: true, family: "usc", sectionIds: new Set(["usc-1101"]), pathsBySection: new Map([["usc-1101", ["a", "15", "S"]]]) } };
  const citationScopeMatchingTargets = extractedFunction(fallbackSource, "citationScopeMatchingTargets", "citationScopeMatchesRecord", { state: citesScopeState, pathStartsWith: testPathStartsWith });
  const citationScopeMatchesRecord = extractedFunction(fallbackSource, "citationScopeMatchesRecord", "searchScopeMatchesRecord", { state: citesScopeState, citationScopeMatchingTargets });
  const citesSearchScopeMatchesRecord = extractedFunction(fallbackSource, "searchScopeMatchesRecord", "searchScopePathForRecord", { state: citesScopeState, citationScopeMatchesRecord });
  const citesExactRecord = { kind: "cfr", citedTargets: [{ family: "usc", sectionId: "usc-1101", path: ["a", "15", "S"], sourceText: "section 101(a)(15)(S)" }] };
  assert(citesSearchScopeMatchesRecord(citesExactRecord), "A regulation with an exact outgoing link to the cites: target was filtered out.");
  assert(!citesSearchScopeMatchesRecord({ kind: "cfr", citedTargets: [{ family: "usc", sectionId: "usc-1101", path: ["a", "15", "R"] }] }), "A sibling statutory citation was mistaken for the cites: target.");
  assert(!citesSearchScopeMatchesRecord({ kind: "definition", citedTargets: citesExactRecord.citedTargets }), "A non-statutory search record leaked into cites: results.");
  const parentCitesScope = { ...citesScopeState.searchScope, pathsBySection: new Map([["usc-1101", ["a", "15"]]]) };
  assert(citationScopeMatchesRecord(citesExactRecord, parentCitesScope), "A reference to a descendant did not match a broader cites: provision.");
  const resultFilterGroups = new Set(["all", "statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "policy", "forms", "notes"]);
  const searchResultCounts = extractedFunction(fallbackSource, "searchResultCounts", "updateSearchFilterCounts", { state: { allResults: [] }, RESULT_FILTER_GROUPS: resultFilterGroups, Object });
  const countedResults = searchResultCounts([
    { group: "statutes" }, { group: "statutes" }, { group: "regulations" }, { group: "policy" }
  ]);
  assert.deepStrictEqual(plain({ all: countedResults.all, statutes: countedResults.statutes, regulations: countedResults.regulations, policy: countedResults.policy, forms: countedResults.forms }), { all: 4, statutes: 2, regulations: 1, policy: 1, forms: 0 }, "Filter result counts do not reflect the complete matching set.");
  const syntheticRegulation = { title: 8, section: "999.1", heading: "Ordinary heading", blocks: [{ t: "p", x: "This is an unrelated displayed paragraph." }] };
  assert.strictEqual(cfrSearchTarget(syntheticRegulation, "special situation", "8 CFR 999.1"), null, "CFR search produced a hit without a displayed phrase or metadata occurrence.");
  syntheticRegulation.blocks.push({ t: "p", a: "(a)", x: "Special situations receive separate treatment." });
  const proseTarget = cfrSearchTarget(syntheticRegulation, "special situation", "8 CFR 999.1");
  assert.deepStrictEqual(plain({ matchType: proseTarget.matchType, path: proseTarget.path, blockPath: proseTarget.blockPath }), { matchType: "prose", path: "(a)", blockPath: [1] }, "CFR prose match did not retain its visible target.");
  assert.strictEqual(cfrSearchTarget(full.corpus.cfr.sections.find(section => section.id === "22:41.12"), "classification symbols", "22 CFR 41.12").matchType, "metadata", "CFR heading match is not labeled as metadata.");
  const projectedCfrSections = full.corpus.cfr.sections.map(section => ({
    section,
    citation: `${section.title} CFR ${section.section}`,
    fields: cfrSearchFields(section, `${section.title} CFR ${section.section}`)
  }));
  const cfrSearchStarted = performance.now();
  for (const query of ["special situation", "alien", "classification", "definitely absent synthetic phrase"]) {
    for (const record of projectedCfrSections) cfrSearchTarget(record.section, query, record.citation, record.fields);
  }
  const cfrSearchElapsed = performance.now() - cfrSearchStarted;
  assert(cfrSearchElapsed < 150, `Projected CFR phrase scans are too slow (${cfrSearchElapsed.toFixed(1)} ms for four full-corpus queries).`);
  assert(!fallbackSource.includes("cfrItemText(section)"), "CFR section prose is still collapsed and normalized into every search record.");
  console.log(`PASS search performance: four full CFR scans in ${cfrSearchElapsed.toFixed(1)} ms; citation searches retain related corpus sources`);
  assert(fallbackSource.includes('data-filter="regulations"'), "The Regulations result filter is missing.");
  assert(fallbackSource.includes('data-cfr-search-match'), "CFR result selection has no highlighted search target.");
  assert(fallbackSource.includes('Current regulation'), "The sticky navigator does not identify regulation context.");
  assert(!fallbackSource.includes('<div class="breadcrumb">${hierarchy}</div>'), "The regulation detail repeats the sticky navigator hierarchy.");
  assert(fallbackSource.includes('<details class="regulation-source-details"><summary>Source details</summary>'), "Regulation provenance is not collapsed under Source details.");
  assert(fallbackSource.indexOf('<div class="cfr-body">${(section.blocks || []).map') < fallbackSource.indexOf('<details class="regulation-source-details"><summary>Source details</summary>'), "Regulation source details are not placed after the regulation text.");
  assert(fallbackSource.includes('class="detail-heading-actions"') && fallbackSource.includes('"Current eCFR"'), "Regulation actions are not compactly aligned with the heading.");
  assert(!fallbackSource.includes('eCFR text current through'), "The regulation detail still repeats its citation and date subtitle.");
  assert(fallbackSource.includes('function fitStatuteNavigation()') && fallbackSource.includes('const preferredLabels = ["chapter", "subchapter", "part"]') && fallbackSource.includes('classList.add("unit-name-hidden")'), "The statute navigator does not use the requested hierarchy-first label compaction order.");
  assert(fallbackSource.includes('child.getClientRects().length'), "Hidden navigator elements are still included in the wrapping calculation.");
  assert(fallbackSource.includes('.statute-nav-segment.unit-name-hidden summary small { display: none; }'), "Individual unit-name compaction styling is missing.");
  assert(!fallbackSource.includes('statute-nav-inner.compact'), "The all-or-nothing statute-unit compaction rule remains enabled.");
  const testClassList = initial => {
    const values = new Set(initial || []);
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
  };
  const progressiveSegmentLabels = ["Title", "Chapter", "Subchapter", "Part", "Section", "Subsection", "Paragraph"];
  const progressiveSegments = progressiveSegmentLabels.map(navigationLabel => ({ classList: testClassList(), dataset: { navigationLabel } }));
  let progressiveNavigatorWide = false;
  let requiredHiddenNames = 4;
  const progressiveInner = { classList: testClassList(), dataset: { navigationKind: "usc" }, children: [] };
  progressiveInner.children = [
    {
      getClientRects: () => progressiveInner.classList.contains("intro-hidden") ? [] : [{}],
      getBoundingClientRect: () => ({ top: 0, height: 40 })
    },
    { getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 10, height: 20 }) },
    {
      getClientRects: () => [{}],
      getBoundingClientRect: () => progressiveNavigatorWide || progressiveSegments.filter(segment => segment.classList.contains("unit-name-hidden")).length >= requiredHiddenNames
        ? { top: 5, height: 30 }
        : { top: 50, height: 20 }
    }
  ];
  const fitStatuteNavigation = extractedFunction(fallbackSource, "fitStatuteNavigation", "setStatuteNavigationVisible", {
    els: { statuteNavigator: { hidden: false }, statuteNavigatorInner: progressiveInner },
    $$: () => progressiveSegments,
    Math
  });
  assert.strictEqual(fitStatuteNavigation(), 4, "The navigator did not stop hiding unit names as soon as one row fit.");
  assert(progressiveInner.classList.contains("intro-hidden"), "The non-unit navigator intro was not removed before unit names.");
  assert(progressiveSegments[1].classList.contains("unit-name-hidden") && progressiveSegments[2].classList.contains("unit-name-hidden") && progressiveSegments[3].classList.contains("unit-name-hidden"), "Chapter, Subchapter, and Part were not the first statute unit names hidden.");
  assert(progressiveSegments[6].classList.contains("unit-name-hidden"), "The deepest remaining statute unit name was not hidden after Chapter, Subchapter, and Part.");
  assert(!progressiveSegments[5].classList.contains("unit-name-hidden"), "A shallower statute unit name was hidden after the navigator already fit.");
  progressiveInner.dataset.navigationKind = "cfr";
  requiredHiddenNames = 2;
  assert.strictEqual(fitStatuteNavigation(), 2, "Regulation navigation no longer compacts from the deepest unit first.");
  assert(progressiveSegments[6].classList.contains("unit-name-hidden") && progressiveSegments[5].classList.contains("unit-name-hidden"), "The two deepest regulation unit names were not hidden first.");
  assert(!progressiveSegments[1].classList.contains("unit-name-hidden"), "Regulation navigation incorrectly inherited the statute hierarchy priority.");
  progressiveNavigatorWide = true;
  assert.strictEqual(fitStatuteNavigation(), 0, "Mixed-height navigator controls on one row are incorrectly treated as wrapped.");
  assert(!progressiveInner.classList.contains("intro-hidden") && progressiveSegments.every(segment => !segment.classList.contains("unit-name-hidden")), "The navigator did not restore every label after more room became available.");
  assert(!fallbackSource.includes("Cached regulation") && !fallbackSource.includes("Not cached"), "Technical cache language remains visible in the interface.");
  const feedbackElement = { className: "", textContent: "" };
  const renderCitationFeedback = extractedFunction(fallbackSource, "renderCitationFeedback", "renderCitationEquivalent", {
    state: { query: "22 CFR 42.11" },
    els: { feedback: feedbackElement },
    renderImpliedUscTitle: () => false,
    renderCitationEquivalent: () => null,
    renderCitationAmbiguity: () => null
  });
  renderCitationFeedback({ recognized: true, valid: true, label: "22 CFR 42.11", message: "Section found in this edition." });
  assert.strictEqual(feedbackElement.textContent, "", "A successful citation still displays a redundant loaded message.");
  assert.strictEqual(feedbackElement.className, "sr-only", "Citation feedback can escape its visually hidden container.");
  const shouldDeferBroadSearch = extractedFunction(fallbackSource, "shouldDeferBroadSearch", "findKnownPrefix", { String });
  assert(shouldDeferBroadSearch("I") && shouldDeferBroadSearch("IN"), "One- and two-letter deletion fragments still launch broad searches.");
  assert(!shouldDeferBroadSearch("INA") && !shouldDeferBroadSearch("F1"), "Useful three-letter or alphanumeric searches are incorrectly deferred.");
  assert(!shouldDeferBroadSearch("IN", { recognized: true }), "A recognized short citation is incorrectly deferred.");
  const inputHandlerSource = fallbackSource.match(/els\.search\.addEventListener\("input", event => \{([\s\S]*?)\n      \}\);\n      els\.search\.addEventListener\("scroll"/)?.[1] || "";
  assert(inputHandlerSource && !inputHandlerSource.includes("parseCitation("), "The input event still reparses citations synchronously on every keystroke.");
  assert(inputHandlerSource.includes("deleting ? 160 : 65"), "Deletion does not use the longer coalescing delay.");
  assert(inputHandlerSource.includes("closeSearchResults(undefined, true)"), "Clearing the search still rebuilds the previously rendered page.");
  assert(fallbackSource.includes("switchView(destination === \"search\" ? \"definitions\" : destination, false, !reuseRenderedView)"), "The fast close path does not reuse the existing page DOM.");
  const section1101ForCompactPaths = hydratedSource.title8.sections.find(section => String(section.section) === "1101");
  const section1255ForCompactPaths = hydratedSource.title8.sections.find(section => String(section.section) === "1255");
  assert.deepStrictEqual(
    plain(section1255ForCompactPaths.runInPaths.filter(pathParts => pathParts[0] === "c")),
    ["1", "2", "3", "4", "5", "6", "7", "8"].map(number => ["c", number]),
    "The generated run-in index does not contain every paragraph of 8 U.S.C. 1255(c)."
  );
  const compactComponentTokens = raw => {
    const value = String(raw || "").trim();
    if (!value) return [];
    const paren = [...value.matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
    if (paren.length && value.replace(/\([^)]+\)/g, "").replace(/[\s.,-]/g, "") === "") return paren;
    if (/\s|\(|\)|,/.test(value)) return value.replace(/[()]/g, " ").split(/[\s,]+/).filter(Boolean);
    return null;
  };
  const compactKnownInaPaths = new Map([
    ["h1a", { section: "101", path: ["a", "15", "H", "i", "a"] }],
    ["h1b", { section: "101", path: ["a", "15", "H", "i", "b"] }],
    ["h1c", { section: "101", path: ["a", "15", "H", "i", "c"] }],
    ["h2a", { section: "101", path: ["a", "15", "H", "ii", "a"] }],
    ["h2b", { section: "101", path: ["a", "15", "H", "ii", "b"] }]
  ]);
  const compactKnownUscPaths = new Map([...compactKnownInaPaths].map(([key, item]) => [key, { ...item, section: "1101" }]));
  const compactPathApi = compactCitationPathFunctions(fallbackSource, {
    knownInaCitationPaths: compactKnownInaPaths,
    knownUscCitationPaths: compactKnownUscPaths,
    normCitationPart: statutoryNormPart,
    componentTokens: compactComponentTokens,
    canonicalPath: statutoryCanonicalPath,
    statuteNodeAtPath: (section, pathParts) => {
      let nodes = section?.body || [], node = null;
      for (const part of pathParts) { node = nodes.find(item => String(item.label) === String(part)); if (!node) return null; nodes = node.children || []; }
      return node;
    }
  });
  const compactH1b = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "101", section1101ForCompactPaths, "a15hib"));
  assert.deepStrictEqual(compactH1b.path, ["a", "15", "H", "i", "b"], "Compact H-1B citation did not resolve through indexed run-in units.");
  assert.strictEqual(compactH1b.valid, true);
  assert.strictEqual(compactH1b.virtual, true, "Flattened H-1B run-in units were incorrectly treated as structural nodes.");
  assert.strictEqual(compactH1b.ambiguity, null, "A uniquely valid lowercase Roman path was marked ambiguous.");
  const compactIna245c2 = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "245", section1255ForCompactPaths, "c2"));
  assert.deepStrictEqual(compactIna245c2.path, ["c", "2"], "Compact INA 245(c)(2) did not resolve through the generated run-in index.");
  assert.strictEqual(compactIna245c2.virtual, true, "INA 245(c)(2) was incorrectly treated as a structural corpus node.");
  const parenthesizedIna245c2 = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "245", section1255ForCompactPaths, "(c)(2)"));
  assert.deepStrictEqual(parenthesizedIna245c2.path, ["c", "2"], "Parenthesized INA 245(c)(2) did not resolve through the generated run-in index.");
  const inaByUscSection = new Map(hydratedSource.inaCrosswalk.filter(row => row.uscSection).map(row => [String(row.uscSection).toLowerCase(), row]));
  let auditedGeneratedRunInPaths = 0;
  for (const section of hydratedSource.title8.sections) {
    for (const pathParts of section.runInPaths || []) {
      auditedGeneratedRunInPaths += 1;
      const parenthesized = plain(compactPathApi.resolveIndexedCompactStatutePath("usc", section.section, section, statutoryCanonicalPath(pathParts)));
      assert(parenthesized?.valid && JSON.stringify(parenthesized.path) === JSON.stringify(pathParts), `Parenthesized 8 U.S.C. ${section.section}${statutoryCanonicalPath(pathParts)} did not resolve to its generated run-in path.`);
      const compact = plain(compactPathApi.resolveIndexedCompactStatutePath("usc", section.section, section, pathParts.join("")));
      const compactOptions = [compact?.path, ...(compact?.ambiguity?.options || []).map(option => option.path)].filter(Boolean);
      assert(compact?.valid && compactOptions.some(option => JSON.stringify(option) === JSON.stringify(pathParts)), `Compact 8 U.S.C. ${section.section}${statutoryCanonicalPath(pathParts)} does not include its generated run-in path.`);
      const inaRow = inaByUscSection.get(String(section.section).toLowerCase());
      if (inaRow) {
        const inaParenthesized = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", inaRow.inaSection, section, statutoryCanonicalPath(pathParts)));
        assert(inaParenthesized?.valid && JSON.stringify(inaParenthesized.path) === JSON.stringify(pathParts), `INA ${inaRow.inaSection}${statutoryCanonicalPath(pathParts)} did not resolve to its generated run-in path.`);
      }
    }
  }
  assert.strictEqual(auditedGeneratedRunInPaths, 256, "The exhaustive compact-citation audit did not visit every generated statutory run-in path.");
  const lowercaseRomanAmbiguity = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "101", section1101ForCompactPaths, "a15oiii"));
  assert.deepStrictEqual(lowercaseRomanAmbiguity.path, ["a", "15", "O", "iii"], "The longest valid clause was not selected for an ambiguous lowercase Roman sequence.");
  assert.deepStrictEqual(lowercaseRomanAmbiguity.ambiguity.options.map(option => option.path), [["a", "15", "O", "iii"], ["a", "15", "O", "ii", "I"]], "The valid lowercase Roman interpretations were not listed in priority order.");
  assert.deepStrictEqual(lowercaseRomanAmbiguity.ambiguity.options.map(option => option.casePattern), ["a15Oiii", "a15OiiI"], "Ambiguity choices do not retain compact case patterns.");
  assert.strictEqual(compactPathApi.citationWithRomanCase("INA101a15oiii", "a15OiiI"), "INA101a15oiiI", "Choosing an interpretation changed more than the required Roman-numeral case.");
  assert.strictEqual(compactPathApi.citationWithRomanCase("Ina 101-a15oiii", "a15OiiI"), "Ina 101-a15oiiI", "Choosing an interpretation did not preserve typed spacing and punctuation.");
  const section1153ForCompactPaths = hydratedSource.title8.sections.find(section => String(section.section) === "1153");
  const eb5RomanAmbiguity = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "203", section1153ForCompactPaths, "b5Biii"));
  assert(eb5RomanAmbiguity.ambiguity.options.some(option => JSON.stringify(option.path) === JSON.stringify(["b", "5", "B", "iii"])) && eb5RomanAmbiguity.ambiguity.options.some(option => JSON.stringify(option.path) === JSON.stringify(["b", "5", "B", "ii", "I"])), "The reported INA 203(b)(5)(B) ambiguity is not resolved into both expected valid paths.");
  const eb5SubclauseOption = eb5RomanAmbiguity.ambiguity.options.find(option => JSON.stringify(option.path) === JSON.stringify(["b", "5", "B", "ii", "I"]));
  assert.strictEqual(compactPathApi.citationWithRomanCase("INA203b5Biii", eb5SubclauseOption.casePattern), "INA203b5BiiI", "The INA 203(b)(5)(B) ambiguity choice does not limit its edit to Roman-numeral case.");
  const explicitlyCasedRoman = plain(compactPathApi.resolveIndexedCompactStatutePath("ina", "101", section1101ForCompactPaths, "a15oiiI"));
  assert.deepStrictEqual(explicitlyCasedRoman.path, ["a", "15", "O", "ii", "I"], "An uppercase I did not disambiguate the compact citation.");
  assert.strictEqual(explicitlyCasedRoman.ambiguity, null, "An explicitly cased Roman sequence still shows ambiguity choices.");
  const compactLookupStart = performance.now();
  for (let index = 0; index < 20_000; index++) compactPathApi.resolveIndexedCompactStatutePath("ina", "101", section1101ForCompactPaths, index % 2 ? "a15oiii" : "a15hib");
  assert(performance.now() - compactLookupStart < 250, "Cached compact-citation ambiguity lookup is too slow for responsive typing.");
  const findKnownPrefix = extractedFunction(fallbackSource, "findKnownPrefix", "letteredIdentifierFamily", { String });
  const componentTokensForParser = extractedFunction(fallbackSource, "componentTokens", "childEntries", { String });
  const childEntriesForParser = extractedFunction(fallbackSource, "childEntries", "resolveComponents", { normCitationPart: statutoryNormPart });
  const resolveComponentsForParser = extractedFunction(fallbackSource, "resolveComponents", "resolveKnownCitationPath", { componentTokens: componentTokensForParser, normCitationPart: statutoryNormPart });
  const resolveKnownCitationPathForParser = extractedFunction(fallbackSource, "resolveKnownCitationPath", "nearestStructuralPath", { knownInaCitationPaths: compactKnownInaPaths, knownUscCitationPaths: compactKnownUscPaths, componentTokens: componentTokensForParser, citationPathKey: (section, pathParts) => `${statutoryNormPart(section)}:${pathParts.map(statutoryNormPart).join("/")}`, normCitationPart: statutoryNormPart });
  const section1182ForScopeRange = hydratedSource.title8.sections.find(section => String(section.section) === "1182");
  const section1185ForStartup = hydratedSource.title8.sections.find(section => String(section.section) === "1185");
  const section1161ForIna = hydratedSource.title8.sections.find(section => String(section.section) === "1161");
  const section31ForTransfer = hydratedSource.title8.sections.find(section => String(section.section) === "31, 32");
  const section100ForTransfer = hydratedSource.title8.sections.find(section => String(section.section) === "100, 101");
  const section724ForTransfer = hydratedSource.title8.sections.find(section => String(section.section) === "724a–1");
  const localParserSectionMap = new Map([["1101", section1101ForCompactPaths], ["1153", section1153ForCompactPaths], ["1161", section1161ForIna], ["1182", section1182ForScopeRange], ["1185", section1185ForStartup], ["1255", section1255ForCompactPaths]]);
  for (const section of [section31ForTransfer, section100ForTransfer, section724ForTransfer]) {
    for (const target of section.transferTargets) {
      localParserSectionMap.set(statutoryNormPart(target.source), section);
      localParserSectionMap.set(transferSourceKey(target.source), section);
    }
  }
  const parseLocalStatute = extractedFunction(fallbackSource, "parseLocalStatute", "parseFallbackStatute", {
    corpus: hydratedSource,
    hasLocalUscCache: true,
    inaMap: new Map([["101", { inaSection: "101", uscSection: "1101", hasEquivalent: true }], ["203", { inaSection: "203", uscSection: "1153", hasEquivalent: true }], ["210a", full.corpus.inaCrosswalk.find(row => row.inaSection === "210A")], ["212", { inaSection: "212", uscSection: "1182", hasEquivalent: true }], ["215", { inaSection: "215", uscSection: "1185", hasEquivalent: true }], ["245", { inaSection: "245", uscSection: "1255", hasEquivalent: true }], ["401", full.corpus.inaCrosswalk.find(row => row.inaSection === "401")], ["404", full.corpus.inaCrosswalk.find(row => row.inaSection === "404")]]),
    sectionMap: localParserSectionMap,
    uscToIna: new Map([["1101", { inaSection: "101", uscSection: "1101", hasEquivalent: true }], ["1153", { inaSection: "203", uscSection: "1153", hasEquivalent: true }], ["1161", full.corpus.inaCrosswalk.find(row => row.inaSection === "210A")], ["1182", { inaSection: "212", uscSection: "1182", hasEquivalent: true }], ["1185", { inaSection: "215", uscSection: "1185", hasEquivalent: true }], ["1255", { inaSection: "245", uscSection: "1255", hasEquivalent: true }]]),
    findKnownPrefix,
    resolveIndexedCompactStatutePath: compactPathApi.resolveIndexedCompactStatutePath,
    resolveComponents: resolveComponentsForParser,
    resolveKnownCitationPath: resolveKnownCitationPathForParser,
    canonicalPath: statutoryCanonicalPath,
    normCitationPart: statutoryNormPart,
    normalize: searchNormalize,
    statuteStatus,
    transferTargetForSource,
    transferRecord,
    transferTargetUrl,
    transferStatusMessage,
    inaMappedSection,
    inaSourceRecord,
    INA_SOURCE_URL,
    parseFallbackStatute: () => { throw new Error("Local citation unexpectedly used fallback parsing."); }
  });
  const parsedCompactH1b = plain(parseLocalStatute("ina", "101a15hib"));
  assert(parsedCompactH1b.valid && parsedCompactH1b.label === "INA 101(a)(15)(H)(i)(b)", "The complete compact H-1B citation does not survive the local parser.");
  const parsedDefaultStartup = plain(parseLocalStatute("ina", "203b1a"));
  assert(parsedDefaultStartup.valid && parsedDefaultStartup.label === "INA 203(b)(1)(A)" && JSON.stringify(parsedDefaultStartup.path) === JSON.stringify(["b", "1", "A"]), "The parenthesis-free INA 203b1a startup text does not resolve to INA 203(b)(1)(A).");
  const parsedCompactIna245c2 = plain(parseLocalStatute("ina", "245c2"));
  assert(parsedCompactIna245c2.valid && parsedCompactIna245c2.label === "INA 245(c)(2)" && JSON.stringify(parsedCompactIna245c2.path) === JSON.stringify(["c", "2"]), "The complete compact INA 245(c)(2) citation does not survive the local parser.");
  const parsedParenthesizedIna245c2 = plain(parseLocalStatute("ina", "245(c)(2)"));
  assert(parsedParenthesizedIna245c2.valid && parsedParenthesizedIna245c2.label === "INA 245(c)(2)" && JSON.stringify(parsedParenthesizedIna245c2.path) === JSON.stringify(["c", "2"]), "The parenthesized INA 245(c)(2) citation does not survive the local parser.");
  const parsedRomanAmbiguity = plain(parseLocalStatute("ina", "101a15oiii"));
  assert(parsedRomanAmbiguity.valid && parsedRomanAmbiguity.ambiguity.options.length === 2, "The local parser did not retain valid ambiguity choices.");
  assert.deepStrictEqual(parsedRomanAmbiguity.renderPath, ["a", "15", "O", "iii"], "The parser still truncates a selected compact path before navigation.");
  const noteOnlyIna404 = plain(parseLocalStatute("ina", "404"));
  assert(noteOnlyIna404.valid && !noteOnlyIna404.section && noteOnlyIna404.record?.kind === "ina", "INA 404 incorrectly opens the unrelated local 8 U.S.C. 1101 operative text.");
  const noEquivalentIna401 = plain(parseLocalStatute("ina", "401"));
  assert(noEquivalentIna401.valid && !noEquivalentIna401.section && noEquivalentIna401.record?.kind === "ina", "INA 401 does not retain its authoritative source-only landing record.");
  const parsedTransferred31 = plain(parseLocalStatute("usc", "31"));
  assert(parsedTransferred31.valid && parsedTransferred31.label === "8 U.S.C. 31" && parsedTransferred31.dispositionTarget?.title === 52 && parsedTransferred31.dispositionTarget?.section === "10101", "The exact former citation 8 U.S.C. 31 does not resolve to its reviewed transfer destination.");
  assert.strictEqual(parsedTransferred31.record?.key, `usc-transfer:${section31ForTransfer.id}:31`, "The transferred citation does not select its pre-indexed result record.");
  const parsedTransferredParagraph = plain(parseLocalStatute("usc", "31(a)"));
  assert(!parsedTransferredParagraph.valid && /does not contain/.test(parsedTransferredParagraph.message), "A nonexistent child paragraph under a transferred source was treated as locally navigable text.");
  const parsedInternalTransfer = plain(parseLocalStatute("usc", "100"));
  assert(parsedInternalTransfer.valid && parsedInternalTransfer.dispositionTarget?.title === 8 && parsedInternalTransfer.dispositionTarget?.section === "1551", "An internal Title 8 transfer does not resolve to its current section.");
  const parsedTransferredNote = plain(parseLocalStatute("usc", "724a–1"));
  assert(parsedTransferredNote.valid && parsedTransferredNote.dispositionTarget?.placement === "note" && parsedTransferredNote.dispositionTarget?.section === "1440", "A typographic-dash transferred note citation does not resolve to the indexed note destination.");
  assert(parseLocalStatute("usc", "724a-1").valid, "The keyboard-hyphen spelling of transferred 8 U.S.C. 724a-1 is not recognized.");
  const inaTitleNumberFromBrowseInput = extractedFunction(fallbackSource, "inaTitleNumberFromBrowseInput", "parseIna", { String, Number, INA_TITLE_ROMAN });
  const parseIna = extractedFunction(fallbackSource, "parseIna", "parseCfr", {
    String,
    INA_SOURCE_URL,
    inaTitleGroups,
    inaTitleNumberFromBrowseInput,
    statuteSectionFamilyResult,
    parseLocalStatute
  });
  const bareIna = parseIna("");
  assert(bareIna.valid && bareIna.level === "authority" && bareIna.titles.length === 5, "Bare INA does not resolve to the authoritative title browser.");
  for (const raw of ["2", "20", "200", "002", "II", "Title II"]) {
    const titleResult = parseIna(raw);
    assert(titleResult.valid && titleResult.level === "title" && titleResult.title === 2 && titleResult.rows.length === 97, `INA title shorthand did not resolve Title II: ${raw}`);
  }
  assert(parseIna("203").valid && parseIna("203").mapping?.inaSection === "203" && !parseIna("203").level, "An exact INA section lost priority to title browsing.");
  assert(parseIna("0203").valid && parseIna("0203").mapping?.inaSection === "203", "Leading zeroes prevent navigation to an exact INA section.");
  assert(parseIna("210A").valid && parseIna("210A").mapping?.inaSection === "210A", "An alphanumeric INA section is intercepted by title browsing.");
  const ina274Family = parseIna("274");
  assert(ina274Family.valid && ina274Family.level === "section-family", "Bare INA 274 does not open its letter-suffixed section family.");
  assert.deepStrictEqual(plain(ina274Family.rows.map(row => row.inaSection)), ["274", "274A", "274B", "274C", "274D"], "INA 274 does not include every separately numbered letter-suffixed section.");
  assert.strictEqual(statuteSectionFamilyResult("ina", "274(a)"), null, "INA 274(a) was confused with the separate INA 274A section.");
  const parseCitationForImpliedUsc = extractedFunction(fallbackSource, "parseCitation", "pathStartsWith", {
    parseCfr: () => ({ type: "cfr" }),
    parseLocalStatute: (kind, raw) => ({ type: kind, recognized: true, valid: true, label: `8 U.S.C. ${raw}`, raw }),
    parseIna,
    statuteSectionFamilyResult,
    parseAct: () => null
  });
  const impliedCompactUsc = plain(parseCitationForImpliedUsc("usc1101(a)(15)(H)"));
  assert.strictEqual(impliedCompactUsc.raw, "1101(a)(15)(H)", "A compact titleless U.S.C. citation was not parsed as Title 8.");
  assert.strictEqual(impliedCompactUsc.impliedUscTitle, 8, "A titleless U.S.C. citation does not retain its Title 8 assumption for display.");
  const impliedPunctuatedUsc = plain(parseCitationForImpliedUsc("U.S.C. § 1153(b)"));
  assert.strictEqual(impliedPunctuatedUsc.raw, "1153(b)", "A punctuated titleless U.S.C. citation was not parsed as Title 8.");
  assert.strictEqual(parseCitationForImpliedUsc("USCIS Glossary"), null, "The Title 8 fallback incorrectly captures text beginning with USCIS.");
  assert.strictEqual(parseCitationForImpliedUsc("8 USC 1101").impliedUscTitle, undefined, "An explicit Title 8 citation was incorrectly marked as assumed.");
  const usc1324Family = parseCitationForImpliedUsc("8 USC 1324");
  assert(usc1324Family.valid && usc1324Family.level === "section-family", "Bare 8 U.S.C. 1324 does not open its letter-suffixed section family.");
  assert.deepStrictEqual(plain(usc1324Family.sections.map(section => String(section.section).toLowerCase())), ["1324", "1324a", "1324b", "1324c", "1324d"], "8 U.S.C. 1324 does not include every separately numbered letter-suffixed section.");
  assert.strictEqual(statuteSectionFamilyResult("usc", "1324(a)"), null, "8 U.S.C. 1324(a) was confused with the separate 8 U.S.C. 1324a section.");
  for (const raw of ["INA", "ina", "I.N.A."]) {
    const authorityResult = parseCitationForImpliedUsc(raw);
    assert(authorityResult?.valid && authorityResult.level === "authority" && authorityResult.titles.length === 5, `Flexible bare INA syntax did not open the title browser: ${raw}`);
  }
  const parseCitationForScope = extractedFunction(fallbackSource, "parseCitation", "pathStartsWith", {
    parseCfr,
    parseLocalStatute,
    parseIna,
    statuteSectionFamilyResult,
    parseAct: () => null
  });
  const scopeSectionMap = new Map(hydratedSource.title8.sections.map(section => [statutoryNormPart(section.section), section]));
  const { parseSearchScope } = searchScopeParsingFunctions(fallbackSource, {
    corpus: hydratedSource,
    sectionMap: scopeSectionMap,
    normCitationPart: statutoryNormPart,
    inaTitleGroups,
    inaMappedSection,
    parseCitation: parseCitationForScope
  });
  const wholeInaScope = parseSearchScope("INA");
  assert(wholeInaScope.valid && wholeInaScope.hierarchy === "authority" && wholeInaScope.sectionIds.size === 172, `Bare INA does not scope every locally mapped operative INA section exactly once (${wholeInaScope.sectionIds.size}).`);
  for (const raw of ["INA 2", "INA 20", "INA 200", "INA II", "INA Title II"]) {
    const titleScope = parseSearchScope(raw);
    assert(titleScope.valid && titleScope.hierarchy === "title" && titleScope.label === "Title II: Immigration" && titleScope.sectionIds.size === 97, `INA Title II hierarchy scope did not resolve: ${raw} (${titleScope.sectionIds.size})`);
  }
  const inaSectionRangeScope = parseSearchScope("ina 101-215");
  assert(inaSectionRangeScope.valid && inaSectionRangeScope.range && inaSectionRangeScope.label === "INA 101–215", "The flexible INA section-range syntax did not resolve.");
  assert(inaSectionRangeScope.sectionIds.has(section1101ForCompactPaths.id) && inaSectionRangeScope.sectionIds.has(section1185ForStartup.id) && inaSectionRangeScope.sectionIds.has(section1153ForCompactPaths.id), "An INA range omitted its endpoints or an indexed intervening section.");
  assert(!inaSectionRangeScope.sectionIds.has(section1255ForCompactPaths.id), "An INA range leaked into a section beyond its ending citation.");
  const compactIna101Scope = parseSearchScope("ina101");
  assert(compactIna101Scope.valid && compactIna101Scope.label === "INA 101" && compactIna101Scope.sectionIds.has(section1101ForCompactPaths.id), "The in: field rejected compact INA syntax that the main search accepts.");
  const repeatedAuthorityRangeScope = parseSearchScope("ina101-ina212");
  assert(repeatedAuthorityRangeScope.valid && repeatedAuthorityRangeScope.label === "INA 101–212", `The in: field rejected a compact INA range with the authority repeated at both endpoints: ${JSON.stringify({ valid: repeatedAuthorityRangeScope.valid, label: repeatedAuthorityRangeScope.label, message: repeatedAuthorityRangeScope.message })}`);
  assert(repeatedAuthorityRangeScope.sectionIds.has(section1101ForCompactPaths.id) && repeatedAuthorityRangeScope.sectionIds.has(scopeSectionMap.get("1182").id), "The compact repeated-authority INA range omitted one of its endpoints.");
  for (const mainSearchCitation of [
    "INA 101", "ina101", "INA101(a)(15)(H)(i)(b)", "ina101a15hib",
    "8 U.S.C. 1101", "8usc1101", "usc1101", "U.S.C. § 1101(a)",
    "8 CFR 214.2", "8cfr214.2", "8 CFR 214.2(h)(13)",
    "22 CFR 41", "22cfr41", "22 CFR Part 41"
  ]) {
    const mainSearchResult = parseCitationForScope(mainSearchCitation);
    assert(mainSearchResult?.valid && !mainSearchResult.external, `Main-search parity fixture is not a valid local citation: ${mainSearchCitation}`);
    assert(parseSearchScope(mainSearchCitation).valid, `The in: field rejected main-search citation syntax: ${mainSearchCitation}`);
  }
  const compactRunInScope = parseSearchScope("ina245c2");
  assert(compactRunInScope.valid && compactRunInScope.sectionIds.has(section1255ForCompactPaths.id), "A compact run-in citation was not accepted as a search scope.");
  assert.deepStrictEqual(plain(compactRunInScope.pathsBySection.get(section1255ForCompactPaths.id)), ["c", "2"], "The run-in citation scope lost its exact statutory path.");
  const cfrParagraphScope = parseSearchScope("8 CFR 214.2(h)(13)");
  assert(cfrParagraphScope.valid && cfrParagraphScope.sectionIds.has("8:214.2") && JSON.stringify(cfrParagraphScope.pathsBySection.get("8:214.2")) === JSON.stringify(["h", "13"]), "A CFR paragraph citation was not accepted as an exact scope.");
  const cfrPartScope = parseSearchScope("22 CFR 62");
  assert(cfrPartScope.valid && cfrPartScope.sectionIds.size === 43, "A CFR part citation did not scope all locally indexed sections and appendices in that part.");
  assert([...cfrPartScope.sectionIds].some(id => id.startsWith("22:62:appendix:")), "A CFR part scope omitted its appendices.");
  const cfrSectionRangeScope = parseSearchScope("22 CFR 41.11 - 41.12");
  assert(cfrSectionRangeScope.valid && cfrSectionRangeScope.sectionIds.has("22:41.11") && cfrSectionRangeScope.sectionIds.has("22:41.12"), "A CFR section range with flexible spaces did not resolve both endpoints.");
  assert.strictEqual(parseSearchScope("INA 215-101").valid, false, "A reversed citation range was silently accepted.");
  assert.strictEqual(parseSearchScope("INA 101-8 CFR 214.2").valid, false, "A mixed-authority citation range was silently accepted.");
  const cfrSectionMapForCites = new Map(hydratedSource.cfr.sections.map(section => [section.id, section]));
  const legalReferenceTargets = extractedFunction(fallbackSource, "legalReferenceTargets", "noteResultKind", {
    sectionMap: scopeSectionMap,
    cfrSectionIdMap: cfrSectionMapForCites,
    normCitationPart: statutoryNormPart,
    Set,
    String
  });
  const compactInaSReferenceScope = parseSearchScope("INA101a15s");
  assert(compactInaSReferenceScope.valid && compactInaSReferenceScope.label === "INA 101(a)(15)(S)", "The compact cites: example target is not accepted by the shared citation parser.");
  const cfr2451ForCites = hydratedSource.cfr.sections.find(section => section.id === "8:245.1");
  const cfr2451CitedTargets = legalReferenceTargets(cfr2451ForCites, "cfr");
  const cfr2451CitesRecord = { kind: "cfr", item: cfr2451ForCites, citedTargets: cfr2451CitedTargets };
  assert(citationScopeMatchesRecord(cfr2451CitesRecord, compactInaSReferenceScope), "8 CFR 245.1 was not indexed as a source that cites INA 101(a)(15)(S).");
  assert(cfr2451CitedTargets.some(target => target.family === "usc" && target.sectionId === section1101ForCompactPaths.id && target.path.join("/").toLowerCase() === "a/15/s"), "The CFR outgoing-reference index lost the INA 101(a)(15)(S) target path.");
  const usc1182ForCites = hydratedSource.title8.sections.find(section => section.section === "1182");
  assert(citationScopeMatchesRecord({ kind: "usc", item: usc1182ForCites, citedTargets: legalReferenceTargets(usc1182ForCites, "usc") }, compactInaSReferenceScope), "8 U.S.C. 1182 was not indexed as a statute citing INA 101(a)(15)(S).");
  assert(citationScopeMatchesRecord(cfr2451CitesRecord, inaSectionRangeScope), "A cites: INA section range did not include a regulation citing an endpoint provision.");
  const allLegalCitationSourceRecords = [
    ...hydratedSource.title8.sections.map(section => ({ key: `usc:${section.id}`, kind: "usc", item: section, citedTargets: legalReferenceTargets(section, "usc") })),
    ...hydratedSource.cfr.sections.map(section => ({ key: `cfr:${section.id}`, kind: "cfr", item: section, citedTargets: legalReferenceTargets(section, "cfr") })),
    ...hydratedSource.cfr.appendices.map(appendix => ({ key: `cfr-appendix:${appendix.id}`, kind: "cfr-appendix", item: appendix, citedTargets: legalReferenceTargets(appendix, "cfr") }))
  ];
  const compactInaSSources = allLegalCitationSourceRecords.filter(record => citationScopeMatchesRecord(record, compactInaSReferenceScope));
  assert.strictEqual(compactInaSSources.length, 24, "cites:INA101a15s did not return every uniquely indexed source citing that provision or one of its descendants.");
  assert(compactInaSSources.some(record => record.key === "usc:8-1182") && compactInaSSources.some(record => record.key === "cfr:8:245.1") && compactInaSSources.some(record => record.key === "cfr:22:41.12"), "The compact cites: example omitted a known statute, Title 8 regulation, or cross-title regulation.");
  const firstCfrToCfrSource = hydratedSource.cfr.sections.map(section => ({ section, targets: legalReferenceTargets(section, "cfr") })).find(record => record.targets.some(target => target.family === "cfr"));
  assert(firstCfrToCfrSource && citationScopeMatchesRecord({ kind: "cfr", citedTargets: firstCfrToCfrSource.targets }, (() => {
    const target = firstCfrToCfrSource.targets.find(item => item.family === "cfr");
    return { valid: true, family: "cfr", sectionIds: new Set([target.sectionId]), pathsBySection: new Map(target.path.length ? [[target.sectionId, target.path]] : []) };
  })()), "The outgoing-reference index cannot match a CFR-to-CFR citation target.");
  const impliedTitleShellClasses = new Set();
  const impliedTitleShell = { classList: { toggle: (name, active) => active ? impliedTitleShellClasses.add(name) : impliedTitleShellClasses.delete(name) } };
  const impliedTitleElements = {
    search: { value: "usc1101", closest: () => impliedTitleShell },
    impliedUscTitle: { hidden: true },
    impliedUscTitleNotice: { hidden: true }
  };
  const renderImpliedUscTitle = extractedFunction(fallbackSource, "renderImpliedUscTitle", "renderCitationAmbiguity", { els: impliedTitleElements, Boolean });
  assert.strictEqual(renderImpliedUscTitle(impliedCompactUsc), true, "The implied Title 8 presentation was not activated.");
  assert(impliedTitleShellClasses.has("has-implied-usc-title") && !impliedTitleElements.impliedUscTitle.hidden && !impliedTitleElements.impliedUscTitleNotice.hidden, "The implied Title 8 marker or warning remains hidden.");
  impliedTitleElements.search.value = "8usc1101";
  assert.strictEqual(renderImpliedUscTitle({ type: "usc", valid: true }), false, "An explicit Title 8 citation still displays the assumption warning.");
  const ambiguityShellClasses = new Set();
  const ambiguityShell = { classList: { toggle: (name, active) => active ? ambiguityShellClasses.add(name) : ambiguityShellClasses.delete(name) } };
  const ambiguityElements = {
    search: { value: "INA101a15oiii", closest: () => ambiguityShell, scrollLeft: 0 },
    searchInputMirror: { textContent: "", innerHTML: "", scrollLeft: 0 },
    citationAmbiguity: { hidden: true },
    citationAmbiguityOptions: { innerHTML: "" }
  };
  const renderCitationAmbiguity = extractedFunction(fallbackSource, "renderCitationAmbiguity", "renderCitationFeedback", { els: ambiguityElements, canonicalPath: statutoryCanonicalPath, citationWithRomanCase: compactPathApi.citationWithRomanCase, escapeHtml: escapeStatutoryHtml, Boolean });
  renderCitationAmbiguity({ type: "ina", ambiguity: lowercaseRomanAmbiguity.ambiguity });
  assert(ambiguityShellClasses.has("has-citation-ambiguity") && !ambiguityElements.citationAmbiguity.hidden, "Ambiguous citation styling and choices were not activated.");
  assert.strictEqual((ambiguityElements.searchInputMirror.innerHTML.match(/<mark>i<\/mark>/g) || []).length, 3, "The ambiguous lowercase i sequence is not highlighted yellow in the search bar.");
  assert(ambiguityElements.citationAmbiguityOptions.innerHTML.includes("INA 101(a)(15)(O)(iii)") && ambiguityElements.citationAmbiguityOptions.innerHTML.includes("INA 101(a)(15)(O)(ii)(I)"), "The ambiguity panel does not render every valid interpretation.");
  assert(ambiguityElements.citationAmbiguityOptions.innerHTML.includes('data-citation-interpretation="INA101a15oiiI"'), "The alternate interpretation does not preserve the user's compact citation format.");
  assert(!ambiguityElements.citationAmbiguityOptions.innerHTML.includes('data-citation-interpretation="INA 101('), "An ambiguity choice still rewrites the typed citation with canonical spacing or parentheses.");
  const searchFieldStart = fallbackSource.indexOf('<div class="search-field-shell">');
  const searchFieldEnd = fallbackSource.indexOf('</div>\n      </div>', searchFieldStart);
  const searchFieldMarkup = fallbackSource.slice(searchFieldStart, searchFieldEnd);
  assert(searchFieldMarkup.indexOf('id="searchInput"') < searchFieldMarkup.indexOf('id="citationEquivalent"'), "The crosswalk citation is not inside the main search field after the typed citation.");
  assert(searchFieldMarkup.indexOf('id="citationEquivalentIna"') < searchFieldMarkup.indexOf('class="citation-equivalent-arrow"') && searchFieldMarkup.indexOf('class="citation-equivalent-arrow"') < searchFieldMarkup.indexOf('id="citationEquivalentUsc"'), "The search crosswalk does not keep INA on the left and U.S.C. on the right.");
  assert((searchFieldMarkup.match(/<span aria-hidden="true">⧉<\/span>/g) || []).length === 2, "The search crosswalk does not provide one symbol-only copy control per citation.");
  assert(fallbackSource.includes('event.target.closest("[data-copy-citation]")') && fallbackSource.includes('event.target.closest("[data-citation-query]")'), "The search crosswalk does not separate copying from changing citation format.");
  const citationCrosswalkSource = fallbackSource.match(/function citationCrosswalk\(result\) \{[\s\S]*?\n    \}/)?.[0];
  assert(citationCrosswalkSource, "Could not extract citationCrosswalk from the application source.");
  const citationCrosswalk = vm.runInNewContext(`(${citationCrosswalkSource})`, {
    equivalentCitation: result => result.type === "ina"
      ? { system: "usc", label: "8 U.S.C. 1153(b)", query: "8 U.S.C. 1153(b)" }
      : { system: "ina", label: "INA 203(b)", query: "INA 203(b)" }
  });
  assert.deepStrictEqual(plain(citationCrosswalk({ type: "ina", label: "INA 203(b)" })), {
    ina: { system: "ina", label: "INA 203(b)", query: "INA 203(b)" },
    usc: { system: "usc", label: "8 U.S.C. 1153(b)", query: "8 U.S.C. 1153(b)" }
  }, "An INA query does not render the fixed INA/U.S.C. crosswalk order.");
  assert.deepStrictEqual(plain(citationCrosswalk({ type: "usc", label: "8 U.S.C. 1153(b)" })), {
    ina: { system: "ina", label: "INA 203(b)", query: "INA 203(b)" },
    usc: { system: "usc", label: "8 U.S.C. 1153(b)", query: "8 U.S.C. 1153(b)" }
  }, "A U.S.C. query does not render the fixed INA/U.S.C. crosswalk order.");
  const renderedCrosswalkShellClasses = new Set(["citation-crosswalk-below"]);
  const renderedCrosswalkShell = { classList: { remove: name => renderedCrosswalkShellClasses.delete(name) } };
  const crosswalkButton = () => ({ textContent: "", dataset: {}, setAttribute(name, value) { this[name] = value; } });
  const renderedCrosswalkElements = {
    search: { closest: () => renderedCrosswalkShell },
    citationEquivalent: { hidden: true },
    citationEquivalentIna: crosswalkButton(),
    citationEquivalentInaCopy: crosswalkButton(),
    citationEquivalentUsc: crosswalkButton(),
    citationEquivalentUscCopy: crosswalkButton()
  };
  const renderCitationEquivalent = extractedFunction(fallbackSource, "renderCitationEquivalent", "isSingleLegalResult", {
    citationCrosswalk: () => ({
      ina: { system: "ina", label: "INA 203(b)", query: "INA 203(b)" },
      usc: { system: "usc", label: "8 U.S.C. 1153(b)", query: "8 U.S.C. 1153(b)" }
    }),
    els: renderedCrosswalkElements,
    requestAnimationFrame: () => {},
    positionCitationEquivalent: () => {}
  });
  renderCitationEquivalent({ type: "usc" });
  assert(!renderedCrosswalkElements.citationEquivalent.hidden && renderedCrosswalkElements.citationEquivalentIna.textContent === "INA 203(b)" && renderedCrosswalkElements.citationEquivalentUsc.textContent === "8 U.S.C. 1153(b)", "The rendered search crosswalk does not show both citation systems.");
  assert(renderedCrosswalkElements.citationEquivalentInaCopy.dataset.copyCitation === "INA 203(b)" && renderedCrosswalkElements.citationEquivalentUscCopy.dataset.copyCitation === "8 U.S.C. 1153(b)", "The rendered crosswalk copy controls do not carry their own citations.");
  assert(fallbackSource.includes("measureText(els.search.value)") && fallbackSource.includes("positionCitationEquivalent"), "The inline crosswalk citation does not track the typed citation width.");
  assert(fallbackSource.includes('classList.add("citation-crosswalk-below")'), "The two-sided crosswalk lacks a narrow-screen layout that avoids covering the query.");
  const glossaryReferenceLabels = extractedFunction(fallbackSource, "glossaryReferenceLabels", "glossaryInlineLinks", { normalize: searchNormalize, Map, String });
  const glossaryAllowedHosts = new Set(full.corpus.approvedDomains);
  const glossarySafeUrl = value => {
    try { const parsed = new URL(value); return parsed.protocol === "https:" && glossaryAllowedHosts.has(parsed.hostname) ? parsed.href : ""; }
    catch { return ""; }
  };
  const glossaryInlineLinks = extractedFunction(fallbackSource, "glossaryInlineLinks", "renderDefinitionInlineText", { corpus: full.corpus, glossaryReferenceLabels, normalize: searchNormalize, safeUrl: glossarySafeUrl, searchTextMatch, String });
  const renderDefinitionInlineText = extractedFunction(fallbackSource, "renderDefinitionInlineText", "definitionReferenceSlice", { escapeHtml: escapeStatutoryHtml, glossaryInlineLinks, String });
  const glossaryDefinition = term => full.corpus.definitions.entries.find(entry => entry.sourceFamily === "uscis-glossary" && entry.term === term);
  const glossaryDefinitionUrls = full.corpus.definitions.entries
    .filter(entry => entry.sourceFamily === "uscis-glossary")
    .map(entry => ({ entry, url: new URL(entry.url) }));
  assert(glossaryDefinitionUrls.every(({ entry, url }) => url.origin === "https://www.uscis.gov" && decodeURIComponent(url.hash.replace(/^#:~:text=/, "")) === entry.term), "A USCIS Glossary source link does not target its exact term.");
  const disasterReliefHtml = renderDefinitionInlineText(glossaryDefinition("Disaster relief"));
  const aNumberHtml = renderDefinitionInlineText(glossaryDefinition("A-Number/Alien Registration Number/Alien Number (A-Number or A#)"));
  const arrivalRecordHtml = renderDefinitionInlineText(glossaryDefinition("Arrival-Departure Record (Form I-94/I-94A)"));
  assert(disasterReliefHtml.includes('data-definition-reference="Special Situations"'), "Disaster relief does not link to the Special Situations definition.");
  assert(aNumberHtml.includes('data-definition-reference="USCIS Number"'), "The A-Number definition does not link to the USCIS Number definition.");
  assert(arrivalRecordHtml.includes('href="https://uscis.gov/i-94information"'), "The Arrival-Departure Record definition does not link its embedded USCIS URL.");
  const numberHtml = renderDefinitionInlineText(glossaryDefinition("Number"));
  assert(numberHtml.includes('A-Number/Alien Registration Number/Alien Number (A-Number or A#)</button>'), "Trailing punctuation was left outside a glossary cross-reference link.");
  const glossaryExternalLinks = full.corpus.definitions.entries.flatMap(entry => glossaryInlineLinks(entry).filter(link => link.kind === "external"));
  assert.strictEqual(glossaryExternalLinks.length, 5, "Not every embedded government URL in the USCIS Glossary is clickable.");
  assert(glossaryExternalLinks.some(link => link.href === "https://www.irs.gov/"), "The embedded IRS URL is not clickable.");
  assert(glossaryExternalLinks.some(link => new URL(link.href).hostname === "justice.gov"), "The embedded Justice Department URLs are not clickable.");
  const glossaryDefinitionLinks = full.corpus.definitions.entries.flatMap(entry => glossaryInlineLinks(entry).filter(link => link.kind === "definition"));
  assert.strictEqual(glossaryDefinitionLinks.length, 23, "The glossary-wide cross-reference linker missed expected See references.");
  const definitionScopesById = new Map(full.corpus.definitions.scopes.map(scope => [scope.id, scope]));
  const definitionEntrySafeUrl = value => {
    try { const parsed = new URL(value); return parsed.protocol === "https:" && glossaryAllowedHosts.has(parsed.hostname) ? parsed.href : ""; }
    catch { return ""; }
  };
  const definitionReferenceSlice = extractedFunction(fallbackSource, "definitionReferenceSlice", "renderDefinitionLegalBody", {});
  const definitionSourceNode = (section, path) => {
    let nodes = section?.body || [];
    let node = null;
    for (const part of path || []) {
      node = nodes.find(candidate => String(candidate.label) === String(part));
      if (!node) return null;
      nodes = node.children || [];
    }
    return node;
  };
  const renderDefinitionLegalBody = extractedFunction(fallbackSource, "renderDefinitionLegalBody", "renderDefinitionEntry", {
    String,
    Number,
    corpus: full.corpus,
    statuteNodeAtPath: definitionSourceNode,
    definitionReferenceSlice,
    formatStatutoryRunInText: value => escapeStatutoryHtml(value),
    renderStatutoryNode: child => `<span data-definition-child="${escapeStatutoryHtml(child.label)}">${escapeStatutoryHtml(child.text)}</span>`
  });
  const renderDefinitionEntry = extractedFunction(fallbackSource, "renderDefinitionEntry", "renderDefinitions", {
    definitionScope: entry => definitionScopesById.get(entry.scopeId),
    definitionApplicabilityMatches: () => true,
    safeUrl: definitionEntrySafeUrl,
    escapeHtml: escapeStatutoryHtml,
    renderDefinitionInlineText: entry => escapeStatutoryHtml(entry.text),
    renderDefinitionLegalBody,
    officialTextFragment: (url, path) => `${url}#substructure-location_${path.join("_")}`
  });
  const accommodationEntryHtml = renderDefinitionEntry(glossaryDefinition("Accommodation"));
  assert(accommodationEntryHtml.includes('<a class="definition-citation" href="https://www.uscis.gov/tools/glossary#:~:text=Accommodation"'), "The USCIS Glossary source label is not linked to the selected definition.");
  assert(accommodationEntryHtml.includes("<dt>Applies in</dt>") && accommodationEntryHtml.includes("<dt>Source context</dt>") && !accommodationEntryHtml.includes("<dt>Defined at</dt>") && !accommodationEntryHtml.includes("<dt>Source scope</dt>"), "A glossary definition does not display only its useful applicability and context metadata.");
  assert(accommodationEntryHtml.includes('<details class="definition-scope-details"><summary>Definition details</summary>') && !accommodationEntryHtml.includes('<details class="definition-scope-details" open'), "Glossary metadata is not collapsed by default.");
  assert(!accommodationEntryHtml.includes("Open official source") && !accommodationEntryHtml.includes("definition-actions"), "A glossary definition still renders a separate source-action row.");
  const cfrDefinitionEntry = full.corpus.definitions.entries.find(entry => entry.sourceFamily === "cfr");
  const cfrDefinitionEntryHtml = renderDefinitionEntry(cfrDefinitionEntry);
  assert(cfrDefinitionEntryHtml.includes(`<button class="definition-citation" type="button" data-show-cfr-citation="${cfrDefinitionEntry.citation}"`), "The CFR definition citation does not navigate to its local INASearch text.");
  assert(cfrDefinitionEntryHtml.includes('<a class="definition-official-link" href="https://www.ecfr.gov/') && cfrDefinitionEntryHtml.includes('title="Open on eCFR.gov"'), "The CFR definition citation has no adjacent official-source control.");
  assert(cfrDefinitionEntryHtml.includes("<dt>Defined at</dt>") && cfrDefinitionEntryHtml.includes("<dt>Applies in</dt>") && cfrDefinitionEntryHtml.includes("<dt>Source scope</dt>"), "A legal definition lost its scope metadata.");
  assert(cfrDefinitionEntryHtml.includes('<details class="definition-scope-details"><summary>Definition details</summary>') && !cfrDefinitionEntryHtml.includes('<details class="definition-scope-details" open'), "Legal-definition metadata is not collapsed by default.");
  assert(!cfrDefinitionEntryHtml.includes("View citation in INASearch") && !cfrDefinitionEntryHtml.includes("definition-actions"), "The redundant legal-definition action row remains.");
  const inaDefinitionEntry = full.corpus.definitions.entries.find(entry => entry.sourceFamily === "ina" && entry.path?.length);
  const inaDefinitionEntryHtml = renderDefinitionEntry(inaDefinitionEntry);
  assert(inaDefinitionEntryHtml.includes(`<button class="definition-citation" type="button" data-show-citation="${inaDefinitionEntry.citation}"`), "The INA definition citation does not navigate to its local INASearch text.");
  assert(inaDefinitionEntryHtml.includes('<a class="definition-official-link" href="https://uscode.house.gov/') && inaDefinitionEntryHtml.includes("#substructure-location_"), "The INA definition has no adjacent House.gov control targeting its statutory unit.");
  const childDefinitionEntry = definitionsFor("child").find(entry => entry.citation === "INA 101(b)(1)");
  const childDefinitionHtml = renderDefinitionEntry(childDefinitionEntry);
  assert(childDefinitionHtml.includes('data-definition-child="A"') && childDefinitionHtml.includes('data-definition-child="G"'), "The INA 101(b)(1) child definition still omits its seven defining subparagraphs.");
  const asylumOfficerEntry = definitionsFor("asylum officer").find(entry => entry.citation === "INA 235(b)(1)(E)");
  const asylumOfficerHtml = renderDefinitionEntry(asylumOfficerEntry);
  assert(asylumOfficerHtml.includes('data-definition-child="i"') && asylumOfficerHtml.includes('data-definition-child="ii"'), "The asylum-officer definition still omits its two defining clauses.");
  const aggravatedFelonyEntry = definitionsFor("aggravated felony").find(entry => entry.citation === "INA 101(a)(43)");
  const aggravatedFelonyHtml = renderDefinitionEntry(aggravatedFelonyEntry);
  assert(aggravatedFelonyHtml.indexOf("means—") < aggravatedFelonyHtml.indexOf('data-definition-child="A"') && aggravatedFelonyHtml.indexOf('data-definition-child="U"') < aggravatedFelonyHtml.indexOf("The term applies to an offense"), "A definition with trailing statutory text is rendered out of source order.");
  const previewDetail = { innerHTML: "" };
  const renderDefinitionPreview = extractedFunction(fallbackSource, "renderDefinitionPreview", "sameStatuteHierarchyItem", {
    els: { detail: previewDetail },
    definitionScope: entry => definitionScopesById.get(entry.scopeId),
    renderDefinitionLegalBody,
    escapeHtml: escapeStatutoryHtml,
    openButton: () => "",
    truncate: value => String(value)
  });
  renderDefinitionPreview(asylumOfficerEntry);
  assert(previewDetail.innerHTML.includes('data-definition-child="i"') && previewDetail.innerHTML.includes('data-definition-child="ii"'), "The search-result definition preview still truncates structural definitions at the chapeau.");
  let openedDefinitionReference = "";
  const focusedDefinitionReferences = [];
  const scrolledDefinitionReferences = [];
  const definitionReferenceGroup = {
    focus: options => focusedDefinitionReferences.push(options),
    scrollIntoView: options => scrolledDefinitionReferences.push(options)
  };
  const openDefinitionReference = extractedFunction(fallbackSource, "openDefinitionReference", "buildIndex", {
    openDefinitions: query => { openedDefinitionReference = query; },
    requestAnimationFrame: callback => callback(),
    $: () => definitionReferenceGroup,
    els: { definitionList: {} }
  });
  openDefinitionReference("Special Situations");
  assert.strictEqual(openedDefinitionReference, "Special Situations", "A glossary cross-reference did not filter to its target definition.");
  assert.deepStrictEqual(plain(focusedDefinitionReferences.pop()), { preventScroll: true }, "A glossary cross-reference did not focus its target definition.");
  assert.deepStrictEqual(plain(scrolledDefinitionReferences.pop()), { behavior: "smooth", block: "start" }, "A glossary cross-reference did not scroll to its target definition.");
  const statuteSearchTarget = extractedFunction(fallbackSource, "statuteSearchTarget", "renderStatute", { normalize: searchNormalize, searchTextMatch });
  const searchSection = {
    section: "9999",
    heading: "Search Heading",
    preamble: "A short preamble notice.",
    body: [{ label: "a", heading: "General rule", text: "Alpha applies.", children: [{ label: "1", heading: "Focused relief", text: "A special-situations provision allows expedited treatment.", children: [] }] }]
  };
  const exactStatuteSearchTarget = plain(statuteSearchTarget(searchSection, "special situation"));
  assert.strictEqual(exactStatuteSearchTarget.kind, "node-text", "A U.S. Code phrase match did not resolve to its paragraph text.");
  assert.deepStrictEqual(exactStatuteSearchTarget.path, ["a", "1"], "A nested U.S. Code phrase match resolved to the wrong statutory path.");
  assert.strictEqual(searchNormalize(searchSection.body[0].children[0].text.slice(exactStatuteSearchTarget.match.start, exactStatuteSearchTarget.match.end)), "special situation", "Normalized U.S. Code matching lost the original text offsets.");
  assert.strictEqual(statuteSearchTarget(searchSection, "preamble notice").kind, "preamble", "A U.S. Code preamble match did not resolve to the preamble.");
  assert.strictEqual(statuteSearchTarget(searchSection, "search heading").kind, "heading", "A U.S. Code heading match did not resolve to the section heading.");
  assert.deepStrictEqual(plain(statuteSearchTarget(searchSection, "alpha expedited").path), ["a"], "A distributed term match did not choose the first best statutory location.");
  assert.strictEqual(statuteSearchTarget(searchSection, "absent phrase"), null, "An unmatched query produced a U.S. Code scroll target.");
  const renderSearchHighlightedText = extractedFunction(fallbackSource, "renderSearchHighlightedText", "houseFootnoteReferenceHtml", { escapeHtml: escapeStatutoryHtml, Math, Number, String });
  assert.strictEqual(renderSearchHighlightedText("A <special> situation", { start: 3, end: 11 }), 'A &lt;<mark class="statute-search-match" data-statute-search-match>special&gt;</mark> situation', "The U.S. Code search highlight did not preserve safe text offsets.");
  const legalDefinitionEntriesForAnnotation = full.corpus.definitions.entries.filter(entry => entry.sourceCategory === "law" && ["ina", "cfr"].includes(entry.sourceFamily));
  const legalDefinitionEntriesByIdForAnnotation = new Map(legalDefinitionEntriesForAnnotation.map(entry => [entry.id, entry]));
  const legalDefinitionScopesByIdForAnnotation = new Map(full.corpus.definitions.scopes.map(scope => [scope.id, scope]));
  const definitionTargetApplies = extractedFunction(fallbackSource, "definitionTargetApplies", "legalDefinitionApplies", { normCitationPart: statutoryNormPart, String });
  const legalDefinitionApplies = extractedFunction(fallbackSource, "legalDefinitionApplies", "definitionContextKey", { legalDefinitionScopesById: legalDefinitionScopesByIdForAnnotation, definitionTargetApplies });
  const definitionContextKey = extractedFunction(fallbackSource, "definitionContextKey", "definitionApplicabilitySpecificity", {});
  const definitionApplicabilitySpecificity = extractedFunction(fallbackSource, "definitionApplicabilitySpecificity", "supplementalDefinitionEntry", { legalDefinitionScopesById: legalDefinitionScopesByIdForAnnotation, Math });
  const supplementalDefinitionEntry = extractedFunction(fallbackSource, "supplementalDefinitionEntry", "preferredApplicableDefinitionEntries", { Math, String });
  const preferredApplicableDefinitionEntries = extractedFunction(fallbackSource, "preferredApplicableDefinitionEntries", "applicableDefinitionAliases", { definitionApplicabilitySpecificity, supplementalDefinitionEntry, Math });
  const applicableDefinitionAliases = extractedFunction(fallbackSource, "applicableDefinitionAliases", "scopedDefinitionMatches", {
    applicableDefinitionAliasesCache: new Map(), legalDefinitionEntries: legalDefinitionEntriesForAnnotation,
    legalDefinitionApplies, definitionContextKey, preferredApplicableDefinitionEntries, Map, String
  });
  const scopedDefinitionMatches = extractedFunction(fallbackSource, "scopedDefinitionMatches", "renderScopedDefinitionAnnotatedText", { applicableDefinitionAliases, Math, Number, String, Map, Boolean });
  const renderScopedDefinitionAnnotatedText = extractedFunction(fallbackSource, "renderScopedDefinitionAnnotatedText", "definitionFiltersForKind", {
    scopedDefinitionMatches, renderSearchHighlightedText, escapeHtml: escapeStatutoryHtml,
    legalDefinitionEntriesById: legalDefinitionEntriesByIdForAnnotation,
    legalDefinitionScopesById: legalDefinitionScopesByIdForAnnotation,
    definedTermHighlightingEnabled: () => true,
    Math, Number, String, JSON
  });
  const childFamilyDefinition = legalDefinitionEntriesForAnnotation.find(entry => entry.term.toLowerCase() === "child" && entry.citation === "INA 101(b)(1)");
  const childNationalityDefinition = legalDefinitionEntriesForAnnotation.find(entry => entry.term.toLowerCase() === "child" && entry.citation === "INA 101(c)(1)");
  const familyContext = { kind: "ina", inaSection: "203", subchapter: "II", path: ["a"] };
  const nationalityContext = { kind: "ina", inaSection: "301", subchapter: "III", path: ["a"] };
  assert(legalDefinitionApplies(childFamilyDefinition, familyContext) && !legalDefinitionApplies(childNationalityDefinition, familyContext), "The nationality definition of child leaked into INA subchapter II.");
  assert(!legalDefinitionApplies(childFamilyDefinition, nationalityContext) && legalDefinitionApplies(childNationalityDefinition, nationalityContext), "The family-law definition of child leaked into INA subchapter III.");
  const nationalityChildMatches = plain(scopedDefinitionMatches("A child, but not childhood, is referenced.", nationalityContext));
  assert.deepStrictEqual(nationalityChildMatches, [{ start: 2, end: 7, entryIds: [childNationalityDefinition.id] }], "Scoped term matching confused the two child definitions or matched inside a larger word.");
  const parentDefinitions = legalDefinitionEntriesForAnnotation.filter(entry => entry.term.toLowerCase() === "parent" && entry.citation === "INA 101(b)(2)");
  const specialParentContext = { kind: "ina", inaSection: "101", subchapter: "I", path: ["b", "1", "F"] };
  const ordinaryParentContext = { kind: "ina", inaSection: "101", subchapter: "I", path: ["b", "1", "A"] };
  assert.strictEqual(parentDefinitions.filter(entry => legalDefinitionApplies(entry, specialParentContext)).length, 2, "The supplemental parent definition is not paired with the general definition in its exact special scope.");
  assert.strictEqual(parentDefinitions.filter(entry => legalDefinitionApplies(entry, ordinaryParentContext)).length, 1, "The supplemental parent definition leaked beyond INA 101(b)(1)(F) and (G)(i).");
  assert.strictEqual(scopedDefinitionMatches("the parent", specialParentContext)[0].entryIds.length, 2, "The scoped preview dropped the general parent definition needed by its narrow supplement.");
  const ina215Context = { kind: "ina", inaSection: "215", subchapter: "II", path: ["c"] };
  const scopedPersonEntries = scopedDefinitionMatches("A person may apply.", ina215Context)[0].entryIds.map(id => legalDefinitionEntriesByIdForAnnotation.get(id));
  assert.deepStrictEqual(plain(scopedPersonEntries.map(entry => entry.citation)), ["INA 215(c)"], "A section-specific replacement definition of person was confused with the broader subchapter definition.");
  const scopedUnitedStatesEntries = scopedDefinitionMatches("the United States", ina215Context)[0].entryIds.map(id => legalDefinitionEntriesByIdForAnnotation.get(id));
  assert.deepStrictEqual(plain(scopedUnitedStatesEntries.map(entry => entry.citation)), ["INA 101(a)(38)", "INA 215(c)"], "A section-specific supplemental definition did not retain the underlying general definition it modifies.");
  assert(legalDefinitionApplies(substantialDefinition, { kind: "ina", inaSection: "101", subchapter: "I", path: ["a", "15", "E", "ii"] }), "The treaty-trader substantial definition is absent inside its target path.");
  assert(!legalDefinitionApplies(substantialDefinition, { kind: "ina", inaSection: "101", subchapter: "I", path: ["a", "15", "H"] }), "The treaty-trader substantial definition leaked into another classification.");
  const cfrActDefinition = legalDefinitionEntriesForAnnotation.find(entry => entry.sourceFamily === "cfr" && entry.term === "Act or INA");
  assert(legalDefinitionApplies(cfrActDefinition, { kind: "cfr", title: "8", chapter: "I", path: [] }), "An 8 CFR 1.2 definition is absent within 8 CFR Chapter I.");
  assert(!legalDefinitionApplies(cfrActDefinition, { kind: "cfr", title: "8", chapter: "V", path: [] }) && !legalDefinitionApplies(cfrActDefinition, { kind: "cfr", title: "22", chapter: "I", path: [] }), "An 8 CFR 1.2 definition leaked into another CFR chapter or title.");
  const scopedChildHtml = renderScopedDefinitionAnnotatedText("That child qualifies.", null, 0, undefined, nationalityContext);
  assert(scopedChildHtml.includes('class="scoped-defined-term"') && scopedChildHtml.includes(childNationalityDefinition.id) && !scopedChildHtml.includes(childFamilyDefinition.id), "Rendered definition annotation does not carry only the applicable definition record.");
  const renderDefinedTermsDisabled = extractedFunction(fallbackSource, "renderScopedDefinitionAnnotatedText", "definitionFiltersForKind", {
    scopedDefinitionMatches, renderSearchHighlightedText, escapeHtml: escapeStatutoryHtml,
    definedTermHighlightingEnabled: () => false,
    Math, Number, String, JSON
  });
  assert(!renderDefinedTermsDisabled("That child qualifies.", null, 0, undefined, nationalityContext).includes('class="scoped-defined-term"'), "Defined terms were highlighted while the experimental setting was disabled.");
  assert(!/href=|data-show-citation|data-definition-reference/.test(scopedChildHtml), "Clicking an annotated term can navigate directly instead of only opening its scoped preview.");
  assert(fallbackSource.includes('openDefinitionReference(query)') && fallbackSource.includes('id="scopedDefinitionPopoverJump"'), "The hover pane lacks its explicit Definitions-page jump control.");
  const houseFootnoteReferenceHtml = extractedFunction(fallbackSource, "houseFootnoteReferenceHtml", "linkifyStatutoryText", { escapeHtml: escapeStatutoryHtml, String });
  const legalReferenceCitation = extractedFunction(fallbackSource, "legalReferenceCitation", "statutoryReferenceCrosswalk", { canonicalPath: statutoryCanonicalPath, String });
  const citationPreferenceProfile = { preferences: { statutoryLinkCitationSystem: "usc" } };
  const citationPreferenceUscCrosswalk = new Map([
    ["1101", { inaSection: "101", uscSection: "1101", hasEquivalent: true, isNote: false }],
    ["1153", { inaSection: "203", uscSection: "1153", hasEquivalent: true, isNote: false }]
  ]);
  const citationPreferenceInaCrosswalk = new Map([...citationPreferenceUscCrosswalk.values()].map(row => [row.inaSection, row]));
  const statutoryReferenceCrosswalk = extractedFunction(fallbackSource, "statutoryReferenceCrosswalk", "statutoryLinkInaCitation", { inaMap: citationPreferenceInaCrosswalk, uscToIna: citationPreferenceUscCrosswalk, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, String });
  const statutoryLinkInaCitation = extractedFunction(fallbackSource, "statutoryLinkInaCitation", "legalReferenceHtml", { profile: citationPreferenceProfile, statutoryReferenceCrosswalk, canonicalPath: statutoryCanonicalPath });
  const legalReferenceHtml = extractedFunction(fallbackSource, "legalReferenceHtml", "legalReferenceContextForElement", { escapeHtml: escapeStatutoryHtml, legalReferenceCitation, statutoryReferenceCrosswalk, statutoryLinkInaCitation, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, JSON, String });
  const crosswalkedReference = { family: "usc", targetKind: "usc", targetTitle: "8", targetSection: "1101", targetPath: ["a", "15", "S"], resolution: "local", officialUrl: "https://uscode.house.gov/" };
  assert.deepStrictEqual(plain(statutoryReferenceCrosswalk(crosswalkedReference)), { ina: "INA 101(a)(15)(S)", usc: "8 U.S.C. 1101(a)(15)(S)" }, "A statutory link did not retain both sides of its citation crosswalk.");
  assert(legalReferenceHtml(crosswalkedReference, "section 1101(a)(15)(S) of this title").endsWith(">section 1101(a)(15)(S) of this title</a>"), "The default U.S. Code display preference rewrote source citation wording.");
  citationPreferenceProfile.preferences.statutoryLinkCitationSystem = "ina";
  const crosswalkedInaHtml = legalReferenceHtml(crosswalkedReference, "section 1101(a)(15)(S) of this title");
  assert(crosswalkedInaHtml.endsWith(">INA 101(a)(15)(S)</a>"), "The INA display preference did not replace a crosswalked link with its full INA citation.");
  assert(crosswalkedInaHtml.includes("citation-display-ina"), "A converted INA-format statutory link does not carry its amber warning style.");
  assert(crosswalkedInaHtml.includes('data-reference-ina-citation="INA 101(a)(15)(S)"') && crosswalkedInaHtml.includes('data-reference-usc-citation="8 U.S.C. 1101(a)(15)(S)"'), "A converted link does not carry both exact citations into its hover preview.");
  assert(crosswalkedInaHtml.includes('data-show-citation="INA 101(a)(15)(S)"'), "A crosswalked INA link still opens its target in U.S. Code display mode.");
  assert(crosswalkedInaHtml.includes('href="#usc-1101-a-15-s"') && crosswalkedInaHtml.includes('data-reference-section="1101"'), "Changing a link to INA display mode changed its underlying local target.");
  assert.strictEqual(statutoryLinkInaCitation({ family: "usc", targetTitle: "18", targetSection: "1001", targetPath: [] }), "", "The INA display preference rewrote a cross-title U.S. Code citation without an INA crosswalk.");
  assert.strictEqual(statutoryLinkInaCitation({ family: "usc", targetTitle: "8", targetSection: "1153", targetPath: [], resolution: "unresolved" }), "", "An unresolved contextual reference was made to look like a precise INA citation.");
  assert.strictEqual(statutoryLinkInaCitation({ family: "ina", inaSection: "203", targetTitle: "8", targetSection: "1153", targetPath: ["b", "2"] }), "INA 203(b)(2)", "An explicit INA-family reference did not receive its full normalized INA label.");
  citationPreferenceProfile.preferences.statutoryLinkCitationSystem = "usc";
  const linkifyStatutoryText = extractedFunction(fallbackSource, "linkifyStatutoryText", "indexedStatutePathExists", { escapeHtml: escapeStatutoryHtml, renderSearchHighlightedText, scopedDefinitionMatches: () => [], renderScopedDefinitionAnnotatedText: (input, match, start, end) => renderSearchHighlightedText(input, match, start, end), definedTermHighlightingEnabled: () => false, houseFootnoteReferenceHtml, legalReferenceHtml, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, Math, Number, String });
  const scopedLinkifyStatutoryText = extractedFunction(fallbackSource, "linkifyStatutoryText", "indexedStatutePathExists", { escapeHtml: escapeStatutoryHtml, renderSearchHighlightedText, scopedDefinitionMatches, renderScopedDefinitionAnnotatedText, definedTermHighlightingEnabled: () => true, houseFootnoteReferenceHtml, legalReferenceHtml, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, Math, Number, String });
  const specialImmigrantReferenceHtml = linkifyStatutoryText(specialImmigrantBlock.x, specialImmigrantActReferences);
  assert.strictEqual((specialImmigrantReferenceHtml.match(/data-legal-reference/g) || []).length, 2, "8 CFR 245.1(b)(4)(ii) does not render two independent statutory reference triggers.");
  assert(specialImmigrantReferenceHtml.includes('href="#usc-1101-a-27-h"') && specialImmigrantReferenceHtml.includes('href="#usc-1101-a-27-j"'), "The two special-immigrant alternatives do not navigate to their distinct local statutory units.");
  const actDefinitionContext = { kind: "cfr", title: "8", chapter: "I", path: [] };
  const scopedActHtml = scopedLinkifyStatutoryText("the Act applies", [{ start: 0, end: 7, text: "the Act", family: "ina", resolution: "official-source-only" }], 0, undefined, null, [], actDefinitionContext);
  assert(scopedActHtml.includes('class="scoped-defined-term"') && !scopedActHtml.includes("data-legal-reference") && !scopedActHtml.includes("href="), "An applicable defined term retained an overlapping navigation link on the term itself.");
  const legalUnitTriggerHtml = extractedFunction(fallbackSource, "legalUnitTriggerHtml", "superscriptNumber", { escapeHtml: escapeStatutoryHtml, JSON, String });
  const superscriptNumber = extractedFunction(fallbackSource, "superscriptNumber", "textWithHouseFootnoteMarkers", { String });
  const textWithHouseFootnoteMarkers = extractedFunction(fallbackSource, "textWithHouseFootnoteMarkers", "statuteFootnoteAppendix", { superscriptNumber, String });
  const statuteFootnoteAppendix = extractedFunction(fallbackSource, "statuteFootnoteAppendix", "statuteNodePlainText", { HOUSE_FOOTNOTE_STATEMENT: "House editorial footnotes are publisher-supplied editorial content and are not operative statutory text." });
  const statuteNodePlainText = extractedFunction(fallbackSource, "statuteNodePlainText", "statuteUnitText", { textWithHouseFootnoteMarkers, Set });
  const statuteUnitText = extractedFunction(fallbackSource, "statuteUnitText", "cfrBlockPlainText", { statuteNodeAtPath: (section, path) => path.reduce((nodes, token, index) => (index ? nodes?.children : section.body)?.find(node => String(node.label) === String(token)), null), statuteNodePlainText, statuteFootnoteAppendix, textWithHouseFootnoteMarkers, Set });
  const legalReferenceContextForElement = extractedFunction(fallbackSource, "legalReferenceContextForElement", "legalReferencePopoverPlacement", { corpus: hydratedSource, statuteUnitText, cfrSectionIdMap, cfrUnitText, JSON, String });
  const legalReferencePopoverPlacement = extractedFunction(fallbackSource, "legalReferencePopoverPlacement", "positionLegalReferencePopover", { Math, Number });
  const referenceTriggerRect = { left: 425, right: 585, top: 250, bottom: 270 };
  const referencePopoverRect = { width: 590, height: 410 };
  const sidePlacement = plain(legalReferencePopoverPlacement(referenceTriggerRect, referencePopoverRect, 1371, 664));
  assert.strictEqual(sidePlacement.side, "right", "A tall legal-reference preview was not moved beside its trigger.");
  assert(sidePlacement.left >= referenceTriggerRect.right + 10, "The legal-reference preview overlaps the triggering citation.");
  assert(sidePlacement.left + referencePopoverRect.width <= 1361 && sidePlacement.top >= 10 && sidePlacement.top + referencePopoverRect.height <= 654, "The side-positioned legal-reference preview escaped the viewport.");
  const belowPlacement = plain(legalReferencePopoverPlacement({ left: 200, right: 320, top: 100, bottom: 120 }, { width: 420, height: 220 }, 1200, 800));
  assert.strictEqual(belowPlacement.side, "below", "A legal-reference preview with clear space below did not use it.");
  assert(belowPlacement.top >= 130, "A below-positioned legal-reference preview covers its triggering citation.");
  const leftPlacement = plain(legalReferencePopoverPlacement({ left: 1050, right: 1220, top: 260, bottom: 280 }, referencePopoverRect, 1371, 664));
  assert.strictEqual(leftPlacement.side, "left", "A right-edge legal-reference preview was not moved to the open left side.");
  assert(leftPlacement.left + referencePopoverRect.width <= 1040, "A left-positioned legal-reference preview covers its triggering citation.");
  const constrainedPlacement = plain(legalReferencePopoverPlacement({ left: 120, right: 280, top: 240, bottom: 260 }, { width: 380, height: 410 }, 400, 500));
  assert(constrainedPlacement.maxHeight > 0 && constrainedPlacement.top >= 270, "A constrained legal-reference preview was not bounded to a non-overlapping vertical region.");
  assert(/<a class="legal-reference-popover-citation" id="legalReferencePopoverCitation"[^>]*target="_blank"/.test(fallbackSource), "The preview citation is not the official-source link.");
  const previewMarkup = fallbackSource.slice(fallbackSource.indexOf('<section class="legal-reference-popover" id="legalReferencePopover"'), fallbackSource.indexOf('<section class="legal-reference-popover scoped-definition-popover"'));
  assert(previewMarkup.includes('id="legalReferencePopoverCrosswalk"') && previewMarkup.indexOf('id="legalReferencePopoverInaCitation"') < previewMarkup.indexOf('class="citation-equivalent-arrow"') && previewMarkup.indexOf('class="citation-equivalent-arrow"') < previewMarkup.indexOf('id="legalReferencePopoverUscCitation"'), "The statutory preview does not show INA and U.S.C. citations side by side in the established order.");
  assert((previewMarkup.match(/data-copy-legal-reference-citation/g) || []).length === 2 && fallbackSource.includes('event.target.closest("[data-copy-legal-reference-citation]")'), "The statutory preview does not provide one working copy control per citation system.");
  assert(fallbackSource.includes('.statute-citation-link.citation-display-ina { color: var(--warning);'), "Converted INA-format statutory links are not visibly distinguished in amber.");
  assert(!fallbackSource.includes("Open verified official source") && !fallbackSource.includes("legalReferencePopoverActions") && !fallbackSource.includes("data-open-legal-reference"), "The redundant preview footer button remains in the application.");
  const hydrated1184Reference = runtimeHouseReferenceFixture.source.references[0];
  const reference1184Preview = legalReferenceContextForElement({
    dataset: {
      referenceFamily: hydrated1184Reference.family,
      referenceResolution: hydrated1184Reference.resolution,
      referenceTitle: hydrated1184Reference.targetTitle,
      referenceSection: hydrated1184Reference.targetSection,
      referencePath: JSON.stringify(hydrated1184Reference.targetPath),
      referenceUrl: hydrated1184Reference.officialUrl,
      referenceCitation: "8 U.S.C. 1184(i)(1)",
      referenceInaCitation: "INA 214(i)(1)",
      referenceUscCitation: "8 U.S.C. 1184(i)(1)"
    },
    textContent: hydrated1184Reference.text
  });
  assert(reference1184Preview.text.startsWith("(1) Except as provided in paragraph (3)"), "A locally resolved House link still produces an empty offline preview.");
  assert.deepStrictEqual(plain({ ina: reference1184Preview.inaCitation, usc: reference1184Preview.uscCitation }), { ina: "INA 214(i)(1)", usc: "8 U.S.C. 1184(i)(1)" }, "The hover-preview context dropped one side of its statutory crosswalk.");
  const specialImmigrantPreviews = specialImmigrantActReferences.map(reference => legalReferenceContextForElement({
    dataset: {
      referenceFamily: reference.family,
      referenceResolution: reference.resolution,
      referenceTitle: reference.targetTitle,
      referenceSection: reference.targetSection,
      referencePath: JSON.stringify(reference.targetPath),
      referenceUrl: reference.officialUrl,
      referenceCitation: `INA ${reference.inaSection}${reference.targetPath.map(token => `(${token})`).join("")}`
    },
    textContent: reference.text
  }));
  assert(specialImmigrantPreviews.every(preview => preview.text.length > 40), "A CFR-to-INA citation opens an empty hover preview.");
  assert.notStrictEqual(specialImmigrantPreviews[0].text, specialImmigrantPreviews[1].text, "The two alternatives in 8 CFR 245.1(b)(4)(ii) were collapsed into the same statutory hover target.");
  const testComponentTokens = value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  const testUscToIna = new Map([["1101", { inaSection: "101", uscSection: "1101" }]]);
  const statutoryRunInMarkers = extractedFunction(fallbackSource, "statutoryRunInMarkers", "flattenNode", { Number, Set, String });
  const indexedStatutePathExists = extractedFunction(fallbackSource, "indexedStatutePathExists", "resolvedRunInStatutePath", { corpus: hydratedSource, uscToIna: testUscToIna, normCitationPart: statutoryNormPart, compactStatutePathIndex: compactPathApi.compactStatutePathIndex });
  const resolvedRunInStatutePath = extractedFunction(fallbackSource, "resolvedRunInStatutePath", "formatStatutoryRunInText", { indexedStatutePathExists });
  const formatStatutoryRunInText = extractedFunction(fallbackSource, "formatStatutoryRunInText", "renderHouseEditorialFootnotes", { statutoryRunInMarkers, escapeHtml: escapeStatutoryHtml, linkifyStatutoryText, legalUnitTriggerHtml, componentTokens: testComponentTokens, canonicalPath: statutoryCanonicalPath, resolvedRunInStatutePath, normCitationPart: statutoryNormPart, JSON, Set, Number, String });
  const statutoryRunInSegments = extractedFunction(fallbackSource, "statutoryRunInSegments", "scrollToRenderedStatuteTarget", { statutoryRunInMarkers, componentTokens: testComponentTokens, resolvedRunInStatutePath, String });
  const scopeStatuteNodeAtPath = (section, pathParts) => {
    let nodes = section?.body || [];
    let node = null;
    for (const token of pathParts || []) {
      node = nodes.find(item => statutoryNormPart(item.label) === statutoryNormPart(token));
      if (!node) return null;
      nodes = node.children || [];
    }
    return node;
  };
  const nearestStructuralPathForScope = (section, pathParts) => {
    const result = [];
    for (const token of pathParts || []) {
      const node = scopeStatuteNodeAtPath(section, [...result, token]);
      if (!node) break;
      result.push(node.label);
    }
    return result;
  };
  const statuteScopeProjection = extractedFunction(fallbackSource, "statuteScopeProjection", "scopedStatuteRecordText", {
    nearestStructuralPath: nearestStructuralPathForScope,
    statuteNodeAtPath: scopeStatuteNodeAtPath,
    statutoryRunInSegments,
    normCitationPart: statutoryNormPart
  });
  const ina245c2Projection = statuteScopeProjection(section1255ForCompactPaths, ["c", "2"]);
  const ina245c2SearchText = ina245c2Projection.map(field => field.text).join(" ");
  assert.strictEqual(ina245c2Projection.length, 1, "A run-in item scope expanded to its entire structural parent.");
  assert(/unauthorized employment/i.test(ina245c2SearchText) && !/admitted in transit without visa/i.test(ina245c2SearchText), "INA 245(c)(2) scope includes text from neighboring run-in item (3), or omits its own text.");
  const scopedStatuteSearchTarget = extractedFunction(fallbackSource, "statuteSearchTarget", "renderStatute", { normalize: searchNormalize, searchTextMatch, statuteScopeProjection });
  const scopedIna245c2Target = scopedStatuteSearchTarget(section1255ForCompactPaths, "unauthorized employment", ["c", "2"]);
  assert.deepStrictEqual(plain(scopedIna245c2Target.path), ["c", "2"], "A run-in scoped text match did not target the exact cited item.");
  assert.strictEqual(scopedStatuteSearchTarget(section1255ForCompactPaths, "admitted in transit without visa", ["c", "2"]), null, "A run-in scoped search matched text from the next numbered item.");
  const ina245cNode = scopeStatuteNodeAtPath(section1255ForCompactPaths, ["c"]);
  assert.strictEqual(searchNormalize(ina245cNode.text.slice(scopedIna245c2Target.match.start, scopedIna245c2Target.match.end)), "unauthorized employment", "A run-in scoped match lost its original source offsets for highlighting.");
  const scopedScoreState = { searchScopeActive: true };
  const scopedIna245c2Record = { kind: "usc", title: section1255ForCompactPaths.heading, cite: "8 U.S.C. 1255", item: section1255ForCompactPaths, text: searchNormalize([section1255ForCompactPaths.heading, ina245cNode.text].join(" ")) };
  const scopedScoreRecord = extractedFunction(fallbackSource, "scoreRecord", "searchResultCounts", {
    state: scopedScoreState,
    normalize: searchNormalize,
    filterMatches: () => true,
    compactLookup: testCompactLookup,
    compactFormLookup: testCompactLookup,
    searchScoreContext,
    scopedStatuteRecordText: () => searchNormalize(ina245c2SearchText),
    scopedCfrSearchFields: record => record.cfrFields,
    searchScopePathForRecord: () => ["c", "2"],
    Math
  });
  assert.strictEqual(scopedScoreRecord(scopedIna245c2Record, "person admitted for permanent residence"), 0, "A scoped paragraph search matched words found only in the enclosing section title.");
  scopedScoreState.searchScopeMode = "cites";
  assert.strictEqual(scopedScoreRecord(scopedIna245c2Record, ""), 1, "A cites: search with no additional words did not retain its matching statute source.");
  scopedScoreState.searchScopeMode = "in";
  const scopedCfrSearchFields = extractedFunction(fallbackSource, "scopedCfrSearchFields", "searchRouteGroups", {
    canonicalPath: statutoryCanonicalPath,
    searchScopePathForRecord: (record, scope) => scope.pathsBySection.get(record.item.id) || []
  });
  const scopedCfrSection = full.corpus.cfr.sections.find(section => section.id === "8:214.2");
  const allScopedCfrFields = cfrSearchFields(scopedCfrSection, "8 CFR 214.2");
  const h13ScopedCfrFields = scopedCfrSearchFields({ kind: "cfr", item: scopedCfrSection, cfrFields: allScopedCfrFields }, cfrParagraphScope);
  assert(h13ScopedCfrFields.length > 0 && h13ScopedCfrFields.length < allScopedCfrFields.length, "A CFR paragraph scope did not narrow the preprojected section fields.");
  assert(h13ScopedCfrFields.every(field => field.kind === "block" && field.unitPaths.some(value => value === "(h)(13)" || value.startsWith("(h)(13)(") || "(h)(13)".startsWith(value + "("))), "A CFR paragraph scope retained an unrelated searchable block.");
  const scopedCfrExactTarget = cfrSearchTarget(scopedCfrSection, h13ScopedCfrFields[0].text, "8 CFR 214.2", h13ScopedCfrFields);
  assert(scopedCfrExactTarget, "Text visibly contained in a CFR paragraph scope did not match.");
  const excludedCfrField = allScopedCfrFields.find(field => field.kind === "block" && field.text.length > 24 && !h13ScopedCfrFields.includes(field) && !cfrSearchTarget(scopedCfrSection, field.text, "8 CFR 214.2", h13ScopedCfrFields));
  assert(excludedCfrField, "The CFR paragraph scope could not demonstrate exclusion of a neighboring block.");
  const footnotedSection1154 = hydratedSource.title8.sections.find(section => section.section === "1154");
  const copiedSection1154 = statuteUnitText(footnotedSection1154, []);
  assert(copiedSection1154.includes("House editorial footnotes\nHouse editorial footnotes are publisher-supplied editorial content and are not operative statutory text."), "Statute copy text does not separate House editorial footnotes.");
  assert(/[¹²³⁴⁵⁶⁷⁸⁹]/.test(copiedSection1154), "Statute copy text does not retain superscript-style footnote markers.");
  for (const footnote of footnotedSection1154.houseEditorialFootnotes) assert(copiedSection1154.includes(`${footnote.number}. ${footnote.text}`), "A selected statute unit omitted its referenced House footnote text.");
  assert(fallbackSource.includes("body{margin:.65in;color:#111;background:#fff"), "Legal-unit printing does not force a light text-only page.");
  const statuteScrollCalls = [];
  const statuteReadingLine = extractedFunction(fallbackSource, "statuteReadingLine", "scrollStatuteAnchorToReadingLine", {
    $: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }),
    els: { statuteNavigator: { hidden: false, getBoundingClientRect: () => ({ bottom: 150 }) } },
    window: { innerHeight: 950 },
    Math
  });
  assert.strictEqual(statuteReadingLine(), 230, "The statute reading line does not exclude the sticky bars before taking the top tenth.");
  const scrollStatuteAnchorToReadingLine = extractedFunction(fallbackSource, "scrollStatuteAnchorToReadingLine", "currentStatutePathAtReadingLine", {
    statuteReadingLine: () => 200,
    window: { scrollBy: options => statuteScrollCalls.push(options) }
  });
  scrollStatuteAnchorToReadingLine({ getBoundingClientRect: () => ({ top: 500 }) });
  assert.deepStrictEqual(plain(statuteScrollCalls.pop()), { top: 300, behavior: "smooth" }, "Statute navigation did not align an anchor to the tenth-view reading line.");
  let renderedStatuteTarget = null;
  let renderedSearchMatch = null;
  const sectionAnchor = { id: "section-anchor" };
  const targetAnchor = { id: "target-anchor" };
  const alignedAnchors = [];
  const scrollToRenderedStatuteTarget = extractedFunction(fallbackSource, "scrollToRenderedStatuteTarget", "renderStatutoryNode", {
    $: (selector, root) => selector === "[data-statute-search-match]" ? renderedSearchMatch : selector === ".statutory-node.target, .statutory-node.search-target" ? renderedStatuteTarget : selector === ".statutory-line" ? targetAnchor : selector === "[data-statute-start]" ? sectionAnchor : null,
    els: { detail: {} },
    scrollStatuteAnchorToReadingLine: anchor => alignedAnchors.push(anchor)
  });
  scrollToRenderedStatuteTarget();
  assert.strictEqual(alignedAnchors.pop(), sectionAnchor, "A section-level citation did not align the top of the newly rendered statute.");
  renderedStatuteTarget = {};
  scrollToRenderedStatuteTarget();
  assert.strictEqual(alignedAnchors.pop(), targetAnchor, "A nested citation did not align its statutory line to the reading line.");
  renderedSearchMatch = { id: "search-match-anchor" };
  scrollToRenderedStatuteTarget();
  assert.strictEqual(alignedAnchors.pop(), renderedSearchMatch, "A U.S. Code text search did not align the matching term to the reading line.");
  const visibleStatuteLines = [
    { top: 100, path: ["a"] },
    { top: 200, path: ["a", "15"] },
    { top: 260, path: ["a", "16"] }
  ].map(item => ({ getBoundingClientRect: () => ({ top: item.top }), parentElement: { dataset: { statutePath: JSON.stringify(item.path) } } }));
  const currentStatutePathAtReadingLine = extractedFunction(fallbackSource, "currentStatutePathAtReadingLine", "currentCfrPathAtReadingLine", {
    els: { statuteNavigator: { hidden: false }, detail: {} },
    state: { statuteNavigationSectionId: "usc-1101" },
    statuteReadingLine: () => 230,
    $$: () => visibleStatuteLines,
    JSON
  });
  assert.deepStrictEqual(plain(currentStatutePathAtReadingLine()), ["a", "15"], "The live hierarchy does not follow the statutory line touching the tenth-view reading line.");

  const scrollSection1101 = fullSource.title8.sections.find(section => section.section === "1101");
  const scrollHistoryState = {
    view: "search",
    statuteNavigationFrame: 17,
    statuteNavigationKind: "usc",
    statuteNavigationSectionId: scrollSection1101.id,
    statuteNavigationPath: ["a"],
    statuteNavigationHistory: [
      { sectionId: scrollSection1101.id, path: ["a", "1"] },
      { sectionId: fullSource.title8.sections.find(section => section.section === "1157").id, path: ["e"] }
    ],
    statuteNavigationHistoryIndex: 1
  };
  const renderedScrollPaths = [];
  const updateStatuteNavigationFromScroll = extractedFunction(fallbackSource, "updateStatuteNavigationFromScroll", "scheduleStatuteNavigationUpdate", {
    state: scrollHistoryState,
    els: { statuteNavigator: { hidden: false } },
    corpus: fullSource,
    currentStatutePathAtReadingLine: () => ["a", "15"],
    normCitationPart: value => String(value || "").toLowerCase(),
    renderStatuteNavigation: (section, pathParts) => renderedScrollPaths.push({ sectionId: section.id, path: [...pathParts] }),
    JSON
  });
  const scrollHistoryBefore = JSON.stringify(scrollHistoryState.statuteNavigationHistory);
  updateStatuteNavigationFromScroll();
  assert.deepStrictEqual(plain(renderedScrollPaths), [{ sectionId: scrollSection1101.id, path: ["a", "15"] }], "Scrolling did not refresh the visible statute breadcrumb.");
  assert.strictEqual(JSON.stringify(scrollHistoryState.statuteNavigationHistory), scrollHistoryBefore, "A scroll-driven breadcrumb change was incorrectly added to statute history.");
  assert.strictEqual(scrollHistoryState.statuteNavigationHistoryIndex, 1, "A scroll-driven breadcrumb change moved the statute history cursor.");

  const statuteNormPart = value => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const statuteNormalize = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const statuteUscToIna = new Map();
  for (const row of fullSource.inaCrosswalk) if (row.uscSection && !statuteUscToIna.has(statuteNormPart(row.uscSection))) statuteUscToIna.set(statuteNormPart(row.uscSection), row);
  const collectTestStructuralPaths = (nodes, pathParts = [], output = []) => {
    for (const node of nodes || []) {
      const current = [...pathParts, String(node.label)];
      output.push(current);
      collectTestStructuralPaths(node.children, current, output);
    }
    return output;
  };
  const statuteNavigation = statuteNavigationFunctions(fallbackSource, {
    corpus: fullSource,
    uscToIna: statuteUscToIna,
    knownUscCitationPaths: compactKnownUscPaths,
    knownInaCitationPaths: compactKnownInaPaths,
    collectStructuralCitationPaths: collectTestStructuralPaths,
    normCitationPart: statuteNormPart,
    normalize: statuteNormalize,
    truncate: (value, length = 180) => String(value || "").length > length ? `${String(value).slice(0, length - 1)}…` : String(value || "")
  });
  const section1101 = fullSource.title8.sections.find(section => section.section === "1101");
  const ina101Segments = statuteNavigation.statuteNavigationSegments(section1101, ["a", "15"]);
  assert.deepStrictEqual(plain(ina101Segments.map(segment => segment.label)), ["Title", "Chapter", "Subchapter", "Section", "Subsection", "Paragraph"]);
  assert.strictEqual(ina101Segments.find(segment => segment.label === "Section").value, "1101 / INA 101");
  const subsectionChoices = ina101Segments.find(segment => segment.label === "Subsection").options.map(option => option.value);
  assert(subsectionChoices.includes("(a)") && subsectionChoices.includes("(b)") && subsectionChoices.includes("(c)"), "Subsection navigation does not list true siblings.");
  const paragraphChoices = ina101Segments.find(segment => segment.label === "Paragraph").options.map(option => option.value);
  assert(paragraphChoices.includes("(1)") && paragraphChoices.includes("(15)") && paragraphChoices.includes("(52)"), "INA 101(a) paragraph navigation does not list true siblings.");
  assert.strictEqual(ina101Segments.find(segment => segment.label === "Chapter").options.length, 16, "Title-level chapter navigation is incomplete.");
  assert(ina101Segments.find(segment => segment.label === "Section").options.length > 1, "Section navigation does not list sections sharing the current hierarchy.");
  const h1bSegments = statuteNavigation.statuteNavigationSegments(section1101, ["a", "15", "H", "i", "b"]);
  assert.deepStrictEqual(plain(h1bSegments.slice(-3).map(segment => segment.label)), ["Subparagraph", "Clause", "Subclause"], "Indexed H-1B run-in levels are missing from statute navigation.");
  assert(h1bSegments.at(-1).options.some(option => option.value === "(b)" && option.current), "The H-1B run-in subclause is not selected in its navigation menu.");
  const genericLevelSegments = statuteNavigation.statuteNavigationSegments(section1101, ["a", "15", "O", "ii", "III", "a"]);
  assert.strictEqual(genericLevelSegments.at(-1).label, "Level", "A generic House <level> was mislabeled from its hierarchy depth.");
  assert(!genericLevelSegments.some(segment => /Level\s+\d/.test(segment.label)), "The navigator still invents numbered level names.");
  const itemSegments = statuteNavigation.statuteNavigationSegments(section1101, ["a", "15", "T", "i", "III", "aa"]);
  assert.strictEqual(itemSegments.at(-1).label, "Item", "A House <item> did not retain its source unit name.");
  const section1153 = fullSource.title8.sections.find(section => section.section === "1153");
  const subitemSegments = statuteNavigation.statuteNavigationSegments(section1153, ["b", "5", "B", "ii", "IV", "aa", "AA"]);
  assert.strictEqual(subitemSegments.at(-1).label, "Subitem", "A House <subitem> did not retain its source unit name.");
  const ina203Segments = statuteNavigation.statuteNavigationSegments(section1153, ["b", "2", "A"]);
  assert(ina203Segments.some(segment => segment.label === "Part"), "Part navigation is missing where the U.S.C. hierarchy supplies it.");
  assert.deepStrictEqual(plain(statuteNavigation.statuteSiblingNodes(section1101, ["a", "15"]).map(node => node.label)), plain(statuteNavigation.statuteNodeAtPath(section1101, ["a"]).children.map(node => node.label)), "Nested dropdown choices are not derived from the shared parent node.");

  const section1104 = fullSource.title8.sections.find(section => section.section === "1104");
  const historyBackButton = {};
  const historyForwardButton = {};
  const statuteHistoryQueries = [];
  const statuteHistoryState = {
    citation: null,
    statuteNavigationLocation: { sectionId: section1101.id, path: ["a", "42"] },
    statuteNavigationHistory: [],
    statuteNavigationHistoryIndex: -1
  };
  const statuteHistory = statuteHistoryFunctions(fallbackSource, {
    state: statuteHistoryState,
    els: { statuteNavigator: { hidden: false } },
    $: selector => selector.includes("'back'") ? historyBackButton : selector.includes("'forward'") ? historyForwardButton : null,
    corpus: fullSource,
    uscToIna: statuteUscToIna,
    normCitationPart: statuteNormPart,
    canonicalPath: statutoryCanonicalPath,
    applySearchQuery: (query, focus) => statuteHistoryQueries.push({ query, focus }),
    parseCitation: () => ({ valid: true, record: { kind: "usc", item: section1104 }, path: ["b"] })
  });
  statuteHistory.navigateToStatuteLocation(section1153.id, ["b", "2", "A"]);
  assert.deepStrictEqual(plain(statuteHistoryState.statuteNavigationHistory), [
    { kind: "usc", sectionId: section1101.id, path: ["a", "42"] },
    { kind: "usc", sectionId: section1153.id, path: ["b", "2", "A"] }
  ], "A hierarchy-menu jump did not preserve its source and destination in statute history.");
  assert.strictEqual(statuteHistoryState.statuteNavigationHistoryIndex, 1, "A hierarchy-menu jump left the history cursor at the wrong location.");
  assert.strictEqual(historyBackButton.disabled, false, "Back remained disabled after an explicit statute jump.");
  assert.strictEqual(historyForwardButton.disabled, true, "Forward was enabled at the newest statute location.");
  assert.deepStrictEqual(statuteHistoryQueries.pop(), { query: "8 U.S.C. 1153(b)(2)(A)", focus: false }, "A hierarchy-menu jump did not open the exact statutory path.");

  statuteHistory.navigateStatuteHistory(-1);
  assert.strictEqual(statuteHistoryState.statuteNavigationHistoryIndex, 0, "Back did not move to the preceding statute-history entry.");
  assert.deepStrictEqual(statuteHistoryQueries.pop(), { query: "8 U.S.C. 1101(a)(42)", focus: false }, "Back did not restore the preceding statutory path.");
  assert.strictEqual(historyForwardButton.disabled, false, "Forward remained disabled after moving Back.");
  statuteHistory.navigateStatuteHistory(1);
  assert.deepStrictEqual(statuteHistoryQueries.pop(), { query: "8 U.S.C. 1153(b)(2)(A)", focus: false }, "Forward did not restore the later statutory path.");

  statuteHistory.navigateStatuteHistory(-1);
  statuteHistoryQueries.pop();
  statuteHistoryState.statuteNavigationLocation = { sectionId: section1101.id, path: ["a", "42"] };
  statuteHistory.navigateToStatuteCitation("8 U.S.C. 1104(b)");
  assert.deepStrictEqual(plain(statuteHistoryState.statuteNavigationHistory), [
    { kind: "usc", sectionId: section1101.id, path: ["a", "42"] },
    { kind: "usc", sectionId: section1104.id, path: ["b"] }
  ], "Following a statute citation after Back did not replace the obsolete Forward branch.");
  assert.deepStrictEqual(statuteHistoryQueries.pop(), { query: "8 U.S.C. 1104(b)", focus: false }, "A linked statute citation did not open its local destination.");
  assert.strictEqual(statuteHistory.sameStatuteHistoryLocation(
    { sectionId: section1104.id, path: ["B"] },
    { sectionId: section1104.id, path: ["b"] }
  ), true, "Equivalent statutory paths can create duplicate history entries.");

  const cfr4112 = full.corpus.cfr.sections.find(section => section.id === "22:41.12");
  const cfr4211 = full.corpus.cfr.sections.find(section => section.id === "22:42.11");
  const cfrHistoryQueries = [];
  const cfrHistoryState = {
    citation: null,
    statuteNavigationKind: "cfr",
    statuteNavigationLocation: { kind: "cfr", sectionId: cfr4112.id, path: [] },
    statuteNavigationHistory: [],
    statuteNavigationHistoryIndex: -1
  };
  const cfrHistory = statuteHistoryFunctions(fallbackSource, {
    state: cfrHistoryState,
    els: { statuteNavigator: { hidden: false } },
    $: () => null,
    corpus: full.corpus,
    uscToIna: statuteUscToIna,
    normCitationPart: statuteNormPart,
    canonicalPath: statutoryCanonicalPath,
    applySearchQuery: (query, focus) => cfrHistoryQueries.push({ query, focus }),
    parseCitation: query => ({ valid: true, path: [], record: { item: query.includes("42.11") ? cfr4211 : cfr4112 } })
  });
  cfrHistory.navigateToCfrLocation(cfr4211.id, []);
  assert.deepStrictEqual(plain(cfrHistoryState.statuteNavigationHistory), [
    { kind: "cfr", sectionId: cfr4112.id, path: [] },
    { kind: "cfr", sectionId: cfr4211.id, path: [] }
  ], "An explicit CFR navigation jump did not enter regulation history.");
  assert.deepStrictEqual(cfrHistoryQueries.pop(), { query: "22 CFR 42.11", focus: false });
  cfrHistory.navigateStatuteHistory(-1);
  assert.deepStrictEqual(cfrHistoryQueries.pop(), { query: "22 CFR 41.12", focus: false }, "CFR Back did not restore the earlier cached regulation.");

  const refugeeNode = statutoryNode(hydratedSource, "1101", ["a", "42"]);
  const formattedRefugeeDefinition = formatStatutoryRunInText(refugeeNode.text, "42", refugeeNode.references);
  assert.strictEqual((formattedRefugeeDefinition.match(/statutory-runin-line/g) || []).length, 2, "INA 101(a)(42) did not render two run-in subparagraphs.");
  assert(formattedRefugeeDefinition.includes('<strong class="inline-address">(A)</strong>'));
  assert(formattedRefugeeDefinition.includes('<strong class="inline-address">(B)</strong>'));
  assert(formattedRefugeeDefinition.includes("The term “refugee” means</span>"));
  assert(!formattedRefugeeDefinition.includes('<strong class="inline-address">(e)</strong>'), "Citation reference 1157(e) was mistaken for a run-in address.");
  assert(formattedRefugeeDefinition.includes('data-show-citation="8 U.S.C. 1157(e)"'), "The citation inside INA 101(a)(42) is not linked locally.");

  const administratorNode = statutoryNode(hydratedSource, "1101", ["a", "1"]);
  const formattedAdministrator = formatStatutoryRunInText(administratorNode.text, "1", administratorNode.references);
  assert(formattedAdministrator.includes('data-show-citation="8 U.S.C. 1104(b)"'), "8 U.S.C. 1101(a)(1) did not link its official section 1104(b) reference.");
  const aggravatedFelonyF = statutoryNode(hydratedSource, "1101", ["a", "43", "F"]);
  const formattedAggravatedFelonyF = formatStatutoryRunInText(aggravatedFelonyF.text, "F", aggravatedFelonyF.references);
  assert(formattedAggravatedFelonyF.includes('data-reference-resolution="official-source-only"'), "A cross-title citation was not retained as an official-source-only reference.");
  const section1155 = hydratedSource.title8.sections.find(section => section.section === "1155");
  assert(linkifyStatutoryText(section1155.preamble, section1155.preambleReferences).includes('data-show-citation="8 U.S.C. 1154"'), "A local citation in a section preamble was not linked.");
  const section1812ReferencesNote = hydratedSource.title8.sections.find(section => section.section === "1812").notes.find(note => note.topic === "referencesInText");
  const formatted1812ReferencesNote = linkifyStatutoryText(section1812ReferencesNote.text, section1812ReferencesNote.references);
  assert.strictEqual((formatted1812ReferencesNote.match(/class="statute-citation-link legal-reference-link/g) || []).length, 4, "Generated citations in a statutory note were not linked.");

  const formattedHDefinition = formatStatutoryRunInText(statutoryNode(hydratedSource, "1101", ["a", "15", "H"]).text, "H");
  assert(formattedHDefinition.includes('<strong class="inline-address">(i)(a)</strong>'));
  assert(formattedHDefinition.includes('<strong class="inline-address">(ii)(a)</strong>'));
  assert(/class="statutory-runin-line" style="--depth:2"[^>]*><strong class="inline-address">\(i\)\(a\)<\/strong>/.test(formattedHDefinition), "A two-level run-in unit does not receive two levels of standard indentation.");
  const actionableHDefinition = formatStatutoryRunInText(statutoryNode(hydratedSource, "1101", ["a", "15", "H"]).text, "H", [], null, { sectionId: section1101ForCompactPaths.id, currentPath: ["a", "15", "H"], parentPath: ["a", "15"], citationBase: "8 U.S.C. 1101", targetPath: ["a", "15", "H", "i", "b"] });
  assert(actionableHDefinition.includes('data-legal-unit-citation="8 U.S.C. 1101(a)(15)(H)(i)(a)"'), "A run-in statutory unit does not receive its own citation action trigger.");
  assert(actionableHDefinition.includes('data-legal-unit-citation="8 U.S.C. 1101(a)(15)(H)(i)(b)"'), "H-1B's run-in statutory unit does not receive its complete indexed citation path.");
  assert(actionableHDefinition.includes('data-statute-inline-target aria-label="Citation target"'), "A virtual run-in citation does not become the visible scroll target.");
  assert(/class="statutory-runin-line" style="--depth:2"[^>]*>[\s\S]*?data-legal-unit-citation="8 U\.S\.C\. 1101\(a\)\(15\)\(H\)\(i\)\(a\)"/.test(actionableHDefinition), "A validated nested run-in path does not use its relative statutory depth.");
  assert(/class="statutory-runin-line" style="--depth:1"[^>]*>[\s\S]*?data-legal-unit-citation="8 U\.S\.C\. 1101\(a\)\(15\)\(H\)\(iii\)"/.test(actionableHDefinition), "A validated sibling run-in path does not align at the standard statutory depth.");
  assert.strictEqual((formatStatutoryRunInText(statutoryNode(hydratedSource, "1104", ["a"]).text, "a").match(/statutory-runin-line/g) || []).length, 3, "Numeric run-in paragraphs were not formatted.");
  assert.strictEqual((formatStatutoryRunInText(statutoryNode(hydratedSource, "1430", ["b"]).text, "b").match(/statutory-runin-line/g) || []).length, 6, "Nested numeric and letter run-ins were not formatted.");
  assert(formatStatutoryRunInText(statutoryNode(hydratedSource, "1182", ["j", "2", "B", "ii", "I"]).text, "I").includes('<strong class="inline-address">(II)</strong>'), "A run-in sibling retained inside the prior node was not formatted.");

  const referenceOnlyNodes = [
    ["1101", ["a", "15", "A", "iii"]],
    ["1101", ["a", "15", "K", "i"]],
    ["1182", ["d", "13", "B", "ii"]],
    ["1184", ["g", "9", "C", "ii"]],
    ["1255", ["h", "2", "B"]],
    ["1255", ["l", "2", "B"]],
    ["1375c", ["a", "1", "A"]]
  ];
  for (const [section, pathParts] of referenceOnlyNodes) {
    const node = statutoryNode(hydratedSource, section, pathParts);
    assert(!formatStatutoryRunInText(node.text, node.label).includes("statutory-runin-line"), `Reference-only text was split into false statutory lines at 8 U.S.C. ${section}${pathParts.map(value => `(${value})`).join("")}.`);
  }

  const statutoryFormattingAudit = { nodes: 0, formattedNodes: 0, runInLines: 0, citationLinks: 0, indexedRunInPaths: 0 };
  const generatedRunInPathIdentities = new Set();
  const renderedVirtualRunInPathIdentities = new Set();
  const pathIdentity = pathParts => pathParts.map(token => `${String(token).length}:${String(token)}`).join("|");
  const collectStructuralPathIdentities = (nodes, parentPath = [], identities = new Set()) => {
    for (const node of nodes || []) {
      const currentPath = [...parentPath, String(node.label)];
      identities.add(pathIdentity(currentPath));
      collectStructuralPathIdentities(node.children, currentPath, identities);
    }
    return identities;
  };
  for (const section of hydratedSource.title8.sections) {
    for (const pathParts of section.runInPaths || []) generatedRunInPathIdentities.add(`${section.section}:${pathIdentity(pathParts)}`);
  }
  const auditStatutoryNodes = (section, nodes, parentPath = [], structuralIdentities = new Set()) => {
    for (const node of nodes || []) {
      const currentPath = [...parentPath, String(node.label)];
      structuralIdentities.add(pathIdentity(currentPath));
      statutoryFormattingAudit.nodes += 1;
      const output = formatStatutoryRunInText(node.text || "", node.label || "", node.references || []);
      const addresses = [...output.matchAll(/class="inline-address">([^<]+)<\/strong>/g)].map(match => match[1]);
      assert.deepStrictEqual(addresses, statuteRunInMarkers(node.text || "", node.label || "").map(marker => marker.address), `The build-time and browser run-in recognizers disagree at 8 U.S.C. ${section.section}${statutoryCanonicalPath(currentPath)}.`);
      if (addresses.length) statutoryFormattingAudit.formattedNodes += 1;
      statutoryFormattingAudit.runInLines += addresses.length;
      statutoryFormattingAudit.citationLinks += (output.match(/class="statute-citation-link legal-reference-link/g) || []).length;
      for (const address of addresses) assert(/^(?:\((?:\d{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,4}|([a-z])\1{1,2}|([A-Z])\2)\))+$/.test(address), `Invalid formatted statutory address ${address}.`);
      assert(!output.includes('<span class="statutory-runin-line"><strong class="inline-address"></strong>'), "Formatter emitted an empty statutory address.");
      if (addresses.length) {
        const legalUnit = { sectionId: section.id, currentPath, parentPath, citationBase: `8 U.S.C. ${section.section}`, targetPath: [] };
        const actionable = formatStatutoryRunInText(node.text || "", node.label || "", node.references || [], null, legalUnit, node.textFootnoteReferences || []);
        const renderedPaths = [...actionable.matchAll(/data-statute-inline-path="([^"]+)"/g)].map(match => JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
        assert.strictEqual(renderedPaths.length, addresses.length, `A run-in line has no generated path at 8 U.S.C. ${section.section}${statutoryCanonicalPath(currentPath)}.`);
        for (const pathParts of renderedPaths) {
          assert(indexedStatutePathExists(legalUnit, pathParts), `A rendered run-in path is absent from the citation index at 8 U.S.C. ${section.section}${statutoryCanonicalPath(pathParts)}.`);
          statutoryFormattingAudit.indexedRunInPaths += 1;
          if (!structuralIdentities.has(pathIdentity(pathParts))) renderedVirtualRunInPathIdentities.add(`${section.section}:${pathIdentity(pathParts)}`);
        }
      }
      auditStatutoryNodes(section, node.children, currentPath, structuralIdentities);
    }
  };
  for (const section of hydratedSource.title8.sections) auditStatutoryNodes(section, section.body, [], collectStructuralPathIdentities(section.body));
  assert.strictEqual(statutoryFormattingAudit.nodes, 6973, "The statutory formatting audit did not visit every cached node.");
  assert.strictEqual(statutoryFormattingAudit.formattedNodes, 103, "Unexpected change in the set of cached nodes requiring run-in formatting.");
  assert.strictEqual(statutoryFormattingAudit.runInLines, 261, "Unexpected change in the number of formatted cached run-in provisions.");
  assert.strictEqual(statutoryFormattingAudit.indexedRunInPaths, 261, "Not every formatted statutory run-in provision received an indexed path.");
  assert.deepStrictEqual([...renderedVirtualRunInPathIdentities].sort(), [...generatedRunInPathIdentities].sort(), "The generated corpus run-in index has a missing or stale virtual path.");
  assert.strictEqual(statutoryFormattingAudit.citationLinks, 1765, "Unexpected generated-link count in operative statutory text.");
  let ancillaryCitationLinks = 0;
  for (const section of hydratedSource.title8.sections) {
    ancillaryCitationLinks += (linkifyStatutoryText(section.preamble || "", section.preambleReferences || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    ancillaryCitationLinks += (linkifyStatutoryText(section.sourceCredit || "", section.sourceCreditReferences || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    for (const note of section.notes || []) ancillaryCitationLinks += (linkifyStatutoryText(note.text || "", note.references || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    for (const footnote of section.houseEditorialFootnotes || []) ancillaryCitationLinks += (linkifyStatutoryText(footnote.text || "", footnote.references || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
  }
  assert.strictEqual(statutoryFormattingAudit.citationLinks + ancillaryCitationLinks, 15933, "Unexpected total generated-link count in displayed cached statutory material.");

  const parseAssignedProfile = extractedFunction(fallbackSource, "assignedJsonObjectFromText", "updateEmbeddedProfile");
  const migration = profileMigrationFunctions(fallbackSource);
  const tutorialProgress = tutorialProgressFunctions(fallbackSource);
  const completedProgress = {
    schemaVersion: 1,
    modules: {
      "quick-start": { revision: 1, status: "completed", lastStepId: "summary", passedStepIds: ["practice-citation", "recap"], skippedStepIds: [], startedAt: "2026-08-01T10:00:00.000Z", viewedAt: "2026-08-01T10:02:00.000Z", completedAt: "2026-08-01T10:02:00.000Z", updatedAt: "2026-08-01T10:02:00.000Z" }
    }
  };
  const importedInProgress = {
    schemaVersion: 1,
    modules: {
      "quick-start": { revision: 1, status: "in-progress", lastStepId: "reader", passedStepIds: ["practice-citation"], skippedStepIds: [], startedAt: "2026-08-02T10:00:00.000Z", updatedAt: "2026-08-02T10:01:00.000Z" },
      "advanced-search": { revision: 1, status: "viewed", lastStepId: "summary", passedStepIds: [], skippedStepIds: ["practice-filter"], startedAt: "2026-08-02T11:00:00.000Z", viewedAt: "2026-08-02T11:03:00.000Z", updatedAt: "2026-08-02T11:03:00.000Z" },
      "unknown-module": { revision: 99, status: "completed" }
    }
  };
  const mergedTutorialProgress = plain(tutorialProgress.mergeTutorialProgress(completedProgress, importedInProgress));
  assert.strictEqual(mergedTutorialProgress.modules["quick-start"].status, "completed", "Importing lower tutorial status downgraded a completed module.");
  assert.strictEqual(mergedTutorialProgress.modules["quick-start"].lastStepId, "summary", "The highest-status tutorial record did not retain its completed position.");
  assert.strictEqual(mergedTutorialProgress.modules["advanced-search"].status, "viewed", "A separate imported tutorial status was lost.");
  assert.strictEqual(Object.hasOwn(mergedTutorialProgress.modules, "unknown-module"), false, "Unknown tutorial content was accepted into the profile.");
  const normalizedTutorialProgress = plain(tutorialProgress.normalizeTutorialProgress({ modules: { notes: { revision: "1", status: "completed", passedStepIds: ["practice-draft", "practice-draft"], skippedStepIds: [] } } }));
  assert.deepStrictEqual(normalizedTutorialProgress.modules.notes.passedStepIds, ["practice-draft"], "Tutorial resume steps were not normalized and deduplicated.");
  const legacyProfile = JSON.parse(JSON.stringify(blankProfile));
  legacyProfile.notes = [{ id: "old-note", title: "Old", body: "Text containing }; inside a string", tags: [], links: [] }];
  const legacyJs = `/* Old three-file profile */\nwindow.AUTHORITY_SEARCH_PROFILE = ${JSON.stringify(legacyProfile, null, 2)};`;
  assert.deepStrictEqual(parseAssignedProfile(legacyJs, "AUTHORITY_SEARCH_PROFILE"), legacyProfile, "Old three-file AuthoritySearch profile JS was not parsed.");
  const legacyHtml = `<script>window.AUTHORITY_SEARCH_PROFILE = ${JSON.stringify(legacyProfile)}; window.afterProfile = true;</script>`;
  assert.deepStrictEqual(parseAssignedProfile(legacyHtml, "AUTHORITY_SEARCH_PROFILE"), legacyProfile, "Older inline AuthoritySearch profile was not parsed.");
  const parseImportedProfile = extractedFunction(fallbackSource, "profileFromImportedText", "importProfileFile", {
    embeddedJsonFromSource: (source, id) => jsonBlock(source, id),
    assignedJsonObjectFromText: parseAssignedProfile,
    isValidProfile: migration.isValidProfile,
    normalizeProfile: migration.normalizeProfile
  });
  assert.deepStrictEqual(plain(parseImportedProfile(legacyJs)), plain(migration.normalizeProfile(legacyProfile)), "Legacy profile JS import failed.");
  assert.deepStrictEqual(plain(parseImportedProfile(legacyHtml)), plain(migration.normalizeProfile(legacyProfile)), "Legacy inline HTML profile import failed.");
  const legacyStandalone = `<script id="authoritySearchProfileData" type="application/json">${JSON.stringify(legacyProfile)}</script>`;
  assert.deepStrictEqual(plain(parseImportedProfile(legacyStandalone)), plain(migration.normalizeProfile(legacyProfile)), "Legacy standalone AuthoritySearch HTML import failed.");
  assert.deepStrictEqual(plain(parseImportedProfile(JSON.stringify(legacyProfile))), plain(migration.normalizeProfile(legacyProfile)), "JSON profile backup import failed.");
  assert.throws(
    () => parseImportedProfile('<script src="AuthoritySearch-Profile.js"></script>'),
    /Select its AuthoritySearch-Profile\.js file instead/,
    "Old three-file HTML did not explain where its saved data is stored."
  );

  const fixtureDirectory = path.join(root, "tools", "fixtures", "legacy-profiles");
  const importFixture = fileName => {
    const source = fs.readFileSync(path.join(fixtureDirectory, fileName), "utf8");
    const assigned = parseAssignedProfile(source, "AUTHORITY_SEARCH_PROFILE");
    const imported = plain(parseImportedProfile(source));
    assert.strictEqual(migration.isValidProfile(assigned), true, `${fileName}: legacy profile was rejected before normalization.`);
    assert.deepStrictEqual(imported, plain(migration.normalizeProfile(assigned)), `${fileName}: importer and normalizer disagree.`);
    return { source, assigned, imported };
  };

  const comprehensive = importFixture("legacy-comprehensive-profile.js");
  assert.strictEqual(comprehensive.imported.profileId, "synthetic-legacy-comprehensive");
  for (const field of retiredProfileFields) assert.strictEqual(Object.hasOwn(comprehensive.imported, field), false, `Legacy import retained ${field}.`);
  assert.strictEqual(comprehensive.imported.schemaVersion, 3, "A legacy profile was not upgraded to saved-data schema v3.");
  assert.strictEqual(comprehensive.imported.notes.length, 4);
  assert(comprehensive.imported.notes.every(note => !Object.hasOwn(note, "coursePlacement")), "Legacy course placements survived schema-v3 migration.");
  assert.strictEqual(Object.hasOwn(comprehensive.imported, "courseStructure"), false, "Legacy course structure survived schema-v3 migration.");
  assert.deepStrictEqual(comprehensive.imported.notes[0].tags, ["statutes", "day-note", "W2D4"]);
  assert.strictEqual(comprehensive.imported.notes[0].title, "", "A generated WNDM title was not replaced by its migration tag.");
  assert.deepStrictEqual(comprehensive.imported.notes[1].tags, ["module-note", "Block 2 — Synthetic Block Two", "Module 3 — Synthetic Module Three"]);
  assert.strictEqual(comprehensive.imported.notes[1].title, "", "A generated module title was not replaced by migration tags.");
  assert.strictEqual(Object.hasOwn(comprehensive.imported.notes[2], "classificationNoteVisaId"), false, "A card-note identifier survived migration.");
  assert(comprehensive.imported.notes[2].tags.includes("classification"), "A migrated card note lost its generic classification tag.");
  assert(comprehensive.imported.notes[2].links.some(link => link.kind === "legacy" && link.label === "H-1B"), "A migrated card note lost its readable status label.");
  assert.strictEqual(comprehensive.imported.notes[2].body, "Classification note with parser-like text: }; and </script>, ampersand & Unicode — café 🚀.");
  assert.strictEqual(comprehensive.imported.notes[0].links.length, 2);
  const { quizCursorKey: _retiredCursor, quizClassification: _retiredClassification, ...retainedComprehensivePreferences } = comprehensive.assigned.preferences;
  assert.deepStrictEqual(comprehensive.imported.preferences, { ...retainedComprehensivePreferences, statutoryLinkCitationSystem: "usc", highlightDefinedTerms: false, automaticCfrUpdates: true, defaultStartupQuery: "INA 203b1a" });
  const embeddedComprehensive = replaceProfileOnly(full.html, comprehensive.imported);
  assert.deepStrictEqual(jsonBlock(embeddedComprehensive, "inaSearchProfileData"), comprehensive.imported, "Imported legacy data did not survive embedding in the standalone HTML.");
  const comprehensiveReload = await runBootstrap({ ...full, html: embeddedComprehensive, profile: comprehensive.imported });
  assert.deepStrictEqual(plain(comprehensiveReload.profile), comprehensive.imported, "Imported legacy data did not reload from a standalone INASearch file.");
  assert.strictEqual(comprehensiveReload.errors.profile, false);
  assert.deepStrictEqual(plain(parseImportedProfile(JSON.stringify(comprehensive.assigned))), comprehensive.imported, "Comprehensive JSON backup path differs from legacy JS import path.");

  const minimal = importFixture("legacy-minimal-profile.js");
  for (const field of retiredProfileFields) assert.strictEqual(Object.hasOwn(minimal.imported, field), false, `Minimal legacy import retained ${field}.`);
  assert.strictEqual(Object.hasOwn(minimal.imported, "courseStructure"), false);
  assert.strictEqual(Object.hasOwn(minimal.imported.notes[0], "coursePlacement"), false);
  assert.strictEqual(Object.hasOwn(minimal.imported.preferences, "quizCursorKey"), false);
  assert.strictEqual(Object.hasOwn(minimal.imported.preferences, "quizClassification"), false);
  assert.strictEqual(minimal.imported.preferences.statutoryLinkCitationSystem, "usc", "A legacy profile did not receive the safe U.S. Code citation-display default.");
  assert.strictEqual(minimal.imported.preferences.highlightDefinedTerms, false, "A legacy profile did not receive the safe disabled defined-term-highlighting default.");
  assert.strictEqual(minimal.imported.preferences.automaticCfrUpdates, true, "A legacy profile did not enable automatic CFR updates by default.");
  assert.strictEqual(minimal.imported.preferences.defaultStartupQuery, "INA 203b1a", "A legacy profile did not retain the historical startup citation.");
  assert.strictEqual(minimal.imported.notes[0].body, "Preserve this text.");
  const embeddedMinimal = replaceProfileOnly(full.html, minimal.imported);
  const minimalReload = await runBootstrap({ ...full, html: embeddedMinimal, profile: minimal.imported });
  assert.deepStrictEqual(plain(minimalReload.profile), minimal.imported, "Minimal legacy data did not reload from a standalone INASearch file.");
  assert.strictEqual(minimalReload.errors.profile, false);

  const normalized = importFixture("legacy-normalization-profile.js").imported;
  const explicitlyEmptyStartup = plain(migration.normalizeProfile({ ...blankProfile, preferences: { ...blankProfile.preferences, defaultStartupQuery: "" } }));
  assert.strictEqual(explicitlyEmptyStartup.preferences.defaultStartupQuery, "", "Profile normalization replaced an explicitly cleared startup citation.");
  const localOnlyProfile = plain(migration.normalizeProfile({ ...blankProfile, preferences: { ...blankProfile.preferences, automaticCfrUpdates: false } }));
  assert.strictEqual(localOnlyProfile.preferences.automaticCfrUpdates, false, "Profile normalization did not retain the local-only update setting.");
  const schemaTwoImport = plain(migration.normalizeProfile({
    ...blankProfile,
    schemaVersion: 2,
    visaSummaryUnlocks: [{ visaId: "legacy-record" }],
    resourceChallengeLockouts: [{ questionId: "legacy-question" }],
    preferences: { ...blankProfile.preferences, quizCursorKey: "legacy-cursor", quizClassification: "H" }
  }));
  assert.strictEqual(schemaTwoImport.schemaVersion, 3, "A schema-v2 profile was not upgraded.");
  for (const field of retiredProfileFields) assert.strictEqual(Object.hasOwn(schemaTwoImport, field), false, `Schema-v2 import retained ${field}.`);
  assert.strictEqual(Object.hasOwn(schemaTwoImport.preferences, "quizCursorKey"), false);
  assert.strictEqual(Object.hasOwn(schemaTwoImport.preferences, "quizClassification"), false);
  assert(normalized.notes.every(note => !Object.hasOwn(note, "coursePlacement")));
  assert.strictEqual(Object.hasOwn(normalized, "courseStructure"), false);
  assert.deepStrictEqual(normalized.notes[0].tags, ["W6D5"]);
  assert.strictEqual(normalized.notes[0].title, "String-number day", "A custom legacy note title was not preserved.");
  assert.strictEqual(Object.hasOwn(normalized.notes[1], "classificationNoteVisaId"), false);
  assert(normalized.notes[1].tags.includes("classification") && normalized.notes[1].links.some(link => link.kind === "legacy" && link.label === "F-1"), "Normalized card note did not become an ordinary tagged note with a readable legacy item.");
  assert.throws(() => parseImportedProfile('window.AUTHORITY_SEARCH_PROFILE = {"schemaVersion":4,"notes":[],"preferences":{}};'), /valid INASearch profile/, "Unsupported future profile schema was accepted.");
  assert.throws(() => parseImportedProfile('window.INA_SEARCH_PROFILE = {"schemaVersion":1,"notes":"not-an-array","preferences":{}};'), /valid INASearch profile/, "Malformed current notes collection was accepted.");

  console.log(`PASS INASearch.html: ${full.bytes} bytes; ${full.manifest.compressedBytes} gzip bytes`);
  console.log(`PASS INASearch-Uncompressed.html: ${uncompressed.bytes} bytes; ${uncompressed.manifest.uncompressedBytes} plain JSON corpus bytes`);
  console.log(`PASS statutory formatting audit: ${statutoryFormattingAudit.nodes} nodes; ${statutoryFormattingAudit.formattedNodes} nodes with ${statutoryFormattingAudit.runInLines} run-in lines; ${generatedRunInPathIdentities.size} generated virtual paths; ${statutoryFormattingAudit.citationLinks} generated citation links`);
  console.log(`PASS definitions audit: ${full.corpus.definitions.entries.length} source records; 267 USCIS Glossary entries; 199 INA term entries from 170 definition statements; 32 exact 8 CFR 1.2 entries`);
  console.log(`PASS CFR audit: ${full.corpus.cfr.coverage.partCount} active parts; ${full.corpus.cfr.sections.length} sections; ${full.corpus.cfr.appendices.length} appendices; ${full.corpus.cfr.graphics.length} referenced graphics; 1 removed-part tombstone`);
  console.log("PASS round trips, hashes, PTAR boundary/intersection, nested CFR citations, exact visible-match targeting, regulation history, syntax, native loaders, corruption handling, deterministic gzip and plain JSON, profile isolation, comprehensive legacy profile migration, statutory formatting, saving-menu state rules, and ordinary gzip extraction");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
