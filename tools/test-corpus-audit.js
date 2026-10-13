#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const start = source.indexOf("    function renderCorpusAudit() {");
const end = source.indexOf("    function localCalendarDate", start);
assert(start >= 0 && end > start, "The About corpus audit renderer is missing.");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fixturePayload = (value, compressed = true) => {
  const json = Buffer.from(JSON.stringify(value));
  const gzip = compressed === "brotli" ? zlib.brotliCompressSync(json) : compressed ? zlib.gzipSync(json) : null;
  return { json, payload: gzip ? gzip.toString("base64") : json.toString(), manifest: {
    compression: compressed === "brotli" ? "brotli" : compressed ? "gzip" : "none", encoding: compressed ? "base64" : "utf-8",
    mediaType: compressed === "brotli" ? "application/brotli" : compressed ? "application/gzip" : "application/json", contentType: "application/json", charset: "utf-8",
    uncompressedBytes: json.length, uncompressedSha256: sha256(json),
    ...(gzip ? { compressedBytes: gzip.length, compressedSha256: sha256(gzip) } : {})
  } };
};

function render(manifest, fileName = "Fixture.html") {
  const els = { corpusManifestDetails: {}, corpusAuditPowerShell: {}, corpusPackagingDescription: {} };
  const context = { corpusManifest: manifest, els, build: { fileName }, escapeHtml: value => String(value) };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderCorpusAudit();`, context);
  return { details: els.corpusManifestDetails.innerHTML, script: els.corpusAuditPowerShell.textContent };
}

const metadata = fixturePayload({ _pack: { v: 1 }, title8: { sections: [{ id: "8-1" }] }, _shards: { v: 1, usc: [0] } });
const chunks = [fixturePayload({ id: 0, records: [["usc", 0, { body: [{ text: "A complete legal provision." }] }]] }), fixturePayload({ id: 1, records: [] })];
const manifest = { ...metadata.manifest, shards: chunks.map(chunk => chunk.manifest), fullUncompressedSha256: "fixture-full-hash" };
const audit = render(manifest);
assert(audit.details.includes("2 content chunks"), "The sharded About audit still describes its metadata payload as the complete corpus.");
assert(audit.details.includes(String(metadata.manifest.compressedBytes + chunks.reduce((sum, chunk) => sum + chunk.manifest.compressedBytes, 0))), "The About audit omits combined compressed byte counts.");

const pwshArgument = process.argv.indexOf("--pwsh");
const pwsh = pwshArgument >= 0 ? process.argv[pwshArgument + 1] : "pwsh";
function verifyExtraction(html, manifest, expected, label, expectedError = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inasearch-corpus-audit-"));
  try {
    fs.writeFileSync(path.join(directory, "Fixture.html"), html);
    fs.writeFileSync(path.join(directory, "extract.ps1"), render(manifest).script);
    const result = spawnSync(pwsh, ["-NoLogo", "-NoProfile", "-File", path.join(directory, "extract.ps1")], { cwd: directory, encoding: "utf8", timeout: 120000 });
    assert.ifError(result.error);
    if (expectedError) {
      assert.notEqual(result.status, 0, `${label}: Invalid embedded data was accepted.`);
      assert(result.stderr.includes(expectedError), `${label}: Expected ${expectedError}, received ${result.stderr}`);
      console.log(`PASS ${label}: emitted PowerShell rejects invalid embedded data`);
      return;
    }
    assert.equal(result.status, 0, `${label}: PowerShell extraction failed:\n${result.stdout}\n${result.stderr}`);
    for (const [file, bytes] of Object.entries(expected)) {
      assert.deepEqual(fs.readFileSync(path.join(directory, "INASearch-Corpus", file)), bytes, `${label}: Extracted ${file} changed its exact bytes.`);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "INASearch-Corpus/manifest.json"))), manifest, `${label}: Extraction did not retain the complete verification manifest.`);
    console.log(`PASS ${label}: emitted PowerShell extracts exact JSON bytes and verifies every payload`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function block(id, text) {
  // Attribute order differs from the former example's fragile fixed order.
  return `<script type="application/gzip" data-encoding="base64" id="${id}" data-schema-version="1">${text}</script>`;
}
const decoyScript = '<script id="app">const pattern = \'<script id="inaSearchCorpusData">wrong payload<\\/script>\';</script>';
const fixtureHtml = decoyScript + block("inaSearchCorpusManifest", JSON.stringify(manifest)) + block("inaSearchCorpusData", metadata.payload) + chunks.map((chunk, index) => block(`inaSearchCorpusShard${index}`, chunk.payload)).join("");
verifyExtraction(fixtureHtml, manifest, { "metadata.json": metadata.json, "chunk-0.json": chunks[0].json, "chunk-1.json": chunks[1].json }, "sharded corpus with reordered HTML attributes");
for (const [field, value, message] of [["compressedSha256", "incorrect-hash", "SHA-256 mismatch"], ["uncompressedBytes", chunks[1].json.length + 1, "Byte count mismatch"]]) {
  const invalid = structuredClone(manifest);
  invalid.shards[1][field] = value;
  verifyExtraction(fixtureHtml.replace(JSON.stringify(manifest), JSON.stringify(invalid)), invalid, {}, `incorrect chunk ${field}`, message);
}
verifyExtraction(fixtureHtml.replace(block("inaSearchCorpusShard1", chunks[1].payload), ""), manifest, {}, "missing content chunk", "Missing embedded block");

const brotli = fixturePayload({ text: "Brotli exact bytes: café § 101." }, "brotli");
verifyExtraction(block("inaSearchCorpusManifest", JSON.stringify(brotli.manifest)) + block("inaSearchCorpusData", brotli.payload), brotli.manifest, { "corpus.json": brotli.json }, "Brotli corpus");

const uncompressed = fixturePayload({ title8: { sections: [{ body: [{ text: "Expanded full corpus." }] }] } }, false);
verifyExtraction(block("inaSearchCorpusManifest", JSON.stringify(uncompressed.manifest)) + block("inaSearchCorpusData", uncompressed.payload), uncompressed.manifest, { "corpus.json": uncompressed.json }, "expanded uncompressed corpus");

const htmlArgument = process.argv.indexOf("--html");
if (htmlArgument >= 0) {
  const html = fs.readFileSync(path.resolve(process.argv[htmlArgument + 1]), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const read = id => scripts.find(match => new RegExp(`(?:^|\\s)id="${id}"`, "i").test(match[1]))[2];
  const realManifest = JSON.parse(read("inaSearchCorpusManifest"));
  const expected = {};
  const decode = (id, entry) => entry.compression === "brotli" ? zlib.brotliDecompressSync(Buffer.from(read(id).replace(/\s/g, ""), "base64")) : entry.compression === "gzip" ? zlib.gunzipSync(Buffer.from(read(id).replace(/\s/g, ""), "base64")) : Buffer.from(read(id));
  expected[realManifest.shards?.length ? "metadata.json" : "corpus.json"] = decode("inaSearchCorpusData", realManifest);
  (realManifest.shards || []).forEach((entry, index) => { expected[`chunk-${index}.json`] = decode(`inaSearchCorpusShard${index}`, entry); });
  verifyExtraction(html, realManifest, expected, `built corpus (${realManifest.shards?.length || 0} content chunks)`);
}
