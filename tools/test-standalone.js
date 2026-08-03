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
const { buildDefinitionCatalog } = require("./definition-catalog");
const { applyStatuteReferences, statuteSourceMap } = require("./statute-references");

const root = path.resolve(__dirname, "..");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sourceCorpus() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Corpus.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Visa-Tables.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Form-Questions.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Definitions.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Statute-References.js"), "utf8"), sandbox);
  const corpus = JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_CORPUS));
  corpus.visaTables = JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_VISA_TABLES));
  corpus.visaTables.formQuestions = JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_FORM_QUESTIONS));
  const definitions = JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_DEFINITIONS));
  const statuteReferences = JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_STATUTE_REFERENCES));
  applyStatuteReferences(corpus, statuteReferences);
  corpus.definitions = buildDefinitionCatalog(corpus, definitions);
  return corpus;
}

function sourceProfile() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Profile.js"), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_PROFILE));
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
  return scriptBody(html, "authoritySearchCorpusData").replace(/\s+/g, "");
}

function metadataOnlyTitle8(title8) {
  return {
    title: title8.title,
    name: title8.name,
    publication: title8.publication,
    currentThrough: title8.currentThrough,
    sourceCreatedAt: title8.sourceCreatedAt,
    isPositiveLaw: title8.isPositiveLaw,
    sourceUrl: title8.sourceUrl,
    sections: (title8.sections || []).map(section => ({
      id: section.id,
      section: section.section,
      heading: section.heading,
      status: section.status,
      identifier: section.identifier,
      breadcrumb: section.breadcrumb,
      url: section.url
    }))
  };
}

