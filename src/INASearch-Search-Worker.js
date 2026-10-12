/* INASearch occurrence-search worker. Embedded as inert source in the standalone file. */
(() => {
  "use strict";

  const scope = globalThis;
  const runtime = scope.INA_SEARCH_OCCURRENCE;
  const storage = scope.INASearchStorage;
  const packing = scope.INASearchCorpusPacking;
  if (!runtime) throw new Error("The occurrence-search runtime is unavailable in the worker.");

  let projection = null;
  let projectionPromise = null;
  let projectionCacheSavePromise = Promise.resolve();
  let identity = null;
  let initializationGeneration = 0;
  let embeddedPayloadWaiter = null;
  const sessionGenerations = new Map();
  const searchResults = new Map();

  const elapsed = started => (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
  const startedAt = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  const send = value => scope.postMessage(value);
  const metric = (name, started, detail = {}) => send({ type: "metric", name, duration: elapsed(started), detail });

  function settleEmbeddedPayload(value = null, generation = initializationGeneration) {
    if (!embeddedPayloadWaiter || embeddedPayloadWaiter.generation !== generation) return;
    const waiter = embeddedPayloadWaiter;
    embeddedPayloadWaiter = null;
    waiter.resolve(value);
  }

  async function corpusFromInitialization(message) {
    // The main thread may have merged a new embedded statute release with
    // newer locally downloaded CFRs. That verified snapshot supersedes storage.
    if (message.source === "upgraded-cache" && message.runtimeCorpus) return message.runtimeCorpus;
    if (message.awaitEmbeddedPayload && !(message.embeddedPayload instanceof Blob)) {
      const supplied = await message.embeddedPayloadReady;
      if (!supplied) return null;
      message = { ...message, embeddedPayload: supplied.embeddedPayload };
      if (!(message.embeddedPayload instanceof Blob)) {
        throw new Error("The deferred embedded corpus payload is missing or invalid.");
      }
    }
    if (message.embeddedPayload instanceof Blob) {
      const parsed = JSON.parse(await message.embeddedPayload.text());
      return packing?.hydratePackedCorpus(parsed) || parsed;
    }
    const cached = await storage?.loadActiveCorpus?.({
      corpusSchemaVersion: message.identity?.corpusSchemaVersion,
      minimumVersion: message.identity?.corpusVersion
    });
    const corpus = cached?.corpus || null;
    if (message.identity?.cfrStructureRevision && corpus?.cfr?.structureRevision !== message.identity.cfrStructureRevision) return null;
    return corpus;
  }

  async function persistRuntimeCorpus(corpus, message) {
    if (!storage?.ensureActiveCorpus) return;
    try {
      if (message.source === "upgraded-cache" && storage.activateCorpus) {
        await storage.activateCorpus(corpus, { reason: "embedded-statute-upgrade" });
        send({ type: "baseline-cached", corpusVersion: corpus?.corpusVersion || "" });
        return;
      }
      await storage.ensureActiveCorpus(corpus, {
        reason: message.source === "embedded" ? "automatic-embedded-baseline" : "runtime-cache-migration",
        legalReferencesPacked: message.source === "embedded" || message.legalReferencesPacked === true,
        sourceCorpusSha256: message.identity?.corpusSha256 || "",
        sourceState: message.sourceState || { authority: "embedded-release" }
      });
      send({ type: "baseline-cached", corpusVersion: corpus?.corpusVersion || "" });
    } catch (error) {
      send({ type: "cache-warning", cache: "corpus", message: error?.message || String(error) });
    }
  }

  async function initialize(message, generation) {
    const initStarted = startedAt();
    const nextIdentity = runtime.projectionIdentity(null, message.identity || {});
    identity = nextIdentity;
    projection = null;
    searchResults.clear();
    sessionGenerations.clear();
    send({ type: "progress", phase: "projection-cache" });
    if (storage?.loadSearchIndex) {
      const restoreStarted = startedAt();
      try {
        const record = await storage.loadSearchIndex(nextIdentity);
        if (generation !== initializationGeneration) return null;
        if (record) {
          const restored = runtime.restorePersistedProjection(record, nextIdentity);
          if (generation !== initializationGeneration) return null;
          projection = restored;
          metric("projection-cache-hit", restoreStarted, { fragments: restored.fragments.length });
          send({ type: "ready", source: "indexeddb", identity: nextIdentity, fragments: restored.fragments.length });
          metric("projection-ready", initStarted, { source: "indexeddb" });
          settleEmbeddedPayload(null, generation);
          // A valid search index does not imply that the upgraded reader data
          // has been saved. Otherwise every refresh repeats the corpus upgrade.
          if (message.source === "upgraded-cache" || message.corpusCacheNeedsUpgrade || !message.awaitEmbeddedPayload && message.source === "embedded" && message.embeddedPayload instanceof Blob) void corpusFromInitialization(message).then(corpus => generation === initializationGeneration ? persistRuntimeCorpus(corpus, message) : null).catch(error => send({ type: "cache-warning", cache: "corpus", message: error?.message || String(error) }));
          return restored;
        }
        metric("projection-cache-miss", restoreStarted);
      } catch (error) {
        send({ type: "cache-warning", cache: "search-index", message: error?.message || String(error) });
      }
    }
    send({ type: "progress", phase: "projection-build" });
    const corpusStarted = startedAt();
    const corpus = await corpusFromInitialization(message);
    if (generation !== initializationGeneration) return null;
    if (!corpus) throw new Error("No corpus is available to build the legal-text search projection.");
    metric("worker-corpus-ready", corpusStarted, { source: message.source || "indexeddb" });
    const buildStarted = startedAt();
    const built = await runtime.buildProjectionAsync(corpus, {
      sliceMs: 12,
      isCancelled: () => generation !== initializationGeneration,
      onProgress: progress => send({ type: "progress", phase: "projection-build", progress })
    });
    if (generation !== initializationGeneration) return null;
    projection = built;
    metric("projection-built", buildStarted, { fragments: built.fragments.length });
    send({ type: "ready", source: "built", identity: nextIdentity, fragments: built.fragments.length });
    metric("projection-ready", initStarted, { source: "built" });
    void persistRuntimeCorpus(corpus, message);
    if (storage?.saveSearchIndex) {
      // Pending searches can use the completed projection while its cache saves.
      // Serialize writes so a slow older save cannot replace a newer corpus.
      projectionCacheSavePromise = projectionCacheSavePromise.then(async () => {
        if (generation !== initializationGeneration) return;
        const saveStarted = startedAt();
        try {
          await storage.saveSearchIndex(runtime.toPersistedProjection(built, nextIdentity));
          if (generation !== initializationGeneration) return;
          metric("projection-cache-saved", saveStarted, { fragments: built.fragments.length });
        } catch (error) {
          if (generation !== initializationGeneration) return;
          send({ type: "cache-warning", cache: "search-index", message: error?.message || String(error) });
        }
      });
    }
    return built;
  }

  function searchResultDto(result, requestId) {
    return {
      requestId,
      sections: result.sections || [],
      hierarchy: result.hierarchy || [],
      totalOccurrences: Number(result.totalOccurrences || 0),
      stats: result.stats || null,
    };
  }

  async function runSearch(message) {
    const sessionId = String(message.sessionId || "default");
    const generation = Number(message.generation) || 0;
    sessionGenerations.set(sessionId, generation);
    const activeProjection = projection || await projectionPromise;
    if (!activeProjection) throw new Error("The legal-text search projection is unavailable.");
    const options = { ...(message.options || {}) };
    options.sliceMs = 12;
    options.generation = generation;
    options.isCancelled = () => sessionGenerations.get(sessionId) !== generation;
    const searchStarted = startedAt();
    const result = await scope.INA_SEARCH_QUERY.searchAsync(activeProjection, message.query, options);
    if (sessionGenerations.get(sessionId) !== generation) return;
    const requestId = String(message.requestId);
    searchResults.set(requestId, result);
    while (searchResults.size > 12) searchResults.delete(searchResults.keys().next().value);
    metric("search-complete", searchStarted, { requestId, generation, totalOccurrences: result.totalOccurrences });
    send({ type: "search-result", sessionId, generation, result: searchResultDto(result, requestId) });
  }

  function materialize(message) {
    const result = searchResults.get(String(message.requestId));
    if (!result) throw new Error("The requested search result is no longer available.");
    const page = result.materializeOccurrences(message.options || {});
    send({ type: "page-result", pageId: String(message.pageId), requestId: String(message.requestId), page });
  }

  scope.addEventListener("message", event => {
    const message = event.data || {};
    if (message.type === "init" || message.type === "corpus-change") {
      // A replacement initialization must release a superseded payload wait.
      settleEmbeddedPayload();
      const generation = ++initializationGeneration;
      let initializationMessage = message;
      if (message.awaitEmbeddedPayload && !(message.embeddedPayload instanceof Blob)) {
        const embeddedPayloadReady = new Promise(resolve => {
          embeddedPayloadWaiter = { generation, identityKey: runtime.projectionIdentity(null, message.identity || {}).key, resolve };
        });
        initializationMessage = { ...message, embeddedPayloadReady };
      }
      const previous = projectionPromise;
      projection = null;
      searchResults.clear();
      sessionGenerations.clear();
      const pending = Promise.resolve(previous).catch(() => null).then(() => {
        if (generation !== initializationGeneration) return null;
        return initialize(initializationMessage, generation);
      }).catch(error => {
        if (generation !== initializationGeneration || error?.name === "AbortError") return null;
        if (projectionPromise === pending) projectionPromise = null;
        send({ type: "fatal", phase: "initialize", message: error?.message || String(error) });
        return null;
      });
      projectionPromise = pending;
      return;
    }
    if (message.type === "embedded-corpus-payload") {
      if (!embeddedPayloadWaiter || embeddedPayloadWaiter.generation !== initializationGeneration) return;
      if (message.identity && runtime.projectionIdentity(null, message.identity).key !== embeddedPayloadWaiter.identityKey) return;
      settleEmbeddedPayload(message);
      return;
    }
    if (message.type === "search") {
      void runSearch(message).catch(error => {
        if (error?.name !== "AbortError") send({ type: "search-error", sessionId: String(message.sessionId || "default"), generation: Number(message.generation) || 0, message: error?.message || String(error) });
      });
      return;
    }
    if (message.type === "cancel") {
      const sessionId = String(message.sessionId || "default");
      sessionGenerations.set(sessionId, Math.max(Number(message.generation) || 0, (sessionGenerations.get(sessionId) || 0) + 1));
      return;
    }
    if (message.type === "materialize") {
      try { materialize(message); }
      catch (error) { send({ type: "page-error", pageId: String(message.pageId), message: error?.message || String(error) }); }
      return;
    }
    if (message.type === "dispose-result") searchResults.delete(String(message.requestId));
  });
})();
