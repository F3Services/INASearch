#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const { buildDefinitionCatalog } = require("./definition-catalog");
const { applyStatuteReferences } = require("./statute-references");

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

function replaceDataBlock(html, name, id, value) {
  const start = `<!-- AUTHORITY_SEARCH_${name}_DATA_START -->`;
  const end = `<!-- AUTHORITY_SEARCH_${name}_DATA_END -->`;
  const replacement = `${start}\n  <script id="${id}" type="application/json">${safeJson(value)}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error(`Template is missing the ${name} data block.`);
  return html.replace(expression, replacement);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compressCorpus(corpus) {
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
      compressedBytes: gzip.byteLength,
      uncompressedBytes: json.byteLength,
      compressedSha256: sha256(gzip),
      uncompressedSha256: sha256(json)
    },
    base64: gzip.toString("base64")
  };
}

function htmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function replaceCorpusBlock(html, base64, manifest) {
  const start = "<!-- AUTHORITY_SEARCH_CORPUS_DATA_START -->";
  const end = "<!-- AUTHORITY_SEARCH_CORPUS_DATA_END -->";
  const attributes = [
    ["schema-version", manifest.schemaVersion],
    ["corpus-schema-version", manifest.corpusSchemaVersion],
    ["corpus-version", manifest.corpusVersion],
    ["encoding", manifest.encoding],
    ["compression", manifest.compression],
    ["media-type", manifest.mediaType],
    ["content-type", manifest.contentType],
    ["charset", manifest.charset],
    ["compressed-bytes", manifest.compressedBytes],
    ["uncompressed-bytes", manifest.uncompressedBytes],
    ["compressed-sha256", manifest.compressedSha256],
    ["uncompressed-sha256", manifest.uncompressedSha256]
  ].map(([name, value]) => `data-${name}="${htmlAttribute(value)}"`).join(" ");
  const replacement = `${start}\n  <script id="authoritySearchCorpusData" type="application/gzip" ${attributes}>${base64}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error("Template is missing the CORPUS data block.");
  return html.replace(expression, replacement);
}

function metadataOnlyTitle8(title8) {
  return {
    title: title8.title,
    name: title8.name,
    publication: title8.publication,
    currentThrough: title8.currentThrough,
    sourceCreatedAt: title8.sourceCreatedAt,
    isPositiveLaw: title8.isPositiveLaw,
    sourceUrl: title8.sourceUrl,
    sections: (title8.sections || []).map(section => ({
      id: section.id,
      section: section.section,
      heading: section.heading,
      status: section.status,
      identifier: section.identifier,
      breadcrumb: section.breadcrumb,
      url: section.url
    }))
  };
}

function makeBuild(template, corpus, profile, options) {
  const compressedCorpus = compressCorpus(corpus);
  const buildSignature = crypto.createHash("sha256")
    .update(template)
    .update(corpus.corpusVersion || "")
    .update(compressedCorpus.manifest.uncompressedSha256)
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
    generatedAt: new Date().toISOString()
  };
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${options.displayName}</title>`);
  html = replaceDataBlock(html, "BUILD", "authoritySearchBuildData", buildData);
  html = replaceDataBlock(html, "CORPUS_MANIFEST", "authoritySearchCorpusManifest", compressedCorpus.manifest);
  html = replaceCorpusBlock(html, compressedCorpus.base64, compressedCorpus.manifest);
  html = replaceDataBlock(html, "PROFILE", "authoritySearchProfileData", profile);
  fs.writeFileSync(path.join(root, options.fileName), html);
  return { fileName: options.fileName, bytes: Buffer.byteLength(html), instanceId: buildSignature, manifest: compressedCorpus.manifest };
}

const template = fs.readFileSync(path.join(sourceDir, "AuthoritySearch.template.html"), "utf8");
const fullCorpus = readAssignedObject("AuthoritySearch-Corpus.js", "AUTHORITY_SEARCH_CORPUS");
fullCorpus.visaTables = readAssignedObject("AuthoritySearch-Visa-Tables.js", "AUTHORITY_SEARCH_VISA_TABLES");
fullCorpus.visaTables.formQuestions = readAssignedObject("AuthoritySearch-Form-Questions.js", "AUTHORITY_SEARCH_FORM_QUESTIONS");
const statuteReferenceSource = readAssignedObject("AuthoritySearch-Statute-References.js", "AUTHORITY_SEARCH_STATUTE_REFERENCES");
applyStatuteReferences(fullCorpus, statuteReferenceSource);
const definitionSource = readAssignedObject("AuthoritySearch-Definitions.js", "AUTHORITY_SEARCH_DEFINITIONS");
fullCorpus.definitions = buildDefinitionCatalog(fullCorpus, definitionSource);
const defaultProfile = readAssignedObject("AuthoritySearch-Profile.js", "AUTHORITY_SEARCH_PROFILE");
const linkCorpus = JSON.parse(JSON.stringify(fullCorpus));
linkCorpus.title8 = metadataOnlyTitle8(fullCorpus.title8);

const results = [
  makeBuild(template, fullCorpus, defaultProfile, {
    variant: "standard",
    displayName: "AuthoritySearch",
    fileName: "AuthoritySearch.html",
    hasLocalUscCache: true
  }),
  makeBuild(template, linkCorpus, defaultProfile, {
    variant: "no-usc",
    displayName: "AuthoritySearch without local U.S. Code",
    fileName: "AuthoritySearch-no-USC.html",
    hasLocalUscCache: false
  })
];

for (const result of results) {
  console.log(`${result.fileName}\t${result.bytes} bytes\t${result.instanceId}\t${result.manifest.compressedBytes} gzip bytes`);
}
