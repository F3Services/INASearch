#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const functionSource = require("./test-function-source");
const storageSource = fs.readFileSync(require.resolve("../src/INASearch-Storage.js"), "utf8");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
const profile = { schemaVersion: 5, notes: [{ id: "test-note", text: "Keep the current window's work" }], highlights: [{ id: "test-highlight" }], preferences: { theme: "dark" } };
const vault = { format: "INASearchData", schemaVersion: 1, vaultId: "test-profile-vault", revision: 3, profile };

// Only the IndexedDB boundary is replaced. Validation, recovery, CAS, and the
// application's save paths below execute their actual production functions.
function storageFixture() {
  const stores = { profiles: new Map(), corpus: new Map(), metadata: new Map() };
  let transactions = Promise.resolve();
  const database = {
    close() {},
    transaction() {
      const changes = [];
      let aborted = false;
      const ready = transactions;
      let complete;
      transactions = new Promise(resolve => { complete = resolve; });
      const transaction = {
        abort() { aborted = true; },
        objectStore(name) {
          return {
            get(key) {
              const request = {};
              ready.then(() => {
                request.result = structuredClone(stores[name].get(key));
                request.onsuccess?.();
              });
              return request;
            },
            put(value, key) { changes.push(() => stores[name].set(key, value)); },
            delete(key) { changes.push(() => stores[name].delete(key)); }
          };
        }
      };
      ready.then(() => setImmediate(() => {
        if (aborted) transaction.onabort?.();
        else {
          for (const change of changes) change();
          transaction.oncomplete?.();
        }
        complete();
      }));
      return transaction;
    }
  };
  const context = vm.createContext({
    Blob, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto,
    resetCachesCleared: false,
    ACTIVE_PROFILE_KEY: "active", PREVIOUS_PROFILE_KEY: "previous", STAGING_PROFILE_KEY: "staging",
    ACTIVE_CORPUS_KEY: "active", PREVIOUS_CORPUS_KEY: "previous", STARTUP_METADATA_KEYS: [],
    openDatabase: async () => database,
    read: async (name, key) => structuredClone(stores[name].get(key)),
    write: async (name, key, value) => { stores[name].set(key, value); return true; },
    remove: async (name, key) => { stores[name].delete(key); return true; }
  });
  for (const name of ["requestResult", "sha256Bytes", "validProfileRecord", "profileRecord", "decodeProfileRecord", "loadActiveProfile", "loadStartupSnapshot", "saveProfile"]) {
    vm.runInContext(functionSource(storageSource, name), context);
  }
  return { stores, storage: context };
}

function applicationFixture(storage, state = {}) {
  const messages = [];
  const context = vm.createContext({
    Date, String,
    state: { cacheRevision: 7, profileRevision: 1, profileChanged: true, saveQueue: Promise.resolve(), vaultRevision: 3, view: "search", ...state },
    profileSnapshot: () => structuredClone(profile),
    updateSaveStatus() {}, updateProfileSummary() {}, renderSources() {},
    markFilesystemProtection: async () => {}, requestProfileStoragePersistence: async () => {},
    validateVaultDocument: value => value,
    vaultDocument: snapshot => ({ ...vault, profile: snapshot }),
    toast: message => messages.push(message),
    INASearchStorage: storage
  });
  for (const name of ["saveVaultInBrowser", "mirrorVaultInBrowser", "queueProfileWrite"]) {
    vm.runInContext(functionSource(template, name), context);
  }
  return { app: context, messages };
}