function readBuild(fileName) {
  const filePath = path.join(root, fileName);
  const html = fs.readFileSync(filePath, "utf8");
  const manifest = jsonBlock(html, "authoritySearchCorpusManifest");
  const compressed = Buffer.from(payloadBlock(html), "base64");
  const uncompressed = zlib.gunzipSync(compressed);
  assert.strictEqual(compressed.byteLength, manifest.compressedBytes, `${fileName}: compressed byte count`);
  assert.strictEqual(uncompressed.byteLength, manifest.uncompressedBytes, `${fileName}: uncompressed byte count`);
  assert.strictEqual(sha256(compressed), manifest.compressedSha256, `${fileName}: compressed SHA-256`);
  assert.strictEqual(sha256(uncompressed), manifest.uncompressedSha256, `${fileName}: uncompressed SHA-256`);
  return {
    fileName,
    filePath,
    html,
    bytes: Buffer.byteLength(html),
    build: jsonBlock(html, "authoritySearchBuildData"),
    profile: jsonBlock(html, "authoritySearchProfileData"),
    manifest,
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
  const manifestAttributes = {
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
  };
  const embeddedElement = (value, attributes = {}) => {
    const element = overrides.scriptTextOnly
      ? { text: value, textContent: "", innerHTML: "" }
      : { text: value, textContent: value, innerHTML: value };
    element.getAttribute = name => Object.hasOwn(attributes, name.replace(/^data-/, "")) ? attributes[name.replace(/^data-/, "")] : null;
    return element;
  };
  const elements = {
    authoritySearchBuildData: embeddedElement(JSON.stringify(build.build)),
    authoritySearchCorpusManifest: embeddedElement(overrides.manifestTextUnreadable ? "" : JSON.stringify(overrides.manifest || build.manifest)),
    authoritySearchCorpusData: embeddedElement(overrides.payload || payloadBlock(build.html), manifestAttributes),
    authoritySearchProfileData: embeddedElement(JSON.stringify(build.profile))
  };
  const context = {
    window: {},
    document: { getElementById: id => elements[id] },
    DecompressionStream: overrides.missingDecompressionStream ? undefined : globalThis.DecompressionStream,
    Blob: globalThis.Blob,
    Response: globalThis.Response,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array,
    atob: globalThis.atob,
    crypto: globalThis.crypto
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(scripts[0], { filename: `${build.fileName}:bootstrap` }).runInContext(context);
  const corpus = await context.AUTHORITY_SEARCH_CORPUS_READY;
  return { corpus, profile: context.AUTHORITY_SEARCH_PROFILE, errors: context.AUTHORITY_SEARCH_LOAD_ERRORS };
}

function replaceProfileOnly(html, profile) {
  const start = "<!-- AUTHORITY_SEARCH_PROFILE_DATA_START -->";
  const end = "<!-- AUTHORITY_SEARCH_PROFILE_DATA_END -->";
  const safe = JSON.stringify(profile, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return html.replace(
    new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n  <script id="authoritySearchProfileData" type="application/json">${safe}</script>\n  ${end}`
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

async function main() {
  const fullSource = sourceCorpus();
  const blankProfile = sourceProfile();
  const full = readBuild("AuthoritySearch.html");
  const light = readBuild("AuthoritySearch-no-USC.html");

  assert(full.bytes <= 2_500_000, "AuthoritySearch.html exceeds 2.5 MB acceptance limit.");
  assert(light.bytes <= 1_000_000, "AuthoritySearch-no-USC.html exceeds 1 MB acceptance limit.");
  assert.strictEqual(full.build.variant, "standard");
  assert.strictEqual(full.build.hasLocalUscCache, true);
  assert.strictEqual(light.build.variant, "no-usc");
  assert.strictEqual(light.build.hasLocalUscCache, false);
  assert.deepStrictEqual(full.profile, blankProfile);
  assert.deepStrictEqual(light.profile, blankProfile);
  assert.deepStrictEqual(full.corpus, fullSource, "Full corpus round trip changed data.");

  const expectedLight = JSON.parse(JSON.stringify(fullSource));
  expectedLight.title8 = metadataOnlyTitle8(fullSource.title8);
  assert.deepStrictEqual(light.corpus, expectedLight, "No-USC corpus round trip changed metadata.");
  assert.strictEqual(full.corpus.title8.sections.length, 376);
  assert.strictEqual(light.corpus.title8.sections.length, 376);
  assert(full.corpus.title8.sections.some(section => Array.isArray(section.body)), "Full corpus has no cached Title 8 bodies.");
  assert(!light.corpus.title8.sections.some(section => Object.hasOwn(section, "body")), "No-USC corpus contains a Title 8 body.");
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
  const allFormQuestions = [...formQuestions.nonimmigrant, ...formQuestions.immigrant];
  assert.strictEqual(new Set(allFormQuestions.map(question => question.id)).size, allFormQuestions.length, "Form-question IDs must be unique.");
  for (const kind of ["nonimmigrant", "immigrant"]) {
    const validSymbols = new Set(full.corpus.visaTables[`${kind}Types`].map(record => record.symbol));
    for (const question of formQuestions[kind]) {
      assert(question.correctSymbols.length, `${question.id}: form question has no correct statuses.`);
      assert(question.correctSymbols.every(symbol => validSymbols.has(symbol)), `${question.id}: form question references an unknown status.`);
      assert(question.form === null || question.prompt.includes("{form}"), `${question.id}: linked form is not present in the prompt.`);
      assert(question.source?.label && question.source?.url, `${question.id}: missing specifically named source link.`);
    }
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
  assert(full.html.includes('class="resource-status-choices"'), "Form questions should render selectable status sets.");
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
  assert.strictEqual(full.corpus.title8.referenceMetadata.localReferences, 3587, "Unexpected local statutory-reference count.");
  assert.strictEqual(full.corpus.title8.referenceMetadata.sourcesWithReferences, 2089, "Unexpected count of statutory text records with local references.");
  assert.strictEqual(full.corpus.title8.referenceMetadata.nodesWithReferences, 981, "Unexpected count of statutory nodes with local references.");
  assert.strictEqual(full.corpus.title8.referenceMetadata.notesWithReferences, 1083, "Unexpected count of statutory notes with local references.");
  assert.strictEqual(full.corpus.title8.referenceMetadata.preamblesWithReferences, 25, "Unexpected count of statutory preambles with local references.");
  const referencedSources = statuteSourceMap(full.corpus);
  let verifiedStatutoryReferences = 0;
  for (const [key, source] of referencedSources) {
    const sourceText = key.endsWith(":source-credit") ? source.sourceCredit : key.endsWith(":preamble") ? source.preamble : source.text;
    const references = key.endsWith(":source-credit") ? source.sourceCreditReferences : key.endsWith(":preamble") ? source.preambleReferences : source.references;
    for (const reference of references || []) {
      assert.strictEqual(String(sourceText || "").slice(reference.start, reference.end), reference.text, `${key}: statutory reference offsets no longer match the displayed text.`);
      assert(full.corpus.title8.sections.some(section => String(section.section) === String(reference.targetSection)), `${key}: statutory reference points outside the local Title 8 corpus.`);
      verifiedStatutoryReferences++;
    }
  }
  assert.strictEqual(verifiedStatutoryReferences, 3587, "Not every generated statutory reference was attached to a displayed cached text record.");
  assert.strictEqual(full.corpus.definitions.entries.length, 93, "Unexpected definition record count.");
  assert.strictEqual(full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "ina").length, 61, "Unexpected INA 101 definition count.");
  assert.strictEqual(full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "cfr").length, 32, "Unexpected 8 CFR 1.2 definition count.");
  assert.deepStrictEqual(light.corpus.definitions, full.corpus.definitions, "No-USC build lost or altered the independent definitions catalog.");

  const definitionScopes = new Map(full.corpus.definitions.scopes.map(scope => [scope.id, scope]));
  assert.strictEqual(definitionScopes.get("ina-chapter")?.label, "Entire INA", "The chapter-wide INA definition scope is not plainly labeled.");
  assert(!full.corpus.definitions.scopes.some(scope => scope.label === "INA generally"), "The ambiguous INA generally label remains in the definition scopes.");
  for (const entry of full.corpus.definitions.entries) {
    assert(entry.id && entry.term && entry.text && entry.locator && entry.url && entry.captureDate, `Incomplete definition provenance for ${entry.id || entry.term}.`);
    assert(Array.isArray(entry.aliases) && entry.aliases.length > 0, `Definition ${entry.id} has no searchable term aliases.`);
    assert(definitionScopes.has(entry.scopeId), `Definition ${entry.id} has an unknown applicability scope.`);
    assert(/^https:\/\/(?:uscode\.house\.gov|www\.ecfr\.gov)\//.test(entry.url), `Definition ${entry.id} uses an unapproved source URL.`);
    if (entry.specificScope) assert(entry.text.includes(entry.specificScope), `Definition ${entry.id} has scope text that is not quoted from its source.`);
  }
  const definitionsFor = term => full.corpus.definitions.entries.filter(entry => entry.aliases.some(alias => alias.toLowerCase() === term.toLowerCase()));
  assert.deepStrictEqual(definitionsFor("child").map(entry => entry.citation), ["INA 101(b)(1)", "INA 101(c)(1)"], "The two statutory definitions of child were not retained separately.");
  assert.deepStrictEqual(definitionsFor("aggravated felony").map(entry => entry.citation), ["INA 101(a)(43)", "8 CFR 1.2"], "Statutory and regulatory aggravated-felony definitions were not retained separately.");
  assert.deepStrictEqual(definitionsFor("lawfully admitted for permanent residence").map(entry => entry.citation), ["INA 101(a)(20)", "8 CFR 1.2"], "Duplicate LPR definitions were not retained separately.");
  assert.strictEqual(definitionsFor("ineligible to citizenship").length, 1, "Quoted statutory punctuation leaked into the term index.");

  const inaDefinitions = full.corpus.definitions.entries.filter(entry => entry.sourceFamily === "ina");
  for (const entry of inaDefinitions.filter(entry => entry.citation !== "INA 101(a)(37)")) {
    const node = statutoryNode(fullSource, "1101", entry.path);
    assert.strictEqual(entry.text, node.text, `${entry.citation}: definition text diverges from the cached statute.`);
    assert.deepStrictEqual(entry.children, node.children || [], `${entry.citation}: definition hierarchy diverges from the cached statute.`);
  }
  const totalitarianSource = statutoryNode(fullSource, "1101", ["a", "37"]).text;
  assert.strictEqual(definitionsFor("totalitarian party")[0].text + " " + definitionsFor("totalitarianism")[0].text, totalitarianSource, "INA 101(a)(37) split definitions do not reconstruct the source text.");
  assert.strictEqual(definitionScopes.get("ina-chapter").text, statutoryNode(fullSource, "1101", ["a"]).text);
  assert.strictEqual(definitionScopes.get("ina-subchapters-i-ii").text, statutoryNode(fullSource, "1101", ["b"]).text);
  assert.strictEqual(definitionScopes.get("ina-subchapter-iii").text, statutoryNode(fullSource, "1101", ["c"]).text);

  for (const build of [full, light]) {
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
    assert(elapsed < 1000, `${build.fileName}: bootstrap decompression took ${elapsed.toFixed(0)} ms.`);

    const safariScriptText = await runBootstrap(build, { scriptTextOnly: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(safariScriptText.corpus)), build.corpus, `${build.fileName}: script-text fallback changed data.`);
    assert.strictEqual(safariScriptText.errors.corpus, false);

    const attributeManifestFallback = await runBootstrap(build, { manifestTextUnreadable: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(attributeManifestFallback.corpus)), build.corpus, `${build.fileName}: manifest-attribute fallback changed data.`);
    assert.strictEqual(attributeManifestFallback.errors.corpus, false);

    const unsupported = await runBootstrap(build, { missingDecompressionStream: true });
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

    const corpusBlockBefore = build.html.match(/<!-- AUTHORITY_SEARCH_CORPUS_DATA_START -->[\s\S]*?<!-- AUTHORITY_SEARCH_CORPUS_DATA_END -->/)[0];
    const manifestBlockBefore = build.html.match(/<!-- AUTHORITY_SEARCH_CORPUS_MANIFEST_DATA_START -->[\s\S]*?<!-- AUTHORITY_SEARCH_CORPUS_MANIFEST_DATA_END -->/)[0];
    const edited = JSON.parse(JSON.stringify(build.profile));
    edited.notes = [{ id: "test", title: "", body: "Corpus safety </script> \u2028 test", tags: [], links: [] }];
    const rewritten = replaceProfileOnly(build.html, edited);
    assert.strictEqual(rewritten.match(/<!-- AUTHORITY_SEARCH_CORPUS_DATA_START -->[\s\S]*?<!-- AUTHORITY_SEARCH_CORPUS_DATA_END -->/)[0], corpusBlockBefore);
    assert.strictEqual(rewritten.match(/<!-- AUTHORITY_SEARCH_CORPUS_MANIFEST_DATA_START -->[\s\S]*?<!-- AUTHORITY_SEARCH_CORPUS_MANIFEST_DATA_END -->/)[0], manifestBlockBefore);
    assert.strictEqual(jsonBlock(rewritten, "authoritySearchProfileData").notes[0].body, edited.notes[0].body);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "authority-search-audit-"));
    const gzipPath = path.join(temp, "AuthoritySearch-Corpus.json.gz");
    fs.writeFileSync(gzipPath, build.compressed);
    const ordinaryGzip = spawnSync("/usr/bin/gzip", ["-dc", gzipPath], { encoding: null, maxBuffer: 20_000_000 });
    assert.strictEqual(ordinaryGzip.status, 0, ordinaryGzip.stderr?.toString());
    assert.strictEqual(sha256(ordinaryGzip.stdout), build.manifest.uncompressedSha256);
  }

  const fullPayload = payloadBlock(full.html);
  const lightPayload = payloadBlock(light.html);
  const rebuild = spawnSync(process.execPath, [path.join(root, "tools", "build-standalone.js")], { cwd: root, encoding: "utf8" });
  assert.strictEqual(rebuild.status, 0, rebuild.stderr);
  assert.strictEqual(payloadBlock(fs.readFileSync(full.filePath, "utf8")), fullPayload, "Full gzip output is not deterministic.");
  assert.strictEqual(payloadBlock(fs.readFileSync(light.filePath, "utf8")), lightPayload, "No-USC gzip output is not deterministic.");

  const fallbackSource = fs.readFileSync(path.join(root, "src", "AuthoritySearch.template.html"), "utf8");
  assert(fallbackSource.includes("const studyUnavailable = active || !corpus;"));
  assert(fallbackSource.includes("Official navigation is available"));
  assert(fallbackSource.includes("https://www.ecfr.gov/current/title-"));
  assert(fallbackSource.includes("state.saveTimer = setTimeout(queueProfileWrite, 5000);"));
  assert(fallbackSource.includes('id="savingMenuModal"'));
  assert(fallbackSource.includes('els.profileSetupNotice.hidden = mode !== "unsaved";'));
  assert(fallbackSource.includes('els.saveStatus.disabled = false;'));
  assert(fallbackSource.includes("Import an older AuthoritySearch profile"));
  assert(fallbackSource.includes('id="view-definitions"'));
  assert(fallbackSource.includes('data-view="definitions"'));
  assert(/<nav class="main-nav"[^>]*>\s*<button class="nav-button" data-view="definitions" aria-current="page">Definitions<\/button>/.test(fallbackSource), "Definitions is not the leftmost current primary page.");
  assert(fallbackSource.includes('id="view-definitions" aria-labelledby="definitionsHeading"'), "Definitions is not the default visible view.");
  assert(fallbackSource.includes('id="view-visas" hidden aria-labelledby="visasHeading"'), "Nonimmigrant Types is still the default visible view.");
  assert(!fallbackSource.includes('class="nav-button" data-view="quiz"'), "The classic Quiz remains in the primary navigation.");
  assert(fallbackSource.includes('id="openClassicQuizButton"'), "Sources & About does not link to the classic quiz.");
  assert(fallbackSource.includes('id="statuteNavigator"'), "The live statute hierarchy navigation is missing.");
  assert(fallbackSource.includes('data-statute-path='), "Rendered statutory nodes do not expose their hierarchy paths.");
  assert(fallbackSource.includes('Math.max(0, window.innerHeight - navigatorBottom) * .25'), "The statute reading line is not one quarter of the statute viewport.");
  assert(fallbackSource.includes('nestedInaScope ? "\\u2003\\u2003"'), "Narrow INA scope options are not visually nested under Entire INA.");
  assert(fallbackSource.includes('@keyframes statute-nav-value-flash'), "Changed statute hierarchy values do not flash blue.");
  assert(fallbackSource.includes('previousValues[index] !== segment.value'), "Statute hierarchy changes are not detected by segment value.");
  assert(fallbackSource.includes('.statute-nav-option { display: flex;'), "Statute dropdown rows are not compact single-line layouts.");
  assert(fallbackSource.includes('text-overflow: ellipsis; white-space: nowrap;'), "Statute dropdown descriptions are not constrained to one truncated line.");
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
  const searchNormalize = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const scoreRecord = extractedFunction(fallbackSource, "scoreRecord", "runSearch", {
    normalize: searchNormalize,
    filterMatches: () => true,
    compactLookup: value => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(),
    compactFormLookup: value => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(),
    Math
  });
  const definitionsLandingScore = scoreRecord({ kind: "definition-index", title: "Definitions", cite: "93 source records", text: "definitions defined terms" }, "definitions");
  const statuteDefinitionsScore = scoreRecord({ kind: "usc", title: "Definitions", cite: "8 U.S.C. 1101", text: "8 usc 1101 definitions" }, "definitions");
  assert(definitionsLandingScore > statuteDefinitionsScore, "The Definitions page is not the top result for an exact definitions search.");

  const escapeStatutoryHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const statutoryNormPart = value => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const statutoryCanonicalPath = pathParts => (pathParts || []).map(value => `(${value})`).join("");
  const linkifyStatutoryText = extractedFunction(fallbackSource, "linkifyStatutoryText", "formatStatutoryRunInText", { escapeHtml: escapeStatutoryHtml, canonicalPath: statutoryCanonicalPath, normCitationPart: statutoryNormPart, Math, Number, String });
  const formatStatutoryRunInText = extractedFunction(fallbackSource, "formatStatutoryRunInText", "renderStatutoryNote", { escapeHtml: escapeStatutoryHtml, linkifyStatutoryText, Set, Number, String });
  const statuteScrollCalls = [];
  const statuteReadingLine = extractedFunction(fallbackSource, "statuteReadingLine", "scrollStatuteAnchorToReadingLine", {
    $: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }),
    els: { statuteNavigator: { hidden: false, getBoundingClientRect: () => ({ bottom: 150 }) } },
    window: { innerHeight: 950 },
    Math
  });
  assert.strictEqual(statuteReadingLine(), 350, "The statute reading line does not exclude the sticky bars before taking the top quarter.");
  const scrollStatuteAnchorToReadingLine = extractedFunction(fallbackSource, "scrollStatuteAnchorToReadingLine", "currentStatutePathAtReadingLine", {
    statuteReadingLine: () => 200,
    window: { scrollBy: options => statuteScrollCalls.push(options) }
  });
  scrollStatuteAnchorToReadingLine({ getBoundingClientRect: () => ({ top: 500 }) });
  assert.deepStrictEqual(plain(statuteScrollCalls.pop()), { top: 300, behavior: "smooth" }, "Statute navigation did not align an anchor to the quarter-view reading line.");
  let renderedStatuteTarget = null;
  const sectionAnchor = { id: "section-anchor" };
  const targetAnchor = { id: "target-anchor" };
  const alignedAnchors = [];
  const scrollToRenderedStatuteTarget = extractedFunction(fallbackSource, "scrollToRenderedStatuteTarget", "renderStatutoryNode", {
    $: (selector, root) => selector === ".statutory-node.target" ? renderedStatuteTarget : selector === ".statutory-line" ? targetAnchor : selector === "[data-statute-start]" ? sectionAnchor : null,
    els: { detail: {} },
    scrollStatuteAnchorToReadingLine: anchor => alignedAnchors.push(anchor)
  });
  scrollToRenderedStatuteTarget();
  assert.strictEqual(alignedAnchors.pop(), sectionAnchor, "A section-level citation did not align the top of the newly rendered statute.");
  renderedStatuteTarget = {};
  scrollToRenderedStatuteTarget();
  assert.strictEqual(alignedAnchors.pop(), targetAnchor, "A nested citation did not align its statutory line to the reading line.");
  const visibleStatuteLines = [
    { top: 100, path: ["a"] },
    { top: 240, path: ["a", "15"] },
    { top: 360, path: ["a", "16"] }
  ].map(item => ({ getBoundingClientRect: () => ({ top: item.top }), parentElement: { dataset: { statutePath: JSON.stringify(item.path) } } }));
  const currentStatutePathAtReadingLine = extractedFunction(fallbackSource, "currentStatutePathAtReadingLine", "updateStatuteNavigationFromScroll", {
    els: { statuteNavigator: { hidden: false }, detail: {} },
    state: { statuteNavigationSectionId: "usc-1101" },
    statuteReadingLine: () => 350,
    $$: () => visibleStatuteLines,
    JSON
  });
  assert.deepStrictEqual(plain(currentStatutePathAtReadingLine()), ["a", "15"], "The live hierarchy does not follow the statutory line touching the quarter-view reading line.");

  const statuteNormPart = value => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const statuteNormalize = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const statuteUscToIna = new Map();
  for (const row of fullSource.inaCrosswalk) if (row.uscSection && !statuteUscToIna.has(statuteNormPart(row.uscSection))) statuteUscToIna.set(statuteNormPart(row.uscSection), row);
  const statuteNavigation = statuteNavigationFunctions(fallbackSource, {
    corpus: fullSource,
    uscToIna: statuteUscToIna,
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
  const section1153 = fullSource.title8.sections.find(section => section.section === "1153");
  const ina203Segments = statuteNavigation.statuteNavigationSegments(section1153, ["b", "2", "A"]);
  assert(ina203Segments.some(segment => segment.label === "Part"), "Part navigation is missing where the U.S.C. hierarchy supplies it.");
  assert.deepStrictEqual(plain(statuteNavigation.statuteSiblingNodes(section1101, ["a", "15"]).map(node => node.label)), plain(statuteNavigation.statuteNodeAtPath(section1101, ["a"]).children.map(node => node.label)), "Nested dropdown choices are not derived from the shared parent node.");
  const refugeeNode = statutoryNode(fullSource, "1101", ["a", "42"]);
  const formattedRefugeeDefinition = formatStatutoryRunInText(refugeeNode.text, "42", refugeeNode.references);
  assert.strictEqual((formattedRefugeeDefinition.match(/statutory-runin-line/g) || []).length, 2, "INA 101(a)(42) did not render two run-in subparagraphs.");
  assert(formattedRefugeeDefinition.includes('<strong class="inline-address">(A)</strong>'));
  assert(formattedRefugeeDefinition.includes('<strong class="inline-address">(B)</strong>'));
  assert(formattedRefugeeDefinition.includes("The term “refugee” means</span>"));
  assert(!formattedRefugeeDefinition.includes('<strong class="inline-address">(e)</strong>'), "Citation reference 1157(e) was mistaken for a run-in address.");
  assert(formattedRefugeeDefinition.includes('data-show-citation="8 U.S.C. 1157(e)"'), "The citation inside INA 101(a)(42) is not linked locally.");

  const administratorNode = statutoryNode(fullSource, "1101", ["a", "1"]);
  const formattedAdministrator = formatStatutoryRunInText(administratorNode.text, "1", administratorNode.references);
  assert(formattedAdministrator.includes('data-show-citation="8 U.S.C. 1104(b)"'), "8 U.S.C. 1101(a)(1) did not link its official section 1104(b) reference.");
  const aggravatedFelonyF = statutoryNode(fullSource, "1101", ["a", "43", "F"]);
  const formattedAggravatedFelonyF = formatStatutoryRunInText(aggravatedFelonyF.text, "F", aggravatedFelonyF.references);
  assert(!formattedAggravatedFelonyF.includes("statute-citation-link"), "A cross-title citation was incorrectly linked as though it existed in local Title 8.");
  const section1155 = fullSource.title8.sections.find(section => section.section === "1155");
  assert(linkifyStatutoryText(section1155.preamble, section1155.preambleReferences).includes('data-show-citation="8 U.S.C. 1154"'), "A local citation in a section preamble was not linked.");
  const section1812ReferencesNote = fullSource.title8.sections.find(section => section.section === "1812").notes.find(note => note.topic === "referencesInText");
  const formatted1812ReferencesNote = linkifyStatutoryText(section1812ReferencesNote.text, section1812ReferencesNote.references);
  assert.strictEqual((formatted1812ReferencesNote.match(/class="statute-citation-link"/g) || []).length, 2, "Local citations in a statutory note were not linked.");

  const formattedHDefinition = formatStatutoryRunInText(statutoryNode(fullSource, "1101", ["a", "15", "H"]).text, "H");
  assert(formattedHDefinition.includes('<strong class="inline-address">(i)(a)</strong>'));
  assert(formattedHDefinition.includes('<strong class="inline-address">(ii)(a)</strong>'));
  assert.strictEqual((formatStatutoryRunInText(statutoryNode(fullSource, "1104", ["a"]).text, "a").match(/statutory-runin-line/g) || []).length, 3, "Numeric run-in paragraphs were not formatted.");
  assert.strictEqual((formatStatutoryRunInText(statutoryNode(fullSource, "1430", ["b"]).text, "b").match(/statutory-runin-line/g) || []).length, 6, "Nested numeric and letter run-ins were not formatted.");
  assert(formatStatutoryRunInText(statutoryNode(fullSource, "1182", ["j", "2", "B", "ii", "I"]).text, "I").includes('<strong class="inline-address">(II)</strong>'), "A run-in sibling retained inside the prior node was not formatted.");

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
    const node = statutoryNode(fullSource, section, pathParts);
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
      statutoryFormattingAudit.citationLinks += (output.match(/class="statute-citation-link"/g) || []).length;
      for (const address of addresses) assert(/^(?:\((?:\d{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,4}|([a-z])\1{1,2}|([A-Z])\2)\))+$/.test(address), `Invalid formatted statutory address ${address}.`);
      assert(!output.includes('<span class="statutory-runin-line"><strong class="inline-address"></strong>'), "Formatter emitted an empty statutory address.");
      auditStatutoryNodes(node.children);
    }
  };
  for (const section of fullSource.title8.sections) auditStatutoryNodes(section.body);
  assert.strictEqual(statutoryFormattingAudit.nodes, 6973, "The statutory formatting audit did not visit every cached node.");
  assert.strictEqual(statutoryFormattingAudit.formattedNodes, 103, "Unexpected change in the set of cached nodes requiring run-in formatting.");
  assert.strictEqual(statutoryFormattingAudit.runInLines, 261, "Unexpected change in the number of formatted cached run-in provisions.");
  assert.strictEqual(statutoryFormattingAudit.citationLinks, 1289, "Not every verified House Title 8 operative-text citation rendered as a local link.");
  let ancillaryCitationLinks = 0;
  for (const section of fullSource.title8.sections) {
    ancillaryCitationLinks += (linkifyStatutoryText(section.preamble || "", section.preambleReferences || []).match(/class="statute-citation-link"/g) || []).length;
    ancillaryCitationLinks += (linkifyStatutoryText(section.sourceCredit || "", section.sourceCreditReferences || []).match(/class="statute-citation-link"/g) || []).length;
    for (const note of section.notes || []) ancillaryCitationLinks += (linkifyStatutoryText(note.text || "", note.references || []).match(/class="statute-citation-link"/g) || []).length;
  }
  assert.strictEqual(statutoryFormattingAudit.citationLinks + ancillaryCitationLinks, 3587, "Not every verified House Title 8 citation in displayed cached text rendered as a local link.");

  const parseAssignedProfile = extractedFunction(fallbackSource, "assignedJsonObjectFromText", "validateStandaloneSource");
  const migration = profileMigrationFunctions(fallbackSource);
  const legacyProfile = JSON.parse(JSON.stringify(blankProfile));
  legacyProfile.notes = [{ id: "old-note", title: "Old", body: "Text containing }; inside a string", tags: [], links: [] }];
  const legacyJs = `/* Old three-file profile */\nwindow.AUTHORITY_SEARCH_PROFILE = ${JSON.stringify(legacyProfile, null, 2)};`;
  assert.deepStrictEqual(parseAssignedProfile(legacyJs, "AUTHORITY_SEARCH_PROFILE"), legacyProfile, "Old three-file profile JS was not parsed.");
  const legacyHtml = `<script>window.AUTHORITY_SEARCH_PROFILE = ${JSON.stringify(legacyProfile)}; window.afterProfile = true;</script>`;
  assert.deepStrictEqual(parseAssignedProfile(legacyHtml, "AUTHORITY_SEARCH_PROFILE"), legacyProfile, "Older inline standalone profile was not parsed.");
  const parseImportedProfile = extractedFunction(fallbackSource, "profileFromImportedText", "importProfileFile", {
    embeddedJsonFromSource: (source, id) => jsonBlock(source, id),
    assignedJsonObjectFromText: parseAssignedProfile,
    isValidProfile: migration.isValidProfile,
    normalizeProfile: migration.normalizeProfile
  });
  assert.deepStrictEqual(plain(parseImportedProfile(legacyJs)), plain(migration.normalizeProfile(legacyProfile)), "Legacy profile JS import failed.");
  assert.deepStrictEqual(plain(parseImportedProfile(legacyHtml)), plain(migration.normalizeProfile(legacyProfile)), "Legacy inline HTML profile import failed.");
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
  assert.deepStrictEqual(jsonBlock(embeddedComprehensive, "authoritySearchProfileData"), comprehensive.imported, "Imported legacy data did not survive embedding in the standalone HTML.");
  const comprehensiveReload = await runBootstrap({ ...full, html: embeddedComprehensive, profile: comprehensive.imported });
  assert.deepStrictEqual(plain(comprehensiveReload.profile), comprehensive.imported, "Imported legacy data did not reload from a standalone AuthoritySearch file.");
  assert.strictEqual(comprehensiveReload.errors.profile, false);
  assert.deepStrictEqual(plain(parseImportedProfile(JSON.stringify(comprehensive.assigned))), comprehensive.imported, "Comprehensive JSON backup path differs from legacy JS import path.");

  const minimal = importFixture("legacy-minimal-profile.js");
  assert.deepStrictEqual(minimal.imported.visaSummaryUnlocks, []);
  assert.deepStrictEqual(minimal.imported.visaChallengeLockouts, []);
  assert.deepStrictEqual(minimal.imported.visaFactUnlocks, []);
  assert.deepStrictEqual(minimal.imported.visaFactChallengeLockouts, []);
  assert.deepStrictEqual(minimal.imported.courseStructure, { blocks: [] });
  assert.deepStrictEqual(minimal.imported.notes[0].coursePlacement, { kind: "uncategorized" });
  assert.strictEqual(minimal.imported.preferences.quizCursorKey, null);
  assert.strictEqual(minimal.imported.preferences.quizClassification, "all");
  assert.strictEqual(minimal.imported.notes[0].body, "Preserve this text.");
  const embeddedMinimal = replaceProfileOnly(light.html, minimal.imported);
  const minimalReload = await runBootstrap({ ...light, html: embeddedMinimal, profile: minimal.imported });
  assert.deepStrictEqual(plain(minimalReload.profile), minimal.imported, "Minimal legacy data did not reload from a standalone AuthoritySearch file.");
  assert.strictEqual(minimalReload.errors.profile, false);

  const normalized = importFixture("legacy-normalization-profile.js").imported;
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
  assert.throws(() => parseImportedProfile('window.AUTHORITY_SEARCH_PROFILE = {"schemaVersion":2,"notes":[],"preferences":{}};'), /valid AuthoritySearch profile/, "Unsupported profile schema was accepted.");
  assert.throws(() => parseImportedProfile('window.AUTHORITY_SEARCH_PROFILE = {"schemaVersion":1,"notes":"not-an-array","preferences":{}};'), /valid AuthoritySearch profile/, "Malformed notes collection was accepted.");

  console.log(`PASS AuthoritySearch.html: ${full.bytes} bytes; ${full.manifest.compressedBytes} gzip bytes`);
  console.log(`PASS AuthoritySearch-no-USC.html: ${light.bytes} bytes; ${light.manifest.compressedBytes} gzip bytes`);
  console.log(`PASS statutory formatting audit: ${statutoryFormattingAudit.nodes} nodes; ${statutoryFormattingAudit.formattedNodes} nodes with ${statutoryFormattingAudit.runInLines} run-in lines; ${statutoryFormattingAudit.citationLinks} local citation links`);
  console.log(`PASS definitions audit: ${full.corpus.definitions.entries.length} source records; 61 INA clauses; 32 exact 8 CFR 1.2 entries`);
  console.log("PASS round trips, hashes, counts, syntax, native loader, corruption handling, deterministic gzip, profile isolation, comprehensive legacy profile migration, statutory formatting, saving-menu state rules, and ordinary gzip extraction");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
