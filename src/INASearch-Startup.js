/* Verified embedded data, with opening-page content ahead of background records. */
(() => {
  "use strict";
  const arrivals = new Map();
  const available = new Set();
  const waitForData = id => {
    if (available.has(id)) return Promise.resolve();
    // A parser-created script exists before all its text has arrived. Its following
    // register call is the signal that the complete embedded payload can be read.
    if (document.readyState === "interactive" || document.readyState === "complete") {
      return document.getElementById(id) ? Promise.resolve() : Promise.reject(new Error(`Missing embedded corpus data: ${id}.`));
    }
    return new Promise((resolve, reject) => {
      const finish = () => { document.removeEventListener("DOMContentLoaded", missing); resolve(); };
      const missing = () => { if (!available.has(id)) reject(new Error(`Missing embedded corpus data: ${id}.`)); arrivals.delete(id); };
      const waiting = arrivals.get(id) || [];
      waiting.push(finish);
      arrivals.set(id, waiting);
      document.addEventListener("DOMContentLoaded", missing, { once: true });
    });
  };
  function register(id) {
    available.add(id);
    arrivals.get(id)?.forEach(resolve => resolve());
    arrivals.delete(id);
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function hierarchyRowHtml({ id, citation, label, size, expandable = true, expanded = false, children = "", interactiveLabel = false, navigationLabel = citation }) {
    const toggle = expandable
      ? `<button class="hierarchy-expand" type="button" data-hierarchy-expand="${escapeHtml(id)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(citation)}"><span class="hierarchy-expand-icon" aria-hidden="true">›</span></button>`
      : `<span class="hierarchy-expand-placeholder" aria-hidden="true">•</span>`;
    // Keep inline note controls beside their heading without nesting buttons.
    const labelHtml = interactiveLabel
      ? `<div class="hierarchy-label hierarchy-label-annotated"><button class="hierarchy-open" type="button" data-hierarchy-open="${escapeHtml(id)}" aria-label="${escapeHtml(navigationLabel)}"></button>${label}</div>`
      : `<button class="hierarchy-label" type="button" data-hierarchy-open="${escapeHtml(id)}">${label}</button>`;
    return `<article class="hierarchy-row" data-row-size="${escapeHtml(size)}" data-hierarchy-row="${escapeHtml(id)}"><div class="hierarchy-row-main">${toggle}${labelHtml}</div>${expandable ? `<div class="hierarchy-children" data-hierarchy-children="${escapeHtml(id)}"${expanded ? "" : " hidden"}>${children}</div>` : ""}</article>`;
  }
  // Reconcile the opening markup in place. Browser scroll anchoring, focused
  // controls and the already painted rows survive the application handoff.
  function adoptOpeningIndex(root, header, rows) {
    const list = document.getElementById("resultList");
    const matches = list?.dataset.openingRoot === root;
    if (list) delete list.dataset.openingRoot;
    if (!matches) return false;
    const reconcile = (current, next) => {
      if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); return; }
      if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; return; }
      if (current.nodeType !== 1) return;
      for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      for (const attr of next.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      const children = [...current.childNodes], desired = [...next.childNodes];
      desired.forEach((node, index) => children[index] ? reconcile(children[index], node) : current.appendChild(node.cloneNode(true)));
      children.slice(desired.length).forEach(node => node.remove());
    };
    for (const [element, html] of [[document.getElementById("authorityBrowseHeader"), header], [list, rows]]) {
      const next = element.cloneNode(false);
      next.innerHTML = html;
      reconcile(element, next);
    }
    return true;
  }
  async function showOpeningIndex(data) {
    // Remember an action taken before the full application attaches its handlers.
    let action = null, typedQuery;
    const rememberInput = event => { if (event.target.id === "searchInput") { typedQuery = event.target.value; action = null; } };
    const rememberClick = event => {
      const target = event.target.closest("button, a");
      if (!target) return;
      const handled = window.INA_SEARCH_HANDLE_OPENING_CLICK?.(event);
      if (handled) {
        action = null;
        if (handled === "ready") return;
        if (handled === "navigation") typedQuery = undefined;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const attribute = [...target.attributes].find(item => item.name.startsWith("data-"));
      if (!target.id && !attribute) return;
      action = target.id ? { id: target.id } : { attribute: attribute.name, value: attribute.value };
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("input", rememberInput, true);
    document.addEventListener("click", rememberClick, true);
    window.INA_SEARCH_RELEASE_EARLY_INPUT = () => {
      document.removeEventListener("input", rememberInput, true);
      document.removeEventListener("click", rememberClick, true);
      window.INA_SEARCH_HANDLE_OPENING_CLICK = null;
      if (typedQuery !== undefined) {
        const input = document.getElementById("searchInput");
        input.value = typedQuery;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (action) (action.id ? document.getElementById(action.id) : document.querySelector(`[${action.attribute}="${CSS.escape(action.value)}"]`))?.click();
    };
    const cachedProfile = window.INA_SEARCH_OPENING_PROFILE_READY ? await window.INA_SEARCH_OPENING_PROFILE_READY : (await window.INA_SEARCH_STARTUP_SNAPSHOT_READY)?.profile;
    if (window.INA_SEARCH_OPENING_VIEW_RENDERED) return;
    const parameters = new URLSearchParams(window.location?.search || "");
    const profile = cachedProfile?.vault?.profile || window.INA_SEARCH_PROFILE;
    if (!parameters.has("q") && (parameters.get("view") === "notes" || /^#\/?notes(?:\b|\/)/i.test(window.location?.hash || ""))) return;
    const query = parameters.has("q") ? parameters.get("q") : profile?.preferences?.defaultStartupQuery || "";
    if (String(query || "").trim() || !data) return;
    const system = profile?.preferences?.statutoryNavigationSystem === "usc" ? "usc" : "ina";
    const escape = escapeHtml;
    const rows = values => values.map(([id, citation, heading, badges, size = "top"]) => hierarchyRowHtml({
      id, citation, size,
      label: `<span class="hierarchy-citation">${escape(citation)}</span><span class="hierarchy-heading-with-status">${(badges || []).map(([label, kind]) => `<span class="hierarchy-status hierarchy-status-title ${kind}">${escape(label)}</span>`).join(" ")} <span class="hierarchy-heading">${escape(heading)}</span></span>`
    })).join("");
    const actions = root => `<div class="hierarchy-page-actions"><button class="button small" type="button" data-hierarchy-expand-all="${root}">Expand All</button><button class="button small" type="button" data-hierarchy-collapse-all="${root}">Collapse All</button></div>`;
    const header = (label, url, title, description, id) => `<button class="authority-browse-source" type="button" data-open-url="${escape(url)}">${label} <span aria-hidden="true">↗</span></button><h2 class="authority-browse-title" id="${id}">${title}</h2><div class="authority-browse-footer"><p class="authority-browse-meta">${description}</p></div>`;
    const root = system === "ina" ? "ina:root" : "usc:title:8";
    document.getElementById("authorityBrowseHeader").innerHTML = header(system === "ina" ? "GovInfo INA structure" : "House U.S. Code", data.urls[system], system === "ina" ? "INA" : "8 U.S.C.", system === "ina" ? "Immigration and Nationality Act" : "Aliens and Nationality", "authorityBrowseTitle") + actions(root);
    const list = document.getElementById("resultList");
    list.innerHTML = `<div class="hierarchy-list">${rows(data[system])}</div><section class="home-cfr-index" aria-labelledby="homeCfrTitle"><header class="authority-browse-header">${header("eCFR", "https://www.ecfr.gov/current", "CFR", "Code of Federal Regulations", "homeCfrTitle")}${actions("cfr:root")}</header><div class="hierarchy-list" role="list" aria-label="CFR index">${rows(data.cfr)}</div></section>`;
    if (data.referencedUsc?.length) list.insertAdjacentHTML("beforeend", `<section class="home-cfr-index" aria-labelledby="homeRelatedUscTitle"><header class="authority-browse-header"><h2 class="authority-browse-title" id="homeRelatedUscTitle">Referenced U.S. Code</h2><div class="authority-browse-footer"><p class="authority-browse-meta">Sections cited by the statutory text of the INA</p></div>${actions("referenced-usc")}</header><div class="hierarchy-list" role="list" aria-label="Referenced U.S. Code index">${rows(data.referencedUsc)}</div></section>`);
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", `${system === "ina" ? "INA" : "8 U.S.C."} and CFR index`);
    list.removeAttribute("aria-busy");
    list.dataset.openingRoot = root;
    const rail = document.getElementById("mainReaderActions");
    rail.querySelector(".statute-authority-cycle-current").textContent = system.toUpperCase();
    for (const button of rail.querySelectorAll("[data-live-citation-action]")) button.disabled = button.dataset.liveCitationAction !== "open";
    document.getElementById("liveCitationCopies").setAttribute("aria-disabled", "true");
    rail.hidden = false;
    document.documentElement.style.setProperty("--topbar-height", `${document.querySelector(".topbar").getBoundingClientRect().height}px`);
    document.getElementById("searchWorkspace").classList.remove("boot-workspace");
    requestAnimationFrame(() => window.INA_SEARCH_MARK_PERFORMANCE?.("opening-index-rendered"));
  }
  const sha256 = async bytes => {
    if (!globalThis.crypto?.subtle) throw new Error("This browser does not support the standard SHA-256 API required to verify the INASearch corpus.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  async function decode(text, manifest, parse = true) {
    if (!globalThis.crypto?.subtle) throw new Error("This browser does not support the standard SHA-256 API required to verify the INASearch corpus.");
    const isHash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (manifest?.schemaVersion !== 1 || manifest.contentType !== "application/json" || manifest.charset !== "utf-8" || !Number.isSafeInteger(manifest.uncompressedBytes) || !isHash(manifest.uncompressedSha256)) throw new Error("The corpus manifest is present but has invalid or unsupported fields.");
    let bytes;
    let compressedCheck = Promise.resolve(true);
    if (["gzip", "brotli"].includes(manifest.compression)) {
      if (manifest.encoding !== "base64" || manifest.mediaType !== `application/${manifest.compression}` || !Number.isSafeInteger(manifest.compressedBytes) || !isHash(manifest.compressedSha256)) throw new Error("The corpus manifest is present but has invalid or unsupported fields.");
      if (manifest.compression === "gzip" && typeof DecompressionStream !== "function") throw new Error("This browser does not support the standard gzip decompression API required by INASearch.");
      const binary = atob(text.replace(/\s+/g, ""));
      const compressed = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) compressed[index] = binary.charCodeAt(index);
      if (compressed.byteLength !== manifest.compressedBytes) throw new Error("The compressed corpus has an unexpected byte count.");
      // Verify before handing bytes to the embedded decoder. Nothing is
      // published until the decoded byte count and hash also pass.
      compressedCheck = sha256(compressed).then(hash => hash === manifest.compressedSha256);
      if (!await compressedCheck) throw new Error("The compressed corpus failed its SHA-256 integrity check.");
      globalThis.INA_SEARCH_MARK_PERFORMANCE?.("corpus-decompression-start", { compression: manifest.compression });
      try { bytes = manifest.compression === "brotli"
        ? globalThis.INASearchBrotli.decode(compressed)
        : new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
      catch (error) { if (!await compressedCheck) throw new Error("The compressed corpus failed its SHA-256 integrity check."); throw error; }
      globalThis.INA_SEARCH_MARK_PERFORMANCE?.("corpus-decompression-end", { compression: manifest.compression });
    } else if (manifest.compression === "none" && manifest.encoding === "utf-8" && manifest.mediaType === "application/json") bytes = new TextEncoder().encode(text);
    else throw new Error("The corpus manifest is present but has invalid or unsupported fields.");
    if (bytes.byteLength !== manifest.uncompressedBytes) throw new Error("The decompressed corpus has an unexpected byte count.");
    const uncompressedCheck = sha256(bytes);
    const json = manifest.compression === "none" ? text : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let parsed, parseError;
    if (parse) { try { parsed = JSON.parse(json); } catch (error) { parseError = error; } }
    const payload = new Blob([bytes], { type: "application/json;charset=utf-8" });
    if (!await compressedCheck) throw new Error("The compressed corpus failed its SHA-256 integrity check.");
    if (await uncompressedCheck !== manifest.uncompressedSha256) throw new Error("The decompressed corpus failed its SHA-256 integrity check.");
    if (parseError) throw parseError;
    return { parsed, payload, json: parse ? undefined : json };
  }
  // Select broadly when citation spelling has multiple interpretations; the ordinary parser makes the final choice.
  function openingChunks(corpus, mapping, query) {
    const chunks = new Set();
    const uscSections = [...(corpus.title8?.sections || []), ...(corpus.referencedUsc?.titles || []).flatMap(title => title.sections || [])];
    const segments = globalThis.INA_SEARCH_COMMAND?.scanCommandSegments(query)?.segments || [{ text: query }];
    const add = (kind, index) => { const id = mapping[kind]?.[index]; if (Number.isInteger(id)) chunks.add(id); };
    for (const segment of segments) {
      const value = String(segment.text ?? segment.value ?? segment ?? "").trim();
      if (!value || /^(?:about$|define:|INA$|USC$|\d+\s*U\.?\s*S\.?\s*C\.?$|CFR$|\d+\s*CFR$)/i.test(value)) continue;
      if (/\b(?:chapter|title|subchapter|subpart)\b/i.test(value) && !/\b(?:in|cites):/i.test(value)) continue;
      const compact = value.replace(/[‐‑‒–—−]/g, "-").replace(/[\s§]/g, "").replace(/i\.?n\.?a\.?/gi, "ina").replace(/u\.?s\.?c\.?/gi, "usc").replace(/c\.?f\.?r\.?/gi, "cfr").replace(/^0+(?=\d)/, "");
      const cfr = compact.match(/^(?:(\d+)cfr)?(\d+[a-z]*\.\d+.*)$/i);
      if (cfr) {
        (corpus.cfr?.sections || []).forEach((record, index) => {
          const number = String(record.section).toLowerCase();
          const source = cfr[2].toLowerCase();
          if ((!cfr[1] || Number(record.title) === Number(cfr[1])) && source.startsWith(number) && !/\d/.test(source[number.length] || "")) add("cfr", index);
        });
        continue;
      }
      const usc = compact.match(/^(\d+)?usc(\d+[a-z0-9()\-]*)$/i);
      if (usc) {
        const title = Number(usc[1] || 8), citation = usc[2].toLowerCase();
        uscSections.forEach((record, index) => {
          const number = String(record.section).replace(/[‐‑‒–—−]/g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase();
          if (Number(record.title || 8) === title && citation.startsWith(number) && !/\d/.test(citation[number.length] || "")) add("usc", index);
        });
        continue;
      }
      if (/^(?:ina)?\d+[a-z0-9()\-]*$/i.test(compact)) {
        const citation = compact.replace(/^ina/i, "").toLowerCase();
        const targets = new Set((corpus.inaCrosswalk || []).filter(row => citation.startsWith(String(row.inaSection).toLowerCase()) && !/\d/.test(citation[String(row.inaSection).length] || "")).map(row => String(row.localSection || row.uscSection)));
        (corpus.title8?.sections || []).forEach((record, index) => { if (targets.has(String(record.section))) add("usc", index); });
        if (!/^ina/i.test(compact)) (corpus.title8?.sections || []).forEach((record, index) => {
          const number = String(record.section).replace(/[‐‑‒–—−]/g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase();
          if (citation.startsWith(number) && !/\d/.test(citation[number.length] || "")) add("usc", index);
        });
        continue;
      }
      if (/^(?:\d+cfr\d+[a-z]*|(?:INA|USC|CFR)\s+(?:Part|Chapter|Title)|form\b|I-\d+|IIRIRA|IMMACT|IRCA|public\s+law)/i.test(value)) continue;
      return null; // Text searches and unusual commands need the complete corpus.
    }
    return [...chunks];
  }
  const yieldTask = () => new Promise(resolve => {
    if (typeof MessageChannel !== "function") { setTimeout(resolve, 0); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
  async function openCachedCorpus(cached, query) {
    const { corpus, record } = cached;
    const mapping = corpus._shards;
    if (mapping?.v !== 1 || !Array.isArray(record.chunks)) throw new Error("The cached corpus catalog is malformed.");
    window.INA_SEARCH_CORPUS_FULLY_LOADED = false;
    const pending = new Map();
    const loadChunk = id => {
      if (!pending.has(id)) pending.set(id, globalThis.INASearchStorage.readCorpusChunk(record, id).then(chunk => {
        globalThis.INASearchCorpusShards.mergePackedChunk(corpus, chunk);
        window.INA_SEARCH_MARK_PERFORMANCE?.("content-chunk-ready", { id, source: "indexeddb" });
      }));
      return pending.get(id);
    };
    window.INA_SEARCH_LOAD_QUERY_CONTENT = async query => {
      const ids = openingChunks(corpus, mapping, query);
      if (ids === null) { continueLoading(); await window.INA_SEARCH_CORPUS_COMPLETE; }
      else await Promise.all(ids.map(loadChunk));
    };
    let continueLoading, stopped = false;
    const gate = new Promise(resolve => { continueLoading = resolve; });
    window.INA_SEARCH_CONTINUE_LOADING = continueLoading;
    window.INA_SEARCH_CORPUS_COMPLETE = (async () => {
      await gate;
      if (stopped) return corpus;
      for (let id = 0; id < record.chunks.length; id++) { await loadChunk(id); await yieldTask(); }
      delete corpus._shards;
      window.INA_SEARCH_CORPUS_FULLY_LOADED = true;
      window.INA_SEARCH_MARK_PERFORMANCE?.("background-corpus-ready", { source: "indexeddb" });
      return corpus;
    })();
    window.INA_SEARCH_CORPUS_COMPLETE.catch(() => {});
    let requested = openingChunks(corpus, mapping, query);
    if (requested === null) {
      const profile = window.INA_SEARCH_STARTUP_SNAPSHOT?.profile?.vault?.profile || window.INA_SEARCH_PROFILE;
      const selected = new Set();
      const segments = globalThis.INA_SEARCH_COMMAND?.scanCommandSegments(query)?.segments || [{ text: query }];
      let ready = !profile?.notes?.length && !profile?.highlights?.length;
      for (const segment of segments) {
        let ids = openingChunks(corpus, mapping, segment.text);
        if (ids === null) {
          const ast = globalThis.INA_SEARCH_COMMAND?.parseCommand(segment.text);
          if (!ast?.ok || ast.has?.length || ast.scope?.contentScopes?.includes("notes")) { ready = false; break; }
          ids = openingChunks(corpus, mapping, [...(ast.scopeGroups || []).flat(), ...(ast.citationGroups || []).flat()].join(","));
        }
        if (ids === null) { ready = false; break; }
        ids.forEach(id => selected.add(id));
      }
      if (ready) requested = [...selected];
    }
    window.INA_SEARCH_OPENING_REQUIRES_FULL_CORPUS = requested === null;
    if (requested === null) continueLoading();
    else {
      try { await Promise.all(requested.map(loadChunk)); }
      catch (error) { stopped = true; continueLoading(); throw error; }
    }
    window.INA_SEARCH_MARK_PERFORMANCE?.("opening-content-ready", { chunks: requested?.length ?? record.chunks.length, source: "indexeddb" });
    return corpus;
  }
  globalThis.INASearchStartup = Object.freeze({ register, waitForData, decode, openingChunks, openCachedCorpus, showOpeningIndex, hierarchyRowHtml, adoptOpeningIndex });
})();
