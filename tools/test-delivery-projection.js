#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");
const { prepareDeliveryCorpus } = require("./corpus-delivery");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");
const { readBuildCorpus } = require("./read-build-corpus");
const functionSource = require("./test-function-source");
const root = path.join(__dirname, "..");
const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

const metadataFixture = {
  legalReferenceExceptions: { schemaVersion: 1, exceptions: [
    { id: "usc", sourceId: "usc-8-1" },
    { id: "cfr", sourceId: "cfr-8:1.2-0", sourceText: "Exact source guard", reason: "Retain validated evidence" },
    { id: "future", sourceId: "future-1" }
  ] },
  legalReferencePacking: { schemaVersion: 3, sources: 1, references: 2, hydratedAtRuntime: true, houseHrefs: [], legalTargets: [] },
  legalReferenceMetadata: { schemaVersion: 3, cfrHierarchyVersion: 20, uscHierarchyVersion: 2, generatedReferences: 2, historicalReviewedReferences: 1, rules: ["build audit"], futureMode: "keep" }
};
const metadataBefore = clone(metadataFixture);
const metadataAfter = prepareDeliveryCorpus(metadataFixture);
assert.deepEqual(metadataAfter.legalReferenceExceptions.exceptions.map(item => item.id), ["cfr", "future"], "Delivery must omit only build-resolved USC-source exceptions, preserving CFR and future source kinds");
assert.deepEqual(metadataFixture, metadataBefore, "Projection must not mutate canonical inputs");
assert.deepEqual(metadataAfter.legalReferenceMetadata, { schemaVersion: 3, cfrHierarchyVersion: 20, uscHierarchyVersion: 2, futureMode: "keep" });
assert.deepEqual(metadataAfter.legalReferencePacking, { schemaVersion: 3, houseHrefs: [], legalTargets: [] });

// Independent allowlist: normalize only the audited delivery-only paths.
function normalizeReaderMetadata(corpus) {
  for (const target of Object.values(corpus.uscHierarchyLinks?.targets || {})) delete target.heading;
  if (Array.isArray(corpus.policyManual?.catalog)) corpus.policyManual.catalog = [];
  if (Array.isArray(corpus.forms)) corpus.forms = [];
  for (const key of ["groupSources", "coverage", "sourceManifest", "reviewedSourceManifest", "additionalReviewedSourceManifests"]) if (corpus.historicalUsc) delete corpus.historicalUsc[key];
  if (corpus.historicalIna) delete corpus.historicalIna.sourceManifest;
  if (corpus.cfr) delete corpus.cfr.structureSources;
  for (const key of ["inaVerification", "glossaryVerification"]) if (corpus.definitions) delete corpus.definitions[key];
  for (const section of corpus.title8?.sections || []) for (const key of ["sourceArtifact", "sourceSha256", "unitsSha256", "sourceCapturedAt", "transcriptionPolicy", "transcriptionCorrections", "amendmentReview", "headingEvidence", "headingOrigin", "referenceCorrections", "sourcePdfPages", "sourceFile", "pdfPages", "sourceCaptureStatus", "sourceAccessedAt"]) if (section.historical) delete section.historical[key];
  for (const [field, keep] of [["referenceMetadata", "capturedAt"], ["houseFootnoteMetadata", "noteLayoutRevision"]]) for (const key of Object.keys(corpus.title8?.[field] || {})) if (key !== keep) delete corpus.title8[field][key];
  if (Array.isArray(corpus.historicalLocatorCorrections)) corpus.historicalLocatorCorrections = corpus.historicalLocatorCorrections.filter(row => row.kind !== "usc").map(row => { for (const key of ["review", "reason", "sourceSha256"]) delete row[key]; return row; });
  return corpus;
}
const readerFixture = {
  uscHierarchyLinks: { targets: { "8:1": { heading: "Build label", url: "https://example.test/chapter", future: "keep" } } },
  policyManual: { schemaVersion: 1, catalog: [{ text: "Dormant" }] }, forms: [{ number: "Dormant" }],
  sources: { policyManual: { url: "https://example.test/policy" }, forms: { url: "https://example.test/forms" } },
  title8: { sections: [{ text: "Legal text", historical: { sourceArtifact: "build", sourceUrl: "https://example.test/history", transcriptionNote: "Warning", reviewStatus: "reviewed", validity: [1900, 1950], future: "keep" } }], referenceMetadata: { capturedAt: "date", audit: 1 }, houseFootnoteMetadata: { noteLayoutRevision: 2, audit: 1 } },
  historicalLocatorCorrections: [{ kind: "usc", id: "resolved" }, { kind: "cfr", id: "guard", sourceFingerprint: "literal", target: { url: "https://example.test/target" }, citationNote: "Visible note", reason: "audit", review: "audit", sourceSha256: "audit" }, { kind: "future", id: "future", sourceText: "keep" }],
  historicalUsc: { groupSources: ["build"], coverage: { count: 1 }, sourceManifest: "build", legal: "keep" }, historicalIna: { sourceManifest: "build", legal: "keep" },
  cfr: { structureSources: ["build"], coverage: { core: "Complete current Title 8 CFR" }, text: "Legal regulation" }, definitions: { inaVerification: {}, glossaryVerification: {}, items: [{ text: "Definition" }] }
};
const readerBefore = clone(readerFixture);
const readerAfter = prepareDeliveryCorpus(readerFixture);
assert.deepEqual(readerAfter, normalizeReaderMetadata(clone(readerFixture)), "Only audited delivery metadata may be removed");
assert.deepEqual(readerFixture, readerBefore, "Metadata trimming must preserve canonical inputs");
assert.deepEqual(prepareDeliveryCorpus(readerAfter), readerAfter);

