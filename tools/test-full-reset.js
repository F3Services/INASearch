"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const source = require("./test-function-source");
const storageSource = fs.readFileSync(require.resolve("../src/INASearch-Storage.js"), "utf8");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");

// IndexedDB is the boundary; all storage and reset application logic is real.
function storageFixture({ pauseOpenAt = 0 } = {}) {
  const stores = Object.fromEntries(["corpus", "sources", "search-indexes", "metadata", "profiles", "handles"].map(name => [name, new Map()]));
  let fail = false;
  let openCount = 0, reachPausedOpen, resumeOpen;
  const pausedOpen = new Promise(resolve => { reachPausedOpen = resolve; });
  const openReleased = new Promise(resolve => { resumeOpen = resolve; });
  const database = { close() {}, transaction(names) {
    const changes = [];
    const tx = { objectStore(name) { return {
      clear() { changes.push(() => stores[name].clear()); },
      delete(key) { changes.push(() => stores[name].delete(key)); },
      put(value, key) { changes.push(() => stores[name].set(key, structuredClone(value))); },
      getAllKeys() { const request = {}; queueMicrotask(() => { request.result = [...stores[name].keys()]; request.onsuccess?.(); }); return request; },
      get(key) { const request = {}; queueMicrotask(() => { request.result = structuredClone(stores[name].get(key)); request.onsuccess?.(); }); return request; }
    }; }, abort() { this.aborted = true; } };
    setImmediate(() => {
      if (fail || tx.aborted) { fail = false; tx.error = new Error("Storage write failed"); tx.onabort?.(); }
      else { changes.forEach(change => change()); tx.oncomplete?.(); }
    });
    return tx;
  } };
  const context = vm.createContext({ Blob, TextEncoder, TextDecoder, Uint8Array, structuredClone,
    crypto: globalThis.crypto, indexedDB: { open() { const request = {}, number = ++openCount; queueMicrotask(async () => {
      if (number === pauseOpenAt) { reachPausedOpen(); await openReleased; }
      request.result = database; request.onsuccess?.();
    }); return request; } } });
  vm.runInContext(fs.readFileSync(require.resolve("../src/INASearch-Corpus-Shards.js"), "utf8"), context);
  vm.runInContext(storageSource, context);
  return { stores, api: context.INASearchStorage, pausedOpen, resumeOpen, failNext: () => { fail = true; } };
}

test("full reset removes all corpus slots, sources, indexes and history while retaining the reset profile and file connection", async () => {
  const { stores, api } = storageFixture();
  for (const name of ["corpus", "sources", "search-indexes", "metadata"]) for (const key of ["active", "previous", "staging", "ecfr-last-check-v2"]) stores[name].set(key, { old: true });
  stores.profiles.set("active", { resetProfile: true }); stores.profiles.set("previous", { oldNotes: true }); stores.profiles.set("staging", { oldNotes: true });
  stores.profiles.set("staging:unfinished-save", { oldNotes: true });
  stores.handles.set("primary-vault", { fileConnection: true });
  assert.equal(typeof api.clearResetCaches, "function", "Full reset needs an atomic cache-clearing operation");
  assert.equal(await api.clearResetCaches(), true);
  for (const name of ["corpus", "sources", "search-indexes", "metadata"]) assert.equal(stores[name].size, 0, name + " survived reset");
  assert.deepEqual([...stores.profiles.keys()], ["active"]);
  assert.deepEqual(stores.profiles.get("active"), { resetProfile: true });
  assert.equal(stores.handles.size, 1);
  assert.equal(await api.ensureActiveCorpus({ schemaVersion: 5, corpusVersion: "old", cfr: { sections: [], appendices: [] } }), false, "An old background baseline write repopulated the cleared corpus");
  assert.equal(await api.storeSourceArtifact("late-source", {}), false);
  await api.setMetadata("ecfr-maintenance-status-v2", { state: "updated" });
  await api.setMetadata("annotation-index:old-profile", { oldCache: true });
  assert.equal(stores.metadata.size, 0, "A late update callback repopulated history");
  assert.equal(await api.write("profiles", "staging:late-save", { oldNotes: true }), false);
  assert.equal(await api.saveSearchIndex({ key: "late-index", recordSchemaVersion: 1, payload: { fragments: [], hierarchyNodes: [] } }), false);
  assert.equal(stores["search-indexes"].size, 0);
});

test("failed cache clearing is atomic and can be retried", async () => {
  const { stores, api, failNext } = storageFixture();
  stores.corpus.set("active", { keep: true }); stores.sources.set("old", { keep: true });
  assert.equal(typeof api.clearResetCaches, "function");
  failNext();
  await assert.rejects(api.clearResetCaches(), /failed|abort/i);
  assert.equal(stores.corpus.size, 1); assert.equal(stores.sources.size, 1);
  assert.equal(await api.clearResetCaches(), true);
  assert.equal(stores.corpus.size, 0); assert.equal(stores.sources.size, 0);
});

