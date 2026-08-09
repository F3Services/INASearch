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

const root = path.resolve(__dirname, "..");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sourceCorpus() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Corpus.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-CFR.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Visa-Tables.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Form-Questions.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Definitions.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-USCIS-Glossary.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Statute-References.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "INASearch-Statute-Footnotes.js"), "utf8"), sandbox);
  const corpus = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_CORPUS));
  const statuteFootnotes = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_STATUTE_FOOTNOTES));
  applyStatuteFootnotes(corpus, statuteFootnotes);
  corpus.cfr = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_CFR));
  corpus.visaTables = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_VISA_TABLES));
  corpus.visaTables.formQuestions = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_FORM_QUESTIONS));
  const definitions = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_DEFINITIONS));
  const uscisGlossary = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_USCIS_GLOSSARY));
  const statuteReferences = JSON.parse(JSON.stringify(sandbox.window.INA_SEARCH_STATUTE_REFERENCES));
  applyStatuteReferences(corpus, statuteReferences);
  applyGeneratedLegalReferences(corpus);
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
    uncompressed,
    corpus: JSON.parse(uncompressed.toString("utf8"))
  };
}

function executableScripts(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(match => !/type="application\/(?:json|gzip)"/.test(match[1]))
    .map(match => match[2]);
}

async function runBootstrap(build, overrides = {}) {
  const scripts = executableScripts(build.html);
  assert.strictEqual(scripts.length, 2, `${build.fileName}: executable script count`);
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
    "uncompressed-sha256": build.manifest.uncompressedSha256
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
  new vm.Script(scripts[0], { filename: `${build.fileName}:bootstrap` }).runInContext(context);
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
  const expression = new RegExp(`function ${name}\\([\\s\\S]*?\\n    }\\n\\n    (?:async )?function ${nextName}\\(`);
  const match = source.match(expression);
  assert(match, `Could not extract ${name} from the application source.`);
  const functionSource = match[0].replace(new RegExp(`\\n\\n    (?:async )?function ${nextName}\\($`), "");
  return vm.runInNewContext(`(${functionSource})`, { JSON, String, ...context });
}

