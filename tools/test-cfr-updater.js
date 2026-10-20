"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

const runtime = fs.readFileSync(require.resolve("../src/INASearch-Updater.js"), "utf8");
const corpus = () => ({ schemaVersion: 5, corpusVersion: "fixture.1", cfr: {
  structureRevision: 1, parts: [{ id: "8:1", title: 8, part: "1", sectionIds: [] }], sections: [], appendices: [],
  currentThrough: { 8: "2026-01-01" }
} });

function harness(fetch, values = {}) {
  const storage = { loadActiveCorpus: async () => null, getMetadata: async () => null,
    setMetadata: async () => {}, storeSourceArtifact: async () => {}, ensureActiveCorpus: async () => true,
    sha256Bytes: async () => "0".repeat(64), activateCorpus: async () => true, ...values };
  const box = { AbortController, Blob, TextEncoder, URL, URLSearchParams, performance, structuredClone,
    navigator: {}, INASearchStorage: storage, INASearchCfrHierarchy: { revision: 1 },
    setTimeout: (fn, ms) => setTimeout(fn, ms > 5000 ? ms : 0), clearTimeout, fetch };
  vm.createContext(box);
  vm.runInContext(runtime, box);
  return box.INASearchUpdater;
}

test("network failures identify the exact official request and remain errors", async () => {
  const updater = harness(async () => { throw new TypeError("Failed to fetch"); });
  const status = await updater.checkAndUpdate(corpus(), { force: true });
  assert.equal(status.state, "error");
  assert.equal(status.requestUrl, "https://www.ecfr.gov/api/versioner/v1/titles.json");
  assert.match(status.message, /network|browser|download/i);
});

test("request timeouts do not falsely report that the user turned updates off", async () => {
  const updater = harness(async () => { throw Object.assign(new Error("timed out"), { name: "AbortError" }); });
  const status = await updater.checkAndUpdate(corpus(), { force: true });
  assert.equal(status.state, "error");
  assert.match(status.message, /timed out/i);
  assert.equal(status.requestUrl, "https://www.ecfr.gov/api/versioner/v1/titles.json");
});

test("an unavailable activation store cannot produce a successful currency advance", async () => {
  const updater = harness(async url => ({ ok: true, text: async () => JSON.stringify(url.includes("titles.json")
    ? { titles: [{ number: 8, up_to_date_as_of: "2026-01-02", latest_amended_on: "2025-12-01", latest_issue_date: "2025-12-01" }] }
    : { ecfr_corrections: [] }) }), { activateCorpus: async () => false });
  const status = await updater.checkAndUpdate(corpus(), { force: true });
  assert.equal(status.state, "error");
  assert.match(status.message, /stor|activat|sav/i);
});

test("stopping maintenance waits for the aborted update to finish", async () => {
  let beginRequest, finishRequest;
  const requested = new Promise(resolve => { beginRequest = resolve; });
  const release = new Promise(resolve => { finishRequest = resolve; });
  const updater = harness(async (_url, options) => {
    beginRequest();
    await release;
    assert.equal(options.signal.aborted, true);
    throw Object.assign(new Error("Stopped"), { name: "AbortError" });
  });
  const stop = updater.start(corpus(), { startDelayMs: 0 });
  await requested;
  let stopped = false;
  const pending = Promise.resolve(stop()).then(() => { stopped = true; });
  await new Promise(setImmediate);
  const stoppedBeforeRequestFinished = stopped;
  finishRequest();
  await pending;
  assert.equal(stoppedBeforeRequestFinished, false, "Stop returned while the old update could still write to storage");
});
