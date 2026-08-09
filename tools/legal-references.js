"use strict";

const { referenceProperty } = require("./statute-references");

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
    const mapping = context.inaMap?.get(String(inaSection).toLowerCase());
    const targetSection = mapping?.uscSection ? String(mapping.uscSection) : "";
    const targetPath = inaPath;
    const local = targetSection && localUscTarget(context, "8", targetSection, targetPath);
    return { family: "ina", targetKind: local ? "usc" : "ina", targetTitle: "8", targetSection: targetSection || inaSection, targetPath, inaSection, resolution: local ? "local" : "official-source-only", officialUrl: targetSection ? houseSectionUrl("8", targetSection) : "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act" };
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
  if (context.kind === "cfr" && targetTitle === "8") {
    for (const match of input.matchAll(/\bthe Act\b/g)) {
      results.push({
        id: makeId(context, match.index, "context-title8-cfr-the-act"), start: match.index, end: match.index + match[0].length, text: match[0],
        family: "ina", targetKind: "ina", targetTitle: "8", targetSection: "", targetPath: [], resolution: "official-source-only",
        officialUrl: "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act",
        provenance: "deterministic-context", ruleId: "context-title8-cfr-the-act"
      });
    }
  }
  return results;
}

function generatedReferences(text, context, existing = []) {
  const occupied = [...(existing || [])].sort((a, b) => a.start - b.start || a.end - b.end);
  const candidates = [...explicitReferenceCandidates(text, context), ...contextualReferenceCandidates(text, context)]
    .filter(reference => reference.end > reference.start && String(text).slice(reference.start, reference.end) === reference.text)
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.ruleId.localeCompare(b.ruleId));
  for (const candidate of candidates) {
    if (overlaps(candidate, occupied)) continue;
    occupied.push(candidate);
    occupied.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return occupied;
}

function legalReferenceContext(corpus) {
  const uscSections = new Map((corpus.title8?.sections || []).map(section => [`8:${section.section}`, section]));
  const uscPaths = new Set();
  function walkUsc(section, nodes, path = []) {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      uscPaths.add(`${section}:${nodePath.join("/")}`);
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
  return { uscSections, uscPaths, cfrSections, cfrPaths, inaMap };
}

function applyGeneratedLegalReferences(corpus) {
  const shared = legalReferenceContext(corpus);
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
      const context = { kind: "usc", title: "8", section: String(section.section), path: nodePath, sourceId: `usc-${section.section}-${nodePath.join("-")}` };
      attach(node, "heading", context);
      attach(node, "text", context);
      walkUsc(section, node.children, nodePath);
    }
  };
  for (const section of corpus.title8?.sections || []) {
    const context = { kind: "usc", title: "8", section: String(section.section), path: [], sourceId: `usc-${section.section}` };
    attach(section, "heading", context);
    attach(section, "preamble", context);
    attach(section, "sourceCredit", context);
    walkUsc(section, section.body);
    (section.notes || []).forEach((note, index) => { attach(note, "heading", { ...context, sourceId: `usc-${section.section}-note-${index + 1}` }); attach(note, "text", { ...context, sourceId: `usc-${section.section}-note-${index + 1}` }); });
    (section.houseEditorialFootnotes || []).forEach(footnote => attach(footnote, "text", { ...context, sourceId: footnote.id }));
  }
  const attachCfrBlocks = (section, blocks, pathPrefix = []) => {
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || "");
      const context = { kind: "cfr", title: String(section.title), section: String(section.section || ""), path, sourceId: `cfr-${section.id}-${[...pathPrefix, index].join("-")}` };
      attach(block, "x", context);
      if (block.t === "table") {
        (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => attach(cell, "x", { ...context, sourceId: `${context.sourceId}-cell-${rowIndex}-${cellIndex}` })));
      }
      if (block.t === "note") attachCfrBlocks(section, block.blocks, [...pathPrefix, index]);
    });
  };
  for (const section of [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])]) {
    attach(section, "heading", { kind: "cfr", title: String(section.title), section: String(section.section || ""), path: [], sourceId: `cfr-${section.id}-heading`, ...shared });
    attachCfrBlocks(section, section.blocks);
  }
  for (const part of corpus.cfr?.parts || []) {
    const context = { kind: "cfr", title: String(part.title), section: "", path: [], sourceId: `cfr-part-${part.id}` };
    attach(part, "authority", context);
    attach(part, "source", context);
  }
  corpus.legalReferenceMetadata = {
    schemaVersion: 1,
    generatedReferences: generated,
    generatedAtBuild: true,
    runtimeNetworkForPreviews: false,
    rules: ["house-uslm-ref", "explicit-usc", "explicit-ina", "explicit-cfr", "explicit-public-law", "explicit-statutes-at-large", "explicit-federal-register", "context-named-unit", "context-path-this-section", "context-this-unit", "context-title8-cfr-the-act", "ambiguous-antecedent"]
  };
  return corpus;
}

module.exports = {
  applyGeneratedLegalReferences,
  explicitReferenceCandidates,
  generatedReferences,
  legalReferenceContext,
  pathTokens
};
