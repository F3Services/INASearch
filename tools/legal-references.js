(function (root, factory) {
  const nodeRuntime = typeof module === "object" && module.exports;
  const embeddedReferences = nodeRuntime ? require("./embedded-references") : root?.INASearchEmbeddedReferences;
  const textSha256 = nodeRuntime
    ? value => require("crypto").createHash("sha256").update(String(value || ""), "utf8").digest("hex")
    : null;
  const api = factory(embeddedReferences, textSha256);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INASearchLegalReferences = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (EmbeddedReferences, textSha256) {
"use strict";

function referenceProperty(field) {
  return field === "text" || field === "x" ? (field === "x" ? "xReferences" : "references") : `${field}References`;
}

const LEVELS = ["subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem"];
const EMBEDDED_RESOLVER_VERSION = "embedded-v1";

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

function unitKind(value) {
  const singular = String(value || "").toLowerCase().replace(/s$/, "");
  return singular === "section" || LEVELS.includes(singular) ? singular : "";
}

function unitTypeCode(kind) {
  return kind === "section" ? -1 : LEVELS.indexOf(unitKind(kind));
}

function unitPathKey(title, section, path = []) {
  return `${title}:${section}:${path.map(String).join("/")}`;
}

function stableTextFingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sourceTextHash(value) {
  return textSha256 ? textSha256(value) : stableTextFingerprint(value);
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

function validateEmbeddedReferenceExceptions(source) {
  if (!source) return { schemaVersion: 1, exceptions: 0 };
  if (source.schemaVersion !== 1 || source.resolverVersion !== EMBEDDED_RESOLVER_VERSION || !source.reviewedAt || !Array.isArray(source.exceptions)) {
    throw new Error("The embedded-reference exception manifest lacks valid schema metadata.");
  }
  const ids = new Set();
  for (const exception of source.exceptions) {
    if (!exception?.id || ids.has(exception.id)) throw new Error(`Duplicate or missing embedded-reference exception id ${exception?.id || "(missing)"}.`);
    ids.add(exception.id);
    if (!exception.sourceArtifact || !exception.sourceId || !exception.sourceField || !/^[a-f0-9]{64}$/.test(exception.sourceTextSha256 || "") ||
        !Number.isInteger(exception.start) || !Number.isInteger(exception.end) || exception.end <= exception.start || !exception.text ||
        !exception.reason || !exception.officialUrl || !exception.reviewedAt || !exception.target?.family || !exception.target?.section || !Array.isArray(exception.target.path)) {
      throw new Error(`Embedded-reference exception ${exception.id} is incomplete.`);
    }
  }
  return { schemaVersion: source.schemaVersion, resolverVersion: source.resolverVersion, exceptions: source.exceptions.length, reviewedAt: source.reviewedAt };
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

function embeddedUnitPhrases(text) {
  const input = String(text || "");
  const phrases = [];
  if (!EmbeddedReferences?.parseUnitList) return phrases;
  const pattern = /\b(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi;
  for (const match of input.matchAll(pattern)) {
    const kind = unitKind(match[1]);
    const list = EmbeddedReferences.parseUnitList(input, match.index + match[0].length);
    if (!kind || !list) continue;
    phrases.push({
      type: "direct-unit-list",
      start: match.index,
      end: list.end,
      text: input.slice(match.index, list.end),
      unitKind: kind,
      unitPlural: /s$/i.test(match[1]),
      unitSpan: { start: match.index, end: match.index + match[0].length, text: match[0] },
      list,
      members: list.members
    });
  }
  return phrases;
}

function embeddedTargetExists(context, target) {
  if (target.family === "cfr") return localCfrTarget(context, target.title, target.section, target.path);
  return localUscTarget(context, target.title, target.section, target.path);
}

function embeddedTargetUnitMatches(context, target, baseDepth, expectedKind) {
  if (target.family !== "usc") return true;
  const record = context.uscUnits?.get(unitPathKey(target.title, target.section, target.path));
  if (!record) return true;
  const expected = unitTypeCode(expectedKind);
  return expected < 0 || record.unitTypes?.[baseDepth] === expected;
}

function currentContainerTarget(context, kind) {
  const family = context.kind === "cfr" ? "cfr" : "usc";
  const target = { family, title: String(context.title || "8"), section: String(context.section || ""), path: [] };
  if (kind === "section") return target;
  const sourcePath = (context.path || []).map(String);
  if (family === "cfr") return { ...target, path: sourcePath };
  const expected = unitTypeCode(kind);
  for (let length = sourcePath.length; length > 0; length--) {
    const path = sourcePath.slice(0, length);
    const record = context.uscUnits?.get(unitPathKey(target.title, target.section, path));
    if (record?.unitType === expected) return { ...target, path };
  }
  return null;
}

function relativeSiblingTarget(context, kind, direction) {
  const family = context.kind === "cfr" ? "cfr" : "usc";
  const title = String(context.title || "8");
  const section = String(context.section || "");
  const sourcePath = (context.path || []).map(String);
  if (!section || !sourcePath.length) return null;
  let currentPath = null;
  let siblings = null;
  if (family === "usc") {
    const expected = unitTypeCode(kind);
    for (let length = sourcePath.length; length > 0; length--) {
      const path = sourcePath.slice(0, length);
      if (context.uscUnits?.get(unitPathKey(title, section, path))?.unitType !== expected) continue;
      currentPath = path;
      siblings = context.uscSiblingLists?.get(`${unitPathKey(title, section, path.slice(0, -1))}:${expected}`) || null;
      break;
    }
  } else if (unitKind(kind) === "paragraph") {
    currentPath = sourcePath;
    siblings = context.cfrSiblingLists?.get(unitPathKey(title, section, sourcePath.slice(0, -1))) || null;
  }
  if (!currentPath || !siblings?.length) return null;
  const identity = currentPath.join("/").toLowerCase();
  const index = siblings.findIndex(path => path.join("/").toLowerCase() === identity);
  const offset = direction === "preceding" ? -1 : 1;
  const sibling = index >= 0 ? siblings[index + offset] : null;
  return sibling ? { family, title, section, path: [...sibling] } : null;
}

function parentContainerKind(kind) {
  const normalized = unitKind(kind);
  if (normalized === "section") return "";
  const level = LEVELS.indexOf(normalized);
  return level <= 0 ? "section" : LEVELS[level - 1];
}

function embeddedOfficialUrl(target) {
  return target.family === "cfr" ? ecfrSectionUrl(target.title, target.section) : houseSectionUrl(target.title, target.section);
}

function frameIdentity(frame) {
  return `${frame.kind}|${frame.family}|${frame.title}|${frame.section}|${frame.path.join("/")}|${frame.sourceId}|${frame.end}`;
}

function addEmbeddedFrame(state, frame) {
  if (!frame?.kind || !frame.section || !Array.isArray(frame.path)) return;
  const identity = frameIdentity(frame);
  if ((state.frames || []).some(item => frameIdentity(item) === identity)) return;
  state.frames.push({ ...frame, path: [...frame.path] });
}

function referenceFrame(reference, context) {
  if (!reference?.targetSection) return null;
  const match = String(reference.text || "").match(/\b(section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)s?\b/i);
  const kind = unitKind(match?.[1]);
  if (!kind) return null;
  const family = reference.family === "cfr" ? "cfr" : "usc";
  return {
    kind,
    family,
    title: String(reference.targetTitle || (family === "usc" ? "8" : context.title || "")),
    section: String(reference.targetSection),
    path: [...(reference.targetPath || [])].map(String),
    sourceId: context.sourceId,
    sourceField: context.sourceField || "text",
    start: reference.start,
    end: reference.end,
    text: reference.text,
    ruleId: reference.ruleId || "source-reference"
  };
}

function findEmbeddedAntecedent(state, kind, sourceId, before) {
  const compatible = (state.frames || []).filter(frame => frame.kind === kind && (frame.sourceId !== sourceId || frame.end <= before));
  if (!compatible.length) return null;
  return compatible.at(-1);
}

function recordEmbeddedAudit(context, status, candidate, details = {}) {
  const audit = context.referenceAudit;
  if (!audit) return;
  audit.embeddedCandidates = Number(audit.embeddedCandidates || 0) + 1;
  audit.embeddedByStatus ||= {};
  audit.embeddedByRule ||= {};
  audit.embeddedIssues ||= [];
  audit.embeddedByStatus[status] = (audit.embeddedByStatus[status] || 0) + 1;
  const ruleId = details.ruleId || candidate.ruleId || "embedded-unknown";
  audit.embeddedByRule[ruleId] = (audit.embeddedByRule[ruleId] || 0) + 1;
  if (status === "ambiguous" || status === "unresolved") {
    audit.embeddedIssues.push({
      sourceId: context.sourceId,
      sourceField: context.sourceField || "text",
      start: candidate.start,
      end: candidate.end,
      text: candidate.text,
      status,
      ruleId,
      reason: details.reason || "no-unique-target",
      candidates: details.candidates || []
    });
  }
}

function embeddedEvidence(context, member, candidate, target, base, ruleId) {
  const sourceArtifact = context.kind === "usc"
    ? (context.uscSourceArtifact || "house-title-8-xml")
    : (context.cfrSourceArtifacts?.get(`${context.title}:${context.part || ""}`) || context.cfrSourceArtifacts?.get(`${context.title}:*`) || `ecfr-${context.title}-${context.section}`);
  return {
    resolverVersion: EMBEDDED_RESOLVER_VERSION,
    ruleId,
    sourceArtifact,
    sourceId: context.sourceId,
    sourceField: context.sourceField || "text",
    sourceTextSha256: context.sourceTextSha256 || sourceTextHash(context.sourceText || ""),
    sourceSpan: { start: member.start, end: member.end, text: member.text },
    parsedUnit: candidate.unitKind,
    relativePath: [...member.tokens],
    base: base ? { kind: base.kind, path: [...base.path], sourceId: base.sourceId, start: base.start, end: base.end, text: base.text } : null,
    target: { family: target.family, title: target.title, section: target.section, path: [...target.path] },
    validation: {
      sectionExists: Boolean(target.section),
      pathExists: embeddedTargetExists(context, target),
      unitCompatible: embeddedTargetUnitMatches(context, target, base?.path?.length || 0, candidate.unitKind),
      unique: true
    }
  };
}

function embeddedExceptionFor(context, member) {
  const hash = context.sourceTextSha256 || sourceTextHash(context.sourceText || "");
  const exception = [...(context.embeddedExceptions?.values?.() || [])].find(exception =>
    exception.sourceId === context.sourceId && exception.sourceField === (context.sourceField || "text") &&
    exception.sourceTextSha256 === hash && exception.start === member.start && exception.end === member.end && exception.text === member.text
  ) || null;
  if (exception) context.embeddedExceptionUsage?.add(exception.id);
  return exception;
}

function embeddedReferenceCandidates(text, context, anchorReferences = []) {
  const input = String(text || "");
  if (!EmbeddedReferences?.parseEmbeddedReferences) return [];
  const parsed = EmbeddedReferences.parseEmbeddedReferences(input);
  const direct = embeddedUnitPhrases(input);
  const state = context.embeddedState || { frames: [] };
  if (!Array.isArray(state.frames)) state.frames = [];
  for (const reference of anchorReferences) {
    const frame = referenceFrame(reference, context);
    if (frame) addEmbeddedFrame(state, frame);
  }

  const results = [];
  const resolved = new Map();
  const resolving = new Set();
  const candidateAt = new Map(parsed.map(candidate => [candidate.start, candidate]));

  const targetFrom = (family, title, section, path) => ({ family, title: String(title || ""), section: String(section || ""), path: path.map(String) });
  const makeReference = (member, candidate, target, base, ruleId, index) => {
    const exception = embeddedExceptionFor(context, member);
    if (exception) {
      target = targetFrom(exception.target.family, exception.target.title || context.title, exception.target.section, exception.target.path);
      ruleId = "embedded-exception";
    }
    if (!target.section) return null;
    const local = embeddedTargetExists(context, target);
    const compatible = embeddedTargetUnitMatches(context, target, base?.path?.length || 0, candidate.unitKind);
    if (local && !compatible && !exception) return null;
    const reference = {
      id: makeId(context, member.start, ruleId, index),
      start: member.start,
      end: member.end,
      text: member.text,
      family: target.family,
      targetKind: target.family,
      targetTitle: target.title,
      targetSection: target.section,
      targetPath: [...target.path],
      resolution: local ? "local" : "official-source-only",
      officialUrl: exception?.officialUrl || embeddedOfficialUrl(target),
      provenance: exception ? "reviewed-exception" : "deterministic-context",
      ruleId,
      evidenceRecord: embeddedEvidence(context, member, candidate, target, base, ruleId)
    };
    return reference;
  };

  const auditResolution = (candidate, references, ruleId) => {
    if (references.length !== candidate.members.length) {
      recordEmbeddedAudit(context, "unresolved", candidate, { ruleId, reason: "target-validation-failed" });
      return;
    }
    const local = references.every(reference => reference.resolution === "local");
    recordEmbeddedAudit(context, local ? "resolved-local" : "resolved-official-source-only", candidate, { ruleId });
  };

  const resolveCandidate = candidate => {
    if (resolved.has(candidate)) return resolved.get(candidate);
    if (resolving.has(candidate)) return null;
    resolving.add(candidate);
    let base = null;
    let ruleId = "embedded-explicit-container";
    if (candidate.anaphorType === "this") {
      base = currentContainerTarget(context, candidate.baseKind);
      if (base) Object.assign(base, { kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.base.start, end: candidate.base.end, text: candidate.base.text });
      ruleId = "embedded-this-container";
    } else if (candidate.anaphorType === "such") {
      base = findEmbeddedAntecedent(state, candidate.baseKind, context.sourceId, candidate.base.start);
      ruleId = "embedded-such-container";
    } else if (candidate.anaphorType === "preceding" || candidate.anaphorType === "following") {
      base = relativeSiblingTarget(context, candidate.baseKind, candidate.anaphorType);
      if (base) Object.assign(base, { kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.base.start, end: candidate.base.end, text: candidate.base.text });
      ruleId = "embedded-relative-container";
    } else {
      const nested = candidateAt.get(candidate.base.start);
      if (nested && nested !== candidate && nested.list?.end === candidate.base.end) {
        const nestedResolution = resolveCandidate(nested);
        if (nestedResolution?.targets?.length === 1) base = { ...nestedResolution.targets[0], kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.base.start, end: candidate.base.end, text: candidate.base.text };
      }
      if (!base) base = { family: context.kind === "cfr" ? "cfr" : "usc", title: String(context.title || "8"), section: String(context.section || ""), path: [...candidate.baseTokens].map(String), kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.base.start, end: candidate.base.end, text: candidate.base.text };
      addEmbeddedFrame(state, base);
    }
    if (!base) {
      recordEmbeddedAudit(context, "ambiguous", candidate, { ruleId, reason: `missing-${candidate.baseKind}-antecedent` });
      resolving.delete(candidate);
      resolved.set(candidate, null);
      return null;
    }
    const references = [];
    const targets = [];
    candidate.members.forEach((member, index) => {
      const target = targetFrom(base.family, base.title, base.section, [...base.path, ...member.tokens]);
      const reference = makeReference(member, candidate, target, base, ruleId, index);
      if (reference) { references.push(reference); targets.push(target); }
    });
    auditResolution(candidate, references, ruleId);
    if (!candidate.unitPlural && targets.length === 1) addEmbeddedFrame(state, { ...targets[0], kind: candidate.unitKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.start, end: candidate.end, text: candidate.text, ruleId });
    const value = { references, targets, base, ruleId };
    resolved.set(candidate, value);
    resolving.delete(candidate);
    return value;
  };

  const events = [
    ...parsed.map(candidate => ({ start: candidate.start, priority: 0, candidate })),
    ...direct.filter(phrase => !parsed.some(candidate => phrase.start >= candidate.start && phrase.end <= candidate.end)).map(phrase => ({ start: phrase.start, priority: 1, phrase }))
  ].sort((left, right) => left.start - right.start || left.priority - right.priority);

  for (const event of events) {
    if (event.candidate) {
      for (const reference of resolveCandidate(event.candidate)?.references || []) results.push(reference);
      continue;
    }
    const phrase = event.phrase;
    const baseKind = parentContainerKind(phrase.unitKind);
    const container = baseKind ? currentContainerTarget(context, baseKind) : null;
    if (!container) {
      recordEmbeddedAudit(context, "ambiguous", phrase, { ruleId: "embedded-explicit-container", reason: `missing-current-${baseKind || "container"}` });
      continue;
    }
    const base = { ...container, kind: baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: phrase.start, end: phrase.unitSpan.end, text: phrase.unitSpan.text };
    const candidate = { ...phrase, ruleId: "embedded-explicit-container" };
    const targets = [];
    const references = [];
    phrase.members.forEach((member, index) => {
      const target = targetFrom(base.family, base.title, base.section, [...base.path, ...member.tokens]);
      const reference = makeReference(member, candidate, target, base, "embedded-explicit-container", index);
      if (reference) { results.push(reference); references.push(reference); targets.push(target); }
    });
    auditResolution(candidate, references, "embedded-explicit-container");
    if (!phrase.unitPlural && targets.length === 1) addEmbeddedFrame(state, { ...targets[0], kind: phrase.unitKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: phrase.start, end: phrase.end, text: phrase.text, ruleId: "embedded-explicit-container" });
  }

  const consumedAnaphors = new Set(parsed.filter(candidate => candidate.anaphor).map(candidate => `${candidate.anaphor.start}:${candidate.anaphor.end}`));
  for (const match of input.matchAll(/\b(?:such|preceding|following)\s+(?:section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/gi)) {
    const key = `${match.index}:${match.index + match[0].length}`;
    if (!consumedAnaphors.has(key)) recordEmbeddedAudit(context, "unresolved", { start: match.index, end: match.index + match[0].length, text: match[0], ruleId: "embedded-relative-container" }, { ruleId: "embedded-relative-container", reason: "anaphor-is-not-a-link-span" });
  }
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
      targetTitle, targetSection, targetPath: path, resolution: local ? "local" : "official-source-only", officialUrl,
      provenance: "deterministic-context", ruleId
    });
  };

  for (const match of input.matchAll(/((?:\([A-Za-z0-9-]+\)){1,7})\s+of\s+this\s+section\b/gi)) {
    add(match.index, match.index + match[1].length, pathTokens(match[1]), "context-path-this-section");
  }
  for (const match of input.matchAll(/\bthis\s+(section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)\b/gi)) {
    const level = match[1].toLowerCase() === "section" ? 0 : LEVELS.indexOf(match[1].toLowerCase()) + 1;
    if (level < 0) continue;
    add(match.index, match.index + match[0].length, sourcePath.slice(0, level), "context-this-unit");
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
  const deterministic = [...explicitReferenceCandidates(text, context), ...inaActReferenceCandidates(text, context), ...contextualReferenceCandidates(text, context)];
  const candidates = retainNavigableReferences([...deterministic, ...embeddedReferenceCandidates(text, context, [...existing, ...deterministic])]
    .filter(reference => reference.end > reference.start && String(text).slice(reference.start, reference.end) === reference.text)
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.ruleId.localeCompare(b.ruleId)), context);
  for (const candidate of candidates) {
    if (overlaps(candidate, occupied)) continue;
    if (candidate.evidenceRecord) {
      if (Array.isArray(context.referenceEvidence)) {
        candidate.evidenceId = context.referenceEvidence.length;
        context.referenceEvidence.push(candidate.evidenceRecord);
      }
      delete candidate.evidenceRecord;
    }
    occupied.push(candidate);
    occupied.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  for (const reference of occupied) delete reference.evidenceRecord;
  return occupied;
}

function legalReferenceContext(corpus) {
  validateLegalReferencePolicy(corpus);
  validateEmbeddedReferenceExceptions(corpus?.legalReferenceExceptions);
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
  const uscUnits = new Map();
  const uscSiblingLists = new Map();
  const addUscUnit = (section, path, types, virtual = false) => {
    const aliases = new Set([String(section), ...(uscAliases.get(String(section)) || [])]);
    for (const alias of aliases) {
      uscPaths.add(`${alias}:${path.join("/")}`);
      uscUnits.set(unitPathKey("8", alias, path), { path: [...path], unitTypes: [...types], unitType: types.at(-1), virtual });
      const siblingKey = `${unitPathKey("8", alias, path.slice(0, -1))}:${types.at(-1)}`;
      if (!uscSiblingLists.has(siblingKey)) uscSiblingLists.set(siblingKey, []);
      if (!uscSiblingLists.get(siblingKey).some(item => item.join("/").toLowerCase() === path.join("/").toLowerCase())) uscSiblingLists.get(siblingKey).push([...path]);
    }
  };
  function walkUsc(section, nodes, path = [], types = []) {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const nodeTypes = [...types, Number.isInteger(node.u) ? node.u : path.length];
      addUscUnit(section, nodePath, nodeTypes);
      walkUsc(section, node.children, nodePath, nodeTypes);
    }
  }
  for (const section of corpus.title8?.sections || []) {
    walkUsc(String(section.section), section.body);
    for (const path of section.runInPaths || []) {
      const types = [];
      let nodes = section.body || [];
      let previousType = -1;
      for (let index = 0; index < path.length; index++) {
        const token = String(path[index]);
        const node = (nodes || []).find(item => String(item.label).toLowerCase() === token.toLowerCase());
        const type = node ? (Number.isInteger(node.u) ? node.u : index) : Math.max(index, previousType + 1);
        types.push(type);
        previousType = type;
        nodes = node?.children || [];
      }
      addUscUnit(String(section.section), path.map(String), types, true);
    }
  }
  const cfrSections = new Map((corpus.cfr?.sections || []).map(section => [`${section.title}:${section.section}`, section]));
  const cfrPaths = new Set();
  const cfrUnits = new Map();
  const cfrSiblingLists = new Map();
  const collectCfr = section => {
    const visit = blocks => {
      for (const block of blocks || []) {
        for (const value of [block.a, ...(block.u || []).map(unit => unit.a)]) {
          const tokens = pathTokens(value);
          if (tokens.length) {
            cfrPaths.add(`${section.title}:${section.section}:${tokens.join("/")}`);
            cfrUnits.set(unitPathKey(String(section.title), String(section.section || ""), tokens), { path: tokens, virtual: Boolean(block.u?.some(unit => unit.a === value)) });
            const siblingKey = unitPathKey(String(section.title), String(section.section || ""), tokens.slice(0, -1));
            if (!cfrSiblingLists.has(siblingKey)) cfrSiblingLists.set(siblingKey, []);
            if (!cfrSiblingLists.get(siblingKey).some(item => item.join("/").toLowerCase() === tokens.join("/").toLowerCase())) cfrSiblingLists.get(siblingKey).push(tokens);
          }
        }
        if (block.t === "note") visit(block.blocks);
      }
    };
    visit(section.blocks);
  };
  for (const section of corpus.cfr?.sections || []) collectCfr(section);
  const inaMap = new Map((corpus.inaCrosswalk || []).map(row => [String(row.inaSection || "").toLowerCase(), row]));
  const embeddedExceptions = new Map((corpus?.legalReferenceExceptions?.exceptions || []).map(exception => [exception.id, exception]));
  const uscSourceArtifact = corpus.sources?.title8?.sourceArtifact || "house-title-8-xml";
  const cfrSourceArtifacts = new Map();
  for (const source of corpus.cfr?.sources || []) {
    cfrSourceArtifacts.set(`${source.title}:${source.part || "*"}`, source.url || `ecfr-title-${source.title}${source.part ? `-part-${source.part}` : ""}`);
  }
  return { uscSections, uscPaths, uscUnits, uscSiblingLists, cfrSections, cfrPaths, cfrUnits, cfrSiblingLists, inaMap, embeddedExceptions, uscSourceArtifact, cfrSourceArtifacts, legalReferencePolicy: corpus.legalReferencePolicy || null };
}

function applyGeneratedLegalReferences(corpus) {
  const referenceAudit = {
    suppressedSelfReferences: 0,
    suppressedByRule: {},
    suppressedByFamily: {},
    embeddedCandidates: 0,
    embeddedByStatus: {},
    embeddedByRule: {},
    embeddedIssues: []
  };
  const referenceEvidence = [];
  const embeddedExceptionUsage = new Set();
  const shared = { ...legalReferenceContext(corpus), referenceAudit, referenceEvidence, embeddedExceptionUsage };
  let generated = 0;
  const newState = frames => ({ frames: (frames || []).map(frame => ({ ...frame, path: [...(frame.path || [])] })) });
  const attach = (source, field, context, embeddedState = newState()) => {
    if (!source || !Object.hasOwn(source, field) || !source[field]) return;
    const property = referenceProperty(field);
    const before = source[property]?.length || 0;
    source[property] = generatedReferences(source[field], {
      ...shared,
      ...context,
      sourceField: field,
      sourceText: String(source[field]),
      sourceTextSha256: sourceTextHash(source[field]),
      embeddedState
    }, source[property] || []);
    generated += source[property].length - before;
  };
  const walkUsc = (section, nodes, path = [], parentState = newState()) => {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const context = { kind: "usc", title: "8", section: String(section.section), path: nodePath, sourceId: `usc-${section.section}-${nodePath.join("-")}`, suppressSelfReferences: true };
      const nodeState = newState(parentState.frames);
      attach(node, "heading", context, nodeState);
      attach(node, "text", context, nodeState);
      walkUsc(section, node.children, nodePath, nodeState);
    }
  };
  for (const section of corpus.title8?.sections || []) {
    const context = { kind: "usc", title: "8", section: String(section.section), path: [], sourceId: `usc-${section.section}` };
    const sectionState = newState();
    attach(section, "heading", { ...context, suppressSelfReferences: true }, sectionState);
    attach(section, "preamble", { ...context, suppressSelfReferences: true }, sectionState);
    attach(section, "sourceCredit", context, newState());
    walkUsc(section, section.body, [], sectionState);
    (section.notes || []).forEach((note, index) => {
      const noteContext = { ...context, sourceId: `usc-${section.section}-note-${index + 1}` };
      const noteState = newState();
      attach(note, "heading", noteContext, noteState);
      attach(note, "text", noteContext, noteState);
    });
    (section.houseEditorialFootnotes || []).forEach(footnote => attach(footnote, "text", { ...context, sourceId: footnote.id }, newState()));
  }
  const attachCfrBlocks = (section, blocks, pathPrefix = [], inheritedState = newState()) => {
    const stateByPath = new Map([["", newState(inheritedState.frames)]]);
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || "");
      const context = { kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section), section: String(section.section || ""), path, sourceId: `cfr-${section.id}-${[...pathPrefix, index].join("-")}`, suppressSelfReferences: true };
      const parentKey = path.slice(0, -1).join("/");
      const blockState = newState((stateByPath.get(parentKey) || stateByPath.get("") || inheritedState).frames);
      attach(block, "x", context, blockState);
      stateByPath.set(path.join("/"), blockState);
      if (!path.length) stateByPath.set("", blockState);
      if (block.t === "table") {
        (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => attach(cell, "x", { ...context, sourceId: `${context.sourceId}-cell-${rowIndex}-${cellIndex}` }, newState(blockState.frames))));
      }
      if (block.t === "note") attachCfrBlocks(section, block.blocks, [...pathPrefix, index], newState(blockState.frames));
    });
  };
  for (const section of [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])]) {
    const sectionState = newState();
    attach(section, "heading", { kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section), section: String(section.section || ""), path: [], sourceId: `cfr-${section.id}-heading`, suppressSelfReferences: true }, sectionState);
    attachCfrBlocks(section, section.blocks, [], sectionState);
  }
  for (const part of corpus.cfr?.parts || []) {
    const context = { kind: "cfr", title: String(part.title), part: cfrPartNumber(part), chapter: cfrChapterNumber(part), section: "", path: [], sourceId: `cfr-part-${part.id}` };
    const partState = newState();
    attach(part, "heading", context, partState);
    attach(part, "authority", context, partState);
    attach(part, "source", context, partState);
  }
  const unusedExceptions = [...shared.embeddedExceptions.keys()].filter(id => !embeddedExceptionUsage.has(id));
  if (unusedExceptions.length) throw new Error(`Stale embedded-reference exceptions: ${unusedExceptions.join(", ")}.`);
  corpus.legalReferenceEvidence = { schemaVersion: 1, resolverVersion: EMBEDDED_RESOLVER_VERSION, records: referenceEvidence };
  corpus.legalReferenceAudit = {
    schemaVersion: 1,
    resolverVersion: EMBEDDED_RESOLVER_VERSION,
    candidates: referenceAudit.embeddedCandidates,
    byStatus: referenceAudit.embeddedByStatus,
    byRule: referenceAudit.embeddedByRule,
    issues: referenceAudit.embeddedIssues
  };
  corpus.legalReferenceAudit.sha256 = sourceTextHash(JSON.stringify(corpus.legalReferenceAudit));
  corpus.legalReferenceMetadata = {
    schemaVersion: 3,
    generatedReferences: generated,
    suppressedSelfReferences: referenceAudit.suppressedSelfReferences,
    suppressedSelfReferencesByRule: referenceAudit.suppressedByRule,
    suppressedSelfReferencesByFamily: referenceAudit.suppressedByFamily,
    generatedAtBuild: true,
    runtimeNetworkForPreviews: false,
    policySchemaVersion: corpus.legalReferencePolicy?.schemaVersion || null,
    policyReviewedAt: corpus.legalReferencePolicy?.reviewedAt || null,
    policyScopes: corpus.legalReferencePolicy?.scopes?.length || 0,
    embeddedResolverVersion: EMBEDDED_RESOLVER_VERSION,
    embeddedCandidates: referenceAudit.embeddedCandidates,
    embeddedResolvedReferences: referenceEvidence.length,
    embeddedIssues: referenceAudit.embeddedIssues.length,
    rules: ["house-uslm-ref", "explicit-usc", "explicit-ina", "explicit-cfr", "explicit-public-law", "explicit-statutes-at-large", "explicit-federal-register", "context-cfr-ina-act-section", "context-path-this-section", "context-cfr-the-act", "embedded-explicit-container", "embedded-this-container", "embedded-such-container", "embedded-relative-container", "embedded-exception"]
  };
  return corpus;
}