test("a profile save already past staging cannot recreate recovery copies after reset", async () => {
  const f = storageFixture({ pauseOpenAt: 3 });
  f.stores.profiles.set("active", { resetProfile: true });
  const save = f.api.saveProfile({ format: "INASearchData", schemaVersion: 1, vaultId: "test-vault", revision: 0,
    profile: { schemaVersion: 5, notes: ["old note"], preferences: {} } }).then(() => true, () => false);
  await f.pausedOpen;
  await f.api.clearResetCaches();
  f.resumeOpen();
  assert.equal(await save, false, "A pre-reset save activated its stale profile after clearing");
  assert.deepEqual([...f.stores.profiles.keys()], ["active"]);
  assert.deepEqual(f.stores.profiles.get("active"), { resetProfile: true });
});

function applicationFixture({ failedSave = false, failedClear = false } = {}) {
  const events = [], profile = { notes: ["old note"], preferences: { automaticCfrUpdates: true } };
  let finishSave, finishStop;
  const save = new Promise(resolve => { finishSave = resolve; });
  const stopped = new Promise(resolve => { finishStop = resolve; });
  const state = { view: "search", profileChanged: false, saveQueue: Promise.resolve(), searchWorkerClient: { terminate() { events.push("worker-stopped"); } } };
  const box = { state, profile, document: { body: { inert: false } }, els: { search: { value: "214.1a4" }, resetEverythingButton: { disabled: false, focus() {} }, resetSettingsButton: { disabled: false }, savingMenuModal: {} },
    stopCorpusMaintenance: () => { events.push("stop-requested"); return stopped; }, clearTimeout() {},
    resetProfileContentToDefaults: () => { profile.notes = []; profile.preferences = { automaticCfrUpdates: false }; },
    insertedReferenceMaterializedKeys: new Set(), resetAnnotationIndex() {}, applyThemePreference() {}, syncCitationJumpAnimationPreference() {}, syncAppearanceControls() {},
    markProfileChanged: () => { state.profileChanged = true; }, updateProfileSummary() {}, renderSavingMenu() {},
    openClearedSearchHierarchy() {}, applySearchQuery() {}, refreshStatutoryCitationDisplay() {}, refreshLegalNavigatorVisibility() {}, syncNavigationDepthSettings() {}, rerenderOccurrenceExpansionPreference() {}, rerenderAllInsertedReferenceGroups() {},
    queueProfileWrite: async () => { events.push("save-started"); await save; state.profileChanged = failedSave; state.browserSaveError = failedSave ? "Save failed" : ""; events.push("save-finished"); },
    INASearchStorage: { clearResetCaches: async () => { events.push("caches-cleared"); if (failedClear) throw new Error("Clear failed"); return true; } },
    toast: text => events.push(text), updateSaveStatus() {}, location: { reload: () => events.push("reload") } };
  const reset = vm.runInNewContext(`(${source(template, "resetEverythingToDefaults")})`, box);
  return { reset, events, state, profile, document: box.document, finishSave, finishStop };
}

test("reset waits for the updater and saved defaults before clearing caches and reloading", async () => {
  const f = applicationFixture();
  const pending = f.reset();
  await new Promise(setImmediate);
  assert.equal(f.document.body.inert, true, "The app must not accept edits during reset");
  assert(!f.events.includes("reload")); assert(!f.events.includes("caches-cleared"));
  f.finishStop(); await new Promise(setImmediate);
  assert(f.events.includes("save-started")); assert(!f.events.includes("caches-cleared"));
  f.finishSave(); await pending;
  assert.deepEqual(f.profile.notes, []); assert.equal(f.profile.preferences.automaticCfrUpdates, false);
  assert(f.events.indexOf("worker-stopped") < f.events.indexOf("caches-cleared"));
  assert(f.events.indexOf("save-finished") < f.events.indexOf("caches-cleared"));
  assert(f.events.indexOf("caches-cleared") < f.events.indexOf("reload"));
});

for (const failure of ["failedSave", "failedClear"]) test(failure + " prevents a misleading successful reload", async () => {
  const f = applicationFixture({ [failure]: true }); f.finishStop(); f.finishSave();
  await f.reset();
  assert(!f.events.includes("reload"));
  if (failure === "failedSave") assert(!f.events.includes("caches-cleared"));
  assert.equal(f.state.resetInProgress, false);
  assert.equal(f.document.body.inert, false);
  assert(f.events.some(text => /fail|could not/i.test(text)));
});
