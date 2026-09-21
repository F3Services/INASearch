/* Shared, DOM-free execution of structured search scopes in the worker and fallback. */
(function(root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./INASearch-Occurrence") : root.INA_SEARCH_OCCURRENCE,
    typeof module === "object" && module.exports ? require("./INASearch-Annotations") : root.INA_SEARCH_ANNOTATIONS);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.INA_SEARCH_QUERY = api;
})(globalThis, function(occurrence, annotations) {
  "use strict";
  const prefix = (path, parent) => (parent || []).every((part, i) => String(path?.[i]) === String(part));
  const pathKey = path => (path || []).map(String).join("/");
  const normalize = occurrence.normalizeText;
  const scopePaths = (scope, id) => scope.pathAlternativesBySection?.get(id) || [scope.pathsBySection?.get(id) || []];
  function intersectScopePaths(scopes, id) {
    let paths = [[]];
    for (const scope of scopes) paths = paths.flatMap(left => scopePaths(scope, id).flatMap(right => prefix(left, right) ? [left] : prefix(right, left) ? [right] : []));
    return paths;
  }
  function scopeMatches(fragment, scope) {
    if (!scope?.valid) return false;
    if (scope.family !== (fragment.authority === "ina" ? "usc" : "cfr")) return false;
    if (!scope.sectionIds?.has(fragment.recordId)) return false;
    return scopePaths(scope, fragment.recordId).some(path => prefix(fragment.path, path));
  }
  function referenceMatches(reference, scope) {
    return reference.family === scope.family && scope.sectionIds?.has(reference.sectionId) && scopePaths(scope, reference.sectionId).some(path => prefix(reference.path, path));
  }
  function associationMatches(fragment, association) {
    if (!association?.start || association.family !== (fragment.authority === "ina" ? "usc" : "cfr")) return false;
    if (association.family === "cfr" && Number(association.title) !== Number(fragment.title)) return false;
    if (String(association.start.unit).toLowerCase() !== String(fragment.section).toLowerCase()) return false;
    return prefix(fragment.path, association.start.path);
  }
  const coverageCache = new WeakMap();
  function resolveHighlights(projection, personal = {}) {
    const cacheKey = JSON.stringify(personal.highlights || []), cached = coverageCache.get(projection);
    if (cached?.key === cacheKey) return cached.ranges;
    const ranges = new Map();
    for (const highlight of personal.highlights || []) for (const segment of highlight.segments || []) {
      if (segment.anchor?.status === "needs-review" || segment.association?.structureStatus === "needs-review") continue;
      // A host can contain a heading and several run-in fragments. Resolve its quote as
      // a whole before mapping offsets back to fragments; never guess repeated text.
      let candidates = projection.fragments.filter(f => (f.contentKind || "law") === "law" && associationMatches(f, segment.association) && pathKey(f.path) === pathKey(segment.association.start.path));
      if (segment.association?.family === "cfr") {
        // Several CFR units can share one rendered paragraph. Resolve against
        // that complete source host, then assign coverage to the actual unit.
        const hosts = new Set(candidates.filter(f => f.source?.field === "blocks").map(f => `${f.recordId}:${JSON.stringify(f.source.blockPath)}`));
        candidates = projection.fragments.filter(f => candidates.includes(f) || ((f.contentKind || "law") === "law" && f.authority === "cfr" && f.source?.field === "blocks" && hosts.has(`${f.recordId}:${JSON.stringify(f.source.blockPath)}`)));
      }
      if (!candidates.length) continue;
      let located = null;
      for (const display of [false, true]) {
        if (located) break;
        for (const separator of ["", " ", "\n"]) {
          let source = ""; const entries = [];
          for (const fragment of candidates) {
            if (source) source += separator;
            const mapped = display ? displayMappedText(fragment) : { text: fragment.text, starts: Array.from({ length: fragment.text.length }, (_, i) => i), ends: Array.from({ length: fragment.text.length }, (_, i) => i + 1) };
            entries.push({ fragment, mapped, start: source.length, end: source.length + mapped.text.length });
            source += mapped.text;
          }
          const resolved = annotations.resolveQuoteAnchor(source, segment.anchor);
          if (resolved.status === "active") { located = { entries, resolved }; break; }
        }
      }
      if (!located) continue;
      for (const entry of located.entries) {
        const start = Math.max(0, located.resolved.start - entry.start), end = Math.min(entry.mapped.text.length, located.resolved.end - entry.start);
        if (end <= start) continue;
        if (!ranges.has(entry.fragment.id)) ranges.set(entry.fragment.id, []);
        ranges.get(entry.fragment.id).push({ start: entry.mapped.starts[start], end: entry.mapped.ends[end - 1], color: highlight.color || "yellow", id: highlight.id, segmentId: segment.id,
          selectedText: entry.mapped.text.slice(start, end), starts: entry.mapped.starts.slice(start, end), ends: entry.mapped.ends.slice(start, end) });
      }
    }
    coverageCache.set(projection, { key: cacheKey, ranges });
    return ranges;
  }
  function displayMappedText(fragment) {
    const result = { text: "", starts: [], ends: [] };
    let cursor = 0;
    const append = (text, start, end, replaced = false) => {
      result.text += text;
      for (let i = 0; i < text.length; i++) { result.starts.push(replaced ? start : start + i); result.ends.push(replaced ? end : start + i + 1); }
    };
    for (const ref of fragment.references || []) {
      if (!ref.displayText || ref.start < cursor) continue;
      append(fragment.text.slice(cursor, ref.start), cursor, ref.start);
      append(ref.displayText, ref.start, ref.end, true); cursor = ref.end;
    }
    append(fragment.text.slice(cursor), cursor, fragment.text.length);
    return result;
  }
  function exactMatches(fragment, compiled, saved) {
    // Each selected interval is searched separately: a phrase never jumps a gap.
    const matches = rawMatches(fragment.text, compiled, mergeIntervals(saved.filter(range => range.selectedText === fragment.text.slice(range.start, range.end))));
    for (const selected of saved) for (const hit of rawMatches(selected.selectedText, compiled, [{ start: 0, end: selected.selectedText.length }])) {
      matches.push({ ...hit, start: selected.starts[hit.start], end: selected.ends[hit.end - 1], selectedText: selected.selectedText.slice(hit.start, hit.end) });
    }
    const unique = new Map();
    for (const hit of matches) {
      const key = `${hit.start}:${hit.end}`, previous = unique.get(key);
      if (previous) previous.clauses = [...new Set([...previous.clauses, ...hit.clauses])];
      else unique.set(key, hit);
    }
    return [...unique.values()];
  }
  function mergeIntervals(ranges) {
    const result = [];
    for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = result.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else result.push({ start: range.start, end: range.end });
    }
    return result;
  }
  function rawMatches(text, compiled, ranges, normalized) {
    if (!compiled.atoms.length) return [];
    const matches = [];
    for (const range of ranges) {
      const source = text.slice(range.start, range.end);
      const indexed = normalized ?? normalize(source);
      // The projection already contains normalized text. Most fragments have no
      // evidence; source-position mapping is only needed for actual matches.
      if (!compiled.atoms.some(atom => indexed.includes(atom.normalized))) continue;
      const mapped = occurrence.normalizedTextWithOffsets(source);
      for (const atom of compiled.atoms) {
        let offset = mapped.text.indexOf(atom.normalized);
        while (offset >= 0) {
          matches.push({ start: range.start + mapped.starts[offset], end: range.start + mapped.ends[offset + atom.normalized.length - 1], atomIndex: atom.index, clauses: atom.clauseIndexes });
          offset = mapped.text.indexOf(atom.normalized, offset + 1);
        }
      }
    }
    const seen = new Map();
    for (const match of matches) {
      const key = `${match.start}:${match.end}`, previous = seen.get(key);
      if (previous) previous.clauses = [...new Set([...previous.clauses, ...match.clauses])];
      else seen.set(key, { ...match, clauses: [...match.clauses] });
    }
    return [...seen.values()];
  }
  const expandingCharacters = new WeakMap();
  function indexedMatches(fragment, compiled) {
    if (!compiled.atoms.length) return [];
    const text = fragment.normalized ?? normalize(fragment.text), matches = new Map();
    for (const atom of compiled.atoms) {
      let start = text.indexOf(atom.normalized);
      while (start >= 0) {
        const end = start + atom.normalized.length, key = `${start}:${end}`, previous = matches.get(key);
        if (previous) previous.clauses = [...new Set([...previous.clauses, ...atom.clauseIndexes])];
        else matches.set(key, { start, end, normalized: true, atomIndex: atom.index, clauses: atom.clauseIndexes });
        start = text.indexOf(atom.normalized, start + 1);
      }
    }
    if (!matches.size) return [];
    // Compatibility characters such as ligatures can yield two normalized hits
    // at one source character. Preserve source-occurrence deduplication there.
    if (!expandingCharacters.has(fragment)) expandingCharacters.set(fragment, [...fragment.text.matchAll(/[^\x00-\x7f]/gu)].some(match => normalize(match[0]).length > 1));
    if (expandingCharacters.get(fragment)) return rawMatches(fragment.text, compiled, [{ start: 0, end: fragment.text.length }], text);
    return [...matches.values()];
  }
  function sourceHit(fragment, hit, mappings) {
    if (!hit.normalized) return hit;
    let mapped = mappings.get(fragment);
    if (!mapped) { mapped = occurrence.normalizedTextWithOffsets(fragment.text); mappings.set(fragment, mapped); }
    return { ...hit, start: mapped.starts[hit.start], end: mapped.ends[hit.end - 1], normalized: false };
  }
  function makeSnippet(fragment, hit, highlights, context = 90) {
    const start = Math.max(hit.clip?.start || 0, hit.start - context), end = Math.min(hit.clip?.end ?? fragment.text.length, hit.end + context);
    const boundaries = new Set([start, end, hit.start, hit.end]);
    for (const range of highlights) if (range.end > start && range.start < end) { boundaries.add(Math.max(start, range.start)); boundaries.add(Math.min(end, range.end)); }
    const offsets = [...boundaries].filter(n => n >= start && n <= end).sort((a, b) => a - b), parts = [];
    for (let i = 0; i < offsets.length - 1; i++) {
      const left = offsets[i], right = offsets[i + 1];
      if (right <= left) continue;
      const saved = highlights.find(range => range.start <= left && range.end >= right);
      parts.push({ text: fragment.text.slice(left, right), match: hit.match !== false && left >= hit.start && right <= hit.end, ...(saved ? { highlightColor: saved.color } : {}) });
    }
    return { start, end, matchStart: hit.start, matchEnd: hit.end, leadingEllipsis: start > 0, trailingEllipsis: end < fragment.text.length, parts };
  }
  function previewText(text, ast, ranges = []) {
    const hits = rawMatches(text, occurrence.compileQuery(ast), [{ start: 0, end: text.length }]);
    const evidence = [...ranges, ...hits];
    if (!evidence.length) return [];
    const selected = [], covered = new Set();
    for (const hit of evidence) {
      if (selected.length && !(hit.clauses || []).some(clause => !covered.has(clause))) continue;
      selected.push(makeSnippet({ text }, hit, []));
      (hit.clauses || []).forEach(clause => covered.add(clause));
    }
    return selected;
  }
  function cancelled(options) {
    if (options.signal?.aborted || options.isCancelled?.()) { const e = new Error("Search cancelled"); e.name = "AbortError"; throw e; }
  }
  function* evaluate(projection, ast, options) {
    const plan = options.plan, compiled = occurrence.compileQuery(ast), settings = occurrence.searchOptions({ ...options, common: ast.common });
    const personal = options.personal || {};
    const has = ast.has || [], citationScopes = plan.citationScopes || [];
    const needsNotes = has.some(clause => clause.kinds.includes("notes"));
    const needsHighlights = has.some(clause => clause.kinds.includes("highlights")) || plan.branches.some(branch => branch.highlightMode);
    let highlights;
    const getHighlights = () => highlights ||= resolveHighlights(projection, personal);
    if (needsHighlights) getHighlights();
    const mappings = new Map();
    const mergeBranches = plan.branches.filter(branch => branch.kind !== "notes").length > 1;
    const selectedRows = new Map(), selectedGroups = [], scanned = { fragmentsScanned: 0 };
    for (const branch of plan.branches || []) {
      if (branch.kind === "notes") continue;
      const buckets = new Map();
      for (let index = 0; index < projection.fragments.length; index++) {
        if ((index & 255) === 0) { cancelled(options); yield index; }
        const fragment = projection.fragments[index];
        if (!settings.authorities.has(fragment.authority)) continue;
        if ((fragment.contentKind || "law") !== (branch.kind === "annotations" ? "annotations" : "law")) continue;
        if (!(branch.scopes || []).every(scope => scopeMatches(fragment, scope))) continue;
        scanned.fragmentsScanned++;
        const saved = highlights?.get(fragment.id) || [], intervals = branch.highlightMode === "exact" ? mergeIntervals(saved) : [{ start: 0, end: fragment.text.length }];
        if (!intervals.length) continue;
        const note = needsNotes && (personal.notes || []).some(note => (note.coverageScopes || []).some(scope => scopeMatches(fragment, scope)) || (note.associations || []).some(association => !association.end && associationMatches(fragment, association)));
        const hits = branch.highlightMode === "exact" ? exactMatches(fragment, compiled, saved) : indexedMatches(fragment, compiled);
        const citationHits = [], citations = new Set();
        for (const reference of citationScopes.length ? fragment.references || [] : []) {
          if (branch.highlightMode === "exact") {
            const rawCovered = mergeIntervals(saved.filter(range => range.selectedText === fragment.text.slice(range.start, range.end))).some(range => range.start <= reference.start && range.end >= reference.end);
            const displayCovered = reference.displayText && saved.some(range => range.start <= reference.start && range.end >= reference.end && range.selectedText.includes(reference.displayText));
            if (!rawCovered && !displayCovered) continue;
          }
          let matches = false;
          for (let groupIndex = 0; groupIndex < citationScopes.length; groupIndex++) {
            if (citationScopes[groupIndex].some(scope => referenceMatches(reference, scope))) { citations.add(groupIndex); matches = true; }
          }
          if (matches) citationHits.push({ start: reference.start, end: reference.end });
        }
        // Retain evidence-only fragments for Common/has/highlight presence, but
        // ordinary word searches need no bucket for an unrelated fragment.
        if ((compiled.clauses.length || citationScopes.length) && !hits.length && !citationHits.length && !saved.length && !note) continue;
        const descriptor = occurrence.bucketFor(fragment, settings);
        const bucketId = `${branch.kind}:${descriptor.id}`;
        let bucket = buckets.get(bucketId);
        if (!bucket) { bucket = { ...descriptor, items: [], clauses: new Set(), citations: new Set(), highlighted: false, note: false }; buckets.set(bucketId, bucket); }
        bucket.highlighted ||= saved.length > 0;
        bucket.note ||= note;
        for (const hit of hits) for (const clause of hit.clauses) bucket.clauses.add(clause);
        for (const groupIndex of citations) bucket.citations.add(groupIndex);
        bucket.items.push({ fragment, saved, hits, citationHits, intervals });
      }
      let bucketIndex = 0;
      for (const bucket of buckets.values()) {
        if ((bucketIndex++ & 255) === 0) { cancelled(options); yield bucketIndex; }
        if (bucket.clauses.size < compiled.clauses.length || bucket.citations.size < (plan.citationScopes || []).length) continue;
        if (branch.highlightMode && !bucket.highlighted) continue;
        if (!(ast.has || []).every(clause => clause.kinds.some(kind => kind === "notes" ? bucket.note : bucket.highlighted))) continue;
        const needsWitnesses = compiled.clauses.length > 1 || (compiled.clauses.length && citationScopes.length);
        const evidence = needsWitnesses ? bucket.items.flatMap(item => item.hits.map(hit => ({ fragment: item.fragment, saved: item.saved, hit }))) : [];
        const bare = !citationScopes.length && !compiled.clauses.length && branch.highlightMode !== "exact";
        for (const item of bare ? bucket.items.slice(0, 1) : bucket.items) {
          const hits = citationScopes.length ? [...new Map(item.citationHits.map(hit => [`${hit.start}:${hit.end}`, hit])).values()]
            : compiled.clauses.length ? item.hits
            : branch.highlightMode === "exact" ? item.intervals.map(range => ({ ...range, match: false }))
            : [{ start: 0, end: Math.min(200, item.fragment.text.length), match: false }];
          if (!hits.length) continue;
          const group = { ...item, hits: [...hits].sort((a, b) => a.start - b.start), bucket, evidence, settings, resultKind: branch.kind, highlightMode: branch.highlightMode };
          if (!mergeBranches) { selectedGroups.push(group); continue; }
          for (const hit of group.hits) {
            const identity = sourceHit(item.fragment, hit, mappings);
            const key = `${item.fragment.id}:${identity.start}:${identity.end}`;
            if (!selectedRows.has(key)) selectedRows.set(key, { ...group, hits: [hit] });
          }
        }
      }
    }
    // Keep matching positions grouped by fragment. Large result sets need counts
    // and hierarchy totals now; individual UI rows are allocated only on demand.
    const all = (mergeBranches ? [...selectedRows.values()] : selectedGroups).sort((a, b) => a.fragment.sourceOrder - b.fragment.sourceOrder || sourceHit(a.fragment, a.hits[0], mappings).start - sourceHit(b.fragment, b.hits[0], mappings).start);
    return materializedResult(projection, all, getHighlights, mappings, scanned);
  }
  function materializedResult(projection, all, getHighlights, mappings, stats) {
    const sectionMap = new Map(), hierarchy = new Map();
    let totalOccurrences = 0;
    for (const item of all) {
      const count = item.hits.length;
      totalOccurrences += count;
      const fragment = item.fragment, branch = item.bucket.hierarchyIds || fragment.hierarchyIds;
      const id = `${fragment.authority}:${fragment.recordId}:${branch.at(-1)}`;
      let section = sectionMap.get(id);
      if (!section) {
        section = { id, authority: fragment.authority, recordId: fragment.recordId, recordKind: fragment.recordKind, hierarchyId: branch.at(-1), hierarchyIds: branch, citation: item.bucket.sectionCitation, heading: fragment.heading, firstSourceOrder: fragment.sourceOrder, totalOccurrences: 0, entries: [] };
        sectionMap.set(id, section);
      }
      section.entries.push(item); section.totalOccurrences += count;
      for (const hierarchyId of branch) {
        const node = projection.hierarchyById.get(hierarchyId);
        if (!node) continue;
        const entry = hierarchy.get(hierarchyId) || { ...node, totalOccurrences: 0 };
        entry.totalOccurrences += count; hierarchy.set(hierarchyId, entry);
      }
    }
    const sections = [...sectionMap.values()];
    return {
      sections: sections.map(({ entries, ...section }) => section), hierarchy: [...hierarchy.values()], totalOccurrences, stats,
      materializeOccurrences({ sectionId, start = 0, limit = 80, contextCharacters = 90 } = {}) {
        const highlights = getHighlights();
        const source = sectionId ? sectionMap.get(sectionId)?.entries || [] : all;
        const total = sectionId ? sectionMap.get(sectionId)?.totalOccurrences || 0 : totalOccurrences;
        const page = [];
        let offset = 0;
        for (const group of source) {
          const end = offset + group.hits.length;
          if (end > start) for (const hit of group.hits.slice(Math.max(0, start - offset), Math.max(0, Math.min(group.hits.length, start + limit - offset)))) page.push({ ...group, hit });
          offset = end;
          if (offset >= start + limit) break;
        }
        const rows = page.map(item => {
          const { fragment, bucket, settings } = item, hit = sourceHit(fragment, item.hit, mappings);
          if (item.highlightMode === "exact") hit.clip = mergeIntervals(item.saved).find(range => range.start <= hit.start && range.end >= hit.end);
          const snippet = hit.selectedText ? { start: hit.start, end: hit.end, matchStart: hit.start, matchEnd: hit.end, parts: [{ text: hit.selectedText, match: true, highlightColor: item.saved[0]?.color }] } : makeSnippet(fragment, hit, highlights.get(fragment.id) || [], contextCharacters);
          const evidence = item.evidence.filter(e => e.fragment.id !== fragment.id || e.hit.start !== item.hit.start || e.hit.end !== item.hit.end);
          // One witness for each distinct condition, with its actual source location.
          const witnesses = [], covered = new Set(hit.clauses || []);
          for (const e of evidence) {
            if (!(e.hit.clauses || []).some(clause => !covered.has(clause))) continue;
            (e.hit.clauses || []).forEach(clause => covered.add(clause));
            if (item.highlightMode === "exact") e.hit.clip = mergeIntervals(e.saved).find(range => range.start <= e.hit.start && range.end >= e.hit.end);
            witnesses.push(e);
          }
          const target = { ...fragment.source };
          return {
            id: `${fragment.id}:${hit.start}:${hit.end}`, authority: fragment.authority, recordId: fragment.recordId, recordKind: fragment.recordKind,
            citation: occurrence.citationForFragment(fragment, fragment.path, settings), readerCommand: occurrence.readerCommandForFragment(fragment, settings),
            path: fragment.path, kind: fragment.kind, contentKind: fragment.contentKind, annotationHeading: fragment.annotationHeading,
            occurrenceKey: bucket.occurrenceKey, target, snippet,
            snippets: [snippet, ...witnesses.map(e => makeSnippet(e.fragment, sourceHit(e.fragment, e.hit, mappings), highlights.get(e.fragment.id) || [], Math.max(20, contextCharacters / 2)))],
            evidence: witnesses.map(e => ({ citation: e.fragment.citation, path: e.fragment.path, target: e.fragment.source }))
          };
        });
        return { rows, total, start, returned: rows.length };
      }
    };
  }
  function search(projection, ast, options) {
    const iterator = evaluate(projection, ast, options); let step;
    do { step = iterator.next(); } while (!step.done);
    return step.value;
  }
  async function searchAsync(projection, ast, options = {}) {
    const iterator = evaluate(projection, ast, options); let step, slice = Date.now();
    do {
      step = iterator.next();
      if (!step.done && Date.now() - slice > (options.sliceMs || 8)) { await new Promise(resolve => setTimeout(resolve, 0)); cancelled(options); slice = Date.now(); }
    } while (!step.done);
    return step.value;
  }
  return Object.freeze({ search, searchAsync, scopeMatches, scopePaths, intersectScopePaths, referenceMatches, resolveHighlights, previewText });
});
