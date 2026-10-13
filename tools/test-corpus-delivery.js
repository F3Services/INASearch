#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const deliveryPath = path.join(__dirname, "corpus-delivery.js");
const delivery = fs.existsSync(deliveryPath) ? require(deliveryPath) : {};
assert.equal(typeof delivery.prepareDeliveryCorpus, "function", "Delivery must omit build-only citation audits.");
const original = { legalReferenceAudit: { issues: ["build only"] }, legalReferenceEvidence: { records: ["evidence"] },
  body: [{ text: "Exact legal text.", _lr: { t: "0,0,5,2,1;1,2,4,3,99" } }], legalReferencePacking: { legalTargets: ["target"] } };
const prepared = delivery.prepareDeliveryCorpus(original);
assert(!Object.hasOwn(prepared, "legalReferenceAudit"));
assert(!Object.hasOwn(prepared, "legalReferenceEvidence"));
assert.equal(prepared.body[0].text, "Exact legal text.");
assert.equal(prepared.body[0]._lr.t, "0,0,5,2,1;1,2,4,3", "Keep House resolution flags but remove build-only evidence IDs.");
assert.deepEqual(prepared.legalReferencePacking, original.legalReferencePacking);
assert(original.legalReferenceEvidence, "The canonical build evidence must remain available.");

(async () => {
  const { buildBrotliRuntime } = require("./build-brotli");
  const context = { WebAssembly, Uint8Array, TextDecoder, TextEncoder, atob, Blob, Response, crypto: crypto.webcrypto };
  vm.createContext(context);
  vm.runInContext(buildBrotliRuntime(), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/INASearch-Startup.js"), "utf8"), context);
  const plain = Buffer.from(JSON.stringify({ text: "Exact statute: § café <tag> & punctuation." }));
  const compressed = zlib.brotliCompressSync(plain);
  const hash = x => crypto.createHash("sha256").update(x).digest("hex");
  const manifest = { schemaVersion: 1, compression: "brotli", encoding: "base64", mediaType: "application/brotli",
    contentType: "application/json", charset: "utf-8", uncompressedBytes: plain.length, uncompressedSha256: hash(plain),
    compressedBytes: compressed.length, compressedSha256: hash(compressed) };
  const results = await Promise.all([1, 2].map(() => context.INASearchStartup.decode(compressed.toString("base64"), manifest)));
  for (const result of results) assert.deepEqual(JSON.parse(JSON.stringify(result.parsed)), JSON.parse(plain));
  const corrupt = Buffer.from(compressed); corrupt[0] ^= 1;
  await assert.rejects(context.INASearchStartup.decode(corrupt.toString("base64"), manifest), /SHA-256 integrity check/);
  await assert.rejects(context.INASearchStartup.decode(compressed.toString("base64"), { ...manifest, uncompressedSha256: "0".repeat(64) }), /SHA-256 integrity check/);
  console.log("PASS corpus delivery: audit omission, exact offline Brotli decoding, concurrent initialization and integrity rejection");
})().catch(error => { console.error(error); process.exitCode = 1; });
