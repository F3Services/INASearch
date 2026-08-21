(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INASearchLegalReferences = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

function referenceProperty(field) {
  return field === "text" || field === "x" ? (field === "x" ? "xReferences" : "references") : `${field}References`;
}

const LEVELS = ["subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem"];

function canonicalPath(path = []) {
  return path.map(token => `(${token})`).join("");
}

function houseSectionUrl(title, section) {
  return `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title${title}-section${section}`)}`;
}

function ecfrSectionUrl(title, section) {
  const part = String(section || "").split(".")[0];
  return `https://www.ecfr.gov/current/title-${encodeURIComponent(title)}/part-${encodeURIComponent(part)}/section-${encodeURIComponent(section)}`;
}

function govInfoSearchUrl(text) {
  return `https://www.govinfo.gov/app/search/%7B%22query%22%3A%22${encodeURIComponent(String(text || ""))}%22%7D`;
}

function pathTokens(value) {
  return [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
}

function overlaps(reference, occupied) {
  return occupied.some(span => reference.start < span.end && reference.end > span.start);
}

function pathStartsWith(path, prefix) {
  return prefix.length <= path.length && prefix.every((token, index) => String(token).toLowerCase() === String(path[index]).toLowerCase());
}

function isSelfReference(reference, context) {
  if (reference.ruleId === "context-this-unit") return true;
  if (!context.suppressSelfReferences || reference.resolution !== "local") return false;
  const family = context.kind === "cfr" ? "cfr" : "usc";
  return reference.family === family &&
    String(reference.targetTitle || "") === String(context.title || "") &&
    String(reference.targetSection || "") === String(context.section || "") &&
    pathStartsWith(context.path || [], reference.targetPath || []);
}

function retainNavigableReferences(references, context) {
  return references.filter(reference => {
    if (!isSelfReference(reference, context)) return true;
    const audit = context.referenceAudit;
    if (audit) {
      audit.suppressedSelfReferences += 1;
      audit.suppressedByRule[reference.ruleId || "unknown"] = (audit.suppressedByRule[reference.ruleId || "unknown"] || 0) + 1;
      audit.suppressedByFamily[reference.family || "unknown"] = (audit.suppressedByFamily[reference.family || "unknown"] || 0) + 1;
    }
    return false;
  });
}

function makeId(context, start, ruleId, index = 0) {
  return `${context.sourceId || context.kind || "legal"}-${start}-${ruleId}-${index}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function localUscTarget(context, title, section, path) {
  const sectionRecord = context.uscSections?.get(`${title}:${section}`);
  if (!sectionRecord) return false;
  if (!path.length) return true;
  return context.uscPaths?.has(`${section}:${path.join("/")}`) || false;
}

function localCfrTarget(context, title, section, path) {
  if (!context.cfrSections?.has(`${title}:${section}`)) return false;
  return !path.length || context.cfrPaths?.has(`${title}:${section}:${path.join("/")}`) || false;
}

function cfrHierarchyNumber(record, kind) {
  return String((record?.hierarchy || []).find(item => item.type === kind)?.number || "");
}

function cfrPartNumber(record) {
  return String(record?.part || cfrHierarchyNumber(record, "part") || String(record?.partId || "").split(":").at(-1) || "");
}

function cfrChapterNumber(record) {
  return String(record?.chapter || cfrHierarchyNumber(record, "chapter") || "");
}

function policyScopeMatches(scope, context) {
  const match = scope?.match || {};
  if (String(match.title || "") !== String(context.title || "")) return false;
  if (match.chapter && String(match.chapter) !== String(context.chapter || "")) return false;
  if (Array.isArray(match.parts) && !match.parts.map(String).includes(String(context.part || ""))) return false;
  return Boolean(match.chapter || match.parts?.length);
}

function cfrContextUsesInaAct(context) {
  if (context.kind !== "cfr") return false;
  return (context.legalReferencePolicy?.scopes || []).some(scope => policyScopeMatches(scope, context));
}

function cfrRecordText(record) {
  const values = [record?.heading || ""];
  const visit = blocks => {
    for (const block of blocks || []) {
      if (block.x) values.push(block.x);
      if (block.t === "table") {
        for (const row of block.rows || []) for (const cell of row || []) if (cell?.x) values.push(cell.x);
      }
      if (block.blocks) visit(block.blocks);
    }
  };
  visit(record?.blocks);
  return values.join("\n");
}

function validateLegalReferencePolicy(corpus) {
  const policy = corpus?.legalReferencePolicy;
  if (!policy) return { schemaVersion: 1, scopes: 0 };
  if (policy.schemaVersion !== 1 || !policy.reviewedAt || !Array.isArray(policy.scopes) || !policy.scopes.length) {
    throw new Error("The legal-reference policy is missing its reviewed schema metadata.");
  }
  const sections = new Map((corpus.cfr?.sections || []).map(section => [section.id, section]));
  const records = [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])];
  const ids = new Set();
  for (const scope of policy.scopes) {
    if (!scope?.id || ids.has(scope.id)) throw new Error(`Duplicate or missing legal-reference policy scope id ${scope?.id || "(missing)"}.`);
    ids.add(scope.id);
    const basis = scope.basis || {};
    if (!basis.citation || !basis.sectionId || !basis.excerpt || !/^https:\/\//.test(basis.sourceUrl || "")) {
      throw new Error(`Legal-reference policy scope ${scope.id} lacks complete source provenance.`);
    }
    const source = sections.get(basis.sectionId);
    if (!source) throw new Error(`Legal-reference policy source ${basis.sectionId} does not exist.`);
    if (!cfrRecordText(source).includes(basis.excerpt)) {
      throw new Error(`Legal-reference policy excerpt for ${scope.id} is not exact source text.`);
    }
    const covered = records.filter(record => policyScopeMatches(scope, {
      title: String(record.title || ""), part: cfrPartNumber(record), chapter: cfrChapterNumber(record)
    }));
    if (!covered.length) throw new Error(`Legal-reference policy scope ${scope.id} covers no CFR records.`);
  }
  return { schemaVersion: policy.schemaVersion, scopes: policy.scopes.length, reviewedAt: policy.reviewedAt };
}

function inaReferenceTarget(context, inaSection, targetPath) {
  const mapping = context.inaMap?.get(String(inaSection).toLowerCase());
  const targetSection = mapping?.uscSection ? String(mapping.uscSection) : "";
  const local = targetSection && localUscTarget(context, "8", targetSection, targetPath);
  return {
    family: "ina",
    targetKind: local ? "usc" : "ina",
    targetTitle: "8",
    targetSection: targetSection || inaSection,
    targetPath,
    inaSection,
    resolution: local ? "local" : "official-source-only",
    officialUrl: targetSection
      ? houseSectionUrl("8", targetSection)
      : "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act"
  };
}

function resolvedInaContinuationPath(context, inaSection, basePath, continuationPath) {
  const mapping = context.inaMap?.get(String(inaSection).toLowerCase());
  const targetSection = mapping?.uscSection ? String(mapping.uscSection) : "";
  if (!targetSection) return null;
  for (let retained = basePath.length; retained >= 0; retained--) {
    const candidate = [...basePath.slice(0, retained), ...continuationPath];
    if (localUscTarget(context, "8", targetSection, candidate)) return candidate;
  }
  return null;
}

function parseInaActCitationList(input, start, end) {
  const citations = [];
  let cursor = start;
  let pendingPrefixStart = null;
  let absoluteCitations = 0;
  while (cursor < end) {
    const remainder = input.slice(cursor, end);
    const whitespace = remainder.match(/^\s+/);
    if (whitespace) { cursor += whitespace[0].length; continue; }
    const sectionWord = remainder.match(/^sections?\b/i);
    if (sectionWord) {
      if (pendingPrefixStart !== null) return null;
      pendingPrefixStart = cursor;
      cursor += sectionWord[0].length;
      continue;
    }
    const connector = remainder.match(/^(?:and|or|through|to|respectively)\b/i);
    if (connector) { cursor += connector[0].length; continue; }
    const punctuation = remainder.match(/^[,;:\-–—]+/);
    if (punctuation) { cursor += punctuation[0].length; continue; }
    const absolute = remainder.match(/^\d+[A-Za-z-]*(?:\s*\([A-Za-z0-9-]+\))*/);
    if (absolute) {
      citations.push({
        start: pendingPrefixStart ?? cursor,
        end: cursor + absolute[0].length,
        inaSection: absolute[0].match(/^\d+[A-Za-z-]*/)[0],
        path: pathTokens(absolute[0]),
        relative: false
      });
      absoluteCitations++;
      pendingPrefixStart = null;
      cursor += absolute[0].length;
      continue;
    }
    const continuation = remainder.match(/^(?:\([A-Za-z0-9-]+\))(?:\s*\([A-Za-z0-9-]+\))*/);
    if (continuation) {
      citations.push({
        start: pendingPrefixStart ?? cursor,
        end: cursor + continuation[0].length,
        path: pathTokens(continuation[0]),
        relative: true
      });
      pendingPrefixStart = null;
      cursor += continuation[0].length;
      continue;
    }
    return null;
  }
  return absoluteCitations && pendingPrefixStart === null ? citations : null;
}

function inaActReferenceCandidates(text, context) {
  const input = String(text || "");
  const results = [];
  if (context.kind !== "cfr") return results;
  const suffixPattern = /\bof\s+(?:(the)\s+)?(?:(Immigration\s+and\s+Nationality)\s+)?Act\b(?!\s+of\b)/gi;
  for (const suffix of input.matchAll(suffixPattern)) {
    const explicitlyIna = Boolean(suffix[2]);
    if (!explicitlyIna && !cfrContextUsesInaAct(context)) continue;
    const windowStart = Math.max(0, suffix.index - 420);
    const prefix = input.slice(windowStart, suffix.index);
    const starts = [...prefix.matchAll(/\bsections?\b/gi)].map(match => windowStart + match.index);
    let parsed = null;
    for (const start of starts) {
      const candidate = parseInaActCitationList(input, start, suffix.index);
      if (candidate) { parsed = candidate; break; }
    }
    if (!parsed) continue;
    let currentSection = "";
    let currentPath = [];
    parsed.forEach((citation, index) => {
      let targetPath = citation.path;
      if (citation.relative) {
        if (!currentSection) return;
        targetPath = resolvedInaContinuationPath(context, currentSection, currentPath, citation.path);
        if (!targetPath) return;
      } else {
        currentSection = citation.inaSection;
      }
      currentPath = targetPath;
      results.push({
        id: makeId(context, citation.start, "context-cfr-ina-act-section", index),
        start: citation.start,
        end: citation.end,
        text: input.slice(citation.start, citation.end),
        provenance: "deterministic-context",
        ruleId: "context-cfr-ina-act-section",
        ...inaReferenceTarget(context, currentSection, targetPath)
      });
    });
  }
  return results;
}

function explicitReferenceCandidates(text, context) {
  const input = String(text || "");
  const results = [];
  const addMatches = (pattern, ruleId, build) => {
    for (const match of input.matchAll(pattern)) {
      const built = build(match);
      if (!built) continue;
      const start = match.index + (built.relativeStart || 0);
      const value = built.text || match[0].slice(built.relativeStart || 0, built.relativeEnd);
      results.push({
        id: makeId(context, start, ruleId),
        start,
        end: start + value.length,
        text: value,
        provenance: "deterministic-parser",
        ruleId,
        ...built,
        relativeStart: undefined,
        relativeEnd: undefined
      });
    }
  };

  addMatches(/\b(\d+)\s+U\.?\s*S\.?\s*C\.?\s*(?:§{1,2}\s*)?(\d+[A-Za-z-]*)((?:\([A-Za-z0-9-]+\))*)/gi, "explicit-usc", match => {
    const title = match[1], section = match[2], targetPath = pathTokens(match[3]);
    const local = localUscTarget(context, title, section, targetPath);
    return { family: "usc", targetKind: "usc", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: houseSectionUrl(title, section) };
  });
  addMatches(/\b(\d+)\s+C\.?\s*F\.?\s*R\.?\s*(?:§{1,2}\s*)?(\d+(?:\.\d+)?[A-Za-z-]*)((?:\([A-Za-z0-9-]+\))*)/gi, "explicit-cfr", match => {
    const title = match[1], section = match[2], targetPath = pathTokens(match[3]);
    const local = localCfrTarget(context, title, section, targetPath);
    return { family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: ecfrSectionUrl(title, section) };
  });
  addMatches(/\bINA\s*(?:§|section)?\s*(\d+[A-Za-z-]*)((?:\([A-Za-z0-9-]+\))*)/gi, "explicit-ina", match => {
    const inaSection = match[1], inaPath = pathTokens(match[2]);
    return inaReferenceTarget(context, inaSection, inaPath);
  });
  addMatches(/\bPub(?:lic)?\.?\s+L(?:aw)?\.?\s+(\d+)[–—-](\d+)\b/gi, "explicit-public-law", match => ({
    family: "public-law", targetKind: "public-law", targetCongress: match[1], targetLaw: match[2], targetPath: [], resolution: "official-source-only", officialUrl: `https://www.govinfo.gov/app/details/PLAW-${match[1]}publ${match[2]}`
  }));
  addMatches(/\b(\d+[A-Za-z]?)\s+Stat\.?\s+([\d,]+(?:[–—-]\d+)?)\b/gi, "explicit-statutes-at-large", match => ({
    family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: match[1], targetPage: match[2].replace(/,/g, ""), targetPath: [], resolution: "official-source-only", officialUrl: `https://www.govinfo.gov/app/details/STATUTE-${match[1]}/STATUTE-${match[1]}-Pg${match[2].replace(/,/g, "")}`
  }));
  addMatches(/\b(\d+)\s+(?:Fed\.?\s+Reg\.?|F\.?R\.?)\s+([\d,]+)\b/gi, "explicit-federal-register", match => ({
    family: "federal-register", targetKind: "federal-register", targetVolume: match[1], targetPage: match[2].replace(/,/g, ""), targetPath: [], resolution: "official-source-only", officialUrl: govInfoSearchUrl(match[0])
  }));
  return results;
}