function profileMigrationFunctions(source) {
  const start = source.indexOf("    function normalizeCourseStructure(");
  const end = source.indexOf("\n\n    let profile =", start);
  assert(start >= 0 && end > start, "Could not extract the profile normalization functions.");
  const declarations = source.slice(start, end);
  return vm.runInNewContext(`${declarations}\n({ normalizeCourseStructure, normalizeCoursePlacement, isValidProfile, normalizeProfile })`, {
    Array,
    Date,
    JSON,
    Number,
    Set,
    String,
    corpus: null,
    makeId: () => "synthetic-default-id",
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

async function main() {
  const fullSource = sourceCorpus();
  const rawDefinitionSource = sourceDefinitions();
  const blankProfile = sourceProfile();
  const full = readBuild("INASearch.html");
  const allUnlocked = readBuild("INASearch-AU.html");
  const uncompressed = readBuild("INASearch-Uncompressed.html");
  const allUnlockedUncompressed = readBuild("INASearch-AU-Uncompressed.html");

  assert.deepStrictEqual(blankProfile.resourceChallengeLockouts, [], "Blank profiles must include persisted resource-question lockouts.");
  assert.strictEqual(fs.existsSync(path.join(root, "INASearch-no-USC.html")), false, "The retired no-USC build still exists.");

  assert(full.bytes <= 8_000_000, "INASearch.html exceeds 8 MB acceptance limit.");
  assert(allUnlocked.bytes <= 8_000_000, "INASearch-AU.html exceeds 8 MB acceptance limit.");
  assert(uncompressed.bytes <= 35_000_000, "INASearch-Uncompressed.html exceeds 35 MB acceptance limit.");
  assert(allUnlockedUncompressed.bytes <= 35_000_000, "INASearch-AU-Uncompressed.html exceeds 35 MB acceptance limit.");
  assert.strictEqual(full.build.variant, "standard");
  assert.strictEqual(full.build.hasLocalUscCache, true);
  assert.strictEqual(full.build.corpusCompression, "gzip");
  assert.strictEqual(allUnlocked.build.variant, "all-unlocked");
  assert.strictEqual(allUnlocked.build.hasLocalUscCache, true);
  assert.strictEqual(allUnlocked.build.corpusCompression, "gzip");
  assert.strictEqual(uncompressed.build.variant, "uncompressed");
  assert.strictEqual(uncompressed.build.hasLocalUscCache, true);
  assert.strictEqual(uncompressed.build.corpusCompression, "none");
  assert.strictEqual(uncompressed.manifest.encoding, "utf-8");
  assert.strictEqual(uncompressed.manifest.mediaType, "application/json");
  assert.strictEqual(Object.hasOwn(uncompressed.manifest, "compressedBytes"), false, "The uncompressed manifest advertises compressed bytes.");
  assert(/id="inaSearchCorpusData" type="application\/json"/.test(uncompressed.html), "The uncompressed corpus is not embedded as plain JSON.");
  assert.strictEqual(allUnlockedUncompressed.build.variant, "all-unlocked-uncompressed");
  assert.strictEqual(allUnlockedUncompressed.build.hasLocalUscCache, true);
  assert.strictEqual(allUnlockedUncompressed.build.corpusCompression, "none");
  assert.strictEqual(allUnlockedUncompressed.manifest.encoding, "utf-8");
  assert.strictEqual(allUnlockedUncompressed.manifest.mediaType, "application/json");
  assert.strictEqual(Object.hasOwn(allUnlockedUncompressed.manifest, "compressedBytes"), false, "The all-unlocked uncompressed manifest advertises compressed bytes.");
  assert(/id="inaSearchCorpusData" type="application\/json"/.test(allUnlockedUncompressed.html), "The all-unlocked uncompressed corpus is not embedded as plain JSON.");
  assert.deepStrictEqual(full.profile, blankProfile);
  assert.deepStrictEqual(uncompressed.profile, blankProfile, "The uncompressed build must retain the standard unanswered profile.");
  assert.deepStrictEqual(allUnlockedUncompressed.profile, allUnlocked.profile, "The all-unlocked uncompressed build does not retain the complete all-unlocked profile.");
  assert.deepStrictEqual(full.corpus, fullSource, "Full corpus round trip changed data.");
  assert.deepStrictEqual(allUnlocked.corpus, fullSource, "All-unlocked corpus round trip changed data.");
  assert.deepStrictEqual(uncompressed.corpus, fullSource, "Uncompressed corpus round trip changed data.");
  assert.deepStrictEqual(allUnlockedUncompressed.corpus, fullSource, "All-unlocked uncompressed corpus round trip changed data.");
  const hydratedSource = unpackLegalReferences(JSON.parse(JSON.stringify(fullSource)));
  for (const href of ["/us/usc/t8/s1101/a/15/H/i/b", "/us/pl/104/208", "/us/stat/110/3009", "/us/act/1952-06-27/ch477"]) {
    assert.strictEqual(expandHouseHref(compactHouseHref(href)), href, `Packed House href did not round-trip: ${href}`);
  }
  assert.strictEqual(full.corpus.title8.sections.length, 376);
  assert.strictEqual(allUnlocked.corpus.title8.sections.length, 376);
  assert.strictEqual(uncompressed.corpus.title8.sections.length, 376);
  assert.strictEqual(allUnlockedUncompressed.corpus.title8.sections.length, 376);
  assert(full.corpus.title8.sections.some(section => Array.isArray(section.body)), "Full corpus has no cached Title 8 bodies.");
  assert(allUnlocked.corpus.title8.sections.some(section => Array.isArray(section.body)), "All-unlocked build has no cached Title 8 bodies.");
  assert(uncompressed.corpus.title8.sections.some(section => Array.isArray(section.body)), "Uncompressed build has no cached Title 8 bodies.");
  assert(allUnlockedUncompressed.corpus.title8.sections.some(section => Array.isArray(section.body)), "All-unlocked uncompressed build has no cached Title 8 bodies.");
  assert.strictEqual(full.corpus.schemaVersion, 3, "The combined corpus schema was not upgraded for structured House footnotes.");
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
  assert.strictEqual(full.corpus.visaCategories.length, 85);
  assert.strictEqual(full.corpus.visaTables.nonimmigrantTypes.length, 84);
  assert.strictEqual(full.corpus.visaTables.immigrantTypes.length, 158);
  assert.strictEqual(full.corpus.visaTables.immigrantDefinitionGroups.length, 8);
  assert.strictEqual(full.corpus.verification.resourceUnlockQuestions, 49);
  assert.strictEqual(full.corpus.verification.nonimmigrantResourceUnlockQuestions, 18);
  assert.strictEqual(full.corpus.verification.immigrantResourceUnlockQuestions, 31);
  const formQuestions = full.corpus.visaTables.formQuestions;
  assert.strictEqual(formQuestions.nonimmigrant.length, 15, "Unexpected nonimmigrant form-question count.");
  assert.strictEqual(formQuestions.immigrant.length, 22, "Unexpected immigrant form-question count.");
  const expectedAllUnlockedQuestions = [
    { id: "resource-nonimmigrant-table", revision: "2026-08-02-1" },
    { id: "resource-nonimmigrant-definitions", revision: "2026-08-02-1" },
    { id: "resource-nonimmigrant-eos-cos", revision: "2026-08-02-1" },
    { id: "resource-immigrant-table", revision: "2026-08-02-1" },
    ...full.corpus.visaTables.immigrantDefinitionGroups,
    ...formQuestions.nonimmigrant,
    ...formQuestions.immigrant
  ].map(question => ({ questionId: question.id, revision: question.revision })).sort((a, b) => a.questionId.localeCompare(b.questionId));
  const actualAllUnlockedQuestions = allUnlocked.profile.resourceUnlocks
    .map(question => ({ questionId: question.questionId, revision: question.revision }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
  assert.strictEqual(expectedAllUnlockedQuestions.length, 49, "The expected all-unlocked resource-question set changed.");
  assert.deepStrictEqual(actualAllUnlockedQuestions, expectedAllUnlockedQuestions, "INASearch-AU does not unlock every current card-resource question revision.");
  assert(allUnlocked.profile.resourceUnlocks.every(record => record.corpusVersion === full.corpus.corpusVersion && Date.parse(record.unlockedAt)), "An all-unlocked resource record is missing current corpus metadata.");
  assert.deepStrictEqual(allUnlocked.profile.resourceChallengeLockouts, [], "INASearch-AU contains a resource-question lockout.");
  assert.deepStrictEqual(allUnlocked.profile.visaSummaryUnlocks, [], "INASearch-AU incorrectly answers optional classic summary questions.");
  assert.deepStrictEqual(allUnlocked.profile.visaFactUnlocks, [], "INASearch-AU incorrectly answers optional classic fact questions.");
  assert.strictEqual(allUnlocked.profile.preferences.quizCursorKey, null, "INASearch-AU advances the optional classic quiz.");
  const allFormQuestions = [...formQuestions.nonimmigrant, ...formQuestions.immigrant];
  assert.strictEqual(new Set(allFormQuestions.map(question => question.id)).size, allFormQuestions.length, "Form-question IDs must be unique.");
  for (const kind of ["nonimmigrant", "immigrant"]) {
    const validSymbols = new Set(full.corpus.visaTables[`${kind}Types`].map(record => record.symbol));
    for (const question of formQuestions[kind]) {
      assert(question.correctSymbols.length, `${question.id}: form question has no correct statuses.`);
      assert(question.correctSymbols.every(symbol => validSymbols.has(symbol)), `${question.id}: form question references an unknown status.`);
      assert(typeof question.answerLabel === "string" && question.answerLabel.length > 10, `${question.id}: form question has no concise multiple-choice answer label.`);
      assert(question.form === null || question.prompt.includes("{form}"), `${question.id}: linked form is not present in the prompt.`);
      assert(question.source?.label && question.source?.url, `${question.id}: missing specifically named source link.`);
    }
    assert.strictEqual(new Set(formQuestions[kind].map(question => question.answerLabel)).size, formQuestions[kind].length, `${kind}: form-question answer labels must be unique.`);
  }
  const nonimmigrantFormCoverage = new Set(formQuestions.nonimmigrant.flatMap(question => question.correctSymbols));
  const immigrantFormCoverage = new Set(formQuestions.immigrant.flatMap(question => question.correctSymbols));
  assert.strictEqual(nonimmigrantFormCoverage.size, 39, "Unexpected nonimmigrant form coverage.");
  assert.strictEqual(immigrantFormCoverage.size, 151, "Unexpected immigrant form coverage.");
  assert.deepStrictEqual(full.corpus.visaTables.nonimmigrantTypes.map(record => record.symbol).filter(symbol => !nonimmigrantFormCoverage.has(symbol)), ["A1", "A2", "A3", "B1", "B2", "B1/B2", "C1", "C1/D", "C2", "C3", "D", "E1", "E2", "E2C", "E3", "E3D", "E3R", "F1", "F2", "F3", "G1", "G2", "G3", "G4", "G5", "H1B1", "H1C", "H4", "I", "J1", "J2", "M1", "M2", "M3", "N8", "N9", "NATO1", "NATO2", "NATO3", "NATO4", "NATO5", "NATO6", "NATO7", "TN", "TD"], "Unsupported nonimmigrant form set changed.");
  assert.deepStrictEqual(full.corpus.visaTables.immigrantTypes.map(record => record.symbol).filter(symbol => !immigrantFormCoverage.has(symbol)), ["SB1", "SC1", "SC2", "SP", "SS1", "SS2", "SS3"], "Unsupported immigrant form set changed.");
  const derivativeQuestions = allFormQuestions.filter(question => question.id.includes("derivative"));
  assert(derivativeQuestions.length && derivativeQuestions.every(question => question.card?.derivativeExplanation), "Every derivative question needs hover-detail text.");
  assert(full.corpus.approvedDomains.includes("eforms.state.gov"), "Department of State form links require their exact approved host.");
  assert(allFormQuestions.flatMap(question => [question.source?.url, question.form?.url]).filter(Boolean).every(url => full.corpus.approvedDomains.includes(new URL(url).hostname)), "A form question points outside the approved domains.");
  const tDerivative = formQuestions.nonimmigrant.find(question => question.id === "resource-nonimmigrant-form-i-914a-derivative");
  const uDerivative = formQuestions.nonimmigrant.find(question => question.id === "resource-nonimmigrant-form-i-918a-derivative");
  assert.strictEqual(tDerivative.card.value, "Form I-914", "T derivatives must display the principal's form type.");
  assert.strictEqual(uDerivative.card.value, "Form I-918", "U derivatives must display the principal's form type.");
  const legacyInvestor = formQuestions.immigrant.find(question => question.id === "resource-immigrant-form-i-526-direct");
  assert.strictEqual(legacyInvestor.card.valueBySymbol.R51, "Form I-526 (legacy)");
  assert.strictEqual(legacyInvestor.card.valueBySymbol.I51, "Form I-526 (legacy)");
  assert(full.html.includes('class="resource-choice-citation"'), "Resource citations should be the inspectable answer links.");
  assert(!full.html.includes('class="resource-status-choices"'), "Form questions still render the oversized status checkbox list.");
  assert(!full.html.includes('data-resource-status='), "The obsolete multi-status checkbox handler remains in the application.");
  assert(full.html.includes('classificationQualifier("*derivative classification"'), "Derivative cards should display the asterisked derivative label.");
  assert(full.html.includes('class="classification-tooltip" role="tooltip"'), "Derivative details should use a hoverable, focusable tooltip.");
  assert.strictEqual((full.html.match(/resource-nonimmigrant-eos-cos/g) || []).length, 1, "EOS/COS must remain one combined resource question.");
  assert(!allFormQuestions.some(question => /extension of stay|change of status|eos|cos/i.test(question.id)), "Initial-form questions must not duplicate the combined EOS/COS question.");
  assert(!full.html.includes('>Open resource ↗</a>'), "Resource choices should not use a detached open-resource link.");
  assert(full.html.includes('typeFieldLabel("Section of law", "type-law"'), "Section-of-law fields should expose source information.");
  assert(full.html.includes('typeFieldLabel("Change of status", "type-cos"'), "Unlocked COS fields should expose source information.");
  assert(full.html.includes('class="type-card-status"'), "Card unlock status should render at the top of each classification card.");
  assert.deepStrictEqual(full.corpus.visaTables.immigrantDefinitionGroups.map(group => group.symbols.length), [120, 1, 3, 3, 3, 1, 6, 21]);
  const inaOnlyDefinitionGroup = full.corpus.visaTables.immigrantDefinitionGroups.find(group => group.authority === "Immigration and Nationality Act (INA)");
  assert(inaOnlyDefinitionGroup.scopeLabel.startsWith("IR, IH, CR"), "The large INA-only group should use compact root-prefix wording.");
  assert(full.corpus.visaTables.immigrantDefinitionGroups.every(group => group.scopeLabel && group.sourceUrl), "Every immigrant definition group needs compact scope wording and an inspectable source link.");
  const groupedImmigrantSymbols = full.corpus.visaTables.immigrantDefinitionGroups.flatMap(group => group.symbols);
  assert.strictEqual(groupedImmigrantSymbols.length, full.corpus.visaTables.immigrantTypes.length, "Immigrant definition groups do not cover every classification exactly once.");
  assert.strictEqual(new Set(groupedImmigrantSymbols).size, groupedImmigrantSymbols.length, "An immigrant classification appears in more than one definition group.");
  assert.deepStrictEqual(new Set(groupedImmigrantSymbols), new Set(full.corpus.visaTables.immigrantTypes.map(record => record.symbol)));
  assert.strictEqual(full.corpus.verification.quizQuestions, 442);
  assert.strictEqual(full.corpus.forms.length, 105);
  assert.strictEqual(full.corpus.namedActs.length, 5);
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
  assert.strictEqual(generatedReferences("Form I-130 requires 3 years of evidence.", fixtureContext).length, 0, "A known noncitation pattern produced a false legal reference.");

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
  assert.deepStrictEqual(allUnlocked.corpus.definitions, full.corpus.definitions, "All-unlocked build lost or altered the definitions catalog.");
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

  for (const build of [full, allUnlocked, uncompressed, allUnlockedUncompressed]) {
    const scripts = executableScripts(build.html);
    assert.strictEqual(scripts.length, 2);
    scripts.forEach((source, index) => new vm.Script(source, { filename: `${build.fileName}:script-${index + 1}` }));
    assert(!/<script[^>]+src=/i.test(build.html), `${build.fileName}: external script detected.`);
    assert(!/\bfetch\s*\(/.test(build.html), `${build.fileName}: automatic fetch code detected.`);
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

  const fullPayload = payloadBlock(full.html);
  const allUnlockedPayload = payloadBlock(allUnlocked.html);
  const uncompressedPayload = corpusPayloadText(uncompressed.html);
  const rebuild = spawnSync(process.execPath, [path.join(root, "tools", "build-standalone.js")], { cwd: root, encoding: "utf8" });
  assert.strictEqual(rebuild.status, 0, rebuild.stderr);
  assert.strictEqual(payloadBlock(fs.readFileSync(full.filePath, "utf8")), fullPayload, "Full gzip output is not deterministic.");
  assert.strictEqual(payloadBlock(fs.readFileSync(allUnlocked.filePath, "utf8")), allUnlockedPayload, "All-unlocked gzip output is not deterministic.");
  assert.strictEqual(corpusPayloadText(fs.readFileSync(uncompressed.filePath, "utf8")), uncompressedPayload, "Uncompressed JSON output is not deterministic.");

  const fallbackSource = fs.readFileSync(path.join(root, "src", "INASearch.template.html"), "utf8");
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
  assert(fallbackSource.includes("const studyUnavailable = active || !corpus;"));
  assert(fallbackSource.includes("Official navigation is available"));
  assert(fallbackSource.includes("https://www.ecfr.gov/current/title-"));
  assert(fallbackSource.includes("state.saveTimer = setTimeout(queueProfileWrite, 5000);"));
  assert(fallbackSource.includes('id="savingMenuModal"'));
  assert(fallbackSource.includes('els.profileSetupNotice.hidden = mode !== "unsaved";'));
  assert(fallbackSource.includes('els.saveStatus.disabled = false;'));
  assert(fallbackSource.includes('button.status-chip { cursor: pointer; font-family: inherit; font-size: 11px; }'), "The Saving status button no longer matches the compact Corpus Loaded chip typography.");
  assert(fallbackSource.includes("Import earlier progress"));
  assert(fallbackSource.includes("AuthoritySearch-Profile.js"), "The renamed build no longer explains how to import an older three-file AuthoritySearch profile.");
  assert(fallbackSource.includes('id="view-definitions"'));
  assert(fallbackSource.includes('data-view="definitions"'));
  assert(/<nav class="main-nav"[^>]*>\s*<button class="nav-button" data-view="definitions" aria-current="false">Definitions<\/button>/.test(fallbackSource), "Definitions is not the leftmost primary-page control or is incorrectly marked current on startup.");
  assert(fallbackSource.includes('id="view-search" aria-label="Search results"'), "Search is not the default visible view.");
  assert(fallbackSource.includes('id="view-definitions" hidden aria-labelledby="definitionsHeading"'), "Definitions remains the default visible view.");
  assert(fallbackSource.includes('view: "search"') && fallbackSource.includes('contentViewBeforeSearch: "definitions"'), "The startup state does not open search while retaining Definitions as the close destination.");
  assert(fallbackSource.includes('id="view-visas" hidden aria-labelledby="visasHeading"'), "Nonimmigrant Types is still the default visible view.");
  assert(!/<button class="nav-button" data-view="(?:visas|immigrants)"/.test(fallbackSource), "Immigration Types remain in the primary navigation.");
  assert(fallbackSource.includes('data-study-view="visas">Nonimmigrant Types</button>') && fallbackSource.includes('data-study-view="immigrants">Immigrant Types</button>'), "Sources & About does not link to both Immigration Types pages.");
  assert(!fallbackSource.includes('class="nav-button" data-view="quiz"'), "The classic Quiz remains in the primary navigation.");
  assert(fallbackSource.includes('id="openClassicQuizButton"'), "Sources & About does not link to the classic quiz.");
  assert(/<div class="search-field-shell">[\s\S]*?<input class="search-input"[\s\S]*?<button class="search-suggestion-inline" id="searchSuggestionButton"/.test(fallbackSource), "The rotating suggestion is not integrated into the main search field.");
  assert(/id="impliedUscTitle"[\s\S]*?>8<\/span>[\s\S]*?id="searchInput"/.test(fallbackSource), "The implied Title 8 marker is not positioned before the typed U.S.C. citation.");
  assert(fallbackSource.includes("No U.S.C. title was entered. INASearch is assuming Title 8 for this lookup."), "The implied Title 8 warning is missing.");
  assert(fallbackSource.includes("updateSearchSuggestionVisibility();"), "The integrated search suggestion does not hide when a query is present.");
  const startupSearchQuery = extractedFunction(fallbackSource, "startupSearchQuery", "showSearchResults", { URLSearchParams, String, DEFAULT_STARTUP_QUERY: "INA 203b1a" });
  assert.strictEqual(startupSearchQuery({ search: "?q=22%20CFR%2042.11" }), "22 CFR 42.11", "The startup query does not decode citation URLs.");
  assert.strictEqual(startupSearchQuery({ search: "?q=%20INA%20215(a)%20" }), " INA 215(a) ", "Formatting explicitly supplied in the URL query is not preserved for the editable field.");
  assert.strictEqual(startupSearchQuery({ search: "?q=" }), "", "An explicitly empty q argument was replaced by the default citation.");
  assert.strictEqual(startupSearchQuery({ search: "?other=value" }), "INA 203b1a", "A URL without a q argument did not receive the INA 203b1a default.");
  assert.strictEqual(startupSearchQuery({ search: "" }), "INA 203b1a", "The no-argument startup citation is not INA 203b1a.");
  assert.strictEqual(startupSearchQuery({ search: `?q=${"a".repeat(600)}` }).length, 500, "The startup query is not length-limited.");
  assert(fallbackSource.includes("if (startupQuery) setTimeout(() => applySearchQuery(startupQuery, false, true), 0);"), "Initialization does not preserve the displayed formatting of the startup query.");
  const startupEditableSearch = { value: "" };
  const startupApplyState = { query: "" };
  const applyStartupSearchQuery = extractedFunction(fallbackSource, "applySearchQuery", "openSearchRecord", {
    String,
    els: { search: startupEditableSearch },
    state: startupApplyState,
    updateSearchSuggestionVisibility: () => {},
    closeSearchResults: () => {},
    showSearchResults: () => {},
    runSearch: () => {}
  });
  applyStartupSearchQuery(" INA 215(a) ", false, true);
  assert.strictEqual(startupEditableSearch.value, " INA 215(a) ", "Startup query formatting is canonicalized before it reaches the editable field.");
  applyStartupSearchQuery(" INA 215(a) ", false);
  assert.strictEqual(startupEditableSearch.value, "INA 215(a)", "Ordinary non-startup query normalization unexpectedly changed.");
  assert(!fallbackSource.includes('data-filter="authorities"'), "The obsolete Authorities result filter remains visible.");
  for (const filter of ["statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "visas", "policy", "forms", "notes"]) {
    assert(fallbackSource.includes(`data-filter="${filter}"`), `The ${filter} result filter is missing.`);
  }
  assert(!fallbackSource.includes('class="search-results-tools"') && !fallbackSource.includes('id="closeSearchResultsButton"'), "The redundant lookup-status panel remains in the search view.");
  assert(fallbackSource.includes('id="searchWorkspace"') && fallbackSource.includes('id="resultsPanel"'), "The single-result reading layout cannot target the search workspace and result panel.");
  assert(fallbackSource.includes('id="citationResultsNotification"') && fallbackSource.includes('id="citationResultsNotificationCount"'), "The citation reader has no notification for other matching material.");
  for (const filter of ["all", "statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "visas", "policy", "forms", "notes"]) {
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
    citationResultsExpanded: false
  };
  const directCitationResult = extractedFunction(fallbackSource, "directCitationResult", "citationOtherResultCount", { state: directCitationState });
  assert.strictEqual(directCitationResult().key, "usc:1153", "A valid citation is not retained as the direct reading result.");
  const citationOtherResultCount = extractedFunction(fallbackSource, "citationOtherResultCount", "updateCitationResultsNotification", { state: directCitationState, directCitationResult });
  assert.strictEqual(citationOtherResultCount(), 1, "The citation notification does not exclude the citation itself from its count.");
  const isCitationReadingMode = extractedFunction(fallbackSource, "isCitationReadingMode", "updateSearchResultLayout", { state: directCitationState, directCitationResult });
  assert(isCitationReadingMode(), "A direct citation does not default to reading mode.");
  directCitationState.citationResultsExpanded = true;
  assert(!isCitationReadingMode(), "Opening the other results does not reveal the search pane.");
  assert(fallbackSource.includes("A wrong resource answer locks only that specific question for one minute and keeps it open"), "The Types pages do not explain the one-minute, stay-on-question resource lockout.");
  assert(fallbackSource.includes('${questionLockout ? "disabled" : ""}></label>${link}</div>'), "Resource answer controls are not disabled independently from their linked sources during a lockout.");
  const corpusStatusElement = { innerHTML: "", title: "", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const updateCorpusStatus = extractedFunction(fallbackSource, "updateCorpusStatus", "initialize", {
    corpus: { corpusVersion: "2026.08.02-7", capturedAt: "2026-07-30", verifiedAt: "2026-07-31" },
    els: { corpusStatus: corpusStatusElement },
    loadErrors: {}
  });
  updateCorpusStatus();
  assert.strictEqual(corpusStatusElement.innerHTML, '<span class="status-dot"></span>Corpus Loaded', "The successful corpus chip does not use a plain-language status.");
  assert.strictEqual(corpusStatusElement.title, "Version: 2026.08.02-7 · Captured: 2026-07-30 · Verified: 2026-07-31", "The corpus chip tooltip omits its version or source dates.");
  assert.strictEqual(corpusStatusElement.attributes["aria-label"], "Corpus loaded. Version: 2026.08.02-7 · Captured: 2026-07-30 · Verified: 2026-07-31", "The corpus chip does not expose its status details accessibly.");
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
  assert.strictEqual(saveStatusElement.attributes["aria-label"], "Saving is off. Open saving and progress options.", "The disconnected saving chip has an inaccurate accessible label.");
  saveStatusState.fileConnected = true;
  updateSaveStatus("Autosave queued", "warn");
  assert.strictEqual(saveStatusElement.innerHTML, '<span class="status-dot warn"></span>Saving On', "The connected saving chip exposes internal queue wording instead of the requested short label.");
  assert.strictEqual(saveStatusElement.attributes["aria-label"], "Saving is on. Autosave queued. Open saving and progress options.", "The connected saving chip lost its detailed accessible status.");
  assert(/<div class="brand" id="inaSearchBrand"[\s\S]*?<span class="brand-mark"[\s\S]*?<strong>INASearch<\/strong><small>Quick INA\/CFR Lookup<\/small>[\s\S]*?id="brandTribute"/.test(fallbackSource), "The tribute hover area does not continuously wrap the full INASearch brand.");
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
  const resourceLockoutProfile = { resourceChallengeLockouts: [{ questionId: "resource-other", revision: "test-revision", lockedUntil: "2026-08-03T12:45:00.000Z" }] };
  let resourceLockoutChanges = 0;
  const recordResourceLockout = extractedFunction(fallbackSource, "recordResourceLockout", "immigrantDefinitionQuestion", {
    profile: resourceLockoutProfile,
    markProfileChanged: () => { resourceLockoutChanges += 1; },
    Date
  });
  const resourceQuestion = { id: "resource-test", revision: "test-revision" };
  const lockoutStartedAt = Date.parse("2026-08-03T12:00:00.000Z");
  recordResourceLockout(resourceQuestion, lockoutStartedAt);
  assert.strictEqual(resourceLockoutChanges, 1, "Recording a resource lockout did not mark the profile changed.");
  assert.deepStrictEqual(plain(resourceLockoutProfile.resourceChallengeLockouts), [
    { questionId: "resource-other", revision: "test-revision", lockedUntil: "2026-08-03T12:45:00.000Z" },
    { questionId: resourceQuestion.id, revision: resourceQuestion.revision, lockedUntil: "2026-08-03T12:01:00.000Z" }
  ], "A resource-question lockout changed another question or was not exactly one minute.");
  const activeResourceLockout = extractedFunction(fallbackSource, "activeResourceLockout", "recordResourceLockout", {
    profile: resourceLockoutProfile,
    Date
  });
  assert.strictEqual(activeResourceLockout(resourceQuestion, lockoutStartedAt).remainingMs, 60000);
  assert.strictEqual(activeResourceLockout(resourceQuestion, lockoutStartedAt + 60000), null, "Resource lockout remained active after one minute.");
  assert.strictEqual(activeResourceLockout({ ...resourceQuestion, revision: "new-revision" }, lockoutStartedAt), null, "A stale resource-question revision remained locked.");
  const currentResourceQuestion = extractedFunction(fallbackSource, "currentResourceQuestion", "resourceQuestionLockouts", {
    resourceQuestions: () => [{ id: "locked-question" }, { id: "available-question" }],
    isResourceUnlocked: () => false,
    activeResourceLockout: question => question.id === "locked-question" ? { remainingMs: 1000 } : null,
    state: { resourceQuizQuestionId: { nonimmigrant: null } }
  });
  assert.strictEqual(currentResourceQuestion("nonimmigrant").id, "locked-question", "A wrong resource answer automatically jumped to another question.");
  const formRotatedOptions = extractedFunction(fallbackSource, "rotatedOptions", "resourceOptions");
  const formResourceOptions = extractedFunction(fallbackSource, "resourceOptions", "resourceQuestionPrompt", {
    RESOURCE_CATALOG: {},
    Set,
    corpus: full.corpus,
    normalize: value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    rotatedOptions: formRotatedOptions,
    statusFormQuestions: kind => formQuestions[kind]
  });
  for (const kind of ["nonimmigrant", "immigrant"]) {
    for (const question of formQuestions[kind]) {
      const correctOptionId = `${question.id}:correct`;
      const options = plain(formResourceOptions({ ...question, correctOptionId }));
      assert.strictEqual(options.length, 6, `${question.id}: form question does not have exactly six answer choices.`);
      assert.strictEqual(new Set(options.map(option => option.id)).size, 6, `${question.id}: form question has duplicate option IDs.`);
      assert.strictEqual(new Set(options.map(option => option.label)).size, 6, `${question.id}: form question has duplicate answer labels.`);
      assert.strictEqual(options.filter(option => option.id === correctOptionId).length, 1, `${question.id}: form question does not have exactly one correct option.`);
      assert(options.every(option => option.url === question.source.url), `${question.id}: an answer option does not link to the question's approved source.`);
    }
  }
  const nonimmigrantQuestionFour = plain(formResourceOptions({ ...formQuestions.nonimmigrant[0], correctOptionId: `${formQuestions.nonimmigrant[0].id}:correct` }));
  assert.strictEqual(nonimmigrantQuestionFour.length, 6, "Nonimmigrant question 4 is not six-option multiple choice.");
  assert(nonimmigrantQuestionFour.some(option => option.label === "Employment-based and related principal classifications (H, L, O, P, Q, and R principals)"), "Nonimmigrant question 4 lacks the grouped correct answer.");
  const submitResourceQuizSource = extractedFunction(fallbackSource, "submitResourceQuiz", "visaTableRecords").toString();
  assert(submitResourceQuizSource.includes("recordResourceLockout(question)"), "Wrong resource answers do not record a lockout.");
  assert(!submitResourceQuizSource.includes("correctStatuses"), "Resource submission still expects a giant status-checkbox set.");
  const wrongResourceQuestion = { id: "resource-stay-put", correctOptionId: "correct" };
  const wrongResourceState = {
    resourceQuizQuestionId: { nonimmigrant: wrongResourceQuestion.id },
    resourceQuizSelection: { nonimmigrant: "wrong" },
    resourceQuizFeedback: { nonimmigrant: "" }
  };
  let wrongResourceLockouts = 0;
  let wrongResourceRenders = 0;
  const submitResourceQuiz = extractedFunction(fallbackSource, "submitResourceQuiz", "visaTableRecords", {
    studyAccessLocked: () => false,
    resourceQuestions: () => [wrongResourceQuestion],
    state: wrongResourceState,
    isResourceUnlocked: () => false,
    activeResourceLockout: () => null,
    recordResourceLockout: () => { wrongResourceLockouts += 1; },
    renderResourceQuiz: () => { wrongResourceRenders += 1; },
    recordResourceUnlock: () => { throw new Error("A wrong answer must not unlock the question."); },
    renderVisaGrid: () => {},
    renderImmigrantGrid: () => {},
    buildIndex: () => {}
  });
  submitResourceQuiz("nonimmigrant");
  assert.strictEqual(wrongResourceLockouts, 1, "A wrong resource answer did not start its lockout.");
  assert.strictEqual(wrongResourceRenders, 1, "A wrong resource answer did not redraw the retained question.");
  assert.strictEqual(wrongResourceState.resourceQuizQuestionId.nonimmigrant, wrongResourceQuestion.id, "A wrong resource answer cleared the current question and advanced automatically.");
  assert.strictEqual(wrongResourceState.resourceQuizSelection.nonimmigrant, null, "A wrong resource answer retained the selected choice.");
  const submitSequenceQuizSource = extractedFunction(fallbackSource, "submitSequenceQuiz", "currentLink").toString();
  assert(!submitSequenceQuizSource.includes("recordQuizLockout"), "Classic practice questions still record a retry lockout.");
  const isQuizQuestionCandidate = extractedFunction(fallbackSource, "isQuizQuestionCandidate", "quizQuestionAtOrAfter", {
    isQuizQuestionAvailable: () => true,
    isQuizQuestionUnlocked: () => false,
    quizQuestionLockout: () => { throw new Error("Classic candidates must ignore legacy lockouts."); },
    state: { quizIncludeAnswered: false }
  });
  assert.strictEqual(isQuizQuestionCandidate({}), true, "A legacy lockout still removes a classic practice question from rotation.");
  assert(fallbackSource.includes('id="statuteNavigator"'), "The live statute hierarchy navigation is missing.");
  assert(fallbackSource.includes('data-statute-history="back"') && fallbackSource.includes('data-statute-history="forward"'), "The statute navigation bar is missing Back and Forward controls.");
  assert(fallbackSource.includes('event.target.closest("[data-statute-history]")'), "The statute history controls are not connected to delegated navigation events.");
  assert(fallbackSource.includes('data-statute-path='), "Rendered statutory nodes do not expose their hierarchy paths.");
  assert(fallbackSource.includes('id="legalUnitMenu"') && fallbackSource.includes('data-legal-unit-action="copy-usc-citation"'), "The structural legal-unit action menu is missing.");
  for (const label of ["Copy Statute", "Print Statute", "Open in House.gov"]) assert(fallbackSource.includes(label), `The legal-unit menu is missing ${label}.`);
  assert(!fallbackSource.includes('>Copy USC Citation</button>') && !fallbackSource.includes('>Copy INA Citation</button>'), "Redundant textual citation-copy menu items remain visible.");
  const legalUnitMenuStart = fallbackSource.indexOf('id="legalUnitMenu"');
  const legalUnitMenuEnd = fallbackSource.indexOf('</div>\n  <section class="legal-reference-popover"', legalUnitMenuStart);
  const legalUnitMenuMarkup = fallbackSource.slice(legalUnitMenuStart, legalUnitMenuEnd);
  assert((legalUnitMenuMarkup.match(/<span aria-hidden="true">⧉<\/span>/g) || []).length === 2, "The two legal-unit citation rows do not use symbol-only copy controls.");
  assert(fallbackSource.includes('id="legalUnitMenuCrosswalkCitation"') && fallbackSource.includes('context.inaCitation') && fallbackSource.includes('data-legal-unit-action="copy-ina-citation"'), "Statutory units do not expose their crosswalked citation as a second copyable row.");
  assert(fallbackSource.includes('event.target.closest("[data-legal-unit-kind]")'), "Structural citation markers do not open the legal-unit menu.");
  assert(fallbackSource.includes('html{color-scheme:light}') && fallbackSource.includes('background:#fff'), "Legal-unit printing does not force a light text-only page.");
  assert(fallbackSource.includes('Math.max(0, window.innerHeight - navigatorBottom) * .1'), "The statute reading line is not one tenth of the statute viewport.");
  assert(/\.statutory-node,\s*\.statutory-runin-line \{ position: relative; margin: 5px 0 5px min\(calc\(var\(--depth, 0\) \* 15px\), 90px\); padding: 5px 7px 7px; border-radius: 6px; \}/.test(fallbackSource), "Run-in statutory units do not share the standard unit layout rules.");
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
  const definitionMatchesQuery = extractedFunction(fallbackSource, "definitionMatchesQuery", "definitionScope", {
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
    normalize: searchNormalize,
    filterMatches: () => true,
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
  const cfrPartMap = new Map(full.corpus.cfr.parts.map(part => [`${part.title}:${statutoryNormPart(part.part)}`, part]));
  const cfrRemovedPartMap = new Map(full.corpus.cfr.removedParts.map(part => [`${part.title}:${statutoryNormPart(part.part)}`, part]));
  const cfrBlockText = block => block?.t === "table" ? [block.caption, ...(block.rows || []).flat().map(cell => cell.x)].join(" ") : block?.t === "note" ? (block.blocks || []).map(cfrBlockText).join(" ") : block?.x || block?.alt || "";
  const cfrSearchFields = extractedFunction(fallbackSource, "cfrSearchFields", "cfrBlockUnitPaths", { normalize: searchNormalize, cfrBlockText });
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
  const cfrBlockUnitPaths = block => [...new Set([...(block?.u || []).map(unit => unit.a), block?.a].filter(Boolean))];
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
  const parseCfr = extractedFunction(fallbackSource, "parseCfr", "parseAct", {
    Number, String, Set,
    cfrSectionMap, cfrSectionIdMap, cfrPartMap, cfrRemovedPartMap,
    componentTokens: cfrComponentTokens,
    compactHierarchyTokens: cfrComponentTokens,
    canonicalPath: cfrCanonicalPath,
    normCitationPart: statutoryNormPart,
    normalize: searchNormalize,
    cfrItemText, cfrBlockPaths,
    cachedCfrBlockPaths: section => [...new Set(cfrBlockPaths(section?.blocks))]
  });
  const nestedCfr = parseCfr("8", "214.2(h)(13)(iii)(A)");
  assert(nestedCfr.valid && !nestedCfr.external && nestedCfr.record.item.id === "8:214.2", "Nested cached CFR citation did not resolve locally.");
  assert.strictEqual(nestedCfr.message, "Section and paragraph found in this edition.");
  assert.strictEqual(parseCfr("8", "214.2(h)(13)(iii)(Z)").valid, false, "Invalid cached CFR paragraph path was accepted.");
  assert.strictEqual(parseCfr("22", "41.12").record.item.id, "22:41.12");
  assert.strictEqual(parseCfr("22", "42.11").record.item.id, "22:42.11");
  assert.strictEqual(parseCfr("42", "34.1").record.item.id, "42:34.1");
  assert(parseCfr("22", "62").partial && parseCfr("22", "62").suggestions.length > 0, "Cached part-only CFR lookup does not list its sections.");
  assert(parseCfr("45", "402").removed, "Removed 45 CFR Part 402 does not surface its tombstone.");
  const uncachedCfr = parseCfr("26", "1.1");
  assert(uncachedCfr.valid && uncachedCfr.external && /not included/i.test(uncachedCfr.message), "Outside-coverage CFR lookup does not use the explicit eCFR fallback.");
  const cfrSearchTarget = extractedFunction(fallbackSource, "cfrSearchTarget", "statuteSearchTarget", { normalize: searchNormalize, searchTextMatch, cfrSearchFields });
  const searchRouteGroups = extractedFunction(fallbackSource, "searchRouteGroups", "filterMatches", { Set, String });
  for (const query of ["8 c", "8 cf", "8 CFR 214", "8 USC 1101", "INA 101", "Pub. L. 104-208", "special situation"]) {
    const groups = searchRouteGroups(query, "all");
    assert(groups.has("statutes") && groups.has("regulations") && groups.has("policy"), `Citation-shaped query “${query}” does not search the complete corpus for related material.`);
  }
  assert.deepStrictEqual([...searchRouteGroups("8 CFR 214", "regulations")], ["regulations"], "An explicit result filter no longer narrows the displayed source group.");
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
  const resultFilterGroups = new Set(["all", "statutes", "regulations", "ina", "acts", "definitions", "statute-notes", "policy", "forms", "visas", "notes"]);
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
  assert(fallbackSource.includes('function fitStatuteNavigation()') && fallbackSource.includes('segments.length - 1') && fallbackSource.includes('classList.add("unit-name-hidden")'), "The statute navigator does not progressively hide the smallest unit names when it wraps.");
  assert(fallbackSource.includes('child.getClientRects().length'), "Hidden navigator elements are still included in the wrapping calculation.");
  assert(fallbackSource.includes('.statute-nav-segment.unit-name-hidden summary small { display: none; }'), "Individual unit-name compaction styling is missing.");
  assert(!fallbackSource.includes('statute-nav-inner.compact'), "The all-or-nothing statute-unit compaction rule remains enabled.");
  const testClassList = initial => {
    const values = new Set(initial || []);
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
  };
  const progressiveSegments = Array.from({ length: 5 }, () => ({ classList: testClassList() }));
  let progressiveNavigatorWide = false;
  const progressiveInner = { classList: testClassList(), children: [] };
  progressiveInner.children = [
    {
      getClientRects: () => progressiveInner.classList.contains("intro-hidden") ? [] : [{}],
      getBoundingClientRect: () => ({ top: 0, height: 40 })
    },
    { getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 10, height: 20 }) },
    {
      getClientRects: () => [{}],
      getBoundingClientRect: () => progressiveNavigatorWide || progressiveSegments.filter(segment => segment.classList.contains("unit-name-hidden")).length >= 2
        ? { top: 5, height: 30 }
        : { top: 50, height: 20 }
    }
  ];
  const fitStatuteNavigation = extractedFunction(fallbackSource, "fitStatuteNavigation", "setStatuteNavigationVisible", {
    els: { statuteNavigator: { hidden: false }, statuteNavigatorInner: progressiveInner },
    $$: () => progressiveSegments,
    Math
  });
  assert.strictEqual(fitStatuteNavigation(), 2, "The navigator did not stop hiding unit names as soon as one row fit.");
  assert(progressiveInner.classList.contains("intro-hidden"), "The non-unit navigator intro was not removed before unit names.");
  assert(progressiveSegments[4].classList.contains("unit-name-hidden") && progressiveSegments[3].classList.contains("unit-name-hidden"), "The two smallest unit names were not hidden first.");
  assert(!progressiveSegments[2].classList.contains("unit-name-hidden"), "A larger unit name was hidden after the navigator already fit.");
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
  const findKnownPrefix = extractedFunction(fallbackSource, "findKnownPrefix", "componentTokens", { String });
  const componentTokensForParser = extractedFunction(fallbackSource, "componentTokens", "childEntries", { String });
  const childEntriesForParser = extractedFunction(fallbackSource, "childEntries", "resolveComponents", { normCitationPart: statutoryNormPart });
  const resolveComponentsForParser = extractedFunction(fallbackSource, "resolveComponents", "resolveKnownCitationPath", { componentTokens: componentTokensForParser, normCitationPart: statutoryNormPart });
  const resolveKnownCitationPathForParser = extractedFunction(fallbackSource, "resolveKnownCitationPath", "nearestStructuralPath", { knownInaCitationPaths: compactKnownInaPaths, knownUscCitationPaths: compactKnownUscPaths, componentTokens: componentTokensForParser, citationPathKey: (section, pathParts) => `${statutoryNormPart(section)}:${pathParts.map(statutoryNormPart).join("/")}`, normCitationPart: statutoryNormPart });
  const section1185ForStartup = hydratedSource.title8.sections.find(section => String(section.section) === "1185");
  const parseLocalStatute = extractedFunction(fallbackSource, "parseLocalStatute", "parseFallbackStatute", {
    corpus: hydratedSource,
    hasLocalUscCache: true,
    inaMap: new Map([["101", { inaSection: "101", uscSection: "1101", hasEquivalent: true }], ["203", { inaSection: "203", uscSection: "1153", hasEquivalent: true }], ["215", { inaSection: "215", uscSection: "1185", hasEquivalent: true }]]),
    sectionMap: new Map([["1101", section1101ForCompactPaths], ["1153", section1153ForCompactPaths], ["1185", section1185ForStartup]]),
    uscToIna: new Map([["1101", { inaSection: "101", uscSection: "1101", hasEquivalent: true }], ["1153", { inaSection: "203", uscSection: "1153", hasEquivalent: true }], ["1185", { inaSection: "215", uscSection: "1185", hasEquivalent: true }]]),
    findKnownPrefix,
    resolveIndexedCompactStatutePath: compactPathApi.resolveIndexedCompactStatutePath,
    resolveComponents: resolveComponentsForParser,
    resolveKnownCitationPath: resolveKnownCitationPathForParser,
    canonicalPath: statutoryCanonicalPath,
    normCitationPart: statutoryNormPart,
    parseFallbackStatute: () => { throw new Error("Local citation unexpectedly used fallback parsing."); }
  });
  const parsedCompactH1b = plain(parseLocalStatute("ina", "101a15hib"));
  assert(parsedCompactH1b.valid && parsedCompactH1b.label === "INA 101(a)(15)(H)(i)(b)", "The complete compact H-1B citation does not survive the local parser.");
  const parsedDefaultStartup = plain(parseLocalStatute("ina", "203b1a"));
  assert(parsedDefaultStartup.valid && parsedDefaultStartup.label === "INA 203(b)(1)(A)" && JSON.stringify(parsedDefaultStartup.path) === JSON.stringify(["b", "1", "A"]), "The parenthesis-free INA 203b1a startup text does not resolve to INA 203(b)(1)(A).");
  const parsedRomanAmbiguity = plain(parseLocalStatute("ina", "101a15oiii"));
  assert(parsedRomanAmbiguity.valid && parsedRomanAmbiguity.ambiguity.options.length === 2, "The local parser did not retain valid ambiguity choices.");
  assert.deepStrictEqual(parsedRomanAmbiguity.renderPath, ["a", "15", "O", "iii"], "The parser still truncates a selected compact path before navigation.");
  const parseCitationForImpliedUsc = extractedFunction(fallbackSource, "parseCitation", "pathStartsWith", {
    parseCfr: () => ({ type: "cfr" }),
    parseLocalStatute: (kind, raw) => ({ type: kind, recognized: true, valid: true, label: `8 U.S.C. ${raw}`, raw }),
    parseAct: () => null
  });
  const impliedCompactUsc = plain(parseCitationForImpliedUsc("usc1101(a)(15)(H)"));
  assert.strictEqual(impliedCompactUsc.raw, "1101(a)(15)(H)", "A compact titleless U.S.C. citation was not parsed as Title 8.");
  assert.strictEqual(impliedCompactUsc.impliedUscTitle, 8, "A titleless U.S.C. citation does not retain its Title 8 assumption for display.");
  const impliedPunctuatedUsc = plain(parseCitationForImpliedUsc("U.S.C. § 1153(b)"));
  assert.strictEqual(impliedPunctuatedUsc.raw, "1153(b)", "A punctuated titleless U.S.C. citation was not parsed as Title 8.");
  assert.strictEqual(parseCitationForImpliedUsc("USCIS Glossary"), null, "The Title 8 fallback incorrectly captures text beginning with USCIS.");
  assert.strictEqual(parseCitationForImpliedUsc("8 USC 1101").impliedUscTitle, undefined, "An explicit Title 8 citation was incorrectly marked as assumed.");
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
  const citationCrosswalk = extractedFunction(fallbackSource, "citationCrosswalk", "inaCitationsFromText", {
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
  const houseFootnoteReferenceHtml = extractedFunction(fallbackSource, "houseFootnoteReferenceHtml", "linkifyStatutoryText", { escapeHtml: escapeStatutoryHtml, String });
  const legalReferenceCitation = extractedFunction(fallbackSource, "legalReferenceCitation", "legalReferenceHtml", { canonicalPath: statutoryCanonicalPath, String });
  const legalReferenceHtml = extractedFunction(fallbackSource, "legalReferenceHtml", "legalReferenceContextForElement", { escapeHtml: escapeStatutoryHtml, legalReferenceCitation, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, JSON, String });
  const linkifyStatutoryText = extractedFunction(fallbackSource, "linkifyStatutoryText", "indexedStatutePathExists", { escapeHtml: escapeStatutoryHtml, renderSearchHighlightedText, houseFootnoteReferenceHtml, legalReferenceHtml, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, Math, Number, String });
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
      referenceCitation: "8 U.S.C. 1184(i)(1)"
    },
    textContent: hydrated1184Reference.text
  });
  assert(reference1184Preview.text.startsWith("(1) Except as provided in paragraph (3)"), "A locally resolved House link still produces an empty offline preview.");
  const testComponentTokens = value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  const testUscToIna = new Map([["1101", { inaSection: "101", uscSection: "1101" }]]);
  const indexedStatutePathExists = extractedFunction(fallbackSource, "indexedStatutePathExists", "resolvedRunInStatutePath", { corpus: hydratedSource, uscToIna: testUscToIna, normCitationPart: statutoryNormPart, compactStatutePathIndex: compactPathApi.compactStatutePathIndex });
  const resolvedRunInStatutePath = extractedFunction(fallbackSource, "resolvedRunInStatutePath", "formatStatutoryRunInText", { indexedStatutePathExists });
  const formatStatutoryRunInText = extractedFunction(fallbackSource, "formatStatutoryRunInText", "renderHouseEditorialFootnotes", { escapeHtml: escapeStatutoryHtml, linkifyStatutoryText, legalUnitTriggerHtml, componentTokens: testComponentTokens, canonicalPath: statutoryCanonicalPath, resolvedRunInStatutePath, normCitationPart: statutoryNormPart, JSON, Set, Number, String });
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

  const statutoryFormattingAudit = { nodes: 0, formattedNodes: 0, runInLines: 0, citationLinks: 0 };
  const auditStatutoryNodes = nodes => {
    for (const node of nodes || []) {
      statutoryFormattingAudit.nodes += 1;
      const output = formatStatutoryRunInText(node.text || "", node.label || "", node.references || []);
      const addresses = [...output.matchAll(/class="inline-address">([^<]+)<\/strong>/g)].map(match => match[1]);
      if (addresses.length) statutoryFormattingAudit.formattedNodes += 1;
      statutoryFormattingAudit.runInLines += addresses.length;
      statutoryFormattingAudit.citationLinks += (output.match(/class="statute-citation-link legal-reference-link/g) || []).length;
      for (const address of addresses) assert(/^(?:\((?:\d{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,4}|([a-z])\1{1,2}|([A-Z])\2)\))+$/.test(address), `Invalid formatted statutory address ${address}.`);
      assert(!output.includes('<span class="statutory-runin-line"><strong class="inline-address"></strong>'), "Formatter emitted an empty statutory address.");
      auditStatutoryNodes(node.children);
    }
  };
  for (const section of hydratedSource.title8.sections) auditStatutoryNodes(section.body);
  assert.strictEqual(statutoryFormattingAudit.nodes, 6973, "The statutory formatting audit did not visit every cached node.");
  assert.strictEqual(statutoryFormattingAudit.formattedNodes, 103, "Unexpected change in the set of cached nodes requiring run-in formatting.");
  assert.strictEqual(statutoryFormattingAudit.runInLines, 261, "Unexpected change in the number of formatted cached run-in provisions.");
  assert.strictEqual(statutoryFormattingAudit.citationLinks, 1765, "Unexpected generated-link count in operative statutory text.");
  let ancillaryCitationLinks = 0;
  for (const section of hydratedSource.title8.sections) {
    ancillaryCitationLinks += (linkifyStatutoryText(section.preamble || "", section.preambleReferences || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    ancillaryCitationLinks += (linkifyStatutoryText(section.sourceCredit || "", section.sourceCreditReferences || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    for (const note of section.notes || []) ancillaryCitationLinks += (linkifyStatutoryText(note.text || "", note.references || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
    for (const footnote of section.houseEditorialFootnotes || []) ancillaryCitationLinks += (linkifyStatutoryText(footnote.text || "", footnote.references || []).match(/class="statute-citation-link legal-reference-link/g) || []).length;
  }
  assert.strictEqual(statutoryFormattingAudit.citationLinks + ancillaryCitationLinks, 15933, "Unexpected total generated-link count in displayed cached statutory material.");

  const parseAssignedProfile = extractedFunction(fallbackSource, "assignedJsonObjectFromText", "validateStandaloneSource");
  const migration = profileMigrationFunctions(fallbackSource);
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
    "Old three-file HTML did not explain where its progress is stored."
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
  assert.strictEqual(Object.hasOwn(comprehensive.imported, "unlocks"), false, "Obsolete source-identification unlocks were retained.");
  assert.strictEqual(comprehensive.imported.visaSummaryUnlocks.length, 2);
  assert.strictEqual(comprehensive.imported.visaFactUnlocks.length, 2);
  assert.deepStrictEqual(comprehensive.imported.visaChallengeLockouts.map(record => record.visaId), ["visa-a-1"], "Expired summary lockout was not removed.");
  assert.deepStrictEqual(comprehensive.imported.visaFactChallengeLockouts.map(record => record.factId), ["visa-a-1:visa-row-001:cos"], "Expired fact lockout was not removed.");
  assert.deepStrictEqual(comprehensive.imported.resourceChallengeLockouts, [], "A legacy profile without resource lockouts did not receive the new collection.");
  assert.strictEqual(comprehensive.imported.notes.length, 4);
  assert.deepStrictEqual(comprehensive.imported.notes.map(note => note.coursePlacement), [
    { kind: "day", week: 2, day: 4 },
    { kind: "module", blockId: "block-2", moduleId: "module-3" },
    { kind: "classification", visaId: "visa-h-1b" },
    { kind: "uncategorized" }
  ]);
  assert.strictEqual(comprehensive.imported.notes[2].body, "Classification note with parser-like text: }; and </script>, ampersand & Unicode — café 🚀.");
  assert.strictEqual(comprehensive.imported.notes[0].links.length, 2);
  assert.strictEqual(comprehensive.imported.courseStructure.blocks.length, 2);
  assert.strictEqual(comprehensive.imported.courseStructure.blocks[1].modules[0].title, "Synthetic Module Three");
  assert.deepStrictEqual(comprehensive.imported.preferences, comprehensive.assigned.preferences);

  const visaById = new Map(fullSource.visaCategories.map(visa => [visa.id, visa]));
  const factById = new Map(fullSource.visaCategories.flatMap(visa => (visa.variants || []).flatMap(variant => variant.facts || [])).map(fact => [fact.id, fact]));
  for (const record of comprehensive.imported.visaSummaryUnlocks) {
    assert(visaById.has(record.visaId), `Synthetic summary unlock references missing visa ${record.visaId}.`);
    assert.strictEqual(record.challengeRevision, visaById.get(record.visaId).summaryChallenge.revision, `Synthetic summary unlock revision is stale for ${record.visaId}.`);
  }
  for (const record of comprehensive.imported.visaFactUnlocks) {
    assert(factById.has(record.factId), `Synthetic fact unlock references missing fact ${record.factId}.`);
    assert.strictEqual(record.challengeRevision, factById.get(record.factId).challenge.revision, `Synthetic fact unlock revision is stale for ${record.factId}.`);
  }
  const embeddedComprehensive = replaceProfileOnly(full.html, comprehensive.imported);
  assert.deepStrictEqual(jsonBlock(embeddedComprehensive, "inaSearchProfileData"), comprehensive.imported, "Imported legacy data did not survive embedding in the standalone HTML.");
  const comprehensiveReload = await runBootstrap({ ...full, html: embeddedComprehensive, profile: comprehensive.imported });
  assert.deepStrictEqual(plain(comprehensiveReload.profile), comprehensive.imported, "Imported legacy data did not reload from a standalone INASearch file.");
  assert.strictEqual(comprehensiveReload.errors.profile, false);
  assert.deepStrictEqual(plain(parseImportedProfile(JSON.stringify(comprehensive.assigned))), comprehensive.imported, "Comprehensive JSON backup path differs from legacy JS import path.");

  const minimal = importFixture("legacy-minimal-profile.js");
  assert.deepStrictEqual(minimal.imported.visaSummaryUnlocks, []);
  assert.deepStrictEqual(minimal.imported.visaChallengeLockouts, []);
  assert.deepStrictEqual(minimal.imported.visaFactUnlocks, []);
  assert.deepStrictEqual(minimal.imported.visaFactChallengeLockouts, []);
  assert.deepStrictEqual(minimal.imported.resourceChallengeLockouts, []);
  assert.deepStrictEqual(minimal.imported.courseStructure, { blocks: [] });
  assert.deepStrictEqual(minimal.imported.notes[0].coursePlacement, { kind: "uncategorized" });
  assert.strictEqual(minimal.imported.preferences.quizCursorKey, null);
  assert.strictEqual(minimal.imported.preferences.quizClassification, "all");
  assert.strictEqual(minimal.imported.notes[0].body, "Preserve this text.");
  const embeddedMinimal = replaceProfileOnly(allUnlocked.html, minimal.imported);
  const minimalReload = await runBootstrap({ ...allUnlocked, html: embeddedMinimal, profile: minimal.imported });
  assert.deepStrictEqual(plain(minimalReload.profile), minimal.imported, "Minimal legacy data did not reload from a standalone INASearch file.");
  assert.strictEqual(minimalReload.errors.profile, false);

  const normalized = importFixture("legacy-normalization-profile.js").imported;
  const normalizedResourceLockouts = plain(migration.normalizeProfile({
    ...blankProfile,
    resourceChallengeLockouts: [
      { questionId: "resource-active", revision: "1", lockedUntil: "2099-01-01T00:00:00.000Z" },
      { questionId: "resource-expired", revision: "1", lockedUntil: "2000-01-01T00:00:00.000Z" }
    ]
  }));
  assert.deepStrictEqual(normalizedResourceLockouts.resourceChallengeLockouts.map(record => record.questionId), ["resource-active"], "Expired resource-question lockout was not removed during profile normalization.");
  assert.deepStrictEqual(normalized.notes.map(note => note.coursePlacement), [
    { kind: "day", week: 6, day: 5 },
    { kind: "classification", visaId: "visa-f-1" },
    { kind: "uncategorized" }
  ]);
  assert.deepStrictEqual(normalized.courseStructure.blocks.map(block => ({ id: block.id, number: block.number, title: block.title })), [
    { id: "duplicate-id", number: 2, title: "Trimmed Block" },
    { id: "block-2-2", number: 2, title: "" }
  ]);
  assert.deepStrictEqual(normalized.courseStructure.blocks[0].modules, [
    { id: "duplicate-module", number: 3, title: "Trimmed Module" },
    { id: "module-2-2", number: 2, title: "" }
  ]);
  assert.throws(() => parseImportedProfile('window.AUTHORITY_SEARCH_PROFILE = {"schemaVersion":2,"notes":[],"preferences":{}};'), /valid INASearch profile/, "Unsupported legacy profile schema was accepted.");
  assert.throws(() => parseImportedProfile('window.INA_SEARCH_PROFILE = {"schemaVersion":1,"notes":"not-an-array","preferences":{}};'), /valid INASearch profile/, "Malformed current notes collection was accepted.");

  console.log(`PASS INASearch.html: ${full.bytes} bytes; ${full.manifest.compressedBytes} gzip bytes`);
  console.log(`PASS INASearch-AU.html: ${allUnlocked.bytes} bytes; ${allUnlocked.manifest.compressedBytes} gzip bytes`);
  console.log(`PASS INASearch-Uncompressed.html: ${uncompressed.bytes} bytes; ${uncompressed.manifest.uncompressedBytes} plain JSON corpus bytes`);
  console.log(`PASS INASearch-AU-Uncompressed.html: ${allUnlockedUncompressed.bytes} bytes; ${allUnlockedUncompressed.manifest.uncompressedBytes} plain JSON corpus bytes`);
  console.log(`PASS statutory formatting audit: ${statutoryFormattingAudit.nodes} nodes; ${statutoryFormattingAudit.formattedNodes} nodes with ${statutoryFormattingAudit.runInLines} run-in lines; ${statutoryFormattingAudit.citationLinks} generated citation links`);
  console.log(`PASS definitions audit: ${full.corpus.definitions.entries.length} source records; 267 USCIS Glossary entries; 199 INA term entries from 170 definition statements; 32 exact 8 CFR 1.2 entries`);
  console.log(`PASS CFR audit: ${full.corpus.cfr.coverage.partCount} active parts; ${full.corpus.cfr.sections.length} sections; ${full.corpus.cfr.appendices.length} appendices; ${full.corpus.cfr.graphics.length} referenced graphics; 1 removed-part tombstone`);
  console.log("PASS round trips, hashes, PTAR boundary/intersection, nested CFR citations, exact visible-match targeting, regulation history, syntax, native loaders, corruption handling, deterministic gzip and plain JSON, profile isolation, comprehensive legacy profile migration, statutory formatting, saving-menu state rules, and ordinary gzip extraction");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
