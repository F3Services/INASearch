#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { statuteNodeMap, statuteSourceMap } = require("./statute-references");
const { applyStatuteFootnotes } = require("./statute-footnotes");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "sources", "legal", "source-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const houseArtifact = manifest.sources.flatMap(source => source.artifacts || []).find(artifact => artifact.id === "house-title-8-xml");
if (!houseArtifact) throw new Error("The legal-source manifest does not contain the House Title 8 XML artifact.");
const xmlPath = process.argv[2] || path.join(root, houseArtifact.path);
const xmlBytes = fs.readFileSync(xmlPath);
const xmlSha256 = crypto.createHash("sha256").update(xmlBytes).digest("hex");
if (path.resolve(xmlPath) === path.resolve(root, houseArtifact.path) && (xmlBytes.length !== houseArtifact.bytes || xmlSha256 !== houseArtifact.sha256)) {
  throw new Error("The committed House Title 8 XML does not match the legal-source manifest.");
}

function normalizeSectionNumber(value) {
  return String(value || "").replace(/\.\.\./g, " to ");
}

function readAssigned(fileName, propertyName) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", fileName), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window[propertyName]));
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
}

function govInfoSearchUrl(text) {
  return `https://www.govinfo.gov/app/search/%7B%22query%22%3A%22${encodeURIComponent(String(text || ""))}%22%7D`;
}

function classifyHref(href, text, localSections, localNodes) {
  const value = String(href || "");
  let match = value.match(/^\/us\/usc\/t([^/]+)\/s([^/]+)(?:\/(.*))?$/);
  if (match) {
    const title = match[1];
    const section = match[2];
    const targetPath = match[3] ? match[3].split("/").filter(Boolean) : [];
    const local = title === "8" && localSections.has(section) && (!targetPath.length || localNodes.has(`${section}:${targetPath.join("/")}`));
    return {
      family: "usc",
      resolution: local ? "local" : "official-source-only",
      targetKind: "usc",
      targetTitle: title,
      targetSection: section,
      targetPath,
      officialUrl: `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title${title}-section${section}`)}`
    };
  }
  match = value.match(/^\/us\/usc\/t([^/]+)\/(.*)$/);
  if (match) {
    return {
      family: "usc",
      resolution: "official-source-only",
      targetKind: "usc",
      targetTitle: match[1],
      targetPath: match[2].split("/").filter(Boolean),
      officialUrl: `https://uscode.house.gov/view.xhtml?path=${encodeURIComponent(`/prelim@title${match[1]}/${match[2]}`)}&edition=prelim`
    };
  }
  match = value.match(/^\/us\/pl\/(\d+)\/(\d+)(?:\/(.*))?$/);
  if (match) {
    return {
      family: "public-law",
      resolution: "official-source-only",
      targetKind: "public-law",
      targetCongress: match[1],
      targetLaw: match[2],
      targetPath: match[3] ? match[3].split("/").filter(Boolean) : [],
      officialUrl: `https://www.govinfo.gov/app/details/PLAW-${match[1]}publ${match[2]}`
    };
  }
  match = value.match(/^\/us\/stat\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    return {
      family: "statutes-at-large",
      resolution: "official-source-only",
      targetKind: "statutes-at-large",
      targetVolume: match[1],
      targetPage: match[2],
      targetPath: match[3] ? match[3].split("/").filter(Boolean) : [],
      officialUrl: `https://www.govinfo.gov/app/details/STATUTE-${match[1]}/STATUTE-${match[1]}-Pg${match[2]}`
    };
  }
  if (/^\/us\/act\//.test(value)) {
    return {
      family: "public-law",
      resolution: "official-source-only",
      targetKind: "act",
      targetPath: value.split("/").filter(Boolean).slice(2),
      officialUrl: govInfoSearchUrl(text)
    };
  }
  return {
    family: "unknown",
    resolution: "unresolved",
    targetKind: "unknown",
    targetPath: [],
    officialUrl: ""
  };
}

