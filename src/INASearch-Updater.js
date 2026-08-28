/* Direct-authority background corpus maintenance for the standalone INASearch build. */
(() => {
  "use strict";

  const ECFR_ORIGIN = "https://www.ecfr.gov";
  const TITLES_URL = `${ECFR_ORIGIN}/api/versioner/v1/titles.json`;
  const STATUS_KEY = "ecfr-maintenance-status-v2";
  const LAST_CHECK_KEY = "ecfr-last-check-v2";
  const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const START_DELAY_MS = 900;
  const MAX_RETRIES = 3;
  const REQUEST_TIMEOUT_MS = 30_000;
  const FETCH_CONCURRENCY = 3;
  const TEXT_BLOCK_TAGS = new Set(["P", "P2", "FP", "FP-1", "FP-2", "FP-DASH", "LI", "PSPACE", "CITA", "FR", "FRP", "SECAUTH", "PARAUTH", "XREF", "CROSSREF", "APPRO"]);
  const HEADING_TAGS = new Set(["HED", "HD1", "HD2", "HD3", "HD4"]);
  const CONTAINER_TAGS = new Set(["DIV", "EXTRACT", "EXAMPLE", "SCOL2", "NOTE", "EDNOTE", "EFFDNOT", "AUTH", "SOURCE"]);
  const NOTE_TYPES = Object.freeze({ NOTE: "ordinary", EDNOTE: "editorial", EFFDNOT: "effective-date" });
  const TABLE_CONTAINER_TAGS = new Set(["THEAD", "TBODY", "TFOOT"]);
  const INLINE_STYLES = Object.freeze({ I: "i", E: "b", B: "b", strong: "b", SU: "sup", sup: "sup", SUB: "sub" });
  const IGNORED_EMPTY_TAGS = new Set(["PRTPAGE", "HALFDASH", "BR", "HR", "FTREF"]);
  const CFR_MARKER_RE = /\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\)/g;
  const CFR_LEADING_MARKERS_RE = /^\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)/;
  const CFR_LEADING_RANGE_RE = /^\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))\s*[-–—]\s*(\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\))/;
  const CFR_MATCH_EQUIVALENTS = Object.freeze({ "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-", "“": '"', "”": '"', "‘": "'", "’": "'", "⁄": "/", "\u00ad": "" });

  const nowIso = () => new Date().toISOString();
  const cleanText = value => String(value || "").replace(/\s+/g, " ").trim();
  const flattened = element => cleanText(element?.textContent || "");
  const directChild = (element, name) => [...(element?.children || [])].find(child => child.tagName === name) || null;
  const childText = (element, name) => cleanText(directChild(element, name)?.textContent || "");
  const abortFailure = () => Object.assign(new Error("Automatic CFR updates are off."), { name: "AbortError" });
  const throwIfAborted = signal => { if (signal?.aborted) throw abortFailure(); };
  const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortFailure()); };
    function cleanup() { signal?.removeEventListener?.("abort", abort); }
    function done() { cleanup(); resolve(); }
    signal?.addEventListener?.("abort", abort, { once: true });
  });

  function dayAfter(date) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  function metadataCouldContainChanges(record, snapshot) {
    const latest = [record?.latest_issue_date, record?.latest_amended_on].filter(Boolean).sort().at(-1);
    return !latest || latest > snapshot;
  }

  function report(status, onStatus) {
    const value = Object.freeze({ schemaVersion: 1, authority: ECFR_ORIGIN, privacyMode: "fixed-corpus-coverage", ...status });
    globalThis.INA_SEARCH_UPDATE_STATUS = value;
    try { onStatus?.(value); } catch {}
    globalThis.INASearchStorage?.setMetadata(STATUS_KEY, value).catch(() => {});
    return value;
  }

  async function fetchAuthority(url, accept, metrics, signal) {
    if (!String(url).startsWith(`${ECFR_ORIGIN}/api/`)) throw new Error("An update request did not target the approved eCFR API origin.");
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      const controller = new AbortController();
      const relayAbort = () => controller.abort();
      signal?.addEventListener?.("abort", relayAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const started = performance.now();
      try {
        const response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", headers: { Accept: accept }, signal: controller.signal });
        const text = await response.text();
        metrics.requests += 1;
        metrics.bytes += new TextEncoder().encode(text).byteLength;
        metrics.requestMs += performance.now() - started;
        if (response.ok) return { text, response };
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) throw new Error(`eCFR returned HTTP ${response.status} for ${new URL(url).pathname}.`);
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(500 * (2 ** attempt), 4_000), signal);
      } catch (error) {
        if (signal?.aborted) throw abortFailure();
        lastError = error;
        if (attempt === MAX_RETRIES || !(error?.name === "AbortError" || error instanceof TypeError)) throw error;
        await sleep(Math.min(500 * (2 ** attempt), 4_000), signal);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", relayAbort);
      }
    }
    throw lastError || new Error("The eCFR request failed.");
  }

  async function fetchJson(url, metrics, signal) {
    const { text } = await fetchAuthority(url, "application/json", metrics, signal);
    try { return { value: JSON.parse(text), text }; }
    catch { throw new Error(`eCFR returned malformed JSON for ${new URL(url).pathname}.`); }
  }

  const paragraphPath = tokens => (tokens || []).map(value => `(${value})`).join("");
  const markerMatches = value => [...String(value || "").matchAll(CFR_MARKER_RE)];

  function canonicalMatchText(value) {
    let result = "";
    for (const character of String(value || "")) {
      const translated = Object.hasOwn(CFR_MATCH_EQUIVALENTS, character) ? CFR_MATCH_EQUIVALENTS[character] : character;
      for (const output of translated) if (!/\s/.test(output)) result += output;
    }
    return result;
  }

  function canonicalMatchMap(value) {
    const text = String(value || ""), characters = [], offsets = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const translated = Object.hasOwn(CFR_MATCH_EQUIVALENTS, character) ? CFR_MATCH_EQUIVALENTS[character] : character;
      for (const output of translated) {
        if (/\s/.test(output)) continue;
        characters.push(output);
        offsets.push(index);
      }
    }
    return { text: characters.join(""), offsets };
  }

  function parseEnhancedHtml(raw, { title, part }) {
    if (!(globalThis.DOMParser)) throw new Error("This browser does not provide the HTML parser required for verified eCFR updates.");
    const documentNode = new DOMParser().parseFromString(raw, "text/html");
    const partRoot = documentNode.getElementById(`part-${part}`);
    if (!partRoot) throw new Error(`The enhanced eCFR response did not contain Title ${title} Part ${part}.`);
    const sectionRecords = new Map(), appendices = [];
    const recordNodes = [...partRoot.querySelectorAll("div.section, div.appendix")].filter(node => !node.parentElement?.closest("div.section, div.appendix"));
    for (const recordNode of recordNodes) {
      const kind = recordNode.classList.contains("section") ? "section" : "appendix";
      const record = { kind, id: recordNode.id || "", paragraphs: [] };
      for (const element of recordNode.querySelectorAll("p, h1, h2, h3, h4, h5, h6, table")) {
        if (element.parentElement?.closest("div.section, div.appendix") !== recordNode) continue;
        if (element.closest(".footnote, .footnotes")) continue;
        const tag = element.tagName.toLowerCase();
        if (tag !== "table" && element.closest("table")) continue;
        if (tag === "table" && element.parentElement?.closest("table")) continue;
        const parent = element.closest('div[id^="p-"]');
        const canonicalId = element.id?.startsWith("p-") ? element.id : parent?.id || "";
        let paragraph;
        if (tag === "table") {
          paragraph = { dataTitle: "", canonicalId, addressable: false, term: false, disabled: false, heading: false, indent: 0, elementKind: "table", text: cleanText(element.textContent) };
        } else if (tag === "p") {
          const classes = [...element.classList];
          const indent = Number(classes.map(value => /^(?:indent|flush-paragraph)-(\d+)$/.exec(value)?.[1]).find(Boolean) || 0);
          paragraph = {
            dataTitle: element.getAttribute("data-title") || "", canonicalId,
            addressable: element.hasAttribute("data-title"), term: String(element.getAttribute("data-term") || "").toLowerCase() === "true",
            disabled: String(element.getAttribute("data-disable") || "").toLowerCase() === "true",
            heading: classes.some(value => /^hd\d+-paragraph$/.test(value)), indent, elementKind: "p", text: cleanText(element.textContent)
          };
        } else {
          if (!canonicalId) continue;
          paragraph = { dataTitle: element.getAttribute("data-title") || "", canonicalId, addressable: element.hasAttribute("data-title"), term: false, disabled: false, heading: true, indent: 0, elementKind: "heading", text: cleanText(element.textContent) };
        }
        if (paragraph.text) record.paragraphs.push(paragraph);
      }
      const prefix = `p-${record.id}`;
      for (const paragraph of record.paragraphs) {
        if (paragraph.canonicalId && !paragraph.canonicalId.startsWith(prefix)) throw new Error(`The enhanced eCFR paragraph ${paragraph.dataTitle || paragraph.canonicalId} is outside ${record.id}.`);
        paragraph.path = paragraph.canonicalId ? markerMatches(paragraph.canonicalId.slice(prefix.length)).map(match => match[1]) : [];
        if (!paragraph.addressable && paragraph.path.length) {
          const leading = CFR_LEADING_MARKERS_RE.exec(paragraph.text);
          const visible = leading ? markerMatches(leading[1]).map(match => match[1]) : [];
          const dotted = paragraph.path.at(-1) || "";
          if ((visible.length && paragraph.path.slice(-visible.length).join("\u0000") === visible.join("\u0000")) || (dotted.endsWith(".") && paragraph.text.trimStart().startsWith(dotted))) paragraph.addressable = true;
        }
      }
      if (kind === "section") {
        if (!record.id || sectionRecords.has(record.id)) throw new Error(`The enhanced eCFR response has a duplicate or empty section id ${record.id || "(empty)"}.`);
        sectionRecords.set(record.id, record);
      } else appendices.push(record);
    }
    return { title: Number(title), part: String(part), sections: sectionRecords, appendices };
  }

  class ParagraphOracle {
    constructor(record, label) {
      if (!record) throw new Error(`The enhanced eCFR response has no record for ${label}.`);
      this.entries = record.paragraphs;
      this.index = 0;
      this.currentPath = [];
      this.currentContext = [];
      this.currentDepth = 0;
      this.label = label;
    }

    entryUnits(entry, text, entryStart) {
      if (!entry.addressable || entry.term || entry.disabled) return [];
      const leadingRange = CFR_LEADING_RANGE_RE.exec(entry.text);
      const leading = leadingRange || CFR_LEADING_MARKERS_RE.exec(entry.text);
      if (!leading) {
        const token = entry.path.at(-1) || "";
        const renderedStart = entry.text.length - entry.text.trimStart().length;
        const sourceStart = entryStart + text.slice(entryStart).length - text.slice(entryStart).trimStart().length;
        if (token.endsWith(".") && entry.text.startsWith(token, renderedStart) && text.startsWith(token, sourceStart)) return [{ a: paragraphPath(entry.path), s: sourceStart, e: sourceStart + token.length }];
        throw new Error(`Rendered ${this.label} paragraph ${entry.dataTitle || entry.canonicalId} lacks a recognized visible marker.`);
      }
      const sourceLeading = (leadingRange ? CFR_LEADING_RANGE_RE : CFR_LEADING_MARKERS_RE).exec(text.slice(entryStart));
      if (!sourceLeading) throw new Error(`XML text for rendered ${entry.dataTitle || entry.canonicalId} does not expose its marker at offset ${entryStart}.`);
      if (leadingRange) {
        const firstToken = leadingRange[2], lastToken = leadingRange[4];
        if (!entry.path.length || entry.path.at(-1) !== firstToken) throw new Error(`Rendered range ${entry.dataTitle || entry.canonicalId} disagrees with its first marker ${firstToken}.`);
        const firstStart = entryStart + sourceLeading[0].indexOf(sourceLeading[1]);
        const lastStart = entryStart + sourceLeading[0].lastIndexOf(sourceLeading[3]);
        return [
          { a: paragraphPath(entry.path), s: firstStart, e: firstStart + sourceLeading[1].length },
          { a: paragraphPath([...entry.path.slice(0, -1), lastToken]), s: lastStart, e: lastStart + sourceLeading[3].length }
        ];
      }
      const visibleTokens = markerMatches(leading[1]).map(match => match[1]);
      if (!entry.path.length || visibleTokens.length > entry.path.length || entry.path.slice(-visibleTokens.length).join("\u0000") !== visibleTokens.join("\u0000")) throw new Error(`Rendered path ${entry.dataTitle || entry.canonicalId} disagrees with its visible markers.`);
      const baseLength = entry.path.length - visibleTokens.length;
      const sourceMarkers = markerMatches(sourceLeading[1]).slice(0, visibleTokens.length);
      if (sourceMarkers.length !== visibleTokens.length) throw new Error(`XML text for rendered ${entry.dataTitle || entry.canonicalId} exposes ${sourceMarkers.length} markers, expected ${visibleTokens.length}.`);
      const markerGroupStart = sourceLeading[0].indexOf(sourceLeading[1]);
      return sourceMarkers.map((match, index) => {
        const start = entryStart + markerGroupStart + match.index;
        return { a: paragraphPath(entry.path.slice(0, baseLength + index + 1)), s: start, e: start + match[0].length };
      });
    }

    consume(text) {
      const canonical = canonicalMatchMap(text);
      let searchFrom = 0;
      const units = [], consumedEntries = [];
      const startingIndex = this.index;
      while (this.index < this.entries.length) {
        const entry = this.entries[this.index];
        const expected = canonicalMatchText(entry.text);
        if (!expected) throw new Error(`Rendered ${this.label} paragraph ${entry.dataTitle || entry.canonicalId} has no visible text.`);
        let found = canonical.text.indexOf(expected, searchFrom), consumedLength = expected.length;
        if (found < 0) {
          const probe = canonicalMatchText(entry.text.split(/\[[A-Za-z0-9-]+\]/, 1)[0]);
          if (probe && probe !== expected) { found = canonical.text.indexOf(probe, searchFrom); consumedLength = probe.length; }
        }
        if (found < 0) break;
        const entryStart = canonical.offsets[found];
        const entryUnits = this.entryUnits(entry, text, entryStart);
        units.push(...entryUnits);
        consumedEntries.push({ entry, start: entryStart, units: entryUnits });
        this.index += 1;
        searchFrom = found + consumedLength;
        this.currentDepth = entry.indent || (!entry.addressable ? entry.path.length : 0);
        if (entry.term || entry.disabled) { this.currentPath = []; this.currentContext = []; }
        else if (!entry.addressable) { this.currentPath = []; this.currentContext = [...entry.path]; }
        else if (units.length) { this.currentPath = markerMatches(units.at(-1).a).map(match => match[1]); this.currentContext = [...this.currentPath]; }
      }
      const consumed = this.index !== startingIndex;
      const segments = consumedEntries.map((item, index) => {
        const rawStart = index === 0 ? 0 : item.start;
        const rawEnd = consumedEntries[index + 1]?.start ?? text.length;
        const raw = text.slice(rawStart, rawEnd);
        const start = rawStart + raw.length - raw.trimStart().length;
        const end = rawEnd - (raw.length - raw.trimEnd().length);
        const entryUnits = item.units.filter(unit => start <= unit.s && unit.s < unit.e && unit.e <= end).map(unit => ({ ...unit, s: unit.s - start, e: unit.e - start }));
        const address = item.entry.addressable && !item.entry.term && !item.entry.disabled ? entryUnits.at(-1)?.a || paragraphPath(item.entry.path) : "";
        const context = address || (item.entry.path.length && !item.entry.term && !item.entry.disabled ? paragraphPath(item.entry.path) : "");
        const depth = item.entry.indent || (!item.entry.addressable ? item.entry.path.length : 0);
        return { start, end, a: address, c: context, d: depth, u: entryUnits };
      });
      return { units, path: consumed ? paragraphPath(this.currentPath) : "", depth: consumed ? this.currentDepth : 0, context: consumed ? paragraphPath(this.currentContext) : "", segments };
    }

    consumeNonaddressableWrapper(text) {
      if (this.index >= this.entries.length) return false;
      const entry = this.entries[this.index];
      if (entry.elementKind !== "p" || (entry.addressable && !(entry.term || entry.disabled))) return false;
      const expected = canonicalMatchText(entry.text);
      if (!expected || !canonicalMatchText(text).includes(expected)) return false;
      this.index += 1;
      this.currentDepth = entry.indent;
      this.currentPath = [];
      this.currentContext = !entry.addressable ? [...entry.path] : [];
      return true;
    }

    consumeHeading(text) {
      if (this.index >= this.entries.length) return { units: [], path: "", depth: 0, context: "" };
      const entry = this.entries[this.index];
      if (!entry.heading || canonicalMatchText(entry.text) !== canonicalMatchText(text)) return { units: [], path: "", depth: 0, context: "" };
      this.index += 1;
      this.currentPath = entry.addressable ? [...entry.path] : [];
      this.currentContext = [...entry.path];
      this.currentDepth = entry.indent || entry.path.length;
      const units = [];
      if (entry.addressable && entry.path.length) {
        const token = entry.path.at(-1), start = text.length - text.trimStart().length;
        if (!text.startsWith(token, start)) throw new Error(`Rendered heading path ${entry.dataTitle || entry.canonicalId} is not visible in its XML heading.`);
        units.push({ a: paragraphPath(entry.path), s: start, e: start + token.length });
      }
      return { units, path: paragraphPath(this.currentPath), depth: this.currentDepth, context: paragraphPath(this.currentContext) };
    }

    finish() {
      if (this.index === this.entries.length) return;
      const entry = this.entries[this.index];
      throw new Error(`XML normalization did not consume rendered ${this.label} paragraph ${entry.dataTitle || entry.canonicalId}: ${entry.text.slice(0, 160)}`);
    }
  }

  function inlineRuns(element) {
    const runs = [];
    const add = (text, style) => {
      const value = String(text || "").replace(/\s+/g, " ");
      if (!value) return;
      const item = style ? { x: value, s: style } : { x: value };
      if (runs.length && runs.at(-1).s === item.s) runs.at(-1).x += item.x;
      else runs.push(item);
    };
    const walk = (node, inherited) => {
      if (node.nodeType === 3) { add(node.nodeValue, inherited); return; }
      const style = INLINE_STYLES[node.tagName] || inherited;
      for (const child of node.childNodes || []) walk(child, style);
    };
    walk(element, undefined);
    if (runs.length) {
      runs[0].x = runs[0].x.trimStart();
      runs.at(-1).x = runs.at(-1).x.trimEnd();
      for (let index = 1; index < runs.length; index += 1) {
        if (runs[index].x.startsWith(" ")) runs[index].x = (runs[index - 1].x.endsWith(" ") ? "" : " ") + runs[index].x.trimStart();
      }
    }
    const filtered = runs.filter(run => run.x);
    return filtered.length === 1 && !("s" in filtered[0]) ? [] : filtered;
  }

  function sliceInlineRuns(runs, start, end) {
    if (!runs?.length || end <= start) return [];
    const sliced = [];
    let cursor = 0;
    for (const run of runs) {
      const runStart = cursor, runEnd = cursor + run.x.length;
      cursor = runEnd;
      const overlapStart = Math.max(start, runStart), overlapEnd = Math.min(end, runEnd);
      if (overlapEnd <= overlapStart) continue;
      const item = { x: run.x.slice(overlapStart - runStart, overlapEnd - runStart) };
      if (run.s) item.s = run.s;
      if (sliced.length && sliced.at(-1).s === item.s) sliced.at(-1).x += item.x;
      else sliced.push(item);
    }
    return sliced.length === 1 && !("s" in sliced[0]) ? [] : sliced;
  }

  function tableBlock(element) {
    const rows = [];
    for (const row of element.getElementsByTagName("TR")) {
      const cells = [];
      for (const cell of row.children || []) {
        if (cell.tagName !== "TH" && cell.tagName !== "TD") continue;
        const item = { x: flattened(cell) };
        if (cell.tagName === "TH") item.h = 1;
        if (cell.getAttribute("colspan") && cell.getAttribute("colspan") !== "1") item.c = cell.getAttribute("colspan");
        cells.push(item);
      }
      if (cells.length) rows.push(cells);
    }
    const block = { t: "table", rows };
    const caption = directChild(element, "CAPTION");
    if (flattened(caption)) block.caption = flattened(caption);
    return block;
  }

  function preservedGraphics(cfr) {
    const result = new Map();
    const walk = blocks => {
      for (const block of blocks || []) {
        if (block.t === "graphic" && block.src && block.data) result.set(block.src, { data: block.data, mime: block.mime || "image/gif" });
        if (block.t === "note") walk(block.blocks);
      }
    };
    for (const record of [...(cfr?.sections || []), ...(cfr?.appendices || [])]) walk(record.blocks);
    return result;
  }

  function normalizedBlocks(element, graphics, oracle, defaultDepth = 0, defaultContext = "") {
    const blocks = [];
    for (const child of element.children || []) {
      const tag = child.tagName;
      if (tag === "HEAD") continue;
      if (TEXT_BLOCK_TAGS.has(tag)) {
        const text = flattened(child);
        if (!text) continue;
        const runs = inlineRuns(child);
        const consumed = oracle.consume(text);
        const segments = consumed.segments.length ? consumed.segments : [{ start: 0, end: text.length, a: consumed.path, c: consumed.context, d: consumed.depth, u: consumed.units }];
        for (const segment of segments) {
          const segmentText = text.slice(segment.start, segment.end);
          if (!segmentText) continue;
          const block = { t: "p", x: segmentText };
          if (segment.a) block.a = segment.a;
          if (segment.c && segment.c !== segment.a) block.c = segment.c;
          else if (defaultContext && !segment.a && !segment.c) block.c = defaultContext;
          if (segment.u?.length) block.u = segment.u;
          const displayDepth = segment.d || defaultDepth;
          if (displayDepth && displayDepth !== markerMatches(segment.a).length) block.d = displayDepth;
          const segmentRuns = sliceInlineRuns(runs, segment.start, segment.end);
          if (segmentRuns.length) {
            if (segmentRuns.map(run => run.x).join("") !== segmentText) throw new Error(`Formatting runs do not align after splitting rendered ${oracle.label} at ${segment.start}:${segment.end}.`);
            block.r = segmentRuns;
          }
          if (["CITA", "SECAUTH", "XREF", "CROSSREF"].includes(tag)) block.k = "citation";
          blocks.push(block);
        }
      } else if (HEADING_TAGS.has(tag)) {
        const text = flattened(child);
        if (text) {
          const block = { t: "h", x: text, l: /\d$/.test(tag) ? Number(tag.at(-1)) : 4 };
          const consumed = oracle.consumeHeading(text);
          if (consumed.path) block.a = consumed.path;
          if (consumed.context && consumed.context !== consumed.path) block.c = consumed.context;
          else if (defaultContext && !consumed.path) block.c = defaultContext;
          if (consumed.units.length) block.u = consumed.units;
          if (consumed.depth && consumed.depth !== markerMatches(consumed.path).length) block.d = consumed.depth;
          blocks.push(block);
        }
      } else if (tag === "TABLE") {
        const block = tableBlock(child);
        const consumed = oracle.consume(flattened(child));
        if (consumed.units.length || consumed.path) throw new Error(`Rendered ${oracle.label} table unexpectedly declares an addressable paragraph.`);
        if (consumed.context) block.c = consumed.context;
        const displayDepth = consumed.depth || defaultDepth;
        if (displayDepth) block.d = displayDepth;
        blocks.push(block);
      }
      else if (tag.toLowerCase() === "img") {
        const sourcePath = child.getAttribute("src") || "";
        const preserved = graphics.get(sourcePath);
        const block = { t: "graphic", src: sourcePath, alt: `Official CFR graphic ${sourcePath.split("/").at(-1) || "image"}` };
        if (preserved) Object.assign(block, preserved);
        else block.unavailable = true;
        blocks.push(block);
      } else if (TABLE_CONTAINER_TAGS.has(tag)) blocks.push(...normalizedBlocks(child, graphics, oracle, defaultDepth, defaultContext));
      else if (tag === "FTNT") {
        const text = flattened(child);
        if (text) blocks.push({ t: "footnote", x: text });
      } else if (CONTAINER_TAGS.has(tag)) {
        let nestedDepth = defaultDepth, nestedContext = defaultContext;
        if (tag === "EXAMPLE" && oracle.consumeNonaddressableWrapper(flattened(child))) {
          nestedDepth = oracle.currentDepth;
          nestedContext = paragraphPath(oracle.currentContext);
        }
        const nested = normalizedBlocks(child, graphics, oracle, nestedDepth, nestedContext);
        if (nested.length) blocks.push(...(NOTE_TYPES[tag] ? [{ t: "note", noteType: NOTE_TYPES[tag], blocks: nested }] : nested));
      } else if (tag.startsWith("DIV")) continue;
      else if (IGNORED_EMPTY_TAGS.has(tag) || (!flattened(child) && !child.children.length)) continue;
      else throw new Error(`The current eCFR XML contains an unsupported text element <${tag}>.`);
    }
    return blocks;
  }

  function breadcrumb(element, ancestors) {
    const result = ancestors.map(item => ({ ...item }));
    const head = childText(element, "HEAD");
    if (head) result.push({ type: String(element.getAttribute("TYPE") || "").toLowerCase(), number: element.getAttribute("N") || "", heading: head });
    return result;
  }

  function sourceUrl(title, hierarchy, section = null) {
    let path = `${ECFR_ORIGIN}/current/title-${title}`;
    for (const item of hierarchy) {
      if (["chapter", "subchapter", "part", "subpart", "subject-group"].includes(item.type) && item.number) path += `/${item.type}-${item.number}`;
    }
    return section ? `${path}/section-${section}` : path;
  }

  function normalizeEcfrXml(raw, { title, part: expectedPart = "", rendererHtml, mappings = [], graphics = new Map() }) {
    if (!(globalThis.DOMParser)) throw new Error("This browser does not provide the XML parser required for eCFR updates.");
    if (!rendererHtml) throw new Error("A same-date enhanced eCFR rendering is required to verify paragraph hierarchy.");
    const renderedPart = parseEnhancedHtml(rendererHtml, { title: Number(title), part: String(expectedPart) });
    const documentNode = new DOMParser().parseFromString(raw, "application/xml");
    const parserError = documentNode.getElementsByTagName("parsererror")[0];
    if (parserError) throw new Error(`The current eCFR XML could not be parsed: ${cleanText(parserError.textContent).slice(0, 180)}`);
    const root = documentNode.documentElement;
    if (!root?.tagName?.startsWith("DIV")) throw new Error("The current eCFR response did not contain the expected regulatory XML root.");
    const parts = [], sections = [], appendices = [];
    const rendererUsage = { sections: new Set(), appendixCount: 0 };
    const walk = (node, ancestors, partRecord = null) => {
      const nodeType = String(node.getAttribute("TYPE") || "").toLowerCase();
      const current = node.tagName.startsWith("DIV") && nodeType ? breadcrumb(node, ancestors) : ancestors;
      if (node.tagName === "DIV5" && nodeType === "part") {
        const part = node.getAttribute("N") || "";
        if (expectedPart && String(part) !== String(expectedPart)) throw new Error(`The eCFR XML returned Part ${part || "(empty)"} while Part ${expectedPart} was requested.`);
        partRecord = {
          id: `${title}:${part}`, title: Number(title), part, heading: childText(node, "HEAD"), hierarchy: current,
          authority: flattened(directChild(node, "AUTH")), source: flattened(directChild(node, "SOURCE")),
          url: sourceUrl(title, current), uscMappings: [...mappings], sectionIds: [], appendixIds: []
        };
        parts.push(partRecord);
      } else if (node.tagName === "DIV8" && nodeType === "section" && partRecord) {
        const number = node.getAttribute("N") || "", head = childText(node, "HEAD");
        const oracle = new ParagraphOracle(renderedPart.sections.get(number), `${title} CFR ${number}`);
        const record = {
          id: `${title}:${number}`, title: Number(title), section: number, partId: partRecord.id,
          heading: head.replace(/^§\s*[^ ]+\s*/, ""), hierarchy: current, blocks: normalizedBlocks(node, graphics, oracle),
          url: sourceUrl(title, current.slice(0, -1), number)
        };
        oracle.finish();
        sections.push(record);
        partRecord.sectionIds.push(record.id);
        rendererUsage.sections.add(number);
        return;
      } else if (node.tagName === "DIV9" && partRecord) {
        const number = node.getAttribute("N") || childText(node, "HEAD");
        if (rendererUsage.appendixCount >= renderedPart.appendices.length) throw new Error(`The enhanced eCFR response has no appendix record for ${title} CFR ${number}.`);
        const oracle = new ParagraphOracle(renderedPart.appendices[rendererUsage.appendixCount], `${title} CFR ${number}`);
        const record = {
          id: `${partRecord.id}:appendix:${appendices.length + 1}`, title: Number(title), partId: partRecord.id,
          label: number, heading: childText(node, "HEAD"), hierarchy: current, blocks: normalizedBlocks(node, graphics, oracle), url: partRecord.url
        };
        oracle.finish();
        appendices.push(record);
        partRecord.appendixIds.push(record.id);
        rendererUsage.appendixCount += 1;
        return;
      }
      for (const child of node.children || []) if (child.tagName.startsWith("DIV")) walk(child, current, partRecord);
    };
    walk(root, []);
    if (parts.length !== 1) throw new Error(`The eCFR part response produced ${parts.length} part records instead of one.`);
    const rendererOnlySections = [...renderedPart.sections.keys()].filter(section => !rendererUsage.sections.has(section)).sort();
    const xmlOnlySections = [...rendererUsage.sections].filter(section => !renderedPart.sections.has(section)).sort();
    if (rendererOnlySections.length || xmlOnlySections.length) throw new Error(`The XML/enhanced-renderer section inventories differ; renderer-only=${rendererOnlySections.join(",") || "none"}; XML-only=${xmlOnlySections.join(",") || "none"}.`);
    if (rendererUsage.appendixCount !== renderedPart.appendices.length) throw new Error(`The XML has ${rendererUsage.appendixCount} appendices but the enhanced renderer has ${renderedPart.appendices.length}.`);
    const rendererElements = [...renderedPart.sections.values(), ...renderedPart.appendices].flatMap(record => record.paragraphs);
    return {
      parts, sections, appendices,
      structureMetrics: {
        recordCount: renderedPart.sections.size + renderedPart.appendices.length,
        paragraphCount: rendererElements.filter(element => element.elementKind === "p").length,
        elementCount: rendererElements.length,
        addressableElementCount: rendererElements.filter(element => element.addressable && element.path.length && !element.term && !element.disabled).length,
        contextElementCount: rendererElements.filter(element => element.path.length && !element.addressable).length
      }
    };
  }

  function coverage(cfr) {
    const byTitle = new Map();
    for (const part of cfr.parts || []) {
      const title = String(part.title), number = String(part.part);
      if (!byTitle.has(title)) byTitle.set(title, new Set());
      byTitle.get(title).add(number);
    }
    const titles = [...byTitle.keys()].sort((left, right) => Number(left) - Number(right));
    return { byTitle, titles, snapshotByTitle: new Map(titles.map(title => [title, cfr.currentThrough?.[title]])) };
  }

  function correctionParts(data, corpusCoverage) {
    const parts = new Set(), unresolvedTitles = new Set();
    for (const correction of data.ecfr_corrections || []) {
      for (const reference of correction.cfr_references || []) {
        const hierarchy = reference.hierarchy || {};
        const title = String(hierarchy.title || correction.title || "");
        const snapshot = corpusCoverage.snapshotByTitle.get(title), allowed = corpusCoverage.byTitle.get(title);
        if (!snapshot || !allowed || !correction.error_occurred || !correction.error_corrected) continue;
        if (!(correction.error_occurred <= snapshot && correction.error_corrected > snapshot)) continue;
        const part = hierarchy.part ? String(hierarchy.part) : "";
        if (!part) { unresolvedTitles.add(title); continue; }
        if (title === "8" || allowed.has(part)) parts.add(`${title}:${part}`);
      }
    }
    return { parts, unresolvedTitles };
  }

  async function mapConcurrent(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
  }

  function rebuildCoverage(cfr) {
    const counts = {};
    for (const section of cfr.sections || []) counts[String(section.title)] = (counts[String(section.title)] || 0) + 1;
    cfr.coverage = {
      ...(cfr.coverage || {}),
      titles: [...new Set((cfr.parts || []).map(part => part.title))].sort((a, b) => a - b),
      partCount: (cfr.parts || []).length,
      sectionCount: (cfr.sections || []).length,
      appendixCount: (cfr.appendices || []).length,
      sectionCountsByTitle: counts
    };
    const unavailable = new Set();
    const graphicPaths = new Set();
    const walk = blocks => {
      for (const block of blocks || []) {
        if (block.t === "graphic") { graphicPaths.add(block.src); if (!block.data) unavailable.add(block.src); }
        if (block.t === "note") walk(block.blocks);
      }
    };
    for (const record of [...(cfr.sections || []), ...(cfr.appendices || [])]) walk(record.blocks);
    cfr.coverage.graphicsCount = graphicPaths.size;
    cfr.coverage.embeddedGraphicsCount = graphicPaths.size - unavailable.size;
    cfr.coverage.unavailableGraphics = [...unavailable].sort();
  }

  const REFERENCE_FIELDS = ["references", "headingReferences", "authorityReferences", "sourceReferences"];

  function copyReferenceFields(target, source) {
    if (!target || !source) return;
    for (const field of REFERENCE_FIELDS) if (Array.isArray(source[field])) target[field] = structuredClone(source[field]);
  }

  function retainExactBlockReferences(newBlocks, oldBlocks) {
    const available = new Map();
    const key = block => `${block?.t || ""}\u0000${block?.a || ""}\u0000${block?.x || block?.caption || ""}`;
    for (const block of oldBlocks || []) {
      const identity = key(block);
      if (!available.has(identity)) available.set(identity, []);
      available.get(identity).push(block);
    }
    for (const block of newBlocks || []) {
      const prior = available.get(key(block))?.shift();
      if (prior) {
        copyReferenceFields(block, prior);
        if (block.t === "table") {
          (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
            const oldCell = prior.rows?.[rowIndex]?.[cellIndex];
            if (oldCell?.x === cell.x) copyReferenceFields(cell, oldCell);
          }));
        }
      }
      if (block.t === "note") retainExactBlockReferences(block.blocks, prior?.blocks || []);
    }
  }

  function retainExactReferences(cfr, normalized, oldPart) {
    if (!oldPart) return;
    const oldSections = new Map((cfr.sections || []).filter(section => section.partId === oldPart.id).map(section => [section.id, section]));
    for (const section of normalized.sections) {
      const prior = oldSections.get(section.id);
      if (!prior) continue;
      if (prior.heading === section.heading) copyReferenceFields(section, prior);
      retainExactBlockReferences(section.blocks, prior.blocks);
    }
    const oldAppendices = (cfr.appendices || []).filter(appendix => appendix.partId === oldPart.id);
    const oldByLabel = new Map(oldAppendices.map(appendix => [`${appendix.label}\u0000${appendix.heading}`, appendix]));
    normalized.appendices.forEach((appendix, index) => {
      const prior = oldByLabel.get(`${appendix.label}\u0000${appendix.heading}`) || oldAppendices[index];
      if (prior) {
        appendix.id = prior.id;
        copyReferenceFields(appendix, prior);
        retainExactBlockReferences(appendix.blocks, prior.blocks);
      } else appendix.id = `${oldPart.id}:appendix:runtime:${index + 1}`;
    });
    normalized.parts[0].appendixIds = normalized.appendices.map(appendix => appendix.id);
    if (oldPart.heading === normalized.parts[0].heading) copyReferenceFields(normalized.parts[0], oldPart);
  }

  function slug(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "term";
  }

  function refreshCfrDefinitions(corpus) {
    const definitions = corpus.definitions;
    const section = corpus.cfr?.sections?.find(item => item.id === "8:1.2");
    if (!definitions?.entries || !section) return;
    const entries = [];
    for (const block of section.blocks || []) {
      if (block.t !== "p" || /^As used in this chapter/i.test(block.x || "")) continue;
      const text = cleanText(block.x);
      const italicAliases = (block.r || []).filter(run => run.s === "i").map(run => cleanText(run.x).replace(/[.,;:]+$/, "")).filter(Boolean);
      const verb = /\b(?:shall\s+(?:include|mean)|means?|includes?|refers?\s+to)\b/i.exec(text);
      const see = /^([^.!?]{1,180})\.\s+See\b/i.exec(text);
      if (!verb && !see) continue;
      let aliases = [...new Set(italicAliases)];
      if (!aliases.length) {
        const prefix = cleanText(see?.[1] || text.slice(0, verb.index)).replace(/,?\s+(?:unless|when|as)\b.*$/i, "").replace(/[.,;:]+$/, "");
        aliases = prefix.split(/\s+(?:or|and)\s+/i).map(cleanText).filter(Boolean);
      }
      if (!aliases.length) continue;
      const term = aliases.join(aliases.length === 2 ? " or " : ", ");
      const entry = { term, aliases, text };
      const scope = text.match(/\bThis definition applies\b[\s\S]*$/i)?.[0];
      if (scope) entry.specificScope = scope;
      entries.push(entry);
    }
    if (!entries.length) throw new Error("The updated 8 CFR 1.2 text did not yield any regulatory definitions.");
    const source = definitions.sources?.cfr1_2 || {};
    const captureDate = corpus.cfr.currentThrough?.["8"] || nowIso().slice(0, 10);
    if (definitions.sources?.cfr1_2) definitions.sources.cfr1_2.capturedAt = captureDate;
    const records = entries.map((entry, index) => ({
      ...entry,
      id: `8-cfr-1-2-${String(index + 1).padStart(2, "0")}-${slug(entry.term)}`,
      sourceFamily: "cfr", sourceCategory: "law", sourceFilter: "8-cfr-1-2",
      scopeId: "cfr-chapter-i", scopeCategory: "law", sourcePriority: 1,
      citation: "8 CFR 1.2", locator: `8 CFR 1.2 — ${entry.term}`,
      url: source.url || `${ECFR_ORIGIN}/current/title-8/section-1.2`, captureDate,
      resource: source.name || "8 CFR 1.2", children: []
    }));
    definitions.entries = [...definitions.entries.filter(entry => entry.sourceFilter !== "8-cfr-1-2"), ...records];
  }

  function runtimeCorpusVersion(existing, date) {
    const base = String(existing || "0").replace(/\+ecfr\..*$/, "");
    return `${base}+ecfr.${String(date).replace(/-/g, ".")}`;
  }

  async function sourceArtifact(key, text, details) {
    const bytes = new TextEncoder().encode(text);
    return {
      recordSchemaVersion: 1,
      authority: ECFR_ORIGIN,
      mediaType: details.mediaType,
      sourceUrl: details.sourceUrl,
      capturedAt: nowIso(),
      bytes: bytes.byteLength,
      sha256: await globalThis.INASearchStorage.sha256Bytes(bytes),
      payload: new Blob([bytes], { type: details.mediaType })
    };
  }

  async function updateCorpusFromPlan(corpus, plan, metrics, signal) {
    throwIfAborted(signal);
    const updated = structuredClone(corpus);
    const cfr = updated.cfr;
    cfr.titleMetadata = {
      url: TITLES_URL,
      bytes: plan.titleMetadataArtifact.bytes,
      sha256: plan.titleMetadataArtifact.sha256,
      capturedAt: plan.titleMetadataArtifact.capturedAt,
      runtimeUpdate: true
    };
    const graphics = preservedGraphics(cfr);
    const existingParts = new Map(cfr.parts.map(part => [part.id, part]));
    const tasks = [...plan.changedParts].sort().map(key => {
      const [title, part] = key.split(":");
      return { key, title, part, date: plan.targetDates.get(title) };
    });
    const downloads = await mapConcurrent(tasks, FETCH_CONCURRENCY, async task => {
      throwIfAborted(signal);
      const url = `${ECFR_ORIGIN}/api/versioner/v1/full/${encodeURIComponent(task.date)}/title-${encodeURIComponent(task.title)}.xml?part=${encodeURIComponent(task.part)}`;
      const rendererUrl = `${ECFR_ORIGIN}/api/renderer/v1/content/enhanced/${encodeURIComponent(task.date)}/title-${encodeURIComponent(task.title)}?part=${encodeURIComponent(task.part)}`;
      try {
        const [{ text }, { text: rendererHtml }] = await Promise.all([
          fetchAuthority(url, "application/xml", metrics, signal),
          fetchAuthority(rendererUrl, "text/html", metrics, signal)
        ]);
        throwIfAborted(signal);
        const artifact = await sourceArtifact(`ecfr:${task.title}:${task.part}:${task.date}`, text, { mediaType: "application/xml", sourceUrl: url });
        const rendererArtifact = await sourceArtifact(`ecfr-renderer:${task.title}:${task.part}:${task.date}`, rendererHtml, { mediaType: "text/html", sourceUrl: rendererUrl });
        await globalThis.INASearchStorage.storeSourceArtifact(`ecfr:${task.title}:${task.part}:${task.date}`, artifact);
        await globalThis.INASearchStorage.storeSourceArtifact(`ecfr-renderer:${task.title}:${task.part}:${task.date}`, rendererArtifact);
        const mappings = existingParts.get(task.key)?.uscMappings || [];
        const normalized = normalizeEcfrXml(text, { title: Number(task.title), part: task.part, rendererHtml, mappings, graphics });
        retainExactReferences(cfr, normalized, existingParts.get(task.key));
        return { ...task, url, rendererUrl, text, artifact, rendererArtifact, normalized };
      } catch (error) {
        if (/HTTP 404 for \/api\/versioner\/v1\/full\//.test(error?.message || "")) return { ...task, url, removed: true };
        throw error;
      }
    });

    for (const download of downloads) {
      const oldPart = existingParts.get(download.key);
      const sectionIds = new Set(oldPart?.sectionIds || []), appendixIds = new Set(oldPart?.appendixIds || []);
      cfr.parts = cfr.parts.filter(part => part.id !== download.key);
      cfr.sections = cfr.sections.filter(section => section.partId !== download.key && !sectionIds.has(section.id));
      cfr.appendices = cfr.appendices.filter(appendix => appendix.partId !== download.key && !appendixIds.has(appendix.id));
      cfr.removedParts = (cfr.removedParts || []).filter(part => part.id !== download.key);
      if (download.removed) {
        cfr.removedParts.push({
          id: download.key, title: Number(download.title), part: download.part, status: "removed", removedOn: download.date,
          uscMappings: oldPart?.uscMappings || [], historyUrl: `${ECFR_ORIGIN}/api/versioner/v1/versions/title-${download.title}.json?part=${encodeURIComponent(download.part)}`,
          message: "This part has been removed from the current eCFR; no outdated regulatory text is included."
        });
      } else {
        cfr.parts.push(...download.normalized.parts);
        cfr.sections.push(...download.normalized.sections);
        cfr.appendices.push(...download.normalized.appendices);
      }
      cfr.sources = (cfr.sources || []).filter(source => !(String(source.title) === download.title && String(source.part || "") === download.part));
      cfr.structureSources = (cfr.structureSources || []).filter(source => !(String(source.title) === download.title && String(source.part || "") === download.part));
      if (!download.removed) cfr.sources.push({
        title: Number(download.title), part: download.part, url: download.url, bytes: download.artifact.bytes,
        sha256: download.artifact.sha256, currentThrough: download.date, runtimeUpdate: true
      });
      if (!download.removed) cfr.structureSources.push({
        title: Number(download.title), part: download.part, url: download.rendererUrl, bytes: download.rendererArtifact.bytes,
        sha256: download.rendererArtifact.sha256, currentThrough: download.date, runtimeUpdate: true,
        ...download.normalized.structureMetrics
      });
    }

    for (const [title, date] of plan.targetDates) cfr.currentThrough[title] = date;
    cfr.parts.sort((left, right) => left.title - right.title || String(left.part).localeCompare(String(right.part), "en", { numeric: true }));
    cfr.sections.sort((left, right) => left.title - right.title || String(left.section).localeCompare(String(right.section), "en", { numeric: true }));
    cfr.appendices.sort((left, right) => left.title - right.title || String(left.partId).localeCompare(String(right.partId), "en", { numeric: true }) || String(left.id).localeCompare(String(right.id), "en", { numeric: true }));
    rebuildCoverage(cfr);
    if (plan.changedParts.has("8:1")) refreshCfrDefinitions(updated);
    const referenceEngine = globalThis.INASearchLegalReferences;
    if (!referenceEngine?.applyCfrReferences) throw new Error("The shared legal-reference engine is unavailable; the CFR update was not activated.");
    const citationMaintenance = referenceEngine.applyCfrReferences(updated, plan.changedParts);
    const maximumDate = [...plan.targetDates.values()].sort().at(-1);
    updated.corpusVersion = runtimeCorpusVersion(updated.corpusVersion, maximumDate);
    updated.verifiedAt = nowIso();
    updated.runtimeMaintenance = {
      schemaVersion: 1,
      authority: ECFR_ORIGIN,
      checkedAt: plan.checkedAt,
      currentThrough: Object.fromEntries(plan.targetDates),
      changedParts: tasks.map(task => task.key),
      citationReferencesRegenerated: true,
      citationReferenceParts: citationMaintenance.changedParts,
      citationReferenceFields: citationMaintenance.fields,
      citationReferenceCount: citationMaintenance.references,
      citationReferenceEngineVersion: citationMaintenance.engineVersion,
      structureRendererVerified: true,
      structureRendererParts: tasks.map(task => task.key),
      requestPattern: "fixed-corpus-coverage",
      navigationIndependent: true
    };
    return updated;
  }

  async function currentCorpus(fallback) {
    const cached = await globalThis.INASearchStorage?.loadActiveCorpus({ corpusSchemaVersion: fallback.schemaVersion });
    return cached?.corpus && globalThis.INASearchStorage.compareVersions(cached.corpus.corpusVersion, fallback.corpusVersion) >= 0 ? cached.corpus : fallback;
  }

  async function performCheck(fallbackCorpus, options = {}) {
    const onStatus = options.onStatus;
    const signal = options.signal;
    throwIfAborted(signal);
    const storage = globalThis.INASearchStorage;
    if (!fallbackCorpus?.cfr || !storage) return report({ state: "unsupported", message: "Local corpus storage is unavailable." }, onStatus);
    const started = performance.now();
    const metrics = { requests: 0, bytes: 0, requestMs: 0 };
    let corpus = await currentCorpus(fallbackCorpus);
    throwIfAborted(signal);
    const previous = await storage.getMetadata(LAST_CHECK_KEY);
    const previousTime = Date.parse(previous?.checkedAt || "");
    if (!options.force && Number.isFinite(previousTime) && Date.now() - previousTime < CHECK_INTERVAL_MS) {
      await storage.ensureActiveCorpus(corpus, { reason: "local-baseline", sourceState: { authority: "embedded-release" } });
      return report({ ...previous, state: previous.state === "updated" ? "current" : previous.state, cachedCheck: true }, onStatus);
    }
    report({ state: "checking", startedAt: nowIso(), message: "Checking fixed eCFR coverage in the background." }, onStatus);
    const titlesResult = await fetchJson(TITLES_URL, metrics, signal);
    throwIfAborted(signal);
    const titlesArtifact = await sourceArtifact("ecfr:titles", titlesResult.text, { mediaType: "application/json", sourceUrl: TITLES_URL });
    await storage.storeSourceArtifact("ecfr:titles:latest", titlesArtifact);
    const titleMetadata = new Map((titlesResult.value.titles || []).map(item => [String(item.number), item]));
    const corpusCoverage = coverage(corpus.cfr);
    const missing = corpusCoverage.titles.filter(title => !titleMetadata.has(title));
    if (missing.length) throw new Error(`eCFR title metadata omitted covered titles: ${missing.join(", ")}.`);
    const provisional = corpusCoverage.titles.filter(title => {
      const record = titleMetadata.get(title);
      return record.processing_in_progress || !record.up_to_date_as_of;
    });
    if (provisional.length) {
      await storage.ensureActiveCorpus(corpus, { reason: "local-baseline", sourceState: { authority: "embedded-release" } });
      const status = { state: "deferred", checkedAt: nowIso(), message: `eCFR is still processing title${provisional.length > 1 ? "s" : ""} ${provisional.join(", ")}; the local corpus was left unchanged.`, metrics: { ...metrics, elapsedMs: performance.now() - started } };
      await storage.setMetadata(LAST_CHECK_KEY, status);
      return report(status, onStatus);
    }

    const titlesToQuery = corpusCoverage.titles.filter(title => {
      const snapshot = corpusCoverage.snapshotByTitle.get(title);
      const record = titleMetadata.get(title);
      return !snapshot || metadataCouldContainChanges(record, snapshot);
    });
    const targetDates = new Map(corpusCoverage.titles
      .filter(title => titleMetadata.get(title).up_to_date_as_of > corpusCoverage.snapshotByTitle.get(title))
      .map(title => [title, titleMetadata.get(title).up_to_date_as_of]));
    const versionResults = await mapConcurrent(titlesToQuery, FETCH_CONCURRENCY, async title => {
      throwIfAborted(signal);
      const parameters = new URLSearchParams({ "date[gte]": dayAfter(corpusCoverage.snapshotByTitle.get(title)) });
      const url = `${ECFR_ORIGIN}/api/versioner/v1/versions/title-${encodeURIComponent(title)}.json?${parameters}`;
      const result = await fetchJson(url, metrics, signal);
      throwIfAborted(signal);
      await storage.storeSourceArtifact(`ecfr:versions:${title}:${corpusCoverage.snapshotByTitle.get(title)}`, await sourceArtifact("versions", result.text, { mediaType: "application/json", sourceUrl: url }));
      return { title, url, ...result };
    });
    const correctionDates = [...new Set(corpusCoverage.snapshotByTitle.values())].filter(Boolean).sort();
    const correctionResults = await mapConcurrent(correctionDates, FETCH_CONCURRENCY, async date => {
      throwIfAborted(signal);
      const url = `${ECFR_ORIGIN}/api/admin/v1/corrections.json?${new URLSearchParams({ date })}`;
      const result = await fetchJson(url, metrics, signal);
      throwIfAborted(signal);
      await storage.storeSourceArtifact(`ecfr:corrections:${date}`, await sourceArtifact("corrections", result.text, { mediaType: "application/json", sourceUrl: url }));
      return { date, url, ...result };
    });
    const changedParts = new Set(), unresolvedTitles = new Set();
    for (const result of versionResults) {
      const allowed = corpusCoverage.byTitle.get(result.title);
      for (const record of result.value.content_versions || result.value.versions || []) {
        const title = String(record.title || result.title), part = record.part ? String(record.part) : "";
        if (!part) { unresolvedTitles.add(title); continue; }
        if (title === "8" || allowed.has(part)) changedParts.add(`${title}:${part}`);
      }
    }
    const correctionData = { ecfr_corrections: correctionResults.flatMap(result => result.value.ecfr_corrections || []) };
    const correctionChanges = correctionParts(correctionData, corpusCoverage);
    correctionChanges.parts.forEach(key => changedParts.add(key));
    correctionChanges.unresolvedTitles.forEach(title => unresolvedTitles.add(title));
    for (const key of changedParts) {
      const title = key.split(":")[0];
      if (!targetDates.has(title)) targetDates.set(title, titleMetadata.get(title).up_to_date_as_of);
    }
    if (unresolvedTitles.size) throw new Error(`eCFR reported a title-wide change that cannot be safely reduced to fixed parts for title${unresolvedTitles.size > 1 ? "s" : ""} ${[...unresolvedTitles].join(", ")}. The local corpus was left unchanged.`);

    const checkedAt = nowIso();
    const plan = { checkedAt, changedParts, targetDates, titleMetadataArtifact: titlesArtifact };
    throwIfAborted(signal);
    if (!changedParts.size) {
      const updated = structuredClone(corpus);
      updated.cfr.titleMetadata = { url: TITLES_URL, bytes: titlesArtifact.bytes, sha256: titlesArtifact.sha256, capturedAt: titlesArtifact.capturedAt, runtimeUpdate: true };
      for (const [title, date] of targetDates) updated.cfr.currentThrough[title] = date;
      if (targetDates.size) {
        const maximumDate = [...targetDates.values()].sort().at(-1);
        updated.corpusVersion = runtimeCorpusVersion(updated.corpusVersion, maximumDate);
        updated.verifiedAt = checkedAt;
        updated.runtimeMaintenance = { schemaVersion: 1, authority: ECFR_ORIGIN, checkedAt, currentThrough: Object.fromEntries(targetDates), changedParts: [], requestPattern: "fixed-corpus-coverage", navigationIndependent: true };
        await storage.activateCorpus(updated, { reason: "ecfr-currency-advance", sourceState: updated.runtimeMaintenance });
        corpus = updated;
      } else await storage.ensureActiveCorpus(corpus, { reason: "local-baseline", sourceState: { authority: "embedded-release" } });
      const status = { state: "current", checkedAt, nextCheckAfter: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(), coveredTitles: corpusCoverage.titles.length, coveredParts: [...corpusCoverage.byTitle.values()].reduce((sum, parts) => sum + parts.size, 0), changedParts: [], metrics: { ...metrics, elapsedMs: performance.now() - started } };
      await storage.setMetadata(LAST_CHECK_KEY, status);
      return report(status, onStatus);
    }

    const updated = await updateCorpusFromPlan(corpus, plan, metrics, signal);
    throwIfAborted(signal);
    await storage.activateCorpus(updated, { reason: "ecfr-incremental-update", sourceState: updated.runtimeMaintenance });
    const status = {
      state: "updated", checkedAt, nextCheckAfter: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
      coveredTitles: corpusCoverage.titles.length, coveredParts: [...corpusCoverage.byTitle.values()].reduce((sum, parts) => sum + parts.size, 0),
      changedParts: [...changedParts].sort(), corpusVersion: updated.corpusVersion, reloadRequired: true,
      message: `${changedParts.size} CFR part${changedParts.size === 1 ? "" : "s"} updated directly from eCFR. Reload to use the verified local copy.`,
      metrics: { ...metrics, elapsedMs: performance.now() - started }
    };
    await storage.setMetadata(LAST_CHECK_KEY, status);
    return report(status, onStatus);
  }

  async function withUpdateLock(worker) {
    if (globalThis.navigator?.locks?.request) {
      let result = null;
      await navigator.locks.request("inasearch-ecfr-maintenance", { ifAvailable: true }, async lock => {
        if (lock) result = await worker();
      });
      return result || { state: "already-running", authority: ECFR_ORIGIN };
    }
    return worker();
  }

  async function checkAndUpdate(corpus, options = {}) {
    try { return await withUpdateLock(() => performCheck(corpus, options)); }
    catch (error) {
      if (error?.name === "AbortError") return report({ state: "disabled", networkActivity: false, message: "Automatic CFR updates are off. INASearch is using local data only and making no network requests." }, options.onStatus);
      await globalThis.INASearchStorage?.ensureActiveCorpus(corpus, { reason: "local-baseline-after-update-error", sourceState: { authority: "embedded-release" } }).catch(() => {});
      const status = { state: "error", checkedAt: nowIso(), message: error?.message || String(error) };
      await globalThis.INASearchStorage?.setMetadata(LAST_CHECK_KEY, status).catch(() => {});
      return report(status, options.onStatus);
    }
  }

  function start(corpus, options = {}) {
    let timer = null, controller = null, stopped = false;
    const run = async () => {
      if (stopped || options.enabled?.() === false) return;
      let result = null;
      controller = new AbortController();
      try { result = await checkAndUpdate(corpus, { ...options, signal: controller.signal }); }
      finally {
        controller = null;
        if (stopped || options.enabled?.() === false) return;
        const scheduledAt = Date.parse(result?.nextCheckAfter || "");
        const delay = Number.isFinite(scheduledAt) ? Math.max(60_000, scheduledAt - Date.now()) : CHECK_INTERVAL_MS;
        timer = setTimeout(run, delay);
      }
    };
    const initial = setTimeout(run, options.startDelayMs ?? START_DELAY_MS);
    return () => { stopped = true; clearTimeout(initial); clearTimeout(timer); controller?.abort(); };
  }

  globalThis.INASearchUpdater = Object.freeze({
    ECFR_ORIGIN,
    CHECK_INTERVAL_MS,
    normalizeEcfrXml,
    checkAndUpdate,
    start
  });
})();
