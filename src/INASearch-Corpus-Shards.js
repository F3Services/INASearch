/* Record content is decoded on demand; heading and navigation records keep their identities. */
(() => {
  "use strict";

  const FORMAT = "record-shards-v1";
  const AUXILIARY_FIELDS = ["legalReferenceEvidence", "legalReferenceAudit"];

  function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function recordsForKind(corpus, kind) {
    if (kind === "usc") return [...(corpus?.title8?.sections || []), ...(corpus?.referencedUsc?.titles || []).flatMap(title => title.sections || [])];
    if (kind === "cfr") return corpus?.cfr?.sections || [];
    if (kind === "appendix") return corpus?.cfr?.appendices || [];
    if (kind === "corpus") return [corpus];
    throw new Error("The corpus content chunk has an unknown record kind.");
  }

  function chunkEntries(corpus, chunk) {
    if (!Array.isArray(chunk?.records)) throw new Error("The corpus content chunk has no records.");
    return chunk.records.map(entry => {
      if (!Array.isArray(entry) || entry.length !== 3) throw new Error("The corpus content chunk has an invalid record.");
      const [kind, index, fields] = entry;
      const record = recordsForKind(corpus, kind)[index];
      if (!Number.isInteger(index) || index < 0 || !record || !fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error("The corpus content chunk has an invalid record index or fields.");
      }
      if (kind === "corpus" && (!Object.keys(fields).length || Object.entries(fields).some(([key, value]) =>
        !AUXILIARY_FIELDS.includes(key) || !value || typeof value !== "object" || Array.isArray(value)))) {
        throw new Error("The corpus content chunk has invalid auxiliary record fields.");
      }
      return { kind, record, fields };
    });
  }

  function partitionPackedCorpus(packed, maxChars = 1e6) {
    if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error("The corpus chunk size must be positive.");
    const metadata = clone(packed);
    const chunks = [];
    const mapping = { v: 1, usc: [], cfr: [], appendix: [] };
    const fieldNames = {
      usc: ["body", "notes", "sourceCredit", "preamble", "footnotes", "runInPaths", "_lr", "source", "sourceCreditSource", "_s", "_c"],
      cfr: ["blocks", "authority", "source", "notes", "_lr"],
      appendix: ["blocks", "authority", "source", "notes", "_lr"]
    };
    let current = null;
    let currentChars = 0;
    for (const kind of ["usc", "cfr", "appendix"]) {
      recordsForKind(metadata, kind).forEach((record, index) => {
        const fields = {};
        for (const key of fieldNames[kind]) {
          if (!Object.hasOwn(record, key)) continue;
          fields[key] = record[key];
          delete record[key];
        }
        if (Object.keys(fields).length === 0) {
          mapping[kind].push(null);
          return;
        }
        const entry = [kind, index, fields];
        const entryChars = JSON.stringify(entry).length;
        if (!current || current.records.length && currentChars + entryChars + 1 > maxChars) {
          current = { id: chunks.length, records: [] };
          chunks.push(current);
          currentChars = JSON.stringify(current).length;
        }
        current.records.push(entry);
        currentChars += entryChars + (current.records.length > 1 ? 1 : 0);
        mapping[kind].push(current.id);
      });
    }
    const auxiliary = {};
    for (const key of AUXILIARY_FIELDS) {
      if (!Object.hasOwn(metadata, key)) continue;
      auxiliary[key] = metadata[key];
      delete metadata[key];
    }
    if (Object.keys(auxiliary).length) {
      const chunk = { id: chunks.length, records: [["corpus", 0, auxiliary]] };
      chunks.push(chunk);
      mapping.corpus = [chunk.id];
    }
    metadata._shards = mapping;
    return { metadata, chunks };
  }

  function mergePackedChunk(metadata, chunk) {
    for (const { record, fields } of chunkEntries(metadata, chunk)) Object.assign(record, fields);
    return metadata;
  }

  function hydrateChunk(corpus, chunk, packing, consume = false) {
    if (!packing || packing.v !== 1) throw new Error("The corpus content chunk requires its shared packing dictionary.");
    const decoder = globalThis.INASearchCorpusPacking;
    if (!decoder?.hydratePackedCorpus) throw new Error("The corpus content chunk decoder is unavailable.");
    const entries = chunkEntries(corpus, chunk);
    const wrapper = {
      _pack: packing,
      sources: { title8: { capturedAt: corpus?.sources?.title8?.capturedAt || "" } },
      title8: { sections: [] },
      referencedUsc: { titles: [] },
      cfr: { parts: [], sections: [], appendices: [] }
    };
    // The ordinary decoder reconstructs source citations and CFR URLs using this small context.
    // It only visits chunk content; the existing metadata and shared dictionary are never decoded again.
    const partIds = new Set(entries.filter(entry => entry.kind === "cfr" || entry.kind === "appendix").map(({ kind, record }) =>
      kind === "appendix" ? record.partId : `${record.title}:${String(record.section).split(".")[0]}`));
    wrapper.cfr.parts = (corpus?.cfr?.parts || []).filter(part => partIds.has(part.id || `${part.title}:${part.part}`))
      .map(part => ({ title: part.title, part: part.part, url: part.url }));
    const hydrated = entries.map(({ kind, record, fields }) => {
      const content = consume ? fields : clone(fields);
      let target;
      if (kind === "usc") {
        target = { title: record.title || 8, section: record.section, url: record.url, ...content };
        if (Number(target.title) === 8) wrapper.title8.sections.push(target);
        else {
          let title = wrapper.referencedUsc.titles.find(item => item.number === Number(target.title));
          if (!title) { title = { number: Number(target.title), sections: [] }; wrapper.referencedUsc.titles.push(title); }
          title.sections.push(target);
        }
      } else if (kind === "cfr") {
        target = { title: record.title, section: record.section, _u: record.url || record._u, ...content };
        wrapper.cfr.sections.push(target);
      } else if (kind === "corpus") {
        target = content;
        (wrapper.auxiliary ||= []).push(target);
      } else {
        target = { id: record.id, title: record.title, partId: record.partId, ...content };
        wrapper.cfr.appendices.push(target);
      }
      return target;
    });
    decoder.hydratePackedCorpus(wrapper);
    entries.forEach(({ record, fields }, index) => {
      const target = hydrated[index];
      for (const key of Object.keys(fields)) {
        const expandedKey = key === "_s" ? "source" : key === "_c" ? "sourceCreditSource" : key;
        if (Object.hasOwn(target, expandedKey)) record[expandedKey] = target[expandedKey];
      }
    });
    return corpus;
  }

  // The browser partitions runtime JSON when writing its independently readable cache.
  const api = Object.freeze(typeof INASEARCH_BROWSER !== "undefined" && INASEARCH_BROWSER
    ? { FORMAT, partitionPackedCorpus, mergePackedChunk }
    : { FORMAT, partitionPackedCorpus, mergePackedChunk, hydrateChunk });
  globalThis.INASearchCorpusShards = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