function contextualReferenceCandidates(text, context) {
  const input = String(text || "");
  const results = [];
  const sourcePath = context.path || [];
  const localCheck = context.kind === "cfr" ? localCfrTarget : localUscTarget;
  const targetTitle = String(context.title || "8");
  const targetSection = String(context.section || "");
  const officialUrl = context.kind === "cfr" ? ecfrSectionUrl(targetTitle, targetSection) : houseSectionUrl(targetTitle, targetSection);
  const add = (start, end, path, ruleId, index = 0) => {
    const local = targetSection && localCheck(context, targetTitle, targetSection, path);
    results.push({
      id: makeId(context, start, ruleId, index), start, end, text: input.slice(start, end),
      family: context.kind === "cfr" ? "cfr" : "usc", targetKind: context.kind === "cfr" ? "cfr" : "usc",
      targetTitle, targetSection, targetPath: path, resolution: local ? "local" : "unresolved", officialUrl,
      provenance: "deterministic-context", ruleId
    });
  };

  const named = /\b(subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\s+((?:\([A-Za-z0-9-]+\))(?:\s*(?:,|and|or|through|to)\s*\([A-Za-z0-9-]+\))*)\s+of\s+this\s+(section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/gi;
  for (const match of input.matchAll(named)) {
    const targetLevel = LEVELS.indexOf(match[1].toLowerCase().replace(/s$/, ""));
    const containerName = match[3].toLowerCase();
    const containerDepth = containerName === "section" ? 0 : LEVELS.indexOf(containerName) + 1;
    if (targetLevel < 0 || containerDepth < 0 || targetLevel + 1 !== containerDepth + 1) continue;
    const base = sourcePath.slice(0, containerDepth);
    const listOffset = match.index + match[0].indexOf(match[2]);
    let itemIndex = 0;
    for (const item of match[2].matchAll(/\(([A-Za-z0-9-]+)\)/g)) {
      add(listOffset + item.index, listOffset + item.index + item[0].length, [...base, item[1]], "context-named-unit", itemIndex++);
    }
  }
  for (const match of input.matchAll(/((?:\([A-Za-z0-9-]+\)){1,7})\s+of\s+this\s+section\b/gi)) {
    add(match.index, match.index + match[1].length, pathTokens(match[1]), "context-path-this-section");
  }
  for (const match of input.matchAll(/\bthis\s+(section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/gi)) {
    const level = match[1].toLowerCase() === "section" ? 0 : LEVELS.indexOf(match[1].toLowerCase()) + 1;
    if (level < 0) continue;
    add(match.index, match.index + match[0].length, sourcePath.slice(0, level), "context-this-unit");
  }
  for (const match of input.matchAll(/\b(?:such|preceding|following)\s+(?:subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/gi)) {
    results.push({
      id: makeId(context, match.index, "ambiguous-antecedent"), start: match.index, end: match.index + match[0].length, text: match[0],
      family: context.kind === "cfr" ? "cfr" : "usc", targetKind: context.kind === "cfr" ? "cfr" : "usc",
      targetTitle, targetSection, targetPath: [], resolution: "unresolved", officialUrl,
      provenance: "deterministic-context", ruleId: "ambiguous-antecedent"
    });
  }
  if (context.kind === "cfr" && cfrContextUsesInaAct(context)) {
    for (const match of input.matchAll(/\bthe Act\b/gi)) {
      if (/^\s+(?:of|entitled|approved|known\s+as|called)\b/i.test(input.slice(match.index + match[0].length))) continue;
      results.push({
        id: makeId(context, match.index, "context-cfr-the-act"), start: match.index, end: match.index + match[0].length, text: match[0],
        family: "ina", targetKind: "ina", targetTitle: "8", targetSection: "", targetPath: [], resolution: "official-source-only",
        officialUrl: "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act",
        provenance: "reviewed-semantic-policy", ruleId: "context-cfr-the-act",
        policyScopeId: (context.legalReferencePolicy?.scopes || []).find(scope => policyScopeMatches(scope, context))?.id || ""
      });
    }
  }
  return results;
}

function generatedReferences(text, context, existing = []) {
  const occupied = retainNavigableReferences([...(existing || [])], context).sort((a, b) => a.start - b.start || a.end - b.end);
  const candidates = retainNavigableReferences([...explicitReferenceCandidates(text, context), ...inaActReferenceCandidates(text, context), ...contextualReferenceCandidates(text, context)]
    .filter(reference => reference.end > reference.start && String(text).slice(reference.start, reference.end) === reference.text)
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.ruleId.localeCompare(b.ruleId)), context);
  for (const candidate of candidates) {
    if (overlaps(candidate, occupied)) continue;
    occupied.push(candidate);
    occupied.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return occupied;
}

function legalReferenceContext(corpus) {
  validateLegalReferencePolicy(corpus);
  const uscSections = new Map((corpus.title8?.sections || []).map(section => [`8:${section.section}`, section]));
  const uscAliases = new Map();
  for (const row of corpus.inaCrosswalk || []) {
    if (!row.uscSection || !row.localSection) continue;
    const record = uscSections.get(`8:${row.localSection}`);
    if (!record) throw new Error(`INA ${row.inaSection} local section ${row.localSection} does not exist.`);
    uscSections.set(`8:${row.uscSection}`, record);
    if (!uscAliases.has(String(record.section))) uscAliases.set(String(record.section), new Set());
    uscAliases.get(String(record.section)).add(String(row.uscSection));
  }
  const uscPaths = new Set();
  function walkUsc(section, nodes, path = []) {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      uscPaths.add(`${section}:${nodePath.join("/")}`);
      for (const alias of uscAliases.get(String(section)) || []) uscPaths.add(`${alias}:${nodePath.join("/")}`);
      walkUsc(section, node.children, nodePath);
    }
  }
  for (const section of corpus.title8?.sections || []) walkUsc(String(section.section), section.body);
  const cfrSections = new Map((corpus.cfr?.sections || []).map(section => [`${section.title}:${section.section}`, section]));
  const cfrPaths = new Set();
  const collectCfr = section => {
    const visit = blocks => {
      for (const block of blocks || []) {
        for (const value of [block.a, ...(block.u || []).map(unit => unit.a)]) {
          const tokens = pathTokens(value);
          if (tokens.length) cfrPaths.add(`${section.title}:${section.section}:${tokens.join("/")}`);
        }
        if (block.t === "note") visit(block.blocks);
      }
    };
    visit(section.blocks);
  };
  for (const section of corpus.cfr?.sections || []) collectCfr(section);
  const inaMap = new Map((corpus.inaCrosswalk || []).map(row => [String(row.inaSection || "").toLowerCase(), row]));
  return { uscSections, uscPaths, cfrSections, cfrPaths, inaMap, legalReferencePolicy: corpus.legalReferencePolicy || null };
}

function applyGeneratedLegalReferences(corpus) {
  const referenceAudit = { suppressedSelfReferences: 0, suppressedByRule: {}, suppressedByFamily: {} };
  const shared = { ...legalReferenceContext(corpus), referenceAudit };
  let generated = 0;
  const attach = (source, field, context) => {
    if (!source || !Object.hasOwn(source, field) || !source[field]) return;
    const property = referenceProperty(field);
    const before = source[property]?.length || 0;
    source[property] = generatedReferences(source[field], { ...shared, ...context }, source[property] || []);
    generated += source[property].length - before;
  };
  const walkUsc = (section, nodes, path = []) => {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const context = { kind: "usc", title: "8", section: String(section.section), path: nodePath, sourceId: `usc-${section.section}-${nodePath.join("-")}`, suppressSelfReferences: true };
      attach(node, "heading", context);
      attach(node, "text", context);
      walkUsc(section, node.children, nodePath);
    }
  };
  for (const section of corpus.title8?.sections || []) {
    const context = { kind: "usc", title: "8", section: String(section.section), path: [], sourceId: `usc-${section.section}` };
    attach(section, "heading", { ...context, suppressSelfReferences: true });
    attach(section, "preamble", { ...context, suppressSelfReferences: true });
    attach(section, "sourceCredit", context);
    walkUsc(section, section.body);
    (section.notes || []).forEach((note, index) => { attach(note, "heading", { ...context, sourceId: `usc-${section.section}-note-${index + 1}` }); attach(note, "text", { ...context, sourceId: `usc-${section.section}-note-${index + 1}` }); });
    (section.houseEditorialFootnotes || []).forEach(footnote => attach(footnote, "text", { ...context, sourceId: footnote.id }));
  }
  const attachCfrBlocks = (section, blocks, pathPrefix = []) => {
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || "");
      const context = { kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section), section: String(section.section || ""), path, sourceId: `cfr-${section.id}-${[...pathPrefix, index].join("-")}`, suppressSelfReferences: true };
      attach(block, "x", context);
      if (block.t === "table") {
        (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => attach(cell, "x", { ...context, sourceId: `${context.sourceId}-cell-${rowIndex}-${cellIndex}` })));
      }
      if (block.t === "note") attachCfrBlocks(section, block.blocks, [...pathPrefix, index]);
    });
  };
  for (const section of [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])]) {
    attach(section, "heading", { kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section), section: String(section.section || ""), path: [], sourceId: `cfr-${section.id}-heading`, suppressSelfReferences: true, ...shared });
    attachCfrBlocks(section, section.blocks);
  }
  for (const part of corpus.cfr?.parts || []) {
    const context = { kind: "cfr", title: String(part.title), part: cfrPartNumber(part), chapter: cfrChapterNumber(part), section: "", path: [], sourceId: `cfr-part-${part.id}` };
    attach(part, "heading", context);
    attach(part, "authority", context);
    attach(part, "source", context);
  }
  corpus.legalReferenceMetadata = {
    schemaVersion: 2,
    generatedReferences: generated,
    suppressedSelfReferences: referenceAudit.suppressedSelfReferences,
    suppressedSelfReferencesByRule: referenceAudit.suppressedByRule,
    suppressedSelfReferencesByFamily: referenceAudit.suppressedByFamily,
    generatedAtBuild: true,
    runtimeNetworkForPreviews: false,
    policySchemaVersion: corpus.legalReferencePolicy?.schemaVersion || null,
    policyReviewedAt: corpus.legalReferencePolicy?.reviewedAt || null,
    policyScopes: corpus.legalReferencePolicy?.scopes?.length || 0,
    rules: ["house-uslm-ref", "explicit-usc", "explicit-ina", "explicit-cfr", "explicit-public-law", "explicit-statutes-at-large", "explicit-federal-register", "context-cfr-ina-act-section", "context-named-unit", "context-path-this-section", "context-cfr-the-act", "ambiguous-antecedent"]
  };
  return corpus;
}

