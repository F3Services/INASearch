#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { statuteSourceMap } = require("./statute-references");

const root = path.resolve(__dirname, "..");
const xmlPath = process.argv[2];
if (!xmlPath) throw new Error("Usage: node tools/generate-statute-references.js /path/to/usc08.xml");

function readCorpus() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "AuthoritySearch-Corpus.js"), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.AUTHORITY_SEARCH_CORPUS));
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

function parseTarget(href) {
  const match = String(href || "").match(/^\/us\/usc\/t8\/s([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return { section: match[1], path: match[2] ? match[2].split("/").filter(Boolean) : [] };
}

function extractReferences(xml) {
  const structural = new Set(["section", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem", "level"]);
  const stack = [];
  const references = [];
  const structuralOccurrences = new Map();
  const noteOccurrences = new Map();
  let capture = null;
  for (const token of xml.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith("</")) {
      const name = token.match(/^<\/([^\s>]+)/)?.[1];
      if (name === "ref" && capture) {
        capture.text = decodeXmlText(capture.text).trim();
        if (capture.sourceKey && capture.text && parseTarget(capture.href)) references.push(capture);
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
      const identifier = token.match(/\bidentifier="([^"]+)"/)?.[1];
      const href = token.match(/\bhref="([^"]+)"/)?.[1];
      let sourceKey = null;
      let sectionNumber = [...stack].reverse().find(item => item.sectionNumber)?.sectionNumber || null;
      if (structural.has(name) && identifier) {
        const match = identifier.match(/^\/us\/usc\/t8\/s([^/\s]+)(?:\/(.*))?$/);
        if (match && !/\s/.test(match[2] || "")) {
          sectionNumber = match[1];
          const baseKey = match[2] ? `${match[1]}:${match[2]}` : `${match[1]}:preamble`;
          const occurrence = (structuralOccurrences.get(baseKey) || 0) + 1;
          structuralOccurrences.set(baseKey, occurrence);
          sourceKey = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
        }
      }
      const isFootnote = name === "note" && /\btype="footnote"/.test(token);
      if (name === "note" && sectionNumber && !isFootnote) {
        const parentNote = [...stack].reverse().find(item => item.sourceKind === "note");
        if (parentNote) sourceKey = parentNote.sourceKey;
        else {
          const occurrence = (noteOccurrences.get(sectionNumber) || 0) + 1;
          noteOccurrences.set(sectionNumber, occurrence);
          sourceKey = `${sectionNumber}:note:${occurrence}`;
        }
      } else if (name === "sourceCredit" && sectionNumber) {
        sourceKey = `${sectionNumber}:source-credit`;
      }
      const sourceKind = sourceKey?.includes(":note:") ? "note" : sourceKey?.endsWith(":source-credit") ? "sourceCredit" : sourceKey?.endsWith(":preamble") ? "preamble" : sourceKey ? "operative" : null;
      stack.push({ name, sourceKey, sourceKind, sectionNumber });
      if (name === "ref") {
        const nearest = [...stack].reverse().find(item => item.sourceKey);
        capture = { sourceKey: nearest?.sourceKey || null, href, text: "", sourceKind: nearest?.sourceKind || "other" };
      }
      if (token.endsWith("/>")) stack.pop();
      continue;
    }
    if (capture) capture.text += token;
  }
  return references;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const corpus = readCorpus();
const sourceMap = statuteSourceMap(corpus);
const sectionSet = new Set((corpus.title8?.sections || []).map(section => String(section.section)));
const extracted = extractReferences(fs.readFileSync(xmlPath, "utf8"));
const grouped = new Map();
let missingSourceRecord = 0;
let sourceTextMismatch = 0;
let missingTargetSection = 0;
const skipped = [];

for (const reference of extracted) {
  const source = sourceMap.get(reference.sourceKey);
  if (!source) { missingSourceRecord++; skipped.push({ reason: "missing-source-record", sourceKey: reference.sourceKey, text: reference.text, href: reference.href }); continue; }
  const target = parseTarget(reference.href);
  if (!target || !sectionSet.has(String(target.section))) { missingTargetSection++; skipped.push({ reason: "missing-target-section", sourceKey: reference.sourceKey, text: reference.text, href: reference.href }); continue; }
  if (!grouped.has(reference.sourceKey)) grouped.set(reference.sourceKey, []);
  grouped.get(reference.sourceKey).push({ text: reference.text, target, href: reference.href, sourceKind: reference.sourceKind });
}

const outputReferences = {};
for (const [key, references] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
  const source = sourceMap.get(key);
  const sourceText = key.endsWith(":source-credit") ? source.sourceCredit : key.endsWith(":preamble") ? source.preamble : source.text;
  const accepted = [];
  let cursor = 0;
  for (const reference of references) {
    let start = String(sourceText || "").indexOf(reference.text, cursor);
    if (start < 0) start = String(sourceText || "").indexOf(reference.text);
    if (start < 0) { sourceTextMismatch++; skipped.push({ reason: "source-text-mismatch", sourceKey: key, text: reference.text, href: reference.href }); continue; }
    const end = start + reference.text.length;
    accepted.push({
      start,
      end,
      text: reference.text,
      targetSection: reference.target.section,
      targetPath: reference.target.path,
      houseHref: reference.href,
      sourceKind: reference.sourceKind
    });
    cursor = end;
  }
  if (accepted.length) outputReferences[key] = accepted;
}

const result = {
  schemaVersion: 1,
  sourceUrl: "https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip",
  sourceReleasePoint: "119-102",
  capturedAt: "2026-08-02",
  extraction: {
    localDisplayedReferencesSeen: extracted.length,
    acceptedReferences: Object.values(outputReferences).reduce((sum, entries) => sum + entries.length, 0),
    sourcesWithReferences: Object.keys(outputReferences).length,
    operativeReferences: Object.values(outputReferences).flat().filter(reference => reference.sourceKind === "operative").length,
    preambleReferences: Object.values(outputReferences).flat().filter(reference => reference.sourceKind === "preamble").length,
    noteReferences: Object.values(outputReferences).flat().filter(reference => reference.sourceKind === "note").length,
    sourceCreditReferences: Object.values(outputReferences).flat().filter(reference => reference.sourceKind === "sourceCredit").length,
    skippedMissingSourceRecord: missingSourceRecord,
    skippedSourceTextMismatch: sourceTextMismatch,
    skippedMissingTargetSection: missingTargetSection,
    skipped
  },
  references: outputReferences
};

const output = `/* Generated from official House USLM Title 8 XML; rebuild with tools/generate-statute-references.js. */\nwindow.AUTHORITY_SEARCH_STATUTE_REFERENCES = ${safeJson(result)};\n`;
fs.writeFileSync(path.join(root, "src", "AuthoritySearch-Statute-References.js"), output);
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.extraction).filter(([key]) => key !== "skipped"))));
