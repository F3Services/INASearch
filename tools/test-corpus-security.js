#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { test } = require("node:test");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const preflight = fs.existsSync(require("node:path").join(__dirname, "check-node.js")) ? require("./check-node") : {};
const decoder = fs.existsSync(require("node:path").join(__dirname, "decode-corpus-payload.js")) ? require("./decode-corpus-payload") : {};
test("preflight accepts only patched supported Node release lines", () => {
  assert.equal(typeof preflight.isSupportedNode, "function", "A patched Node preflight is required");
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0"]) assert(preflight.isSupportedNode(version), version);
  for (const version of ["20.99.0", "22.22.2", "22.23.3", "23.23.4", "24.22.0", "25.99.0", "26.12.0", "27.0.0", "22.23.4-rc.1", "invalid"]) assert(!preflight.isSupportedNode(version), version);
});
function fixture(compression = "brotli", plain = Buffer.from('{"text":"Exact § bytes"}')) {
  const encoded = compression === "brotli" ? zlib.brotliCompressSync(plain) : zlib.gzipSync(plain);
  return { encoded, plain, manifest: { schemaVersion: 1, contentType: "application/json", charset: "utf-8", compression, encoding: "base64", mediaType: `application/${compression}`, compressedBytes: encoded.length, compressedSha256: hash(encoded), uncompressedBytes: plain.length, uncompressedSha256: hash(plain) } };
}
test("build decoder verifies input before invoking native decompression", () => {
  assert.equal(typeof decoder.decodeCorpusPayload, "function", "Verified build decoder is required");
  const { encoded, plain, manifest } = fixture();
  assert.deepEqual(decoder.decodeCorpusPayload(encoded.toString("base64"), manifest), plain);
  const invalid = Buffer.from(encoded); invalid[0] ^= 1;
  assert.throws(() => decoder.decodeCorpusPayload(invalid.toString("base64"), manifest), /compressed SHA-256/);
  assert.throws(() => decoder.decodeCorpusPayload(encoded.subarray(1).toString("base64"), manifest), /compressed byte count/);
});
test("build decoder rejects manifest violations and output expansion for Brotli and gzip", () => {
  assert.equal(typeof decoder.decodeCorpusPayload, "function");
  for (const compression of ["brotli", "gzip"]) {
    const { encoded, manifest } = fixture(compression, Buffer.alloc(1024 * 1024, 65));
    assert.throws(() => decoder.decodeCorpusPayload(encoded.toString("base64"), { ...manifest, uncompressedBytes: 32 }), /large|limit|length|size/i);
    assert.throws(() => decoder.decodeCorpusPayload(encoded.toString("base64"), { ...manifest, uncompressedBytes: -1 }), /manifest/i);
  }
});
test("build decoder rejects trailing Brotli bytes even with matching hashes", () => {
  assert.equal(typeof decoder.decodeCorpusPayload, "function");
  const { encoded, manifest } = fixture();
  const trailing = Buffer.concat([encoded, Buffer.from([0])]);
  assert.throws(() => decoder.decodeCorpusPayload(trailing.toString("base64"), { ...manifest, compressedBytes: trailing.length, compressedSha256: hash(trailing) }), /trailing/i);
});
