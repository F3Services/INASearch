/* INASearch occurrence-search worker. Embedded as inert source in the standalone file. */
(() => {
  "use strict";

  const scope = globalThis;
  const runtime = scope.INA_SEARCH_OCCURRENCE;
  const storage = scope.INASearchStorage;
  const packing = scope.INASearchCorpusPacking;
  if (!runtime) throw new Error("The occurrence-search runtime is unavailable in the worker.");

  let projection = null;
  let projectionPromise = null;
  let identity = null;
  let initializationGeneration = 0;
  const sessionGenerations = new Map();
  const searchResults = new Map();

  const elapsed = started => (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
  const startedAt = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  const send = value => scope.postMessage(value);
  const metric = (name, started, detail = {}) => send({ type: "metric", name, duration: elapsed(started), detail });

  async function corpusFromInitialization(message) {
    if (message.embeddedPayload instanceof Blob) {
      const parsed = JSON.parse(await message.embeddedPayload.text());
      return packing?.hydratePackedCorpus(parsed) || parsed;
    }
    const cached = await storage?.loadActiveCorpus?.({
      corpusSchemaVersion: message.identity?.corpusSchemaVersion,
      minimumVersion: message.identity?.corpusVersion
    });
    return cached?.corpus || null;
  }

  function normalizedIdentifier(value) {
    return runtime.normalizeText(value).replace(/\s+/g, "");
  }

  function pathTokens(value) {
    return [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  }

  function expandedHouseHref(value) {
    const input = String(value || "");
    if (input.startsWith("u")) return `/us/usc/t${input.slice(1)}`;
    if (input.startsWith("p")) return `/us/pl/${input.slice(1)}`;
    if (input.startsWith("s")) return `/us/stat/${input.slice(1)}`;
    if (input.startsWith("a")) return `/us/act/${input.slice(1)}`;
    return input;
  }

  function packedReferences(corpus, source, property, code, field) {
    if (Array.isArray(source?.[property])) return source[property];
    const packed = source?._lr?.[code];
    if (!packed) return [];
    const references = typeof packed === "string" ? packed.split(";").filter(Boolean).map(item => item.split(",").map(Number)) : packed;
    const families = { u: "usc", i: "ina", c: "cfr", p: "public-law", s: "statutes-at-large", f: "federal-register", "?": "unknown" };
    let previousEnd = 0;
    return references.map(reference => {
      const start = previousEnd + Number(reference?.[1] || 0);
      const end = start + Number(reference?.[2] || 0);
      previousEnd = end;
      const text = String(source?.[field] || "").slice(start, end);
      if (Array.isArray(reference) && reference[0] === 0) {
        const houseHref = expandedHouseHref(corpus?.legalReferencePacking?.houseHrefs?.[reference[3]] || "");
        const match = houseHref.match(/^\/us\/usc\/t([^/]+)\/s([^/]+)(?:\/(.*))?$/);
        return match ? { family: "usc", targetTitle: match[1], targetSection: match[2], targetPath: match[3] ? match[3].split("/").filter(Boolean) : [], resolution: Number(reference[4]) === 2 ? "unresolved" : "local", start, end, text } : { resolution: "unresolved", start, end, text };
      }
      if (!Array.isArray(reference)) return { ...reference, start, end, text: reference.text || text };
      const rawTarget = corpus?.legalReferencePacking?.legalTargets?.[reference[3]] || [];
      const target = typeof rawTarget === "string" ? rawTarget.split("|") : rawTarget;
      return {
        family: families[target[0]] || "unknown",
        targetTitle: target[2] || "",
        targetSection: target[3] || "",
        targetPath: Array.isArray(target[4]) ? target[4].map(String) : target[4] ? String(target[4]).split("/") : [],
        resolution: Number(target[1]) === 2 ? "unresolved" : Number(target[1]) === 1 ? "local" : "official-source-only",
        start, end, text
      };
    });
  }

  function buildCitationSources(corpus, activeProjection) {
    const uscSections = new Map((corpus?.title8?.sections || []).map(section => [normalizedIdentifier(section.section), section.id]));
    const cfrSections = new Map((corpus?.cfr?.sections || []).map(section => [`${normalizedIdentifier(section.title)}:${normalizedIdentifier(section.section)}`, section.id]));
    const inaByUsc = new Map((corpus?.inaCrosswalk || []).filter(row => !row.isNote && row.hasEquivalent !== false).map(row => [normalizedIdentifier(row.localSection || row.uscSection), row.inaSection]));
    const hierarchyByRecord = new Map();
    for (const fragment of activeProjection.fragments || []) {
      const key = `${fragment.authority}:${fragment.recordId}`;
      if (!hierarchyByRecord.has(key)) hierarchyByRecord.set(key, { hierarchyId: fragment.hierarchyIds?.at?.(-1) || "", hierarchyIds: fragment.hierarchyIds || [] });
    }
    const sources = [];
    const collectTargets = (item, kind) => {
      const targets = [], seen = new Set();
      const addSource = (source, property, code, field, metadata = {}) => {
        for (const reference of packedReferences(corpus, source, property, code, field)) {
          if (!reference || reference.resolution === "unresolved") continue;
          let family = "", sectionId = "";
          if (["usc", "ina"].includes(reference.family) && normalizedIdentifier(reference.targetTitle || 8) === "8") {
            family = "usc"; sectionId = uscSections.get(normalizedIdentifier(reference.targetSection)) || "";
          } else if (reference.family === "cfr") {
            family = "cfr"; sectionId = cfrSections.get(`${normalizedIdentifier(reference.targetTitle)}:${normalizedIdentifier(reference.targetSection)}`) || "";
          }
          if (!family || !sectionId) continue;
          const path = (reference.targetPath || []).map(String), sourcePath = (metadata.path || []).map(String);
          const key = `${family}:${sectionId}:${path.join("/")}:${field}:${sourcePath.join("/")}:${reference.start}:${reference.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({
            family, sectionId, path, sourceText: reference.text || "", sourceContext: String(source?.[field] || reference.text || ""),
            sourceStart: Math.max(0, Number(reference.start) || 0), sourceEnd: Math.max(0, Number(reference.end) || 0),
            sourceField: field, sourcePath, sourceBlockPath: [...(metadata.blockPath || [])], sourceRowIndex: metadata.rowIndex, sourceCellIndex: metadata.cellIndex
          });
        }
      };
      if (kind === "section") {
        addSource(item, "headingReferences", "h", "heading", { path: [] });
        addSource(item, "preambleReferences", "p", "preamble", { path: [] });
        const visitNodes = (nodes, parentPath = []) => {
          for (const node of nodes || []) {
            const path = [...parentPath, String(node.label)];
            addSource(node, "headingReferences", "h", "heading", { path });
            addSource(node, "references", "t", "text", { path });
            visitNodes(node.children, path);
          }
        };
        visitNodes(item?.body);
      } else {
        addSource(item, "headingReferences", "h", "heading", { path: [], blockPath: [] });
        const visitBlocks = (blocks, parentBlockPath = []) => {
          for (let blockIndex = 0; blockIndex < (blocks || []).length; blockIndex += 1) {
            const block = blocks[blockIndex], blockPath = [...parentBlockPath, blockIndex];
            const path = pathTokens(block.a || block.u?.at?.(-1)?.a || "");
            addSource(block, "xReferences", "x", "x", { path, blockPath });
            if (block.t === "table") for (let rowIndex = 0; rowIndex < (block.rows || []).length; rowIndex += 1) {
              for (let cellIndex = 0; cellIndex < (block.rows[rowIndex] || []).length; cellIndex += 1) addSource(block.rows[rowIndex][cellIndex], "xReferences", "x", "x", { path, blockPath, rowIndex, cellIndex });
            }
            if (block.t === "note") visitBlocks(block.blocks, [...blockPath, "blocks"]);
          }
        };
        visitBlocks(item?.blocks);
      }
      return targets;
    };
    for (const [sourceOrder, section] of (corpus?.title8?.sections || []).entries()) {
      const targets = collectTargets(section, "section");
      if (!targets.length) continue;
      const inaSection = inaByUsc.get(normalizedIdentifier(section.section)) || "";
      const hierarchy = hierarchyByRecord.get(`ina:${section.id}`) || {};
      if (!hierarchy.hierarchyId) continue;
      sources.push({ authority: "statute", displayAuthority: "ina", recordId: section.id, recordKind: "section", citation: inaSection ? `INA ${inaSection}` : `8 U.S.C. ${section.section}`, readerCommand: `8 U.S.C. ${section.section}`, heading: section.heading || "", firstSourceOrder: sourceOrder, searchHeader: runtime.normalizeText(`8 U.S.C. ${section.section} INA ${inaSection} ${section.heading || ""}`), ...hierarchy, targets });
    }
    const cfrRecords = [...(corpus?.cfr?.sections || []).map(item => ({ item, kind: "section" })), ...(corpus?.cfr?.appendices || []).map(item => ({ item, kind: "appendix" }))];
    for (const [sourceOrder, entry] of cfrRecords.entries()) {
      const item = entry.item, targets = collectTargets(item, entry.kind);
      if (!targets.length) continue;
      const hierarchy = hierarchyByRecord.get(`cfr:${item.id}`) || {};
      if (!hierarchy.hierarchyId) continue;
      const citation = item.section ? `${item.title} CFR ${item.section}` : `${item.title} CFR ${item.label || "Appendix"}`;
      sources.push({ authority: "cfr", displayAuthority: "cfr", recordId: item.id, recordKind: entry.kind, citation, readerCommand: citation, heading: item.heading || item.label || "", firstSourceOrder: 1_000_000 + sourceOrder, searchHeader: runtime.normalizeText(`${citation} ${item.heading || item.label || ""}`), ...hierarchy, targets });
    }
    return sources;
  }

  function pathStartsWith(path, prefix) {
    return (prefix || []).every((token, index) => normalizedIdentifier(path?.[index]) === normalizedIdentifier(token));
  }

  function citationSnippet(target, contextCharacters = 90) {
    const source = String(target?.sourceContext || target?.sourceText || ""), cited = String(target?.sourceText || "");
    let start = Math.max(0, Number(target?.sourceStart) || 0);
    if (!cited || source.slice(start, start + cited.length) !== cited) { const located = cited ? source.indexOf(cited) : -1; if (located >= 0) start = located; }
    const end = Math.min(source.length, Math.max(start, Number(target?.sourceEnd) || start + cited.length));
    const leadingStart = Math.max(0, start - contextCharacters), trailingEnd = Math.min(source.length, end + contextCharacters);
    return { leadingEllipsis: leadingStart > 0, trailingEllipsis: trailingEnd < source.length, leading: source.slice(leadingStart, start), match: source.slice(start, end) || cited, trailing: source.slice(end, trailingEnd), matchStart: start, matchEnd: end, parts: [{ text: source.slice(leadingStart, start), match: false }, { text: source.slice(start, end) || cited, match: true }, { text: source.slice(end, trailingEnd), match: false }].filter(part => part.text) };
  }

  function citationSearchResult(activeProjection, message) {
    const scopeFilter = message.scope || {}, ast = message.query || null, authorities = new Set(message.authorities || [message.authority].filter(Boolean));
    const fragmentsByRecord = new Map();
    const sourceMatchesAst = source => {
      if (!ast?.clauses?.length) return true;
      let haystack = source.searchHeader || "";
      if (source.authority === "statute") {
        if (!fragmentsByRecord.has(source.recordId)) fragmentsByRecord.set(source.recordId, (activeProjection.fragments || []).filter(fragment => fragment.recordId === source.recordId).map(fragment => fragment.normalized).join(" "));
        haystack += ` ${fragmentsByRecord.get(source.recordId)}`;
      }
      return ast.clauses.every(clause => (clause.alternatives || []).some(alternative => { const needle = runtime.normalizeText(alternative?.value || ""); return needle && haystack.includes(needle); }));
    };
    const hierarchy = new Map(), sections = [], rowsBySection = new Map();
    const addHierarchy = (source, count) => {
      for (const id of source.hierarchyIds || []) {
        const node = activeProjection.hierarchyById.get(id);
        if (!node) continue;
        const aggregate = hierarchy.get(id) || { id, parentId: node.parentId || "", authority: node.authority || source.displayAuthority, kind: node.kind || "unit", number: node.number || "", heading: node.heading || "", order: node.order, totalOccurrences: 0 };
        aggregate.totalOccurrences += count; hierarchy.set(id, aggregate);
      }
    };
    for (const source of activeProjection.citationSources || []) {
      if (authorities.size && !authorities.has(source.authority)) continue;
      if (!sourceMatchesAst(source)) continue;
      const targets = (source.targets || []).filter(target => {
        if (target.family !== scopeFilter.family || !scopeFilter.sectionIds?.has?.(target.sectionId)) return false;
        const requestedPath = scopeFilter.pathsBySection?.get?.(target.sectionId) || [];
        return !requestedPath.length || pathStartsWith(target.path, requestedPath);
      });
      if (!targets.length) continue;
      const rows = targets.map((target, index) => {
        const snippet = citationSnippet(target), path = target.sourcePath || [];
        return { authority: source.displayAuthority, recordId: source.recordId, recordKind: source.recordKind, citation: `${source.citation}${path.map(token => `(${token})`).join("")}`, readerCommand: `${source.readerCommand}${path.map(token => `(${token})`).join("")}`, path, kind: target.sourceField || "citation", occurrenceKey: `cites:${source.recordId}:${index}`, citationTarget: target, snippet, snippets: [snippet], target: source.displayAuthority === "ina" ? { field: target.sourceField, path, start: 0, end: target.sourceContext?.length || 0 } : { field: target.sourceField, blockPath: target.sourceBlockPath || [], rowIndex: target.sourceRowIndex, cellIndex: target.sourceCellIndex, start: 0, end: target.sourceContext?.length || 0 } };
      });
      rowsBySection.set(source.recordId, rows);
      sections.push({ id: source.recordId, authority: source.displayAuthority, recordId: source.recordId, hierarchyId: source.hierarchyId || "", hierarchyIds: source.hierarchyIds || [], citation: source.citation, readerCommand: source.readerCommand, heading: source.heading, totalOccurrences: rows.length, firstSourceOrder: source.firstSourceOrder });
      addHierarchy(source, rows.length);
    }
    return { sections, hierarchy: [...hierarchy.values()], totalOccurrences: sections.reduce((sum, section) => sum + section.totalOccurrences, 0), materializeOccurrences({ sectionId, start = 0, limit = 80, contextCharacters = 90 } = {}) { const rows = rowsBySection.get(sectionId) || []; const selected = rows.slice(start, start + limit).map(row => ({ ...row, snippet: citationSnippet(row.citationTarget, contextCharacters), snippets: [citationSnippet(row.citationTarget, contextCharacters)] })); return { rows: selected, total: rows.length, returned: selected.length }; } };
  }

  async function persistRuntimeCorpus(corpus, message) {
    if (!storage?.ensureActiveCorpus) return;
    try {
      await storage.ensureActiveCorpus(corpus, {
        reason: message.source === "embedded" ? "automatic-embedded-baseline" : "runtime-cache-migration",
        legalReferencesPacked: message.source === "embedded" || message.legalReferencesPacked === true,
        sourceCorpusSha256: message.identity?.corpusSha256 || "",
        sourceState: { authority: "embedded-release" }
      });
      send({ type: "baseline-cached", corpusVersion: corpus?.corpusVersion || "" });
    } catch (error) {
      send({ type: "cache-warning", cache: "corpus", message: error?.message || String(error) });
    }
  }

  async function initialize(message, generation) {
    const initStarted = startedAt();
    const nextIdentity = runtime.projectionIdentity(null, message.identity || {});
    identity = nextIdentity;
    projection = null;
    searchResults.clear();
    sessionGenerations.clear();
    send({ type: "progress", phase: "projection-cache" });
    if (storage?.loadSearchIndex) {
      const restoreStarted = startedAt();
      try {
        const record = await storage.loadSearchIndex(nextIdentity);
        if (generation !== initializationGeneration) return null;
        if (record) {
          const restored = runtime.restorePersistedProjection(record, nextIdentity);
          if (generation !== initializationGeneration) return null;
          projection = restored;
          metric("projection-cache-hit", restoreStarted, { fragments: restored.fragments.length });
          send({ type: "ready", source: "indexeddb", identity: nextIdentity, fragments: restored.fragments.length });
          metric("projection-ready", initStarted, { source: "indexeddb" });
          if (message.source === "embedded" && message.embeddedPayload instanceof Blob) void corpusFromInitialization(message).then(corpus => generation === initializationGeneration ? persistRuntimeCorpus(corpus, message) : null).catch(error => send({ type: "cache-warning", cache: "corpus", message: error?.message || String(error) }));
          return restored;
        }
        metric("projection-cache-miss", restoreStarted);
      } catch (error) {
        send({ type: "cache-warning", cache: "search-index", message: error?.message || String(error) });
      }
    }
    send({ type: "progress", phase: "projection-build" });
    const corpusStarted = startedAt();
    const corpus = await corpusFromInitialization(message);
    if (generation !== initializationGeneration) return null;
    if (!corpus) throw new Error("No corpus is available to build the legal-text search projection.");
    metric("worker-corpus-ready", corpusStarted, { source: message.source || "indexeddb" });
    const buildStarted = startedAt();
    const built = await runtime.buildProjectionAsync(corpus, {
      sliceMs: 12,
      isCancelled: () => generation !== initializationGeneration,
      onProgress: progress => send({ type: "progress", phase: "projection-build", progress })
    });
    if (generation !== initializationGeneration) return null;
    built.citationSources = buildCitationSources(corpus, built);
    if (generation !== initializationGeneration) return null;
    projection = built;
    metric("projection-built", buildStarted, { fragments: built.fragments.length });
    send({ type: "ready", source: "built", identity: nextIdentity, fragments: built.fragments.length });
    metric("projection-ready", initStarted, { source: "built" });
    void persistRuntimeCorpus(corpus, message);
    if (storage?.saveSearchIndex) {
      const saveStarted = startedAt();
      try {
        await storage.saveSearchIndex(runtime.toPersistedProjection(built, nextIdentity, { citationSources: built.citationSources }));
        if (generation !== initializationGeneration) return null;
        metric("projection-cache-saved", saveStarted, { fragments: built.fragments.length });
      } catch (error) {
        send({ type: "cache-warning", cache: "search-index", message: error?.message || String(error) });
      }
    }
    return built;
  }

  function searchResultDto(result, requestId) {
    return {
      requestId,
      sections: result.sections || [],
      hierarchy: result.hierarchy || [],
      totalOccurrences: Number(result.totalOccurrences || 0),
      stats: result.stats || null,
    };
  }

  async function runSearch(message) {
    const sessionId = String(message.sessionId || "default");
    const generation = Number(message.generation) || 0;
    sessionGenerations.set(sessionId, generation);
    const activeProjection = projection || await projectionPromise;
    if (!activeProjection) throw new Error("The legal-text search projection is unavailable.");
    const options = { ...(message.options || {}) };
    options.sliceMs = 12;
    options.generation = generation;
    options.isCancelled = () => sessionGenerations.get(sessionId) !== generation;
    const searchStarted = startedAt();
    const result = await runtime.searchAsync(activeProjection, message.query, options);
    if (sessionGenerations.get(sessionId) !== generation) return;
    const requestId = String(message.requestId);
    searchResults.set(requestId, result);
    while (searchResults.size > 12) searchResults.delete(searchResults.keys().next().value);
    metric("search-complete", searchStarted, { requestId, generation, totalOccurrences: result.totalOccurrences });
    send({ type: "search-result", sessionId, generation, result: searchResultDto(result, requestId) });
  }

  async function runCitationSearch(message) {
    const sessionId = String(message.sessionId || "citations");
    const generation = Number(message.generation) || 0;
    sessionGenerations.set(sessionId, generation);
    const activeProjection = projection || await projectionPromise;
    if (!activeProjection) throw new Error("The citation-source index is unavailable.");
    const searchStarted = startedAt();
    const result = citationSearchResult(activeProjection, message);
    if (sessionGenerations.get(sessionId) !== generation) return;
    const requestId = String(message.requestId);
    searchResults.set(requestId, result);
    while (searchResults.size > 12) searchResults.delete(searchResults.keys().next().value);
    metric("citation-search-complete", searchStarted, { requestId, generation, totalOccurrences: result.totalOccurrences });
    send({ type: "search-result", sessionId, generation, result: searchResultDto(result, requestId) });
  }

  function materialize(message) {
    const result = searchResults.get(String(message.requestId));
    if (!result) throw new Error("The requested search result is no longer available.");
    const page = result.materializeOccurrences(message.options || {});
    send({ type: "page-result", pageId: String(message.pageId), requestId: String(message.requestId), page });
  }

  scope.addEventListener("message", event => {
    const message = event.data || {};
    if (message.type === "init" || message.type === "corpus-change") {
      const generation = ++initializationGeneration;
      const previous = projectionPromise;
      projection = null;
      searchResults.clear();
      sessionGenerations.clear();
      const pending = Promise.resolve(previous).catch(() => null).then(() => {
        if (generation !== initializationGeneration) return null;
        return initialize(message, generation);
      }).catch(error => {
        if (generation !== initializationGeneration || error?.name === "AbortError") return null;
        if (projectionPromise === pending) projectionPromise = null;
        send({ type: "fatal", phase: "initialize", message: error?.message || String(error) });
        return null;
      });
      projectionPromise = pending;
      return;
    }
    if (message.type === "search") {
      void runSearch(message).catch(error => {
        if (error?.name !== "AbortError") send({ type: "search-error", sessionId: String(message.sessionId || "default"), generation: Number(message.generation) || 0, message: error?.message || String(error) });
      });
      return;
    }
    if (message.type === "citation-search") {
      void runCitationSearch(message).catch(error => send({ type: "search-error", sessionId: String(message.sessionId || "citations"), generation: Number(message.generation) || 0, message: error?.message || String(error) }));
      return;
    }
    if (message.type === "cancel") {
      const sessionId = String(message.sessionId || "default");
      sessionGenerations.set(sessionId, Math.max(Number(message.generation) || 0, (sessionGenerations.get(sessionId) || 0) + 1));
      return;
    }
    if (message.type === "materialize") {
      try { materialize(message); }
      catch (error) { send({ type: "page-error", pageId: String(message.pageId), message: error?.message || String(error) }); }
      return;
    }
    if (message.type === "dispose-result") searchResults.delete(String(message.requestId));
  });
})();
