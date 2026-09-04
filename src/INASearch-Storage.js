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
    const database = await openDatabase();
    if (!database) return false;
    try {
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
      record && ((record.recordSchemaVersion === 1 && record.storageFormat === "json") || (record.recordSchemaVersion === 2 && record.storageFormat === "runtime-json")) &&
      Number.isSafeInteger(record.bytes) && record.bytes > 0 &&
      typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256) &&
      record.payload instanceof Blob
    );
  }

  async function corpusRecord(corpus, details = {}) {
    const text = JSON.stringify(corpus);
    const bytes = new TextEncoder().encode(text);
    return {
      recordSchemaVersion: 2,
      storageFormat: "runtime-json",
      corpusSchemaVersion: Number(corpus?.schemaVersion),
      corpusVersion: String(corpus?.corpusVersion || ""),
      bytes: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
      sourceCorpusSha256: typeof details.sourceCorpusSha256 === "string" ? details.sourceCorpusSha256 : "",
      storedAt: new Date().toISOString(),
      legalReferencesPacked: details.legalReferencesPacked === true,
      sourceState: details.sourceState || null,
      reason: String(details.reason || ""),
      payload: new Blob([bytes], { type: "application/json;charset=utf-8" })
    };
  }

  async function decodeCorpusRecord(record) {
    if (!validCorpusRecord(record)) throw new Error("The cached corpus record is malformed.");
    const bytes = new Uint8Array(await record.payload.arrayBuffer());
    if (bytes.byteLength !== record.bytes) throw new Error("The cached corpus byte count does not match its manifest.");
    if (await sha256Bytes(bytes) !== record.sha256) throw new Error("The cached corpus failed its SHA-256 integrity check.");
    const corpus = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (Number(corpus?.schemaVersion) !== record.corpusSchemaVersion || String(corpus?.corpusVersion || "") !== record.corpusVersion) {
      throw new Error("The cached corpus identity does not match its manifest.");
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
    return {
      recordSchemaVersion: 1,
      storageFormat: "json",
      cacheRevision: expectedRevision + 1,
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
    if (!vault || vault.format !== "INASearchData" || Number(vault.schemaVersion) !== 1 || typeof vault.vaultId !== "string" || !Number.isSafeInteger(vault.revision) || vault.revision < 0 || ![1, 2, 3, 4, 5].includes(Number(vault.profile?.schemaVersion)) || !Array.isArray(vault.profile?.notes) || !vault.profile?.preferences || typeof vault.profile.preferences !== "object") {
      throw new Error("The saved browser profile payload is invalid.");
    }
    return vault;
  }

  async function loadActiveProfile() {
    for (const key of [ACTIVE_PROFILE_KEY, PREVIOUS_PROFILE_KEY]) {
      const record = await read("profiles", key);
      if (!record) continue;
      try {
        return { vault: await decodeProfileRecord(record), record, slot: key };
      } catch (error) {
        if (key === ACTIVE_PROFILE_KEY) await remove("profiles", ACTIVE_PROFILE_KEY).catch(() => {});
        await write("metadata", "last-profile-cache-error", { at: new Date().toISOString(), slot: key, message: error?.message || String(error) }).catch(() => {});
      }
    }
    return null;
  }

  async function saveProfile(vault, details = {}) {
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
      await decodeProfileRecord(persistedStage);
      database = await openDatabase();
      if (!database) throw new Error("Browser profile storage is unavailable.");
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("profiles", "readwrite");
        const store = transaction.objectStore("profiles");
        const currentRequest = store.get(ACTIVE_PROFILE_KEY);
        currentRequest.onsuccess = () => {
          const current = currentRequest.result;
          const actualRevision = Number.isSafeInteger(current?.cacheRevision) ? current.cacheRevision : 0;
          if (actualRevision !== expectedRevision) {
            conflictError = new Error(`The browser profile changed in another window (expected revision ${expectedRevision}, found ${actualRevision}).`);
            conflictError.name = "ProfileConflictError";
            transaction.abort();
            return;
          }
          if (current) store.put(current, PREVIOUS_PROFILE_KEY);
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
    if (!database) return { available: false, corpus: null, profile: null, metadata: {}, errors: {} };
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
        try { return { corpus: await decodeCorpusRecord(record), record, slot }; }
        catch (error) { errors[`corpus:${slot}`] = error?.message || String(error); }
      }
      return null;
    };
    const chooseProfile = async () => {
      for (const [offset, slot] of [ACTIVE_PROFILE_KEY, PREVIOUS_PROFILE_KEY].entries()) {
        const record = values[2 + offset];
        if (!record) continue;
        try { return { vault: await decodeProfileRecord(record), record, slot }; }
        catch (error) { errors[`profile:${slot}`] = error?.message || String(error); }
      }
      return null;
    };
    const [corpus, profile] = await Promise.all([chooseCorpus(), chooseProfile()]);
    const metadata = Object.fromEntries(STARTUP_METADATA_KEYS.map((key, index) => [key, values[4 + index]]));
    return { available: true, corpus, profile, metadata, errors };
  }

  async function loadSearchIndex(identity) {
    const key = typeof identity === "string" ? identity : identity?.key;
    if (!key) return null;
    return await read(SEARCH_INDEX_STORE, key) || null;
  }

  async function removeStaleSearchIndexes(currentKey = "") {
    const database = await openDatabase();
    if (!database) return false;
    try {
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
    if (!record?.key || record.recordSchemaVersion !== 1 || !record.payload || !Array.isArray(record.payload.fragments) || !Array.isArray(record.payload.hierarchyNodes) || !Array.isArray(record.payload.citationSources)) {
      throw new Error("The search-index cache record is malformed.");
    }
    const database = await openDatabase();
    if (!database) throw new Error("Browser search-index storage is unavailable.");
    try {
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
    const staged = await corpusRecord(corpus, details);
    await write("corpus", STAGING_CORPUS_KEY, staged);
    // Decode what IndexedDB returned, not the in-memory object, before activation.
    const persistedStage = await read("corpus", STAGING_CORPUS_KEY);
    await decodeCorpusRecord(persistedStage);
    const database = await openDatabase();
    if (!database) return false;
    try {
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
    if (current && Number(current.recordSchemaVersion) >= 2 && Number(current.corpusSchemaVersion) === Number(corpus?.schemaVersion) && compareVersions(current.corpusVersion, corpus?.corpusVersion) >= 0) {
      try { await decodeCorpusRecord(current); return false; }
      catch { await remove("corpus", ACTIVE_CORPUS_KEY).catch(() => {}); }
    }
    return activateCorpus(corpus, { ...details, reason: details.reason || "embedded-baseline" });
  }

  async function storeSourceArtifact(key, value) {
    if (!key || !value || typeof value !== "object") throw new Error("A source artifact key and record are required.");
    return write("sources", key, value);
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
    loadSearchIndex,
    saveSearchIndex,
    removeStaleSearchIndexes,
    loadActiveProfile,
    saveProfile,
    profileRecord,
    decodeProfileRecord,
    storeSourceArtifact,
    requestPersistentStorage,
    loadVaultHandle: () => read("handles", PRIMARY_VAULT_HANDLE_KEY),
    storeVaultHandle: handle => write("handles", PRIMARY_VAULT_HANDLE_KEY, handle),
    forgetVaultHandle: () => remove("handles", PRIMARY_VAULT_HANDLE_KEY),
    getMetadata: key => read("metadata", key),
    setMetadata: (key, value) => write("metadata", key, value)
  });
  globalThis.INASearchStorage = api;
})();
