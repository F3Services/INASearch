"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");
const { mergePackedChunk } = require("../src/INASearch-Corpus-Shards");

function scriptTexts(html) {
  const scripts = new Map();
  // Consume each complete script before inspecting the next opening tag. Runtime
  // strings can contain examples of corpus tags, which are not HTML elements.
  const elements = /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(html || "").matchAll(elements)) {
    if (match[1] === undefined) continue;
    const attribute = match[1].match(/(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (attribute) scripts.set(attribute[1] ?? attribute[2] ?? attribute[3], match[2]);
  }
  return scripts;
}

function scriptText(scripts, id) {
  if (!scripts.has(id)) throw new Error(`Missing ${id} in standalone artifact.`);
  return scripts.get(id);
}

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function decodePayload(text, manifest, label) {
  let bytes;
  if (manifest.compression === "gzip") {
    const compressed = Buffer.from(text.replace(/\s+/g, ""), "base64");
    assert.equal(compressed.length, manifest.compressedBytes, `${label}: compressed byte count`);
    assert.equal(sha256(compressed), manifest.compressedSha256, `${label}: compressed SHA-256`);
    bytes = zlib.gunzipSync(compressed);
  } else {
    assert.equal(manifest.compression, "none", `${label}: unsupported corpus compression`);
    bytes = Buffer.from(text, "utf8");
  }
  assert.equal(bytes.length, manifest.uncompressedBytes, `${label}: uncompressed byte count`);
  assert.equal(sha256(bytes), manifest.uncompressedSha256, `${label}: uncompressed SHA-256`);
  return JSON.parse(bytes.toString("utf8"));
}

function readPackedCorpusHtml(html) {
  const scripts = scriptTexts(html);
  const manifest = JSON.parse(scriptText(scripts, "inaSearchCorpusManifest"));
  const corpus = decodePayload(scriptText(scripts, "inaSearchCorpusData"), manifest, "corpus");
  for (const [id, shardManifest] of (manifest.shards || []).entries()) {
    const chunk = decodePayload(scriptText(scripts, `inaSearchCorpusShard${id}`), shardManifest, `chunk ${id}`);
    assert.equal(chunk.id, id, "Corpus content chunk has the wrong ID.");
    mergePackedChunk(corpus, chunk);
  }
  delete corpus._shards;
  return corpus;
}

function readBuildCorpus(fileName) {
  return hydratePackedCorpus(readPackedCorpusHtml(fs.readFileSync(fileName, "utf8")));
}

module.exports = { readBuildCorpus, readPackedCorpusHtml };
