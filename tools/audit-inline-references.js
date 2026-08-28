#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");
const { unpackLegalReferences } = require("./pack-legal-references");
const { statuteRunInMarkers } = require("./statute-run-ins");

const FIELD_REFERENCES = Object.freeze({
  text: "references",
  heading: "headingReferences",
  preamble: "preambleReferences",
  sourceCredit: "sourceCreditReferences",
  x: "xReferences",
  authority: "authorityReferences",
  source: "sourceReferences"
});

const PARENTHETICAL = /\(([A-Za-z0-9]+(?:[-\u2010\u2011\u2012\u2013\u2014][A-Za-z0-9]+)*)\)/g;
const ROMAN = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/i;

function scriptText(html, id) {
  const match = String(html || "").match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error(`Missing ${id} in standalone artifact.`);
  return match[1];
}

function readArtifact(fileName) {
  const html = fs.readFileSync(fileName, "utf8");
  const manifest = JSON.parse(scriptText(html, "inaSearchCorpusManifest"));
  const payload = scriptText(html, "inaSearchCorpusData");
  const bytes = manifest.compression === "gzip" ? zlib.gunzipSync(Buffer.from(payload.replace(/\s+/g, ""), "base64")) : Buffer.from(payload, "utf8");
  return unpackLegalReferences(hydratePackedCorpus(JSON.parse(bytes.toString("utf8"))));
}

function addressTokens(value) {
  return [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
}

function tokenVocabulary(corpus) {
  const usc = new Set();
  const cfr = new Set();
  const visitStatute = nodes => {
    for (const node of nodes || []) {
      usc.add(String(node.label));
      visitStatute(node.children);
    }
  };
  for (const section of corpus?.title8?.sections || []) {
    visitStatute(section.body);
    for (const pathValue of section.runInPaths || []) for (const token of pathValue) usc.add(String(token));
  }
  const visitCfr = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visitCfr); return; }
    for (const token of addressTokens(value.a)) cfr.add(token);
    for (const unit of value.u || []) for (const token of addressTokens(unit.a)) cfr.add(token);
    for (const child of Object.values(value)) visitCfr(child);
  };
  visitCfr(corpus?.cfr);
  return { usc, cfr };
}

function plausibleUnitToken(token, vocabulary) {
  const value = String(token || "");
  return vocabulary.has(value) || /^\d{1,3}$/.test(value) || /^[A-Za-z]$/.test(value) || /^[a-z]\d{1,3}$/.test(value) || ROMAN.test(value) || /^([a-z])\1{1,2}$/.test(value) || /^([A-Z])\1$/.test(value);
}

function parentheticalSequences(text, vocabulary) {
  const input = String(text || "");
  const groups = [];
  for (const match of input.matchAll(PARENTHETICAL)) {
    if (!plausibleUnitToken(match[1], vocabulary)) continue;
    groups.push({ start: match.index, end: match.index + match[0].length, text: match[0], token: match[1] });
  }
  const sequences = [];
  for (const group of groups) {
    const previous = sequences.at(-1);
    if (previous && /^\s*$/.test(input.slice(previous.end, group.start))) {
      previous.end = group.end;
      previous.text = input.slice(previous.start, previous.end);
      previous.tokens.push(group.token);
      previous.groups.push(group);
    } else sequences.push({ start: group.start, end: group.end, text: group.text, tokens: [group.token], groups: [group] });
  }
  return sequences;
}

function targetIdentity(reference) {
  if (reference.family === "public-law") return `public-law:${reference.targetCongress}-${reference.targetLaw}/${(reference.targetPath || []).join("/")}`;
  if (reference.family === "statutes-at-large") return `statutes-at-large:${reference.targetVolume}/${reference.targetPage}/${(reference.targetPath || []).join("/")}`;
  return `${reference.family || "unknown"}:${reference.targetTitle || ""}:${reference.targetSection || ""}/${(reference.targetPath || []).join("/")}`;
}

