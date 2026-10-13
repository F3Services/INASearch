#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const { compactShell } = require("./compact-shell");
const { buildBrotliRuntime } = require("./build-brotli");
const { prepareDeliveryCorpus } = require("./corpus-delivery");
const { buildFaqMarkup } = require("./build-about");
const { buildDefinitionCatalog } = require("./definition-catalog");
const { applyStatuteReferences } = require("./statute-references");
const { applyStatuteFootnotes } = require("./statute-footnotes");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { packLegalReferences } = require("./pack-legal-references");
const { indexStatuteRunIns } = require("./statute-run-ins");
const { applyStatuteStatusMetadata } = require("./statute-status");
const status = require("../src/INASearch-Statute-Status");
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
  return html.replace(expression, () => replacement);
}

function replaceRuntimeBlock(html, name, id, source) {
  const start = `<!-- INA_SEARCH_${name}_RUNTIME_START -->`;
  const end = `<!-- INA_SEARCH_${name}_RUNTIME_END -->`;
  const replacement = `${start}\n  <script id="${id}">${source.replace(/<\/script/gi, "<\\/script")}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error(`Template is missing the ${name} runtime block.`);
  return html.replace(expression, () => replacement);
}

function replaceInertRuntimeBlock(html, name, id, source) {
  const start = `<!-- INA_SEARCH_${name}_RUNTIME_START -->`;
  const end = `<!-- INA_SEARCH_${name}_RUNTIME_END -->`;
  const replacement = `${start}\n  <script id="${id}" type="text/plain">${source.replace(/<\/script/gi, "<\\/script")}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error(`Template is missing the ${name} runtime block.`);
  return html.replace(expression, () => replacement);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compressCorpus(corpus, deliveryPacking = "") {
  const json = Buffer.from(JSON.stringify(corpus), "utf8");
  const compressed = zlib.brotliCompressSync(json, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  return {
    manifest: {
      schemaVersion: 1,
      corpusSchemaVersion: corpus.schemaVersion,
      corpusVersion: corpus.corpusVersion,
      encoding: "base64",
      compression: "brotli",
      mediaType: "application/brotli",
      contentType: "application/json",
      charset: "utf-8",
      ...(deliveryPacking ? { deliveryPacking } : {}),
      compressedBytes: compressed.byteLength,
      uncompressedBytes: json.byteLength,
      compressedSha256: sha256(compressed),
      uncompressedSha256: sha256(json)
    },
    base64: compressed.toString("base64")
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
    , ["full-uncompressed-sha256", manifest.fullUncompressedSha256]
    , ["shards", manifest.shards ? JSON.stringify(manifest.shards) : undefined]
  ].filter(([, value]) => value !== undefined).map(([name, value]) => `data-${name}="${htmlAttribute(value)}"`).join(" ");
  const scriptType = manifest.compression === "none" ? "application/json" : `application/${manifest.compression}`;
  const replacement = `${start}\n  <script id="inaSearchCorpusData" type="${scriptType}" ${attributes}>${payload}</script>\n  ${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(html)) throw new Error("Template is missing the CORPUS data block.");
  return html.replace(expression, () => replacement);
}

function openingIndexData(template, corpus) {
  const start = template.indexOf("    function navigationTitleCase(");
  const end = template.indexOf("    function statuteStatus(", start);
  const titleCase = vm.runInNewContext(`(${template.slice(start, end).trim()})`);
  const chapters = new Map();
  const sectionsByChapter = new Map();
  for (const section of corpus.title8.sections) {
    const chapterNumber = section.breadcrumb?.[0]?.number;
    if (chapterNumber === undefined) continue;
    if (!sectionsByChapter.has(chapterNumber)) sectionsByChapter.set(chapterNumber, []);
    sectionsByChapter.get(chapterNumber).push(section);
  }
  for (const section of corpus.title8.sections) {
    const chapter = section.breadcrumb?.[0];
    if (!chapter || chapters.has(chapter.number)) continue;
    const containsIna = corpus.title8.sections.some(candidate => candidate.breadcrumb?.[0]?.number === chapter.number && corpus.inaCrosswalk.some(row => row.hasEquivalent !== false && String(row.uscSection) === String(candidate.section)));
    const badges = [];
    if (containsIna) badges.push(["Contains INA", "ina-membership"]);
    const disposition = status.dispositionBadge(corpus.title8.chapterDispositions?.[chapter.number]);
    const aggregate = status.aggregateSections(sectionsByChapter.get(chapter.number));
    if (disposition) badges.push([disposition.label, disposition.status]);
    else if (aggregate) badges.push([status.label(aggregate), aggregate]);
    chapters.set(chapter.number, [`usc:title:8:chapter:${encodeURIComponent(chapter.number)}`, `Chapter ${chapter.number}`, titleCase(chapter.title), badges, "intermediate"]);
  }
  return {
    ina: corpus.inaHierarchy.titles.map(title => [title.id, `Title ${title.number}`, titleCase(title.heading)]),
    usc: [...chapters.values()],
    referencedUsc: (corpus.referencedUsc?.titles || []).map(title => {
      const disposition = status.aggregateSections(title.sections || []);
      return [`usc:title:${title.number}`, `Title ${title.number}`, titleCase(title.name), disposition ? [[status.label(disposition), disposition]] : []];
    }),
    cfr: [...new Set(corpus.cfr.parts.map(part => Number(part.title)))].sort((a, b) => a - b).map(number => [`cfr:title:${number}`, `Title ${number}`, titleCase(corpus.cfr.titleNames?.[number] || `Title ${number}`)]),
    urls: { ina: corpus.inaHierarchy.source.detailUrl, usc: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8&num=0&edition=prelim" }
  };
}

function makeBuild(template, corpus, profile, options) {
  const deliveryCorpus = options.compactCorpus ? packCorpusForDelivery(corpus) : corpus;
  const fullPayload = options.uncompressedCorpus
    ? encodeUncompressedCorpus(deliveryCorpus)
    : compressCorpus(deliveryCorpus, options.compactCorpus ? CORPUS_PACKING_FORMAT : "");
  const corpusPayload = fullPayload;
  if (!corpusPayload.payload) corpusPayload.payload = corpusPayload.base64;
  const buildSignature = crypto.createHash("sha256")
    .update(template)
    .update(corpus.corpusVersion || "")
    .update(fullPayload.manifest.uncompressedSha256)
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
    title8ChapterDispositions: {
      sourceSha256: corpus.sources.title8.sourceSha256,
      labels: corpus.title8.chapterDispositions
    },
    cfrHierarchyVersion: corpus.legalReferenceMetadata.cfrHierarchyVersion,
    statuteRunInRevision: corpus.title8.runInRevision,
    statuteNoteLayoutRevision: corpus.title8.houseFootnoteMetadata?.noteLayoutRevision || 0,
    referencedUscVersion: corpus.referencedUsc?.version || "",
    corpusCompression: corpusPayload.manifest.compression,
    generatedAt: new Date().toISOString()
  };
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${options.displayName}</title>`);
  html = replaceDataBlock(html, "BUILD", "inaSearchBuildData", buildData);
  html = replaceDataBlock(html, "CORPUS_MANIFEST", "inaSearchCorpusManifest", corpusPayload.manifest);
  html = replaceCorpusBlock(html, corpusPayload.payload, corpusPayload.manifest);
  html = replaceDataBlock(html, "PROFILE", "inaSearchProfileData", profile);
  html = html.replace("<!-- INA_SEARCH_OPENING_INDEX -->", `<script id="inaSearchOpeningIndex" type="application/json">${safeCompactJson(options.openingIndex)}</script><script id="inaSearchOpeningIndexRuntime">INASearchStartup.showOpeningIndex(JSON.parse(document.getElementById("inaSearchOpeningIndex").textContent))</script>`);
  // The complete shell and its opening-page code precede the large inert data.
  // Repeat visits open verified content from IndexedDB without reading this fallback payload.
  const corpusBlock = html.match(/<!-- INA_SEARCH_CORPUS_DATA_START -->[\s\S]*?<!-- INA_SEARCH_CORPUS_DATA_END -->/)[0];
  html = html.replace(corpusBlock, "");
  const bodyEnd = html.lastIndexOf("</body>");
  html = html.slice(0, bodyEnd) + `${corpusBlock}\n<script>INASearchStartup.register("inaSearchCorpusData")</script>\n` + html.slice(bodyEnd);
  if (options.compactShell) {
    for (const [name, id] of [["BUILD", "inaSearchBuildData"], ["CORPUS_MANIFEST", "inaSearchCorpusManifest"], ["PROFILE", "inaSearchProfileData"]]) {
      const expression = new RegExp(`(<!-- INA_SEARCH_${name}_DATA_START -->\\s*<script id="${id}"[^>]*>)([\\s\\S]*?)(<\\/script>\\s*<!-- INA_SEARCH_${name}_DATA_END -->)`);
      html = html.replace(expression, (_, open, json, close) => `${open}${safeCompactJson(JSON.parse(json))}${close}`);
    }
  }
  const destination = path.join(root, options.outputDirectory || "", options.fileName);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, html);
  return { fileName: options.fileName, bytes: Buffer.byteLength(html), instanceId: buildSignature, manifest: corpusPayload.manifest };
}

