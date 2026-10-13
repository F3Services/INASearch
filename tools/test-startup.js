#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const packing = require("../src/INASearch-Corpus-Packing");
const shards = require("../src/INASearch-Corpus-Shards");
const command = require("../src/INASearch-Command");
const { readBuildCorpus } = require("./read-build-corpus");
const full = readBuildCorpus(require.resolve("../INASearch.html"));
const { metadata, chunks } = shards.partitionPackedCorpus(full);
const mapping = metadata._shards;
const headings = metadata;
function startup(elements = new Map(), marks = []) {
  const context = { INASearchCorpusPacking: packing, INASearchCorpusShards: shards, INA_SEARCH_COMMAND: command,
    crypto: globalThis.crypto, DecompressionStream, Blob, Response, TextDecoder, TextEncoder, Uint8Array, atob, setTimeout,
    document: { readyState: "loading", getElementById: id => elements.has(id) ? {} : null, addEventListener() {}, removeEventListener() {} }, INA_SEARCH_MARK_PERFORMANCE: (name, detail) => marks.push({ name, detail }) };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/INASearch-Startup"), "utf8"), context);
  for (const id of elements.keys()) if (id) context.INASearchStartup.register(id);
  return context;
}
const select = startup().INASearchStartup.openingChunks;
for (const [query, kind, recordId] of [
  ["101a15h2a", "usc", "8-1101"], ["I.N.A. 101(a)(15)(H)(ii)(a)", "usc", "8-1101"],
  ["8usc1101a15h2a", "usc", "8-1101"], ["1101a15h2a", "usc", "8-1101"],
  ["8 U.S.C. 1 to 18", "usc", "8-1"], ["8 U.S.C. 1 to 18", "usc", "8-18"],
  ["61 to 65", "usc", "8-61"], ["61 to 65", "usc", "8-65"],
  ["INA 329A", "usc", "8-1440–1"], ["INA 401", "usc", "8-1106"], ["INA 242A", "usc", "8-1252a"],
  ["8cfr214.2h13iiia", "cfr", "8:214.2"], ["214.2h13iiia", "cfr", "8:214.2"],
  ["8 CFR 214.2(h)(2)", "cfr", "8:214.2"]
]) {
  const records = kind === "usc" ? headings.title8.sections : headings.cfr.sections;
  const index = records.findIndex(record => record.id === recordId);
  assert(index >= 0, `${query}: missing fixture ${recordId}`);
  assert(select(headings, mapping, query).includes(mapping[kind][index]), `${query}: opening body was not selected`);
}
assert.equal(select(headings, mapping, "president"), null);
assert.deepEqual([...select(headings, mapping, "")], []);
assert.deepEqual([...select(headings, mapping, "about")], []);
assert.equal(select(headings, mapping, '"about"'), null);
assert.deepEqual([...select(headings, mapping, "INA Title II")], []);
const combined = select(headings, mapping, "101a15h2a,8cfr214.2h13iiia");
assert(combined.includes(mapping.usc[headings.title8.sections.findIndex(record => record.id === "8-1101")]));
assert(combined.includes(mapping.cfr[headings.cfr.sections.findIndex(record => record.id === "8:214.2")]));
async function checkFallbackPersistence(rejectLoading = false, legacy = false) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    let embeddedBaselineFallbackScheduled"), template.indexOf("    function createSearchWorkerClient()"));
  let resolveComplete, rejectComplete;
  const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
  const saved = [];
  const corpus = { title8: { sections: [{ id: "8-1101" }] } };
  const context = { corpus, corpusManifest: {}, loadErrors: {}, Blob,
    requestIdleCallback: callback => callback(),
    INASearchStorage: { ensureActiveCorpus: value => saved.push(structuredClone(value)) },
    INA_SEARCH_CORPUS_LOAD_SOURCE: legacy ? "indexeddb" : "embedded", INA_SEARCH_CORPUS_FULLY_LOADED: false,
    INA_SEARCH_ACTIVE_CORPUS_RECORD: legacy ? { recordSchemaVersion: 2, sourceCorpusSha256: "legacy-identity", legalReferencesPacked: false, sourceState: { authority: "updated-cfr" } } : null,
    INA_SEARCH_CORPUS_COMPLETE: complete };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source + "\nscheduleEmbeddedBaselinePersistence();", context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, 0, "Worker failure persisted a partially loaded corpus");
  if (rejectLoading) rejectComplete(new Error("Background content could not be verified"));
  else {
    corpus.title8.sections[0].body = "Verified complete statutory text";
    context.INA_SEARCH_CORPUS_FULLY_LOADED = true;
    resolveComplete();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, rejectLoading ? 0 : 1, "Fallback persistence ignored the background load outcome");
  if (!rejectLoading) assert.equal(saved[0].title8.sections[0].body, "Verified complete statutory text");
}
async function checkNoteMetadataUpgrade() {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    if (corpus && (corpus.legalReferenceMetadata"), template.indexOf("    if (loadedCorpus && !corpus)"));
  const embedded = { legalReferenceMetadata: { cfrHierarchyVersion: 1 }, title8: { runInRevision: 1, houseFootnoteMetadata: { noteLayoutRevision: 1 } }, cfr: { currentThrough: { 8: "2026-01-01" } } };
  const previous = structuredClone(embedded);
  delete previous.title8.houseFootnoteMetadata.noteLayoutRevision;
  previous.cfr = { currentThrough: { 8: "2026-02-01" }, parts: [{ id: "8:214" }] };
  previous.corpusVersion = "newer-cfr-download";
  const context = { corpus: previous, build: { cfrHierarchyVersion: 1, statuteRunInRevision: 1, statuteNoteLayoutRevision: 1 },
    loadEmbeddedINASearchCorpus: async () => structuredClone(embedded), isValidCorpus: () => true, hydrateLegalReferences() {},
    INA_SEARCH_CORPUS_COMPLETE: Promise.resolve(), INASearchLegalReferences: { applyCfrReferences() {} }, TextEncoder,
    INASearchStorage: { sha256Bytes: async bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex") } };
  context.window = context;
  vm.createContext(context);
  await vm.runInContext(`(async () => { ${source} })()`, context);
  assert.equal(context.corpus.title8.houseFootnoteMetadata.noteLayoutRevision, 1, "An existing cache must receive the structured editorial notes");
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE, "upgraded-cache");
  assert.equal(context.corpus.cfr.currentThrough[8], "2026-02-01", "The note upgrade must preserve newer downloaded regulations");
  assert.equal(context.INA_SEARCH_UPGRADED_CORPUS_SHA256, require("node:crypto").createHash("sha256").update(JSON.stringify(context.corpus)).digest("hex"), "An upgraded reader must identify its new content with the same hash used by its next cached startup.");
}
(async () => {
  await checkNoteMetadataUpgrade();
  await checkFallbackPersistence();
  await checkFallbackPersistence(true);
  await checkFallbackPersistence(false, true);
  const parser = startup();
  parser.document.getElementById = () => ({ textContent: "partial payload" });
  let arrived = false;
  const waiting = parser.INASearchStartup.waitForData("streamingChunk").then(() => { arrived = true; });
  await Promise.resolve();
  assert.equal(arrived, false, "A parser-created element was read before its closing script arrived");
  parser.INASearchStartup.register("streamingChunk");
  await waiting;
  const selected = select(headings, mapping, "101a15h2a");
  const marks = [], context = startup(new Map(), marks);
  const reads = [], chunkWaiters = new Map();
  context.INASearchStorage = { readCorpusChunk(_record, id) {
    reads.push(id);
    if (selected.includes(id)) return Promise.resolve(structuredClone(chunks[id]));
    return new Promise(resolve => chunkWaiters.set(id, () => resolve(structuredClone(chunks[id]))));
  } };
  const record = { chunks };
  const opened = await context.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "101a15h2a");
  assert.deepEqual(JSON.parse(JSON.stringify(opened.title8.sections.find(record => record.id === "8-1101").body)), full.title8.sections.find(record => record.id === "8-1101").body);
  assert(!opened.cfr.sections.some(record => record.blocks?.length), "Unrequested CFR bodies were parsed before paint");
  const hierarchy = require("../src/INASearch-CFR-Hierarchy");
  const cfrRecord = opened.cfr.sections.find(record => record.id === "8:214.2");
  assert.equal(hierarchy.index(cfrRecord).paths.length, 0);
  context.INA_SEARCH_CONTINUE_LOADING();
  let complete = false;
  context.INA_SEARCH_CORPUS_COMPLETE.then(() => { complete = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(complete, false, "Withheld cached content should not finish loading");
  context.INASearchStorage.readCorpusChunk = (_record, id) => { reads.push(id); return Promise.resolve(structuredClone(chunks[id])); };
  chunkWaiters.forEach(resolve => resolve());
  await context.INA_SEARCH_CORPUS_COMPLETE;
  assert(hierarchy.index(cfrRecord).paths.length > 0, "A pre-loading CFR structure cache stayed empty after body arrival");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), full, "Background loading changed legal content or record identity");
  assert.equal(marks.filter(mark => mark.name === "content-chunk-ready").length, chunks.length, "A cached chunk loaded more than once");
  const text = startup();
  text.INASearchStorage = { readCorpusChunk: (_record, id) => Promise.resolve(structuredClone(chunks[id])) };
  const textCorpus = await text.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "president");
  assert.equal(text.INA_SEARCH_OPENING_REQUIRES_FULL_CORPUS, false, "Ordinary cached searches should use their saved index before complete records");
  assert.equal(text.INA_SEARCH_CORPUS_FULLY_LOADED, false);
  text.INA_SEARCH_CONTINUE_LOADING();
  await text.INA_SEARCH_CORPUS_COMPLETE;
  assert.deepEqual(JSON.parse(JSON.stringify(textCorpus)), full);
  for (const [query, profile] of [["in:notes", null], ["has:highlight president", null], ["president", { notes: [{ id: "saved-note" }] }], ["president", { highlights: [{ id: "saved-highlight" }] }]]) {
    const annotated = startup();
    annotated.INA_SEARCH_PROFILE = profile;
    annotated.INASearchStorage = { readCorpusChunk: (_record, id) => Promise.resolve(structuredClone(chunks[id])) };
    await annotated.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, query);
    assert.equal(annotated.INA_SEARCH_OPENING_REQUIRES_FULL_CORPUS, true, `${query}: annotations were searched against incomplete legal records`);
    await annotated.INA_SEARCH_CORPUS_COMPLETE;
  }
  const bad = startup();
  bad.INASearchStorage = { readCorpusChunk: () => Promise.reject(new Error("Cached corpus failed its SHA-256 integrity check")) };
  await bad.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "");
  bad.INA_SEARCH_CONTINUE_LOADING();
  await assert.rejects(bad.INA_SEARCH_CORPUS_COMPLETE, /SHA-256 integrity check/);
  console.log("PASS staged startup: compact and historical citations, split queries, withheld background bytes, exact final content, single hydration and corrupt background detection");
})().catch(error => { console.error(error); process.exitCode = 1; });
