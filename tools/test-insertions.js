#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  MAX_RECORDS,
  ReferenceInsertionSession,
  addressedTextRanges,
  compareSourceOrder,
  mergeReferenceInsertionRecords,
  normalizeReferenceInsertionRecord,
  normalizeReferenceInsertionRecords,
  persistenceTransition,
  resolveInsertionRecord,
  textFingerprint
} = require("../src/INASearch-Insertions");

function fixture(overrides = {}) {
  const record = {
    sourceHost: { kind: "usc", title: 8, section: "1101", path: ["a", "1"] },
    sourceRecord: {
      kind: "node-text", recordPath: ["a", "1"], field: "text",
      start: 22, end: 35, ordinal: 1, textFingerprint: textFingerprint("section 1104")
    },
    target: { kind: "usc", title: 8, section: "1104", path: ["b"] },
    copiedText: "must not survive",
    html: "<strong>must not survive</strong>"
  };
  return { ...record, ...overrides };
}

const normalized = normalizeReferenceInsertionRecord(fixture());
assert(normalized && normalized.key.startsWith("refins1:"));
assert.strictEqual(normalized.copiedText, undefined);
assert.strictEqual(normalized.html, undefined);
assert.deepStrictEqual(addressedTextRanges(30, [
  { path: ["a"], start: 0, end: 3 },
  { path: ["a", "1"], start: 10, end: 13 },
  { path: ["b"], start: 20, end: 23 }
], ["a"]), [{ start: 0, end: 20 }], "an exact unit excerpt includes descendants but not its sibling");
assert.deepStrictEqual(addressedTextRanges(30, [
  { path: ["a"], start: 0, end: 3 },
  { path: ["a", "1"], start: 10, end: 13 },
  { path: ["b"], start: 20, end: 23 }
], ["a", "1"]), [{ start: 10, end: 20 }], "a descendant excerpt excludes its ancestor chapeau and siblings");
assert.strictEqual(normalizeReferenceInsertionRecord(fixture({ sourceHost: { kind: "bogus", title: 8, section: "1101" } })), null, "unknown source authority is rejected");
assert.strictEqual(normalizeReferenceInsertionRecord(fixture({ target: { kind: "cfr", title: 0, section: "1.1" } })), null, "invalid CFR title is rejected");
assert.deepStrictEqual(normalizeReferenceInsertionRecords([fixture()], { cap: 0 }), [], "an explicit zero cap is honored");

const inaEquivalent = normalizeReferenceInsertionRecord(fixture({
  sourceHost: { kind: "ina", section: "101", path: ["a", "1"] },
  target: { kind: "ina", section: "104", path: ["b"] }
}), { resolveInaSection: value => ({ 101: "1101", 104: "1104" })[value] });
assert.strictEqual(inaEquivalent.key, normalized.key, "INA and U.S.C. display identities share one underlying key");

const secondOccurrence = normalizeReferenceInsertionRecord(fixture({
  sourceRecord: { ...fixture().sourceRecord, start: 52, end: 65, ordinal: 2 }
}));
assert.notStrictEqual(secondOccurrence.key, normalized.key, "distinct source occurrences remain distinct");

const laterTableCell = normalizeReferenceInsertionRecord(fixture({
  sourceHost: { kind: "cfr", title: 8, section: "1.1", path: ["a"] },
  sourceRecord: { kind: "cfr-table-cell", recordPath: [4, 10, 0], field: "cell", start: 0, end: 4, ordinal: 0, textFingerprint: textFingerprint("test") },
  target: { kind: "usc", title: 8, section: "1104", path: [] }
}));
const earlierTableCell = normalizeReferenceInsertionRecord(fixture({
  sourceHost: { kind: "cfr", title: 8, section: "1.1", path: ["a"] },
  sourceRecord: { kind: "cfr-table-cell", recordPath: [4, 2, 0], field: "cell", start: 50, end: 54, ordinal: 2, textFingerprint: textFingerprint("test") },
  target: { kind: "usc", title: 8, section: "1104", path: [] }
}));
assert(compareSourceOrder(earlierTableCell, laterTableCell) < 0, "record paths retain source order before field-local offsets");

const session = new ReferenceInsertionSession();
assert.strictEqual(session.upsert(normalized).changed, true);
assert.strictEqual(session.upsert(normalized).changed, false, "reinsertion is idempotent");
assert.strictEqual(session.upsert(secondOccurrence).changed, true);
assert.deepStrictEqual(session.recordsForHost(normalized.sourceHost).map(record => record.key), [normalized.key, secondOccurrence.key]);
assert.strictEqual(persistenceTransition(session, false).records.length, 0);
assert.strictEqual(session.size, 2, "turning persistence off does not clear the tab session");
assert.strictEqual(persistenceTransition(session, true).records.length, 2);

session.markDormant(normalized.key);
assert.strictEqual(session.unavailableCount, 1);
assert.strictEqual(session.removeUnavailable(), 1);
assert.strictEqual(session.size, 1);

assert.strictEqual(mergeReferenceInsertionRecords([normalized], [normalized, secondOccurrence], false).length, 0);
assert.strictEqual(mergeReferenceInsertionRecords([normalized], [normalized, secondOccurrence], true).length, 2);
assert.strictEqual(normalizeReferenceInsertionRecords(Array.from({ length: MAX_RECORDS + 10 }, (_, ordinal) => fixture({
  sourceRecord: { ...fixture().sourceRecord, start: ordinal * 2, end: ordinal * 2 + 1, ordinal }
}))).length, MAX_RECORDS);

const exact = { ...normalized, sourceRecord: { ...normalized.sourceRecord } };
assert.strictEqual(resolveInsertionRecord(normalized, [exact]).status, "exact");
const wrongHost = normalizeReferenceInsertionRecord(fixture({
  sourceHost: { kind: "usc", title: 8, section: "1102", path: ["a", "1"] }
}));
assert.strictEqual(resolveInsertionRecord(normalized, [wrongHost]).status, "dormant", "resolution never crosses source hosts");
assert.strictEqual(resolveInsertionRecord(normalized, []).status, "dormant");

console.log("Inserted-reference state tests passed.");