function applyCfrReferences(corpus, changedPartIds) {
  const changed = new Set([...(changedPartIds || [])].map(String));
  const referenceAudit = { suppressedSelfReferences: 0, suppressedByRule: {}, suppressedByFamily: {} };
  const shared = { ...legalReferenceContext(corpus), referenceAudit };
  let fields = 0;
  let references = 0;
  const attach = (source, field, context) => {
    if (!source || !Object.hasOwn(source, field) || !source[field]) return;
    const property = referenceProperty(field);
    source[property] = generatedReferences(source[field], { ...shared, ...context }, []);
    fields += 1;
    references += source[property].length;
  };
  const attachBlocks = (section, blocks, pathPrefix = []) => {
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || "");
      const context = {
        kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section),
        section: String(section.section || ""), path, sourceId: `runtime-cfr-${section.id}-${[...pathPrefix, index].join("-")}`,
        suppressSelfReferences: true
      };
      attach(block, "x", context);
      if (block.t === "table") {
        (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
          attach(cell, "x", { ...context, sourceId: `${context.sourceId}-cell-${rowIndex}-${cellIndex}` });
        }));
      }
      if (block.t === "note") attachBlocks(section, block.blocks, [...pathPrefix, index]);
    });
  };
  const records = [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])].filter(record => changed.has(String(record.partId)));
  for (const record of records) {
    const context = {
      kind: "cfr", title: String(record.title), part: cfrPartNumber(record), chapter: cfrChapterNumber(record),
      section: String(record.section || ""), path: [], sourceId: `runtime-cfr-${record.id}-heading`, suppressSelfReferences: true
    };
    attach(record, "heading", context);
    attachBlocks(record, record.blocks);
  }
  for (const part of corpus.cfr?.parts || []) {
    if (!changed.has(String(part.id))) continue;
    const context = {
      kind: "cfr", title: String(part.title), part: cfrPartNumber(part), chapter: cfrChapterNumber(part),
      section: "", path: [], sourceId: `runtime-cfr-part-${part.id}`
    };
    attach(part, "heading", context);
    attach(part, "authority", context);
    attach(part, "source", context);
  }
  return {
    engineVersion: 1,
    changedParts: [...changed].sort(),
    fields,
    references,
    suppressedSelfReferences: referenceAudit.suppressedSelfReferences
  };
}

return {
  applyCfrReferences,
  applyGeneratedLegalReferences,
  explicitReferenceCandidates,
  generatedReferences,
  inaActReferenceCandidates,
  legalReferenceContext,
  pathTokens,
  validateLegalReferencePolicy
};
});
