/* INASearch browser-owned storage. Embedded into the standalone build. */
(() => {
  "use strict";

  const DB_NAME = "INASearchStandalone";
  const DB_VERSION = 5;
  const PRIMARY_VAULT_HANDLE_KEY = "primary-vault";
  const ACTIVE_CORPUS_KEY = "active";
  const PREVIOUS_CORPUS_KEY = "previous";
  const STAGING_CORPUS_KEY = "staging";
  const ACTIVE_PROFILE_KEY = "active";
  const PREVIOUS_PROFILE_KEY = "previous";
  const STAGING_PROFILE_KEY = "staging";
  const SEARCH_INDEX_STORE = "search-indexes";
  const STARTUP_METADATA_KEYS = ["last-backup-reminder-at", "last-filesystem-protection-at", "storage-persistence"];
  let resetCachesCleared = false;
  const resetCacheWrite = store => ["corpus", "sources", SEARCH_INDEX_STORE, "metadata", "profiles"].includes(store);

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in globalThis)) { resolve(null); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of ["handles", "corpus", "metadata", "sources", "profiles", SEARCH_INDEX_STORE]) {
          if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INASearch storage could not be opened."));
      request.onblocked = () => reject(new Error("INASearch storage upgrade is blocked by another open copy."));
    });
  }

  async function read(storeName, key) {
    const database = await openDatabase();
    if (!database) return undefined;
    try {
      return await requestResult(database.transaction(storeName, "readonly").objectStore(storeName).get(key));
    } finally {
      database.close();
    }
  }

  async function write(storeName, key, value) {
    if (resetCachesCleared && resetCacheWrite(storeName)) return false;
    const database = await openDatabase();
    if (!database) return false;
    try {
      if (resetCachesCleared && resetCacheWrite(storeName)) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
      });
      return true;
    } finally {
      database.close();
    }
  }

  async function remove(storeName, key) {
    const database = await openDatabase();
    if (!database) return false;
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
      });
      return true;
    } finally {
      database.close();
    }
  }

  async function sha256Bytes(bytes) {
    if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser context.");
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
    return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function compareVersions(left, right) {
    const tokenize = value => String(value || "").match(/\d+|\D+/g) || [];
    const a = tokenize(left), b = tokenize(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const x = a[index] ?? "", y = b[index] ?? "";
      const numbers = /^\d+$/.test(x) && /^\d+$/.test(y);
      const comparison = numbers ? Number(x) - Number(y) : x.localeCompare(y);
      if (comparison) return comparison < 0 ? -1 : 1;
    }
    return 0;
  }

  function validCorpusRecord(record) {
    return Boolean(
      record && (record.recordSchemaVersion === 2 && record.storageFormat === "runtime-json" ||
        record.recordSchemaVersion === 3 && record.storageFormat === "runtime-json-chunks" && Array.isArray(record.chunks)) &&
      Number.isSafeInteger(record.bytes) && record.bytes > 0 &&
      typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256) &&
      record.payload instanceof Blob
    );
  }

  async function corpusRecord(corpus, details = {}) {
    const runtimeSha256 = await sha256Bytes(new TextEncoder().encode(JSON.stringify(corpus)));
    const partition = globalThis.INASearchCorpusShards.partitionPackedCorpus(corpus);
    const encode = async value => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      return { bytes: bytes.byteLength, sha256: await sha256Bytes(bytes), payload: new Blob([bytes], { type: "application/json;charset=utf-8" }) };
    };
    const header = await encode(partition.metadata);
    return {
      recordSchemaVersion: 3,
      storageFormat: "runtime-json-chunks",
      corpusSchemaVersion: Number(corpus?.schemaVersion),
      corpusVersion: String(corpus?.corpusVersion || ""),
      ...header,
      runtimeSha256,
      chunks: await Promise.all(partition.chunks.map(encode)),
      sourceCorpusSha256: typeof details.sourceCorpusSha256 === "string" ? details.sourceCorpusSha256 : "",
      storedAt: new Date().toISOString(),
      legalReferencesPacked: details.legalReferencesPacked === true,
      sourceState: details.sourceState || null,
      reason: String(details.reason || "")
    };
  }

  async function decodeCorpusJson(record) {
    if (!record || !(record.payload instanceof Blob)) throw new Error("The cached corpus content is missing.");
    const bytes = new Uint8Array(await record.payload.arrayBuffer());
    if (bytes.byteLength !== record.bytes) throw new Error("The cached corpus byte count does not match its manifest.");
    if (await sha256Bytes(bytes) !== record.sha256) throw new Error("The cached corpus failed its SHA-256 integrity check.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async function readCorpusChunk(record, id) {
    if (!Number.isInteger(id) || id < 0 || !record.chunks?.[id]) throw new Error("The cached corpus content is missing.");
    const chunk = await decodeCorpusJson(record.chunks[id]);
    if (chunk.id !== id) throw new Error("The cached corpus content has an invalid identity.");
    return chunk;
  }

  async function decodeCorpusRecord(record, options = {}) {
    if (!validCorpusRecord(record)) throw new Error("The cached corpus record is malformed.");
    const corpus = await decodeCorpusJson(record);
    if (Number(corpus?.schemaVersion) !== record.corpusSchemaVersion || String(corpus?.corpusVersion || "") !== record.corpusVersion) {
      throw new Error("The cached corpus identity does not match its manifest.");
    }
    if (record.recordSchemaVersion === 3) {
      const mapping = corpus._shards, used = new Set();
      const validIds = ids => Array.isArray(ids) && ids.every(id => {
        if (id === null) return true;
        if (!Number.isInteger(id) || id < 0 || id >= record.chunks.length) return false;
        used.add(id); return true;
      });
      const groups = { usc: [...(corpus.title8?.sections || []), ...(corpus.referencedUsc?.titles || []).flatMap(title => title.sections || [])], cfr: corpus.cfr?.sections || [], appendix: corpus.cfr?.appendices || [] };
      if (mapping?.v !== 1 || Object.entries(groups).some(([kind, records]) => !validIds(mapping[kind]) || mapping[kind].length !== records.length) ||
        mapping.corpus && !validIds(mapping.corpus) || used.size !== record.chunks.length) throw new Error("The cached corpus catalog has missing or invalid content records.");
    }
    if (record.recordSchemaVersion === 3 && !options.metadataOnly) {
      for (let id = 0; id < record.chunks.length; id++) globalThis.INASearchCorpusShards.mergePackedChunk(corpus, await readCorpusChunk(record, id));
      delete corpus._shards;
    }
    return corpus;
  }

  function validProfileRecord(record) {
    return Boolean(
      record && record.recordSchemaVersion === 1 && record.storageFormat === "json" &&
      Number.isSafeInteger(record.cacheRevision) && record.cacheRevision > 0 &&
      Number.isSafeInteger(record.bytes) && record.bytes > 0 &&
      typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256) &&
      record.payload instanceof Blob
    );
  }

  async function profileRecord(vault, details = {}) {
    const text = JSON.stringify(vault);
    const bytes = new TextEncoder().encode(text);
    const expectedRevision = Math.max(0, Number(details.expectedRevision) || 0);
    const revisionFloor = Math.max(expectedRevision, Number(details.revisionFloor) || 0);
    return {
      recordSchemaVersion: 1,
      storageFormat: "json",
      cacheRevision: revisionFloor + 1,
      bytes: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
      storedAt: new Date().toISOString(),
      reason: String(details.reason || "profile-autosave"),
      fileSyncState: details.fileSyncState && typeof details.fileSyncState === "object" ? details.fileSyncState : { status: "none" },
      payload: new Blob([bytes], { type: "application/json;charset=utf-8" })
    };
  }

  async function decodeProfileRecord(record) {
    if (!validProfileRecord(record)) throw new Error("The saved browser profile record is malformed.");
    const bytes = new Uint8Array(await record.payload.arrayBuffer());
    if (bytes.byteLength !== record.bytes) throw new Error("The saved browser profile byte count does not match its manifest.");
    if (await sha256Bytes(bytes) !== record.sha256) throw new Error("The saved browser profile failed its SHA-256 integrity check.");
    const vault = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!vault || vault.format !== "INASearchData" || Number(vault.schemaVersion) !== 1 || typeof vault.vaultId !== "string" || !Number.isSafeInteger(vault.revision) || vault.revision < 0 || Number(vault.profile?.schemaVersion) !== 5 || !Array.isArray(vault.profile?.notes) || !vault.profile?.preferences || typeof vault.profile.preferences !== "object") {
      throw new Error("The saved browser profile payload is invalid.");
    }
    return vault;
  }

  async function loadActiveProfile({ includeRecoveryState = false } = {}) {
    const active = await read("profiles", ACTIVE_PROFILE_KEY);
    const cacheRevision = Number.isSafeInteger(active?.cacheRevision) ? Math.max(0, active.cacheRevision) : 0;
    const activeSha256 = typeof active?.sha256 === "string" ? active.sha256 : null;
    for (const key of [ACTIVE_PROFILE_KEY, PREVIOUS_PROFILE_KEY]) {
      const record = key === ACTIVE_PROFILE_KEY ? active : await read("profiles", key);
      if (!record) continue;
      try {
        return { vault: await decodeProfileRecord(record), record, slot: key, cacheRevision, activeSha256 };
      } catch (error) {
        await write("metadata", "last-profile-cache-error", { at: new Date().toISOString(), slot: key, message: error?.message || String(error) }).catch(() => {});
      }
    }
    return includeRecoveryState ? { vault: null, record: null, slot: null, cacheRevision, activeSha256 } : null;
  }

  async function saveProfile(vault, details = {}) {
    if (resetCachesCleared) throw new Error("Browser profile saving was stopped by a full reset.");
    const expectedRevision = Math.max(0, Number(details.expectedRevision) || 0);
    const staged = await profileRecord(vault, { ...details, expectedRevision });
    // Verify the exact record shape and payload before it can become active.
    await decodeProfileRecord(staged);
    const stagingKey = `${STAGING_PROFILE_KEY}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
    let database = null;
    let conflictError = null;
    try {
      if (!(await write("profiles", stagingKey, staged))) throw new Error("Browser profile storage is unavailable.");
      const persistedStage = await read("profiles", stagingKey);
      if (resetCachesCleared) throw new Error("Browser profile saving was stopped by a full reset.");
      await decodeProfileRecord(persistedStage);
      database = await openDatabase();
      if (!database) throw new Error("Browser profile storage is unavailable.");
      if (resetCachesCleared) throw new Error("Browser profile saving was stopped by a full reset.");
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("profiles", "readwrite");
        const store = transaction.objectStore("profiles");
        const currentRequest = store.get(ACTIVE_PROFILE_KEY);
        currentRequest.onsuccess = () => {
          const current = currentRequest.result;
          const actualRevision = Number.isSafeInteger(current?.cacheRevision) ? Math.max(0, current.cacheRevision) : 0;
          const actualSha256 = typeof current?.sha256 === "string" ? current.sha256 : null;
          // A cleared cache can reuse an old revision. Match the payload too
          // so a stale window cannot overwrite a different recovered copy.
          if (actualRevision !== expectedRevision || ("expectedSha256" in details && actualSha256 !== details.expectedSha256)) {
            conflictError = new Error(`The saved browser profile changed or is missing (expected revision ${expectedRevision}, found ${actualRevision}).`);
            conflictError.name = "ProfileConflictError";
            transaction.abort();
            return;
          }
          if (current && details.preservePrevious !== true) store.put(current, PREVIOUS_PROFILE_KEY);
          store.put(persistedStage, ACTIVE_PROFILE_KEY);
          store.delete(stagingKey);
        };
        currentRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(conflictError || transaction.error || new Error("The browser profile could not be saved."));
        transaction.onabort = () => reject(conflictError || transaction.error || new Error("The browser profile save was aborted."));
      });
      return { vault: await decodeProfileRecord(persistedStage), record: persistedStage, cacheRevision: persistedStage.cacheRevision };
    } finally {
      database?.close();
      await remove("profiles", stagingKey).catch(() => {});
    }
  }

  async function loadActiveCorpus(options = {}) {
    for (const key of [ACTIVE_CORPUS_KEY, PREVIOUS_CORPUS_KEY]) {
      const record = await read("corpus", key);
      if (!record) continue;
      if (Number(record.corpusSchemaVersion) !== Number(options.corpusSchemaVersion)) continue;
      if (options.minimumVersion && compareVersions(record.corpusVersion, options.minimumVersion) < 0) continue;
      if (Number(options.preferRecordSchemaVersion) > Number(record.recordSchemaVersion) && (!options.minimumVersion || compareVersions(record.corpusVersion, options.minimumVersion) <= 0)) continue;
      try {
        return { corpus: await decodeCorpusRecord(record), record, slot: key };
      } catch (error) {
        if (key === ACTIVE_CORPUS_KEY) await remove("corpus", ACTIVE_CORPUS_KEY).catch(() => {});
        await write("metadata", "last-corpus-cache-error", { at: new Date().toISOString(), slot: key, message: error?.message || String(error) }).catch(() => {});
      }
    }
    return null;
  }

  async function loadStartupSnapshot(options = {}) {
    const database = await openDatabase();
    if (!database) {
      options.onProfileReady?.(null);
      return { available: false, corpus: null, profile: null, metadata: {}, errors: {} };
    }
    let values;
    try {
      const transaction = database.transaction(["corpus", "profiles", "metadata"], "readonly");
      const corpusStore = transaction.objectStore("corpus");
      const profileStore = transaction.objectStore("profiles");
      const metadataStore = transaction.objectStore("metadata");
      values = await Promise.all([
        requestResult(corpusStore.get(ACTIVE_CORPUS_KEY)),
        requestResult(corpusStore.get(PREVIOUS_CORPUS_KEY)),
        requestResult(profileStore.get(ACTIVE_PROFILE_KEY)),
        requestResult(profileStore.get(PREVIOUS_PROFILE_KEY)),
        ...STARTUP_METADATA_KEYS.map(key => requestResult(metadataStore.get(key)))
      ]);
    } finally {
      database.close();
    }
    const errors = {};
    const chooseCorpus = async () => {
      for (const [index, slot] of [ACTIVE_CORPUS_KEY, PREVIOUS_CORPUS_KEY].entries()) {
        const record = values[index];
        if (!record || Number(record.corpusSchemaVersion) !== Number(options.corpusSchemaVersion)) continue;
        if (options.minimumVersion && compareVersions(record.corpusVersion, options.minimumVersion) < 0) continue;
        if (Number(options.preferRecordSchemaVersion) > Number(record.recordSchemaVersion) && (!options.minimumVersion || compareVersions(record.corpusVersion, options.minimumVersion) <= 0)) continue;
        try { return { corpus: await decodeCorpusRecord(record, { metadataOnly: options.deferCorpus === true }), record, slot }; }
        catch (error) { errors[`corpus:${slot}`] = error?.message || String(error); }
      }
      return null;
    };
    const chooseProfile = async () => {
      // A recovered payload belongs to the previous slot, but the next save
      // must compare against the active slot read in this same snapshot.
      const cacheRevision = Number.isSafeInteger(values[2]?.cacheRevision) ? Math.max(0, values[2].cacheRevision) : 0;
      const activeSha256 = typeof values[2]?.sha256 === "string" ? values[2].sha256 : null;
      for (const [offset, slot] of [ACTIVE_PROFILE_KEY, PREVIOUS_PROFILE_KEY].entries()) {
        const record = values[2 + offset];
        if (!record) continue;
        try { return { vault: await decodeProfileRecord(record), record, slot, cacheRevision, activeSha256 }; }
        catch (error) { errors[`profile:${slot}`] = error?.message || String(error); }
      }
      return null;
    };
    const [corpus, profile] = await Promise.all([chooseCorpus(), chooseProfile().then(profile => { options.onProfileReady?.(profile); return profile; })]);
    const metadata = Object.fromEntries(STARTUP_METADATA_KEYS.map((key, index) => [key, values[4 + index]]));
    return { available: true, corpus, profile, metadata, errors };
  }

  async function loadSearchIndex(identity) {
    const key = typeof identity === "string" ? identity : identity?.key;
    if (!key) return null;
    return await read(SEARCH_INDEX_STORE, key) || null;
  }

  async function removeStaleSearchIndexes(currentKey = "") {
    if (resetCachesCleared) return false;
    const database = await openDatabase();
    if (!database) return false;
    try {
      if (resetCachesCleared) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(SEARCH_INDEX_STORE, "readwrite");
        const store = transaction.objectStore(SEARCH_INDEX_STORE);
        const request = store.getAllKeys();
        request.onsuccess = () => {
          for (const key of request.result || []) if (String(key) !== String(currentKey)) store.delete(key);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Stale search indexes could not be removed."));
        transaction.onabort = () => reject(transaction.error || new Error("Search-index cleanup was aborted."));
      });
      return true;
    } finally {
      database.close();
    }
  }

  async function saveSearchIndex(record) {
    if (resetCachesCleared) return false;
    if (!record?.key || record.recordSchemaVersion !== 1 || !record.payload || !Array.isArray(record.payload.fragments) || !Array.isArray(record.payload.hierarchyNodes)) {
      throw new Error("The search-index cache record is malformed.");
    }
    const database = await openDatabase();
    if (!database) throw new Error("Browser search-index storage is unavailable.");
    try {
      if (resetCachesCleared) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(SEARCH_INDEX_STORE, "readwrite");
        const store = transaction.objectStore(SEARCH_INDEX_STORE);
        store.put(record, record.key);
        const keysRequest = store.getAllKeys();
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result || []) if (String(key) !== String(record.key)) store.delete(key);
        };
        keysRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("The search index could not be saved."));
        transaction.onabort = () => reject(transaction.error || new Error("The search-index save was aborted."));
      });
      return true;
    } finally {
      database.close();
    }
  }

  async function activateCorpus(corpus, details = {}) {
    if (resetCachesCleared) return false;
    const staged = await corpusRecord(corpus, details);
    if (!await write("corpus", STAGING_CORPUS_KEY, staged)) return false;
    // Decode what IndexedDB returned, not the in-memory object, before activation.
    const persistedStage = await read("corpus", STAGING_CORPUS_KEY);
    if (resetCachesCleared) return false;
    await decodeCorpusRecord(persistedStage);
    const database = await openDatabase();
    if (!database) return false;
    try {
      if (resetCachesCleared) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("corpus", "readwrite");
        const store = transaction.objectStore("corpus");
        const currentRequest = store.get(ACTIVE_CORPUS_KEY);
        currentRequest.onsuccess = () => {
          if (currentRequest.result) store.put(currentRequest.result, PREVIOUS_CORPUS_KEY);
          store.put(persistedStage, ACTIVE_CORPUS_KEY);
          store.delete(STAGING_CORPUS_KEY);
        };
        currentRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("The staged corpus could not be activated."));
        transaction.onabort = () => reject(transaction.error || new Error("Corpus activation was aborted."));
      });
      return true;
    } finally {
      database.close();
    }
  }

  async function ensureActiveCorpus(corpus, details = {}) {
    const current = await read("corpus", ACTIVE_CORPUS_KEY);
    if (current && (Number(current.recordSchemaVersion) >= 3 || compareVersions(current.corpusVersion, corpus?.corpusVersion) > 0) && Number(current.corpusSchemaVersion) === Number(corpus?.schemaVersion) && compareVersions(current.corpusVersion, corpus?.corpusVersion) >= 0) {
      try { await decodeCorpusRecord(current); return false; }
      catch { await remove("corpus", ACTIVE_CORPUS_KEY).catch(() => {}); }
    }
    return activateCorpus(corpus, { ...details, reason: details.reason || "embedded-baseline" });
  }

  async function storeSourceArtifact(key, value) {
    if (!key || !value || typeof value !== "object") throw new Error("A source artifact key and record are required.");
    return write("sources", key, value);
  }

  async function clearResetCaches() {
    // Keep this window's late callbacks from restoring its pre-reset corpus.
    // A fresh page load creates a new storage runtime for the embedded edition.
    resetCachesCleared = true;
    let database;
    try {
      database = await openDatabase();
      if (!database) { resetCachesCleared = false; return false; }
      await new Promise((resolve, reject) => {
        const stores = ["corpus", "sources", SEARCH_INDEX_STORE, "metadata", "profiles"];
        const transaction = database.transaction(stores, "readwrite");
        for (const name of stores.slice(0, -1)) transaction.objectStore(name).clear();
        // The newly saved blank profile remains active. Its old recovery copies
        // must not bring deleted personal content back after a reset.
        const profiles = transaction.objectStore("profiles");
        const keysRequest = profiles.getAllKeys();
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result || []) if (key !== ACTIVE_PROFILE_KEY) profiles.delete(key);
        };
        keysRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Reset storage cleanup failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Reset storage cleanup was aborted."));
      });
      return true;
    } catch (error) {
      resetCachesCleared = false;
      throw error;
    } finally { database?.close(); }
  }

  async function requestPersistentStorage() {
    const storage = globalThis.navigator?.storage;
    const checkedAt = new Date().toISOString();
    if (!storage?.persisted) return { supported: false, persisted: false, requested: false, checkedAt };
    let persisted = await storage.persisted();
    let requested = false;
    if (!persisted && storage.persist) {
      requested = true;
      persisted = await storage.persist();
    }
    const result = { supported: true, persisted: Boolean(persisted), requested, checkedAt };
    await write("metadata", "storage-persistence", result).catch(() => {});
    return result;
  }

  const api = Object.freeze({
    DB_NAME,
    DB_VERSION,
    SEARCH_INDEX_STORE,
    PRIMARY_VAULT_HANDLE_KEY,
    compareVersions,
    sha256Bytes,
    openDatabase,
    read,
    write,
    remove,
    loadActiveCorpus,
    loadStartupSnapshot,
    activateCorpus,
    ensureActiveCorpus,
    decodeCorpusRecord,
    readCorpusChunk,
    loadSearchIndex,
    saveSearchIndex,
    removeStaleSearchIndexes,
    loadActiveProfile,
    saveProfile,
    profileRecord,
    decodeProfileRecord,
    storeSourceArtifact,
    clearResetCaches,
    requestPersistentStorage,
    loadVaultHandle: () => read("handles", PRIMARY_VAULT_HANDLE_KEY),
    storeVaultHandle: handle => write("handles", PRIMARY_VAULT_HANDLE_KEY, handle),
    forgetVaultHandle: () => remove("handles", PRIMARY_VAULT_HANDLE_KEY),
    getMetadata: key => read("metadata", key),
    setMetadata: (key, value) => write("metadata", key, value)
  });
  globalThis.INASearchStorage = api;
})();