const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const browser = vm.createContext({ INASEARCH_BROWSER: true, hydratedLegalReferenceRoots: new WeakSet() });
for (const name of ["canonicalPath", "componentTokens", "houseSectionUrl", "expandPackedHouseHref", "hydrateLegalReferences"]) {
  vm.runInContext(functionSource(template, name), browser);
}
const browserDecode = input => {
  const copy = clone(input);
  browser.hydrateLegalReferences(copy, copy);
  return clone(copy);
};
const nodeDecode = input => unpackLegalReferences(clone(input));
const omitDeliveryMetadata = corpus => {
  for (const key of ["legalReferenceExceptions", "legalReferencePacking", "legalReferenceMetadata", "legalReferenceEvidence", "legalReferenceAudit"]) delete corpus[key];
  return normalizeReaderMetadata(corpus);
};
function assertDecodedEqual(before, after, decode, label) {
  assert(isDeepStrictEqual(omitDeliveryMetadata(decode(before)), omitDeliveryMetadata(decode(after))), `${label}: every source value and decoded reference property must remain exact`);
}

const lostLegalText = clone(readerAfter);
lostLegalText.title8.sections[0].text = "";
assert.throws(() => assertDecodedEqual(readerBefore, lostLegalText, nodeDecode, "Legal-loss sentinel"), /every source value/, "Metadata normalization must not mask legal text loss");
const lostWarning = clone(readerAfter);
delete lostWarning.title8.sections[0].historical.transcriptionNote;
assert.throws(() => assertDecodedEqual(readerBefore, lostWarning, nodeDecode, "Warning-loss sentinel"), /every source value/, "Metadata normalization must retain rendered historical warnings");

