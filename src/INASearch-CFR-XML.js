/* Paragraph structure from official eCFR XML and previously verified source anchors. */
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INASearchCfrXml = api;
})(typeof globalThis === "undefined" ? this : globalThis, function() {
  "use strict";
  const TEXT = new Set([ "P", "P2", "FP", "FP-1", "FP-2", "FP-DASH", "LI", "PSPACE", "CITA", "FR", "FRP", "SECAUTH", "PARAUTH", "XREF", "CROSSREF", "APPRO" ]);
  const HEAD = new Set([ "HED", "HD1", "HD2", "HD3", "HD4" ]);
  const WRAP = new Set([ "DIV", "EXTRACT", "EXAMPLE", "SCOL2", "NOTE", "EDNOTE", "EFFDNOT", "AUTH", "SOURCE", "THEAD", "TBODY", "TFOOT" ]);
  const IGNORE = new Set([ "HEAD", "FTNT", "PRTPAGE", "HALFDASH", "BR", "HR", "FTREF" ]);
  const MARK = /\(([A-Za-z0-9ivxlcdmIVXLCDM]+)\)/g;
  const LEAD = /^\s*((?:\([A-Za-z0-9ivxlcdmIVXLCDM]+\))+)/;
  const RANGE = /^\s*((?:\([A-Za-z0-9]+\))+)\s*[-–—]\s*(\(([A-Za-z0-9]+)\))/;
  const DOTTED = /^\s*((?:\d+|[A-Za-z]|[ivxlcdmIVXLCDM]+)\.)(?=\s|$)/;
  const addr = p => (p || []).map(x => "(" + x + ")").join("");
  const tokens = x => [ ...String(x || "").matchAll(/\(([^()]+)\)/g) ].map(m => m[1]);
  function createCfrXmlParagraphResolver(dep) {
    for (const n of [ "flattened", "inlineRuns", "canonicalMatchText", "canonicalMatchMap", "cleanText" ]) if (typeof dep?.[n] !== "function") throw new TypeError("Missing dependency " + n);
    const hierarchy = dep.hierarchy;
    function oldBlocks(record) {
      if (!record) return [];
      if (hierarchy?.flatten) return hierarchy.flatten(record.blocks).map(x => x.block);
      const walk = blocks => (blocks || []).flatMap(b => b.t === "note" ? walk(b.blocks) : [ b ]);
      return walk(record.blocks);
    }
    function collect(root) {
      const out = [];
      function walk(parent, noteType) {
        for (const node of parent?.children || []) {
          const tag = node.tagName;
          if (IGNORE.has(tag)) continue;
          const note = tag === "NOTE" ? "ordinary" : tag === "EDNOTE" ? "editorial" : tag === "EFFDNOT" ? "effective-date" : noteType;
          if (TEXT.has(tag) || HEAD.has(tag) || tag === "TABLE") {
            const text = dep.cleanText(dep.flattened(node));
            if (text) out.push({
              text: text,
              heading: HEAD.has(tag),
              elementKind: tag === "TABLE" ? "table" : HEAD.has(tag) ? "heading" : "p",
              term: false,
              disabled: false,
              indent: 0,
              noteType: note || "",
              runs: tag === "TABLE" ? [] : dep.inlineRuns(node) || [],
              tag: tag
            });
          } else if (WRAP.has(tag)) walk(node, note); else if (node.children?.length && !dep.flattened(node)) walk(node, note); else if (dep.cleanText(dep.flattened(node))) throw new Error("Unsupported nonempty XML element <" + tag + ">; refusing partial CFR normalization.");
        }
      }
      walk(root, "");
      return out;
    }
    function kinds(t) {
      if (/^\d+$/.test(t)) return [ "n" ];
      if (/^[a-z]$/.test(t)) return /^[ivxlcdm]$/.test(t) ? [ "la", "lr" ] : [ "la" ];
      if (/^[A-Z]$/.test(t)) return /^[IVXLCDM]$/.test(t) ? [ "ua", "ur" ] : [ "ua" ];
      if (/^[ivxlcdm]+$/.test(t)) return [ "lr" ];
      if (/^[IVXLCDM]+$/.test(t)) return [ "ur" ];
      if (/^[a-z]-\d+$/.test(t)) return [ "hn" ];
      if (/^[A-Za-z0-9]+\.$/.test(t)) return [ "dot" ];
      return [ "?" ];
    }
    function markerLead(text) {
      const dotted = DOTTED.exec(text);
      if (dotted) return { dotted: true, tokens: [{ token: dotted[1], start: dotted[0].indexOf(dotted[1]), end: dotted[0].length }] };
      const m = LEAD.exec(text);
      if (!m) return null;
      const start = m[0].indexOf(m[1]);
      const range = RANGE.exec(text);
      return {
        tokens: [ ...m[1].matchAll(MARK) ].map(x => ({
          token: x[1],
          start: start + x.index,
          end: start + x.index + x[0].length
        })),
        rangeEnd: range ? { token: range[3], start: range[0].lastIndexOf(range[2]), end: range[0].length } : null
      };
    }
    function priorIndex(record) {
      const text = new Map, paths = new Map, childKinds = new Map, sequence = [], localMarkers = new Map;
      const add = p => {
        if (!p?.length) return;
        paths.set(addr(p), p);
        const par = addr(p.slice(0, -1));
        if (!childKinds.has(par)) childKinds.set(par, new Set);
        for (const k of kinds(p.at(-1))) childKinds.get(par).add(k);
      };
      for (const b of oldBlocks(record)) {
        const lead = markerLead(b.x || "");
        if (!b.a && !b.u?.length && lead) {
          const token = lead.tokens[0].token;
          if (!localMarkers.has(token)) localMarkers.set(token, new Set);
          localMarkers.get(token).add(b.c || "");
        }
        const ps = (b.u || []).map(u => tokens(u.a));
        if (!ps.length && b.a) ps.push(tokens(b.a));
        const key = dep.canonicalMatchText(b.x || "");
        sequence.push({
          key: key,
          block: b
        });
        if (key) {
          if (!text.has(key)) text.set(key, []);
          text.get(key).push({
            ps: ps,
            a: tokens(b.a),
            c: tokens(b.c)
          });
        }
        ps.forEach(add);
        if (b.a) add(tokens(b.a));
        if (b.c) add(tokens(b.c));
      }
      return {
        text: text,
        paths: paths,
        kinds: childKinds,
        sequence: sequence,
        localMarkers: localMarkers
      };
    }
    function resolve(xmlRoot, previousRecord, options = {}) {
      const prev = priorIndex(previousRecord), diagnostics = [], paragraphs = [], occurrences = new Map;
      const entries = collect(xmlRoot);
      let active = [], last = [], priorCursor = 0;
      const diag = (code, e, detail) => diagnostics.push({
        code: code,
        index: entries.indexOf(e),
        text: e.text.slice(0, 140),
        detail: detail || ""
      });
      const order = [ "la", "n", "lr", "ua", "n", "lr" ];
      const ordinal = (token, kind) => {
        if (kind === "n") return Number(token);
        if (kind === "la" || kind === "ua") return token.toLowerCase().charCodeAt(0) - 96;
        const values = {
          i: 1,
          v: 5,
          x: 10,
          l: 50,
          c: 100,
          d: 500,
          m: 1e3
        }, chars = token.toLowerCase();
        let n = 0;
        for (let j = 0; j < chars.length; j++) n += (values[chars[j]] || 0) * (values[chars[j]] < values[chars[j + 1]] ? -1 : 1);
        return n;
      };
      function exactPrior(e) {
        const target = dep.canonicalMatchMap(e.text);
        const key = target?.text || dep.canonicalMatchText(e.text);
        if (!key) return null;
        function at(start) {
          const first = prev.sequence[start];
          if (first?.key === key) {
            const block = first.block;
            if (block.x === e.text || !block.u?.length) return {
              block: block,
              end: start + 1
            };
            const oldMap = dep.canonicalMatchMap(block.x), offsets = target.offsets;
            const mapped = block.u.map(unit => {
              const positions = oldMap.offsets.flatMap((offset, index) => offset >= unit.s && offset < unit.e ? [ index ] : []);
              if (!positions.length) throw new Error("A verified paragraph marker could not be mapped to current XML text.");
              return {
                ...unit,
                s: offsets[positions[0]],
                e: offsets[positions.at(-1)] + 1
              };
            });
            return {
              block: {
                ...block,
                x: e.text,
                u: mapped
              },
              end: start + 1
            };
          }
          const blocks = [];
          let joined = "";
          for (let j = start; j < prev.sequence.length; j++) {
            const block = prev.sequence[j].block, part = prev.sequence[j].key;
            if (!part || block.t !== "p" || block.q || !block.a && !block.u?.length) break;
            const next = joined + part;
            if (!key.startsWith(next)) break;
            blocks.push(block);
            joined = next;
            if (joined === key) {
              if (blocks.length === 1) return {
                block: block,
                end: j + 1
              };
              const offsets = target?.offsets || [];
              const units = [];
              let base = 0;
              for (const old of blocks) {
                const oldMap = dep.canonicalMatchMap(old.x || "");
                if (!oldMap?.offsets || !Array.isArray(old.u)) return null;
                for (const unit of old.u) {
                  const rawStart = Number(unit.s), rawEnd = Number(unit.e);
                  const indexes = oldMap.offsets.flatMap((offset, index) => offset >= rawStart && offset < rawEnd ? [ index ] : []);
                  if (!indexes.length) return null;
                  const first = base + indexes[0], after = base + indexes.at(-1) + 1;
                  if (first >= offsets.length || after <= 0 || after > offsets.length) return null;
                  units.push({
                    a: unit.a,
                    s: offsets[first],
                    e: offsets[after - 1] + 1
                  });
                }
                base += oldMap.text.length;
              }
              const last = blocks.at(-1);
              return {
                end: j + 1,
                block: {
                  t: "p",
                  x: e.text,
                  a: last.a || last.u?.at(-1)?.a || "",
                  u: units,
                  c: last.c || blocks[0].c || "",
                  d: last.d ?? blocks[0].d,
                  q: "",
                  fused: true
                }
              };
            }
          }
          return null;
        }
        for (let i = priorCursor; i < prev.sequence.length; i++) {
          const found = at(i);
          if (!found) continue;
          priorCursor = found.end;
          return found.block;
        }
        return null;
      }
      function candidates(t, e, i, lead, prefix) {
        let bases = [];
        if (i) bases = [ prefix ]; else {
          if (active.length) bases.push(active);
          if (last.length) for (let d = last.length - 1; d >= 0; d--) bases.push(last.slice(0, d));
          bases.push([]);
        }
        const out = [];
        for (const b of bases) {
          const p = [ ...b, t ], key = addr(p), par = addr(b);
          let score = 0;
          if (prev.paths.has(key)) score += 1;
          const possible = kinds(t);
          if (possible.some(k => prev.kinds.get(par)?.has(k))) score += 1;
          if (last.length && addr(last) === par) score += 3; else if (last.length && addr(last.slice(0, -1)) === par) score += 1;
          const exact = prev.text.get(dep.canonicalMatchText(e.text)) || [];
          if (exact.some(x => x.ps.some(q => addr(q) === key) || addr(x.a) === key)) score += 8;
          const kind = order[p.length - 1];
          if (possible.includes(kind)) score += 6; else score -= 12;
          const italicMarker = e.runs?.[0]?.x === "(" && e.runs?.[1]?.s === "i" ? e.runs[1].x : "";
          const styledDepth = /^\d+$/.test(italicMarker) ? 5 : /^[ivxlcdm]+$/.test(italicMarker) ? 6 : 0;
          if (i === 0 && styledDepth) score += p.length === styledDepth ? 30 : -30;
          if (last.length >= p.length && addr(last.slice(0, p.length - 1)) === par && kinds(last[p.length - 1]).includes(kind)) {
            const step = ordinal(t, kind) - ordinal(last[p.length - 1], kind);
            if (step === 1) score += 8; else if (step > 1) score += 1; else score -= 5;
          } else if (ordinal(t, kind) === 1) score += 4;
          if (i > 0) score += 3;
          if (!out.some(x => addr(x.p) === key)) out.push({
            p: p,
            score: score
          });
        }
        const exact = prev.text.get(dep.canonicalMatchText(e.text)) || [];
        for (const x of exact) for (const p of x.ps.length ? x.ps : x.a.length ? [ x.a ] : []) if (p.at(-1) === t) out.push({
          p: p,
          score: 13
        });
        return out.sort((a, b) => b.score - a.score);
      }
      function styledSplits(e, lead) {
        if (!lead || !e.runs.length) return [];
        const result = [];
        let at = 0, markerEnd = lead.tokens.at(-1).end;
        for (const r of e.runs) {
          const start = at, end = at + r.x.length;
          at = end;
          if (r.s !== "i" || start < markerEnd) continue;
          if (!/^\s*$/.test(e.text.slice(markerEnd, start))) break;
          const tail = e.text.slice(end), m = /^[\s:;,.—–-]*(\(([A-Za-z0-9]+)\))/.exec(tail);
          if (!m) break;
          const off = end + m[0].indexOf(m[1]);
          if (off < lead.tokens.at(-1).end) continue;
          result.push({
            offset: off,
            token: m[2],
            end: off + m[1].length
          });
          markerEnd = off + m[1].length;
        }
        return result;
      }
      for (const e of entries) {
        const anchor = exactPrior(e);
        if (e.elementKind === "table") {
          paragraphs.push({
            ...e,
            path: [],
            addressable: false,
            units: [],
            context: anchor?.c || addr(active),
            indent: anchor?.d || active.length
          });
          continue;
        }
        const lead = markerLead(e.text);
        const splits = e.heading || lead?.dotted || lead?.rangeEnd ? [] : styledSplits(e, lead);
        const missingSplits = splits.filter(split => !(anchor?.u || []).some(u => u.s === split.offset));
        const split = missingSplits.length > 0;
        const priorNamed = !!anchor?.q;
        const priorUnaddressed = !!anchor && !anchor.a && !anchor.u?.length;
        const ms = lead?.tokens || [];
        for (const item of splits) ms.push({
          token: item.token,
          start: item.offset,
          end: item.end
        });
        let path = [];
        if (anchor?.a) path = tokens(anchor.a); else if (anchor?.u?.length) path = tokens(anchor.u.at(-1).a);
        let relocatedFrom = null;
        if (path.length > 3 && last.length >= path.length - 1) {
          const divergence = path.findIndex((token, i) => token !== last[i]);
          if (divergence >= 2 && divergence < path.length - 1 && path.slice(divergence + 1, -1).every((token, i) => last[divergence + 1 + i] === token) && kinds(path[divergence]).some(kind => kinds(last[divergence]).includes(kind) && ordinal(last[divergence], kind) - ordinal(path[divergence], kind) === 1)) {
            relocatedFrom = [ ...path ];
            path = [ ...last.slice(0, path.length - 1), path.at(-1) ];
          }
        }
        if (split && path.length) path.push(...missingSplits.map(item => item.token));
        const localContexts = prev.localMarkers.get(ms[0]?.token);
        // A changed local definition/example list has the same visible markers
        // as a regulatory paragraph, but no verified address to carry forward.
        const ambiguousLocal = !anchor && !!localContexts && (localContexts.has("") || localContexts.has(addr(active)));
        if (ambiguousLocal) diag("ambiguous-local-list", e, "A changed publisher-local list marker cannot establish an addressable paragraph.");
        if (!anchor && lead?.dotted && !ambiguousLocal) {
          // Appendix numbering does not follow the six ordinary CFR levels.
          const known = [...prev.paths.values()].filter(p => p.at(-1) === ms[0].token);
          if (known.length === 1) path = [...known[0]];
          else diag("ambiguous-dotted-marker", e, "The dotted marker has no unique verified paragraph address.");
        }
        const freshAmbiguous = !anchor && !last.length && ms.length && [ "i", "I" ].includes(ms[0].token) && !prev.paths.has(addr([ ms[0].token ]));
        if (freshAmbiguous) diag("ambiguous-marker-level", e, "No preceding paragraph establishes whether " + ms[0].token + " is a letter or a Roman numeral.");
        if (!path.length && ms.length && !priorNamed && !priorUnaddressed && !freshAmbiguous && !ambiguousLocal && !lead?.dotted) {
          for (let i = 0; i < ms.length; i++) {
            const cs = candidates(ms[i].token, e, i, lead, path), best = cs[0], ties = cs.filter(x => x.score === best?.score);
            const unsupportedLetterReset = i === 0 && [ "i", "I" ].includes(ms[i].token) && best?.p.length === 1 && !prev.paths.has(addr(best.p)) && last[0] !== (ms[i].token === "i" ? "h" : "H");
            if (!best || best.score < 2 || unsupportedLetterReset || new Set(ties.map(item => addr(item.p))).size > 1) {
              diag("ambiguous-marker-level", e, ms[i].token + ": " + cs.slice(0, 3).map(x => addr(x.p) + "=" + x.score).join(", "));
              path = [];
              break;
            }
            path = best.p;
          }
        }
        const baseDepth = Math.max(0, path.length - ms.length);
        const inferredUnits = path.length ? ms.map((m, i) => ({
          a: addr(path.slice(0, Math.min(path.length, baseDepth + i + 1))),
          s: m.start,
          e: m.end
        })) : [];
        const units = priorNamed ? [] : anchor?.u?.length && !split ? anchor.u.map(u => relocatedFrom ? {
          ...u,
          a: addr(path.slice(0, tokens(u.a).length))
        } : {
          ...u
        }) : inferredUnits;
        if (!anchor && lead?.rangeEnd && path.length) {
          const endpoint = lead.rangeEnd;
          path = [...path.slice(0, -1), endpoint.token];
          units.push({ a: addr(path), s: endpoint.start, e: endpoint.end });
        }
        if (priorNamed) {
          active = [];
          last = [];
        } else if (path.length) {
          active = path;
          last = path;
        } else if (anchor?.c) {
          active = tokens(anchor.c);
          last = [ ...active ];
        } else if (e.heading && e.noteType && e.noteType !== "ordinary") {
          active = [];
          last = [];
        }
        const p = {
          text: e.text,
          path: path,
          addressable: !!(path.length || units.length) && !priorNamed,
          term: e.term || priorNamed || priorUnaddressed && !!ms.length,
          disabled: e.disabled,
          heading: e.heading,
          indent: Number(anchor?.d) || e.indent,
          elementKind: e.elementKind,
          noteType: e.noteType,
          units: units
        };
        p.context = anchor ? anchor.c || "" : !ms.length ? addr(active) : "";
        if (anchor) {
          p.q = anchor.q || "";
          if (anchor.d !== undefined) p.d = anchor.d;
        }
        if (e.elementKind === "table") {
          p.addressable = false;
          p.path = [];
          p.units = [];
        }
        if (path.length) {
          const n = (occurrences.get(addr(path)) || 0) + 1;
          occurrences.set(addr(path), n);
          if (n > 1) diag("repeated-path-preserved", e, addr(path) + " occurrence " + n);
        }
        paragraphs.push(p);
      }
      for (let i = 0; i < paragraphs.length - 1; i++) {
        const current = paragraphs[i], next = paragraphs[i + 1];
        if (!current.addressable || next.path.length < 2) continue;
        const parent = next.path.slice(0, -1), parentAddress = addr(parent);
        if (parent.length !== current.path.length - 1) continue;
        if (current.units.some(unit => unit.a === parentAddress) || addr(current.path) === parentAddress) continue;
        if (addr(parent.slice(0, -1)) !== addr(current.path.slice(0, parent.length - 1))) continue;
        const marker = "(" + parent.at(-1) + ")";
        let at = current.text.indexOf(marker, current.units.at(-1)?.e || 0);
        while (at >= 0 && !/[.;]\s+$/.test(current.text.slice(0, at))) at = current.text.indexOf(marker, at + marker.length);
        if (at < 0) continue;
        current.units.push({
          a: parentAddress,
          s: at,
          e: at + marker.length
        });
        current.path = parent;
        diagnostics.push({
          code: "inline-parent-marker",
          index: i,
          text: current.text.slice(at, at + 140),
          detail: parentAddress
        });
      }
      return {
        paragraphs: paragraphs,
        diagnostics: diagnostics,
        sourceCount: entries.length,
        resolvedCount: paragraphs.filter(p => p.addressable).length,
        unresolvedCount: diagnostics.filter(x => x.code.startsWith("ambiguous-")).length,
        options: options
      };
    }
    return resolve;
  }
  return {
    createCfrXmlParagraphResolver: createCfrXmlParagraphResolver,
    address: addr,
    tokens: tokens
  };
});
