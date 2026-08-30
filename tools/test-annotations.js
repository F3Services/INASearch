#!/usr/bin/env node
"use strict";

const assert = require("assert");
const annotations = require("../src/INASearch-Annotations");

const associationKey = association => `${association.family}:${association.title}:${association.start.unit}:${(association.start.path || []).join("/")}:${association.end?.unit || ""}:${(association.end?.path || []).join("/")}`;
const association = (unit = "1182", path = ["a", "2", "D"]) => ({ family: "usc", title: 8, citationSystem: "ina", start: { unit, path }, label: "INA 212(a)(2)(D)" });

function testLegacyMigration() {
  const migrated = annotations.normalizeProfile({
    schemaVersion: 3,
    notes: [{ id: "legacy", title: "Issue", body: "Keep this wording.", tags: ["urgent"], links: [{ label: "INA 212" }], associations: [association()] }],
    preferences: {}
  });
  assert.strictEqual(migrated.schemaVersion, 4);
  assert(migrated.notes[0].text.includes("Issue"));
  assert(migrated.notes[0].text.includes("Keep this wording."));
  assert(migrated.notes[0].text.includes("Tags: urgent"));
  assert.deepStrictEqual(migrated.notes[0].associations[0].placement, annotations.DEFAULT_PLACEMENT);
  assert.deepStrictEqual(migrated.highlights, []);
  assert.strictEqual(migrated.preferences.lastNoteColor, "yellow");
}

function testReferencesStayVerbatim() {
  const text = "Compare 212a2d and INA 212(a)(2)(D), but leave 212xyz and the original text unchanged.";
  const detected = annotations.detectReferences(text, query => /^(?:INA 212\(a\)\(2\)\([dD]\))$/.test(query) ? { valid: true, label: "INA 212(a)(2)(D)", targetKey: "usc:8:1182:a/2/D:" } : null);
  assert.strictEqual(text.slice(detected.spans[0].start, detected.spans[0].end), "212a2d");
  assert.strictEqual(detected.spans[0].citation, "INA 212(a)(2)(D)");
  assert.strictEqual(text.slice(detected.spans[1].start, detected.spans[1].end), "INA 212(a)(2)(D)");
  assert.strictEqual(detected.spans.length, 2);
  assert.strictEqual(detected.textHash, annotations.hashText(text));
}

function testAnchorsAndNeedsReview() {
  const source = "alpha selected language omega";
  const anchor = annotations.quoteAnchor(source, 6, 23, { sourceHostKey: "usc:8:1182:a" });
  assert.deepStrictEqual(annotations.resolveQuoteAnchor(source, anchor), { status: "active", start: 6, end: 23, method: "offset" });
  const moved = `prefix ${source}`;
  const resolved = annotations.resolveQuoteAnchor(moved, anchor);
  assert.strictEqual(resolved.status, "active");
  assert.strictEqual(resolved.method, "quote");
  assert.strictEqual(annotations.resolveQuoteAnchor("selected language and selected language", { ...anchor, start: 0, end: 1, prefix: "", suffix: "" }).status, "needs-review");
}

function testIncrementalIndexesAndAliases() {
  const note = annotations.normalizeNote({ id: "n1", text: "President; see 212a2d", associations: [association()], textReferences: { spans: [{ start: 15, end: 21, raw: "212a2d", citation: "INA 212(a)(2)(D)", targetKey: "usc:8:1182:a/2/D::" }] } });
  const highlight = annotations.normalizeHighlight({ id: "h1", color: "pink", segments: [{ id: "s1", association: association(), citation: "INA 212(a)(2)(D)", ordinal: 7, aliases: ["INA 212(a)(2)(D).h[7]", "8 U.S.C. 1182(a)(2)(D).h[7]"], citedTargets: ["usc:8:1153:b/1::"], anchor: { exact: "selected words", start: 3, end: 17 } }] });
  const profile = { notes: [note], highlights: [highlight] };
  const index = new annotations.AnnotationIndex(profile, { associationKey });
  assert(index.byCitation.get(associationKey(note.associations[0])).has("note:n1"));
  assert(index.byToken.notes.get("president").has("n1"));
  assert(index.byToken.highlights.get("selected").has("h1"));
  assert.deepStrictEqual(index.byHighlightAlias.get(annotations.normalizedText("8 U.S.C. 1182(a)(2)(D).h[7]")), { highlightId: "h1", segmentId: "s1" });

  note.text = "Attorney General";
  note.textReferences = { parserVersion: 1, textHash: annotations.hashText(note.text), spans: [] };
  index.updateNote(note);
  assert(!index.byToken.notes.has("president"));
  assert(index.byToken.notes.get("attorney").has("n1"));

  const snapshot = index.snapshot();
  const hydrated = annotations.AnnotationIndex.hydrate(profile, snapshot, { associationKey });
  assert(hydrated.byCitation.get(associationKey(note.associations[0])).has("note:n1"));
  assert.strictEqual(annotations.AnnotationIndex.hydrate({ notes: [], highlights: [] }, snapshot, { associationKey }), null);
}

function testSyntheticScale() {
  const notes = [], highlights = [];
  for (let index = 0; index < 10000; index += 1) {
    const itemAssociation = association(String(1000 + index), []);
    notes.push(annotations.normalizeNote({ id: `n${index}`, text: `note token${index}`, associations: [itemAssociation] }));
    highlights.push(annotations.normalizeHighlight({ id: `h${index}`, segments: [{ id: `s${index}`, association: itemAssociation, ordinal: 1, anchor: { exact: `highlight token${index}` } }] }));
  }
  const started = Date.now();
  const index = new annotations.AnnotationIndex({ notes, highlights }, { associationKey });
  assert.strictEqual(index.notes.size, 10000);
  assert.strictEqual(index.highlights.size, 10000);
  assert.strictEqual(index.byCitation.size, 10000);
  console.log(`INFO annotation synthetic index: ${Date.now() - started} ms for 20,000 artifacts / 20,000 associations`);
}

testLegacyMigration();
testReferencesStayVerbatim();
testAnchorsAndNeedsReview();
testIncrementalIndexesAndAliases();
testSyntheticScale();
console.log("PASS annotations: migration, references, anchors, incremental indexes, aliases, and synthetic scale");
