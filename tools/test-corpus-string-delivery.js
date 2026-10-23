#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");
const { packCorpusStringsForDelivery, hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");
const { readBuildCorpus } = require("./read-build-corpus");
const { unpackLegalReferences } = require("./pack-legal-references");
const functionSource = require("./test-function-source");
const clone = value => JSON.parse(JSON.stringify(value));
const root = path.join(__dirname, "..");
function firstDifference(left, right, location = "") {
  if (left === right) return "";
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return `${location}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  for (const key of keys) {
    if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return `${location}/${key}: property presence differs`;
    const difference = firstDifference(left[key], right[key], `${location}/${key}`);
    if (difference) return difference;
  }
  return "";
}
function canonicalUrls(value) {
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (key === "officialUrl" && typeof child === "string" && child) {
      const url = new URL(child);
      url.searchParams.sort();
      value[key] = url.href;
    } else canonicalUrls(child);
  }
  return value;
}
const browser = vm.createContext({ INASEARCH_BROWSER: true, hydratedLegalReferenceRoots: new WeakSet() });
vm.runInContext(fs.readFileSync(path.join(root, "src/INASearch-Corpus-Packing.js"), "utf8"), browser);
const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
for (const name of ["canonicalPath", "componentTokens", "houseSectionUrl", "expandPackedHouseHref", "hydrateLegalReferences"]) vm.runInContext(functionSource(template, name), browser);

assert.equal(typeof packCorpusStringsForDelivery, "function", "Uncompressed delivery needs a lossless repeated-string encoder");
function roundTrip(original) {
  const before = clone(original);
  const packed = packCorpusStringsForDelivery(original);
  assert.deepEqual(original, before, "Packing must not mutate source data");
  assert.deepEqual(packCorpusStringsForDelivery(packed), packed, "Repeated packing must not escape dictionary tokens twice");
  const nodeDecoded = hydratePackedCorpus(clone(packed));
  const browserDecoded = browser.INASearchCorpusPacking.hydratePackedCorpus(clone(packed));
  assert.deepEqual(nodeDecoded, before, "Every source, provenance, policy and packed-reference value must survive exactly");
  assert.deepEqual(clone(browserDecoded), before, "Browser string decoding must retain every value exactly");
  const nodeReferences = unpackLegalReferences(nodeDecoded);
  browser.hydrateLegalReferences(browserDecoded, browserDecoded);
  const browserReferences = clone(browserDecoded);
  const previousNode = unpackLegalReferences(clone(before)), previousBrowser = clone(before);
  browser.hydrateLegalReferences(previousBrowser, previousBrowser);
  assert.deepEqual(nodeReferences, previousNode, "String packing must preserve the exact preexisting Node decoder output");
  assert.deepEqual(browserReferences, clone(previousBrowser), "String packing must preserve the exact preexisting browser decoder output");
  // The existing House URL builders use different query-parameter order.
  // All other properties, and each runtime's exact URL spelling, stay intact.
  canonicalUrls(browserReferences); canonicalUrls(nodeReferences);
  assert(isDeepStrictEqual(browserReferences, nodeReferences), `Every decoded reference property must agree in Node and the browser: ${firstDifference(browserReferences, nodeReferences)}`);
  return packed;
}

const repeated = "Repeated source evidence and citation notices must remain complete and byte-for-byte unchanged.";
const shared = { locator: repeated, supportingExcerpt: repeated, literalToken: "~12" };
roundTrip({ schemaVersion: 5, absent: null, empty: [], sources: { first: shared, second: shared },
  body: [{ path: "a/1", text: repeated }, { path: ["a", "1"], text: repeated }],
  literals: ["~12", "~~12", "~~~12", "~0", "", "0", 0, false],
  metadata: { officialUrl: "", historicalOfficialUrl: "https://www.govinfo.gov/example.pdf#page=2", citationNote: repeated } });
assert(!browser.INASearchCorpusPacking.packCorpusStringsForDelivery, "The build-only encoder must not ship in the browser API");

const artifact = process.argv[2] || path.join(root, "INASearch-Uncompressed.html");
const corpus = readBuildCorpus(artifact);
const packed = roundTrip(corpus);
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"));
const originalBytes = jsonBytes(corpus), packedBytes = jsonBytes(packed);
assert(packedBytes < originalBytes - 5_000_000, "Repeated metadata must save at least 5 MB without dropping any data");
assert(packedBytes < 43_000_000, "Uncompressed corpus JSON must leave room for the shell within the existing 45 MB artifact limit");
console.log(`PASS lossless corpus string delivery: ${originalBytes} -> ${packedBytes} bytes; complete Node/browser metadata parity`);
