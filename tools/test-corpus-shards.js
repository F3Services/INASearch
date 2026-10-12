#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { readPackedCorpusHtml } = require("./read-build-corpus");
const { packCorpusForDelivery, hydratePackedCorpus } = require("../src/INASearch-Corpus-Packing");
const shardPath = path.join(__dirname, "..", "src", "INASearch-Corpus-Shards.js");
const shards = fs.existsSync(shardPath) ? require(shardPath) : {};
const clone = value => JSON.parse(JSON.stringify(value));

function fixtureCorpus() {
  const url = "https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title8-section101";
  const captureDate = "2026-08-21";
  const source = (locator, supportingExcerpt) => ({ resource: "United States Code, Title 8", locator, url, captureDate, supportingExcerpt });
  const repeated = "Repeated legal reference content with enough text to enter the shared dictionary.";
  const partUrl = "https://www.ecfr.gov/current/title-8/part-1";
  return {
    schemaVersion: 1, corpusVersion: "fixture", sources: { title8: { capturedAt: captureDate } },
    title8: { title: 8, sections: [
      { id: "8-101", section: "101", heading: "Definitions", status: "current", url,
        body: [{ label: "a", text: repeated, path: ["a"], children: [{ label: "1", text: "Child text", path: ["a", "1"] }] }],
        notes: [{ heading: "History", topic: "history", text: repeated, source: source("8 U.S.C. 101 > History", repeated) }],
        sourceCredit: repeated, source: source("8 U.S.C. 101", repeated), sourceCreditSource: source("8 U.S.C. 101 > source credit", repeated),
        preamble: "Opening", footnotes: [], runInPaths: [], _lr: { customUrl: url, text: repeated } },
      { id: "8-102", section: "102", heading: "Empty content", status: "repealed", url,
        body: [], notes: [], sourceCredit: "", preamble: [], footnotes: [], runInPaths: [] },
      { id: "8-103", section: "103", heading: "Absent content", status: "omitted", url }
    ] },
    referencedUsc: { schemaVersion: 1, titles: [{ number: 18, name: "Crimes and Criminal Procedure", sections: [
      { id: "18-16", title: 18, section: "16", heading: "Crime of violence", status: "current", url: "https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title18-section16",
        preamble: repeated, body: [{ label: "a", text: repeated, path: ["a"], children: [{ label: "1", text: "Referenced child text", path: ["a", "1"] }] }], notes: [],
        source: { resource: "United States Code, Title 18", locator: "18 U.S.C. 16", url: "https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title18-section16", captureDate, supportingExcerpt: repeated } }
    ] }] },
    cfr: { coverage: { partCount: 1 }, parts: [
      { id: "8:1", title: 8, part: "1", heading: "General", url: partUrl, sectionIds: ["8:1.1", "8:1.2"], appendixIds: ["8:1:appendix-A"], hierarchy: [{ type: "part", number: "1", heading: "General" }] }
    ], sections: [
      { id: "8:1.1", title: 8, section: "1.1", partId: "8:1", heading: "Definitions", url: `${partUrl}/section-1.1`,
        hierarchy: [{ type: "part", number: "1", heading: "General" }], authority: repeated, source: repeated, notes: [],
        blocks: [{ t: "p", x: repeated, r: [{ x: "Repeated", s: "b" }, { x: repeated.slice(8) }], u: [{ a: "a", s: 0, e: 8 }] }, { t: "note", noteType: "editorial", x: "Editorial", blocks: [{ t: "p", x: "Nested" }] }],
        _lr: { referenceUrl: url, text: repeated } },
      { id: "8:1.2", title: 8, section: "1.2", partId: "8:1", heading: "Empty", url: `${partUrl}/section-1.2`, blocks: [], authority: "", source: "", notes: [] }
    ], appendices: [
      { id: "8:1:appendix-A", title: 8, partId: "8:1", heading: "Appendix A", url: partUrl,
        hierarchy: [{ type: "part", number: "1", heading: "General" }], blocks: [{ t: "p", x: repeated }], authority: "Appendix authority", source: repeated, notes: [], _lr: [] }
    ] },
    inaCrosswalk: [{ inaSection: "1", uscSection: "101", isNote: false, hasEquivalent: true }],
    namedActs: [], extraMetadata: { text: repeated, empty: [] },
    legalReferenceEvidence: { schemaVersion: 1, detail: { text: repeated, referenceUrl: url }, empty: [] },
    legalReferenceAudit: { schemaVersion: 1, text: repeated, sourceUrl: partUrl, issues: [] }
  };
}

