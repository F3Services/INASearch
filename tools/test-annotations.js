#!/usr/bin/env node
"use strict";

const assert = require("assert");
const annotations = require("../src/INASearch-Annotations");

const associationKey = association => `${association.family}:${association.title}:${association.start.unit}:${(association.start.path || []).join("/")}:${association.end?.unit || ""}:${(association.end?.path || []).join("/")}`;
const association = (unit = "1182", path = ["a", "2", "D"]) => ({ family: "usc", title: 8, citationSystem: "ina", start: { unit, path }, label: "INA 212(a)(2)(D)" });

function testCurrentProfileNormalization() {
  const noteAssociation = { ...association(), placement: { dock: "right", boundary: "after", preferredWidthPx: 412, order: 9, primaryHighlightId: "segment-1" } };
  const migrated = annotations.normalizeProfile({
    schemaVersion: 5,
    notes: [{ id: "current", text: "Issue. Keep this wording. Tags: urgent", color: "pink", associations: [noteAssociation], createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }],
    highlights: [{ id: "highlight-1", noteId: "legacy", color: "violet", segments: [{ id: "segment-1", association: noteAssociation, anchor: { exact: "Keep", start: 0, end: 4 } }], createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }],
    preferences: { lastNoteColor: "pink", notesUseRuleFont: true }
  });
  assert.strictEqual(migrated.schemaVersion, 5);
  assert(migrated.notes[0].text.includes("Issue"));
  assert(migrated.notes[0].text.includes("Keep this wording."));
  assert(migrated.notes[0].text.includes("Tags: urgent"));
  assert.strictEqual(migrated.notes[0].createdAt, "2025-01-01T00:00:00.000Z");
  assert.strictEqual(migrated.notes[0].updatedAt, "2025-01-02T00:00:00.000Z");
  assert.strictEqual(Object.hasOwn(migrated.notes[0], "color"), false);
  assert.strictEqual(Object.hasOwn(migrated.notes[0].associations[0], "placement"), false);
  assert.strictEqual(migrated.highlights[0].color, "violet");
  assert.strictEqual(Object.hasOwn(migrated.highlights[0], "noteId"), false);
  assert.strictEqual(Object.hasOwn(migrated.highlights[0].segments[0].association, "placement"), false);
  assert.strictEqual(migrated.preferences.noteDisplayPosition, undefined);
  assert.strictEqual(migrated.preferences.notesUseHandwrittenFont, false);
  assert.strictEqual(Object.hasOwn(migrated.preferences, "lastNoteColor"), false);
  assert.strictEqual(Object.hasOwn(migrated.preferences, "notesUseRuleFont"), false);
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

function testDisplayPreferences() {
  const persisted = annotations.normalizeProfile({ schemaVersion: 5, notes: [], highlights: [], preferences: { noteDisplayPosition: "bottom", notesUseHandwrittenFont: true } });
  assert.strictEqual(persisted.preferences.noteDisplayPosition, undefined);
  assert.strictEqual(persisted.preferences.notesUseHandwrittenFont, true);
  const invalid = annotations.normalizeProfile({ schemaVersion: 5, notes: [], highlights: [], preferences: { noteDisplayPosition: "side", notesUseHandwrittenFont: "yes" } });
  assert.strictEqual(invalid.preferences.noteDisplayPosition, undefined);
  assert.strictEqual(invalid.preferences.notesUseHandwrittenFont, false);
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

function testHighlightRangeEditing() {
  assert.strictEqual(typeof annotations.editHighlightRanges, "function", "highlight range editing must be available");
  let serial = 10;
  const source = "abcdefghijklmnopqrstuvwxyz", a = association();
  const key = associationKey(a);
  const host = (start, end, overrides = {}) => ({ key, source, association: a, start, end, ...overrides });
  const makeSegment = (h, anchor) => ({ id: `s${++serial}`, association: h.association, citation: h.association.label, ordinal: serial, aliases: [`test.h[${serial}]`], anchor });
  const options = mode => ({ mode, associationKey, makeSegment, makeId: () => `h${++serial}`, now: "2026-01-01T00:00:00Z" });
  const highlight = (id, start, end, color = "pink", createdAt = "2025-01-01") => ({ id, color, createdAt, segments: [{ id: `${id}s`, association: a, ordinal: 1, citation: a.label, aliases: [`${id}.h[1]`], anchor: annotations.quoteAnchor(source, start, end, { sourceHostKey: key }) }] });
  const ranges = result => result.highlights.flatMap(h => h.segments.map(s => [s.anchor.start, s.anchor.end]));
  const original = [highlight("old", 2, 6)];
  let result = annotations.editHighlightRanges(original, [host(4, 10)], options("add"));
  assert.deepStrictEqual(ranges(result), [[2, 10]], "overlap must retain earlier ink and expand");
  assert.deepStrictEqual(original[0].segments[0].anchor.exact, "cdef", "editing must not mutate the input");
  assert.strictEqual(result.highlights[0].id, "old");
  assert.strictEqual(result.highlights[0].color, "pink");
  assert.strictEqual(annotations.editHighlightRanges(result.highlights, [host(4, 6)], options("add")).changed, false, "contained selections are idempotent");
  result = annotations.editHighlightRanges([highlight("new", 10, 15, "cyan", "2025-02-01"), ...original], [host(5, 12)], options("add"));
  assert.deepStrictEqual(ranges(result), [[2, 15]]);
  assert.strictEqual(result.highlights[0].id, "old");
  assert(result.highlights[0].segments[0].aliases.includes("new.h[1]"));
  const index = new annotations.AnnotationIndex(result, { associationKey });
  assert.strictEqual(index.byHighlightAlias.get(annotations.normalizedText("new.h[1]")).highlightId, "old");
  result = annotations.editHighlightRanges([highlight("old", 2, 15)], [host(6, 10)], options("remove"));
  assert.deepStrictEqual(ranges(result), [[2, 6], [10, 15]], "erasure must split around only the selected text");
  assert.strictEqual(result.highlights[0].segments[0].id, "olds");
  assert.notStrictEqual(result.highlights[0].segments[1].id, "olds");
  assert.deepStrictEqual(result.highlights[0].segments.map(s => s.anchor.exact), ["cdef", "klmno"]);
  assert.deepStrictEqual(ranges(annotations.editHighlightRanges(original, [host(0, 4)], options("remove"))), [[4, 6]]);
  assert.deepStrictEqual(annotations.editHighlightRanges(original, [host(0, 10)], options("remove")).highlights, []);
  assert.strictEqual(annotations.editHighlightRanges(original, [host(20, 25)], options("remove")).changed, false);
  result = annotations.editHighlightRanges([highlight("old", 2, 9), highlight("later", 4, 12, "cyan", "2025-03-01")], [host()], options("normalize"));
  assert.deepStrictEqual(ranges(result), [[2, 12]], "legacy overlaps must normalize");
  const unresolved = highlight("unresolved", 2, 7); unresolved.segments[0].anchor.exact = "missing";
  result = annotations.editHighlightRanges([...original, unresolved], [host()], options("normalize"));
  assert.strictEqual(result.highlights.length, 2, "unresolved anchors must survive unchanged");
  const b = association("1183", ["b"]);
  result = annotations.editHighlightRanges(original, [host(4, 9), host(1, 5, { key: associationKey(b), association: b })], options("add"));
  assert.deepStrictEqual(ranges(result), [[2, 9], [1, 5]], "cross-citation selections use independent offsets");
  const oldest = highlight("first", 0, 2);
  const middle = highlight("middle", 1, 3, "cyan", "2025-02-01");
  middle.segments.push({ ...highlight("middle-second", 10, 12).segments[0] });
  const last = highlight("last", 11, 13, "violet", "2025-03-01");
  last.segments.push({ ...highlight("remote", 20, 23).segments[0], association: b });
  result = annotations.editHighlightRanges([oldest, middle, last], [host()], options("normalize"));
  assert.strictEqual(result.highlights.length, 1, "successive merges retain the actual surviving owner across disconnected segments");
  assert.strictEqual(result.highlights[0].id, "first");
  assert.strictEqual(result.highlights[0].segments.length, 3, "merging must retain segments at other citations");
}

function testDraftAndBannerBoundaries() {
  assert.strictEqual(typeof annotations.NoteDraft, "function", "note edits need an uncommitted draft");
  const note = { id: "note", text: "saved", associations: [association()], createdAt: "2025-01-01", updatedAt: "2025-01-01" };
  const draft = new annotations.NoteDraft(note);
  draft.value.text = "edited";
  draft.value.associations.push(association("1183"));
  assert.strictEqual(note.text, "saved");
  assert.strictEqual(note.associations.length, 1);
  assert.deepStrictEqual(draft.discard(), note, "discard restores both text and sharing");
  assert.strictEqual(draft.save("2026-01-01").text, "edited");
  assert.strictEqual(draft.save("2026-01-01").associations.length, 2);
  assert.strictEqual(new annotations.NoteDraft(note, true).discard(), null, "discarding a new draft removes the whole note");
  assert.strictEqual(typeof annotations.layoutCitationBanners, "function");
  const banners = [
    { id: "warning", naturalTop: -100, bottom: 500, height: 50, parentIds: [] },
    { id: "section", naturalTop: -50, bottom: 500, height: 40, parentIds: ["warning"] },
    { id: "child", naturalTop: 0, bottom: 180, height: 60, parentIds: ["warning", "section"] }
  ];
  let layout = annotations.layoutCitationBanners(banners, 100);
  assert.deepStrictEqual(layout.map(x => x.top), [100, 150, 120], "child bottom takes priority over the parent stop at 190");
  assert.strictEqual(layout[2].pinned, true);
  banners[2].bottom = 400;
  layout = annotations.layoutCitationBanners(banners, 100);
  assert.deepStrictEqual(layout.map(x => x.top), [100, 150, 190], "all ancestor banners stay visible");
  banners[2].naturalTop = 300;
  assert.strictEqual(annotations.layoutCitationBanners(banners, 100)[2].top, 300, "unreached notes stay in normal flow");
  const longNote = { id: "long", naturalTop: 100, bottom: 700, height: 220, compactHeight: 80, parentIds: [] };
  const at = distance => annotations.layoutCitationBanners([{ ...longNote, naturalTop: 100 - distance }], 100)[0];
  assert.strictEqual(at(0).height, 220);
  assert.strictEqual(at(1).height, 219, "pinning must not instantly clamp the note");
  assert.strictEqual(at(60.5).height, 159.5, "collapse follows scrolling smoothly, including fractional pixels");
  assert.strictEqual(at(400).height, 80, "long notes retain two lines and sharing at full collapse");
  assert.strictEqual(at(60.5).collapsedBy, 60.5, "the text viewport shortens by exactly the height removed");
  assert.strictEqual(at(-10).height, 220, "scrolling back restores the full note");
  const collapsingStack = annotations.layoutCitationBanners([
    { ...longNote, naturalTop: 40 },
    { id: "nested", naturalTop: 220, bottom: 250, height: 100, compactHeight: 70, parentIds: ["long"] }
  ], 100);
  assert.strictEqual(collapsingStack[1].top + collapsingStack[1].height, 250, "citation bottom still pushes a shrinking child behind its parent");
}

testDraftAndBannerBoundaries();
testHighlightRangeEditing();
testCurrentProfileNormalization();
testReferencesStayVerbatim();
testDisplayPreferences();
testAnchorsAndNeedsReview();
testIncrementalIndexesAndAliases();
testSyntheticScale();
console.log("PASS annotations: schema-5 normalization, references, anchors, incremental indexes, aliases, and synthetic scale");