function excerpt(text, start, end, radius = 180) {
  return String(text || "").slice(Math.max(0, start - radius), Math.min(String(text || "").length, end + radius)).replace(/\s+/g, " ").trim();
}

function structuralSpansFor(field) {
  if (field.scope === "usc-operative" && (field.field === "text" || field.field === "preamble")) return statuteRunInMarkers(field.text, field.currentLabel).map(marker => ({ start: marker.start, end: marker.end }));
  if (field.scope === "cfr" && field.field === "x") return (field.owner?.u || []).map(unit => ({ start: unit.s, end: unit.e }));
  return [];
}

function referenceRows(field) {
  return field.references.map(reference => {
    if (field.text.slice(reference.start, reference.end) !== reference.text) throw new Error(`${field.sourceId}.${field.field}:${reference.start}-${reference.end} does not round-trip its reference span.`);
    return ({
    kind: "reference",
    scope: field.scope,
    sourceId: field.sourceId,
    sourcePath: field.sourcePath,
    field: field.field,
    start: reference.start,
    end: reference.end,
    text: reference.text,
    context: excerpt(field.text, reference.start, reference.end),
    family: reference.family,
    resolution: reference.resolution,
    target: targetIdentity(reference),
    ruleId: reference.ruleId,
    provenance: reference.provenance
    });
  });
}

function candidateRows(field, vocabulary) {
  const structural = structuralSpansFor(field);
  return parentheticalSequences(field.text, vocabulary).map(candidate => {
    const overlapping = field.references.filter(reference => reference.start < candidate.end && reference.end > candidate.start);
    const fullyLinked = candidate.groups.every(group => field.references.some(reference => reference.start <= group.start && reference.end >= group.end));
    const structuralMarker = candidate.groups.every(group => structural.some(span => span.start <= group.start && span.end >= group.end));
    return {
      kind: "parenthetical-candidate",
      scope: field.scope,
      sourceId: field.sourceId,
      sourcePath: field.sourcePath,
      field: field.field,
      start: candidate.start,
      end: candidate.end,
      text: candidate.text,
      tokens: candidate.tokens,
      context: excerpt(field.text, candidate.start, candidate.end),
      coverage: fullyLinked ? "linked" : overlapping.length ? "partial" : structuralMarker ? "structural" : "unlinked",
      overlappingTargets: overlapping.map(targetIdentity)
    };
  });
}

