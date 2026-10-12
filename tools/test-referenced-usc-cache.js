#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const shards = require("../src/INASearch-Corpus-Shards");
const command = require("../src/INASearch-Command");

const section = (title, number) => ({ id: `${title}-${number}`, title, section: number, heading: `Title ${title} section ${number}`, preamble: `Opening ${title} USC ${number}`, body: [{ label: "a", text: `Operative text of ${title} USC ${number}. `.repeat(80) }], notes: [] });
const corpus = {
  schemaVersion: 1, corpusVersion: "referenced-usc-cache-fixture",
  title8: { sections: [section(8, "16"), section(8, "1101")] },
  inaCrosswalk: [{ inaSection: "101", uscSection: "1101", localSection: "1101" }],
  referencedUsc: { schemaVersion: 1, titles: [
    { number: 18, name: "Crimes and Criminal Procedure", sections: [section(18, "16"), section(18, "1101")] },
    { number: 22, name: "Foreign Relations", sections: [section(22, "16")] }
  ] },
  cfr: { sections: [], appendices: [] }
};
const allUsc = value => [...value.title8.sections, ...value.referencedUsc.titles.flatMap(title => title.sections)];
const plain = value => JSON.parse(JSON.stringify(value));
const encode = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), payload: new Blob([bytes], { type: "application/json" }) };
};
function runtime() {
  const context = { Blob, TextEncoder, TextDecoder, Uint8Array, crypto: crypto.webcrypto, setTimeout,
    INA_SEARCH_COMMAND: command, INASearchCorpusShards: shards,
    document: { readyState: "complete", getElementById: () => null, addEventListener() {}, removeEventListener() {} } };
  context.window = context;
  vm.createContext(context);
  for (const source of ["INASearch-Storage", "INASearch-Startup"]) vm.runInContext(fs.readFileSync(require.resolve(`../src/${source}`), "utf8"), context);
  return context;
}

async function main() {
  const { metadata, chunks } = shards.partitionPackedCorpus(corpus, 700);
  assert(allUsc(metadata).every(record => !Object.hasOwn(record, "body") && !Object.hasOwn(record, "preamble")), "Referenced USC bodies and preambles must be deferred from cache metadata.");
  assert.equal(metadata._shards.usc.length, 5, "The USC shard map must address Title 8 and added titles in one stable sequence.");
  assert.deepEqual(metadata.referencedUsc.titles.map(title => [title.number, title.name]), [[18, "Crimes and Criminal Procedure"], [22, "Foreign Relations"]], "Initial cache metadata must retain title navigation.");
  assert.deepEqual(corpus.title8.sections[0].body, [section(8, "16").body[0]], "Partitioning must not strip the runtime source corpus.");
  const merged = structuredClone(metadata), identities = allUsc(merged);
  for (const chunk of [...chunks].reverse()) shards.mergePackedChunk(merged, structuredClone(chunk));
  delete merged._shards;
  assert.deepEqual(merged, corpus, "Out-of-order cache chunks must restore every referenced statute field.");
  identities.forEach((record, index) => assert.equal(allUsc(merged)[index], record, "Chunk loading must preserve existing navigation record identity."));

  const record = { recordSchemaVersion: 3, storageFormat: "runtime-json-chunks", corpusSchemaVersion: 1, corpusVersion: corpus.corpusVersion, ...encode(metadata), chunks: chunks.map(encode) };
  const context = runtime(), storage = context.INASearchStorage;
  const catalog = await storage.decodeCorpusRecord(record, { metadataOnly: true });
  assert(allUsc(catalog).every(item => !Object.hasOwn(item, "body")), "Verified metadata-only reads must not decode referenced USC body chunks.");
  assert.deepEqual(plain(await storage.decodeCorpusRecord(record)), corpus, "Verified storage decoding must restore cross-title USC text exactly.");
  const missingIndex = structuredClone(metadata);
  missingIndex._shards.usc.pop();
  await assert.rejects(storage.decodeCorpusRecord({ ...record, ...encode(missingIndex) }, { metadataOnly: true }), /missing or invalid content records/, "A cache map missing an external USC record must be rejected.");
  const corrupt = { ...record, chunks: record.chunks.map((chunk, index) => index === metadata._shards.usc[2] ? { ...chunk, sha256: "0".repeat(64) } : chunk) };
  await assert.rejects(storage.decodeCorpusRecord(corrupt), /SHA-256 integrity check/, "Added USC bodies must receive the existing cache integrity checks.");

  const select = context.INASearchStartup.openingChunks;
  for (const [input, indices] of [
    ["18 USC 16(a)", [2]], ["18 U.S.C. § 16(a)", [2]], ["18usc1101a", [3]], ["22 USC 16", [4]],
    ["USC 16", [0]], ["8 USC 16", [0]], ["INA 101", [1]], ["18 USC 16,22 USC 16", [2, 4]], ["18 USC", []]
  ]) assert.deepEqual([...select(metadata, metadata._shards, input)], indices.map(index => metadata._shards.usc[index]), `${input}: startup must select only its title-qualified statute chunks.`);

  const reads = [];
  context.INASearchStorage = { ...storage, readCorpusChunk: async (saved, id) => { reads.push(id); return storage.readCorpusChunk(saved, id); } };
  const opened = await context.INASearchStartup.openCachedCorpus({ corpus: catalog, record }, "18 USC 16(a)");
  assert.deepEqual(reads, [metadata._shards.usc[2]], "Opening an external statute must read only its required cached chunk before paint.");
  assert.deepEqual(plain(opened.referencedUsc.titles[0].sections[0].body), corpus.referencedUsc.titles[0].sections[0].body);
  assert(allUsc(opened).filter(item => item.id !== "18-16").every(item => !Object.hasOwn(item, "body")), "Unrelated titles must remain unloaded until background loading starts.");
  context.INA_SEARCH_CONTINUE_LOADING();
  await context.INA_SEARCH_CORPUS_COMPLETE;
  assert.deepEqual(plain(opened), corpus, "Background cache loading must finish with the complete original corpus.");
  assert.equal(new Set(reads).size, reads.length, "The opening chunk must not be loaded again in the background.");
  console.log("PASS referenced USC cache: deferred bodies, title metadata, verified round trips, title-specific startup, stable identities and integrity rejection");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
