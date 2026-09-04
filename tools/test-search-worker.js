#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");

const root = path.resolve(__dirname, "..");
const occurrenceSource = fs.readFileSync(path.join(root, "src", "INASearch-Occurrence.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "src", "INASearch-Search-Worker.js"), "utf8");

function fixtureCorpus() {
  const referenceText = "See 8 U.S.C. 1182 for the alpha rule.";
  const start = referenceText.indexOf("8 U.S.C. 1182");
  return {
    schemaVersion: 5,
    corpusVersion: "worker-fixture-1",
    legalReferencePacking: { houseHrefs: [], legalTargets: ["u|1|8|1182||||||"] },
    inaHierarchy: {
      titles: [{ id: "ina:title:I", number: "I", heading: "General", chapters: [], sectionIds: ["ina:section:101", "ina:section:102"] }],
      sections: [
        { id: "ina:section:101", inaSection: "101", heading: "Source", titleId: "ina:title:I", chapterId: null },
        { id: "ina:section:102", inaSection: "102", heading: "Target", titleId: "ina:title:I", chapterId: null }
      ]
    },
    inaCrosswalk: [
      { inaSection: "101", uscSection: "1101", localSection: "1101", title: "Source", group: "Title I", isNote: false, hasEquivalent: true },
      { inaSection: "102", uscSection: "1182", localSection: "1182", title: "Target", group: "Title I", isNote: false, hasEquivalent: true }
    ],
    title8: { sections: [
      { id: "8-1101", section: "1101", heading: "Source", body: [{ label: "a", text: referenceText, _lr: { t: [[1, start, "8 U.S.C. 1182".length, 0]] } }] },
      { id: "8-1182", section: "1182", heading: "Target", body: [{ label: "a", text: "Target provision." }] }
    ] },
    cfr: { captureTime: "fixture", parts: [], sections: [], appendices: [] }
  };
}

function createHarness(shared, corpus) {
  const listeners = new Map(), messages = [];
  const storage = {
    async loadSearchIndex(identity) { return shared.searchIndexes.get(identity.key) || null; },
    async saveSearchIndex(record) { shared.searchIndexes.clear(); shared.searchIndexes.set(record.key, structuredClone(record)); return true; },
    async ensureActiveCorpus(value) { shared.persistedCorpus = structuredClone(value); shared.corpusWrites += 1; return true; },
    async loadActiveCorpus() { shared.corpusReads += 1; return { corpus: structuredClone(shared.persistedCorpus || corpus), record: {}, slot: "active" }; }
  };
  const context = {
    globalThis: null,
    self: null,
    Blob,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Map,
    Set,
    WeakMap,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    Math,
    JSON,
    RegExp,
    Promise,
    structuredClone,
    performance,
    setTimeout,
    clearTimeout,
    INASearchStorage: storage,
    INASearchCorpusPacking: { hydratePackedCorpus: value => value },
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(value) { messages.push(structuredClone(value)); }
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  new vm.Script(occurrenceSource, { filename: "INASearch-Occurrence.js" }).runInContext(context);
  new vm.Script(workerSource, { filename: "INASearch-Search-Worker.js" }).runInContext(context);
  return {
    messages,
    send(data) { listeners.get("message")({ data }); },
    async waitFor(predicate, timeout = 5000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const match = messages.find(predicate);
        if (match) return match;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for worker message. Seen: ${messages.map(message => message.type).join(", ")}`);
    }
  };
}

async function main() {
  const corpus = fixtureCorpus();
  const identity = { corpusSchemaVersion: 5, corpusVersion: corpus.corpusVersion, corpusSha256: "a".repeat(64), authorities: ["ina", "cfr"] };
  const shared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  const cold = createHarness(shared, corpus);
  cold.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)], { type: "application/json" }) });
  const coldReady = await cold.waitFor(message => message.type === "ready");
  assert.strictEqual(coldReady.source, "built", "A cold worker did not build its projection.");
  await cold.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  assert.strictEqual(shared.searchIndexes.size, 1, "A built projection was not persisted.");
  assert.strictEqual(shared.corpusWrites, 1, "The embedded baseline was not persisted independently of updater settings.");

  cold.send({ type: "search", sessionId: "ordinary", generation: 1, requestId: "ordinary-1", query: "alpha", options: { authorities: ["ina"] } });
  const search = await cold.waitFor(message => message.type === "search-result" && message.sessionId === "ordinary");
  assert(search.result.totalOccurrences > 0, "The worker returned no ordinary legal-text hits.");
  cold.send({ type: "materialize", pageId: "ordinary-page", requestId: search.result.requestId, options: { sectionId: search.result.sections[0].id, start: 0, limit: 1 } });
  const page = await cold.waitFor(message => message.type === "page-result" && message.pageId === "ordinary-page");
  assert.strictEqual(page.page.rows.length, 1, "The worker did not materialize a bounded result page.");

  cold.send({ type: "citation-search", sessionId: "citations", generation: 1, requestId: "citations-1", scope: { family: "usc", sectionIds: new Set(["8-1182"]), pathsBySection: new Map([["8-1182", []]]) }, query: { clauses: [] }, authorities: ["statute"] });
  const citations = await cold.waitFor(message => message.type === "search-result" && message.sessionId === "citations");
  assert.strictEqual(citations.result.totalOccurrences, 1, "The persisted reverse citation index did not find its source provision.");

  const corruptedKey = [...shared.searchIndexes.keys()][0];
  const corruptedRecord = structuredClone(shared.searchIndexes.get(corruptedKey));
  corruptedRecord.payload.fragments = null;
  shared.searchIndexes.set(corruptedKey, corruptedRecord);
  const readsBeforeRecovery = shared.corpusReads;
  const recovering = createHarness(shared, corpus);
  recovering.send({ type: "init", identity, source: "indexeddb" });
  const recoveredReady = await recovering.waitFor(message => message.type === "ready");
  assert.strictEqual(recoveredReady.source, "built", "A corrupt cached projection was not rebuilt.");
  assert(shared.corpusReads > readsBeforeRecovery, "Projection corruption did not fall back to the runtime corpus.");
  await recovering.waitFor(message => message.type === "cache-warning" && message.cache === "search-index");
  await recovering.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");

  const readsBeforeWarm = shared.corpusReads;
  const warm = createHarness(shared, corpus);
  warm.send({ type: "init", identity, source: "indexeddb" });
  const warmReady = await warm.waitFor(message => message.type === "ready");
  assert.strictEqual(warmReady.source, "indexeddb", "A warm worker rebuilt instead of restoring its projection.");
  assert.strictEqual(shared.corpusReads, readsBeforeWarm, "A warm projection cache hit unnecessarily decoded the corpus in the worker.");

  const cancellationStart = warm.messages.length;
  warm.send({ type: "search", sessionId: "rapid", generation: 1, requestId: "rapid-1", query: "alpha", options: { authorities: ["ina"] } });
  warm.send({ type: "search", sessionId: "rapid", generation: 2, requestId: "rapid-2", query: "target", options: { authorities: ["ina"] } });
  await warm.waitFor(message => message.type === "search-result" && message.sessionId === "rapid" && message.generation === 2);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(!warm.messages.slice(cancellationStart).some(message => message.type === "search-result" && message.sessionId === "rapid" && message.generation === 1), "A stale search generation replaced a newer result.");

  const nextCorpus = structuredClone(corpus);
  nextCorpus.corpusVersion = "worker-fixture-2";
  shared.persistedCorpus = nextCorpus;
  const nextIdentity = { corpusSchemaVersion: 5, corpusVersion: nextCorpus.corpusVersion, corpusSha256: "b".repeat(64), authorities: ["ina", "cfr"] };
  const changed = createHarness(shared, nextCorpus);
  changed.send({ type: "corpus-change", identity: nextIdentity, source: "indexeddb" });
  const changedReady = await changed.waitFor(message => message.type === "ready");
  assert.strictEqual(changedReady.source, "built", "A changed corpus incorrectly reused the prior projection.");
  await changed.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  assert.strictEqual(shared.searchIndexes.size, 1, "A corpus change retained a stale search projection.");
  assert.strictEqual([...shared.searchIndexes.values()][0].corpusVersion, nextCorpus.corpusVersion, "The replacement projection was saved under the wrong corpus identity.");

  const racingShared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  const racing = createHarness(racingShared, nextCorpus);
  racing.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  racing.send({ type: "corpus-change", identity: nextIdentity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(nextCorpus)]) });
  const racingReady = await racing.waitFor(message => message.type === "ready");
  assert.strictEqual(racingReady.identity.corpusVersion, nextCorpus.corpusVersion, "An obsolete projection build won a corpus-change race.");
  await racing.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  assert(!racing.messages.some(message => message.type === "ready" && message.identity?.corpusVersion === corpus.corpusVersion), "A stale projection announced readiness after a corpus change.");
  console.log("Search worker cache tests passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
