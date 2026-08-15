/* Compact embedded-corpus delivery format. The canonical source and IndexedDB corpus remain expanded. */
(() => {
  "use strict";

  const FORMAT = "compact-v1";
  const EMPTY_REFERENCE_ARRAYS = new Set([
    "references", "headingReferences", "preambleReferences", "sourceCreditReferences",
    "xReferences", "authorityReferences", "sourceReferences", "textFootnoteReferences"
  ]);
  const CONTEXT_CODES = Object.freeze({ "source credit": "s", "statutory note": "n", "operative text": "o" });
  const CODE_CONTEXTS = Object.freeze({ s: "source credit", n: "statutory note", o: "operative text" });

  function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function houseUrl(section) {
    return `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title8-section${section}`)}`;
  }

  function compactHouseIdentifier(value) {
    const input = String(value || "");
    if (input.startsWith("/us/usc/t")) return `u${input.slice(9)}`;
    if (input.startsWith("/us/pl/")) return `p${input.slice(7)}`;
    if (input.startsWith("/us/stat/")) return `s${input.slice(9)}`;
    if (input.startsWith("/us/act/")) return `a${input.slice(8)}`;
    return input;
  }

  function expandHouseIdentifier(value) {
    const input = String(value || "");
    if (input.startsWith("u")) return `/us/usc/t${input.slice(1)}`;
    if (input.startsWith("p")) return `/us/pl/${input.slice(1)}`;
    if (input.startsWith("s")) return `/us/stat/${input.slice(1)}`;
    if (input.startsWith("a")) return `/us/act/${input.slice(1)}`;
    return input;
  }

  function stripEmptyReferenceArrays(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(stripEmptyReferenceArrays);
      return;
    }
    for (const key of EMPTY_REFERENCE_ARRAYS) {
      if (Array.isArray(value[key]) && value[key].length === 0) delete value[key];
    }
    Object.values(value).forEach(stripEmptyReferenceArrays);
  }

  function isUrlKey(key) {
    return /url$/i.test(String(key || ""));
  }

  const URL_PREFIXES = Object.freeze([
    ["!e", "https://www.ecfr.gov/current/"],
    ["!c", "https://www.uscis.gov/"],
    ["!C", "https://uscis.gov/"],
    ["!g", "https://www.govinfo.gov/"],
    ["!s", "https://www.state.gov/"]
  ]);

  function compactUrl(value) {
    const input = String(value || "");
    const encodedHouse = "https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title";
    const directHouse = "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title";
    if (input.startsWith(encodedHouse)) return `!h${input.slice(encodedHouse.length)}`;
    if (input.startsWith(directHouse) && input.endsWith("&num=0&edition=prelim")) return `!H${input.slice(directHouse.length, -"&num=0&edition=prelim".length)}`;
    const prefix = URL_PREFIXES.find(([, expanded]) => input.startsWith(expanded));
    return prefix ? `${prefix[0]}${input.slice(prefix[1].length)}` : input;
  }

  function expandUrl(value) {
    const input = String(value || "");
    if (input.startsWith("!h")) return `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title${input.slice(2)}`;
    if (input.startsWith("!H")) return `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title${input.slice(2)}&num=0&edition=prelim`;
    const prefix = URL_PREFIXES.find(([compact]) => input.startsWith(compact));
    return prefix ? `${prefix[1]}${input.slice(prefix[0].length)}` : input;
  }

  function packRepeatedUrls(corpus, packing) {
    const counts = new Map();
    const count = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(count); return; }
      for (const [key, child] of Object.entries(value)) {
        if (isUrlKey(key) && typeof child === "string" && child) {
          value[key] = compactUrl(child);
          counts.set(value[key], (counts.get(value[key]) || 0) + 1);
        }
        count(child);
      }
    };
    count(corpus);
    const indexes = new Map();
    const replace = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(replace); return; }
      for (const [key, child] of Object.entries(value)) {
        if (isUrlKey(key) && typeof child === "string" && (counts.get(child) || 0) > 1) {
          if (!indexes.has(child)) {
            indexes.set(child, packing.u.length);
            packing.u.push(child);
          }
          value[key] = indexes.get(child);
        } else replace(child);
      }
    };
    replace(corpus);
  }

  function hydrateRepeatedUrls(corpus, packing) {
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      for (const [key, child] of Object.entries(value)) {
        if (key === "_pack") continue;
        if (isUrlKey(key) && Number.isInteger(child)) value[key] = expandUrl(packing.u[child] || "");
        else if (isUrlKey(key) && typeof child === "string") value[key] = expandUrl(child);
        else visit(child);
      }
    };
    visit(corpus);
  }

  function packRepeatedStrings(corpus, packing) {
    const counts = new Map();
    const count = value => {
      if (typeof value === "string") {
        if (value.length >= 32) counts.set(value, (counts.get(value) || 0) + 1);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) value.forEach(count);
      else Object.values(value).forEach(count);
    };
    count(corpus);
    packing.s = [...counts]
      .filter(([, occurrences]) => occurrences > 1)
      .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
      .map(([value]) => value);
    const indexes = new Map(packing.s.map((value, index) => [value, index]));
    const replace = value => {
      if (typeof value === "string") {
        if (indexes.has(value)) return `~${indexes.get(value)}`;
        return /^~\d+$/.test(value) ? `~${value}` : value;
      }
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) value[index] = replace(value[index]);
      } else {
        for (const key of Object.keys(value)) value[key] = replace(value[key]);
      }
      return value;
    };
    replace(corpus);
  }

  function hydrateRepeatedStrings(corpus, packing) {
    const expand = value => {
      if (typeof value === "string") {
        if (/^~~\d+$/.test(value)) return value.slice(1);
        const match = value.match(/^~(\d+)$/);
        return match ? packing.s[Number(match[1])] : value;
      }
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) value[index] = expand(value[index]);
      } else {
        for (const key of Object.keys(value)) {
          if (key !== "_pack") value[key] = expand(value[key]);
        }
      }
      return value;
    };
    expand(corpus);
  }

  function packStatuteNode(node) {
    if (!node || typeof node !== "object") return;
    delete node.path;
    for (const child of node.children || []) packStatuteNode(child);
  }

  function packStatuteTransferTargets(section) {
    if (!Array.isArray(section?.transferTargets)) return;
    section._t = section.transferTargets.map(target => {
      const flags = `${target.placement === "note" ? "n" : ""}${target.relation === "see" ? "s" : ""}${target.former ? "f" : ""}`;
      return [target.source, target.title, target.section, ...(flags ? [flags] : [])];
    });
    delete section.transferTargets;
  }

  function hydrateStatuteTransferTargets(section) {
    if (!Array.isArray(section?._t)) return;
    section.transferTargets = section._t.map(([source, title, targetSection, flags = ""]) => ({
      source,
      title,
      section: targetSection,
      ...(flags.includes("n") ? { placement: "note" } : {}),
      ...(flags.includes("s") ? { relation: "see" } : {}),
      ...(flags.includes("f") ? { former: true } : {})
    }));
    delete section._t;
  }

  function hydrateStatuteNodes(nodes, parentPath = []) {
    for (const node of nodes || []) {
      const path = [...parentPath, String(node.label)];
      node.path = path;
      hydrateStatuteNodes(node.children, path);
    }
  }

  function statuteSource(section, locator, supportingExcerpt, capturedAt) {
    return {
      resource: "United States Code, Title 8",
      locator,
      url: section.url,
      captureDate: capturedAt,
      supportingExcerpt
    };
  }

  function packStatuteSources(corpus) {
    const capturedAt = corpus?.sources?.title8?.capturedAt || "";
    for (const section of corpus?.title8?.sections || []) {
      const common = source => Boolean(
        source && source.resource === "United States Code, Title 8" && source.url === section.url &&
        source.captureDate === capturedAt && Object.keys(source).sort().join(",") === "captureDate,locator,resource,supportingExcerpt,url"
      );
      if (common(section.source) && section.source.locator === `8 U.S.C. ${section.section}`) {
        section._s = section.source.supportingExcerpt;
        delete section.source;
      }
      if (common(section.sourceCreditSource) && section.sourceCreditSource.locator === `8 U.S.C. ${section.section} > source credit` && section.sourceCreditSource.supportingExcerpt === section.sourceCredit) {
        section._c = 1;
        delete section.sourceCreditSource;
      }
      for (const note of section.notes || []) {
        if (!common(note.source)) continue;
        const prefix = `8 U.S.C. ${section.section} > `;
        if (!String(note.source.locator || "").startsWith(prefix) || !String(note.text || "").startsWith(note.source.supportingExcerpt)) continue;
        const defaultSuffix = note.heading || note.topic;
        const suffix = note.source.locator.slice(prefix.length);
        const length = note.source.supportingExcerpt.length;
        note._s = suffix === defaultSuffix && length === String(note.text || "").length ? 1 : [suffix === defaultSuffix ? "" : suffix, length];
        delete note.source;
      }
    }
  }

  function hydrateStatuteSources(corpus) {
    const capturedAt = corpus?.sources?.title8?.capturedAt || "";
    for (const section of corpus?.title8?.sections || []) {
      if (typeof section._s === "string") {
        section.source = statuteSource(section, `8 U.S.C. ${section.section}`, section._s, capturedAt);
        delete section._s;
      }
      if (section._c) {
        section.sourceCreditSource = statuteSource(section, `8 U.S.C. ${section.section} > source credit`, section.sourceCredit, capturedAt);
        delete section._c;
      }
      for (const note of section.notes || []) {
        if (!note._s) continue;
        const packed = note._s;
        const suffix = Array.isArray(packed) && packed[0] ? packed[0] : note.heading || note.topic;
        const length = Array.isArray(packed) ? packed[1] : String(note.text || "").length;
        note.source = statuteSource(section, `8 U.S.C. ${section.section} > ${suffix}`, String(note.text || "").slice(0, length), capturedAt);
        delete note._s;
      }
    }
  }

  function packCfrBlocks(blocks) {
    for (const block of blocks || []) {
      if (block.t === "p") delete block.t;
      if (Array.isArray(block.u)) block.u = block.u.map(unit => [unit.a, unit.s, unit.e]);
      if (Array.isArray(block.r)) {
        const joined = block.r.map(run => String(run.x || "")).join("");
        block.r = joined === String(block.x || "")
          ? block.r.map(run => run.s ? [String(run.x || "").length, run.s] : String(run.x || "").length)
          : { v: block.r };
      }
      packCfrBlocks(block.blocks);
    }
  }

  function hydrateCfrBlocks(blocks) {
    for (const block of blocks || []) {
      if (!block.t) block.t = "p";
      if (Array.isArray(block.u)) block.u = block.u.map(unit => Array.isArray(unit) ? { a: unit[0], s: unit[1], e: unit[2] } : unit);
      if (block.r?.v) block.r = block.r.v;
      else if (Array.isArray(block.r)) {
        let cursor = 0;
        block.r = block.r.map(run => {
          const length = Number(Array.isArray(run) ? run[0] : run) || 0;
          const expanded = { x: String(block.x || "").slice(cursor, cursor + length) };
          cursor += length;
          if (Array.isArray(run) && run[1]) expanded.s = run[1];
          return expanded;
        });
      }
      hydrateCfrBlocks(block.blocks);
    }
  }

  function packNamedActReferences(corpus, packing) {
    const capturedAt = corpus?.sources?.title8?.capturedAt || "";
    const sections = new Map((corpus?.title8?.sections || []).map(section => [String(section.section), section]));
    const excerptIndexes = new Map();
    const excerptIndex = value => {
      const text = String(value || "");
      if (!excerptIndexes.has(text)) {
        excerptIndexes.set(text, packing.e.length);
        packing.e.push(text);
      }
      return excerptIndexes.get(text);
    };
    for (const act of corpus?.namedActs || []) {
      act.references = (act.references || []).map(reference => {
        const contextCode = CONTEXT_CODES[reference.contextType];
        const expectedUrl = houseUrl(reference.uscSection);
        const source = reference.source;
        const expectedLocator = `8 U.S.C. ${reference.uscSection} > ${reference.contextType}`;
        const sourceKeys = source && Object.keys(source).sort().join(",");
        const canPack = Boolean(
          contextCode && source && sourceKeys === "captureDate,locator,resource,supportingExcerpt,url" &&
          source.resource === "United States Code, Title 8" && source.locator === expectedLocator &&
          source.url === reference.url && source.captureDate === capturedAt && reference.url === expectedUrl
        );
        if (!canPack) return { v: reference };
        const indexedHeading = sections.get(String(reference.uscSection))?.heading || "";
        const headingOverride = indexedHeading === reference.uscHeading ? "" : String(reference.uscHeading || "");
        const packed = [
          String(reference.uscSection || ""), contextCode, String(reference.actLocator || ""),
          String(reference.referenceText || ""), compactHouseIdentifier(reference.houseIdentifier),
          excerptIndex(source.supportingExcerpt)
        ];
        if (headingOverride) packed.push(headingOverride);
        return packed;
      });
    }
  }

  function hydrateNamedActReferences(corpus, packing) {
    const capturedAt = corpus?.sources?.title8?.capturedAt || "";
    const sections = new Map((corpus?.title8?.sections || []).map(section => [String(section.section), section]));
    for (const act of corpus?.namedActs || []) {
      act.references = (act.references || []).map(packed => {
        if (!Array.isArray(packed)) return packed?.v || packed;
        const [uscSection, contextCode, actLocator, referenceText, compactIdentifier, excerpt, headingOverride] = packed;
        const contextType = CODE_CONTEXTS[contextCode] || contextCode;
        const url = houseUrl(uscSection);
        return {
          uscSection,
          uscHeading: headingOverride || sections.get(String(uscSection))?.heading || "",
          contextType,
          actLocator,
          referenceText,
          houseIdentifier: expandHouseIdentifier(compactIdentifier),
          url,
          source: {
            resource: "United States Code, Title 8",
            locator: `8 U.S.C. ${uscSection} > ${contextType}`,
            url,
            captureDate: capturedAt,
            supportingExcerpt: packing.e[excerpt] || ""
          }
        };
      });
    }
  }

  function packCorpusForDelivery(source) {
    const corpus = clone(source);
    if (!corpus || typeof corpus !== "object" || corpus._pack) return corpus;
    const packing = { v: 1, h: [], e: [], u: [] };
    const hierarchyIndexes = new Map();
    const hierarchyIndex = item => {
      const tuple = [item.type, item.number, item.heading];
      const key = JSON.stringify(tuple);
      if (!hierarchyIndexes.has(key)) {
        hierarchyIndexes.set(key, packing.h.length);
        packing.h.push(tuple);
      }
      return hierarchyIndexes.get(key);
    };

    for (const section of corpus?.title8?.sections || []) {
      if (section.status === "current") delete section.status;
      packStatuteTransferTargets(section);
      for (const node of section.body || []) packStatuteNode(node);
    }
    packStatuteSources(corpus);

    const cfr = corpus?.cfr;
    const cfrParts = new Map((cfr?.parts || []).map(part => [part.id, part]));
    for (const record of [...(cfr?.parts || []), ...(cfr?.sections || []), ...(cfr?.appendices || [])]) {
      if (Array.isArray(record.hierarchy)) {
        record._h = record.hierarchy.map(hierarchyIndex);
        delete record.hierarchy;
      }
    }
    for (const part of cfr?.parts || []) {
      delete part.id;
      delete part.sectionIds;
      delete part.appendixIds;
    }
    for (const section of cfr?.sections || []) {
      const partUrl = cfrParts.get(section.partId)?.url || "";
      const ending = `/section-${section.section}`;
      if (partUrl && String(section.url || "").startsWith(partUrl) && String(section.url || "").endsWith(ending)) {
        const middle = section.url.slice(partUrl.length, -ending.length);
        if (middle) section._u = middle;
      } else if (section.url) section._u = section.url;
      delete section.id;
      delete section.partId;
      delete section.url;
      packCfrBlocks(section.blocks);
    }
    for (const appendix of cfr?.appendices || []) {
      delete appendix.url;
      packCfrBlocks(appendix.blocks);
    }

    for (const row of corpus?.inaCrosswalk || []) {
      if (row.isNote === false) delete row.isNote;
      if (row.hasEquivalent === true) delete row.hasEquivalent;
    }
    packNamedActReferences(corpus, packing);
    stripEmptyReferenceArrays(corpus);
    packRepeatedUrls(corpus, packing);
    packRepeatedStrings(corpus, packing);
    corpus._pack = packing;
    return corpus;
  }

  function hydratePackedCorpus(corpus) {
    const packing = corpus?._pack;
    if (!packing) return corpus;
    if (packing.v !== 1 || !Array.isArray(packing.h) || !Array.isArray(packing.e) || !Array.isArray(packing.u) || !Array.isArray(packing.s)) throw new Error("The embedded corpus uses an unsupported compact delivery format.");

    hydrateRepeatedStrings(corpus, packing);
    hydrateRepeatedUrls(corpus, packing);

    for (const section of corpus?.title8?.sections || []) {
      if (!section.status) section.status = "current";
      hydrateStatuteTransferTargets(section);
      hydrateStatuteNodes(section.body);
    }
    hydrateStatuteSources(corpus);

    const hierarchy = packing.h.map(item => ({ type: item[0], number: item[1], heading: item[2] }));
    const cfr = corpus?.cfr;
    for (const record of [...(cfr?.parts || []), ...(cfr?.sections || []), ...(cfr?.appendices || [])]) {
      if (Array.isArray(record._h)) {
        record.hierarchy = record._h.map(index => hierarchy[index]);
        delete record._h;
      }
    }
    const parts = new Map();
    for (const part of cfr?.parts || []) {
      part.id = `${part.title}:${part.part}`;
      part.sectionIds = [];
      part.appendixIds = [];
      parts.set(part.id, part);
    }
    for (const section of cfr?.sections || []) {
      section.id = `${section.title}:${section.section}`;
      section.partId = `${section.title}:${String(section.section).split(".")[0]}`;
      const part = parts.get(section.partId);
      section.url = String(section._u || "").startsWith("https://")
        ? section._u
        : `${part?.url || `https://www.ecfr.gov/current/title-${section.title}/part-${String(section.section).split(".")[0]}`}${section._u || ""}/section-${section.section}`;
      delete section._u;
      if (part) part.sectionIds.push(section.id);
      hydrateCfrBlocks(section.blocks);
    }
    for (const appendix of cfr?.appendices || []) {
      const part = parts.get(appendix.partId);
      appendix.url = part?.url || `https://www.ecfr.gov/current/title-${appendix.title}/part-${String(appendix.partId || "").split(":").at(-1)}`;
      if (part) part.appendixIds.push(appendix.id);
      hydrateCfrBlocks(appendix.blocks);
    }

    for (const row of corpus?.inaCrosswalk || []) {
      if (!("isNote" in row)) row.isNote = false;
      if (!("hasEquivalent" in row)) row.hasEquivalent = true;
    }
    hydrateNamedActReferences(corpus, packing);
    delete corpus._pack;
    return corpus;
  }

  const api = Object.freeze({ FORMAT, packCorpusForDelivery, hydratePackedCorpus });
  globalThis.INASearchCorpusPacking = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
