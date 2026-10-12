#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { runtime } = require("./audit-ina-display");
const { readArtifact } = require("./audit-inline-references");
const functionSource = require("./test-function-source");
const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const corpus = readArtifact(path.join(root, "INASearch-Uncompressed.html"));
const api = runtime(template, corpus);
for (const name of ["statuteNoteBodyStart", "formatStatuteNoteBody", "renderStatuteNoteBody"])
  vm.runInContext(functionSource(template, name), api);
const section = corpus.title8.sections.find(item => item.section === "1182");
const note = section.notes.filter(item => item.layout?.length).sort((a, b) => b.text.length - a.text.length)[0];
assert(note?.text.length > 10000, "The regression fixture must exercise a long, structured editorial note");
const sourceContext = { kind: "ina", uscSection: "1182", inaSection: "212" };
const parser = api.INASearchEmbeddedReferences.parseCoordinatedSectionReferences;
let parsedCharacters = 0, calls = 0;
api.INASearchEmbeddedReferences = { ...api.INASearchEmbeddedReferences, parseCoordinatedSectionReferences(text) {
  parsedCharacters += text.length; calls++;
  return parser(text);
} };
const started = performance.now();
const html = api.renderStatuteNoteBody(note, null, sourceContext);
console.log(`INFO long editorial note: ${Math.round(performance.now() - started)} ms; ${calls} citation-list parses; ${parsedCharacters} characters examined for ${note.text.length} source characters`);
assert(parsedCharacters <= note.text.length, "Formatting separate paragraphs must not repeatedly parse the full editorial note");
assert(html.includes('class="note-paragraph"'), "The editorial paragraph layout must remain intact");
assert(html.includes("data-legal-reference"), "The editorial note must retain its citation links");
const independentlyRendered = api.formatStatuteNoteBody(note, (start, end) => api.linkifyStatutoryText(note.text, note.references || [], start, end, null, [], sourceContext));
assert.equal(html, independentlyRendered, "Reusing citation analysis must produce exactly the same editorial layout and links");
api.profile.preferences.statutoryLinkCitationSystem = "view";
parsedCharacters = 0; calls = 0;
api.renderStatuteNoteBody(note, null, sourceContext);
assert(parsedCharacters <= note.text.length, "The INA/USC display alternatives must share one analysis of the editorial note");
// Reuse must be confined to one render, preserving text changes and rendering preferences.
const sample = { text: "Heading See sections 1182 and 1227 of this title. Second paragraph.", heading: "Heading", bodyStart: 8,
  layout: [{ tag: "p", start: 8, end: 47 }, { tag: "p", start: 47, end: 65 }], references: [] };
const before = api.renderStatuteNoteBody(sample, null, sourceContext);
sample.text = sample.text.replace("Second", "Edited");
const after = api.renderStatuteNoteBody(sample, null, sourceContext);
assert.notEqual(before, after, "Editing the note must invalidate analysis from the prior render");
console.log("PASS reader rendering: editorial analysis stays proportional to source length, with layout and links preserved");