function assertPartitionRoundTrip(packed, maxChars) {
  const original = clone(packed);
  const { metadata, chunks } = shards.partitionPackedCorpus(packed, maxChars);
  assert.deepStrictEqual(packed, original, "Partitioning mutated the packed input.");
  assert(chunks.length > 1, "A small chunk budget did not create separate content chunks.");
  for (const [kind, records] of [["usc", [...metadata.title8.sections, ...(metadata.referencedUsc?.titles || []).flatMap(title => title.sections)]], ["cfr", metadata.cfr.sections], ["appendix", metadata.cfr.appendices]]) {
    records.forEach((record, index) => {
      assert(!Object.hasOwn(record, kind === "usc" ? "body" : "blocks"), "Metadata retained record content.");
      const id = metadata._shards[kind][index];
      if (id != null) assert(chunks[id].records.some(([entryKind, entryIndex]) => entryKind === kind && entryIndex === index), "Record-to-chunk mapping did not identify its content.");
    });
  }
  const auxiliaryFields = ["legalReferenceEvidence", "legalReferenceAudit"].filter(key => Object.hasOwn(original, key));
  if (auxiliaryFields.length) {
    for (const key of auxiliaryFields) assert(!Object.hasOwn(metadata, key), "Metadata retained deferred legal audit data.");
    const auxiliary = chunks.at(-1);
    assert.strictEqual(metadata._shards.corpus[0], auxiliary.id, "The corpus audit mapping did not identify its final chunk.");
    assert.strictEqual(auxiliary.records.length, 1, "The auxiliary chunk contains unrelated record content.");
    assert.deepStrictEqual(auxiliary.records[0].slice(0, 2), ["corpus", 0]);
    assert.deepStrictEqual(Object.keys(auxiliary.records[0][2]), auxiliaryFields);
  }
  const restored = clone(metadata);
  for (const chunk of chunks) assert.strictEqual(shards.mergePackedChunk(restored, clone(chunk)), restored);
  delete restored._shards;
  assert.deepStrictEqual(restored, original, "Packed chunk merge lost data or introduced absent content fields.");
  assert.deepStrictEqual(shards.partitionPackedCorpus(packed, maxChars), { metadata, chunks }, "Partitioning was not deterministic.");
  return { metadata, chunks };
}

function assertHydratedRoundTrip(packed, partitioned) {
  const expected = hydratePackedCorpus(clone(packed));
  const corpus = clone(partitioned.metadata);
  const packing = corpus._pack;
  hydratePackedCorpus(corpus);
  const records = [...corpus.title8.sections, ...(corpus.referencedUsc?.titles || []).flatMap(title => title.sections), ...corpus.cfr.sections, ...corpus.cfr.appendices];
  const parts = corpus.cfr.parts;
  const partIds = clone(parts.map(part => [part.sectionIds, part.appendixIds]));
  for (const chunk of partitioned.chunks.slice().reverse()) {
    const originalChunk = clone(chunk);
    assert.strictEqual(shards.hydrateChunk(corpus, chunk, packing), corpus);
    assert.deepStrictEqual(chunk, originalChunk, "Chunk hydration changed its reusable packed input.");
  }
  const mergedRecords = [...corpus.title8.sections, ...(corpus.referencedUsc?.titles || []).flatMap(title => title.sections), ...corpus.cfr.sections, ...corpus.cfr.appendices];
  records.forEach((record, index) => assert.strictEqual(mergedRecords[index], record, "Hydration replaced a record used by an existing index."));
  assert.strictEqual(corpus.cfr.parts, parts, "Chunk hydration replaced the part catalog.");
  assert.deepStrictEqual(parts.map(part => [part.sectionIds, part.appendixIds]), partIds, "Chunk hydration damaged the part navigation IDs.");
  delete corpus._shards;
  assert.deepStrictEqual(corpus, expected, "Staged hydration differs from complete corpus hydration.");
  for (const chunk of partitioned.chunks) shards.hydrateChunk(corpus, chunk, packing);
  assert.deepStrictEqual(corpus, expected, "Loading a chunk again changed the expanded corpus.");
}

function assertConsumedHydration(packed, partitioned) {
  const corpus = clone(partitioned.metadata);
  const packing = corpus._pack;
  hydratePackedCorpus(corpus);
  const chunks = clone(partitioned.chunks);
  for (const chunk of chunks) shards.hydrateChunk(corpus, chunk, packing, true);
  delete corpus._shards;
  assert.deepStrictEqual(corpus, hydratePackedCorpus(clone(packed)), "Owned chunk hydration changed the corpus data.");
  return chunks;
}

