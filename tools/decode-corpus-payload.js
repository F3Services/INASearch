"use strict";
require("./check-node");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const MAX_BYTES = 64 * 1024 * 1024;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function decodeCorpusPayload(text, manifest, label = "corpus") {
  const validSize = size => Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES;
  const validHash = hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
  assert(manifest?.schemaVersion === 1 && manifest.contentType === "application/json" && manifest.charset === "utf-8" && validSize(manifest.uncompressedBytes) && validHash(manifest.uncompressedSha256), `${label}: invalid manifest`);
  let bytes;
  if (["gzip", "brotli"].includes(manifest.compression)) {
    assert(manifest.encoding === "base64" && manifest.mediaType === `application/${manifest.compression}` && validSize(manifest.compressedBytes) && validHash(manifest.compressedSha256), `${label}: invalid compressed manifest`);
    // Bound allocation before base64 decoding as well as before decompression.
    assert(text.length <= Math.ceil(manifest.compressedBytes / 3) * 4 + 1024, `${label}: compressed byte count`);
    const compressed = Buffer.from(text.replace(/\s+/g, ""), "base64");
    assert.equal(compressed.length, manifest.compressedBytes, `${label}: compressed byte count`);
    assert.equal(sha256(compressed), manifest.compressedSha256, `${label}: compressed SHA-256`);
    const decompress = manifest.compression === "brotli" ? zlib.brotliDecompressSync : zlib.gunzipSync;
    const result = decompress(compressed, { maxOutputLength: manifest.uncompressedBytes, info: true });
    assert.equal(result.engine.bytesWritten, compressed.length, `${label}: trailing compressed data`);
    bytes = result.buffer;
  } else {
    assert(manifest.compression === "none" && manifest.encoding === "utf-8" && manifest.mediaType === "application/json", `${label}: invalid uncompressed manifest`);
    assert(text.length <= manifest.uncompressedBytes, `${label}: uncompressed byte count`);
    bytes = Buffer.from(text, "utf8");
  }
  assert.equal(bytes.length, manifest.uncompressedBytes, `${label}: uncompressed byte count`);
  assert.equal(sha256(bytes), manifest.uncompressedSha256, `${label}: uncompressed SHA-256`);
  return bytes;
}
module.exports = { decodeCorpusPayload };
