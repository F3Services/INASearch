#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { packCorpusForDelivery } = require("../src/INASearch-Corpus-Packing");
const { partitionPackedCorpus } = require("../src/INASearch-Corpus-Shards");
const helperPath = path.join(__dirname, "read-build-corpus.js");
const helper = fs.existsSync(helperPath) ? require(helperPath) : {};
assert.equal(typeof helper.readPackedCorpusHtml, "function", "The shared standalone corpus reader is missing.");

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function payload(value, compression = "gzip") {
  const plain = Buffer.from(JSON.stringify(value));
  const encoded = compression === "brotli" ? zlib.brotliCompressSync(plain) : compression === "gzip" ? zlib.gzipSync(plain) : plain;
  return {
    manifest: { compression, encoding: compression !== "none" ? "base64" : "utf-8", uncompressedBytes: plain.length, uncompressedSha256: hash(plain),
      ...(compression !== "none" ? { compressedBytes: encoded.length, compressedSha256: hash(encoded) } : {}) },
    text: compression !== "none" ? encoded.toString("base64") : encoded.toString("utf8")
  };
}

function html(manifest, corpusText, chunks = []) {
  const fake = '<script id="instructions">const example = \'<script id="inaSearchCorpusData" type="application/gzip">incorrect<\\/script>\';</script>';
  return fake + '<!-- <script id="inaSearchCorpusData">commented out</script> -->' +
    `<script id="inaSearchCorpusManifest" type="application/json">${JSON.stringify(manifest)}</script>` +
    `<script id="inaSearchCorpusData" type="application/gzip">${corpusText}</script>` +
    chunks.map((chunk, id) => `<script id="inaSearchCorpusShard${id}" type="application/gzip">${chunk.text}</script>`).join("");
}

const corpus = { schemaVersion: 5, corpusVersion: "fixture", sources: { title8: { capturedAt: "2026-08-21" } },
  title8: { sections: [{ id: "8-101", section: "101", heading: "Definitions", body: [{ label: "a", path: ["a"], text: "Exact legal text and punctuation: café § 1." }], notes: [], sourceCredit: "Original source credit." }] },
  cfr: { parts: [], sections: [], appendices: [] } };
const packed = packCorpusForDelivery(corpus);
const ordinary = payload(packed);
assert.deepEqual(helper.readPackedCorpusHtml(html(ordinary.manifest, ordinary.text)), packed, "The reader selected a script example rather than the actual gzip payload.");
const brotli = payload(packed, "brotli");
assert.deepEqual(helper.readPackedCorpusHtml(html(brotli.manifest, brotli.text)), packed, "Brotli reading changed the corpus.");
const plain = payload(corpus, "none");
assert.deepEqual(helper.readPackedCorpusHtml(html(plain.manifest, plain.text)), corpus, "Plain JSON corpus reading regressed.");
const partition = partitionPackedCorpus(packed, 100);
const metadata = payload(partition.metadata);
const chunks = partition.chunks.map(chunk => payload(chunk));
const manifest = { ...metadata.manifest, shards: chunks.map(chunk => chunk.manifest) };
const staged = html(manifest, metadata.text, chunks);
assert.deepEqual(helper.readPackedCorpusHtml(staged), packed, "The reader failed to restore exact sharded legal content.");
assert.throws(() => helper.readPackedCorpusHtml(staged.replace(chunks[0].text, "AAAA" + chunks[0].text.slice(4))), /compressed SHA-256/i, "A corrupted shard was accepted.");
assert.throws(() => helper.readPackedCorpusHtml(staged.replace(`id="inaSearchCorpusShard0"`, 'id="missing"')), /Missing inaSearchCorpusShard0/, "A missing shard was accepted.");
assert.throws(() => helper.readPackedCorpusHtml(html({ ...ordinary.manifest, uncompressedSha256: "incorrect" }, ordinary.text)), /uncompressed SHA-256/i, "Corrupted decoded integrity metadata was accepted.");
console.log("PASS standalone corpus reader: actual script selection, gzip/plain JSON, exact shard merge, and missing/corrupt chunk detection");
