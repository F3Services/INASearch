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
const workerClientSource = require("./test-function-source")(fs.readFileSync(path.join(root, "src", "INASearch.template.html"), "utf8"), "createSearchWorkerClient");
assert(workerClientSource.indexOf('"inaSearchUslmRuntime"') >= 0 && workerClientSource.indexOf('"inaSearchUslmRuntime"') < workerClientSource.indexOf('"inaSearchOccurrenceRuntime"'), "Search workers must load USLM presentation before its occurrence consumer");

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

function createHarness(shared, corpus, options = {}) {
  const listeners = new Map(), messages = [];
  const storage = {
    async loadSearchIndex(identity) { return shared.searchIndexes.get(identity.key) || null; },
    async saveSearchIndex(record) {
      if (options.beforeSearchIndexSave) await options.beforeSearchIndexSave(record);
      shared.searchIndexes.clear(); shared.searchIndexes.set(record.key, structuredClone(record)); return true;
    },
    async ensureActiveCorpus(value) { shared.persistedCorpus = structuredClone(value); shared.corpusWrites += 1; return true; },
    async activateCorpus(value) { shared.persistedCorpus = structuredClone(value); shared.corpusWrites += 1; return true; },
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
    postMessage(value) { messages.push(structuredClone(value)); options.onMessage?.(value); }
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(path.join(root, "src", "INASearch-USLM.js"), "utf8")).runInContext(context);
  new vm.Script(occurrenceSource, { filename: "INASearch-Occurrence.js" }).runInContext(context);
  for (const name of ["Annotations", "Query"]) new vm.Script(fs.readFileSync(path.join(root, "src", `INASearch-${name}.js`), "utf8")).runInContext(context);
  new vm.Script(fs.readFileSync(path.join(root, "src", "INASearch-Corpus-Shards.js"), "utf8")).runInContext(context);
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
  const upgraded = structuredClone(corpus);
  upgraded.referencedUsc = { version: "new", titles: [{ number: 18, name: "Crimes", sections: [{ id: "18-16", title: 18, section: "16", heading: "Crime", body: [{ label: "a", text: "upgradeneedle" }] }] }] };
  const upgradeShared = { searchIndexes: new Map(), persistedCorpus: corpus, corpusWrites: 0, corpusReads: 0 };
  const upgradeWorker = createHarness(upgradeShared, corpus);
  upgradeWorker.send({ type: "init", identity, source: "upgraded-cache", runtimeCorpus: upgraded });
  await upgradeWorker.waitFor(message => message.type === "ready");
  upgradeWorker.send({ type: "search", sessionId: "upgrade", generation: 1, requestId: "upgrade-1", query: require("../src/INASearch-Command").parseCommand("upgradeneedle"), options: { authorities: ["statute"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
  const upgradeSearch = await upgradeWorker.waitFor(message => message.type === "search-result");
  assert.strictEqual(upgradeSearch.result.totalOccurrences, 1, "The worker must use the upgraded runtime corpus instead of the older browser cache.");
  await upgradeWorker.waitFor(message => message.type === "baseline-cached");
  assert.strictEqual(upgradeShared.persistedCorpus.referencedUsc?.version, "new", "Cache upgrade must retain referenced USC sections for the next boot.");
  const projectionIdentity = require("../src/INASearch-Occurrence").projectionIdentity;
  const trimmed = structuredClone(corpus);
  trimmed.referencedUsc = { version: "trimmed", titles: [] };
  const oldIdentity = projectionIdentity(upgraded, identity);
  const trimmedIdentity = projectionIdentity(trimmed, identity);
  const trimShared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  const beforeTrim = createHarness(trimShared, upgraded);
  beforeTrim.send({ type: "init", identity: oldIdentity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(upgraded)]) });
  await beforeTrim.waitFor(message => message.name === "projection-cache-saved");
  const afterTrim = createHarness(trimShared, upgraded);
  afterTrim.send({ type: "init", identity: trimmedIdentity, source: "upgraded-cache", runtimeCorpus: trimmed });
  assert.strictEqual((await afterTrim.waitFor(message => message.type === "ready")).source, "built", "A corpus trim must invalidate the previously populated search index.");
  afterTrim.send({ type: "search", sessionId: "trim", generation: 1, requestId: "trim-1", query: require("../src/INASearch-Command").parseCommand("upgradeneedle"), options: { authorities: ["statute"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
  assert.strictEqual((await afterTrim.waitFor(message => message.type === "search-result")).result.totalOccurrences, 0, "A removed external section must disappear from cached search results.");
  await afterTrim.waitFor(message => message.name === "projection-cache-saved");
  const reopenedTrim = createHarness(trimShared, trimmed);
  reopenedTrim.send({ type: "init", identity: trimmedIdentity, source: "indexeddb" });
  assert.strictEqual((await reopenedTrim.waitFor(message => message.type === "ready")).source, "indexeddb", "The rebuilt trimmed index must remain reusable on subsequent startup.");
  const payloadShared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  const payloadPending = createHarness(payloadShared, corpus);
  payloadPending.send({ type: "init", identity, source: "embedded", awaitEmbeddedPayload: true });
  await payloadPending.waitFor(message => message.type === "progress" && message.phase === "projection-build");
  assert(!payloadPending.messages.some(message => message.type === "ready"), "A cold worker built a projection before its deferred embedded payload arrived.");
  assert.strictEqual(payloadShared.corpusReads, 0, "A deferred embedded initialization fell back to an older runtime corpus.");
  payloadPending.send({ type: "search", sessionId: "pending-payload", generation: 1, requestId: "pending-payload-1", query: require("../src/INASearch-Command").parseCommand("alpha"), options: { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
  payloadPending.send({ type: "embedded-corpus-payload", identity, embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  const payloadSearch = await payloadPending.waitFor(message => message.type === "search-result" && message.sessionId === "pending-payload");
  assert.strictEqual(payloadSearch.result.totalOccurrences, 1, "A pending startup search did not use its delivered embedded corpus payload.");
  await payloadPending.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  const delayedShared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  let finishDelayedSave;
  const delayedSave = new Promise(resolve => { finishDelayedSave = resolve; });
  const delayed = createHarness(delayedShared, corpus, {
    beforeSearchIndexSave: () => delayedSave,
    onMessage(message) {
      if (message.type !== "progress" || message.phase !== "projection-build" || message.progress) return;
      delayed.send({ type: "search", sessionId: "startup", generation: 1, requestId: "startup-1", query: require("../src/INASearch-Command").parseCommand("alpha"), options: { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
    }
  });
  delayed.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  await delayed.waitFor(message => message.type === "ready");
  try {
    const startupSearch = await delayed.waitFor(message => message.type === "search-result" && message.sessionId === "startup", 250).catch(() => null);
    assert(startupSearch?.result.totalOccurrences > 0, "A startup search waited for slow search-index persistence after its projection was ready.");
    assert(!delayed.messages.some(message => message.type === "metric" && message.name === "projection-cache-saved"), "The test did not keep search-index persistence pending.");
  } finally { finishDelayedSave(); }
  await delayed.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");

  const cold = createHarness(shared, corpus);
  cold.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)], { type: "application/json" }) });
  const coldReady = await cold.waitFor(message => message.type === "ready");
  assert.strictEqual(coldReady.source, "built", "A cold worker did not build its projection.");
  await cold.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  assert.strictEqual(shared.searchIndexes.size, 1, "A built projection was not persisted.");
  assert.strictEqual(shared.corpusWrites, 1, "The embedded baseline was not persisted independently of updater settings.");

  cold.send({ type: "search", sessionId: "ordinary", generation: 1, requestId: "ordinary-1", query: require("../src/INASearch-Command").parseCommand("alpha"), options: { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
  const search = await cold.waitFor(message => message.type === "search-result" && message.sessionId === "ordinary");
  assert(search.result.totalOccurrences > 0, "The worker returned no ordinary legal-text hits.");
  cold.send({ type: "materialize", pageId: "ordinary-page", requestId: search.result.requestId, options: { sectionId: search.result.sections[0].id, start: 0, limit: 1 } });
  const page = await cold.waitFor(message => message.type === "page-result" && message.pageId === "ordinary-page");
  assert.strictEqual(page.page.rows.length, 1, "The worker did not materialize a bounded result page.");

  const ast = require("../src/INASearch-Command").parseCommand("in:101 cites:102 alpha");
  const scopes = id => ({ valid: true, family: "usc", sectionIds: new Set([id]), pathsBySection: new Map() });
  const structuredOptions = { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [scopes("8-1101")] }], citationScopes: [[scopes("8-1182")]] } };
  cold.send({ type: "search", sessionId: "structured", generation: 1, requestId: "structured-1", query: ast, options: structuredOptions });
  const structured = await cold.waitFor(message => message.type === "search-result" && message.sessionId === "structured");
  const projection = require("../src/INASearch-Occurrence").buildProjection(corpus);
  const fallback = require("../src/INASearch-Query").search(projection, ast, structuredOptions);
  assert.strictEqual(structured.result.totalOccurrences, 1, "Independent source and cited-target constraints lost packed references during asynchronous indexing.");
  cold.send({ type: "materialize", pageId: "structured-page", requestId: structured.result.requestId, options: { start: 0, limit: 10 } });
  const structuredPage = await cold.waitFor(message => message.type === "page-result" && message.pageId === "structured-page");
  assert.deepStrictEqual(structuredPage.page.rows, fallback.materializeOccurrences({limit:10}).rows, "Worker/fallback structured results differ.");

  const highlightedText = corpus.title8.sections[0].body[0].text;
  const selectedStart = highlightedText.indexOf("alpha");
  const personal = {highlights:[{id:"highlight",color:"pink",segments:[{id:"segment",association:{family:"usc",title:8,start:{unit:"1101",path:["a"]}},anchor:require("../src/INASearch-Annotations").quoteAnchor(highlightedText,selectedStart,selectedStart+5)}]}]};
  for (const [id, input, count] of [["presence","in:highlights rule",1],["exact","in:highlights-exact rule",0],["selected","in:highlights-exact alpha",1]]) {
    const queryAst = require("../src/INASearch-Command").parseCommand(input);
    const options = {...structuredOptions, personal, plan:{branches:queryAst.branches.map(branch=>({...branch,scopes:[]})),citationScopes:[]}};
    cold.send({type:"search",sessionId:id,generation:1,requestId:id,query:queryAst,options});
    const result = await cold.waitFor(message=>message.type==="search-result" && message.sessionId===id);
    assert.strictEqual(result.result.totalOccurrences,count,`Worker ${id} highlight matching failed.`);
  }

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
  // Existing installations may still have the redundant citation-source field.
  // Its removal must not invalidate otherwise identical cached projections.
  for (const record of shared.searchIndexes.values()) record.payload.citationSources = [{ retired: true }];
  const warm = createHarness(shared, corpus);
  warm.send({ type: "init", identity, source: "indexeddb" });
  const warmReady = await warm.waitFor(message => message.type === "ready");
  assert.strictEqual(warmReady.source, "indexeddb", "A warm worker rebuilt instead of restoring its projection.");
  assert.strictEqual(shared.corpusReads, readsBeforeWarm, "A warm projection cache hit unnecessarily decoded the corpus in the worker.");

  const upgradedNotes = structuredClone(corpus);
  upgradedNotes.title8.houseFootnoteMetadata = { noteLayoutRevision: 1 };
  const warmUpgradeShared = { searchIndexes: new Map(shared.searchIndexes), persistedCorpus: corpus, corpusWrites: 0, corpusReads: 0 };
  const warmUpgrade = createHarness(warmUpgradeShared, corpus);
  warmUpgrade.send({ type: "init", identity, source: "upgraded-cache", runtimeCorpus: upgradedNotes });
  const warmUpgradeReady = await warmUpgrade.waitFor(message => message.type === "ready");
  assert.strictEqual(warmUpgradeReady.source, "indexeddb", "A metadata upgrade must preserve an already valid search index.");
  await warmUpgrade.waitFor(message => message.type === "baseline-cached", 250);
  assert.strictEqual(warmUpgradeShared.persistedCorpus.title8.houseFootnoteMetadata.noteLayoutRevision, 1,
    "A search-index cache hit must save the upgraded editorial-note corpus so refresh does not repeat the upgrade.");
  assert.strictEqual(warmUpgradeShared.corpusReads, 0, "An upgraded snapshot must not reload the outdated corpus.");

  const writesBeforeEarlyWarm = shared.corpusWrites;
  const earlyWarm = createHarness(shared, corpus);
  earlyWarm.send({ type: "init", identity, source: "embedded", awaitEmbeddedPayload: true });
  const earlyReady = await earlyWarm.waitFor(message => message.type === "ready");
  assert.strictEqual(earlyReady.source, "indexeddb", "Early startup did not restore the saved projection independently of its embedded payload.");
  earlyWarm.send({ type: "search", sessionId: "early-warm", generation: 1, requestId: "early-warm-1", query: require("../src/INASearch-Command").parseCommand("alpha"), options: { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } } });
  const earlySearch = await earlyWarm.waitFor(message => message.type === "search-result" && message.sessionId === "early-warm");
  assert.strictEqual(earlySearch.result.totalOccurrences, 1, "A restored projection could not search before the embedded payload arrived.");
  earlyWarm.send({ type: "embedded-corpus-payload", identity, embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(shared.corpusWrites, writesBeforeEarlyWarm, "An early projection cache hit redundantly persisted its later embedded payload.");

  const cancellationStart = warm.messages.length;
  const rapidOptions = { authorities: ["ina"], plan: { branches: [{ kind: "law", scopes: [] }], citationScopes: [] } };
  const parse = require("../src/INASearch-Command").parseCommand;
  warm.send({ type: "search", sessionId: "rapid", generation: 1, requestId: "rapid-1", query: parse("alpha"), options: rapidOptions });
  warm.send({ type: "search", sessionId: "rapid", generation: 2, requestId: "rapid-2", query: parse("target"), options: rapidOptions });
  await warm.waitFor(message => message.type === "search-result" && message.sessionId === "rapid" && message.generation === 2);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(!warm.messages.slice(cancellationStart).some(message => message.type === "search-result" && message.sessionId === "rapid" && message.generation === 1), "A stale search generation replaced a newer result.");

  const nextCorpus = structuredClone(corpus);
  nextCorpus.corpusVersion = "worker-fixture-2";
  shared.persistedCorpus = nextCorpus;
  const nextIdentity = { corpusSchemaVersion: 5, corpusVersion: nextCorpus.corpusVersion, corpusSha256: "b".repeat(64), authorities: ["ina", "cfr"] };
  const deferredRacing = createHarness({ searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 }, corpus);
  deferredRacing.send({ type: "init", identity, source: "embedded", awaitEmbeddedPayload: true });
  await deferredRacing.waitFor(message => message.type === "progress" && message.phase === "projection-build");
  const pendingReplacementStart = deferredRacing.messages.length;
  deferredRacing.send({ type: "corpus-change", identity: nextIdentity, source: "embedded", awaitEmbeddedPayload: true });
  const replacementBuild = await deferredRacing.waitFor(message => message.type === "progress" && message.phase === "projection-build" && deferredRacing.messages.indexOf(message) >= pendingReplacementStart, 250).catch(() => null);
  assert(replacementBuild, "A superseded embedded-payload wait blocked replacement initialization.");
  deferredRacing.send({ type: "embedded-corpus-payload", identity, embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(!deferredRacing.messages.some(message => message.type === "ready"), "A late obsolete payload was used for a replacement initialization.");
  deferredRacing.send({ type: "embedded-corpus-payload", identity: nextIdentity, embeddedPayload: new Blob([JSON.stringify(nextCorpus)]) });
  const replacementPayloadReady = await deferredRacing.waitFor(message => message.type === "ready");
  assert.strictEqual(replacementPayloadReady.identity.corpusVersion, nextCorpus.corpusVersion, "The deferred replacement payload was indexed under an obsolete corpus identity.");
  assert(!deferredRacing.messages.some(message => message.type === "fatal"), "Canceling an obsolete payload wait reported a worker initialization failure.");

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

  const savingShared = { searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 };
  let finishOlderSave;
  const olderSave = new Promise(resolve => { finishOlderSave = resolve; });
  const saving = createHarness(savingShared, corpus, {
    beforeSearchIndexSave: record => record.corpusVersion === corpus.corpusVersion ? olderSave : undefined
  });
  saving.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  await saving.waitFor(message => message.type === "ready" && message.identity?.corpusVersion === corpus.corpusVersion);
  try {
    saving.send({ type: "corpus-change", identity: nextIdentity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(nextCorpus)]) });
    const replacementReady = await saving.waitFor(message => message.type === "ready" && message.identity?.corpusVersion === nextCorpus.corpusVersion, 250).catch(() => null);
    assert(replacementReady, "A replacement projection waited for an obsolete search-index save.");
  } finally { finishOlderSave(); }
  await saving.waitFor(message => message.type === "metric" && message.name === "projection-cache-saved");
  assert.strictEqual([...savingShared.searchIndexes.values()][0].corpusVersion, nextCorpus.corpusVersion, "A slow obsolete save replaced the latest projection cache.");
  assert.strictEqual(saving.messages.filter(message => message.type === "metric" && message.name === "projection-cache-saved").length, 1, "An obsolete search-index save reported success after a corpus change.");

  const failedSave = createHarness({ searchIndexes: new Map(), persistedCorpus: null, corpusWrites: 0, corpusReads: 0 }, corpus, {
    beforeSearchIndexSave: async () => { throw new Error("Search-index storage is full."); }
  });
  failedSave.send({ type: "init", identity, source: "embedded", embeddedPayload: new Blob([JSON.stringify(corpus)]) });
  await failedSave.waitFor(message => message.type === "ready");
  const saveWarning = await failedSave.waitFor(message => message.type === "cache-warning" && message.cache === "search-index");
  assert.match(saveWarning.message, /storage is full/, "Background cache failures did not report their warning.");
  failedSave.send({ type: "search", sessionId: "save-failed", generation: 1, requestId: "save-failed-1", query: parse("alpha"), options: rapidOptions });
  const uncachedSearch = await failedSave.waitFor(message => message.type === "search-result" && message.sessionId === "save-failed");
  assert(uncachedSearch.result.totalOccurrences > 0, "A background cache-write failure disabled legal-text search.");

  const obsolete = createHarness(shared, nextCorpus);
  obsolete.send({ type: "init", identity: { ...nextIdentity, cfrStructureRevision: 1 }, source: "indexeddb" });
  const rejected = await obsolete.waitFor(message => message.type === "fatal");
  assert.match(rejected.message, /No corpus is available/, "A worker built a repaired-release projection from obsolete cached CFR structure.");
  assert(!obsolete.messages.some(message => message.type === "ready"), "An obsolete hierarchy projection became active.");
  console.log("Search worker cache tests passed, including CFR structure-revision rejection.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
