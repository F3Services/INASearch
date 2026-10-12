#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const build = fs.readFileSync(path.join(__dirname, "build-standalone.js"), "utf8");
const status = require("../src/INASearch-Statute-Status.js");

const section = (statusValue, reason = "") => ({ status: statusValue, statusReason: reason ? { text: reason, sourceUrl: "https://uscode.house.gov/" } : undefined });
assert.equal(status.normalize(section("OMITTED")), "omitted");
assert.equal(status.normalize({}), "current");
assert.equal(status.label("omitted"), "Omitted");
assert.equal(status.aggregateSections([section("omitted"), section("omitted")]), "omitted");
assert.equal(status.aggregateSections([section("omitted"), section("repealed")]), "");
assert.equal(status.aggregateSections([section("omitted"), section("current")]), "");
assert.equal(status.aggregateSections([]), "");
const tree = { children: [{ children: [{ status: "repealed" }, { status: "repealed" }] }, { status: "repealed" }] };
assert.equal(status.aggregateTree(tree, node => node.children || []), "repealed");
tree.children[1].status = "current";
assert.equal(status.aggregateTree(tree, node => node.children || []), "");

function extractFunction(source, start, end, context) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Cannot extract ${start}`);
  return vm.runInNewContext(`(${source.slice(first, last).trim()})`, context);
}
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#39;" })[char]);
const badge = extractFunction(template, "    function hierarchyStatusBadge(", "    function hierarchyExpandableNodeIds(", {
  escapeHtml,
  statuteStatusLabel: status.label
});
const omitted = badge({ authority: "usc", kind: "section", status: "omitted", statusReason: { text: "Omitted because the temporary authority expired in 1990." } });
assert.match(omitted, /class="hierarchy-status omitted"/);
assert.match(omitted, /title="Omitted because the temporary authority expired in 1990\."/);
assert.match(omitted, /aria-label="Omitted because the temporary authority expired in 1990\."/);
assert.doesNotMatch(badge({ authority: "usc", kind: "chapter", dispositionLabel: "Omitted", status: "" }), /disposition|omitted/i);
assert.match(badge({ authority: "usc", kind: "chapter", containsIna: true, status: "" }), /Contains INA/);

const warning = extractFunction(template, "    function statuteStatusWarning(", "    function renderStatutoryNote(", {
  escapeHtml,
  statuteStatus: status.normalize,
  state: { statuteHierarchyAuthority: "usc" }
});
const reason = "Omitted as executed under Pub. L. 90-123.";
const warningHtml = warning(section("omitted", reason));
assert.match(warningHtml, /legal-status-warning omitted/);
assert.match(warningHtml, /role="alert"/);
assert.match(warningHtml, /Omitted as executed under Pub\. L\. 90-123\./);
assert.doesNotMatch(warningHtml, /not current operative statutory text|undefined/);
const historicWarning = warning({ ...section("repealed", "Repealed by Pub. L. 90-456."), historical: { versionLabel: "1970 U.S. Code", sourceUrl: "https://www.govinfo.gov/" } });
assert.match(historicWarning, /1970 U\.S\. Code/);
assert.match(historicWarning, /Official historical text source/);
assert.doesNotMatch(historicWarning, /undefined/);
const editorialNote = "The 1988 Code footnote explains the former cross-reference.";
const warningWithNote = warning({ ...section("repealed"), historical: { historicalEditorialNote: editorialNote, amendmentSources: [{ label: "Missing scan" }] } });
assert.match(warningWithNote, /1988 Code footnote/);
assert.doesNotMatch(warningWithNote, /Subsequent amendments: \./);

const referenceWarning = extractFunction(template, "    function legalReferenceStatusWarning(", "    function openLegalReferencePopover(", {
  escapeHtml,
  statuteStatus: status.normalize,
  statuteStatusWarning: warning
});
const omittedReference = referenceWarning({ referenceStatus: "omitted", statuteSection: section("omitted", reason) });
assert.match(omittedReference, /legal-status-warning omitted/);
assert.match(omittedReference, /Omitted as executed under Pub\. L\. 90-123\./);
assert.doesNotMatch(omittedReference, /legal-status-warning transferred/);
assert.match(referenceWarning({ referenceStatus: "omitted" }), /legal-status-warning omitted/);

const detail = { innerHTML: "" };
const renderIna = extractFunction(template, "    function renderIna(", "    function linkifyCfrText(", {
  inaMappedSection: () => section("omitted", reason),
  statuteStatus: status.normalize,
  statuteStatusWarning: warning,
  statuteStatusLabel: status.label,
  escapeHtml,
  els: { detail },
  openButton: () => "",
  INA_SOURCE_URL: "https://www.uscis.gov/",
  corpus: { sources: {} }
});
renderIna({ inaSection: "900", title: "Former provision", status: "omitted", hasEquivalent: true, uscLabel: "8 U.S.C. 900", source: {} });
assert.match(detail.innerHTML, /Omitted as executed under Pub\. L\. 90-123\./);
assert.doesNotMatch(detail.innerHTML, /Warning: this provision was omitted as executed/);
const renderUnmappedIna = extractFunction(template, "    function renderIna(", "    function linkifyCfrText(", {
  inaMappedSection: () => null,
  statuteStatus: status.normalize,
  statuteStatusWarning: warning,
  statuteStatusLabel: status.label,
  escapeHtml,
  els: { detail },
  openButton: () => "",
  INA_SOURCE_URL: "https://www.uscis.gov/",
  corpus: { sources: {} }
});
renderUnmappedIna({ inaSection: "901", title: "Unmapped provision", status: "omitted", hasEquivalent: false, statusReason: { text: "The crosswalk records this entry as omitted." }, source: {} });
assert.match(detail.innerHTML, /Omitted in the USCIS INA crosswalk/);
assert.match(detail.innerHTML, /The crosswalk records this entry as omitted/);
assert.doesNotMatch(detail.innerHTML, /omitted as executed/i);

const css = template.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
assert.match(css, /\.hierarchy-status\.repealed,\s*\.hierarchy-status\.omitted\s*\{/);
assert.match(css, /\.legal-status-warning\.repealed,\s*\.legal-status-warning\.omitted\s*\{/);
assert.match(css, /\.statute-citation-link\.reference-repealed,\s*\.statute-citation-link\.reference-omitted\s*\{/);
assert.match(template, /INA_SEARCH_STATUTE_STATUS_RUNTIME_START/);
assert.match(build, /replaceRuntimeBlock\(template, "STATUTE_STATUS"/);

const openingIndexData = extractFunction(build, "function openingIndexData(", "function makeBuild(", {
  vm,
  status
});
const fixture = {
  title8: { sections: [
    { id: 1, section: "1", breadcrumb: [{ number: "1", title: "FIRST", kind: "chapter" }], status: "omitted" },
    { id: 2, section: "2", breadcrumb: [{ number: "1", title: "FIRST", kind: "chapter" }], status: "omitted" },
    { id: 3, section: "3", breadcrumb: [{ number: "2", title: "SECOND", kind: "chapter" }], status: "omitted" },
    { id: 4, section: "4", breadcrumb: [{ number: "2", title: "SECOND", kind: "chapter" }], status: "current" }
  ] },
  inaCrosswalk: [{ uscSection: "1", hasEquivalent: true }],
  inaHierarchy: { titles: [], source: { detailUrl: "https://example.com/" } },
  referencedUsc: { titles: [
    { number: 5, name: "UNIFORM", sections: [section("repealed"), section("repealed")] },
    { number: 12, name: "MIXED", sections: [section("repealed"), section("current")] }
  ] },
  cfr: { parts: [], titleNames: {} }
};
const titleCaseTemplate = template;
const opening = openingIndexData(titleCaseTemplate, fixture);
assert.deepEqual(Array.from(opening.usc[0][3][0]), ["Contains INA", "ina-membership"]);
assert.deepEqual(Array.from(opening.usc[0][3][1]), ["Omitted", "omitted"]);
assert.equal(opening.usc[1][3].length, 0);
assert.deepEqual(Array.from(opening.referencedUsc[0][3][0]), ["Repealed", "repealed"]);
assert.equal(opening.referencedUsc[1][3].length, 0);
assert.match(template, /addReferencedUscHierarchy\(uscRoot\);[\s\S]{0,1000}assignContainerStatuses\(uscRoot\);/);

const statuteUnitText = extractFunction(template, "    function statuteUnitText(", "    function statuteReferenceRunInLineHtml(", {
  statuteReferenceSelection: () => ({ kind: "section" }),
  textWithHouseFootnoteMarkers: value => value || "",
  statuteFootnoteAppendix: () => "",
  statuteStatus: status.normalize
});
const historicalSection = {
  title: 8, section: "2", heading: "Citizenship of Oregon residents", body: [],
  status: "omitted", statusReason: { text: "Omitted because territorial conditions ended." },
  historical: { versionLabel: "1934 U.S. Code, Title 8", amendmentSources: [{ label: "Local artifact only" }] }
};
const omittedCopy = statuteUnitText(historicalSection);
assert.match(omittedCopy, /OMITTED FROM THE CURRENT CODE/);
assert.match(omittedCopy, /Omitted because territorial conditions ended\./);
assert.match(omittedCopy, /1934 U\.S\. Code, Title 8/);
assert.match(omittedCopy, /§2\. Citizenship of Oregon residents/);
assert.doesNotMatch(omittedCopy, /REPEALED|undefined|Source:|subsequent amendments/i);
const transferredCopy = statuteUnitText({ ...historicalSection, status: "transferred", statusReason: undefined, historical: { destinationIna: "101" } });
assert.match(transferredCopy, /TRANSFERRED—NOT CURRENT AT THIS LOCATION/);
assert.match(transferredCopy, /Now INA 101/);
assert.doesNotMatch(transferredCopy, /undefined/);
const repealedCopy = statuteUnitText({ ...historicalSection, status: "repealed", statusReason: undefined, historical: { versionLabel: "1970 U.S. Code", sourceUrl: "https://www.govinfo.gov/", amendmentSources: [{ url: "https://www.congress.gov/" }] } });
assert.match(repealedCopy, /REPEALED—NOT CURRENT LAW/);
assert.match(repealedCopy, /https:\/\/www\.govinfo\.gov\//);
assert.match(repealedCopy, /https:\/\/www\.congress\.gov\//);

console.log("PASS statute status UI: shared aggregate, opening/hydrated badges, reasons, warnings and colors.");
