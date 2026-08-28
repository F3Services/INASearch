(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INA_SEARCH_INSERTIONS = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_RECORDS = 5000;
  const HOST_KINDS = new Set(["usc", "cfr"]);
  const RECORD_KINDS = new Set([
    "section-heading", "section-preamble", "node-heading", "node-text", "run-in",
    "cfr-heading", "cfr-unit", "cfr-table-cell", "cfr-note", "cfr-footnote"
  ]);
  const RECORD_FIELDS = new Set(["heading", "preamble", "text", "x", "cell"]);

  function cleanToken(value) {
    return String(value == null ? "" : value).trim().slice(0, 160);
  }

  function cleanPath(value) {
    return (Array.isArray(value) ? value : []).slice(0, 16).map(cleanToken).filter(Boolean);
  }

  function normalizedIdentityToken(value) {
    return cleanToken(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
  }

  function stableHash(value) {
    const input = String(value || "");
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index++) {
      const code = input.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 0x01000193) >>> 0;
      second ^= code + index;
      second = Math.imul(second, 0x85ebca6b) >>> 0;
    }
    return `${first.toString(36).padStart(7, "0")}${second.toString(36).padStart(7, "0")}`;
  }

  function textFingerprint(value) {
    const normalized = String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    return normalized ? `fp1:${stableHash(normalized)}` : "";
  }

  function addressedTextRanges(textLength, units = [], requestedPath = []) {
    const length = Math.max(0, Number.isFinite(Number(textLength)) ? Math.floor(Number(textLength)) : 0);
    if (!length) return [];
    const target = cleanPath(requestedPath).map(normalizedIdentityToken);
    if (!target.length) return [{ start: 0, end: length }];
    const normalizedUnits = (Array.isArray(units) ? units : []).map(unit => ({
      path: cleanPath(unit?.path).map(normalizedIdentityToken),
      start: Number(unit?.start),
      end: Number(unit?.end)
    })).filter(unit => unit.path.length && Number.isInteger(unit.start) && Number.isInteger(unit.end) && unit.start >= 0 && unit.end > unit.start && unit.end <= length)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const ranges = [];
    for (let index = 0; index < normalizedUnits.length; index++) {
      const unit = normalizedUnits[index];
      if (target.length > unit.path.length || !target.every((token, pathIndex) => token === unit.path[pathIndex])) continue;
      const end = normalizedUnits[index + 1]?.start ?? length;
      if (end <= unit.start) continue;
      const previous = ranges.at(-1);
      if (previous?.end === unit.start) previous.end = end;
      else ranges.push({ start: unit.start, end });
    }
    return ranges;
  }

  function normalizeStatuteIdentity(value, resolveInaSection) {
    const requestedKind = normalizedIdentityToken(value?.kind);
    let kind = requestedKind;
    let section = cleanToken(value?.section);
    if (kind === "ina") {
      section = cleanToken(typeof resolveInaSection === "function" ? resolveInaSection(section) : value?.uscSection);
      kind = section ? "usc" : "";
    }
    if (!HOST_KINDS.has(kind)) kind = "";
    const requestedTitle = Number(value?.title);
    return {
      kind,
      title: kind === "cfr" && Number.isInteger(requestedTitle) && requestedTitle > 0 && requestedTitle <= 999 ? requestedTitle : kind === "usc" ? 8 : 0,
      section,
      path: cleanPath(value?.path)
    };
  }

  function normalizeReferenceInsertionRecord(value, options = {}) {
    if (!value || typeof value !== "object") return null;
    const sourceHost = normalizeStatuteIdentity(value.sourceHost, options.resolveInaSection);
    const target = normalizeStatuteIdentity(value.target, options.resolveInaSection);
    const source = value.sourceRecord && typeof value.sourceRecord === "object" ? value.sourceRecord : {};
    const recordKind = normalizedIdentityToken(source.kind);
    const field = normalizedIdentityToken(source.field);
    const start = Number(source.start);
    const end = Number(source.end);
    const ordinal = Number(source.ordinal);
    const fingerprint = cleanToken(source.textFingerprint);
    if (!HOST_KINDS.has(sourceHost.kind) || !HOST_KINDS.has(target.kind) || !sourceHost.title || !target.title || !sourceHost.section || !target.section) return null;
    if (!RECORD_KINDS.has(recordKind) || !RECORD_FIELDS.has(field)) return null;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start || end > 10_000_000) return null;
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1_000_000 || !/^fp1:[a-z0-9]{8,32}$/i.test(fingerprint)) return null;
    const normalized = {
      key: "",
      sourceHost,
      sourceRecord: {
        kind: recordKind,
        recordPath: cleanPath(source.recordPath),
        field,
        start,
        end,
        ordinal,
        textFingerprint: fingerprint.toLocaleLowerCase()
      },
      target
    };
    normalized.key = referenceInsertionKey(normalized);
    return normalized;
  }

  function canonicalRecordIdentity(record) {
    const host = record.sourceHost;
    const source = record.sourceRecord;
    const target = record.target;
    const pathKey = path => path.map(normalizedIdentityToken).join("/");
    return [
      host.kind, host.title, normalizedIdentityToken(host.section), pathKey(host.path),
      source.kind, pathKey(source.recordPath), source.field, source.start, source.end,
      source.ordinal, source.textFingerprint,
      target.kind, target.title, normalizedIdentityToken(target.section), pathKey(target.path)
    ].join("\u001f");
  }

  function referenceInsertionKey(record) {
    return `refins1:${stableHash(canonicalRecordIdentity(record))}`;
  }

  function normalizeReferenceInsertionRecords(value, options = {}) {
    const source = Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];
    const records = [];
    const seen = new Set();
    const requestedCap = options.cap === undefined ? MAX_RECORDS : Number(options.cap);
    const cap = Math.min(MAX_RECORDS, Math.max(0, Number.isFinite(requestedCap) ? Math.floor(requestedCap) : MAX_RECORDS));
    if (!cap) return records;
    for (const candidate of source) {
      const record = normalizeReferenceInsertionRecord(candidate, options);
      if (!record || seen.has(record.key)) continue;
      seen.add(record.key);
      records.push(record);
      if (records.length >= cap) break;
    }
    return records;
  }

  function normalizeReferenceInsertionsRoot(value, options = {}) {
    return { schemaVersion: SCHEMA_VERSION, records: normalizeReferenceInsertionRecords(value, options) };
  }

  function sourceHostKey(host) {
    const normalized = normalizeStatuteIdentity(host);
    return `${normalized.kind}:${normalized.title}:${normalizedIdentityToken(normalized.section)}:${normalized.path.map(normalizedIdentityToken).join("/")}`;
  }

  function compareRecordPaths(left = [], right = []) {
    const leftPath = cleanPath(left);
    const rightPath = cleanPath(right);
    const length = Math.max(leftPath.length, rightPath.length);
    for (let index = 0; index < length; index++) {
      if (index >= leftPath.length) return -1;
      if (index >= rightPath.length) return 1;
      const leftToken = leftPath[index];
      const rightToken = rightPath[index];
      const leftNumber = /^\d+$/.test(leftToken) ? Number(leftToken) : NaN;
      const rightNumber = /^\d+$/.test(rightToken) ? Number(rightToken) : NaN;
      const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : normalizedIdentityToken(leftToken).localeCompare(normalizedIdentityToken(rightToken), undefined, { numeric: true });
      if (comparison) return comparison;
    }
    return 0;
  }

  const SOURCE_KIND_ORDER = new Map([
    ["section-heading", 0], ["section-preamble", 1],
    ["node-heading", 0], ["node-text", 1], ["run-in", 1],
    ["cfr-heading", 0], ["cfr-unit", 1], ["cfr-table-cell", 1], ["cfr-note", 1], ["cfr-footnote", 2]
  ]);

  function compareSourceOrder(left, right) {
    return compareRecordPaths(left.sourceRecord.recordPath, right.sourceRecord.recordPath)
      || (SOURCE_KIND_ORDER.get(left.sourceRecord.kind) ?? 10) - (SOURCE_KIND_ORDER.get(right.sourceRecord.kind) ?? 10)
      || left.sourceRecord.ordinal - right.sourceRecord.ordinal
      || left.sourceRecord.start - right.sourceRecord.start
      || left.sourceRecord.end - right.sourceRecord.end
      || left.key.localeCompare(right.key);
  }

  class ReferenceInsertionSession {
    constructor(records = [], options = {}) {
      this.options = options;
      this.records = new Map();
      this.dormant = new Set();
      this.expanded = new Set();
      this.revision = 0;
      for (const record of normalizeReferenceInsertionRecords(records, options)) this.records.set(record.key, record);
    }

    get size() { return this.records.size; }
    get unavailableCount() { return this.dormant.size; }

    has(key) { return this.records.has(String(key || "")); }
    get(key) { return this.records.get(String(key || "")) || null; }

    upsert(value) {
      const record = normalizeReferenceInsertionRecord(value, this.options);
      if (!record) return { changed: false, record: null };
      const existing = this.records.get(record.key) || null;
      if (existing) return { changed: false, record: existing };
      this.records.set(record.key, record);
      this.dormant.delete(record.key);
      this.revision++;
      return { changed: true, record };
    }

    remove(key) {
      const normalizedKey = String(key || "");
      if (!this.records.delete(normalizedKey)) return false;
      this.dormant.delete(normalizedKey);
      this.expanded.delete(normalizedKey);
      this.revision++;
      return true;
    }

    markDormant(key, dormant = true) {
      const normalizedKey = String(key || "");
      if (!this.records.has(normalizedKey)) return false;
      const before = this.dormant.has(normalizedKey);
      if (dormant) this.dormant.add(normalizedKey);
      else this.dormant.delete(normalizedKey);
      return before !== dormant;
    }

    removeUnavailable() {
      let removed = 0;
      for (const key of [...this.dormant]) if (this.remove(key)) removed++;
      return removed;
    }

    toggleExpanded(key) {
      const normalizedKey = String(key || "");
      if (!this.records.has(normalizedKey)) return false;
      if (this.expanded.has(normalizedKey)) this.expanded.delete(normalizedKey);
      else this.expanded.add(normalizedKey);
      return this.expanded.has(normalizedKey);
    }

    recordsForHost(host) {
      const key = sourceHostKey(host);
      return [...this.records.values()].filter(record => sourceHostKey(record.sourceHost) === key && !this.dormant.has(record.key)).sort(compareSourceOrder);
    }

    snapshot() {
      return [...this.records.values()].sort((left, right) => sourceHostKey(left.sourceHost).localeCompare(sourceHostKey(right.sourceHost)) || compareSourceOrder(left, right));
    }
  }

  function mergeReferenceInsertionRecords(left, right, enabled, options = {}) {
    if (!enabled) return [];
    return normalizeReferenceInsertionRecords([...(Array.isArray(left) ? left : left?.records || []), ...(Array.isArray(right) ? right : right?.records || [])], options);
  }

  function persistenceTransition(session, enabled) {
    return {
      schemaVersion: SCHEMA_VERSION,
      records: enabled && session instanceof ReferenceInsertionSession ? session.snapshot().slice(0, MAX_RECORDS) : []
    };
  }

  function resolveInsertionRecord(record, candidates = []) {
    const normalized = normalizeReferenceInsertionRecord(record);
    if (!normalized) return { status: "dormant", record: null, candidate: null };
    const normalizedCandidates = normalizeReferenceInsertionRecords(candidates);
    const sameHost = candidate => sourceHostKey(candidate?.sourceHost) === sourceHostKey(normalized.sourceHost);
    const sameTarget = candidate => {
      const target = normalizeStatuteIdentity(candidate?.target);
      return target.kind === normalized.target.kind && target.title === normalized.target.title
        && normalizedIdentityToken(target.section) === normalizedIdentityToken(normalized.target.section)
        && target.path.map(normalizedIdentityToken).join("/") === normalized.target.path.map(normalizedIdentityToken).join("/");
    };
    const sameRecord = candidate => candidate?.sourceRecord?.kind === normalized.sourceRecord.kind
      && cleanPath(candidate.sourceRecord.recordPath).map(normalizedIdentityToken).join("/") === normalized.sourceRecord.recordPath.map(normalizedIdentityToken).join("/")
      && candidate.sourceRecord.field === normalized.sourceRecord.field;
    const exact = normalizedCandidates.find(candidate => sameHost(candidate) && sameTarget(candidate)
      && sameRecord(candidate)
      && Number(candidate.sourceRecord.start) === normalized.sourceRecord.start
      && Number(candidate.sourceRecord.end) === normalized.sourceRecord.end
      && candidate.sourceRecord.textFingerprint === normalized.sourceRecord.textFingerprint);
    if (exact) return { status: "exact", record: normalized, candidate: exact };
    const nearest = normalizedCandidates.filter(candidate => sameHost(candidate) && sameTarget(candidate) && sameRecord(candidate)
      && candidate.sourceRecord.textFingerprint === normalized.sourceRecord.textFingerprint)
      .sort((left, right) => Math.abs(left.sourceRecord.start - normalized.sourceRecord.start) - Math.abs(right.sourceRecord.start - normalized.sourceRecord.start));
    if (nearest.length) return { status: "nearest", record: normalized, candidate: nearest[0] };
    const unit = normalizedCandidates.filter(candidate => sameHost(candidate) && sameTarget(candidate));
    return unit.length === 1 ? { status: "unique-unit", record: normalized, candidate: unit[0] } : { status: "dormant", record: normalized, candidate: null };
  }

  return {
    SCHEMA_VERSION,
    MAX_RECORDS,
    ReferenceInsertionSession,
    addressedTextRanges,
    cleanPath,
    compareSourceOrder,
    mergeReferenceInsertionRecords,
    normalizeReferenceInsertionRecord,
    normalizeReferenceInsertionRecords,
    normalizeReferenceInsertionsRoot,
    normalizeStatuteIdentity,
    persistenceTransition,
    referenceInsertionKey,
    resolveInsertionRecord,
    sourceHostKey,
    stableHash,
    textFingerprint
  };
});