test("main navigation expands by default and remembers collapse and reopen across browser sessions", async () => {
  const { stores, storage } = storageFixture();
  const blankScope = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/INASearch-Profile.js"), "utf8"), blankScope);
  const initialProfile = structuredClone(blankScope.window.INA_SEARCH_PROFILE);
  stores.profiles.set("active", await storage.profileRecord({ ...vault, profile: initialProfile }, { expectedRevision: 6 }));
  const { app } = applicationFixture(storage, {
    profileChanged: false, statuteNavigationKind: "usc", statuteNavigationSectionId: "8-1101",
    statuteNavigationLocation: { view: "reader" }, selected: { item: { id: "8-1101" } }
  });
  let scheduledSave;
  Object.assign(app, {
    profile: initialProfile, corpus: null, structuredCloneSafe: structuredClone,
    els: { mainNavigatorToggle: { focus() {} } },
    captureMainReadingAnchor: () => null, restoreMainReadingAnchor() {}, refreshLegalNavigatorVisibility() {},
    requestAnimationFrame: callback => callback(),
    clearTimeout() { scheduledSave = null; },
    setTimeout(callback) { scheduledSave = callback; return 1; }
  });
  for (const name of ["isMainLegalReader", "legalNavigatorVisibleForCurrentContext", "emptyReferenceInsertions", "normalizeReferenceInsertions", "referenceInsertionPersistenceRoot", "profileSnapshot", "markProfileChanged", "setMainNavigatorCollapsed"]) {
    vm.runInContext(functionSource(template, name), app);
  }
  assert.equal(app.legalNavigatorVisibleForCurrentContext(), true, "A fresh profile must show main navigation");
  for (const [collapsed, visible] of [[true, false], [false, true]]) {
    assert.equal(app.setMainNavigatorCollapsed(collapsed), true);
    assert.equal(typeof scheduledSave, "function", "Changing main navigation must queue profile autosave");
    await scheduledSave();
    assert.equal(app.state.profileChanged, false);
    const reloaded = await storage.loadActiveProfile();
    app.profile = structuredClone(reloaded.vault.profile);
    assert.equal(app.profile.preferences.mainNavigatorCollapsed, collapsed, "Browser reload must retain the chosen state");
    assert.equal(app.legalNavigatorVisibleForCurrentContext(), visible, "The reopened reader must use the saved state");
  }
});

for (const first of ["autosave", "mirror"]) {
  test(`one window can overlap ${first} with the other save path`, async () => {
    const { stores, storage } = storageFixture();
    stores.profiles.set("active", await storage.profileRecord(vault, { expectedRevision: 6 }));
    let release, started;
    const blocked = new Promise(resolve => { release = resolve; });
    const firstStarted = new Promise(resolve => { started = resolve; });
    let calls = 0;
    const { app, messages } = applicationFixture({
      async saveProfile(value, details) {
        if (++calls === 1) { started(); await blocked; }
        return storage.saveProfile(value, details);
      }
    });
    const firstSave = first === "autosave" ? app.queueProfileWrite() : app.mirrorVaultInBrowser(vault);
    await firstStarted;
    const otherSave = first === "autosave" ? app.mirrorVaultInBrowser(vault) : app.queueProfileWrite();
    await new Promise(setImmediate);
    release();
    const results = await Promise.all([firstSave, otherSave]);
    assert.equal(results[first === "mirror" ? 0 : 1], true, "A window mistook its own autosave for an external edit");
    assert.equal(app.state.browserSaveConflict, false, "Overlapping saves falsely stopped autosaving");
    assert.equal(app.state.profileChanged, false);
    assert.equal(app.state.cacheRevision, 9);
    assert.deepEqual(messages, []);
  });
}

for (const loader of ["loadStartupSnapshot", "loadActiveProfile"]) {
  for (const activeState of ["corrupt", "missing", "invalid-revision"]) {
    test(`${loader}: ${activeState} active profile recovers without a false conflict`, async () => {
      const { stores, storage } = storageFixture();
      const previous = await storage.profileRecord(vault, { expectedRevision: 6 });
      stores.profiles.set("previous", previous);
      if (activeState === "corrupt") stores.profiles.set("active", { ...await storage.profileRecord(vault, { expectedRevision: 7 }), sha256: "0".repeat(64) });
      if (activeState === "invalid-revision") stores.profiles.set("active", { ...await storage.profileRecord(vault, { expectedRevision: 7 }), cacheRevision: -1 });
      const result = await storage[loader]();
      const loaded = loader === "loadStartupSnapshot" ? result.profile : result;
      assert.equal(loaded.slot, "previous");
      assert.equal(loaded.cacheRevision, activeState === "corrupt" ? 8 : 0, "Recovery used the backup's revision instead of the active storage revision");
      const { app } = applicationFixture(storage);
      vm.runInContext(functionSource(template, "useBrowserProfileRevision"), app);
      app.useBrowserProfileRevision(loaded);
      await app.queueProfileWrite();
      assert.equal(app.state.browserSaveConflict, false);
      assert.equal(app.state.profileChanged, false);
      assert.equal(app.state.preservePreviousBrowserProfile, false);
      assert.equal(stores.profiles.get("previous"), previous, "Recovery replaced the good backup with a damaged record");
      assert.deepEqual(JSON.parse(JSON.stringify(await storage.decodeProfileRecord(stores.profiles.get("active")))), vault);
      const repaired = stores.profiles.get("active");
      await app.queueProfileWrite(true);
      assert.equal(stores.profiles.get("previous").sha256, repaired.sha256, "Normal saves did not resume backup rotation after recovery");
    });
  }
}