const lawNotice = "The official link searches GovInfo for this Public Law. A verified direct archive is not available here; the slip-law collection begins with the 104th Congress.";
const statuteNotice = "The official citation link locates the printed page within its containing Statutes at Large document.";
const lawUrl = "https://www.govinfo.gov/app/search/" + encodeURIComponent(JSON.stringify({ query: 'collection:statute plawcitation:"Public Law 89-554"' }));
const cfrUrl = "https://www.ecfr.gov/current/title-20/part-655/section-655.202";
const houseUrl = "https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title8-section1101";
const frUrl = "https://www.govinfo.gov/app/search/%7B%22query%22%3A%225%20F.R.%202423%22%7D";
function record(text, fields) {
  return { text, references: [{ start: 0, end: text.length, text, resolution: "official-source-only", ruleId: "explicit-cfr", ...fields }] };
}
const fixture = { body: [
  record("20 CFR 655.202(b)(6)", { family: "cfr", targetTitle: "20", targetSection: "655.202", targetPath: ["b", "6"], officialUrl: cfrUrl }),
  record("Public Law 89-554", { family: "public-law", targetCongress: "89", targetLaw: "554", targetPath: ["s1"], officialUrl: lawUrl, citationNote: "Custom context. " + lawNotice }),
  record("22 Stat. 58", { family: "statutes-at-large", targetVolume: "22", targetPage: "58", officialUrl: "https://www.govinfo.gov/link/statute/22/58", citationNote: statuteNotice }),
  record("8 CFR 204.6", { family: "cfr", targetTitle: "8", targetSection: "204.6", officialUrl: "", resolution: "unresolved", citationNote: "No verified historical destination." }),
  record("8 USC 1101", { family: "usc", targetTitle: "8", targetSection: "1101", officialUrl: houseUrl }),
  record("chapter 7", { family: "usc", targetTitle: "8", targetChapter: "7", officialUrl: "https://uscode.house.gov/us/usc/119-120/t8/chapter7-front.html" }),
  record("section 705(a)(5)", { family: "usc", targetTitle: "8", targetSection: "705", targetPath: ["a", "5"], historicalOfficialUrl: "https://www.govinfo.gov/content/pkg/STATUTE-64/pdf/STATUTE-64-Pg987.pdf#page=27", officialUrl: "https://www.govinfo.gov/content/pkg/STATUTE-64/pdf/STATUTE-64-Pg987.pdf#page=27", citationNote: "Historical archive." }),
  record("5 F.R. 2423", { family: "federal-register", targetVolume: "5", targetPage: "2423", officialUrl: frUrl }),
  record("5 Federal Register 2423", { family: "federal-register", targetVolume: "5", targetPage: "2423", officialUrl: frUrl })
] };
packLegalReferences(fixture);
fixture.legalReferencePacking.legalTargets.push("c|0|8|1.2||||||||||||||https://example.invalid/unused");
const fixtureBefore = clone(fixture);
const projected = prepareDeliveryCorpus(fixture);
assert.deepEqual(fixture, fixtureBefore);
assert.deepEqual(prepareDeliveryCorpus(projected), projected, "A second projection must not append notices or alter already-trimmed targets");
assert.equal(projected.legalReferencePacking.legalTargets.length, fixture.legalReferencePacking.legalTargets.length, "Dictionary indexes must remain stable");
assert.deepEqual(projected.body.map(item => item._lr), fixture.body.map(item => item._lr));
assert(!projected.legalReferencePacking.legalTargets[0].includes(cfrUrl), "A redundant CFR URL should be omitted");
assert(projected.legalReferencePacking.legalTargets[1].includes("Custom context."), "Custom notice text must remain");
assert(!projected.legalReferencePacking.legalTargets[1].includes(lawNotice), "Only the standard notice regenerated by the decoder may be omitted");
assert(projected.legalReferencePacking.legalTargets[3].includes("-1"), "An intentionally empty destination must not become a default URL");
assert(projected.legalReferencePacking.legalTargets[4].includes(houseUrl), "Different Node/browser URL spellings must prevent omission");
assert(projected.legalReferencePacking.legalTargets[5].includes("chapter7-front.html"), "A specific hierarchy destination must not fall back to the generic browse page");
assert(projected.legalReferencePacking.legalTargets[7].includes(frUrl), "Every use of a shared target must agree; a second source wording can require the explicit URL");
assert.equal(projected.legalReferencePacking.legalTargets.at(-1), fixture.legalReferencePacking.legalTargets.at(-1), "Unused dictionary entries must not be guessed or removed");
assertDecodedEqual(fixture, projected, nodeDecode, "Node fixture");
assertDecodedEqual(fixture, projected, browserDecode, "Browser fixture");

const artifact = process.argv[2] || path.join(root, "INASearch-Uncompressed.html");
const corpus = readBuildCorpus(artifact);
// Restore explicit URL storage using the maintained packer so this test still
// exercises the projection after the distributable itself has been trimmed.
packLegalReferences(unpackLegalReferences(corpus));
corpus.legalReferenceExceptions = JSON.parse(fs.readFileSync(path.join(root, "sources/legal/embedded-reference-exceptions.json"), "utf8"));
const beforeJson = JSON.stringify(corpus);
const trimmed = prepareDeliveryCorpus(corpus);
assert.equal(JSON.stringify(corpus), beforeJson, "The complete canonical input must remain unchanged");
assert.deepEqual(trimmed.legalReferenceExceptions.exceptions, corpus.legalReferenceExceptions.exceptions.filter(item => !item.sourceId.startsWith("usc-")), "Every retained exception, literal guard, target and audit attribute must survive exactly");
assert(trimmed.legalReferenceExceptions.exceptions.some(item => item.sourceId.startsWith("cfr-")), "Runtime guard coverage must not be vacuous");
assert.equal(trimmed.legalReferencePacking.legalTargets.length, corpus.legalReferencePacking.legalTargets.length);
assert.deepEqual(prepareDeliveryCorpus(trimmed), trimmed);
assert(bytes(trimmed) < bytes(corpus) - 2_000_000, "The complete projection must remove redundant delivery bytes");
assertDecodedEqual(corpus, trimmed, nodeDecode, "Complete Node corpus");
assertDecodedEqual(corpus, trimmed, browserDecode, "Complete browser corpus");