function collectFields(corpus) {
  const fields = [];
  const add = (scope, sourceId, sourcePath, owner, field, currentLabel = "") => {
    if (typeof owner?.[field] !== "string" || !owner[field]) return;
    fields.push({ scope, sourceId, sourcePath, owner, field, currentLabel, text: owner[field], references: owner[FIELD_REFERENCES[field]] || [] });
  };
  const walkStatuteNodes = (section, nodes, parentPath = [], indexPath = []) => {
    (nodes || []).forEach((node, index) => {
      const unitPath = [...parentPath, String(node.label)];
      const sourceId = `8-${section.section}-${unitPath.join("-")}`;
      const sourcePath = `title8.sections[${section.section}].body[${[...indexPath, index].join("/")}]`;
      add("usc-operative", sourceId, sourcePath, node, "heading", node.label);
      add("usc-operative", sourceId, sourcePath, node, "text", node.label);
      walkStatuteNodes(section, node.children, unitPath, [...indexPath, index]);
    });
  };
  for (const section of corpus?.title8?.sections || []) {
    const sourceId = `8-${section.section}`;
    const sourcePath = `title8.sections[${section.section}]`;
    add("usc-operative", sourceId, sourcePath, section, "heading");
    add("usc-operative", sourceId, sourcePath, section, "preamble");
    walkStatuteNodes(section, section.body);
    add("usc-notes", sourceId, sourcePath, section, "sourceCredit");
    (section.notes || []).forEach((note, index) => {
      const id = note.id || `${sourceId}-note-${index + 1}`;
      const location = `${sourcePath}.notes[${index}]`;
      add("usc-notes", id, location, note, "heading");
      add("usc-notes", id, location, note, "text");
    });
    (section.houseEditorialFootnotes || []).forEach((footnote, index) => add("usc-notes", footnote.id || `${sourceId}-footnote-${index + 1}`, `${sourcePath}.houseEditorialFootnotes[${index}]`, footnote, "text"));
  }
  const walkCfrObject = (owner, sourceId, sourcePath) => {
    if (!owner || typeof owner !== "object") return;
    add("cfr", sourceId, sourcePath, owner, "heading");
    add("cfr", sourceId, sourcePath, owner, "x");
    for (const [key, value] of Object.entries(owner)) {
      // Formatting runs and unit-offset indexes repeat fragments of the
      // parent block; they are metadata, not separately displayed fields.
      if ([...Object.keys(FIELD_REFERENCES), ...Object.values(FIELD_REFERENCES), "r", "u", "hierarchy"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child, index) => walkCfrObject(child, sourceId, `${sourcePath}.${key}[${index}]`));
      else if (value && typeof value === "object") walkCfrObject(value, sourceId, `${sourcePath}.${key}`);
    }
  };
  for (const part of corpus?.cfr?.parts || []) {
    const sourceId = `cfr-part-${part.id}`;
    const sourcePath = `cfr.parts[${part.id}]`;
    add("cfr", sourceId, sourcePath, part, "heading");
    add("cfr", sourceId, sourcePath, part, "authority");
    add("cfr", sourceId, sourcePath, part, "source");
  }
  for (const record of [...(corpus?.cfr?.sections || []), ...(corpus?.cfr?.appendices || [])]) {
    const sourceId = `cfr-${record.id}`;
    const sourcePath = `cfr.records[${record.id}]`;
    add("cfr", sourceId, sourcePath, record, "heading");
    add("cfr", sourceId, sourcePath, record, "authority");
    add("cfr", sourceId, sourcePath, record, "source");
    (record.blocks || []).forEach((block, index) => walkCfrObject(block, sourceId, `${sourcePath}.blocks[${index}]`));
  }
  return fields;
}

function enumerateInlineReferences(corpus) {
  const vocabulary = tokenVocabulary(corpus);
  const rows = { "usc-operative": [], "usc-notes": [], cfr: [] };
  for (const field of collectFields(corpus)) {
    const scopeVocabulary = field.scope === "cfr" ? vocabulary.cfr : vocabulary.usc;
    rows[field.scope].push(...referenceRows(field), ...candidateRows(field, scopeVocabulary));
  }
  return rows;
}

function summarize(rows) {
  const summary = {};
  for (const [scope, values] of Object.entries(rows)) {
    const references = values.filter(row => row.kind === "reference");
    const candidates = values.filter(row => row.kind === "parenthetical-candidate");
    summary[scope] = {
      references: references.length,
      parentheticalCandidates: candidates.length,
      candidateCoverage: Object.fromEntries(["linked", "partial", "structural", "unlinked"].map(status => [status, candidates.filter(row => row.coverage === status).length]))
    };
  }
  return summary;
}

function main() {
  const artifact = path.resolve(process.argv[2] || path.join(__dirname, "..", "INASearch-Uncompressed.html"));
  const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : "";
  const rows = enumerateInlineReferences(readArtifact(artifact));
  const summary = summarize(rows);
  if (outputDirectory) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const [scope, values] of Object.entries(rows)) fs.writeFileSync(path.join(outputDirectory, `${scope}.jsonl`), `${values.map(value => JSON.stringify(value)).join("\n")}\n`);
    fs.writeFileSync(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { collectFields, enumerateInlineReferences, parentheticalSequences, plausibleUnitToken, readArtifact, summarize, tokenVocabulary };