async function main() {
let template = fs.readFileSync(path.join(sourceDir, "INASearch.template.html"), "utf8");
if (!template.includes("<!-- INA_SEARCH_FAQ -->")) throw new Error("The About FAQ placeholder is missing.");
template = template.replace("<!-- INA_SEARCH_FAQ -->", () => buildFaqMarkup(fs.readFileSync(path.join(root, "FAQ.md"), "utf8")));
const annotationRuntimeSource = fs.readFileSync(path.join(sourceDir, "INASearch-Annotations.js"), "utf8");
template = replaceRuntimeBlock(template, "STORAGE", "inaSearchStorageRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Storage.js"), "utf8"));
template = replaceRuntimeBlock(template, "CORPUS_PACKING", "inaSearchCorpusPackingRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Corpus-Packing.js"), "utf8"));
template = replaceRuntimeBlock(template, "CORPUS_SHARDS", "inaSearchCorpusShardsRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Corpus-Shards.js"), "utf8"));
template = replaceRuntimeBlock(template, "STATUTE_STATUS", "inaSearchStatuteStatusRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Statute-Status.js"), "utf8"));
template = replaceRuntimeBlock(template, "STARTUP", "inaSearchStartupRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Startup.js"), "utf8"));
template = replaceRuntimeBlock(template, "BROTLI", "inaSearchBrotliRuntime", buildBrotliRuntime());
template = template.replace("<!-- INA_SEARCH_THIRD_PARTY_LICENSES -->", () => `<!-- INA_SEARCH_THIRD_PARTY_LICENSES\nINASearch application code\n\n${fs.readFileSync(path.join(root, "LICENSE"), "utf8")}\n${fs.readFileSync(path.join(root, "THIRD-PARTY-NOTICES.txt"), "utf8")}\n-->`);
template = replaceRuntimeBlock(template, "INSERTIONS", "inaSearchInsertionsRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Insertions.js"), "utf8"));
template = replaceRuntimeBlock(template, "ANNOTATIONS", "inaSearchAnnotationsRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Annotations.js"), "utf8"));
template = replaceRuntimeBlock(template, "COMMAND", "inaSearchCommandRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Command.js"), "utf8"));
template = replaceRuntimeBlock(template, "WORKSPACE", "inaSearchWorkspaceRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Workspace.js"), "utf8"));
template = replaceRuntimeBlock(template, "OCCURRENCE", "inaSearchOccurrenceRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Occurrence.js"), "utf8"));
template = replaceRuntimeBlock(template, "QUERY", "inaSearchQueryRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Query.js"), "utf8"));
template = replaceInertRuntimeBlock(template, "SEARCH_WORKER", "inaSearchSearchWorkerRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Search-Worker.js"), "utf8"));
template = replaceRuntimeBlock(template, "EMBEDDED_REFERENCES", "inaSearchEmbeddedReferencesRuntime", fs.readFileSync(path.join(root, "tools", "embedded-references.js"), "utf8"));
template = replaceRuntimeBlock(template, "LEGAL_REFERENCES", "inaSearchLegalReferencesRuntime", fs.readFileSync(path.join(root, "tools", "legal-references.js"), "utf8"));
template = replaceRuntimeBlock(template, "CFR_HIERARCHY", "inaSearchCfrHierarchyRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-CFR-Hierarchy.js"), "utf8"));
template = replaceRuntimeBlock(template, "UPDATER", "inaSearchUpdaterRuntime", fs.readFileSync(path.join(sourceDir, "INASearch-Updater.js"), "utf8"));
const fullCorpus = readAssignedObject("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
fullCorpus.inaHierarchy = readAssignedObject("INASearch-INA-Hierarchy.js", "INA_SEARCH_INA_HIERARCHY");
fullCorpus.legalReferencePolicy = readAssignedObject("INASearch-Legal-Reference-Policy.js", "INA_SEARCH_LEGAL_REFERENCE_POLICY");
const statuteFootnoteSource = readAssignedObject("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES");
applyStatuteFootnotes(fullCorpus, statuteFootnoteSource);
fullCorpus.cfr = readAssignedObject("INASearch-CFR.js", "INA_SEARCH_CFR");
const statuteReferenceSource = readAssignedObject("INASearch-Statute-References.js", "INA_SEARCH_STATUTE_REFERENCES");
applyStatuteReferences(fullCorpus, statuteReferenceSource);
require("./historical-ina.js").applyHistoricalIna(fullCorpus);
applyStatuteStatusMetadata(fullCorpus);
require("./historical-usc.js").applyHistoricalUsc(fullCorpus);
// Historical supplements have their own versions; a new current-law source
// must still change the delivered corpus identity for the browser cache.
if (fullCorpus.title8Update) fullCorpus.corpusVersion = fullCorpus.title8Update.corpusVersion;
indexStatuteRunIns(fullCorpus);
fullCorpus.referencedUsc = JSON.parse(fs.readFileSync(path.join(root, "sources/legal/referenced-usc/corpus.json"), "utf8"));
indexStatuteRunIns({ title8: { sections: fullCorpus.referencedUsc.titles.flatMap(title => title.sections) } });
fullCorpus.legalReferenceExceptions = JSON.parse(fs.readFileSync(path.join(root, "sources", "legal", "embedded-reference-exceptions.json"), "utf8"));
fullCorpus.historicalLocatorCorrections = JSON.parse(fs.readFileSync(path.join(root, "sources", "legal", "historical-reference-locators.json"), "utf8"));
applyGeneratedLegalReferences(fullCorpus);
require("./historical-ina.js").applyHistoricalReferences(fullCorpus);
const definitionSource = readAssignedObject("INASearch-Definitions.js", "INA_SEARCH_DEFINITIONS");
const uscisGlossarySource = readAssignedObject("INASearch-USCIS-Glossary.js", "INA_SEARCH_USCIS_GLOSSARY");
fullCorpus.definitions = buildDefinitionCatalog(fullCorpus, definitionSource, uscisGlossarySource);
packLegalReferences(fullCorpus);
const deliveredCorpus = prepareDeliveryCorpus(fullCorpus);
const defaultProfile = readAssignedObject("INASearch-Profile.js", "INA_SEARCH_PROFILE");
const openingIndex = openingIndexData(template, fullCorpus);
const shellStyle = template.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
const annotationCssSource = shellStyle.split("\n").filter(line => /citation-note|user-highlight|annotation-selection|artifact-note|data-artifact-kind/.test(line)).join("\n");
const embeddedFontBytes = [...template.matchAll(/data:font\/[^;]+;base64,([A-Za-z0-9+/=]+)/g)].reduce((sum, match) => sum + Buffer.from(match[1], "base64").byteLength, 0);
if (/\b(?:from|require\s*\()\s*["'](?:@[^"']+\/)?pretext["']/i.test(template)) throw new Error("Pretext was accidentally included in the standalone shell.");
const annotationBundleReport = {
  javascriptBytes: Buffer.byteLength(annotationRuntimeSource),
  cssBytes: Buffer.byteLength(annotationCssSource),
  fontBytes: embeddedFontBytes,
  pretextIncluded: false
};

const debugTemplate = await compactShell(template, { debug: true });
template = await compactShell(template);
const variants = [
  {
    variant: "standard",
    displayName: "INASearch",
    fileName: "INASearch.html",
    hasLocalUscCache: true,
    compactCorpus: true,
    compactShell: true
  },
  {
    variant: "uncompressed",
    displayName: "INASearch (Uncompressed Corpus)",
    fileName: "INASearch-Uncompressed.html",
    hasLocalUscCache: true,
    uncompressedCorpus: true,
    compactShell: true
  }
];
const results = variants.map(options => makeBuild(template, deliveredCorpus, defaultProfile, { ...options, openingIndex }));
for (const options of variants) makeBuild(debugTemplate, deliveredCorpus, defaultProfile, { ...options, openingIndex, outputDirectory: "tmp/debug" });

for (const result of results) {
  const corpusSize = result.manifest.compression !== "none"
    ? `${result.manifest.compressedBytes} ${result.manifest.compression} bytes`
    : `${result.manifest.uncompressedBytes} uncompressed JSON bytes`;
  console.log(`${result.fileName}\t${result.bytes} bytes\t${result.instanceId}\t${corpusSize}`);
}
console.log(`annotations\t${annotationBundleReport.javascriptBytes} JS bytes\t${annotationBundleReport.cssBytes} CSS bytes\t${annotationBundleReport.fontBytes} font bytes\tPretext ${annotationBundleReport.pretextIncluded ? "included" : "absent"}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