const legalSource = fs.readFileSync(path.join(root, "tools/legal-references.js"), "utf8");
const guards = vm.createContext({ textSha256: null });
for (const name of ["stableTextFingerprint", "sourceTextHash", "sourceExceptions"]) vm.runInContext(functionSource(legalSource, name), guards);
const originalExceptions = new Map(corpus.legalReferenceExceptions.exceptions.map(item => [item.id, item]));
const deliveredExceptions = new Map(trimmed.legalReferenceExceptions.exceptions.map(item => [item.id, item]));
for (const exception of trimmed.legalReferenceExceptions.exceptions) {
  const context = { sourceId: `runtime-${exception.sourceId}`, sourceField: exception.sourceField, sourceText: exception.sourceText };
  const before = guards.sourceExceptions({ ...context, embeddedExceptions: originalExceptions });
  const after = guards.sourceExceptions({ ...context, embeddedExceptions: deliveredExceptions });
  assert.deepEqual(clone(after), clone(before), `Runtime literal guard changed: ${exception.id}`);
  assert(after.some(item => item.id === exception.id), `Runtime guard coverage must match the intended exception: ${exception.id}`);
}
// Historical locator guards have a separate schema from embedded exceptions.
// Verify every retained guard accepts identical source context and rejects edits.
vm.runInContext(functionSource(legalSource, "reviewedHistoricalLocators"), guards);
for (const row of trimmed.historicalLocatorCorrections || []) {
  const context = { kind: row.kind, title: row.title, section: row.section, sourceField: row.field, sourceTextFingerprint: row.sourceFingerprint };
  const match = corrections => clone(guards.reviewedHistoricalLocators({ ...context, historicalLocatorCorrections: corrections }, ""));
  assert.deepEqual(normalizeReaderMetadata({ historicalLocatorCorrections: match(corpus.historicalLocatorCorrections) }).historicalLocatorCorrections, match(trimmed.historicalLocatorCorrections), `Historical runtime guard changed: ${row.id}`);
  assert(match(trimmed.historicalLocatorCorrections).some(item => item.id === row.id), `Historical guard coverage: ${row.id}`);
  assert.equal(guards.reviewedHistoricalLocators({ ...context, sourceTextFingerprint: "changed-source", historicalLocatorCorrections: trimmed.historicalLocatorCorrections }, "").length, 0, `Changed historical source must reject guard: ${row.id}`);
}
vm.runInContext(fs.readFileSync(path.join(root, "tools/embedded-references.js"), "utf8"), browser);
vm.runInContext(legalSource, browser);
const beforeUpdate = browserDecode(corpus), afterUpdate = browserDecode(trimmed);
const fullSummary = browser.INASearchLegalReferences.applyCfrReferences(beforeUpdate, ["8:245"]);
const trimmedSummary = browser.INASearchLegalReferences.applyCfrReferences(afterUpdate, ["8:245"]);
assert(fullSummary.references > 0 && fullSummary.fields > 0);
assert.deepEqual(clone(trimmedSummary), clone(fullSummary), "The browser updater must retain the same maintenance outcome");
delete beforeUpdate.cfr.structureSources;
delete afterUpdate.cfr.structureSources;
assert(isDeepStrictEqual(afterUpdate.cfr, beforeUpdate.cfr), "The browser CFR reparse must retain every reference and source field");
console.log(`PASS delivery projection: exact complete Node/browser fields, all CFR guards, immutable/idempotent inputs and runtime update; ${bytes(corpus)} -> ${bytes(trimmed)} bytes`);
