"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const source = require("./test-function-source");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");

function element() {
  const attributes = new Map();
  const classes = new Set();
  return { hidden: true, disabled: true, dataset: {}, innerHTML: "", textContent: "",
    classList: { toggle(key, enabled) { if (enabled) classes.add(key); else classes.delete(key); }, remove(key) { classes.delete(key); } },
    setAttribute(key, value) { attributes.set(key, value); }, removeAttribute(key) { attributes.delete(key); },
    getAttribute(key) { return attributes.get(key); } };
}

function harness() {
  const els = { corpusStatus: element(), saveStatus: element(), topThemeControls: element(),
    corpusUpdateDetails: element(), checkCfrUpdatesButton: element(), reloadCfrUpdatesButton: element(), savingMenuModal: { hidden: true } };
  const profile = { preferences: { showDetailedStatus: false } };
  const state = {};
  let opened = null;
  const context = vm.createContext({ els, profile, state, corpus: { cfr: {} }, loadErrors: {}, window: { INA_SEARCH_CORPUS_FULLY_LOADED: true },
    escapeHtml: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    renderProfileSetupNotice() {}, renderSavingMenu() {}, automaticCfrUpdatesEnabled: () => true,
    openSavingMenu(area) { opened = area; }, reloadUpdatedCorpus: () => true });
  for (const name of ["renderCorpusUpdateDetails", "updateCorpusStatus", "updateSaveStatus", "syncTopBarVisibility", "handleCorpusStatusClick"]) {
    if (template.includes(`function ${name}(`)) vm.runInContext(source(template, name), context);
  }
  return { context, els, state, profile, opened: () => opened };
}

test("red updater failures remain visible and actionable with detailed status off", () => {
  const h = harness();
  h.context.window.INA_SEARCH_UPDATE_STATUS = { state: "error", checkedAt: "2026-01-02T03:04:05Z", message: "The source could not be reached.", requestUrl: "https://www.ecfr.gov/api/versioner/v1/titles.json" };
  h.context.updateCorpusStatus();
  assert.equal(h.els.corpusStatus.hidden, false);
  assert.equal(h.els.corpusStatus.disabled, false);
  h.context.syncTopBarVisibility();
  assert.equal(h.els.corpusStatus.hidden, false, "Appearance synchronization hid an error.");
  h.context.handleCorpusStatusClick();
  assert.equal(h.opened(), "updates");
  assert.match(h.els.corpusUpdateDetails.innerHTML, /The source could not be reached/);
  assert.match(h.els.corpusUpdateDetails.innerHTML, /versioner/);
  assert.equal(h.els.checkCfrUpdatesButton.disabled, false);
});

test("unavailable corpus and red saving errors override the visibility preference", () => {
  const h = harness();
  h.context.corpus = null;
  h.context.loadErrors.corpusMessage = "Invalid embedded data";
  h.context.updateCorpusStatus();
  assert.equal(h.els.corpusStatus.hidden, false);
  assert.equal(h.els.corpusStatus.disabled, false);
  h.state.browserSaveError = "Storage full";
  h.context.updateSaveStatus("Storage full", "bad");
  h.context.syncTopBarVisibility();
  assert.equal(h.els.saveStatus.hidden, false);
  assert.match(h.els.saveStatus.innerHTML, /status-dot bad/);
});

test("routine status respects the preference and checking prevents duplicate retries", () => {
  const h = harness();
  h.context.window.INA_SEARCH_UPDATE_STATUS = { state: "checking", message: "Checking source" };
  h.context.updateCorpusStatus();
  assert.equal(h.els.corpusStatus.hidden, true);
  assert.equal(h.els.checkCfrUpdatesButton.disabled, true);
  h.profile.preferences.showDetailedStatus = true;
  h.context.syncTopBarVisibility();
  assert.equal(h.els.corpusStatus.hidden, false);
});