function applyCfrReferences(corpus, changedPartIds) {
  const changed = new Set([...(changedPartIds || [])].map(String));
  const referenceAudit = {
    suppressedSelfReferences: 0,
    suppressedByRule: {},
    suppressedByFamily: {},
    embeddedCandidates: 0,
    embeddedByStatus: {},
    embeddedByRule: {},
    embeddedIssues: []
  };
  const packedEvidence = corpus.legalReferenceEvidence?.format === "indexed-arrays-v1";
  const referenceEvidence = packedEvidence ? null : (corpus.legalReferenceEvidence?.records || []);
  const shared = { ...legalReferenceContext(corpus), referenceAudit, referenceEvidence, embeddedExceptionUsage: new Set() };
  let fields = 0;
  let references = 0;
  const newState = frames => ({ frames: (frames || []).map(frame => ({ ...frame, path: [...(frame.path || [])] })) });
  const attach = (source, field, context, embeddedState = newState()) => {
    if (!source || !Object.hasOwn(source, field) || !source[field]) return;
    const property = referenceProperty(field);
    source[property] = generatedReferences(source[field], {
      ...shared,
      ...context,
      sourceField: field,
      sourceText: String(source[field]),
      sourceTextSha256: sourceTextHash(source[field]),
      embeddedState
    }, []);
    fields += 1;
    references += source[property].length;
  };
  const attachBlocks = (section, blocks, pathPrefix = [], inheritedState = newState()) => {
    const stateByPath = new Map([["", newState(inheritedState.frames)]]);
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || "");
      const context = {
        kind: "cfr", title: String(section.title), part: cfrPartNumber(section), chapter: cfrChapterNumber(section),
        section: String(section.section || ""), path, sourceId: `runtime-cfr-${section.id}-${[...pathPrefix, index].join("-")}`,
        suppressSelfReferences: true
      };
      const parentKey = path.slice(0, -1).join("/");
      const blockState = newState((stateByPath.get(parentKey) || stateByPath.get("") || inheritedState).frames);
      attach(block, "x", context, blockState);
      stateByPath.set(path.join("/"), blockState);
      if (!path.length) stateByPath.set("", blockState);
      if (block.t === "table") {
        (block.rows || []).forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
          attach(cell, "x", { ...context, sourceId: `${context.sourceId}-cell-${rowIndex}-${cellIndex}` }, newState(blockState.frames));
        }));
      }
      if (block.t === "note") attachBlocks(section, block.blocks, [...pathPrefix, index], newState(blockState.frames));
    });
  };
  const records = [...(corpus.cfr?.sections || []), ...(corpus.cfr?.appendices || [])].filter(record => changed.has(String(record.partId)));
  for (const record of records) {
    const context = {
      kind: "cfr", title: String(record.title), part: cfrPartNumber(record), chapter: cfrChapterNumber(record),
      section: String(record.section || ""), path: [], sourceId: `runtime-cfr-${record.id}-heading`, suppressSelfReferences: true
    };
    const sectionState = newState();
    attach(record, "heading", context, sectionState);
    attachBlocks(record, record.blocks, [], sectionState);
  }
  for (const part of corpus.cfr?.parts || []) {
    if (!changed.has(String(part.id))) continue;
    const context = {
      kind: "cfr", title: String(part.title), part: cfrPartNumber(part), chapter: cfrChapterNumber(part),
      section: "", path: [], sourceId: `runtime-cfr-part-${part.id}`
    };
    const partState = newState();
    attach(part, "heading", context, partState);
    attach(part, "authority", context, partState);
    attach(part, "source", context, partState);
  }
  if (!packedEvidence) corpus.legalReferenceEvidence = { schemaVersion: 1, resolverVersion: EMBEDDED_RESOLVER_VERSION, records: referenceEvidence };
  return {
    engineVersion: 2,
    changedParts: [...changed].sort(),
    fields,
    references,
    suppressedSelfReferences: referenceAudit.suppressedSelfReferences,
    embeddedCandidates: referenceAudit.embeddedCandidates,
    embeddedIssues: referenceAudit.embeddedIssues.length
  };
}

return {
  applyCfrReferences,
  applyGeneratedLegalReferences,
  explicitReferenceCandidates,
  generatedReferences,
  embeddedReferenceCandidates,
  inaActReferenceCandidates,
  legalReferenceContext,
  pathTokens,
  validateEmbeddedReferenceExceptions,
  validateLegalReferencePolicy
};
});
