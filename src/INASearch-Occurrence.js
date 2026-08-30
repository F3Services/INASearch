/*
 * Runtime legal-text projection and exact occurrence search for INASearch.
 *
 * Public flow:
 *   const projection = await getProjectionAsync(corpus, { signal });
 *   const result = await searchAsync(projection, commandAst, { scope, common });
 *   const page = result.materializeOccurrences({ start, limit });
 *
 * Projection construction and scanning also have synchronous counterparts for
 * the standalone harness. Async variants accept AbortSignal, isCancelled,
 * sliceMs, yieldControl, onProgress, and generation without a DOM dependency.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.INA_SEARCH_OCCURRENCE = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_SLICE_MS = 8;
  const STATUTE_DEPTHS = Object.freeze({
    section: 0, subsection: 1, paragraph: 2, subparagraph: 3, clause: 4,
    subclause: 5, item: 6, subitem: 7, subsubitem: 8
  });
  const CFR_DEPTHS = Object.freeze({ section: 0, paragraph: 1 });
  const STATUTE_LEVEL_NAMES = Object.freeze([
    "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem"
  ]);
  const CFR_LEVEL_NAMES = Object.freeze(["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4", "paragraph-5", "paragraph-6"]);
  const NOTE_TYPES = new Set(["ordinary", "editorial", "effective-date"]);
  const projectionCache = new WeakMap();
  const projectionAsyncCache = new WeakMap();

  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}+/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function normalizedTextWithOffsets(value) {
    const input = String(value || "");
    const characters = [], starts = [], ends = [];
    let rawOffset = 0, pendingSpace = null;
    for (const rawCharacter of input) {
      const rawStart = rawOffset;
      rawOffset += rawCharacter.length;
      const expanded = rawCharacter.normalize("NFKD").toLowerCase().replace(/\p{M}+/gu, "");
      for (const character of expanded) {
        if (/^[\p{L}\p{N}]$/u.test(character)) {
          if (pendingSpace && characters.length) {
            characters.push(" ");
            starts.push(pendingSpace.start);
            ends.push(pendingSpace.end);
          }
          pendingSpace = null;
          characters.push(character);
          starts.push(rawStart);
          ends.push(rawOffset);
        } else if (characters.length) {
          if (pendingSpace) pendingSpace.end = rawOffset;
          else pendingSpace = { start: rawStart, end: rawOffset };
        }
      }
    }
    return { text: characters.join(""), starts, ends };
  }

  function normalizedIdentifier(value) {
    return normalizeText(value).replace(/\s+/g, "");
  }

  function pathIdentity(path) {
    return (path || []).map(token => `${String(token).length}:${String(token)}`).join("|");
  }

  function pathTokens(value) {
    if (Array.isArray(value)) return value.map(String);
    return [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  }

  function canonicalPath(path) {
    return (path || []).map(token => `(${token})`).join("");
  }

  function rangeCitation(base, startPath, endPath) {
    let shared = 0;
    while (shared < startPath.length && shared < endPath.length && String(startPath[shared]) === String(endPath[shared])) shared += 1;
    return `${base}${canonicalPath(startPath)}–${canonicalPath(endPath.slice(shared))}`;
  }

  function hierarchyKind(value) {
    const kind = String(value || "").toLowerCase();
    return ({ tit: "title", ch: "chapter", subchap: "subchapter", subch: "subchapter", pt: "part", subpt: "subpart", subjgrp: "subject-group" })[kind] || kind;
  }

  function hierarchyChildId(parentId, kind, number) {
    const token = normalizedIdentifier(number) || normalizeText(number).replace(/\s+/g, "-") || "unnumbered";
    return `${parentId}:${hierarchyKind(kind)}:${encodeURIComponent(token)}`;
  }

  function makeHierarchyStore() {
    const nodes = new Map();
    let order = 0;
    const add = node => {
      const existing = nodes.get(node.id);
      if (existing) {
        if (!existing.heading && node.heading) existing.heading = node.heading;
        return existing;
      }
      const created = { order: order++, children: [], ...node };
      nodes.set(created.id, created);
      const parent = created.parentId && nodes.get(created.parentId);
      if (parent && !parent.children.includes(created.id)) parent.children.push(created.id);
      return created;
    };
    return { nodes, add };
  }

  function cfrNoteType(block) {
    const explicit = NOTE_TYPES.has(block?.noteType) ? block.noteType : "ordinary";
    if (explicit !== "ordinary") return explicit;
    const heading = (block?.blocks || []).find(child => child?.t === "h")?.x || "";
    if (/^\s*editorial\s+notes?\b/i.test(heading)) return "editorial";
    if (/^\s*effective\s+date\s+notes?\b/i.test(heading)) return "effective-date";
    return "ordinary";
  }

  const RUN_IN_MARKER_PATTERN = /\((\d{1,3}|[A-Za-z]{1,4}|[a-z]\d{1,3})\)/g;
  const RUN_IN_ROMAN_PATTERN = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/i;
  const RUN_IN_REFERENCE_WORDS = new Set(["section", "sections", "subsection", "subsections", "paragraph", "paragraphs", "subparagraph", "subparagraphs", "clause", "clauses", "subclause", "subclauses", "item", "items", "subdivision", "subdivisions", "part", "parts", "chapter", "chapters", "title", "titles", "under"]);
  const RUN_IN_REFERENCE_CONNECTOR = /^[\s,()[\]]*(?:(?:and|or|through|to)[\s,()[\]]*)*$/i;

  function runInAddressToken(token) {
    return /^\d{1,3}$/.test(token) || /^[A-Za-z]$/.test(token) || /^[a-z]\d{1,3}$/.test(token) || RUN_IN_ROMAN_PATTERN.test(token) || /^([a-z])\1{1,2}$/.test(token) || /^([A-Z])\1$/.test(token);
  }

  function runInMarkers(value, currentLabel = "") {
    const input = String(value || ""), candidates = [];
    let referenceChainEnd = -1, match;
    RUN_IN_MARKER_PATTERN.lastIndex = 0;
    while ((match = RUN_IN_MARKER_PATTERN.exec(input))) {
      const token = match[1];
      if (!runInAddressToken(token)) continue;
      const start = match.index, end = RUN_IN_MARKER_PATTERN.lastIndex, prefix = input.slice(0, start);
      const precedingWord = prefix.match(/([A-Za-z]+)[\s“”'".:]*$/)?.[1]?.toLowerCase() || "";
      const referenceContinuation = referenceChainEnd >= 0 && RUN_IN_REFERENCE_CONNECTOR.test(input.slice(referenceChainEnd, start));
      const referenceNumberPrefix = /\b(?:section|sections|subsection|subsections|paragraph|paragraphs|subparagraph|subparagraphs|clause|clauses|subclause|subclauses|item|items)\s+\d+[A-Za-z-]*\s*$/i.test(prefix) || /\b\d{3,}[A-Za-z-]*\s*$/.test(prefix);
      const isReference = referenceContinuation || RUN_IN_REFERENCE_WORDS.has(precedingWord) || referenceNumberPrefix || /[\p{L}\p{M}\p{N}§]/u.test(input[start - 1] || "");
      if (isReference) {
        referenceChainEnd = end;
        continue;
      }
      candidates.push({ start, end, address: match[0], token, nestedAfterPrevious: false });
      referenceChainEnd = -1;
    }
    let markers = candidates;
    if (markers.length === 1) {
      const tail = input.slice(0, markers[0].start).slice(-80);
      const followsSeparator = /(?:^|[;:,\]])\s*(?:and|or)?\s*$/i.test(tail) || /\b(?:and|or)\s*$/i.test(tail);
      const siblingPair = String(currentLabel) && ((/^\d+$/.test(currentLabel) && /^\d+$/.test(markers[0].token) && Number(markers[0].token) === Number(currentLabel) + 1) || (/^[A-Za-z]$/.test(currentLabel) && /^[A-Za-z]$/.test(markers[0].token) && markers[0].token.charCodeAt(0) === currentLabel.charCodeAt(0) + 1));
      if (!followsSeparator && !siblingPair) markers = [];
    }
    if (markers.length > 1) {
      const connectorsOnly = markers.slice(1).every((marker, index) => RUN_IN_REFERENCE_CONNECTOR.test(input.slice(markers[index].end, marker.start)));
      const tail = input.slice(markers.at(-1).end);
      const referenceEnding = /^\s*[)\],.”"']*\s*(?:in|of|under|above|below|thereof|if)\b/i.test(tail) || /^\s*[)\]”"']/.test(tail) || /^\s*[,.”"']{2,}/.test(tail);
      if (connectorsOnly && referenceEnding) markers = [];
    }
    const separated = [];
    for (const marker of markers) {
      const previous = separated.at(-1);
      if (previous && /^\s*\[?\s*$/.test(input.slice(previous.end, marker.start))) marker.nestedAfterPrevious = true;
      separated.push({ ...marker });
    }
    return separated;
  }

  function romanNumber(token) {
    const values = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
    return values[String(token || "").toLowerCase()] || 0;
  }

  function immediateSibling(previous, next) {
    const left = String(previous || ""), right = String(next || "");
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(right) === Number(left) + 1;
    const leftRoman = romanNumber(left), rightRoman = romanNumber(right);
    const sameCase = (left === left.toUpperCase() && right === right.toUpperCase()) || (left === left.toLowerCase() && right === right.toLowerCase());
    if (leftRoman && rightRoman && sameCase && rightRoman === leftRoman + 1) return true;
    if (/^[a-z]$/.test(left) && new RegExp(`^${left}\\d+$`).test(right)) return true;
    const suffixed = left.match(/^([a-z])\d+$/)?.[1] || "";
    if (suffixed && /^[a-z]$/.test(right) && right.charCodeAt(0) === suffixed.charCodeAt(0) + 1) return true;
    const leftLetters = left.match(/^([A-Za-z])\1*$/)?.[0] || "", rightLetters = right.match(/^([A-Za-z])\1*$/)?.[0] || "";
    const sameLetterCase = (leftLetters === leftLetters.toUpperCase() && rightLetters === rightLetters.toUpperCase()) || (leftLetters === leftLetters.toLowerCase() && rightLetters === rightLetters.toLowerCase());
    return Boolean(leftLetters && rightLetters && leftLetters.length === rightLetters.length && sameLetterCase && rightLetters.charCodeAt(0) === leftLetters.charCodeAt(0) + 1);
  }

  function inferredSiblingPath(currentPath, inlineTokens, previousInlinePath) {
    if (!previousInlinePath?.length || !inlineTokens?.length) return null;
    const replaceable = Math.max(1, previousInlinePath.length - (currentPath || []).length);
    for (let count = 1; count <= replaceable; count += 1) {
      if (immediateSibling(previousInlinePath.at(-count), inlineTokens[0])) return [...previousInlinePath.slice(0, -count), ...inlineTokens];
    }
    return null;
  }

  function fallbackRunInPath(currentPath, parentPath, inlineTokens) {
    const depth = Math.max(0, (currentPath?.length || 1) - 1), token = String(inlineTokens[0] || "");
    const sameLevel = depth === 0 ? /^[a-z]+$/.test(token)
      : depth === 1 ? /^\d+$/.test(token)
      : depth === 2 ? /^[A-Z]+$/.test(token)
      : depth === 3 ? /^[ivxlcdm]+$/.test(token)
      : depth === 4 ? /^[IVXLCDM]+$/.test(token)
      : depth % 2 === 1 ? /^[a-z]+$/.test(token) : /^[A-Z]+$/.test(token);
    return [...(sameLevel ? parentPath || [] : currentPath || []), ...inlineTokens];
  }

  function runInPathCandidates(currentPath, inlineTokens, previousInlinePath) {
    const result = [], seen = new Set();
    const add = path => {
      const identity = pathIdentity(path);
      if (!seen.has(identity)) { seen.add(identity); result.push(path); }
    };
    add([...(currentPath || []), ...inlineTokens]);
    if (previousInlinePath?.length) {
      const replaceable = Math.max(1, previousInlinePath.length - (currentPath || []).length);
      for (let count = 1; count <= replaceable; count += 1) add([...previousInlinePath.slice(0, -count), ...inlineTokens]);
      add([...previousInlinePath, ...inlineTokens]);
    }
    return result;
  }

  function statuteRunInIndex(section) {
    const structural = new Set(), virtual = new Map(), virtualOwners = new Map(), collisions = new Set(), indexed = new Set();
    const collect = (nodes, parent = []) => {
      for (const node of nodes || []) {
        const path = [...parent, String(node.label)];
        structural.add(pathIdentity(path));
        collect(node.children, path);
      }
    };
    collect(section?.body);
    structural.forEach(identity => indexed.add(identity));
    const walk = (nodes, parent = []) => {
      for (const node of nodes || []) {
        const current = [...parent, String(node.label)], markers = runInMarkers(node.text, node.label);
        let previous = null;
        for (const marker of markers) {
          const tokens = [marker.token], candidates = runInPathCandidates(current, tokens, previous), direct = candidates[0];
          let path = marker.nestedAfterPrevious && previous?.length ? [...previous, ...tokens]
            : candidates.find(candidate => indexed.has(pathIdentity(candidate)) && !structural.has(pathIdentity(candidate)))
              || inferredSiblingPath(current, tokens, previous)
              || (immediateSibling(current.at(-1), tokens[0]) ? [...parent, ...tokens] : null)
              || fallbackRunInPath(current, parent, tokens);
          if (structural.has(pathIdentity(path)) && !structural.has(pathIdentity(direct))) path = direct;
          const identity = pathIdentity(path);
          previous = path;
          if (!virtualOwners.has(identity)) virtualOwners.set(identity, new Set());
          virtualOwners.get(identity).add(pathIdentity(current));
          if (virtualOwners.get(identity).size > 1) collisions.add(identity);
          if (!structural.has(identity) && !virtual.has(identity)) {
            virtual.set(identity, path);
            indexed.add(identity);
          }
        }
        walk(node.children, current);
      }
    };
    walk(section?.body);
    return { structural, virtual, collisions };
  }

  function resolvedRunInSegments(section, node, currentPath, runInIndex) {
    const markers = runInMarkers(node?.text, node?.label), segments = [];
    let previous = null;
    for (const marker of markers) {
      const tokens = [marker.token], candidates = runInPathCandidates(currentPath, tokens, previous);
      const path = marker.nestedAfterPrevious && previous?.length ? [...previous, ...tokens]
        : candidates.find(candidate => runInIndex.virtual.has(pathIdentity(candidate)))
          || inferredSiblingPath(currentPath, tokens, previous)
          || (immediateSibling(currentPath.at(-1), tokens[0]) ? [...currentPath.slice(0, -1), ...tokens] : null)
          || fallbackRunInPath(currentPath, currentPath.slice(0, -1), tokens);
      previous = path;
      const identity = pathIdentity(path);
      if (runInIndex.virtual.has(identity)) segments.push({ ...marker, path, collision: runInIndex.collisions.has(identity) });
    }
    return segments.map((segment, index) => ({ ...segment, sourceEnd: segments[index + 1]?.start ?? String(node?.text || "").length }));
  }

  function buildProjection(corpus, options = {}) {
    const started = now(), fragments = [], hierarchy = makeHierarchyStore();
    const requestedAuthorities = options.authorities === undefined
      ? new Set(["ina", "cfr"])
      : new Set(iterableValues(options.authorities).map(value => {
        const authority = String(value || "").toLowerCase();
        return ["statute", "statutes", "usc"].includes(authority) ? "ina" : authority;
      }));
    const includeIna = requestedAuthorities.has("ina"), includeCfr = requestedAuthorities.has("cfr");
    const stats = {
      buildMs: 0, fragmentCount: 0, rawCharacters: 0, normalizedCharacters: 0,
      inaRecords: 0, cfrSections: 0, cfrAppendices: 0, repeatedCfrPaths: 0,
      byAuthority: { ina: 0, cfr: 0 }, byKind: Object.create(null)
    };

    const addFragment = source => {
      const text = String(source.text || ""), normalized = options.deferNormalization ? null : normalizeText(text);
      if (options.deferNormalization ? !text.trim() : !normalized) return null;
      const sourceOrder = fragments.length;
      const fragment = {
        id: `${source.authority}:${sourceOrder}`,
        sourceOrder,
        ...source,
        text,
        normalized,
        path: (source.path || []).map(String),
        occurrenceKeys: [...(source.occurrenceKeys || [])],
        hierarchyIds: [...(source.hierarchyIds || [])],
        hierarchyBranches: (source.hierarchyBranches || [source.hierarchyIds || []]).map(branch => [...branch])
      };
      fragments.push(fragment);
      stats.rawCharacters += text.length;
      stats.normalizedCharacters += normalized?.length || 0;
      stats.byAuthority[fragment.authority] += 1;
      stats.byKind[fragment.kind] = (stats.byKind[fragment.kind] || 0) + 1;
      return fragment;
    };

    function buildInaHierarchy() {
      const rootNode = hierarchy.add({ id: "ina:root", authority: "ina", kind: "authority", number: "INA", heading: "Immigration and Nationality Act", parentId: null });
      const sectionMetadata = new Map((corpus?.inaHierarchy?.sections || []).map(section => [String(section.inaSection).toUpperCase(), section]));
      for (const title of corpus?.inaHierarchy?.titles || []) {
        hierarchy.add({ id: title.id, authority: "ina", kind: "title", number: title.number, heading: title.heading || "", parentId: rootNode.id });
        for (const chapter of title.chapters || []) hierarchy.add({ id: chapter.id, authority: "ina", kind: "chapter", number: chapter.number, heading: chapter.heading || "", parentId: title.id });
      }
      return sectionMetadata;
    }

    const inaSectionMetadata = includeIna ? buildInaHierarchy() : new Map();
    const statuteSections = new Map((corpus?.title8?.sections || []).map(section => [normalizedIdentifier(section.section), section]));
    const mappedByRecord = new Map();
    for (const row of includeIna ? corpus?.inaCrosswalk || [] : []) {
      if (!row || row.isNote || row.hasEquivalent === false || !row.uscSection) continue;
      const section = statuteSections.get(normalizedIdentifier(row.localSection || row.uscSection));
      // A transferred shell contains no independent operative text; its current
      // destination is already represented by its own mapped INA provision.
      if (!section || section.status === "transferred") continue;
      if (!mappedByRecord.has(section.id)) mappedByRecord.set(section.id, { section, rows: [] });
      mappedByRecord.get(section.id).rows.push(row);
    }

    for (const { section, rows } of mappedByRecord.values()) {
      const primary = rows[0], inaSections = rows.map(row => String(row.inaSection)), uscSections = [...new Set(rows.map(row => String(row.uscSection || row.localSection || section.section)))];
      const metadata = inaSectionMetadata.get(String(primary.inaSection).toUpperCase());
      const titleId = metadata?.titleId || `ina:title:${String(primary.inaSection).charAt(0)}`;
      if (!hierarchy.nodes.has(titleId)) hierarchy.add({ id: titleId, authority: "ina", kind: "title", number: String(primary.inaSection).charAt(0), heading: primary.group || "", parentId: "ina:root" });
      const parentId = metadata?.chapterId && hierarchy.nodes.has(metadata.chapterId) ? metadata.chapterId : titleId;
      const hierarchyBranches = rows.map(row => {
        const rowMetadata = inaSectionMetadata.get(String(row.inaSection).toUpperCase());
        const rowTitle = rowMetadata?.titleId || titleId;
        const rowParent = rowMetadata?.chapterId && hierarchy.nodes.has(rowMetadata.chapterId) ? rowMetadata.chapterId : rowTitle;
        const leafId = `ina:section:${String(row.inaSection).toUpperCase()}`;
        hierarchy.add({ id: leafId, authority: "ina", kind: "section", number: String(row.inaSection), heading: rowMetadata?.heading || row.title || section.heading || "", parentId: rowParent });
        return ["ina:root", rowTitle, ...(rowParent !== rowTitle ? [rowParent] : []), leafId];
      });
      const hierarchyIds = hierarchyBranches[0];
      const rootOccurrenceKey = `ina:${section.id}:section`;
      const citationBase = `INA ${primary.inaSection}`;
      const alternateCitations = rows.slice(1).map(row => `INA ${row.inaSection}`);
      const runIns = statuteRunInIndex(section);
      const statuteMappings = rows.map(row => ({ inaSection: String(row.inaSection), uscSection: String(row.uscSection || row.localSection || section.section) }));
      const common = { authority: "ina", recordKind: "statute", recordId: section.id, section: String(section.section), uscSections, inaSection: String(primary.inaSection), inaSections, statuteMappings, citationBase, alternateCitations, rootOccurrenceKey, hierarchyIds, hierarchyBranches, heading: section.heading || primary.title || "" };
      const structuralCounts = new Map(), virtualCounts = new Map(), virtualActive = new Map();
      const nextKey = (counts, prefix, identity) => {
        const count = (counts.get(identity) || 0) + 1;
        counts.set(identity, count);
        return `${rootOccurrenceKey}:${prefix}:${identity}#${count}`;
      };
      const structuralKeysFor = (path, parentKeys) => [...parentKeys, nextKey(structuralCounts, "unit", pathIdentity(path))];
      const virtualKeysFor = (path, ownerPath, ownerKeys) => {
        let shared = 0;
        while (shared < path.length && shared < ownerPath.length && String(path[shared]) === String(ownerPath[shared])) shared += 1;
        const keys = ownerKeys.slice(0, shared);
        for (let depth = shared; depth < path.length; depth += 1) {
          const identity = pathIdentity(path.slice(0, depth + 1));
          const context = `${keys.at(-1) || rootOccurrenceKey}\u0000${identity}`;
          let key = virtualActive.get(context);
          if (depth === path.length - 1 || !key) {
            key = nextKey(virtualCounts, depth === path.length - 1 ? "run-in" : "run-in-parent", context);
            virtualActive.set(context, key);
          }
          keys.push(key);
        }
        return keys;
      };
      const addStatuteFragment = (kind, text, path, occurrenceKeys, source) => addFragment({ ...common, kind, text, path, occurrenceKeys, citation: `${citationBase}${canonicalPath(path)}`, source });
      addStatuteFragment("statute-heading", section.heading, [], [], { field: "heading" });
      addStatuteFragment("statute-preamble", section.preamble, [], [], { field: "preamble" });
      let nodeOrdinal = 0;
      const walkNodes = (nodes, parentPath = [], parentOccurrenceKeys = [], parentRecordPath = []) => {
        for (let nodeIndex = 0; nodeIndex < (nodes || []).length; nodeIndex += 1) {
          const node = nodes[nodeIndex], path = [...parentPath, String(node.label)], occurrenceKeys = structuralKeysFor(path, parentOccurrenceKeys);
          const recordPath = [...parentRecordPath, nodeIndex], ordinal = nodeOrdinal++;
          const sourceBase = { field: "body", path: [...path], recordPath, ordinal };
          addStatuteFragment("statute-node-heading", node.heading, path, occurrenceKeys, { ...sourceBase, subfield: "heading" });
          const text = String(node.text || ""), segments = resolvedRunInSegments(section, node, path, runIns);
          if (segments.length) {
            addStatuteFragment("statute-node", text.slice(0, segments[0].start), path, occurrenceKeys, { ...sourceBase, subfield: "text", start: 0, end: segments[0].start });
            for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
              const segment = segments[segmentIndex], segmentPath = segment.collision ? path : segment.path;
              const segmentKeys = segment.collision ? occurrenceKeys : virtualKeysFor(segmentPath, path, occurrenceKeys);
              addStatuteFragment(segment.collision ? "statute-node" : "statute-run-in", text.slice(segment.start, segment.sourceEnd), segmentPath, segmentKeys, { ...sourceBase, subfield: "text", segmentIndex, start: segment.start, end: segment.sourceEnd, ...(segment.collision ? { runInCollision: true } : { virtual: true }) });
            }
          } else addStatuteFragment("statute-node", text, path, occurrenceKeys, { ...sourceBase, subfield: "text", start: 0, end: text.length });
          walkNodes(node.children, path, occurrenceKeys, recordPath);
        }
      };
      walkNodes(section.body);
      stats.inaRecords += 1;
    }

    function cfrHierarchy(record, recordKind) {
      hierarchy.add({ id: "cfr:root", authority: "cfr", kind: "authority", number: "CFR", heading: "Code of Federal Regulations", parentId: null });
      let parentId = "cfr:root";
      const ids = [parentId];
      for (const source of record.hierarchy || []) {
        const kind = hierarchyKind(source.type);
        if (["section", "appendix"].includes(kind)) continue;
        const id = kind === "title" ? `cfr:title:${source.number}` : hierarchyChildId(parentId, kind, source.number || source.heading);
        hierarchy.add({ id, authority: "cfr", kind, number: String(source.number || ""), heading: source.heading || "", parentId });
        if (id !== parentId) ids.push(id);
        parentId = id;
      }
      const leafId = recordKind === "appendix" ? `cfr:appendix:${record.id}` : `cfr:section:${record.id}`;
      hierarchy.add({ id: leafId, authority: "cfr", kind: recordKind, number: recordKind === "appendix" ? record.label || record.id : record.section, heading: record.heading || "", parentId });
      ids.push(leafId);
      return ids;
    }

    function makeCfrTracker(recordId) {
      const counts = new Map(), active = new Map();
      const keyFor = (path, createExact) => {
        const occurrenceKeys = [];
        for (let depth = 1; depth <= path.length; depth += 1) {
          const prefix = path.slice(0, depth), identity = pathIdentity(prefix);
          if (createExact && depth === path.length) {
            const count = (counts.get(identity) || 0) + 1;
            counts.set(identity, count);
            if (count > 1) stats.repeatedCfrPaths += 1;
            active.set(identity, `${recordId}:unit:${identity}#${count}`);
          } else if (!active.has(identity)) {
            const count = (counts.get(identity) || 0) + 1;
            counts.set(identity, count);
            active.set(identity, `${recordId}:unit:${identity}#${count}:implicit`);
          }
          occurrenceKeys.push(active.get(identity));
        }
        return occurrenceKeys;
      };
      const activeSnapshot = () => new Map(active);
      const restoreActive = snapshot => {
        active.clear();
        for (const [key, value] of snapshot || []) active.set(key, value);
      };
      return { keyFor, activeSnapshot, restoreActive };
    }

    function projectCfrRecord(record, recordKind) {
      const hierarchyIds = cfrHierarchy(record, recordKind), rootOccurrenceKey = `cfr:${record.id}:root`, tracker = makeCfrTracker(record.id);
      const sectionLabel = recordKind === "appendix" ? String(record.label || record.heading || "Appendix") : String(record.section);
      const citationBase = `${record.title} CFR ${sectionLabel}`;
      const common = { authority: "cfr", recordKind, recordId: record.id, title: Number(record.title), partId: record.partId || "", section: sectionLabel, citationBase, rootOccurrenceKey, hierarchyIds, heading: record.heading || "" };
      const state = { path: [], occurrenceKeys: [], localHeading: "" };
      const addCfrFragment = (kind, text, path, occurrenceKeys, source, noteType = null, citationOverride = "", localHeading = state.localHeading, deepestOccurrenceKey = "") => addFragment({ ...common, heading: localHeading || common.heading, localHeading: localHeading || "", kind, text, path, occurrenceKeys, citation: citationOverride || `${citationBase}${canonicalPath(path)}`, ...(citationOverride ? { rangeCitation: citationOverride } : {}), source, ...(noteType ? { noteType } : {}), ...(deepestOccurrenceKey ? { deepestOccurrenceKey } : {}) });
      addCfrFragment(recordKind === "appendix" ? "cfr-appendix-heading" : "cfr-heading", record.heading, [], [], { field: "heading" }, null, "", "");

      const ensurePath = (path, createExact = false) => {
        state.path = [...path];
        state.occurrenceKeys = tracker.keyFor(path, createExact);
        return state.occurrenceKeys;
      };

      const walkBlocks = (blocks, blockPath = [], inheritedNoteType = null, inheritedDeepestKey = "") => {
        for (let blockIndex = 0; blockIndex < (blocks || []).length; blockIndex += 1) {
          const block = blocks[blockIndex] || {}, currentBlockPath = [...blockPath, blockIndex], type = block.t || "p";
          if (type === "note") {
            const noteType = cfrNoteType(block);
            if (noteType === "ordinary") {
              const saved = { path: [...state.path], occurrenceKeys: [...state.occurrenceKeys], localHeading: state.localHeading, active: tracker.activeSnapshot() };
              walkBlocks(block.blocks, [...currentBlockPath, "blocks"], noteType, `${record.id}:note:${currentBlockPath.join(".")}`);
              state.path = saved.path;
              state.occurrenceKeys = saved.occurrenceKeys;
              state.localHeading = saved.localHeading;
              tracker.restoreActive(saved.active);
            }
            continue;
          }
          if (type === "p") {
            if (block.k === "citation") continue;
            const text = String(block.x || ""), units = [...(block.u || [])].sort((left, right) => Number(left.s) - Number(right.s));
            if (units.length) {
              const leadingRange = /^\s*\([^)]+\)\s*[-–—]\s*\([^)]+\)/.test(text);
              if (leadingRange && units.length === 2) {
                const startPath = pathTokens(units[0].a), endPath = pathTokens(units[1].a);
                ensurePath(startPath, true);
                const occurrenceKeys = ensurePath(endPath, true);
                occurrenceKeys[occurrenceKeys.length - 1] = `${record.id}:range:${currentBlockPath.join(".")}`;
                addCfrFragment(inheritedNoteType ? "cfr-note" : "cfr-paragraph", text, endPath, occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, start: 0, end: text.length, rangePaths: [startPath, endPath] }, inheritedNoteType, rangeCitation(citationBase, startPath, endPath), state.localHeading, inheritedDeepestKey);
                continue;
              }
              const firstStart = Math.max(0, Number(units[0].s) || 0);
              if (firstStart > 0) addCfrFragment(inheritedNoteType ? "cfr-note" : "cfr-paragraph", text.slice(0, firstStart), state.path, state.occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, start: 0, end: firstStart }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey);
              for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
                const unit = units[unitIndex], path = pathTokens(unit.a), start = Math.max(0, Number(unit.s) || 0), end = Math.max(start, Number(units[unitIndex + 1]?.s ?? text.length));
                const occurrenceKeys = ensurePath(path, true);
                addCfrFragment(inheritedNoteType ? "cfr-note" : "cfr-paragraph", text.slice(start, end), path, occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, unitIndex, start, end }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey);
              }
            } else {
              const path = pathTokens(block.a), contextPath = path.length ? path : pathTokens(block.c);
              // Renderer-contained prose has a legal parent context without a
              // separately addressable marker. Preserve that context while
              // keeping each displayed/source-order row as its own occurrence.
              const occurrenceKeys = contextPath.length ? ensurePath(contextPath, true) : state.occurrenceKeys;
              addCfrFragment(inheritedNoteType ? "cfr-note" : "cfr-paragraph", text, contextPath.length ? contextPath : state.path, occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, start: 0, end: text.length }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey);
            }
          } else if (type === "h") {
            // Headings are unaddressed legal fragments. Keep them at the
            // section-equivalent root so they cannot falsely join the preceding
            // paragraph at Deepest, while retaining the text as local context
            // for following repeated-path rows.
            state.localHeading = String(block.x || "");
            addCfrFragment(inheritedNoteType ? "cfr-note-heading" : "cfr-block-heading", block.x, [], [], { field: "blocks", blockPath: currentBlockPath }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey);
          } else if (type === "footnote") {
            addCfrFragment("cfr-footnote", block.x, state.path, state.occurrenceKeys, { field: "blocks", blockPath: currentBlockPath }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey || `${record.id}:footnote:${currentBlockPath.join(".")}`);
          } else if (type === "table") {
            addCfrFragment("cfr-table-caption", block.caption, state.path, state.occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, subfield: "caption" }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey || `${record.id}:table:${currentBlockPath.join(".")}:caption`);
            for (let rowIndex = 0; rowIndex < (block.rows || []).length; rowIndex += 1) {
              for (let cellIndex = 0; cellIndex < (block.rows[rowIndex] || []).length; cellIndex += 1) {
                addCfrFragment("cfr-table-cell", block.rows[rowIndex][cellIndex]?.x, state.path, state.occurrenceKeys, { field: "blocks", blockPath: currentBlockPath, rowIndex, cellIndex }, inheritedNoteType, "", state.localHeading, inheritedDeepestKey || `${record.id}:table:${currentBlockPath.join(".")}:cell:${rowIndex}.${cellIndex}`);
              }
            }
          }
        }
      };
      walkBlocks(record.blocks);
    }

    for (const section of includeCfr ? corpus?.cfr?.sections || [] : []) {
      projectCfrRecord(section, "section");
      stats.cfrSections += 1;
    }
    for (const appendix of includeCfr ? corpus?.cfr?.appendices || [] : []) {
      projectCfrRecord(appendix, "appendix");
      stats.cfrAppendices += 1;
    }

    stats.fragmentCount = fragments.length;
    stats.buildMs = now() - started;
    return {
      schemaVersion: SCHEMA_VERSION,
      corpusVersion: corpus?.corpusVersion || corpus?.cfr?.captureTime || "",
      fragments,
      hierarchyNodes: [...hierarchy.nodes.values()],
      hierarchyById: hierarchy.nodes,
      stats
    };
  }

  function projectionAuthorityKey(options = {}) {
    return [...new Set((options.authorities === undefined ? ["ina", "cfr"] : iterableValues(options.authorities))
      .map(value => ["statute", "statutes", "usc"].includes(String(value).toLowerCase()) ? "ina" : String(value).toLowerCase())
      .sort())].join(",");
  }

  function projectionCacheDescriptor(corpus, options = {}) {
    return {
      cacheKey: `${options.cacheKey || "default"}\u0000${projectionAuthorityKey(options)}\u0000${options.deferNormalization ? "raw" : "normalized"}`,
      version: `${corpus.corpusVersion || ""}\u0000${corpus.cfr?.captureTime || ""}`
    };
  }

  function chunkCfrRecords(records, maximumBlocks = 160, maximumRecords = 12) {
    const chunks = [];
    let current = [], blocks = 0;
    for (const record of records || []) {
      const recordBlocks = Math.max(1, record?.blocks?.length || 0);
      if (current.length && (current.length >= maximumRecords || blocks + recordBlocks > maximumBlocks)) {
        chunks.push(current);
        current = [];
        blocks = 0;
      }
      current.push(record);
      blocks += recordBlocks;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  function mergeProjectionPart(target, part) {
    for (const node of part.hierarchyNodes || []) {
      const { order, children, ...identity } = node;
      target.hierarchy.add(identity);
    }
    for (const source of part.fragments || []) {
      const sourceOrder = target.fragments.length;
      target.fragments.push({ ...source, id: `${source.authority}:${sourceOrder}`, sourceOrder });
    }
    for (const field of ["rawCharacters", "normalizedCharacters", "inaRecords", "cfrSections", "cfrAppendices", "repeatedCfrPaths"]) target.stats[field] += Number(part.stats?.[field]) || 0;
    for (const authority of ["ina", "cfr"]) target.stats.byAuthority[authority] += Number(part.stats?.byAuthority?.[authority]) || 0;
    for (const [kind, count] of Object.entries(part.stats?.byKind || {})) target.stats.byKind[kind] = (target.stats.byKind[kind] || 0) + count;
  }

  async function buildProjectionAsync(corpus, options = {}) {
    if (!corpus || typeof corpus !== "object") throw new TypeError("A corpus object is required.");
    const started = now(), requested = new Set(projectionAuthorityKey(options).split(",").filter(Boolean));
    const units = [];
    if (requested.has("ina")) {
      const sections = new Map((corpus?.title8?.sections || []).map(section => [normalizedIdentifier(section.section), section]));
      const groups = new Map();
      for (const row of corpus?.inaCrosswalk || []) {
        if (!row || row.isNote || row.hasEquivalent === false || !row.uscSection) continue;
        const section = sections.get(normalizedIdentifier(row.localSection || row.uscSection));
        if (!section || section.status === "transferred") continue;
        if (!groups.has(section.id)) groups.set(section.id, { section, rows: [] });
        groups.get(section.id).rows.push(row);
      }
      for (const group of groups.values()) units.push({
        count: 1,
        build: () => buildProjection({ ...corpus, title8: { ...(corpus.title8 || {}), sections: [group.section] }, inaCrosswalk: group.rows, cfr: { ...(corpus.cfr || {}), sections: [], appendices: [] } }, { ...options, authorities: ["ina"], deferNormalization: true })
      });
    }
    if (requested.has("cfr")) {
      for (const sections of chunkCfrRecords(corpus?.cfr?.sections || [])) units.push({
        count: sections.length,
        build: () => buildProjection({ ...corpus, title8: { ...(corpus.title8 || {}), sections: [] }, inaCrosswalk: [], cfr: { ...(corpus.cfr || {}), sections, appendices: [] } }, { ...options, authorities: ["cfr"], deferNormalization: true })
      });
      for (const appendices of chunkCfrRecords(corpus?.cfr?.appendices || [])) units.push({
        count: appendices.length,
        build: () => buildProjection({ ...corpus, title8: { ...(corpus.title8 || {}), sections: [] }, inaCrosswalk: [], cfr: { ...(corpus.cfr || {}), sections: [], appendices } }, { ...options, authorities: ["cfr"], deferNormalization: true })
      });
    }

    const target = {
      fragments: [], hierarchy: makeHierarchyStore(),
      stats: {
        buildMs: 0, workMs: 0, fragmentCount: 0, rawCharacters: 0, normalizedCharacters: 0,
        inaRecords: 0, cfrSections: 0, cfrAppendices: 0, repeatedCfrPaths: 0,
        byAuthority: { ina: 0, cfr: 0 }, byKind: Object.create(null),
        yields: 0, slices: 1, maxSliceMs: 0
      }
    };
    const sliceMs = Number.isFinite(Number(options.sliceMs)) ? Math.max(0, Number(options.sliceMs)) : DEFAULT_SLICE_MS;
    const yieldControl = typeof options.yieldControl === "function" ? options.yieldControl : () => new Promise(resolve => setTimeout(resolve, 0));
    const total = units.reduce((sum, unit) => sum + unit.count, 0);
    let completed = 0, sliceStarted = now();
    const yieldIfNeeded = force => {
      const elapsed = now() - sliceStarted;
      if (!force && elapsed < sliceMs) return null;
      target.stats.maxSliceMs = Math.max(target.stats.maxSliceMs, elapsed);
      target.stats.yields += 1;
      target.stats.slices += 1;
      options.onProgress?.({ completed, total, fragments: target.fragments.length, generation: options.generation });
      return Promise.resolve(yieldControl()).then(() => {
        throwIfCancelled(options);
        sliceStarted = now();
      });
    };
    throwIfCancelled(options);
    for (const unit of units) {
      let pause;
      if (completed > 0 && now() - sliceStarted >= sliceMs / 2 && (pause = yieldIfNeeded(true))) await pause;
      const workStarted = now();
      const part = unit.build();
      target.stats.workMs += now() - workStarted;
      if ((pause = yieldIfNeeded(false))) await pause;
      const retained = [];
      part.stats.normalizedCharacters = 0;
      for (let index = 0; index < part.fragments.length; index += 1) {
        const fragment = part.fragments[index], normalizeStarted = now(), normalized = normalizeText(fragment.text);
        target.stats.workMs += now() - normalizeStarted;
        if (normalized) {
          retained.push({ ...fragment, normalized });
          part.stats.normalizedCharacters += normalized.length;
        } else {
          part.stats.rawCharacters -= fragment.text.length;
          part.stats.byAuthority[fragment.authority] -= 1;
          part.stats.byKind[fragment.kind] -= 1;
        }
        if ((pause = yieldIfNeeded(false))) await pause;
      }
      part.fragments = retained;
      part.stats.fragmentCount = retained.length;
      mergeProjectionPart(target, part);
      completed += unit.count;
      throwIfCancelled(options);
      if ((pause = yieldIfNeeded(false))) await pause;
    }
    target.stats.maxSliceMs = Math.max(target.stats.maxSliceMs, now() - sliceStarted);
    target.stats.fragmentCount = target.fragments.length;
    target.stats.buildMs = now() - started;
    return {
      schemaVersion: SCHEMA_VERSION,
      corpusVersion: corpus?.corpusVersion || corpus?.cfr?.captureTime || "",
      fragments: target.fragments,
      hierarchyNodes: [...target.hierarchy.nodes.values()],
      hierarchyById: target.hierarchy.nodes,
      stats: target.stats
    };
  }

  function getProjection(corpus, options = {}) {
    if (!corpus || typeof corpus !== "object") throw new TypeError("A corpus object is required.");
    const { cacheKey, version } = projectionCacheDescriptor(corpus, options);
    let entries = projectionCache.get(corpus);
    if (!entries) { entries = new Map(); projectionCache.set(corpus, entries); }
    const cached = entries.get(cacheKey);
    if (!cached || cached.version !== version) entries.set(cacheKey, { version, projection: buildProjection(corpus, options) });
    return entries.get(cacheKey).projection;
  }

  async function getProjectionAsync(corpus, options = {}) {
    if (!corpus || typeof corpus !== "object") throw new TypeError("A corpus object is required.");
    if (options.signal || options.isCancelled || options.onProgress) return buildProjectionAsync(corpus, options);
    // Cooperative construction always returns fully normalized fragments; the
    // deferred flag is an internal synchronous-builder facility only.
    const { cacheKey, version } = projectionCacheDescriptor(corpus, { ...options, deferNormalization: false });
    const synchronous = projectionCache.get(corpus)?.get(cacheKey);
    if (synchronous?.version === version && synchronous.projection) return synchronous.projection;
    let entries = projectionAsyncCache.get(corpus);
    if (!entries) { entries = new Map(); projectionAsyncCache.set(corpus, entries); }
    const cached = entries.get(cacheKey);
    if (cached?.version === version) return cached.promise;
    const promise = buildProjectionAsync(corpus, options).then(projection => {
      let synchronousEntries = projectionCache.get(corpus);
      if (!synchronousEntries) { synchronousEntries = new Map(); projectionCache.set(corpus, synchronousEntries); }
      synchronousEntries.set(cacheKey, { version, projection });
      return projection;
    }).catch(error => {
      if (entries.get(cacheKey)?.promise === promise) entries.delete(cacheKey);
      throw error;
    });
    entries.set(cacheKey, { version, promise });
    return promise;
  }

  function clearProjection(corpus) {
    if (corpus && typeof corpus === "object") {
      projectionCache.delete(corpus);
      projectionAsyncCache.delete(corpus);
    }
  }

  function tokenizeQuery(input) {
    const source = String(input || ""), tokens = [];
    let index = 0;
    while (index < source.length) {
      if (/\s/.test(source[index])) { index += 1; continue; }
      if (source[index] === "(" || source[index] === ")") { tokens.push({ type: source[index], value: source[index] }); index += 1; continue; }
      if (source[index] === '"') {
        const start = index++;
        let value = "", closed = false;
        while (index < source.length) {
          const character = source[index++];
          if (character === "\\" && index < source.length) value += source[index++];
          else if (character === '"') { closed = true; break; }
          else value += character;
        }
        tokens.push({ type: "atom", value, phrase: true, start, closed });
        continue;
      }
      const start = index;
      let value = "", escaped = false;
      while (index < source.length && !/[\s()]/.test(source[index])) {
        if (source[index] === "\\" && index + 1 < source.length) { escaped = true; index += 1; value += source[index++]; }
        else value += source[index++];
      }
      tokens.push(!escaped && /^OR$/i.test(value) ? { type: "or", value } : !escaped && /^NOT$/i.test(value) ? { type: "not", value } : { type: "atom", value, phrase: false, start, closed: true });
    }
    return tokens;
  }

  function compileQuery(input) {
    if (input && typeof input === "object" && Array.isArray(input.clauses) && Array.isArray(input.atoms) && input.atoms.every(atom => typeof atom?.normalized === "string")) return input;
    if (input && typeof input === "object" && Array.isArray(input.clauses)) return compileAst(input);
    const source = String(input || ""), tokens = tokenizeQuery(source), rawClauses = [];
    let index = 0;
    const atomAt = token => {
      if (token?.type !== "atom") throw new SyntaxError("Expected a search term.");
      const normalized = normalizeText(token.value);
      if (!normalized) throw new SyntaxError("Search terms must contain a letter or number.");
      return { text: token.value, normalized, phrase: Boolean(token.phrase) };
    };
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.type === ")") throw new SyntaxError("Unexpected closing parenthesis.");
      if (token.type === "or") throw new SyntaxError("OR must appear between search terms.");
      if (token.type === "not") throw new SyntaxError("NOT is not supported; use positive terms and flat OR alternatives.");
      if (token.type === "(") {
        index += 1;
        const alternatives = [];
        let needsAtom = true;
        while (index < tokens.length && tokens[index].type !== ")") {
          if (tokens[index].type === "(") throw new SyntaxError("Nested search groups are not supported.");
          if (tokens[index].type === "not") throw new SyntaxError("NOT is not supported; use positive terms and flat OR alternatives.");
          if (tokens[index].type === "or") {
            if (needsAtom) throw new SyntaxError("OR must appear between search terms.");
            needsAtom = true;
            index += 1;
            continue;
          }
          alternatives.push(atomAt(tokens[index++]));
          needsAtom = false;
        }
        if (tokens[index]?.type !== ")") throw new SyntaxError("Search group is missing a closing parenthesis.");
        if (needsAtom && alternatives.length) throw new SyntaxError("OR must be followed by a search term.");
        index += 1;
        if (!alternatives.length) throw new SyntaxError("Search groups cannot be empty.");
        rawClauses.push({ alternatives });
        continue;
      }
      const alternatives = [atomAt(token)];
      index += 1;
      while (tokens[index]?.type === "or") {
        index += 1;
        if (tokens[index]?.type !== "atom") throw new SyntaxError("OR must be followed by a search term.");
        alternatives.push(atomAt(tokens[index++]));
      }
      rawClauses.push({ alternatives });
    }
    return compileAst({ source, clauses: rawClauses });
  }

  function compileAst(input) {
    const clauses = [], atoms = [], atomIndexes = new Map();
    for (const sourceClause of input.clauses || []) {
      const alternatives = [], seen = new Set();
      for (const sourceAtom of sourceClause.alternatives || []) {
        const atomValue = typeof sourceAtom === "string" ? { text: sourceAtom } : sourceAtom || {};
        const sourceText = atomValue.normalized || atomValue.text || atomValue.value;
        const normalized = normalizeText(sourceText);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        let atomIndex = atomIndexes.get(normalized);
        if (atomIndex === undefined) {
          atomIndex = atoms.length;
          atomIndexes.set(normalized, atomIndex);
          atoms.push({ index: atomIndex, text: String(atomValue.text || atomValue.value || atomValue.normalized || ""), normalized, phrase: Boolean(atomValue.phrase || atomValue.kind === "phrase"), clauseIndexes: [] });
        }
        alternatives.push(atomIndex);
      }
      if (!alternatives.length) continue;
      const clauseIndex = clauses.length;
      clauses.push({ index: clauseIndex, alternatives });
      for (const atomIndex of alternatives) if (!atoms[atomIndex].clauseIndexes.includes(clauseIndex)) atoms[atomIndex].clauseIndexes.push(clauseIndex);
    }
    return { schemaVersion: 1, source: String(input.source || input.input || ""), clauses, atoms };
  }

  function commonDepth(authority, value) {
    if (value === undefined || value === null || value === "" || value === "deepest") return Infinity;
    if (Number.isInteger(value) && value >= 0) return value;
    const normalized = String(value).toLowerCase().replace(/_/g, "-");
    if (authority === "ina") return STATUTE_DEPTHS[normalized] ?? Infinity;
    if (normalized === "section") return 0;
    const paragraph = normalized.match(/^paragraph(?:-|\s*)([1-6])$/);
    return paragraph ? Number(paragraph[1]) : CFR_DEPTHS[normalized] ?? Infinity;
  }

  function searchOptions(options = {}) {
    const authorityValues = options.authorities === undefined ? ["ina", "cfr"] : iterableValues(options.authorities);
    const authorities = new Set(authorityValues.map(value => {
      const authority = String(value).toLowerCase();
      return ["statute", "statutes", "usc"].includes(authority) ? "ina" : authority;
    }));
    const common = options.common || options.commonDepth || {};
    const commonLevels = common?.levels || common;
    return {
      ...options,
      authorities,
      commonDepths: {
        ina: commonDepth("ina", typeof commonLevels === "object" ? commonLevels.ina ?? commonLevels.statute : commonLevels),
        cfr: commonDepth("cfr", typeof commonLevels === "object" ? commonLevels.cfr : commonLevels)
      }
    };
  }

  function optionsForCommand(query, options) {
    if (!query || typeof query !== "object" || query.type !== "search") return options;
    if (query.ok === false || ["invalid", "incomplete"].includes(query.status)) throw new SyntaxError(query.errors?.[0]?.message || "The search command is invalid.");
    const merged = { ...options };
    if (merged.authorities === undefined) merged.authorities = query.scope?.authority ? [query.scope.authority] : query.common?.authorities;
    if (merged.common === undefined && merged.commonDepth === undefined && query.common) merged.common = query.common;
    if (merged.scope === undefined && query.scope) merged.scope = query.scope;
    return merged;
  }

  function iterableValues(values) {
    if (values === undefined || values === null) return [];
    if (Array.isArray(values)) return values;
    if (typeof values !== "string" && typeof values[Symbol.iterator] === "function") return [...values];
    return [values];
  }

  function valueSet(values) {
    if (values === undefined || values === null) return null;
    return new Set(iterableValues(values).map(normalizedIdentifier));
  }

  function rangeList(values) {
    if (values === undefined || values === null) return [];
    const input = Array.isArray(values) && values.length === 2 && values.every(value => value === null || typeof value !== "object") ? [values] : Array.isArray(values) ? values : [values];
    return input.map(value => Array.isArray(value)
      ? { start: value[0], end: value[1] }
      : { start: value?.start ?? value?.from, end: value?.end ?? value?.to })
      .filter(value => value.start !== undefined && value.end !== undefined);
  }

  function legalTokenCompare(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
  }

  function rangeMatches(value, ranges) {
    const candidate = String(value || "");
    return ranges.some(range => legalTokenCompare(candidate, range.start) >= 0 && legalTokenCompare(candidate, range.end) <= 0);
  }

  function prefixesFor(values) {
    return iterableValues(values).map(path => pathTokens(path).map(normalizedIdentifier));
  }

  function mapValue(map, key) {
    if (!map) return undefined;
    if (typeof map.get === "function") return map.get(key);
    return map[key];
  }

  function makeFragmentFilter(options) {
    const scope = options.scope || {}, custom = typeof options.filter === "function" ? options.filter : null;
    const ina = scope.ina || {}, cfr = scope.cfr || {};
    const directSystem = String(scope.system || scope.citationSystem || "").toLowerCase();
    const directSections = scope.sections;
    const inaSections = valueSet(ina.inaSections ?? ina.sections ?? (directSystem === "ina" ? directSections : undefined));
    const uscSections = valueSet(ina.uscSections ?? (directSystem === "usc" ? directSections : undefined));
    const inaRecordIds = valueSet(ina.recordIds ?? ina.sectionIds);
    const inaRanges = rangeList(ina.inaRanges ?? (directSystem === "ina" ? scope.ranges : undefined));
    const uscRanges = rangeList(ina.uscRanges ?? (directSystem === "usc" ? scope.ranges : undefined));
    const cfrTitles = valueSet(cfr.titles ?? (directSystem === "cfr" ? scope.titles : undefined));
    const cfrParts = valueSet(cfr.parts ?? (directSystem === "cfr" ? scope.parts : undefined));
    const cfrSections = valueSet(cfr.sections ?? cfr.sectionIds ?? (directSystem === "cfr" ? directSections : undefined));
    const cfrAppendices = valueSet(cfr.appendices ?? (directSystem === "cfr" ? scope.appendices : undefined));
    const cfrRanges = rangeList(cfr.ranges ?? (directSystem === "cfr" ? scope.ranges : undefined));
    const inaPrefixes = prefixesFor(ina.pathPrefixes || []), cfrPrefixes = prefixesFor(cfr.pathPrefixes || []);
    const descriptorIds = valueSet(scope.sectionIds), descriptorAuthority = String(scope.authority || "").toLowerCase();
    const descriptorPaths = scope.pathsBySection;
    const hasInaScope = directSystem === "ina" || directSystem === "usc" || Object.keys(ina).length > 0;
    const hasCfrScope = directSystem === "cfr" || Object.keys(cfr).length > 0;
    const pathMatches = (fragment, prefixes) => !prefixes.length || prefixes.some(prefix => prefix.every((token, index) => normalizedIdentifier(fragment.path[index]) === token));
    return fragment => {
      if (!options.authorities.has(fragment.authority)) return false;
      if (hasInaScope && !hasCfrScope && fragment.authority !== "ina") return false;
      if (hasCfrScope && !hasInaScope && fragment.authority !== "cfr") return false;
      if (["ina", "usc", "statute"].includes(descriptorAuthority) && fragment.authority !== "ina") return false;
      if (descriptorAuthority === "cfr" && fragment.authority !== "cfr") return false;
      if (descriptorIds && !descriptorIds.has(normalizedIdentifier(fragment.recordId))) return false;
      const descriptorPath = mapValue(descriptorPaths, fragment.recordId);
      if (descriptorPath?.length && !pathMatches(fragment, [pathTokens(descriptorPath).map(normalizedIdentifier)])) return false;
      if (fragment.authority === "ina") {
        if (inaRecordIds && !inaRecordIds.has(normalizedIdentifier(fragment.recordId))) return false;
        const inaSelected = Boolean(inaSections || inaRanges.length), uscSelected = Boolean(uscSections || uscRanges.length);
        const matchesIna = !inaSelected || fragment.inaSections.some(value => inaSections?.has(normalizedIdentifier(value)) || rangeMatches(value, inaRanges));
        const matchesUsc = !uscSelected || (fragment.uscSections || [fragment.section]).some(value => uscSections?.has(normalizedIdentifier(value)) || rangeMatches(value, uscRanges));
        if ((inaSelected || uscSelected) && !((inaSelected && matchesIna) || (uscSelected && matchesUsc))) return false;
        if (!pathMatches(fragment, inaPrefixes)) return false;
      } else {
        if (cfrTitles && !cfrTitles.has(normalizedIdentifier(fragment.title))) return false;
        if (cfrParts && !cfrParts.has(normalizedIdentifier(fragment.partId)) && !cfrParts.has(normalizedIdentifier(String(fragment.partId).split(":").at(-1)))) return false;
        if (fragment.recordKind === "appendix") {
          if ((cfrSections || cfrRanges.length) && !cfrAppendices) return false;
          if (cfrAppendices && !cfrAppendices.has(normalizedIdentifier(fragment.recordId)) && !cfrAppendices.has(normalizedIdentifier(fragment.section))) return false;
        } else {
          if (cfrAppendices && !cfrSections && !cfrRanges.length) return false;
          if ((cfrSections || cfrRanges.length) && !cfrSections?.has(normalizedIdentifier(fragment.section)) && !cfrSections?.has(normalizedIdentifier(fragment.recordId)) && !rangeMatches(fragment.section, cfrRanges)) return false;
        }
        if (!pathMatches(fragment, cfrPrefixes)) return false;
      }
      return !custom || custom(fragment);
    };
  }

  function bucketFor(fragment, options) {
    const depth = options.commonDepths[fragment.authority], pathDepth = depth === Infinity ? fragment.path.length : Math.min(depth, fragment.path.length);
    const occurrenceKey = depth === Infinity && fragment.deepestOccurrenceKey
      ? fragment.deepestOccurrenceKey
      : pathDepth ? fragment.occurrenceKeys[pathDepth - 1] : fragment.rootOccurrenceKey;
    const path = fragment.path.slice(0, pathDepth), id = `${fragment.authority}\u0000${fragment.recordId}\u0000${occurrenceKey}`;
    const selectedMapping = selectedStatuteMapping(fragment, options);
    const hierarchyBranches = selectedMapping && fragment.hierarchyBranches[selectedMapping.index] ? [fragment.hierarchyBranches[selectedMapping.index]] : fragment.hierarchyBranches;
    const hierarchyIds = hierarchyBranches[0] || fragment.hierarchyIds;
    const citation = citationForFragment(fragment, path, options, selectedMapping);
    const sectionCitation = citationForFragment(fragment, [], options, selectedMapping);
    return { id, authority: fragment.authority, recordKind: fragment.recordKind, recordId: fragment.recordId, occurrenceKey, path, citation, sectionCitation, heading: fragment.heading || "", hierarchyIds, hierarchyBranches, firstSourceOrder: fragment.sourceOrder };
  }

  function selectedStatuteMapping(fragment, options) {
    const mappings = fragment.statuteMappings || [];
    const scope = options.scope || {}, ina = scope.ina || {}, system = String(scope.system || scope.citationSystem || scope.authority || "").toLowerCase();
    const requestedIna = valueSet(ina.inaSections ?? ina.sections ?? (system === "ina" ? scope.sections ?? scope.authoritySection : undefined));
    const requestedUsc = valueSet(ina.uscSections ?? (system === "usc" ? scope.sections ?? scope.authoritySection : undefined));
    if (requestedUsc) {
      const index = mappings.findIndex(item => requestedUsc.has(normalizedIdentifier(item.uscSection)));
      if (index >= 0) return { ...mappings[index], index, system: "usc" };
    }
    if (requestedIna) {
      const index = mappings.findIndex(item => requestedIna.has(normalizedIdentifier(item.inaSection)));
      if (index >= 0) return { ...mappings[index], index, system: "ina" };
    }
    if (system === "usc" && mappings.length) return { ...mappings[0], index: 0, system: "usc" };
    if (system === "ina" && mappings.length) return { ...mappings[0], index: 0, system: "ina" };
    return null;
  }

  function citationForFragment(fragment, path, options, suppliedMapping = null) {
    if (fragment.authority !== "ina") return fragment.rangeCitation && path.length === fragment.path.length ? fragment.rangeCitation : `${fragment.citationBase}${canonicalPath(path)}`;
    const selected = suppliedMapping || selectedStatuteMapping(fragment, options);
    if (selected?.system === "usc") return `8 U.S.C. ${selected.uscSection}${canonicalPath(path)}`;
    if (selected?.system === "ina") return `INA ${selected.inaSection}${canonicalPath(path)}`;
    return `${fragment.citationBase}${canonicalPath(path)}`;
  }

  function readerCommandForFragment(fragment, options) {
    if (fragment.authority === "cfr" && (fragment.recordKind === "appendix" || fragment.rangeCitation)) return fragment.citationBase;
    return citationForFragment(fragment, fragment.path, options);
  }

  function countMatches(haystack, needle) {
    let count = 0, first = -1, cursor = 0;
    while (cursor <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) break;
      if (first < 0) first = index;
      count += 1;
      cursor = index + 1;
    }
    return { count, first };
  }

  function createScanState(projection, compiled, rawOptions) {
    const options = searchOptions(rawOptions), filter = makeFragmentFilter(options);
    return {
      projection, compiled, options, filter, buckets: new Map(),
      stats: { scanMs: 0, finalizeMs: 0, totalMs: 0, fragmentsScanned: 0, fragmentsMatched: 0, bucketsConsidered: 0, qualifyingBuckets: 0, totalOccurrences: 0, yields: 0, slices: 1, maxSliceMs: 0, materializedOccurrences: 0, materializedFragments: 0 }
    };
  }

  function scanFragment(state, fragmentIndex) {
    const fragment = state.projection.fragments[fragmentIndex];
    if (!state.filter(fragment)) return;
    state.stats.fragmentsScanned += 1;
    const matches = [];
    for (const atom of state.compiled.atoms) {
      const result = countMatches(fragment.normalized, atom.normalized);
      if (result.count) matches.push({ atomIndex: atom.index, count: result.count, first: result.first });
    }
    if (!matches.length) return;
    state.stats.fragmentsMatched += 1;
    const descriptor = bucketFor(fragment, state.options);
    let bucket = state.buckets.get(descriptor.id);
    if (!bucket) {
      bucket = { ...descriptor, clauseMatches: new Uint8Array(state.compiled.clauses.length), rows: [], firstEvidence: Array(state.compiled.clauses.length).fill(null), totalOccurrences: 0 };
      state.buckets.set(descriptor.id, bucket);
    }
    const atomCounts = [];
    for (const match of matches) {
      const atom = state.compiled.atoms[match.atomIndex];
      atomCounts.push([match.atomIndex, match.count]);
      bucket.totalOccurrences += match.count;
      for (const clauseIndex of atom.clauseIndexes) {
        bucket.clauseMatches[clauseIndex] = 1;
        if (!bucket.firstEvidence[clauseIndex]) bucket.firstEvidence[clauseIndex] = { fragmentIndex, atomIndex: match.atomIndex, normalizedStart: match.first };
      }
    }
    bucket.rows.push({ fragmentIndex, atomCounts, count: atomCounts.reduce((sum, item) => sum + item[1], 0) });
  }

  function abortedError() {
    const error = new Error("The occurrence search was cancelled.");
    error.name = "AbortError";
    return error;
  }

  function throwIfCancelled(options) {
    if (options.signal?.aborted || options.isCancelled?.()) throw abortedError();
  }

  function finalizeSearch(state, started) {
    const finalizeStarted = now(), buckets = [...state.buckets.values()]
      .filter(bucket => state.compiled.clauses.length > 0 && bucket.clauseMatches.every(Boolean))
      .filter(bucket => typeof state.options.bucketFilter !== "function" || state.options.bucketFilter(bucket, { projection: state.projection, compiled: state.compiled, options: state.options }) !== false)
      .sort((left, right) => left.firstSourceOrder - right.firstSourceOrder);
    const hierarchyAggregates = new Map();
    for (const bucket of buckets) {
      state.stats.totalOccurrences += bucket.totalOccurrences;
      const hierarchyIds = new Set(bucket.hierarchyBranches.flat());
      for (const id of hierarchyIds) {
        let aggregate = hierarchyAggregates.get(id);
        if (!aggregate) {
          const node = state.projection.hierarchyById.get(id) || { id, order: Number.MAX_SAFE_INTEGER };
          aggregate = { id, parentId: node.parentId || null, authority: node.authority || bucket.authority, kind: node.kind || "unit", number: node.number || "", heading: node.heading || "", order: node.order, totalOccurrences: 0, bucketCount: 0 };
          hierarchyAggregates.set(id, aggregate);
        }
        aggregate.totalOccurrences += bucket.totalOccurrences;
        aggregate.bucketCount += 1;
      }
    }
    const sectionsById = new Map();
    for (const bucket of buckets) {
      const branches = bucket.hierarchyBranches?.length ? bucket.hierarchyBranches : [bucket.hierarchyIds || []];
      const sectionIds = new Set();
      for (const branch of branches) {
        const hierarchyId = branch?.at?.(-1) || bucket.hierarchyIds?.at?.(-1) || "";
        const node = state.projection.hierarchyById.get(hierarchyId) || null;
        const id = `${bucket.authority}\u0000${bucket.recordId}\u0000${hierarchyId}`;
        if (sectionIds.has(id)) continue;
        sectionIds.add(id);
        let section = sectionsById.get(id);
        if (!section) {
          const citation = bucket.authority === "ina" && node?.kind === "section" && node.number
            ? `INA ${node.number}`
            : bucket.sectionCitation;
          section = {
            id, authority: bucket.authority, recordKind: bucket.recordKind, recordId: bucket.recordId,
            hierarchyId, hierarchyIds: [...(branch || bucket.hierarchyIds || [])], citation,
            heading: node?.heading || bucket.heading || "", firstSourceOrder: bucket.firstSourceOrder,
            totalOccurrences: 0, bucketCount: 0, bucketIds: []
          };
          sectionsById.set(id, section);
        }
        section.totalOccurrences += bucket.totalOccurrences;
        section.bucketCount += 1;
        section.bucketIds.push(bucket.id);
        section.firstSourceOrder = Math.min(section.firstSourceOrder, bucket.firstSourceOrder);
      }
      bucket.sectionIds = [...sectionIds];
    }
    const sections = [...sectionsById.values()].sort((left, right) => left.firstSourceOrder - right.firstSourceOrder || left.citation.localeCompare(right.citation));
    state.stats.bucketsConsidered = state.buckets.size;
    state.stats.qualifyingBuckets = buckets.length;
    state.stats.finalizeMs = now() - finalizeStarted;
    state.stats.totalMs = now() - started;
    const result = {
      schemaVersion: 1,
      query: state.compiled,
      options: { authorities: [...state.options.authorities], commonDepths: state.options.commonDepths },
      buckets: buckets.map(bucket => ({ id: bucket.id, authority: bucket.authority, recordKind: bucket.recordKind, recordId: bucket.recordId, occurrenceKey: bucket.occurrenceKey, path: bucket.path, citation: bucket.citation, sectionCitation: bucket.sectionCitation, sectionIds: bucket.sectionIds, heading: bucket.heading, hierarchyIds: bucket.hierarchyIds, firstSourceOrder: bucket.firstSourceOrder, totalOccurrences: bucket.totalOccurrences, fragmentCount: bucket.rows.length })),
      sections: sections.map(section => ({ ...section, bucketIds: [...section.bucketIds] })),
      totalOccurrences: state.stats.totalOccurrences,
      hierarchy: [...hierarchyAggregates.values()].sort((left, right) => left.order - right.order),
      stats: state.stats
    };
    const bucketInternals = new Map(buckets.map(bucket => [bucket.id, bucket]));
    const sectionInternals = new Map(sections.map(section => [section.id, section.bucketIds.map(id => bucketInternals.get(id)).filter(Boolean)]));
    result.materializeOccurrences = materializationFunction(result, state.projection, state.compiled, bucketInternals, sectionInternals, state.options);
    return result;
  }

  function search(projection, query, options = {}) {
    options = optionsForCommand(query, options);
    const started = now(), compiled = compileQuery(query), state = createScanState(projection, compiled, options), scanStarted = now();
    throwIfCancelled(options);
    for (let index = 0; index < projection.fragments.length; index += 1) scanFragment(state, index);
    throwIfCancelled(options);
    state.stats.scanMs = now() - scanStarted;
    state.stats.maxSliceMs = state.stats.scanMs;
    return finalizeSearch(state, started);
  }

  async function searchAsync(projection, query, options = {}) {
    options = optionsForCommand(query, options);
    const started = now(), compiled = compileQuery(query), state = createScanState(projection, compiled, options), scanStarted = now();
    const sliceMs = Number.isFinite(Number(options.sliceMs)) ? Math.max(0, Number(options.sliceMs)) : DEFAULT_SLICE_MS;
    const yieldControl = typeof options.yieldControl === "function" ? options.yieldControl : () => new Promise(resolve => setTimeout(resolve, 0));
    let sliceStarted = now();
    throwIfCancelled(options);
    for (let index = 0; index < projection.fragments.length; index += 1) {
      scanFragment(state, index);
      if ((index & 63) === 63) {
        throwIfCancelled(options);
        const elapsed = now() - sliceStarted;
        if (elapsed >= sliceMs) {
          state.stats.maxSliceMs = Math.max(state.stats.maxSliceMs, elapsed);
          state.stats.yields += 1;
          state.stats.slices += 1;
          options.onProgress?.({ scanned: index + 1, total: projection.fragments.length, generation: options.generation });
          await yieldControl();
          throwIfCancelled(options);
          sliceStarted = now();
        }
      }
    }
    state.stats.maxSliceMs = Math.max(state.stats.maxSliceMs, now() - sliceStarted);
    state.stats.scanMs = now() - scanStarted;
    return finalizeSearch(state, started);
  }

  function createSearchSession(projection, defaults = {}) {
    let generation = 0;
    return Object.freeze({
      get generation() { return generation; },
      cancel() { generation += 1; },
      search(query, options = {}) {
        const current = ++generation;
        const combined = { ...defaults, ...options }, externalCancellation = combined.isCancelled;
        return searchAsync(projection, query, { ...combined, generation: current, isCancelled: () => current !== generation || externalCancellation?.() });
      }
    });
  }

  function allNormalizedMatches(text, atoms, atomCounts) {
    const matches = [];
    for (const [atomIndex] of atomCounts) {
      const atom = atoms[atomIndex];
      let cursor = 0;
      while (cursor <= text.length - atom.normalized.length) {
        const index = text.indexOf(atom.normalized, cursor);
        if (index < 0) break;
        matches.push({ atomIndex, normalizedStart: index, normalizedEnd: index + atom.normalized.length });
        cursor = index + 1;
      }
    }
    return matches.sort((left, right) => left.normalizedStart - right.normalizedStart || left.atomIndex - right.atomIndex || left.normalizedEnd - right.normalizedEnd);
  }

  function snippetFromMatch(fragment, mapped, match, contextCharacters) {
    const rawStart = mapped.starts[match.normalizedStart] ?? 0, rawEnd = mapped.ends[Math.max(match.normalizedStart, match.normalizedEnd - 1)] ?? rawStart;
    let start = Math.max(0, rawStart - contextCharacters), end = Math.min(fragment.text.length, rawEnd + contextCharacters);
    if (start > 0) {
      const boundary = fragment.text.slice(start, rawStart).search(/\s/);
      if (boundary >= 0) start += boundary + 1;
    }
    if (end < fragment.text.length) {
      const boundary = fragment.text.slice(rawEnd, end).lastIndexOf(" ");
      if (boundary >= 0) end = rawEnd + boundary;
    }
    return {
      start, end, matchStart: rawStart, matchEnd: rawEnd,
      leadingEllipsis: start > 0, trailingEllipsis: end < fragment.text.length,
      leading: fragment.text.slice(start, rawStart), match: fragment.text.slice(rawStart, rawEnd), trailing: fragment.text.slice(rawEnd, end)
    };
  }

  function materializationFunction(result, projection, compiled, bucketInternals, sectionInternals, searchOptions) {
    const offsetCache = new Map();
    const mappedFor = fragment => {
      if (!offsetCache.has(fragment.id)) {
        offsetCache.set(fragment.id, normalizedTextWithOffsets(fragment.text));
        result.stats.materializedFragments += 1;
      }
      return offsetCache.get(fragment.id);
    };
    const evidenceRow = (evidence, contextCharacters) => {
      const fragment = projection.fragments[evidence.fragmentIndex], atom = compiled.atoms[evidence.atomIndex], mapped = mappedFor(fragment);
      return { fragmentIndex: evidence.fragmentIndex, normalizedStart: evidence.normalizedStart, normalizedEnd: evidence.normalizedStart + atom.normalized.length, fragmentId: fragment.id, recordId: fragment.recordId, recordKind: fragment.recordKind, readerCommand: readerCommandForFragment(fragment, searchOptions), citation: citationForFragment(fragment, fragment.path, searchOptions), path: fragment.path, kind: fragment.kind, atom: { index: atom.index, text: atom.text, normalized: atom.normalized }, snippet: snippetFromMatch(fragment, mapped, { atomIndex: atom.index, normalizedStart: evidence.normalizedStart, normalizedEnd: evidence.normalizedStart + atom.normalized.length }, contextCharacters), target: fragment.source };
    };
    const nearestEvidence = (bucket, targetFragmentIndex, targetStart, clauseIndex) => {
      let best = null;
      for (const fragmentRow of bucket.rows) {
        const fragment = projection.fragments[fragmentRow.fragmentIndex];
        for (const [atomIndex] of fragmentRow.atomCounts) {
          const atom = compiled.atoms[atomIndex];
          if (!atom.clauseIndexes.includes(clauseIndex)) continue;
          let normalizedStart;
          if (fragmentRow.fragmentIndex === targetFragmentIndex) {
            const before = fragment.normalized.lastIndexOf(atom.normalized, targetStart);
            const after = fragment.normalized.indexOf(atom.normalized, targetStart);
            normalizedStart = before < 0 ? after : after < 0 || targetStart - before <= after - targetStart ? before : after;
          } else if (fragmentRow.fragmentIndex < targetFragmentIndex) normalizedStart = fragment.normalized.lastIndexOf(atom.normalized);
          else normalizedStart = fragment.normalized.indexOf(atom.normalized);
          if (normalizedStart < 0) continue;
          const sourceDistance = Math.abs(fragmentRow.fragmentIndex - targetFragmentIndex);
          const offsetDistance = fragmentRow.fragmentIndex === targetFragmentIndex ? Math.abs(normalizedStart - targetStart) : 0;
          const candidate = { fragmentIndex: fragmentRow.fragmentIndex, atomIndex, normalizedStart, sourceDistance, offsetDistance };
          if (!best || sourceDistance < best.sourceDistance || (sourceDistance === best.sourceDistance && offsetDistance < best.offsetDistance) || (sourceDistance === best.sourceDistance && offsetDistance === best.offsetDistance && fragmentRow.fragmentIndex < best.fragmentIndex)) best = candidate;
        }
      }
      return best || bucket.firstEvidence[clauseIndex];
    };
    const snippetParts = snippet => ({
      leadingEllipsis: snippet.leadingEllipsis,
      trailingEllipsis: snippet.trailingEllipsis,
      parts: [
        ...(snippet.leading ? [{ text: snippet.leading, match: false }] : []),
        ...(snippet.match ? [{ text: snippet.match, match: true }] : []),
        ...(snippet.trailing ? [{ text: snippet.trailing, match: false }] : [])
      ]
    });
    const contiguousSnippet = (fragment, hits, contextCharacters) => {
      const mapped = mappedFor(fragment);
      const rawHits = hits.map(hit => ({
        start: mapped.starts[hit.normalizedStart] ?? 0,
        end: mapped.ends[Math.max(hit.normalizedStart, hit.normalizedEnd - 1)] ?? (mapped.starts[hit.normalizedStart] ?? 0)
      })).sort((left, right) => left.start - right.start || left.end - right.end);
      if (!rawHits.length) return null;
      const first = rawHits[0].start, last = rawHits.reduce((maximum, hit) => Math.max(maximum, hit.end), first);
      const allowance = Math.max(64, contextCharacters * 2);
      if (last - first > allowance) return null;
      const remaining = Math.max(16, allowance - (last - first));
      let start = Math.max(0, first - Math.floor(remaining / 2));
      let end = Math.min(fragment.text.length, last + Math.ceil(remaining / 2));
      if (start > 0) {
        const boundary = fragment.text.slice(start, first).search(/\s/);
        if (boundary >= 0) start += boundary + 1;
      }
      if (end < fragment.text.length) {
        const boundary = fragment.text.slice(last, end).lastIndexOf(" ");
        if (boundary >= 0) end = last + boundary;
      }
      const merged = [];
      for (const hit of rawHits) {
        const previous = merged.at(-1);
        if (previous && hit.start <= previous.end) previous.end = Math.max(previous.end, hit.end);
        else merged.push({ ...hit });
      }
      const parts = [];
      let cursor = start;
      for (const hit of merged) {
        if (hit.end <= start || hit.start >= end) continue;
        const hitStart = Math.max(start, hit.start), hitEnd = Math.min(end, hit.end);
        if (hitStart > cursor) parts.push({ text: fragment.text.slice(cursor, hitStart), match: false });
        if (hitEnd > hitStart) parts.push({ text: fragment.text.slice(hitStart, hitEnd), match: true });
        cursor = Math.max(cursor, hitEnd);
      }
      if (cursor < end) parts.push({ text: fragment.text.slice(cursor, end), match: false });
      return { leadingEllipsis: start > 0, trailingEllipsis: end < fragment.text.length, parts };
    };
    const composedSnippets = (primary, evidence, contextCharacters) => {
      const hits = [
        { fragmentIndex: primary.fragmentIndex, normalizedStart: primary.normalizedStart, normalizedEnd: primary.normalizedEnd },
        ...evidence.map(item => ({ fragmentIndex: item.fragmentIndex, normalizedStart: item.normalizedStart, normalizedEnd: item.normalizedEnd }))
      ].filter((hit, index, all) => all.findIndex(other => other.fragmentIndex === hit.fragmentIndex && other.normalizedStart === hit.normalizedStart && other.normalizedEnd === hit.normalizedEnd) === index);
      if (hits.every(hit => hit.fragmentIndex === hits[0].fragmentIndex)) {
        const contiguous = contiguousSnippet(projection.fragments[hits[0].fragmentIndex], hits, contextCharacters);
        if (contiguous) return [contiguous];
      }
      const perHitContext = Math.max(8, Math.floor(contextCharacters / Math.max(1, hits.length)));
      return hits.map((hit, index) => {
        const fragment = projection.fragments[hit.fragmentIndex];
        const snippet = snippetParts(snippetFromMatch(fragment, mappedFor(fragment), hit, perHitContext));
        return { ...snippet, leadingEllipsis: index === 0, trailingEllipsis: true };
      });
    };
    return function materializeOccurrences(options = {}) {
      const start = Math.max(0, Number(options.start) || 0), limit = Math.max(0, Math.min(1000, Number(options.limit ?? 50) || 0)), contextCharacters = Math.max(16, Number(options.contextCharacters ?? 90) || 90);
      const selected = options.sectionId
        ? [...(sectionInternals.get(options.sectionId) || [])]
        : options.bucketId ? [bucketInternals.get(options.bucketId)].filter(Boolean) : [...bucketInternals.values()];
      const rows = [];
      let globalCursor = 0;
      for (const bucket of selected) {
        if (rows.length >= limit) break;
        if (globalCursor + bucket.totalOccurrences <= start) { globalCursor += bucket.totalOccurrences; continue; }
        for (const fragmentRow of bucket.rows) {
          if (rows.length >= limit) break;
          if (globalCursor + fragmentRow.count <= start) { globalCursor += fragmentRow.count; continue; }
          const fragment = projection.fragments[fragmentRow.fragmentIndex], mapped = mappedFor(fragment), matches = allNormalizedMatches(fragment.normalized, compiled.atoms, fragmentRow.atomCounts);
          for (const match of matches) {
            if (globalCursor++ < start) continue;
            if (rows.length >= limit) break;
            const atom = compiled.atoms[match.atomIndex], ownClauses = new Set(atom.clauseIndexes);
            const evidence = compiled.clauses
              .filter(clause => !ownClauses.has(clause.index))
              .map(clause => nearestEvidence(bucket, fragmentRow.fragmentIndex, match.normalizedStart, clause.index))
              .filter(Boolean)
              .map(item => evidenceRow(item, contextCharacters));
            const primary = { fragmentIndex: fragmentRow.fragmentIndex, normalizedStart: match.normalizedStart, normalizedEnd: match.normalizedEnd };
            rows.push({
              id: `${bucket.id}\u0000${fragment.id}\u0000${match.atomIndex}\u0000${match.normalizedStart}`,
              bucketId: bucket.id, fragmentId: fragment.id, authority: fragment.authority, recordId: fragment.recordId, recordKind: fragment.recordKind,
              readerCommand: readerCommandForFragment(fragment, searchOptions),
              citation: citationForFragment(fragment, fragment.path, searchOptions), path: fragment.path, occurrenceKey: fragment.path.length ? fragment.occurrenceKeys.at(-1) : fragment.rootOccurrenceKey,
              kind: fragment.kind, atom: { index: atom.index, text: atom.text, normalized: atom.normalized, phrase: atom.phrase },
              snippet: snippetFromMatch(fragment, mapped, match, contextCharacters), snippets: composedSnippets(primary, evidence, contextCharacters), evidence, target: fragment.source
            });
          }
        }
      }
      result.stats.materializedOccurrences += rows.length;
      return { start, requested: limit, returned: rows.length, total: selected.reduce((sum, bucket) => sum + bucket.totalOccurrences, 0), rows };
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    DEFAULT_SLICE_MS,
    STATUTE_LEVEL_NAMES,
    CFR_LEVEL_NAMES,
    normalizeText,
    normalizedTextWithOffsets,
    compileQuery,
    buildProjection,
    buildProjectionAsync,
    getProjection,
    getProjectionAsync,
    clearProjection,
    search,
    searchAsync,
    createSearchSession
  });
});
