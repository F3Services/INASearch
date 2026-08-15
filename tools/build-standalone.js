#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const { buildDefinitionCatalog } = require("./definition-catalog");
const { applyStatuteReferences } = require("./statute-references");
const { applyStatuteFootnotes } = require("./statute-footnotes");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { packLegalReferences } = require("./pack-legal-references");
const { indexStatuteRunIns } = require("./statute-run-ins");
const { applyStatuteStatusMetadata } = require("./statute-status");
const { FORMAT: CORPUS_PACKING_FORMAT, packCorpusForDelivery } = require("../src/INASearch-Corpus-Packing");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "src");

function readAssignedObject(fileName, propertyName) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(sourceDir, fileName), "utf8"), sandbox, { filename: fileName });
  return JSON.parse(JSON.stringify(sandbox.window[propertyName]));
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeCompactJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function replaceDataBlock(html, name, id, value) {
  const start = `<!-- INA_SEARCH_${name}_DATA_START -->`;
  const end = `<!-- INA_SEARCH_${name}_DATA_END -->`;
  const replacement = `${start}\n  <script id="${id}" type="application/json">${safeJson(value)}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error(`Template is missing the ${name} data block.`);
  return html.replace(expression, replacement);
}

function replaceRuntimeBlock(html, name, id, source) {
  const start = `<!-- INA_SEARCH_${name}_RUNTIME_START -->`;
  const end = `<!-- INA_SEARCH_${name}_RUNTIME_END -->`;
  const replacement = `${start}\n  <script id="${id}">${source.replace(/<\/script/gi, "<\\/script")}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error(`Template is missing the ${name} runtime block.`);
  return html.replace(expression, replacement);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compressCorpus(corpus, deliveryPacking = "") {
  const json = Buffer.from(JSON.stringify(corpus), "utf8");
  const gzip = zlib.gzipSync(json, { level: 9, mtime: 0 });
  return {
    manifest: {
      schemaVersion: 1,
      corpusSchemaVersion: corpus.schemaVersion,
      corpusVersion: corpus.corpusVersion,
      encoding: "base64",
      compression: "gzip",
      mediaType: "application/gzip",
      contentType: "application/json",
      charset: "utf-8",
      ...(deliveryPacking ? { deliveryPacking } : {}),
      compressedBytes: gzip.byteLength,
      uncompressedBytes: json.byteLength,
      compressedSha256: sha256(gzip),
      uncompressedSha256: sha256(json)
    },
    base64: gzip.toString("base64")
  };
}

function encodeUncompressedCorpus(corpus) {
  const text = safeCompactJson(corpus);
  const bytes = Buffer.from(text, "utf8");
  return {
    manifest: {
      schemaVersion: 1,
      corpusSchemaVersion: corpus.schemaVersion,
      corpusVersion: corpus.corpusVersion,
      encoding: "utf-8",
      compression: "none",
      mediaType: "application/json",
      contentType: "application/json",
      charset: "utf-8",
      uncompressedBytes: bytes.byteLength,
      uncompressedSha256: sha256(bytes)
    },
    payload: text
  };
}

function htmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function replaceCorpusBlock(html, payload, manifest) {
  const start = "<!-- INA_SEARCH_CORPUS_DATA_START -->";
  const end = "<!-- INA_SEARCH_CORPUS_DATA_END -->";
  const attributes = [
    ["schema-version", manifest.schemaVersion],
    ["corpus-schema-version", manifest.corpusSchemaVersion],
    ["corpus-version", manifest.corpusVersion],
    ["encoding", manifest.encoding],
    ["compression", manifest.compression],
    ["media-type", manifest.mediaType],
    ["content-type", manifest.contentType],
    ["charset", manifest.charset],
    ["delivery-packing", manifest.deliveryPacking],
    ["compressed-bytes", manifest.compressedBytes],
    ["uncompressed-bytes", manifest.uncompressedBytes],
    ["compressed-sha256", manifest.compressedSha256],
    ["uncompressed-sha256", manifest.uncompressedSha256]
  ].filter(([, value]) => value !== undefined).map(([name, value]) => `data-${name}="${htmlAttribute(value)}"`).join(" ");
  const scriptType = manifest.compression === "none" ? "application/json" : "application/gzip";
  const replacement = `${start}\n  <script id="inaSearchCorpusData" type="${scriptType}" ${attributes}>${payload}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error("Template is missing the CORPUS data block.");
  return html.replace(expression, replacement);
}

function makeBuild(template, corpus, profile, options) {
  const deliveryCorpus = options.compactCorpus ? packCorpusForDelivery(corpus) : corpus;
  const corpusPayload = options.uncompressedCorpus
    ? encodeUncompressedCorpus(deliveryCorpus)
    : compressCorpus(deliveryCorpus, options.compactCorpus ? CORPUS_PACKING_FORMAT : "");
  if (!corpusPayload.payload) corpusPayload.payload = corpusPayload.base64;
  const buildSignature = crypto.createHash("sha256")
    .update(template)
    .update(corpus.corpusVersion || "")
    .update(corpusPayload.manifest.uncompressedSha256)
    .update(options.variant)
    .digest("hex")
    .slice(0, 24);
  const buildData = {
    schemaVersion: 1,
    variant: options.variant,
    displayName: options.displayName,
    fileName: options.fileName,
    instanceId: buildSignature,
    hasLocalUscCache: options.hasLocalUscCache,
    corpusCompression: corpusPayload.manifest.compression,
    generatedAt: new Date().toISOString()
  };
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${options.displayName}</title>`);
  html = replaceDataBlock(html, "BUILD", "inaSearchBuildData", buildData);
  html = replaceDataBlock(html, "CORPUS_MANIFEST", "inaSearchCorpusManifest", corpusPayload.manifest);
  html = replaceCorpusBlock(html, corpusPayload.payload, corpusPayload.manifest);
  html = replaceDataBlock(html, "PROFILE", "inaSearchProfileData", profile);
  if (options.compactShell) {
    for (const [name, id] of [["BUILD", "inaSearchBuildData"], ["CORPUS_MANIFEST", "inaSearchCorpusManifest"], ["PROFILE", "inaSearchProfileData"]]) {
      const expression = new RegExp(`(<!-- INA_SEARCH_${name}_DATA_START -->\\s*<script id="${id}"[^>]*>)([\\s\\S]*?)(<\\/script>\\s*<!-- INA_SEARCH_${name}_DATA_END -->)`);
      html = html.replace(expression, (_, open, json, close) => `${open}${safeCompactJson(JSON.parse(json))}${close}`);
    }
    html = html.replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1")}</style>`);
    html = html.replace(/<!--(?! INA_SEARCH_)[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]+/gm, "").replace(/^\/\/[^\n]*\n/gm, "").replace(/\n{2,}/g, "\n");
  }
  fs.writeFileSync(path.join(root, options.fileName), html);
  return { fileName: options.fileName, bytes: Buffer.byteLength(html), instanceId: buildSignature, manifest: corpusPayload.manifest };
}