function extractReferences(xml) {
  const structural = new Set(["section", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem", "level"]);
  const stack = [];
  const references = [];
  const unitTypes = {};
  const structuralOccurrences = new Map();
  const noteOccurrences = new Map();
  let capture = null;
  for (const token of xml.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith("</")) {
      const name = token.match(/^<\/([^\s>]+)/)?.[1];
      if (name === "ref" && capture) {
        capture.text = decodeXmlText(capture.text).trim();
        if (capture.sourceKey && capture.sourceField && capture.text && capture.href) references.push(capture);
        capture = null;
      }
      for (let index = stack.length - 1; index >= 0; index--) {
        if (stack[index].name === name) { stack.length = index; break; }
      }
      continue;
    }
    if (token.startsWith("<")) {
      if (/^<\?|^<!/.test(token)) continue;
      const name = token.match(/^<([^\s/>]+)/)?.[1];
      if (!name) continue;
      const inherited = [...stack].reverse().find(item => item.sourceKey) || null;
      const identifier = token.match(/\bidentifier="([^"]+)"/)?.[1];
      const href = token.match(/\bhref="([^"]+)"/)?.[1];
      let sourceKey = inherited?.sourceKey || null;
      let sourceField = inherited?.sourceField || null;
      let sourceKind = inherited?.sourceKind || null;
      let headingAsText = inherited?.headingAsText || false;
      let sectionNumber = inherited?.sectionNumber || null;
      if (structural.has(name) && identifier) {
        const match = identifier.match(/^\/us\/usc\/t8\/s([^/\s]+)(?:\/(.*))?$/);
        if (match && !/\s/.test(match[2] || "")) {
          sectionNumber = normalizeSectionNumber(match[1]);
          const baseKey = match[2] ? `${sectionNumber}:${match[2]}` : `${sectionNumber}:preamble`;
          const occurrence = (structuralOccurrences.get(baseKey) || 0) + 1;
          structuralOccurrences.set(baseKey, occurrence);
          sourceKey = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
          sourceField = match[2] ? "text" : "preamble";
          sourceKind = match[2] ? "operative" : "preamble";
          if (match[2]) unitTypes[sourceKey] = name;
        }
      }
      const isFootnote = name === "note" && /\btype="footnote"/.test(token);
      if (isFootnote && sectionNumber) {
        const footnoteId = token.match(/\bid="([^"]+)"/)?.[1];
        if (footnoteId) {
          sourceKey = `${sectionNumber}:house-footnote:${footnoteId}`;
          sourceField = "text";
          sourceKind = "houseFootnote";
        }
      } else if (name === "note" && sectionNumber) {
        const parentNote = [...stack].reverse().find(item => item.sourceKind === "note");
        if (parentNote) sourceKey = parentNote.sourceKey;
        else {
          const occurrence = (noteOccurrences.get(sectionNumber) || 0) + 1;
          noteOccurrences.set(sectionNumber, occurrence);
          sourceKey = `${sectionNumber}:note:${occurrence}`;
        }
        sourceField = "text";
        sourceKind = "note";
        headingAsText = Boolean(parentNote);
      } else if (name === "sourceCredit" && sectionNumber) {
        sourceKey = `${sectionNumber}:source-credit`;
        sourceField = "sourceCredit";
        sourceKind = "sourceCredit";
      } else if (name === "heading" && inherited?.sourceKey) {
        sourceKey = inherited.sourceKey;
        // A note's own direct heading maps to note.heading. Headings nested inside
        // quoted statutory material are flattened into the note body by the
        // corpus generator and therefore must retain text offsets.
        const nestedNoteHeading = inherited.sourceKind === "note" && stack.at(-1)?.name !== "note";
        sourceField = inherited.headingAsText || nestedNoteHeading ? "text" : "heading";
        sourceKind = inherited.sourceKind;
      }
      stack.push({ name, sourceKey, sourceField, sourceKind, sectionNumber, headingAsText });
      if (name === "ref" && !/\bclass="footnoteRef"/.test(token)) {
        capture = { sourceKey, sourceField, href, text: "", sourceKind: sourceKind || "other" };
      }
      if (token.endsWith("/>")) stack.pop();
      continue;
    }
    if (capture) capture.text += token;
  }
  return { references, unitTypes };
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const corpus = readAssigned("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
applyStatuteFootnotes(corpus, readAssigned("INASearch-Statute-Footnotes.js", "INA_SEARCH_STATUTE_FOOTNOTES"));
const sourceMap = statuteSourceMap(corpus);
const localSections = new Set((corpus.title8?.sections || []).map(section => String(section.section)));
const localNodes = statuteNodeMap(corpus);
const extracted = extractReferences(xmlBytes.toString("utf8"));
const grouped = new Map();
let missingSourceRecord = 0;
let sourceTextMismatch = 0;
const skipped = [];

for (const reference of extracted.references) {
  const source = sourceMap.get(reference.sourceKey);
  if (!source || !Object.hasOwn(source, reference.sourceField)) {
    missingSourceRecord += 1;
    skipped.push({ reason: "missing-source-field", sourceKey: reference.sourceKey, sourceField: reference.sourceField, text: reference.text, href: reference.href });
    continue;
  }
  const groupKey = `${reference.sourceKey}@${reference.sourceField}`;
  if (!grouped.has(groupKey)) grouped.set(groupKey, { sourceKey: reference.sourceKey, sourceField: reference.sourceField, sourceKind: reference.sourceKind, references: [] });
  grouped.get(groupKey).references.push(reference);
}

const outputSources = [];
for (const [, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
  const source = sourceMap.get(group.sourceKey);
  const sourceText = String(source?.[group.sourceField] || "");
  const accepted = [];
  let cursor = 0;
  for (const reference of group.references) {
    let start = sourceText.indexOf(reference.text, cursor);
    if (start < 0) start = sourceText.indexOf(reference.text);
    if (start < 0) {
      sourceTextMismatch += 1;
      skipped.push({ reason: "source-text-mismatch", sourceKey: group.sourceKey, sourceField: group.sourceField, text: reference.text, href: reference.href });
      continue;
    }
    const target = classifyHref(reference.href, reference.text, localSections, localNodes);
    accepted.push({
      id: `house-${group.sourceKey.replace(/[^A-Za-z0-9]+/g, "-")}-${group.sourceField}-${start}-${accepted.length + 1}`,
      start,
      end: start + reference.text.length,
      text: reference.text,
      ...target,
      houseHref: reference.href,
      sourceKind: reference.sourceKind,
      provenance: "house-uslm-ref",
      ruleId: "house-uslm-ref"
    });
    cursor = start + reference.text.length;
  }
  if (accepted.length) outputSources.push({ sourceKey: group.sourceKey, sourceField: group.sourceField, sourceKind: group.sourceKind, references: accepted });
}

const accepted = outputSources.flatMap(source => source.references);
if (missingSourceRecord || sourceTextMismatch || accepted.length !== extracted.references.length) {
  throw new Error(`House reference extraction skipped ${missingSourceRecord} missing-source and ${sourceTextMismatch} text-mismatch references. First skips: ${JSON.stringify(skipped.slice(0, 5))}`);
}
const result = {
  schemaVersion: 3,
  sourceUrl: "https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip",
  sourceReleasePoint: "119-102",
  capturedAt: manifest.capturedAt,
  sourceArtifact: houseArtifact.path,
  sourceBytes: xmlBytes.length,
  sourceSha256: xmlSha256,
  unitTypes: extracted.unitTypes,
  extraction: {
    displayedReferencesSeen: extracted.references.length,
    acceptedReferences: accepted.length,
    sourcesWithReferences: outputSources.length,
    localReferences: accepted.filter(reference => reference.resolution === "local").length,
    officialSourceOnlyReferences: accepted.filter(reference => reference.resolution === "official-source-only").length,
    unresolvedReferences: accepted.filter(reference => reference.resolution === "unresolved").length,
    familyCounts: Object.fromEntries([...new Set(accepted.map(reference => reference.family))].sort().map(family => [family, accepted.filter(reference => reference.family === family).length])),
    sourceKindCounts: Object.fromEntries([...new Set(accepted.map(reference => reference.sourceKind))].sort().map(kind => [kind, accepted.filter(reference => reference.sourceKind === kind).length])),
    skippedMissingSourceRecord: missingSourceRecord,
    skippedSourceTextMismatch: sourceTextMismatch,
    skipped
  },
  sources: outputSources
};

const output = `/* Generated from official House USLM Title 8 XML; rebuild with tools/generate-statute-references.js. */\nwindow.INA_SEARCH_STATUTE_REFERENCES = ${safeJson(result)};\n`;
fs.writeFileSync(path.join(root, "src", "INASearch-Statute-References.js"), output);
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.extraction).filter(([key]) => key !== "skipped"))));