test("a real external revision still stops autosaving and keeps working edits", async () => {
  const { stores, storage } = storageFixture();
  stores.profiles.set("active", await storage.profileRecord(vault, { expectedRevision: 7 }));
  const { app } = applicationFixture(storage);
  await app.queueProfileWrite();
  assert.equal(app.state.browserSaveConflict, true);
  assert.equal(app.state.profileChanged, true);
  assert.equal(stores.profiles.get("active").cacheRevision, 8);
});

test("an external save after fallback is never silently overwritten", async () => {
  const { stores, storage } = storageFixture();
  stores.profiles.set("active", { ...await storage.profileRecord(vault, { expectedRevision: 7 }), sha256: "0".repeat(64) });
  stores.profiles.set("previous", await storage.profileRecord(vault, { expectedRevision: 6 }));
  const loaded = (await storage.loadStartupSnapshot()).profile;
  stores.profiles.set("active", await storage.profileRecord(vault, { expectedRevision: 8 }));
  await assert.rejects(storage.saveProfile(vault, { expectedRevision: loaded.cacheRevision, preservePrevious: true }), { name: "ProfileConflictError" });
  assert.equal(stores.profiles.get("active").cacheRevision, 9);
});

function recoveryApplication(storage) {
  const fixture = applicationFixture(storage, { browserSaveConflict: true, browserSaveError: "revision conflict", vaultId: vault.vaultId });
  const { app } = fixture;
  app.workingProfile = structuredClone(profile);
  app.profileSnapshot = () => structuredClone(app.workingProfile);
  app.normalizeProfile = value => structuredClone(value);
  app.structuredCloneSafe = structuredClone;
  app.mergeTipProgress = (saved, working) => ({ ...saved, ...working });
  app.applyVaultProfile = value => { app.recovered = value; app.workingProfile = structuredClone(value.profile); app.state.profileChanged = false; };
  for (const name of ["mergeUnsavedProfileIntoVault", "useBrowserProfileRevision", "latestBrowserProfile", "mergeBrowserProfile"]) {
    vm.runInContext(functionSource(template, name), app);
  }
  return fixture;
}

for (const contents of ["missing", "unreadable", "invalid-revision", "invalid-hash-type"]) {
  test(`keeping the current window resumes browser saving when all stored copies are ${contents}`, async () => {
    const { stores, storage } = storageFixture();
    if (contents !== "missing") {
      const damaged = { ...await storage.profileRecord(vault, { expectedRevision: 7 }), ...(contents === "invalid-revision" ? { cacheRevision: -1 } : contents === "invalid-hash-type" ? { sha256: { invalid: true } } : { sha256: "0".repeat(64) }) };
      stores.profiles.set("active", damaged);
      stores.profiles.set("previous", damaged);
    }
    const { app } = recoveryApplication(storage);
    assert.equal(await app.mergeBrowserProfile(), true, "Recovery demanded a saved profile that does not exist");
    assert.equal(app.state.browserSaveConflict, false);
    assert.equal(app.state.browserSaveError, "");
    assert.equal(app.state.profileChanged, false);
    assert.deepEqual(JSON.parse(JSON.stringify(await storage.decodeProfileRecord(stores.profiles.get("active")))), vault);
    assert.equal(app.state.fileConnected, false);
  });
}