let template = fs.readFileSync(path.join(sourceDir, "INASearch.template.html"), "utf8");
template = replaceRuntimeBlock(template, "STORAGE", "inaSearchStorageRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Storage.js"), "utf8"));
template = replaceRuntimeBlock(template, "CORPUS_PACKING", "inaSearchCorpusPackingRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Corpus-Packing.js"), "utf8"));
template = replaceRuntimeBlock(template, "UPDATER", "inaSearchUpdaterRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Updater.js"), "utf8"));
const fullCorpus = readAssignedObject("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
const statuteFootnoteSource = readAssignedObject("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES");
applyStatuteFootnotes(fullCorpus, statuteFootnoteSource);
fullCorpus.cfr = readAssignedObject("INASearch-CFR.js", "INA_SEARCH_CFR");
const statuteReferenceSource = readAssignedObject("INASearch-Statute-References.js", "INA_SEARCH_STATUTE_REFERENCES");
applyStatuteReferences(fullCorpus, statuteReferenceSource);
applyGeneratedLegalReferences(fullCorpus);
indexStatuteRunIns(fullCorpus);
applyStatuteStatusMetadata(fullCorpus);
const definitionSource = readAssignedObject("INASearch-Definitions.js", "INA_SEARCH_DEFINITIONS");
const uscisGlossarySource = readAssignedObject("INASearch-USCIS-Glossary.js", "INA_SEARCH_USCIS_GLOSSARY");
fullCorpus.definitions = buildDefinitionCatalog(fullCorpus, definitionSource, uscisGlossarySource);
packLegalReferences(fullCorpus);
const defaultProfile = readAssignedObject("INASearch-Profile.js", "INA_SEARCH_PROFILE");

const results = [
  makeBuild(template, fullCorpus, defaultProfile, {
    variant: "standard",
    displayName: "INASearch",
    fileName: "INASearch.html",
    hasLocalUscCache: true,
    compactCorpus: true
  }),
  makeBuild(template, fullCorpus, defaultProfile, {
    variant: "uncompressed",
    displayName: "INASearch (Uncompressed Corpus)",
    fileName: "INASearch-Uncompressed.html",
    hasLocalUscCache: true,
    uncompressedCorpus: true,
    compactShell: true
  })
];

for (const result of results) {
  const corpusSize = result.manifest.compression === "gzip"
    ? `${result.manifest.compressedBytes} gzip bytes`
    : `${result.manifest.uncompressedBytes} uncompressed JSON bytes`;
  console.log(`${result.fileName}\t${result.bytes} bytes\t${result.instanceId}\t${corpusSize}`);
}
