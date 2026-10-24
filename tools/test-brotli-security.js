#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { buildBrotliRuntime } = require("./build-brotli");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function runtime() {
  const context = vm.createContext({ WebAssembly, Uint8Array, TextDecoder, TextEncoder, atob, Blob, Response, crypto: crypto.webcrypto });
  vm.runInContext(buildBrotliRuntime(), context);
  return context;
}
const plain = Buffer.from("Exact bytes: § café & text.");
const compressed = zlib.brotliCompressSync(plain);
const decode = async (bytes, limit = plain.length) => runtime().INASearchBrotli.decode(bytes, limit);
test("valid exact-size Brotli output remains byte-identical", async () => {
  assert.deepEqual(Buffer.from(await decode(compressed)), plain);
});
test("Brotli output must stop at the supplied byte ceiling", async () => {
  const expansion = zlib.brotliCompressSync(Buffer.alloc(16 * 1024 * 1024, 65));
  await assert.rejects(decode(expansion, 1024), /size|limit|byte|output/i);
});
test("Brotli rejects trailing bytes and concatenated streams", async () => {
  for (const suffix of [Buffer.from([0]), compressed]) {
    await assert.rejects(decode(Buffer.concat([compressed, suffix])), /trailing|invalid|Brotli/i);
  }
});
test("Brotli rejects every truncated prefix", async () => {
  for (let end = 0; end < compressed.length; end++) await assert.rejects(decode(compressed.subarray(0, end)));
});
test("patched decoder rejects the upstream invalid padding regression", async () => {
  // rust-brotli-decompressor PADDING_2 regression, fixed in 5.0.1.
  const invalid = Buffer.from("1b4a0000c4f4a469bd79252d22b552ea830d387068b271c041761e36c6ce1384e836f22a0ce789687a04492faaf731a19b0d48b7f01f483342a59c312697a9c6be67855202", "hex");
  await assert.rejects(decode(invalid, 75), /Brotli|invalid/i);
});
test("decoder rejects the CVE-2026-111497 block-switch regression", async () => {
  // Official Node.js regression input; exercise only the bounds-checked WASM.
  const invalid = Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex");
  await assert.rejects(decode(invalid, 1024));
});
test("invalid output ceilings are rejected before allocation", async () => {
  for (const limit of [undefined, -1, 0, 1.5, Infinity, 2 ** 32, 64 * 1024 * 1024 + 1]) {
    await assert.rejects(Promise.resolve().then(() => runtime().INASearchBrotli.decode(compressed, limit)), /size|limit|byte|output/i);
  }
});
test("startup passes the manifest output ceiling and keeps the pre-decode hash gate", async () => {
  const context = runtime();
  vm.runInContext(fs.readFileSync(require.resolve("../src/INASearch-Startup.js"), "utf8"), context);
  const manifest = { schemaVersion: 1, compression: "brotli", encoding: "base64", mediaType: "application/brotli", contentType: "application/json", charset: "utf-8", compressedBytes: compressed.length, compressedSha256: hash(compressed), uncompressedBytes: plain.length - 1, uncompressedSha256: hash(plain) };
  await assert.rejects(context.INASearchStartup.decode(compressed.toString("base64"), manifest, false), /output exceeds its size limit/i);
  const invalid = Buffer.from(compressed); invalid[0] ^= 1;
  await assert.rejects(context.INASearchStartup.decode(invalid.toString("base64"), manifest, false), /compressed corpus failed its SHA-256/);
});
test("gzip startup enforces the manifest ceiling during decompression", async () => {
  const context = runtime();
  context.DecompressionStream = DecompressionStream;
  vm.runInContext(fs.readFileSync(require.resolve("../src/INASearch-Startup.js"), "utf8"), context);
  const bytes = Buffer.alloc(1024 * 1024, 65), encoded = zlib.gzipSync(bytes);
  const manifest = { schemaVersion: 1, compression: "gzip", encoding: "base64", mediaType: "application/gzip", contentType: "application/json", charset: "utf-8", compressedBytes: encoded.length, compressedSha256: hash(encoded), uncompressedBytes: 32, uncompressedSha256: hash(bytes) };
  await assert.rejects(context.INASearchStartup.decode(encoded.toString("base64"), manifest, false), /size limit/);
});
function workerRuntime() {
  const { Worker: Thread } = require("node:worker_threads");
  const { resolveObjectURL } = require("node:buffer");
  let started = 0, stopped = 0;
  class Worker {
    constructor(url) {
      started++;
      this.ready = resolveObjectURL(url).text().then(source => {
        if (this.stopped) return;
        this.thread = new Thread(`const { parentPort } = require('node:worker_threads');
          globalThis.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);
          ${source}
          parentPort.on('message', data => onmessage({ data }));`, { eval: true });
        this.thread.on("message", data => this.onmessage?.({ data }));
        this.thread.on("error", error => this.onerror?.(error));
        return this.thread;
      });
    }
    postMessage(data) { this.ready.then(thread => thread?.postMessage(data)); }
    terminate() { this.stopped = true; stopped++; this.thread?.terminate(); }
  }
  const context = vm.createContext({ Worker, URL, WebAssembly, Uint8Array, TextDecoder, TextEncoder, atob, Blob, setTimeout, clearTimeout });
  vm.runInContext(buildBrotliRuntime(), context);
  return { context, counts: () => ({ started, stopped }) };
}
test("real background worker handles concurrent jobs, failures and cleanup", async () => {
  const { context, counts } = workerRuntime();
  const limit = plain.length;
  const output = await Promise.all([context.INASearchBrotli.decode(compressed, limit), context.INASearchBrotli.decode(compressed, limit)]);
  output.forEach(bytes => assert.deepEqual(Buffer.from(bytes), plain));
  assert.deepEqual(counts(), { started: 1, stopped: 1 });
  await assert.rejects(context.INASearchBrotli.decode(Buffer.concat([compressed, Buffer.from([0])]), limit), /Trailing/);
  assert.deepEqual(Buffer.from(await context.INASearchBrotli.decode(compressed, limit)), plain);
  assert.deepEqual(counts(), { started: 3, stopped: 3 });
});
test("worker construction failure retains bounded offline fallback", async () => {
  const context = vm.createContext({ Worker: class { constructor() { throw new Error("Workers blocked"); } }, URL, WebAssembly, Uint8Array, TextDecoder, TextEncoder, atob, Blob });
  vm.runInContext(buildBrotliRuntime(), context);
  assert.deepEqual(Buffer.from(await context.INASearchBrotli.decode(compressed, plain.length)), plain);
  await assert.rejects(context.INASearchBrotli.decode(compressed, 1), /size limit/);
});
test("worker crashes and timeout reject outstanding jobs and terminate the worker", async () => {
  for (const mode of ["error", "messageerror", "timeout", "postMessage"]) {
    let instance, terminated = 0, timeout;
    class Worker {
      constructor() { instance = this; }
      postMessage() { if (mode === "postMessage") throw new Error("post failure"); }
      terminate() { terminated++; }
    }
    const context = vm.createContext({ Worker, URL, Blob, WebAssembly, Uint8Array, TextDecoder, TextEncoder, atob, setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} });
    vm.runInContext(buildBrotliRuntime(), context);
    const result = context.INASearchBrotli.decode(compressed, plain.length);
    if (mode === "error") instance.onerror({ preventDefault() {} });
    if (mode === "messageerror") instance.onmessageerror();
    if (mode === "timeout") timeout();
    await assert.rejects(result, /worker|time limit|post failure/i);
    assert.equal(terminated, 1);
  }
});
