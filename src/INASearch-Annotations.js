/* Pure data helpers for INASearch notes and highlights. */
(function installINASearchAnnotations(factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.INA_SEARCH_ANNOTATIONS = api;
})(function createINASearchAnnotations() {
  "use strict";

  const PROFILE_SCHEMA_VERSION = 5;
  const REFERENCE_PARSER_VERSION = 3;
  const HIGHLIGHT_COLORS = Object.freeze(["yellow", "pink", "orange", "lime", "cyan", "violet"]);
  const DEFAULT_HIGHLIGHT_COLOR = "yellow";

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const text = value => String(value ?? "");
  const normalizedText = value => text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = value => [...new Set(normalizedText(value).split(/\s+/).filter(Boolean))];

  function hashText(value) {
    let hash = 2166136261;
    for (const character of text(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function highlightColor(value, fallback = DEFAULT_HIGHLIGHT_COLOR) {
    return HIGHLIGHT_COLORS.includes(value) ? value : fallback;
  }

  function normalizeAssociation(value) {
    if (!value || typeof value !== "object") return null;
    const association = clone(value);
    delete association.placement;
    delete association.titleText;
    return association;
  }

  function normalizeReferenceRoot(value, noteText = "") {
    const spans = Array.isArray(value?.spans) ? value.spans.filter(span =>
      Number.isInteger(span?.start) && Number.isInteger(span?.end) && span.start >= 0 && span.end > span.start && span.end <= noteText.length && span.citation
    ).map(span => ({ start: span.start, end: span.end, raw: text(span.raw || noteText.slice(span.start, span.end)), citation: text(span.citation), targetKey: text(span.targetKey || span.citation) })) : [];
    return {
      parserVersion: Number.isInteger(Number(value?.parserVersion)) ? Number(value.parserVersion) : 0,
      textHash: text(value?.textHash),
      spans
    };
  }

  function normalizeNote(value, options = {}) {
    const now = options.now || new Date().toISOString();
    const noteText = text(value?.text);
    const associations = (Array.isArray(value?.associations) ? value.associations : []).map(normalizeAssociation).filter(Boolean);
    const normalized = {
      id: text(value?.id || options.makeId?.("note") || `note-${Date.now()}`),
      text: noteText,
      associations,
      textReferences: normalizeReferenceRoot(value?.textReferences, noteText),
      createdAt: text(value?.createdAt || now),
      updatedAt: text(value?.updatedAt || value?.createdAt || now)
    };
    return normalized;
  }

  function normalizeAnchor(value = {}) {
    return {
      sourceHostKey: text(value.sourceHostKey),
      structureRevision: Number(value.structureRevision) || 0,
      sourceField: text(value.sourceField || "text"),
      path: Array.isArray(value.path) ? value.path.map(text) : [],
      start: Math.max(0, Number(value.start) || 0),
      end: Math.max(0, Number(value.end) || 0),
      sourceLength: Math.max(0, Number(value.sourceLength) || 0),
      exact: text(value.exact),
      prefix: text(value.prefix).slice(-80),
      suffix: text(value.suffix).slice(0, 80),
      fingerprint: text(value.fingerprint || hashText(`${value.sourceHostKey || ""}\u0000${value.sourceField || "text"}\u0000${value.exact || ""}`)),
      status: value.status === "needs-review" ? "needs-review" : "active"
    };
  }

  function normalizeSegment(value, index = 0) {
    if (!value || typeof value !== "object") return null;
    return {
      id: text(value.id || `segment-${index + 1}`),
      association: value.association ? normalizeAssociation(value.association, index) : null,
      citation: text(value.citation || value.association?.label),
      ordinal: Math.max(1, Number(value.ordinal) || index + 1),
      aliases: Array.isArray(value.aliases) ? [...new Set(value.aliases.map(text).filter(Boolean))] : [],
      citedTargets: Array.isArray(value.citedTargets) ? [...new Set(value.citedTargets.map(text).filter(Boolean))] : [],
      anchor: normalizeAnchor(value.anchor || value)
    };
  }

  function normalizeHighlight(value, options = {}) {
    const now = options.now || new Date().toISOString();
    return {
      id: text(value?.id || options.makeId?.("highlight") || `highlight-${Date.now()}`),
      color: highlightColor(value?.color),
      segments: (Array.isArray(value?.segments) ? value.segments : []).map(normalizeSegment).filter(Boolean),
      createdAt: text(value?.createdAt || now),
      updatedAt: text(value?.updatedAt || value?.createdAt || now)
    };
  }

  function normalizeProfile(value, options = {}) {
    const profile = clone(value || {});
    profile.schemaVersion = PROFILE_SCHEMA_VERSION;
    profile.notes = (Array.isArray(profile.notes) ? profile.notes : []).map(note => normalizeNote(note, options));
    profile.highlights = (Array.isArray(profile.highlights) ? profile.highlights : []).map(highlight => normalizeHighlight(highlight, options));
    profile.preferences ||= {};
    delete profile.preferences.noteDisplayPosition;
    profile.preferences.notesUseHandwrittenFont = profile.preferences.notesUseHandwrittenFont === true;
    delete profile.preferences.lastNoteColor;
    delete profile.preferences.notesUseRuleFont;
    profile.annotationOrdinals = profile.annotationOrdinals && typeof profile.annotationOrdinals === "object" ? profile.annotationOrdinals : {};
    return profile;
  }

  function compactReferenceCandidate(raw) {
    const match = text(raw).match(/^(\d{3})([a-z0-9]+)$/i);
    if (!match || !/[a-z]/i.test(match[2]) || !/\d/.test(match[2])) return null;
    const path = match[2].match(/[a-z]+|\d+/gi) || [];
    if (!path.length || path.join("").toLowerCase() !== match[2].toLowerCase()) return null;
    return `INA ${match[1]}${path.map(token => `(${token})`).join("")}`;
  }

  function detectReferences(value, resolver) {
    const input = text(value);
    const candidates = [], patterns = [
      /\bINA\s+\d{3}[a-z]?(?:\s*\([a-z0-9-]+\))*/gi,
      /\b\d+\s+U\.?\s*S\.?\s*C\.?\s*(?:§+\s*)?\d+[a-z]?(?:\s*\([a-z0-9-]+\))*/gi,
      /\b\d+\s+C\.?\s*F\.?\s*R\.?\s*(?:§+\s*)?(?:Part\s+)?\d+(?:\.\d+)?(?:\s*\([a-z0-9-]+\))*/gi,
      /\b\d{3}[a-z0-9]+\b/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(input))) {
        const query = pattern === patterns.at(-1) ? compactReferenceCandidate(match[0]) : match[0];
        if (!query) continue;
        let resolved = null;
        try { resolved = typeof resolver === "function" ? resolver(query) : null; } catch {}
        if (!resolved || resolved.valid === false || resolved.ambiguous === true) continue;
        const citation = text(resolved.label || resolved.citation || query);
        candidates.push({ start: match.index, end: match.index + match[0].length, raw: match[0], citation, targetKey: text(resolved.targetKey || citation) });
      }
    }
    candidates.sort((left, right) => left.start - right.start || right.end - left.end);
    const spans = [];
    for (const candidate of candidates) {
      if (spans.some(span => candidate.start < span.end && candidate.end > span.start)) continue;
      spans.push(candidate);
    }
    return { parserVersion: REFERENCE_PARSER_VERSION, textHash: hashText(input), spans };
  }

  function quoteAnchor(source, start, end, metadata = {}) {
    const input = text(source);
    const safeStart = Math.max(0, Math.min(input.length, Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.min(input.length, Number(end) || 0));
    return normalizeAnchor({
      ...metadata,
      start: safeStart,
      end: safeEnd,
      sourceLength: input.length,
      exact: input.slice(safeStart, safeEnd),
      prefix: input.slice(Math.max(0, safeStart - 80), safeStart),
      suffix: input.slice(safeEnd, safeEnd + 80),
      fingerprint: hashText(input)
    });
  }

  function resolveQuoteAnchor(source, anchor) {
    const input = text(source);
    const normalized = normalizeAnchor(anchor);
    if (normalized.fingerprint === hashText(input) && input.slice(normalized.start, normalized.end) === normalized.exact) return { status: "active", start: normalized.start, end: normalized.end, method: "offset" };
    if (!normalized.exact) return { status: "needs-review" };
    const matches = [];
    let offset = input.indexOf(normalized.exact);
    while (offset >= 0) { matches.push(offset); offset = input.indexOf(normalized.exact, offset + 1); }
    if (!matches.length) return { status: "needs-review" };
    const contextual = matches.filter(candidate => {
      const prefix = input.slice(Math.max(0, candidate - normalized.prefix.length), candidate);
      const suffix = input.slice(candidate + normalized.exact.length, candidate + normalized.exact.length + normalized.suffix.length);
      return (!normalized.prefix || prefix.endsWith(normalized.prefix)) && (!normalized.suffix || suffix.startsWith(normalized.suffix));
    });
    const usable = contextual.length === 1 ? contextual : matches.length === 1 ? matches : [];
    return usable.length === 1 ? { status: "active", start: usable[0], end: usable[0] + normalized.exact.length, method: "quote" } : { status: "needs-review" };
  }

  // Work on quote ranges before rendering marks, so saved ink never nests.
  function editHighlightRanges(highlights, hosts, options = {}) {
    const result = clone(highlights || []), before = JSON.stringify(result);
    const mode = options.mode || "normalize", now = options.now || new Date().toISOString();
    const keyFor = options.associationKey || (association => JSON.stringify(association));
    const order = (a, b) => text(a.highlight.createdAt).localeCompare(text(b.highlight.createdAt)) || text(a.highlight.id).localeCompare(text(b.highlight.id)) || text(a.segment.id).localeCompare(text(b.segment.id));
    const aliases = segment => [...(segment.aliases || []), ...(segment.citation ? [`${segment.citation}.h[${segment.ordinal}]`] : [])];
    for (const host of hosts || []) {
      const entries = [];
      for (const highlight of result) for (const segment of highlight.segments) {
        if (keyFor(segment.association) !== host.key || segment.association?.structureStatus === "needs-review") continue;
        // A host can occur more than once in a reader (for example a CFR run-in).
        if (host.acceptSegment && !host.acceptSegment(segment)) continue;
        const resolved = resolveQuoteAnchor(host.source, segment.anchor);
        if (resolved.status === "active") entries.push({ highlight, segment, start: resolved.start, end: resolved.end });
      }
      const reanchor = (segment, start, end) => {
        segment.anchor = quoteAnchor(host.source, start, end, { ...segment.anchor, sourceHostKey: host.key, status: "active" });
        if (host.targetsForRange) segment.citedTargets = host.targetsForRange(start, end);
      };
      if (mode === "remove") {
        for (const entry of entries) {
          if (!(entry.start < host.end && entry.end > host.start)) continue;
          const remaining = [[entry.start, Math.min(entry.end, host.start)], [Math.max(entry.start, host.end), entry.end]].filter(([start, end]) => end > start);
          const replacements = remaining.map(([start, end], index) => {
            const segment = index ? options.makeSegment(host, quoteAnchor(host.source, start, end, entry.segment.anchor)) : entry.segment;
            reanchor(segment, start, end);
            return segment;
          });
          entry.highlight.segments.splice(entry.highlight.segments.indexOf(entry.segment), 1, ...replacements);
          entry.highlight.updatedAt = now;
        }
        continue;
      }
      const groups = [];
      const sorted = entries.sort((a, b) => a.start - b.start || a.end - b.end);
      if (mode === "add" && host.end > host.start) sorted.push({ start: host.start, end: host.end, selection: true });
      sorted.sort((a, b) => a.start - b.start || a.end - b.end);
      for (const entry of sorted) {
        const group = groups.at(-1);
        if (group && entry.start <= group.end) { group.entries.push(entry); group.end = Math.max(group.end, entry.end); }
        else groups.push({ start: entry.start, end: entry.end, entries: [entry] });
      }
      for (const group of groups) {
        const touched = group.entries.filter(entry => !entry.selection).map(entry => ({ ...entry, highlight: result.find(highlight => highlight.segments.includes(entry.segment)) })).filter(entry => entry.highlight).sort(order);
        const selected = group.entries.some(entry => entry.selection);
        if (!selected && touched.length < 2) continue;
        if (!touched.length) {
          const segment = options.makeSegment(host, quoteAnchor(host.source, group.start, group.end, { sourceHostKey: host.key, path: host.association.start.path }));
          reanchor(segment, group.start, group.end);
          result.push({ id: options.makeId("highlight"), color: DEFAULT_HIGHLIGHT_COLOR, createdAt: now, updatedAt: now, segments: [segment] });
          continue;
        }
        const survivor = touched[0];
        if (touched.length === 1 && survivor.start === group.start && survivor.end === group.end) continue;
        survivor.segment.aliases = [...new Set(touched.flatMap(entry => aliases(entry.segment)))];
        survivor.segment.citedTargets = [...new Set(touched.flatMap(entry => entry.segment.citedTargets || []))];
        reanchor(survivor.segment, group.start, group.end);
        // Other segments of a merged record still belong to that highlight.
        for (const entry of touched.slice(1)) {
          const owner = result.find(highlight => highlight.segments.includes(entry.segment));
          if (!owner) continue;
          owner.segments.splice(owner.segments.indexOf(entry.segment), 1);
          if (owner !== survivor.highlight) {
            survivor.highlight.segments.push(...owner.segments);
            owner.segments = [];
          }
        }
        survivor.highlight.updatedAt = now;
      }
    }
    const filtered = result.filter(highlight => highlight.segments.length);
    return { highlights: filtered, changed: JSON.stringify(filtered) !== before };
  }

  class NoteDraft {
    constructor(note, isNew = false) {
      this.original = isNew ? null : clone(note);
      this.value = clone(note);
      this.isNew = isNew;
    }
    save(now = new Date().toISOString()) {
      return normalizeNote({ ...this.value, updatedAt: now }, { now });
    }
    discard() { return clone(this.original); }
  }

  function layoutCitationBanners(entries, viewportTop) {
    const placed = new Map();
    return entries.map(entry => {
      const stop = Math.max(viewportTop, ...(entry.parentIds || []).map(id => {
        const parent = placed.get(id);
        return parent ? parent.top + parent.height : viewportTop;
      }));
      const compactHeight = Math.min(entry.height, entry.compactHeight ?? entry.height);
      const collapsedBy = Math.min(entry.height - compactHeight, Math.max(0, stop - entry.naturalTop));
      const height = entry.height - collapsedBy;
      const top = Math.min(Math.max(entry.naturalTop, stop), entry.bottom - height);
      const result = { ...entry, height, collapsedBy, top, pinned: entry.naturalTop < stop };
      placed.set(entry.id, result);
      return result;
    });
  }

  class AnnotationIndex {
    constructor(profile, options = {}) {
      this.options = options;
      this.rebuild(profile);
    }

    rebuild(profile) {
      this.notes = new Map();
      this.highlights = new Map();
      this.byCitation = new Map();
      this.byToken = { notes: new Map(), highlights: new Map() };
      this.byCitedTarget = { notes: new Map(), highlights: new Map() };
      this.byHighlightAlias = new Map();
      this.noteEntries = new Map();
      this.highlightEntries = new Map();
      for (const note of profile?.notes || []) this.addNote(note);
      for (const highlight of profile?.highlights || []) this.addHighlight(highlight);
      return this;
    }

    addTo(map, key, value) {
      if (!key) return;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(value);
    }

    removeFrom(map, key, value) {
      if (!key || !map.has(key)) return;
      const values = map.get(key);
      values.delete(value);
      if (!values.size) map.delete(key);
    }

    associationKey(association) {
      return text(this.options.associationKey?.(association) || association?.key || association?.label);
    }

    addNote(note) {
      this.notes.set(note.id, note);
      const entry = {
        tokens: tokens(note.text),
        targets: (note.textReferences?.spans || []).map(reference => text(reference.targetKey || reference.citation)).filter(Boolean),
        associations: (note.associations || []).map(association => this.associationKey(association)).filter(Boolean)
      };
      this.noteEntries.set(note.id, entry);
      for (const token of entry.tokens) this.addTo(this.byToken.notes, token, note.id);
      for (const target of entry.targets) this.addTo(this.byCitedTarget.notes, target, note.id);
      for (const key of entry.associations) this.addTo(this.byCitation, key, `note:${note.id}`);
    }

    removeNote(id) {
      const note = this.notes.get(id), entry = this.noteEntries.get(id);
      if (!note && !entry) return false;
      for (const token of entry?.tokens || tokens(note?.text)) this.removeFrom(this.byToken.notes, token, id);
      for (const target of entry?.targets || []) this.removeFrom(this.byCitedTarget.notes, target, id);
      for (const key of entry?.associations || []) this.removeFrom(this.byCitation, key, `note:${id}`);
      this.notes.delete(id);
      this.noteEntries.delete(id);
      return true;
    }

    updateNote(note) {
      this.removeNote(note.id);
      this.addNote(note);
      return note;
    }

    addHighlight(highlight) {
      this.highlights.set(highlight.id, highlight);
      const entry = { tokens: [], targets: [], associations: [], aliases: [] };
      for (const segment of highlight.segments || []) {
        for (const token of tokens(segment.anchor?.exact)) { entry.tokens.push(token); this.addTo(this.byToken.highlights, token, highlight.id); }
        const key = this.associationKey(segment.association);
        if (key) { entry.associations.push({ key, value: `highlight:${highlight.id}:${segment.id}` }); this.addTo(this.byCitation, key, `highlight:${highlight.id}:${segment.id}`); }
        for (const alias of [segment.citation ? `${segment.citation}.h[${segment.ordinal}]` : "", ...(segment.aliases || [])].filter(Boolean)) {
          const key = normalizedText(alias); entry.aliases.push(key); this.byHighlightAlias.set(key, { highlightId: highlight.id, segmentId: segment.id });
        }
        for (const targetValue of segment.citedTargets || []) { const target = text(targetValue); entry.targets.push(target); this.addTo(this.byCitedTarget.highlights, target, highlight.id); }
      }
      this.highlightEntries.set(highlight.id, entry);
    }

    removeHighlight(id) {
      const highlight = this.highlights.get(id), entry = this.highlightEntries.get(id);
      if (!highlight && !entry) return false;
      for (const token of entry?.tokens || []) this.removeFrom(this.byToken.highlights, token, id);
      for (const association of entry?.associations || []) this.removeFrom(this.byCitation, association.key, association.value);
      for (const alias of entry?.aliases || []) this.byHighlightAlias.delete(alias);
      for (const target of entry?.targets || []) this.removeFrom(this.byCitedTarget.highlights, target, id);
      this.highlights.delete(id);
      this.highlightEntries.delete(id);
      return true;
    }

    updateHighlight(highlight) {
      this.removeHighlight(highlight.id);
      this.addHighlight(highlight);
      return highlight;
    }

    remove(kind, id) {
      if (kind === "notes") this.removeNote(id);
      if (kind === "highlights") this.removeHighlight(id);
      return this;
    }

    snapshot() {
      const sets = map => [...map].map(([key, values]) => [key, [...values]]);
      return { schemaVersion: 1, notes: this.notes.size, highlights: this.highlights.size, byCitation: sets(this.byCitation), noteTokens: sets(this.byToken.notes), highlightTokens: sets(this.byToken.highlights), noteCitations: sets(this.byCitedTarget.notes), highlightCitations: sets(this.byCitedTarget.highlights), highlightAliases: [...this.byHighlightAlias] };
    }

    static hydrate(profile, snapshot, options = {}) {
      if (snapshot?.schemaVersion !== 1 || Number(snapshot.notes) !== (profile?.notes || []).length || Number(snapshot.highlights) !== (profile?.highlights || []).length) return null;
      const index = Object.create(AnnotationIndex.prototype);
      index.options = options;
      index.notes = new Map((profile?.notes || []).map(note => [note.id, note]));
      index.highlights = new Map((profile?.highlights || []).map(highlight => [highlight.id, highlight]));
      const mapSets = values => new Map((values || []).map(([key, ids]) => [key, new Set(ids)]));
      index.byCitation = mapSets(snapshot.byCitation);
      index.byToken = { notes: mapSets(snapshot.noteTokens), highlights: mapSets(snapshot.highlightTokens) };
      index.byCitedTarget = { notes: mapSets(snapshot.noteCitations), highlights: mapSets(snapshot.highlightCitations) };
      index.byHighlightAlias = new Map(snapshot.highlightAliases || []);
      index.noteEntries = new Map();
      index.highlightEntries = new Map();
      for (const note of profile?.notes || []) index.noteEntries.set(note.id, {
        tokens: tokens(note.text),
        targets: (note.textReferences?.spans || []).map(reference => text(reference.targetKey || reference.citation)).filter(Boolean),
        associations: (note.associations || []).map(association => index.associationKey(association)).filter(Boolean)
      });
      for (const highlight of profile?.highlights || []) {
        const entry = { tokens: [], targets: [], associations: [], aliases: [] };
        for (const segment of highlight.segments || []) {
          entry.tokens.push(...tokens(segment.anchor?.exact));
          const key = index.associationKey(segment.association);
          if (key) entry.associations.push({ key, value: `highlight:${highlight.id}:${segment.id}` });
          entry.aliases.push(...[segment.citation ? `${segment.citation}.h[${segment.ordinal}]` : "", ...(segment.aliases || [])].filter(Boolean).map(normalizedText));
          entry.targets.push(...(segment.citedTargets || []).map(text));
        }
        index.highlightEntries.set(highlight.id, entry);
      }
      return index;
    }
  }

  return Object.freeze({
    PROFILE_SCHEMA_VERSION, REFERENCE_PARSER_VERSION, HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT_COLOR,
    normalizedText, tokens, hashText, highlightColor, normalizeAssociation, normalizeNote,
    normalizeHighlight, normalizeProfile, compactReferenceCandidate, detectReferences, quoteAnchor,
    resolveQuoteAnchor, editHighlightRanges, NoteDraft, layoutCitationBanners, AnnotationIndex
  });
});