assert.strictEqual(typeof shards.partitionPackedCorpus, "function", "The corpus shard partitioner is missing.");
const packed = packCorpusForDelivery(fixtureCorpus());
const partitioned = assertPartitionRoundTrip(packed, 600);
assertHydratedRoundTrip(packed, partitioned);
const consumedChunks = assertConsumedHydration(packed, partitioned);
const consumedBody = consumedChunks.flatMap(chunk => chunk.records).find(([kind, , fields]) => kind === "usc" && fields.body?.length)[2].body;
assert(Object.hasOwn(consumedBody[0], "path"), "Owned chunk storage was copied instead of reused during hydration.");
assert.throws(() => shards.partitionPackedCorpus(packed, 0), /chunk|size|positive/i, "A zero chunk budget was accepted.");
assert.throws(() => shards.mergePackedChunk(clone(partitioned.metadata), { id: 0, records: [["unknown", 0, {}]] }), /record|kind/i, "An unknown record kind was silently accepted.");
assert.throws(() => shards.mergePackedChunk(clone(partitioned.metadata), { id: 0, records: [["usc", 100, {}]] }), /record|index/i, "An invalid record index was silently accepted.");
assert.throws(() => shards.hydrateChunk({}, partitioned.chunks[0], null), /packing|dictionary/i, "Missing packing data was silently accepted.");
for (const index of [-1, 1, "0", null]) {
  const invalid = { id: 0, records: [["corpus", index, { legalReferenceAudit: {} }]] };
  assert.throws(() => shards.mergePackedChunk(clone(partitioned.metadata), invalid), /record|index/i, "An invalid auxiliary record index was accepted.");
  assert.throws(() => shards.hydrateChunk(clone(partitioned.metadata), invalid, packed._pack), /record|index/i, "Hydration accepted an invalid auxiliary record index.");
}
for (const fields of [null, [], {}, { legalReferenceAudit: null }, { legalReferenceAudit: "text" }, { legalReferenceEvidence: [] }, { legalReferenceEvidence: 3 }, { sources: {} }]) {
  const invalid = { id: 0, records: [["corpus", 0, fields]] };
  const target = clone(partitioned.metadata);
  const unchanged = clone(target);
  assert.throws(() => shards.mergePackedChunk(target, invalid), /record|fields/i, "Invalid auxiliary content fields were accepted.");
  assert.deepStrictEqual(target, unchanged, "Invalid auxiliary content changed the corpus before rejection.");
  assert.throws(() => shards.hydrateChunk(target, invalid, packed._pack), /record|fields/i, "Hydration accepted invalid auxiliary content fields.");
}

console.log(`PASS corpus shards: ${partitioned.chunks.length} fixture chunks; exact packed and expanded round trips, stable identities, out-of-order loading, empty/absent fields, and reloads`);

const htmlArgument = process.argv.indexOf("--html");
if (htmlArgument >= 0) {
  const html = fs.readFileSync(process.argv[htmlArgument + 1], "utf8");
  const fullPacked = readPackedCorpusHtml(html);
  const fullPartitioned = assertPartitionRoundTrip(fullPacked, 1e6);
  assertHydratedRoundTrip(fullPacked, fullPartitioned);
  assertConsumedHydration(fullPacked, fullPartitioned);
  const gzip = value => zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 });
  const originalGzip = gzip(fullPacked);
  const metadataGzip = gzip(fullPartitioned.metadata);
  const chunkGzips = fullPartitioned.chunks.map(gzip);
  const compressedBytes = metadataGzip.length + chunkGzips.reduce((sum, item) => sum + item.length, 0);
  const base64Bytes = metadataGzip.toString("base64").length + chunkGzips.reduce((sum, item) => sum + item.toString("base64").length, 0);
  console.log(`PASS complete corpus shards: ${fullPartitioned.chunks.length} chunks; exact packed and expanded round trips`);
  console.log(JSON.stringify({ originalGzipBytes: originalGzip.length, metadataGzipBytes: metadataGzip.length, chunkGzipBytes: chunkGzips.map(item => item.length), compressedBytes, gzipDelta: compressedBytes - originalGzip.length, base64Bytes, base64Delta: base64Bytes - originalGzip.toString("base64").length }));
}