test("recovery does not report success when browser storage still cannot save", async () => {
  const { storage } = storageFixture();
  const { app, messages } = recoveryApplication({
    loadActiveProfile: options => storage.loadActiveProfile(options),
    saveProfile: async () => { throw new Error("Storage unavailable"); }
  });
  assert.equal(await app.mergeBrowserProfile(), false);
  assert.equal(app.state.profileChanged, true);
  assert.equal(app.state.browserSaveError, "Storage unavailable");
  assert(messages.every(message => !/resumed|Merged this window/.test(message)));
});

test("an external save during explicit browser recovery remains protected", async () => {
  const { stores, storage } = storageFixture();
  const { app } = recoveryApplication({
    async loadActiveProfile(options) {
      const loaded = await storage.loadActiveProfile(options);
      stores.profiles.set("active", await storage.profileRecord(vault, { expectedRevision: 0 }));
      return loaded;
    },
    saveProfile: (value, details) => storage.saveProfile(value, details)
  });
  assert.equal(await app.mergeBrowserProfile(), false);
  assert.equal(app.state.browserSaveConflict, true);
  assert.equal(app.state.profileChanged, true);
  assert.match(app.state.browserSaveError, /expected revision 0, found 1/);
  assert.equal(stores.profiles.get("active").cacheRevision, 1);
});

test("edits made while checking the saved copy are included in recovery", async () => {
  const { storage } = storageFixture();
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { started = resolve; });
  const { app } = recoveryApplication({
    async loadActiveProfile(options) { started(); await blocked; return storage.loadActiveProfile(options); },
    saveProfile: (value, details) => storage.saveProfile(value, details)
  });
  const recovering = app.mergeBrowserProfile();
  await checking;
  app.profileSnapshot = () => ({ ...structuredClone(profile), notes: [{ id: "new-note", text: "Edited during recovery" }] });
  release();
  assert.equal(await recovering, true);
  assert.equal(app.recovered.profile.notes[0].text, "Edited during recovery");
});

test("keeping the window merges saved-only notes and retains current versions and settings", async () => {
  const { stores, storage } = storageFixture();
  const saved = { ...vault, profile: { ...profile, notes: [{ id: "test-note", text: "Older note" }, { id: "saved-only", text: "A saved-only note" }], preferences: { theme: "light" } } };
  stores.profiles.set("active", await storage.profileRecord(saved, { expectedRevision: 6 }));
  const { app } = recoveryApplication(storage);
  assert.equal(await app.mergeBrowserProfile(), true);
  const result = await storage.decodeProfileRecord(stores.profiles.get("active"));
  assert.equal(result.profile.notes.length, 2);
  assert.equal(result.profile.notes.find(note => note.id === "test-note").text, "Keep the current window's work");
  assert.equal(result.profile.notes.find(note => note.id === "saved-only").text, "A saved-only note");
  assert.equal(result.profile.preferences.theme, "dark");
});

test("repair advances beyond the last known revision even when the active copy disappeared", async () => {
  const { stores, storage } = storageFixture();
  stores.profiles.set("previous", await storage.profileRecord(vault, { expectedRevision: 6 }));
  const { app } = recoveryApplication(storage);
  assert.equal(await app.mergeBrowserProfile(), true);
  assert.equal(stores.profiles.get("active").cacheRevision, 8);
});

test("a stale window cannot overwrite a different profile with a reused revision", async () => {
  const { stores, storage } = storageFixture();
  const older = await storage.profileRecord({ ...vault, profile: { ...profile, notes: [{ id: "old", text: "Old window" }] } }, { expectedRevision: 0 });
  stores.profiles.set("active", await storage.profileRecord(vault, { expectedRevision: 0 }));
  const { app } = applicationFixture(storage, { cacheRevision: 1, cacheSha256: older.sha256 });
  await app.queueProfileWrite();
  assert.equal(app.state.browserSaveConflict, true, "Matching revision numbers hid a different saved profile");
  assert.equal(app.state.profileChanged, true);
  assert.equal(stores.profiles.get("active").cacheRevision, 1);
});
