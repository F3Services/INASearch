(function (root, factory) {
  const nodeRuntime = typeof module === "object" && module.exports;
  const embeddedReferences = nodeRuntime ? require("./embedded-references") : root?.INASearchEmbeddedReferences;
  const statuteRunIns = nodeRuntime ? require("./statute-run-ins") : null;
  const textSha256 = nodeRuntime
    ? value => require("crypto").createHash("sha256").update(String(value || ""), "utf8").digest("hex")
    : null;
  const api = factory(embeddedReferences, textSha256, statuteRunIns);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INASearchLegalReferences = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (EmbeddedReferences, textSha256, StatuteRunIns) {
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
  if (singular === "subdivision") return "paragraph";
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

function pathEndsWith(path, suffix) {
  if (suffix.length > path.length) return false;
  const offset = path.length - suffix.length;
  return suffix.every((token, index) => String(token).toLowerCase() === String(path[offset + index]).toLowerCase());
}

function writtenTitleBefore(text, before) {
  let title = "";
  for (const match of String(text || "").slice(0, before).matchAll(/\btitle\s+(\d+)\b/gi)) title = match[1];
  return title;
}

function activeInlineUnitMarker(context, before) {
  const marker = (context.inlineUnitMarkers || []).filter(item => item.start < before).at(-1);
  if (!marker) return null;
  const intervening = String(context.sourceText || "").slice(marker.end, before);
  return /[.!?][”"')\]]*\s+(?=[A-Z])/.test(intervening) ? null : marker;
}

function isSelfReference(reference, context) {
  if (reference.ruleId === "context-this-unit") return true;
  if (!context.suppressSelfReferences || reference.resolution !== "local") return false;
  const family = context.kind === "cfr" ? "cfr" : "usc";
  const activeMarker = activeInlineUnitMarker(context, reference.start);
  const sourcePath = activeMarker?.path || context.path || [];
  return reference.family === family &&
    String(reference.targetTitle || "") === String(context.title || "") &&
    String(reference.targetSection || "") === String(context.section || "") &&
    pathStartsWith(sourcePath, reference.targetPath || []);
}

function isHouseEditorialSourceError(reference, context) {
  if (reference.resolution === "local" || !String(reference.ruleId || "").startsWith("embedded-")) return false;
  const input = String(context.sourceText || "");
  for (const item of context.sourceFootnoteReferences || []) {
    if (item.offset < reference.end || item.offset - reference.end > 32) continue;
    const footnote = context.houseFootnotes?.get(item.id);
    const correction = String(footnote?.text || "").match(/\bprobably\s+should\s+be\s+[“"']?(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
    if (!correction) continue;
    const sourceList = input.slice(Math.max(0, reference.start - 70), item.offset)
      .match(/\b(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\s+(?:\([A-Za-z0-9-]+\)(?:\s+(?:and|or)\s+)?)+$/i);
    if (sourceList && unitKind(sourceList[1]) !== unitKind(correction[1])) return true;
  }
  return false;
}

function retainNavigableReferences(references, context) {
  return references.filter(reference => {
    if (reference.resolution === "unresolved" || reference.family === "unknown") return false;
    const structural = (context.inlineUnitMarkers || []).some(marker => marker.start <= reference.start && marker.end >= reference.end);
    if (structural) return false;
    if (isHouseEditorialSourceError(reference, context)) return false;
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
  if (context.uscCanonicalPaths?.has(unitPathKey(title, section, path).toLowerCase())) return true;
  return context.uscPaths?.has(`${section}:${path.join("/")}`) || false;
}

function canonicalLocalUscPath(context, title, section, path = []) {
  return context.uscCanonicalPaths?.get(unitPathKey(title, section, path).toLowerCase()) || [...path].map(String);
}

function canonicalizeUscReference(reference, context) {
  if (reference?.provenance === "house-uslm-ref" && reference.houseHref) {
    const match = String(reference.houseHref).match(/^\/us\/usc\/t([^/]+)\/s([^/]+)(?:\/(.*))?$/);
    if (match) {
      const title = String(match[1]);
      const section = String(match[2]);
      const writtenPath = match[3] ? match[3].split("/").filter(Boolean) : [];
      const canonicalPath = canonicalLocalUscPath(context, title, section, writtenPath);
      if (localUscTarget(context, title, section, canonicalPath)) {
        return {
          ...reference,
          houseHref: `/us/usc/t${title}/s${section}${canonicalPath.length ? `/${canonicalPath.join("/")}` : ""}`,
          resolution: reference.forceOfficial ? "official-source-only" : "local"
        };
      }
    }
  }
  if (!reference || !["usc", "ina"].includes(reference.family) || !reference.targetSection) return reference;
  const title = String(reference.targetTitle || "8");
  const section = String(reference.targetSection);
  const path = canonicalLocalUscPath(context, title, section, reference.targetPath || []);
  if (!localUscTarget(context, title, section, path)) return reference;
  if (reference.forceOfficial) return { ...reference, targetPath: path, resolution: "official-source-only" };
  const unchanged = path.length === (reference.targetPath || []).length && path.every((token, index) => token === String(reference.targetPath[index]));
  if (unchanged && reference.resolution === "local") return reference;
  return { ...reference, targetPath: path, resolution: "local" };
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

function cfrPolicyScope(context) {
  if (context.kind !== "cfr") return null;
  return (context.legalReferencePolicy?.scopes || []).find(scope => policyScopeMatches(scope, context)) || null;
}

function cfrContextActAuthority(context) {
  const scope = cfrPolicyScope(context);
  if (!scope) return null;
  return scope.authority || {
    family: "ina",
    title: "8",
    actName: "Immigration and Nationality Act",
    officialUrl: "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act"
  };
}

function cfrContextUsesInaAct(context) {
  return cfrContextActAuthority(context)?.family === "ina";
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
    if (scope.authority) {
      if (!scope.authority.family || !scope.authority.actName || !/^https:\/\//.test(scope.authority.officialUrl || "")) {
        throw new Error(`Legal-reference policy scope ${scope.id} has an incomplete Act authority.`);
      }
      const invalidSectionMap = !scope.authority.sectionMap || !Object.keys(scope.authority.sectionMap).length ||
        Object.entries(scope.authority.sectionMap || {}).some(([actSection, uscSection]) =>
          !/^\d+[A-Za-z0-9-]*$/.test(actSection) || !/^\d+[A-Za-z0-9-]*$/.test(String(uscSection)));
      if (scope.authority.family === "usc" && (!/^\d+$/.test(String(scope.authority.title || "")) || invalidSectionMap)) {
        throw new Error(`Legal-reference policy scope ${scope.id} has an invalid U.S. Code section map.`);
      }
    }
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

function citationTokenClass(token) {
  const value = String(token || "");
  if (/^\d+$/.test(value)) return "number";
  if (/^[ivxlcdm]+$/.test(value)) return "lower-roman";
  if (/^[IVXLCDM]+$/.test(value)) return "upper-roman";
  if (/^[a-z]+$/.test(value)) return "lower-alpha";
  if (/^[A-Z]+$/.test(value)) return "upper-alpha";
  if (/^[a-z]\d+$/i.test(value)) return `${value[0] === value[0].toUpperCase() ? "upper" : "lower"}-alphanumeric`;
  return "other";
}

function plausibleContinuationDepth(previousPath, retained, continuationPath) {
  const first = String(continuationPath?.[0] || "");
  if (!first) return false;
  if (retained < previousPath.length) {
    const previous = previousPath[retained];
    if (canonicalUscTokenAtDepth(previous, retained) && canonicalUscTokenAtDepth(first, retained)) return true;
    return citationTokenClass(first) === citationTokenClass(previous);
  }
  return Boolean(canonicalUscTokenAtDepth(first, retained));
}

function resolvedInaContinuationPath(context, inaSection, basePath, continuationPath) {
  const mapping = context.inaMap?.get(String(inaSection).toLowerCase());
  const targetSection = mapping?.uscSection ? String(mapping.uscSection) : "";
  if (!targetSection) return null;
  for (let retained = basePath.length; retained >= 0; retained--) {
    if (!plausibleContinuationDepth(basePath, retained, continuationPath)) continue;
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

function parseInaActCitationPrefix(input, start) {
  const lead = String(input || "").slice(start).match(/^sections?\s+/i);
  if (!lead) return null;
  const citations = [];
  let cursor = start + lead[0].length;
  const readCitation = (leadStart = null) => {
    const remainder = input.slice(cursor);
    const absolute = remainder.match(/^\d+[A-Za-z-]*(?:\s*\([A-Za-z0-9-]+\))*/);
    const continuation = absolute ? null : remainder.match(/^(?:\([A-Za-z0-9-]+\))(?:\s*\([A-Za-z0-9-]+\))*/);
    const match = absolute || continuation;
    if (!match) return false;
    citations.push({
      start: leadStart === null ? cursor : leadStart,
      end: cursor + match[0].length,
      inaSection: absolute ? match[0].match(/^\d+[A-Za-z-]*/)[0] : "",
      path: pathTokens(match[0]),
      relative: !absolute
    });
    cursor += match[0].length;
    return true;
  };
  if (!readCitation(start)) return null;
  while (cursor < input.length) {
    const remainder = input.slice(cursor);
    const separator = remainder.match(/^(?:\s+(?=\([A-Za-z0-9-]+\))|\s*\)*\s*[,;]\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)(?=(?:sections?\s+)?(?:\d+[A-Za-z-]*|\([A-Za-z0-9-]+\)))/i);
    if (!separator) break;
    const nextStart = cursor + separator[0].length;
    const sectionWord = input.slice(nextStart).match(/^sections?\s+/i);
    cursor = nextStart + (sectionWord?.[0].length || 0);
    if (!readCitation(sectionWord ? nextStart : null)) break;
  }
  return { citations, end: cursor };
}

function inaActReferenceCandidates(text, context) {
  const input = String(text || "");
  const results = [];
  if (context.kind !== "cfr") return results;
  const suffixPattern = /\bof\s+(?:(the)\s+)?(?:(Immigration\s+and\s+Nationality)\s+)?(?:Act\b(?!\s+of\b)|(INA)\b)/gi;
  for (const suffix of input.matchAll(suffixPattern)) {
    const explicitlyIna = Boolean(suffix[2] || suffix[3]);
    if (!explicitlyIna && !cfrContextUsesInaAct(context)) continue;
    const windowStart = Math.max(0, suffix.index - 420);
    const prefix = input.slice(windowStart, suffix.index);
    const starts = [...new Set([
      ...[...prefix.matchAll(/\bsections?\b/gi)].map(match => windowStart + match.index),
      ...[...prefix.matchAll(/\b\d+[A-Za-z-]*(?=\s*\()/g)].map(match => windowStart + match.index)
    ])].sort((left, right) => left - right);
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
  const assumesIna = cfrContextUsesInaAct(context) || /\b(?:INA|Immigration\s+and\s+Nationality\s+Act)\b/i.test(input);
  if (assumesIna) {
    for (const match of input.matchAll(/\bsections?\s+(?=\d+[A-Za-z-]*\s*\()/gi)) {
      const parsed = parseInaActCitationPrefix(input, match.index);
      if (!parsed?.citations?.length) continue;
      const suffixText = input.slice(parsed.end, parsed.end + 240);
      const writtenActSuffix = suffixText.match(/^\s+of\s+([^.;]{1,220}?\bAct(?:\s+of\s+\d{4})?)\b/i)?.[1] || "";
      const acceptedActSuffix = /^(?:(?:the|this|such|that)\s+Act|INA|Immigration\s+and\s+Nationality\s+Act)\b/i.test(writtenActSuffix);
      const normalizedSuffix = suffixText.trimStart().toLowerCase();
      const catalogNamedActSuffix = [...(context.namedActs?.keys?.() || [])].some(name => {
        const prefix = `of ${String(name).toLowerCase()}`;
        return normalizedSuffix.startsWith(prefix) && !/[a-z0-9]/.test(normalizedSuffix[prefix.length] || " ");
      });
      const structuredNamedActSuffix = /^\s*,?\s*(?:(?:division|title)\b[^.;]{0,200}?\s+of\s+)?(?:the\s+)?[A-Z][^.;]{0,200}\bAct\b/i.test(suffixText);
      // A written, specifically named Act is affirmative evidence against the
      // CFR scope's default INA meaning, even when the catalog stores a longer
      // formal title (for example, a trailing "of 1996"). Let the named-Act
      // resolver own that citation instead of occupying its first member as INA.
      if (!acceptedActSuffix && (writtenActSuffix || catalogNamedActSuffix || structuredNamedActSuffix)) continue;
      let currentSection = "";
      let currentPath = [];
      for (const [index, citation] of parsed.citations.entries()) {
        let targetPath = citation.path;
        if (citation.relative) {
          if (!currentSection) break;
          targetPath = resolvedInaContinuationPath(context, currentSection, currentPath, citation.path);
          if (!targetPath) break;
        } else {
          currentSection = citation.inaSection;
          if (!context.inaMap?.has(String(currentSection).toLowerCase())) break;
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
      }
    }
    for (const [index, match] of [...input.matchAll(/\bsections?\s+(\d+[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))+)(\s+is\s+divided\s+to\s+create\s+an?\s+)((?:\([A-Za-z0-9-]+\))+)/gi)].entries()) {
      const inaSection = match[1];
      if (!context.inaMap?.has(String(inaSection).toLowerCase())) continue;
      const previousPath = pathTokens(match[2]);
      const continuation = pathTokens(match[4]);
      let targetPath = resolvedInaContinuationPath(context, inaSection, previousPath, continuation);
      if (!targetPath) {
        const repeatedAt = previousPath.findIndex((token, tokenIndex) => continuation.length > 1 &&
          String(token).toLowerCase() === String(continuation[0]).toLowerCase() && tokenIndex + continuation.length <= previousPath.length + 1);
        if (repeatedAt >= 0) targetPath = [...previousPath.slice(0, repeatedAt), ...continuation];
      }
      if (!targetPath) continue;
      const start = match.index + match[0].lastIndexOf(match[4]);
      results.push({
        id: makeId(context, start, "context-cfr-ina-act-section", index),
        start,
        end: start + match[4].length,
        text: match[4],
        provenance: "deterministic-context",
        ruleId: "context-cfr-ina-act-section",
        ...inaReferenceTarget(context, inaSection, targetPath)
      });
    }
  }
  const unique = new Map();
  for (const reference of results) {
    const identity = `${reference.start}:${reference.end}:${reference.targetSection}:${(reference.targetPath || []).join("/")}`;
    if (!unique.has(identity)) unique.set(identity, reference);
  }
  return [...unique.values()];
}

function scopedCfrActReferenceCandidates(text, context) {
  const input = String(text || "");
  const scope = cfrPolicyScope(context);
  const authority = cfrContextActAuthority(context);
  if (!scope || authority?.family !== "usc" || !authority.sectionMap) return [];
  const results = [];
  const add = (citation, actSection, targetPath, index = 0) => {
    const targetSection = String(authority.sectionMap[String(actSection)] || "");
    if (!targetSection) return;
    results.push({
      id: makeId(context, citation.start, "context-cfr-scoped-act-section", index),
      start: citation.start,
      end: citation.end,
      text: input.slice(citation.start, citation.end),
      family: "usc",
      targetKind: "usc",
      targetTitle: String(authority.title),
      targetSection,
      targetPath: [...targetPath].map(String),
      resolution: "official-source-only",
      officialUrl: houseSectionUrl(String(authority.title), targetSection),
      provenance: "reviewed-semantic-policy",
      ruleId: "context-cfr-scoped-act-section",
      policyScopeId: scope.id
    });
  };
  const actName = String(authority.actName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffixPattern = new RegExp(`\\bof\\s+(?:(?:the\\s+)?${actName}(?:\\s*\\(\\s*Act\\s*\\))?|the\\s+Act|this\\s+Act|such\\s+Act|that\\s+Act)\\b`, "gi");
  for (const suffix of input.matchAll(suffixPattern)) {
    const windowStart = Math.max(0, suffix.index - 520);
    const prefix = input.slice(windowStart, suffix.index);
    const starts = [...prefix.matchAll(/\bsections?\b/gi)].map(match => windowStart + match.index);
    for (const start of starts) {
      const parsed = parseInaActCitationList(input, start, suffix.index);
      if (!parsed?.length) continue;
      let currentSection = "";
      let previousPath = [];
      parsed.forEach((citation, index) => {
        if (!citation.relative) currentSection = String(citation.inaSection || "");
        if (!currentSection || !authority.sectionMap[currentSection]) return;
        const targetPath = citation.relative
          ? [...previousPath.slice(0, Math.max(0, previousPath.length - Math.max(1, citation.path.length))), ...citation.path.map(String)]
          : citation.path.map(String);
        previousPath = targetPath;
        add(citation, currentSection, targetPath, index);
      });
    }
    // Coordinated prose can interrupt a statutory list: “section 1915(c) or
    // authorized under section 1902(e)(3) of the Act.” Resolve every mapped
    // absolute address in that same punctuation-bounded authority phrase.
    for (const match of prefix.matchAll(/\bsections?\s+(\d+[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))+)/gi)) {
      const start = windowStart + match.index;
      const bridge = input.slice(start + match[0].length, suffix.index);
      if (/[.;!?]/.test(bridge) || new RegExp(`\\b(?!${actName}\\b)[A-Z][A-Za-z0-9'’&., -]{1,100}\\s+Act\\b`).test(bridge)) continue;
      add({ start, end: start + match[0].length }, match[1], pathTokens(match[2]), results.length);
    }
  }
  const unique = new Map();
  for (const reference of results) {
    const identity = `${reference.start}:${reference.end}:${reference.targetTitle}:${reference.targetSection}:${reference.targetPath.join("/")}`;
    if (!unique.has(identity)) unique.set(identity, reference);
  }
  return [...unique.values()];
}

function writtenUscSection(token) {
  const value = String(token || "");
  const match = value.match(/^(\d+[A-Za-z]*)-(\d+[A-Za-z]*)$/);
  if (!match) return value;
  const leftDigits = match[1].match(/^\d+/)?.[0].length || 0;
  const rightDigits = match[2].match(/^\d+/)?.[0].length || 0;
  return rightDigits < leftDigits ? value : match[1];
}

function writtenCfrSection(token) {
  const value = String(token || "");
  const hyphen = value.lastIndexOf("-");
  if (hyphen < 0) return value;
  return value.slice(hyphen + 1).includes(".") ? value.slice(0, hyphen) : value;
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

  addMatches(/\b(\d+)\s+U\.?\s*S\.?\s*C\.?\s*(?:§{1,2}\s*)?(\d+[A-Za-z]*(?:-\d+[A-Za-z]*)?)((?:\s*\([A-Za-z0-9-]+\))*)/gi, "explicit-usc", match => {
    const title = match[1], section = writtenUscSection(match[2]), targetPath = section === match[2] ? pathTokens(match[3]) : [];
    // A trailing parenthetical year in a U.S. Code citation identifies the
    // edition (for example, "20 U.S.C. 1001(a)(2000)"), not a child unit.
    if (targetPath.length > 1 && /^(?:17|18|19|20)\d{2}$/.test(targetPath.at(-1))) targetPath.pop();
    const local = localUscTarget(context, title, section, targetPath);
    const sectionStart = match[0].indexOf(match[2]);
    const sourceText = section === match[2] ? match[0] : match[0].slice(0, sectionStart + section.length);
    return { text: sourceText, family: "usc", targetKind: "usc", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: houseSectionUrl(title, section) };
  });
  addMatches(/\b(\d+)\s+C\.?\s*F\.?\s*R\.?\s*(?:(?:§{1,2}|sections?)\s*)?(\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?(?:\s*\([A-Za-z0-9-]+\))*-\d+(?:\.\d+)?[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?)((?:\s*\([A-Za-z0-9-]+\))*)/gi, "explicit-cfr", match => {
    const title = match[1], section = writtenCfrSection(match[2]), targetPath = section === match[2] ? pathTokens(match[3]) : [];
    const local = localCfrTarget(context, title, section, targetPath);
    const sectionStart = match[0].indexOf(match[2]);
    const sourceText = section === match[2] ? match[0] : match[0].slice(0, sectionStart + section.length);
    return { text: sourceText, family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: ecfrSectionUrl(title, section) };
  });
  if (context.kind === "cfr") addMatches(/§{1,2}\s*(\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?(?:\s*\([A-Za-z0-9-]+\))*-\d+(?:\.\d+)?[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?)((?:\s*\([A-Za-z0-9-]+\))*)/g, "explicit-cfr", match => {
    // A title-qualified “8 CFR § ...” is already consumed by the preceding
    // rule. This branch supplies the current CFR title for the overwhelmingly
    // common local form “§ 214.2(h)(1)” and its coordinated continuations.
    if (/\bC\.?\s*F\.?\s*R\.?\s*$/i.test(input.slice(Math.max(0, match.index - 18), match.index))) return null;
    const title = String(context.title || ""), section = writtenCfrSection(match[1]);
    const targetPath = section === match[1] ? pathTokens(match[2]) : [];
    const local = localCfrTarget(context, title, section, targetPath);
    const sectionStart = match[0].indexOf(match[1]);
    const sourceText = section === match[1] ? match[0] : match[0].slice(0, sectionStart + section.length);
    return { text: sourceText, family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: ecfrSectionUrl(title, section) };
  });
  if (context.kind === "cfr") addMatches(/\b(?:sections?|paragraphs?)\s+(\d+[A-Za-z]*\.\d+[A-Za-z]*(?:\s*\([A-Za-z0-9-]+\))*-\d+(?:\.\d+)?[A-Za-z]*|\d+[A-Za-z]*\.\d+[A-Za-z]*)((?:\s*\([A-Za-z0-9-]+\))*)/gi, "explicit-cfr", match => {
    if (/\bC\.?\s*F\.?\s*R\.?\s*$/i.test(input.slice(Math.max(0, match.index - 18), match.index))) return null;
    const title = String(context.title || ""), section = writtenCfrSection(match[1]);
    const targetPath = section === match[1] ? pathTokens(match[2]) : [];
    const local = localCfrTarget(context, title, section, targetPath);
    const sectionStart = match[0].indexOf(match[1]);
    const sourceText = section === match[1] ? match[0] : match[0].slice(0, sectionStart + section.length);
    return { text: sourceText, family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath, resolution: local ? "local" : "official-source-only", officialUrl: ecfrSectionUrl(title, section) };
  });
  addMatches(/\bINA\s*(?:§|section)?\s*(\d+[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))*)/gi, "explicit-ina", match => {
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

function bareSectionReferenceCandidates(text, context) {
  if (context.kind !== "usc") return [];
  const input = String(text || "");
  const results = [];
  const pattern = /\bsection\s+(\d{3,5}[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))*)/gi;
  for (const [index, match] of [...input.matchAll(pattern)].entries()) {
    const section = String(match[1]);
    const writtenPath = pathTokens(match[2]);
    let target = null;
    let ruleId = "context-bare-usc-section";
    if (context.uscSections?.has(`8:${section}`)) {
      const targetPath = canonicalLocalUscPath(context, "8", section, writtenPath);
      target = {
        family: "usc", targetKind: "usc", targetTitle: "8", targetSection: section, targetPath,
        resolution: localUscTarget(context, "8", section, targetPath) ? "local" : "official-source-only",
        officialUrl: houseSectionUrl("8", section)
      };
    } else {
      const exactKey = `${section.toLowerCase()}:${writtenPath.map(token => token.toLowerCase()).join("/")}`;
      const historical = context.actSectionTargets?.get(exactKey);
      if (historical) {
        target = referenceFieldsForTarget(context, historical);
        ruleId = "context-bare-historical-act-section";
      } else {
        const suffix = input.slice(match.index + match[0].length, Math.min(input.length, match.index + match[0].length + 220));
        const numberedTitle = suffix.match(/^[^.;!?]{0,190}?\bof\s+title\s+(\d+)\b/i);
        if (numberedTitle) {
          const title = numberedTitle[1];
          target = {
            family: "usc", targetKind: "usc", targetTitle: title, targetSection: section, targetPath: writtenPath,
            resolution: localUscTarget(context, title, section, writtenPath) ? "local" : "official-source-only",
            officialUrl: houseSectionUrl(title, section)
          };
          ruleId = "context-bare-trailing-title-section";
        }
      }
    }
    if (!target) continue;
    results.push({
      id: makeId(context, match.index, ruleId, index), start: match.index, end: match.index + match[0].length,
      text: match[0], ...target, provenance: "deterministic-context", ruleId
    });
  }
  for (const [index, match] of [...input.matchAll(/\b(\d{3,5}[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))+)/g)].entries()) {
    if (/\b(?:section|sections|INA|U\.?\s*S\.?\s*C\.?|C\.?\s*F\.?\s*R\.?)\s*$/i.test(input.slice(Math.max(0, match.index - 24), match.index))) continue;
    if (!/(?:\b(?:and|or)|,)\s*$/i.test(input.slice(Math.max(0, match.index - 18), match.index))) continue;
    const section = String(match[1]);
    const writtenPath = pathTokens(match[2]);
    if (!context.uscSections?.has(`8:${section}`)) continue;
    const targetPath = canonicalLocalUscPath(context, "8", section, writtenPath);
    if (!localUscTarget(context, "8", section, targetPath)) continue;
    results.push({
      id: makeId(context, match.index, "context-bare-usc-address", index), start: match.index, end: match.index + match[0].length,
      text: match[0], family: "usc", targetKind: "usc", targetTitle: "8", targetSection: section, targetPath,
      resolution: "local", officialUrl: houseSectionUrl("8", section), provenance: "deterministic-context", ruleId: "context-bare-usc-address"
    });
  }
  return results;
}

function sourceAuthoritySectionCandidates(text, context, anchorReferences = []) {
  const input = String(text || "");
  const results = [];
  if (!EmbeddedReferences?.parseUnitList) return results;
  const authorities = [...(anchorReferences || [])].filter(reference => ["public-law", "statutes-at-large"].includes(reference.family));
  const numberedSectionParses = EmbeddedReferences.parseNumberedSectionReferences?.(input) || [];

  // A coordinated source citation can put its authority after the complete
  // section list: “sections 101(6) and 106, Division A, Title I of the ...
  // Act, Public Law 118-83.”  Parse the list as one grammar production so the
  // trailing authority and its written containers govern every member.  This
  // must run independently of the current CFR's default Act (often the INA).
  const coordinatedAuthorityLeads = context.kind === "cfr"
    ? [...input.matchAll(/\bsections\s+(?=\d+[A-Za-z-]*(?:\s*\(|\b))/gi)]
    : [];
  for (const [candidateIndex, lead] of coordinatedAuthorityLeads.entries()) {
    if (numberedSectionParses.some(candidate => candidate.start <= lead.index && candidate.end > lead.index &&
      ["public-law", "named-act", "named-instrument"].includes(candidate.scope?.type))) continue;
    const parsed = parseInaActCitationPrefix(input, lead.index);
    if (!parsed?.citations?.length) continue;
    const following = authorities
      .filter(reference => reference.family === "public-law" && reference.start >= parsed.end && reference.start - parsed.end <= 360)
      .filter(reference => !/[;.!?]/.test(input.slice(parsed.end, reference.start)))
      .filter(reference => !/\bto\s+sections?\b/i.test(input.slice(parsed.end, reference.start)))
      .filter(reference => !/\bof\s+(?:such|this|that|the)\s+Act\b/i.test(input.slice(parsed.end, reference.start)))
      .sort((left, right) => left.start - right.start)[0];
    const authority = packedTargetBase(following);
    if (!authority) continue;
    const bridge = input.slice(parsed.end, following.start);
    const containers = namedActContainerPath(bridge.replace(/^[\s,]+/, ""));
    let currentSection = "";
    let previousPath = [];
    for (const [memberIndex, citation] of parsed.citations.entries()) {
      let section = String(citation.inaSection || "");
      let targetPath = (citation.path || []).map(String);
      if (citation.relative) {
        if (!currentSection) break;
        section = currentSection;
        targetPath = resolvedSectionContinuationPath(context, "", section, previousPath, targetPath);
        if (!targetPath) break;
      }
      if (!section) break;
      currentSection = section;
      previousPath = targetPath;
      results.push({
        id: makeId(context, citation.start, "source-authority-section-list", candidateIndex * 100 + memberIndex),
        start: citation.start,
        end: citation.end,
        text: input.slice(citation.start, citation.end),
        family: "public-law",
        targetKind: "public-law",
        targetCongress: authority.title,
        targetLaw: authority.section,
        targetPath: [...(authority.path || []), ...containers, `s${section}`, ...targetPath],
        resolution: "official-source-only",
        officialUrl: `https://www.govinfo.gov/app/details/PLAW-${authority.title}publ${authority.section}`,
        provenance: "deterministic-source-authority",
        ruleId: "source-authority-section-list"
      });
    }
  }
  for (const [candidateIndex, match] of [...input.matchAll(/(?:§{1,2}|\bsecs?\.|\bsections?)\s*(\d+[A-Za-z]*)((?:\s*\([A-Za-z0-9-]+\))+)/gi)].entries()) {
    const section = String(match[1]);
    const firstPath = pathTokens(match[2]);
    const start = match.index + match[0].indexOf(match[1]);
    const end = match.index + match[0].length;
    const preceding = authorities
      .filter(reference => reference.family === "public-law" && reference.end <= match.index && match.index - reference.end <= 180)
      .filter(reference => !/[;!?]/.test(input.slice(reference.end, match.index)))
      .sort((left, right) => left.end - right.end).at(-1);
    const following = authorities
      .filter(reference => reference.start >= end && reference.start - end <= 260)
      .filter(reference => !/[;.!?]/.test(input.slice(end, reference.start)))
      .sort((left, right) => left.start - right.start)[0];
    const authority = packedTargetBase(preceding || following);
    if (!authority) continue;
    const fields = path => authority.family === "public-law"
      ? {
        family: "public-law", targetKind: "public-law", targetCongress: authority.title, targetLaw: authority.section,
        targetPath: [...(authority.path || []), `s${section}`, ...path], resolution: "official-source-only",
        officialUrl: `https://www.govinfo.gov/app/details/PLAW-${authority.title}publ${authority.section}`
      }
      : {
        family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: authority.title, targetPage: authority.section,
        targetPath: [`section-${section}`, ...path], resolution: "official-source-only",
        officialUrl: embeddedOfficialUrl(authority)
      };
    results.push({
      id: makeId(context, start, "source-authority-section", candidateIndex), start, end, text: input.slice(start, end),
      ...fields(firstPath), provenance: "deterministic-source-authority", ruleId: "source-authority-section"
    });
    const tail = input.slice(end, Math.min(input.length, end + 180));
    const connector = tail.match(/^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)(?=\()/i);
    const list = connector ? EmbeddedReferences.parseUnitList(input, end + connector[0].length) : null;
    let previousPath = firstPath;
    for (const [memberIndex, member] of (list?.members || []).entries()) {
      const targetPath = resolvedSectionContinuationPath(context, "", section, previousPath, member.tokens || []);
      if (!targetPath) continue;
      previousPath = targetPath;
      results.push({
        id: makeId(context, member.start, "source-authority-section-continuation", memberIndex),
        start: member.start, end: member.end, text: member.text, ...fields(targetPath),
        provenance: "deterministic-source-authority", ruleId: "source-authority-section-continuation"
      });
    }
  }
  return results;
}

function explicitCitationContinuationCandidates(text, context, baseReferences = []) {
  const input = String(text || "");
  const results = [];
  const bases = (baseReferences || [])
    .filter(reference => ["explicit-usc", "explicit-ina", "explicit-cfr"].includes(reference.ruleId) && ["usc", "ina", "cfr"].includes(reference.family) && reference.targetSection)
    .sort((left, right) => left.end - right.end || left.start - right.start);
  for (const base of bases) {
    let cursor = base.end;
    let currentSection = String(base.targetSection);
    let currentInaSection = String(base.inaSection || "");
    let previousPath = (base.targetPath || []).map(String);
    let referenceIndex = 0;
    // A written title designator commonly governs a complete authority list:
    // “6 U.S.C. 112(a)(2), 112(a)(3), 112(b)(1), 202” or
    // “8 U.S.C. 1182(m), (n), and (t)”.  Walk only the coordinated citation
    // grammar and stop at a semicolon or prose, so the title cannot leak into
    // a later authority.
    while (cursor < input.length && cursor - base.end < 1600) {
      const ignorable = input.slice(cursor).match(/^\s+(?:note\b|et\s+seq\.?\b)/i);
      if (ignorable) cursor += ignorable[0].length;
      const connector = input.slice(cursor).match(/^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or|through|to)\s+)/i);
      if (!connector) break;
      let memberStart = cursor + connector[0].length;
      const repeatedUnit = input.slice(memberStart).match(/^(?:(?:sections?|§{1,2})\s*)/i);
      if (repeatedUnit) memberStart += repeatedUnit[0].length;
      const remainder = input.slice(memberStart);
      const relative = remainder.match(/^((?:\([A-Za-z0-9-]+\))(?:\s*\([A-Za-z0-9-]+\))*)/);
      const absolute = base.family === "cfr"
        ? remainder.match(/^(\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?(?:\s*\([A-Za-z0-9-]+\))*-\d+(?:\.\d+)?[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?)((?:\s*\([A-Za-z0-9-]+\))*)/)
        : remainder.match(/^(\d+[A-Za-z]*(?:-\d+[A-Za-z]*)?)((?:\s*\([A-Za-z0-9-]+\))*)/);
      if (!relative && !absolute) break;
      let memberEnd;
      let sourceText;
      let targetPath;
      if (absolute) {
        const writtenSection = absolute[1];
        if (base.family === "ina") currentInaSection = writtenUscSection(writtenSection);
        else currentSection = base.family === "cfr" ? writtenCfrSection(writtenSection) : writtenUscSection(writtenSection);
        const normalizedSection = base.family === "ina" ? currentInaSection : currentSection;
        targetPath = normalizedSection === writtenSection ? pathTokens(absolute[2]) : [];
        if (targetPath.length > 1 && /^(?:17|18|19|20)\d{2}$/.test(targetPath.at(-1))) targetPath.pop();
        memberEnd = memberStart + absolute[0].length;
        sourceText = normalizedSection === writtenSection ? absolute[0] : absolute[0].slice(0, absolute[0].indexOf(writtenSection) + normalizedSection.length);
      } else {
        const tokens = pathTokens(relative[1]);
        targetPath = base.family === "ina"
          ? resolvedInaContinuationPath(context, currentInaSection, previousPath, tokens) || resolvedSectionContinuationPath(
            context, "8", String(context.inaMap?.get(currentInaSection.toLowerCase())?.uscSection || currentInaSection), previousPath, tokens
          )
          : base.family === "cfr"
          ? resolvedCfrContinuationPath(context, String(base.targetTitle || ""), currentSection, previousPath, tokens)
          : resolvedSectionContinuationPath(context, String(base.targetTitle || "8"), currentSection, previousPath, tokens);
        memberEnd = memberStart + relative[0].length;
        sourceText = relative[0];
      }
      if (!targetPath) break;
      previousPath = targetPath;
      const ruleId = `${base.ruleId === "explicit-ina" || base.family === "ina" ? "explicit-ina" : base.family === "cfr" ? "explicit-cfr" : "explicit-usc"}-continuation`;
      let target;
      if (base.family === "ina") target = inaReferenceTarget(context, currentInaSection, targetPath);
      else if (base.family === "cfr") {
        const title = String(base.targetTitle || ""), section = currentSection;
        target = {
          family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath,
          resolution: localCfrTarget(context, title, section, targetPath) ? "local" : "official-source-only",
          officialUrl: ecfrSectionUrl(title, section)
        };
      } else {
        const title = String(base.targetTitle || ""), section = currentSection;
        target = {
          family: "usc", targetKind: "usc", targetTitle: title, targetSection: section, targetPath,
          resolution: localUscTarget(context, title, section, targetPath) ? "local" : "official-source-only",
          officialUrl: houseSectionUrl(title, section)
        };
      }
      results.push({
        id: makeId(context, memberStart, ruleId, referenceIndex++), start: memberStart, end: memberStart + sourceText.length, text: sourceText,
        ...target, provenance: "deterministic-parser", ruleId
      });
      cursor = memberEnd;
    }
  }
  return results;
}

function targetFromHouseHref(href) {
  let match = String(href || "").match(/^\/us\/usc\/t([^/]+)\/s([^/]+)(?:\/(.*))?$/);
  if (match) return { family: "usc", title: match[1], section: match[2], path: match[3] ? match[3].split("/").filter(Boolean) : [] };
  match = String(href || "").match(/^\/us\/pl\/(\d+)\/(\d+)(?:\/(.*))?$/);
  if (match) return { family: "public-law", title: match[1], section: match[2], path: match[3] ? match[3].split("/").filter(Boolean) : [] };
  match = String(href || "").match(/^\/us\/stat\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (match) return { family: "statutes-at-large", title: match[1], section: match[2], path: match[3] ? match[3].split("/").filter(Boolean) : [] };
  return null;
}

function editorialCorrectionTarget(reference, footnote) {
  const noteText = String(footnote?.text || "");
  if (!/\bprobably should be\b/i.test(noteText)) return null;
  const linked = (footnote.uslmReferences || []).map(item => targetFromHouseHref(item.houseHref)).filter(Boolean);
  if (linked.length === 1) return linked[0];
  const publicLaw = noteText.match(/Public\s+Law\s+(\d+)[–—-](\d+)/i);
  if (publicLaw) return { family: "public-law", title: publicLaw[1], section: publicLaw[2], path: [] };
  if (reference.family !== "usc" && reference.family !== "ina") return null;
  const correctionText = noteText.slice(noteText.search(/\bprobably should be\b/i)).replace(/^.*?\bshould be\b\s*/i, "");
  if (/^[\s“"']*\(/.test(correctionText) && reference.targetSection) {
    const correctedAddress = correctionText.match(/^[\s“"']*((?:\([A-Za-z0-9-]+\))+)/)?.[1] || "";
    const correctedTokens = pathTokens(correctedAddress);
    const priorPath = [...(reference.targetPath || [])].map(String);
    const retained = Math.max(0, priorPath.length - correctedTokens.length);
    return {
      family: "usc",
      title: String(reference.targetTitle || "8"),
      section: String(reference.targetSection),
      path: correctedTokens.length ? [...priorPath.slice(0, retained), ...correctedTokens] : priorPath
    };
  }
  const citation = correctionText.match(/^(?:a\s+reference\s+to\s+)?(?:section\s+)?[“"'(]*(\d+[A-Za-z-]*)((?:\([A-Za-z0-9-]+\))*)/i);
  if (!citation) return null;
  return {
    family: "usc",
    title: String(reference.targetTitle || "8"),
    section: citation[1],
    path: pathTokens(citation[2])
  };
}

function applyHouseEditorialCorrection(reference, context) {
  const footnoteReference = (context.sourceFootnoteReferences || [])
    .filter(item => item.offset >= reference.end && item.offset - reference.end <= 12)
    .filter(item => /^[\s\])}.,;:]*$/.test(String(context.sourceText || "").slice(reference.end, item.offset)))
    .sort((left, right) => left.offset - right.offset)[0];
  if (!footnoteReference) return reference;
  const footnote = context.houseFootnotes?.get(footnoteReference.id);
  const target = editorialCorrectionTarget(reference, footnote);
  if (!target) return reference;
  context.editorialCorrectionUsage?.add(footnoteReference.id);
  if (reference.provenance === "house-uslm-ref") context.houseSourceEditorialCorrectionUsage?.add(footnoteReference.id);
  const corrected = {
    ...reference,
    ...referenceFieldsForTarget(context, target),
    provenance: "house-editorial-correction",
    ruleId: "house-editorial-correction",
    correctionFootnoteId: footnoteReference.id
  };
  delete corrected.houseHref;
  if (corrected.evidenceRecord) {
    corrected.evidenceRecord.ruleId = "house-editorial-correction";
    corrected.evidenceRecord.target = { family: target.family, title: target.title, section: target.section, path: [...target.path] };
    corrected.evidenceRecord.validation = {
      sectionExists: Boolean(target.section),
      pathExists: embeddedTargetExists(context, target),
      unitCompatible: true,
      unique: true
    };
  }
  return corrected;
}

function applyBracketedSourceCorrections(references, context) {
  const input = String(context.sourceText || "");
  const sorted = [...(references || [])].sort((left, right) => left.start - right.start || left.end - right.end);
  return (references || []).map(reference => {
    if (reference.family !== "usc" || !reference.targetSection) return reference;
    const correction = sorted.find(candidate => {
      if (candidate === reference || candidate.family !== "usc" || candidate.start < reference.end || candidate.start - reference.end > 12) return false;
      if (!['house-uslm-ref', 'explicit-usc'].includes(candidate.ruleId)) return false;
      if (String(candidate.targetTitle || "") === String(reference.targetTitle || "")) return false;
      if (String(candidate.targetSection || "").toLowerCase() !== String(reference.targetSection || "").toLowerCase()) return false;
      const leftPath = (reference.targetPath || []).map(token => String(token).toLowerCase());
      const rightPath = (candidate.targetPath || []).map(token => String(token).toLowerCase());
      if (leftPath.length !== rightPath.length || !leftPath.every((token, index) => token === rightPath[index])) return false;
      // The House source uses an immediately adjacent square bracket to
      // correct the preceding parenthetical citation, for example
      // “(3 U.S.C. 1154(b)) [8 U.S.C. 1154(b)]”. Do not infer corrections
      // across prose or from an unlabelled continuation.
      return /^\s*\)\s*\[\s*$/.test(input.slice(reference.end, candidate.start));
    });
    if (!correction) return reference;
    const target = packedTargetBase(correction);
    const corrected = {
      ...reference,
      ...referenceFieldsForTarget(context, target),
      provenance: "house-editorial-correction",
      ruleId: "source-bracket-editorial-correction",
      correctionSourceSpan: { start: correction.start, end: correction.end, text: correction.text }
    };
    delete corrected.houseHref;
    context.sourceBracketCorrectionUsage?.add(`${context.sourceId}:${reference.start}:${reference.end}`);
    return corrected;
  });
}

function correctTruncatedHouseCitations(existing, deterministic, context) {
  return (existing || []).map(reference => {
    if (reference.ruleId !== "house-uslm-ref") return reference;
    const replacement = (deterministic || []).find(candidate =>
      ["explicit-usc", "explicit-cfr"].includes(candidate.ruleId) && candidate.family === reference.family &&
      candidate.start === reference.start && candidate.end > reference.end && candidate.text.startsWith(reference.text)
    );
    if (!replacement) return reference;
    context.houseTruncatedCitationCorrectionUsage?.add(`${context.sourceId}:${reference.start}:${reference.end}`);
    return {
      ...replacement,
      id: reference.id,
      provenance: "house-source-span-correction",
      ruleId: "house-source-span-correction",
      correctionSourceSpan: { start: reference.start, end: reference.end, text: reference.text }
    };
  });
}

function applyHistoricalSourceContext(references, context) {
  if (context.sourceKind !== "usc-note") return references;
  const input = String(context.sourceText || "");
  const sorted = [...(references || [])].sort((left, right) => left.start - right.start || left.end - right.end);
  const historical = new Set();
  const insideHistoricalBracket = reference => {
    const open = input.lastIndexOf("[", reference.start);
    const priorClose = input.lastIndexOf("]", reference.start);
    const close = input.indexOf("]", reference.end);
    if (open <= priorClose || close < 0) return false;
    return /\bformer\b|\bas\s+in\s+effect\b|\beffective\s+before\b/i.test(input.slice(open, close + 1));
  };
  for (const reference of sorted) {
    if (reference.family !== "usc" || !reference.targetSection) continue;
    const prefix = input.slice(Math.max(0, reference.start - 48), reference.start);
    const semicolon = input.indexOf(";", reference.end);
    const boundary = semicolon < 0 ? Math.min(input.length, reference.end + 300) : Math.min(semicolon + 1, reference.end + 300);
    const suffix = input.slice(reference.end, boundary);
    if (/\b(?:old|former)\s*$/i.test(prefix) || /\bunder\s+former\s+(?:section\s+)?$/i.test(prefix) || insideHistoricalBracket(reference) ||
        /\bas\s+in\s+effect\s+(?:before|as\s+of)\b|\beffective\s+before\b|\bimmediately\s+before\b/i.test(suffix)) {
      historical.add(reference);
    }
  }
  for (const reference of sorted) {
    if (historical.has(reference) || reference.family !== "usc" || !reference.targetSection) continue;
    const antecedent = sorted.filter(candidate => historical.has(candidate) && candidate.end <= reference.start &&
      String(candidate.targetTitle || "") === String(reference.targetTitle || "") &&
      String(candidate.targetSection || "").toLowerCase() === String(reference.targetSection || "").toLowerCase() &&
      reference.start - candidate.end <= 420).at(-1);
    if (!antecedent) continue;
    const bridge = input.slice(antecedent.end, reference.start);
    if (!/[.!?][”"')\]]*\s+[A-Z]/.test(bridge) && /\b(?:such|said)\s+section\b/i.test(bridge)) historical.add(reference);
  }
  return (references || []).map(reference => historical.has(reference)
    ? { ...reference, forceOfficial: true, resolution: "official-source-only" }
    : reference);
}

function applyEnclosingPublicLawAmendmentContext(references, context) {
  if (context.sourceKind !== "usc-note") return references;
  const input = String(context.sourceText || "");
  const authorities = (references || []).filter(reference => reference.family === "public-law" && reference.targetCongress && reference.targetLaw);
  return (references || []).map(reference => {
    const prefix = input.slice(Math.max(0, reference.start - 100), reference.start);
    if (!/\bamendments?\s+made\s+by\s+(?:subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\s*$/i.test(prefix)) return reference;
    if (/^(?:\s*[,;]?\s*(?:(?:and|or)\s+)?(?:\([A-Za-z0-9-]+\))+)*\s+of\s+section\s+\d/i.test(input.slice(reference.end, reference.end + 140))) return reference;
    const providedAt = input.toLowerCase().lastIndexOf("provided that", reference.start);
    const authority = authorities
      .filter(candidate => candidate.end <= (providedAt >= 0 ? providedAt : reference.start))
      .filter(candidate => !/\bamended\s+by\s*$/i.test(input.slice(Math.max(0, candidate.start - 40), candidate.start)))
      .sort((left, right) => left.end - right.end).at(-1);
    if (!authority) return reference;
    const authorityPath = (authority.targetPath || []).map(String);
    const sectionIndex = authorityPath.findLastIndex(token => /^(?:s|section-)\d+[A-Za-z]*$/i.test(token));
    if (sectionIndex < 0) return reference;
    const corrected = {
      ...reference,
      family: "public-law",
      targetKind: "public-law",
      targetCongress: String(authority.targetCongress),
      targetLaw: String(authority.targetLaw),
      targetPath: [...authorityPath.slice(0, sectionIndex + 1), ...pathTokens(reference.text)],
      resolution: "official-source-only",
      forceOfficial: true,
      officialUrl: `https://www.govinfo.gov/app/details/PLAW-${authority.targetCongress}publ${authority.targetLaw}`,
      provenance: "deterministic-context"
    };
    const evidence = Number.isInteger(reference.evidenceId) ? context.referenceEvidence?.[reference.evidenceId] : null;
    if (evidence) {
      evidence.target = { family: "public-law", title: corrected.targetCongress, section: corrected.targetLaw, path: [...corrected.targetPath] };
      evidence.validation = { sectionExists: true, pathExists: false, unitCompatible: true, unique: true };
    }
    return corrected;
  });
}

function applySourceTypoTrailingContainerContext(references, context) {
  if (context.kind !== "usc") return references;
  const input = String(context.sourceText || "");
  const replacements = new Map();
  for (const phrase of embeddedUnitPhrases(input, context)) {
    if (!/^\s*if\s+section\s+/i.test(input.slice(phrase.list.end))) continue;
    const anchor = (references || []).filter(reference => ["usc", "ina"].includes(reference.family) && reference.targetSection &&
      reference.start >= phrase.list.end && reference.start - phrase.list.end <= 80).sort((left, right) => left.start - right.start)[0];
    const base = packedTargetBase(anchor);
    if (!base) continue;
    const targets = expandedEmbeddedTargets(context, base, phrase);
    phrase.members.forEach((member, index) => {
      const target = targets[index];
      if (!target) return;
      replacements.set(`${member.start}:${member.end}`, referenceFieldsForTarget(context, target));
    });
  }
  return (references || []).map(reference => {
    const replacement = replacements.get(`${reference.start}:${reference.end}`);
    if (!replacement) return reference;
    const corrected = { ...reference, ...replacement, provenance: "house-editorial-correction", ruleId: "source-bracket-editorial-correction" };
    const evidence = Number.isInteger(reference.evidenceId) ? context.referenceEvidence?.[reference.evidenceId] : null;
    if (evidence) {
      evidence.ruleId = corrected.ruleId;
      evidence.target = { family: corrected.family, title: corrected.targetTitle, section: corrected.targetSection, path: [...corrected.targetPath] };
      evidence.validation = { sectionExists: Boolean(corrected.targetSection), pathExists: corrected.resolution === "local", unitCompatible: true, unique: true };
    }
    return corrected;
  });
}

function embeddedUnitPhrases(text, context = {}) {
  const input = String(text || "");
  const phrases = [];
  if (!EmbeddedReferences?.parseUnitList) return phrases;
  const pattern = /\b(sections?|subsections?|paragraphs?|subdivisions?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi;
  for (const match of input.matchAll(pattern)) {
    const kind = unitKind(match[1]);
    let listStart = match.index + match[0].length;
    const editorialMarker = input.slice(listStart).match(/^\s+\d{1,2}\s+(?=\()/);
    if (editorialMarker) listStart += editorialMarker[0].length;
    const parsedList = EmbeddedReferences.parseUnitList(input, listStart);
    const list = extendInterruptedUnitList(input, parsedList);
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
      members: list.members,
      relativeToPriorReference: /^\s*(?:\([^()]{1,160}\)\s*)?(?:thereof|of\s+(?:said|such|that)\s+section)\b/i.test(input.slice(list.end))
    });
  }
  return phrases;
}

function balancedParentheticalEnd(input, start) {
  if (String(input || "")[start] !== "(") return -1;
  let depth = 0;
  for (let index = start; index < String(input || "").length; index++) {
    if (input[index] === "(") depth++;
    else if (input[index] === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

function extendInterruptedUnitList(input, list) {
  if (!list?.members?.length || !EmbeddedReferences?.parseUnitList) return list;
  const members = [...list.members];
  let end = list.end;
  for (let pass = 0; pass < 3; pass++) {
    const whitespace = String(input || "").slice(end).match(/^\s*/)?.[0] || "";
    const groupStart = end + whitespace.length;
    const groupEnd = balancedParentheticalEnd(input, groupStart);
    if (groupEnd < 0) break;
    const groupText = input.slice(groupStart, groupEnd);
    if (/^\([A-Za-z0-9-]+\)(?:\s*\([A-Za-z0-9-]+\))*$/.test(groupText)) break;
    const connector = input.slice(groupEnd).match(/^\s*,?\s*(?:(?:and|or)\s+)?(?=\()/i);
    if (!connector) break;
    const continuation = EmbeddedReferences.parseUnitList(input, groupEnd + connector[0].length);
    if (!continuation?.members?.length) break;
    members.push(...continuation.members);
    end = continuation.end;
  }
  return members.length === list.members.length ? list : { ...list, end, text: input.slice(list.start, end), members, listMembers: members, tokens: members.map(member => member.tokens), listTokens: members.map(member => member.tokens), next: end };
}

function implicitUnitPhrases(text) {
  const input = String(text || "");
  const phrases = [];
  if (!EmbeddedReferences?.parseUnitList) return phrases;
  for (const match of input.matchAll(/\b(?:under|in)\s+/gi)) {
    const list = EmbeddedReferences.parseUnitList(input, match.index + match[0].length);
    if (!list) continue;
    const tail = input.slice(list.end).match(/^\s+(above|below)\b/i);
    if (!tail) continue;
    phrases.push({
      type: "implicit-unit-list",
      start: match.index,
      end: list.end + tail[0].length,
      text: input.slice(match.index, list.end + tail[0].length),
      unitKind: "",
      unitPlural: list.members.length > 1,
      unitSpan: { start: match.index, end: match.index + match[0].trimEnd().length, text: match[0].trimEnd() },
      list,
      members: list.members,
      relation: tail[1].toLowerCase()
    });
  }
  return phrases;
}

function embeddedTargetExists(context, target) {
  if (target.family === "cfr") return localCfrTarget(context, target.title, target.section, target.path);
  if (target.family === "usc" || target.family === "ina") return localUscTarget(context, target.title || "8", target.section, target.path);
  return false;
}

function embeddedTargetUnitMatches(context, target, baseDepth, expectedKind) {
  if (target.family !== "usc" && target.family !== "ina") return true;
  const title = target.title || "8";
  const path = canonicalLocalUscPath(context, title, target.section, target.path);
  const record = context.uscUnits?.get(unitPathKey(title, target.section, path));
  if (!record) return true;
  const expected = unitTypeCode(expectedKind);
  return expected < 0 || record.unitTypes?.[baseDepth] === expected || record.unitType === expected;
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

function inferredDirectContainer(context, phrase, anchorReferences = [], state = null) {
  if (context.kind === "cfr") return null;
  const title = String(context.title || "8");
  const section = String(context.section || "");
  if (!section) return null;
  const input = String(context.sourceText || "");
  const phrasePrefix = input.slice(Math.max(0, phrase.start - 90), phrase.start);
  if (context.sourceKind === "usc-note" && /\bamendments?\s+made\s+by\s*$/i.test(phrasePrefix)) {
    const providedAt = input.toLowerCase().lastIndexOf("provided that", phrase.start);
    const authority = (anchorReferences || [])
      .filter(reference => reference.family === "public-law" && reference.end <= (providedAt >= 0 ? providedAt : phrase.start))
      .filter(reference => !/\bamended\s+by\s*$/i.test(input.slice(Math.max(0, reference.start - 28), reference.start)))
      .sort((left, right) => left.end - right.end).at(-1);
    const target = packedTargetBase(authority);
    if (target?.family === "public-law") {
      const sectionIndex = target.path.map(String).findLastIndex(token => /^(?:s|section-)\d+[A-Za-z]*$/i.test(token));
      if (sectionIndex >= 0) return { ...target, path: target.path.slice(0, sectionIndex + 1), forceOfficial: true };
    }
  }
  const activeMarker = activeInlineUnitMarker(context, phrase.start);
  const sourcePaths = [activeMarker?.path, context.path].filter(Boolean).map(path => path.map(String));
  const inheritedTargets = inheritedFrameContainers(state, parentContainerKind(phrase.unitKind), context, phrase.start);
  const antecedentTargets = phrase.relativeToPriorReference
    ? anchorReferences.filter(reference => reference.family === "usc" && reference.targetSection && reference.end <= phrase.start)
      .sort((left, right) => right.end - left.end)
      .map(reference => ({ title: String(reference.targetTitle || "8"), section: String(reference.targetSection), path: [...(reference.targetPath || [])].map(String) }))
    : [];
  const validates = base => {
    const targets = expandedEmbeddedTargets(context, { family: "usc", ...base }, phrase);
    return targets.length === phrase.members.length && targets.every(target => localUscTarget(context, target.title, target.section, target.path) && embeddedTargetUnitMatches(context, target, base.path.length, phrase.unitKind));
  };
  const validatesStructurally = base => {
    const targets = expandedEmbeddedTargets(context, { family: "usc", ...base }, phrase);
    return targets.length === phrase.members.length && targets.every(target => localUscTarget(context, target.title, target.section, target.path));
  };
  const anaphoricBridge = String(context.sourceText || "").slice(Math.max(0, phrase.start - 100), phrase.start);
  if (/\b(?:such|said|that)\s+section\b[\s\S]*$/i.test(anaphoricBridge)) {
    const anaphoricFrames = (state?.frames || [])
      .filter(frame => frame.kind === "section" && frame.section)
      .sort((left, right) => right.end - left.end)
      .map(frame => ({ title: String(frame.title || "8"), section: String(frame.section), path: [...frame.path].map(String) }))
      .filter(validatesStructurally);
    if (anaphoricFrames.length) return { family: "usc", ...anaphoricFrames[0], allowUnitMismatch: true };
  }
  if (phrase.relativeToPriorReference) {
    const eligibleStateFrames = (state?.frames || []).filter(frame => frame.family === "usc" && frame.section && (frame.sourceId !== context.sourceId || frame.end <= phrase.start));
    const sameSourceFrames = eligibleStateFrames.filter(frame => frame.sourceId === context.sourceId);
    const stateMatches = [...(sameSourceFrames.length ? sameSourceFrames.sort((left, right) => right.end - left.end) : eligibleStateFrames.reverse())]
      .filter(frame => validatesStructurally({ title: frame.title, section: frame.section, path: frame.path }));
    if (stateMatches.length) {
      const frame = stateMatches[0];
      return { family: "usc", title: frame.title, section: frame.section, path: [...frame.path], allowUnitMismatch: true };
    }
    const relativeMatches = antecedentTargets.filter(validatesStructurally);
    if (relativeMatches.length) return { family: "usc", ...relativeMatches[0], allowUnitMismatch: true };
  }
  const inheritedMatches = inheritedTargets.filter(validates);
  const inheritedBridge = target => String(context.sourceText || "").slice(Math.max(0, target.inheritedEnd || 0), phrase.start);
  const preferredInheritedMatches = inheritedMatches.filter(target =>
    (target.inheritedRelationship === "ancestor-source" && target.section !== section) ||
    (target.inheritedRelationship === "same-source" && phrase.start - target.inheritedEnd <= 180 && !/[.;!?][”"')\]]*\s+[A-Z]/.test(inheritedBridge(target)))
  );
  const inheritedBase = target => {
    const { inheritedRelationship: _relationship, inheritedEnd: _end, ...base } = target;
    return { family: "usc", ...base };
  };
  if (preferredInheritedMatches.length === 1) return inheritedBase(preferredInheritedMatches[0]);
  const currentParent = currentContainerTarget(context, parentContainerKind(phrase.unitKind));
  if (currentParent && validates(currentParent)) return currentParent;
  if (currentParent?.path?.length) {
    const expected = unitTypeCode(parentContainerKind(phrase.unitKind));
    const siblings = context.uscSiblingLists?.get(`${unitPathKey(title, section, currentParent.path.slice(0, -1))}:${expected}`) || [];
    const siblingMatches = siblings
      .filter(path => path.join("/").toLowerCase() !== currentParent.path.join("/").toLowerCase())
      .map(path => ({ title, section, path: [...path].map(String) }))
      .filter(validates);
    if (siblingMatches.length === 1) return { family: "usc", ...siblingMatches[0] };
  }
  const bases = [];
  const identities = new Set();
  for (const sourcePath of sourcePaths) {
    for (let length = sourcePath.length; length >= 0; length--) {
      const path = sourcePath.slice(0, length);
      const identity = path.join("/").toLowerCase();
      if (identities.has(identity)) continue;
      identities.add(identity);
      if (!validates({ title, section, path })) continue;
      bases.push({ family: "usc", title, section, path });
    }
  }
  for (const antecedent of antecedentTargets) {
    if (!validates(antecedent) && !(phrase.relativeToPriorReference && validatesStructurally(antecedent))) continue;
    const identity = `${antecedent.title}:${antecedent.section}:${antecedent.path.join("/")}`.toLowerCase();
    if (!bases.some(base => `${base.title}:${base.section}:${base.path.join("/")}`.toLowerCase() === identity)) bases.push({ family: "usc", ...antecedent });
    break;
  }
  if (bases.length === 1) return bases[0];
  const structuralBases = [];
  for (const sourcePath of sourcePaths) {
    for (let length = sourcePath.length; length >= 0; length--) {
      const candidate = { title, section, path: sourcePath.slice(0, length) };
      if (validatesStructurally(candidate)) structuralBases.push(candidate);
    }
  }
  const sourcePath = (context.path || []).map(String);
  const expectedParentType = unitTypeCode(parentContainerKind(phrase.unitKind));
  for (const record of context.uscUnits?.values?.() || []) {
    if (!Array.isArray(record?.path) || record.unitType !== expectedParentType || !pathStartsWith(record.path, sourcePath)) continue;
    const candidate = { title, section, path: [...record.path].map(String) };
    if (validatesStructurally(candidate)) structuralBases.push(candidate);
  }
  const deepest = Math.max(-1, ...structuralBases.map(base => base.path.length));
  const deepestUnique = new Map(structuralBases.filter(base => base.path.length === deepest).map(base => [base.path.join("/").toLowerCase(), base]));
  if (deepest >= 0 && deepestUnique.size === 1) {
    const structural = [...deepestUnique.values()][0];
    if (!currentParent || structural.path.length >= currentParent.path.length) return { family: "usc", ...structural, allowUnitMismatch: true };
  }
  if (inheritedMatches.length === 1) return inheritedBase(inheritedMatches[0]);
  if (currentParent) return { ...currentParent, allowUnitMismatch: true };
  const firstTokens = phrase.members.map(member => String(member.tokens?.[0] || ""));
  if (parentContainerKind(phrase.unitKind) === "section" && firstTokens.length && firstTokens.every(token => /^[a-z]$/i.test(token))) {
    return { family: "usc", title, section, path: [] };
  }
  return null;
}

function precedingAnchorForWrittenContainer(context, candidate, anchorReferences = []) {
  if (!candidate?.baseTokens?.length || !candidate?.base?.start) return null;
  const input = String(context.sourceText || "");
  const candidates = [];
  const writtenRules = new Set(["house-uslm-ref", "explicit-usc", "context-bare-usc-section", "context-bare-usc-address", "embedded-numbered-section-list"]);
  for (const reference of anchorReferences
    .filter(item => item.family === "usc" && item.targetSection && writtenRules.has(item.ruleId) && item.end <= candidate.base.start && candidate.base.start - item.end <= 420)
    .sort((left, right) => right.end - left.end)) {
    const bridge = input.slice(reference.end, candidate.base.start);
    if (/[.!?][”"')\]]*\s+[A-Z]/.test(bridge)) continue;
    const target = packedTargetBase(reference);
    const resolved = { ...target, path: [...target.path, ...candidate.baseTokens.map(String)] };
    if (!embeddedTargetExists(context, resolved)) continue;
    candidates.push(target);
  }
  const unique = new Map(candidates.map(target => [`${target.title}:${target.section}:${target.path.join("/")}`.toLowerCase(), target]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function topLevelParentheticalMembers(input, start, end) {
  const text = String(input || "").slice(start, end);
  const depthAt = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    depthAt[index] = depth;
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && depth > 0) depth--;
  }
  const members = [];
  for (const match of text.matchAll(/\([A-Za-z0-9-]+\)(?:\s*\([A-Za-z0-9-]+\))*/g)) {
    if (depthAt[match.index] !== 0) continue;
    members.push({ start: start + match.index, end: start + match.index + match[0].length, text: match[0], tokens: pathTokens(match[0]) });
  }
  return members;
}

function topLevelUnitWordBetween(input, start, end, expectedKind = "") {
  const text = String(input || "").slice(start, end);
  let depth = 0;
  const depths = [];
  for (let index = 0; index < text.length; index++) {
    depths[index] = depth;
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && depth > 0) depth--;
  }
  return [...text.matchAll(/\b(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi)]
    .some(match => depths[match.index] === 0 && unitKind(match[1]) !== expectedKind);
}

function parentheticalDepthAtEnd(input, start, end) {
  let depth = 0;
  for (const character of String(input || "").slice(start, end)) {
    if (character === "(") depth++;
    else if (character === ")" && depth > 0) depth--;
  }
  return depth;
}

function sharedTrailingContainerReferenceCandidates(text, context, anchorReferences = []) {
  if (context.kind !== "usc") return [];
  const input = String(text || "");
  const results = [];
  for (const [phraseIndex, unit] of [...input.matchAll(/\b(subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi)].entries()) {
    const kind = unitKind(unit[1]);
    const initialList = EmbeddedReferences.parseUnitList?.(input, unit.index + unit[0].length);
    if (!initialList) continue;
    const listBoundary = initialList?.end || unit.index + unit[0].length;
    const anchor = anchorReferences
      .filter(reference => reference.family === "usc" && reference.targetSection && reference.start >= listBoundary && reference.start - unit.index <= 240)
      .filter(reference => /^\s*(?:of|if\s+section)\s*$/i.test(input.slice(Math.max(unit.index + unit[0].length, input.lastIndexOf(")", reference.start) + 1), reference.start)) || /\b(?:of|if\s+section)\s*$/i.test(input.slice(unit.index + unit[0].length, reference.start)))
      .sort((left, right) => left.start - right.start)[0];
    if (!anchor) continue;
    const bridge = input.slice(unit.index + unit[0].length, anchor.start);
    if (/[.!?][”"')\]]*\s+[A-Z]/.test(bridge) || !/\b(?:of|if\s+section)\s*$/i.test(bridge)) continue;
    if (initialList) {
      const afterList = input.slice(initialList.end, anchor.start);
      // The first parsed list can be followed by same-level alternatives and
      // a nested exception before their one shared trailing section anchor:
      // “subparagraph (A) (other than clause (ii)), (B), or (C) of section …”.
      // The depth and unit checks below keep this within the same citation.
      const simpleTail = /^\s*(?:\([^()]{1,120}\)\s*)?(?:of|if\s+section)\s*$/i.test(afterList);
      const coordinatedTail = context.sourceKind !== "usc-note" && /\b(?:of|if\s+section)\s*$/i.test(afterList) &&
        (/[()]/.test(afterList) || new RegExp(`\\b${kind}s?\\b`, "i").test(afterList));
      if (!simpleTail && !coordinatedTail) continue;
      if (topLevelUnitWordBetween(input, initialList.end, anchor.start, kind) || parentheticalDepthAtEnd(input, initialList.end, anchor.start) > 0) continue;
    }
    const base = packedTargetBase(anchor);
    if (!base) continue;
    const members = topLevelParentheticalMembers(input, unit.index + unit[0].length, anchor.start);
    if (!members.length) continue;
    let memberBase = base;
    const prefix = input.slice(Math.max(0, unit.index - 80), unit.index);
    const nested = prefix.match(/\b(?:subparagraph|paragraph|clause)\s+((?:\s*\([A-Za-z0-9-]+\))+?)\s+\(\s*(?:other\s+than|except(?:ing)?)\s*$/i);
    if (nested) memberBase = { ...base, path: [...base.path, ...pathTokens(nested[1])] };
    const candidate = { unitKind: kind, members };
    const resolved = resolvedEmbeddedTargets(context, memberBase, candidate);
    memberBase = resolved.base;
    let previousMemberPath = [...memberBase.path];
    members.forEach((member, memberIndex) => {
      const progressivePath = resolvedSectionContinuationPath(context, memberBase.title, memberBase.section, previousMemberPath, member.tokens || []);
      const progressiveTarget = progressivePath ? { ...memberBase, path: progressivePath } : null;
      const target = progressiveTarget && embeddedTargetExists(context, progressiveTarget)
        ? progressiveTarget
        : resolved.targets[memberIndex] || { ...memberBase, path: [...memberBase.path, ...member.tokens] };
      previousMemberPath = [...target.path];
      const local = embeddedTargetExists(context, target);
      const targetPath = local ? canonicalLocalUscPath(context, target.title, target.section, target.path) : target.path;
      const resolvedTarget = { ...target, path: targetPath };
      const evidenceBase = {
        ...memberBase,
        kind: parentContainerKind(kind),
        sourceId: context.sourceId,
        start: anchor.start,
        end: anchor.end,
        text: anchor.text
      };
      results.push({
        id: makeId(context, member.start, "embedded-a-shared-trailing-container", phraseIndex * 20 + memberIndex),
        start: member.start, end: member.end, text: member.text,
        family: "usc", targetKind: "usc", targetTitle: target.title, targetSection: target.section, targetPath,
        resolution: local ? "local" : "official-source-only", officialUrl: houseSectionUrl(target.title, target.section),
        provenance: "deterministic-context", ruleId: "embedded-a-shared-trailing-container",
        evidenceRecord: embeddedEvidence(context, member, { unitKind: kind }, resolvedTarget, evidenceBase, "embedded-a-shared-trailing-container")
      });
    });
  }
  return results;
}

function precedingSharedContainerReferenceCandidates(text, context, anchorReferences = []) {
  if (context.kind !== "usc" || !EmbeddedReferences?.parseEmbeddedReferences) return [];
  const input = String(text || "");
  const results = [];
  const writtenRules = new Set(["house-uslm-ref", "explicit-usc", "context-bare-usc-section", "context-bare-usc-address", "embedded-numbered-section-list"]);
  for (const [candidateIndex, candidate] of EmbeddedReferences.parseEmbeddedReferences(input).entries()) {
    if (candidate.baseSection || !candidate.baseTokens?.length || candidate.containerType !== "explicit") continue;
    const anchor = anchorReferences
      .filter(reference => reference.family === "usc" && reference.targetSection && writtenRules.has(reference.ruleId) && reference.end <= candidate.base.start && candidate.base.start - reference.end <= 420)
      .filter(reference => !/[.!?][”"')\]]*\s+[A-Z]/.test(input.slice(reference.end, candidate.base.start)))
      .sort((left, right) => right.end - left.end)[0];
    const anchorBase = packedTargetBase(anchor);
    if (!anchorBase) continue;
    const base = { ...anchorBase, path: [...anchorBase.path, ...candidate.baseTokens.map(String)] };
    if (!embeddedTargetExists(context, base)) continue;
    const targets = expandedEmbeddedTargets(context, base, candidate);
    if (targets.length !== candidate.members.length || !targets.every(target => embeddedTargetExists(context, target))) continue;
    candidate.members.forEach((member, memberIndex) => {
      const target = targets[memberIndex];
      results.push({
        id: makeId(context, member.start, "embedded-a-preceding-container", candidateIndex * 20 + memberIndex),
        start: member.start, end: member.end, text: member.text,
        family: "usc", targetKind: "usc", targetTitle: target.title, targetSection: target.section,
        targetPath: canonicalLocalUscPath(context, target.title, target.section, target.path), resolution: "local",
        officialUrl: houseSectionUrl(target.title, target.section), provenance: "deterministic-context",
        ruleId: "embedded-a-preceding-container",
        evidenceRecord: embeddedEvidence(context, member, candidate, target, {
          ...base,
          kind: candidate.baseKind,
          sourceId: context.sourceId,
          start: candidate.base.start,
          end: candidate.base.end,
          text: candidate.base.text
        }, "embedded-a-preceding-container")
      });
    });
  }
  return results;
}

function expandedEmbeddedTargets(context, base, candidate) {
  const targets = [];
  let previous = null;
  for (const member of candidate.members || []) {
    let target = { family: base.family, title: base.title, section: base.section, path: [...base.path, ...member.tokens.map(String)] };
    if (["usc", "ina"].includes(target.family) && localUscTarget(context, target.title || "8", target.section, target.path)) {
      target.path = canonicalLocalUscPath(context, target.title, target.section, target.path);
    }
    const directIsLocal = embeddedTargetExists(context, target) && embeddedTargetUnitMatches(context, target, base.path.length, candidate.unitKind);
    const continuationPreferred = previous && member.tokens.length < previous.path.length - base.path.length;
    if ((!directIsLocal || continuationPreferred) && previous && previous.family === base.family && previous.title === base.title && previous.section === base.section) {
      const progressivePath = ["usc", "ina"].includes(base.family)
        ? resolvedSectionContinuationPath(context, base.title || "8", base.section, previous.path, member.tokens || [])
        : null;
      const progressive = progressivePath ? { ...target, path: progressivePath } : null;
      if (continuationPreferred && progressive && embeddedTargetExists(context, progressive)) {
        target = { ...progressive, path: canonicalLocalUscPath(context, progressive.title || "8", progressive.section, progressive.path) };
        targets.push(target);
        previous = target;
        continue;
      }
      for (let retained = previous.path.length - 1; retained >= base.path.length; retained--) {
        const continued = { ...target, path: [...previous.path.slice(0, retained), ...member.tokens.map(String)] };
        if (!embeddedTargetExists(context, continued) || !embeddedTargetUnitMatches(context, continued, base.path.length, candidate.unitKind)) continue;
        target = ["usc", "ina"].includes(continued.family)
          ? { ...continued, path: canonicalLocalUscPath(context, continued.title || "8", continued.section, continued.path) }
          : continued;
        break;
      }
    }
    targets.push(target);
    previous = target;
  }
  return targets;
}

function recoveredLocalEmbeddedBase(context, base, candidate) {
  if (base.family !== "usc" || String(base.title) !== "8") return null;
  const tryPaths = paths => {
    const matches = [];
    const seen = new Set();
    for (const path of paths) {
      const normalized = path.map(String);
      const identity = normalized.join("/").toLowerCase();
      if (seen.has(identity) || !pathStartsWith(normalized, base.path)) continue;
      seen.add(identity);
      const alternate = { ...base, path: normalized };
      const targets = expandedEmbeddedTargets(context, alternate, candidate);
      if (targets.every(target => embeddedTargetExists(context, target) && embeddedTargetUnitMatches(context, target, alternate.path.length, candidate.unitKind))) matches.push({ base: alternate, targets });
    }
    return matches.length === 1 ? matches[0] : null;
  };

  if (String(context.section || "") === String(base.section)) {
    const sourcePath = (context.path || []).map(String);
    const sourcePrefixes = [];
    for (let length = base.path.length + 1; length <= sourcePath.length; length++) sourcePrefixes.push(sourcePath.slice(0, length));
    const sourceMatch = tryPaths(sourcePrefixes);
    if (sourceMatch) return sourceMatch;
  }

  const indexedPaths = [];
  const prefix = `${base.title}:${base.section}:`;
  for (const key of context.uscUnits?.keys?.() || []) {
    if (!String(key).startsWith(prefix)) continue;
    indexedPaths.push(String(key).slice(prefix.length).split("/").filter(Boolean));
  }
  return tryPaths(indexedPaths);
}

function resolvedEmbeddedTargets(context, base, candidate) {
  const targets = expandedEmbeddedTargets(context, base, candidate);
  if (targets.every(target => embeddedTargetExists(context, target) && embeddedTargetUnitMatches(context, target, base.path.length, candidate.unitKind))) return { base, targets };
  return recoveredLocalEmbeddedBase(context, base, candidate) || { base, targets };
}

function embeddedOfficialUrl(target) {
  if (target.family === "cfr") return ecfrSectionUrl(target.title, target.section);
  if (target.family === "statutes-at-large") return `https://www.govinfo.gov/app/details/STATUTE-${target.title}/STATUTE-${target.title}-Pg${target.section}`;
  if (target.family === "public-law") return `https://www.govinfo.gov/app/details/PLAW-${target.title}publ${target.section}`;
  if (target.family === "unknown") return govInfoSearchUrl(`${target.title} section ${target.section}${canonicalPath(target.path)}`);
  return houseSectionUrl(target.title, target.section);
}

function canonicalUscTokenAtDepth(token, depth) {
  const value = String(token || "");
  if (depth === 0) return /^[a-z]+$/.test(value);
  if (depth === 1) return /^\d+$/.test(value);
  if (depth === 2) return /^[A-Z]+$/.test(value);
  if (depth === 3) return /^[ivxlcdm]+$/.test(value);
  if (depth === 4) return /^[IVXLCDM]+$/.test(value);
  if (depth % 2 === 1) return /^[a-z]+$/.test(value);
  return /^[A-Z]+$/.test(value);
}

function canonicalActName(value) {
  return String(value || "")
    .replace(/^the\s+/i, "")
    .replace(/^division\s+[A-Z0-9-]+,?\s+title\s+[IVXLCDM0-9-]+\s+of\s+(?:the\s+)?/i, "")
    .replace(/^(?:title\s+)?[IVXLCDM\d-]+\s+of\s+the\s+/i, "")
    .replace(/,\s*hereinafter\s+referred\s+to\s+as\s+the\s+Act\b[\s\S]*$/i, "")
    .replace(/\s+or\s+to\s+the\s+[\s\S]*$/i, "")
    .replace(/,\s*as\s+(?:added|amended|in\s+effect|of\s+the\s+date)[\s\S]*$/i, "")
    .replace(/,\s*\d{4}\s*$/i, "")
    .trim();
}

function namedActContainerPath(value) {
  const text = String(value || "");
  const path = [];
  const division = text.match(/^division\s+([A-Z0-9-]+)\b/i);
  const title = text.match(/^(?:division\s+[A-Z0-9-]+,?\s+)?title\s+([IVXLCDM0-9-]+)\s+of\b/i);
  if (division) path.push(`division-${division[1].toUpperCase()}`);
  if (title) path.push(`title-${title[1].toUpperCase()}`);
  return path;
}

function genericNamedActBefore(input, before) {
  const source = String(input || "").slice(Math.max(0, before - 1600), before);
  const pattern = /\b([A-Z][A-Za-z0-9’'&,-]*(?:\s+(?:[A-Z][A-Za-z0-9’'&,-]*|and|of|the|for|Fiscal|Years?)){0,14}\s+Act(?:\s+of\s+\d{4})?)\b/g;
  let result = "";
  for (const match of source.matchAll(pattern)) result = canonicalActName(match[1]);
  return result;
}

function resolvedSectionContinuationPath(context, title, section, previousPath, tokens) {
  const relative = (tokens || []).map(String);
  for (let retained = previousPath.length; retained >= 0; retained--) {
    if (!plausibleContinuationDepth(previousPath, retained, relative)) continue;
    const candidate = [...previousPath.slice(0, retained), ...relative];
    if (String(title) === "8" && localUscTarget(context, title, section, candidate)) return candidate;
    if (candidate.every((token, depth) => canonicalUscTokenAtDepth(token, depth))) return candidate;
  }
  // Repealed, transferred, and uncodified historical sections are not in
  // the local hierarchy, so their written continuation paths cannot be
  // validated against `uscUnits`. Preserve an explicit sibling continuation
  // structurally: 1485(1), (2) becomes 1485(2), and (a)(1)(A), (B) becomes
  // (a)(1)(B). A repeated leading token supplies its own replacement depth.
  if (!relative.length) return null;
  for (let index = previousPath.length - 1; index >= 0; index--) {
    if (String(previousPath[index]).toLowerCase() === relative[0].toLowerCase()) return [...previousPath.slice(0, index), ...relative];
  }
  const retained = Math.max(0, previousPath.length - Math.max(1, relative.length));
  return [...previousPath.slice(0, retained), ...relative];
}

function resolvedCfrContinuationPath(context, title, section, previousPath, tokens) {
  const relative = (tokens || []).map(String);
  for (let retained = previousPath.length; retained >= 0; retained--) {
    const candidate = [...previousPath.slice(0, retained), ...relative];
    if (localCfrTarget(context, title, section, candidate)) return candidate;
    if (candidate.every((token, depth) => canonicalUscTokenAtDepth(token, depth))) return candidate;
  }
  return relative;
}

function namedActTarget(actName, member, context = {}) {
  const cleanActName = canonicalActName(actName);
  const normalized = cleanActName.toLowerCase();
  const writtenContainers = namedActContainerPath(actName);
  if (/^immigration and (?:nationality|naturalization) act(?: of \d{4})?\b/.test(normalized)) {
    const mapping = context.inaMap?.get(String(member.section || "").toLowerCase());
    const section = String(mapping?.localSection || mapping?.uscSection || "");
    if (!section) return null;
    const noteLocator = /\bnote\b/i.test(String(mapping?.uscLabel || ""));
    const targetPath = noteLocator ? [] : [...(member.tokens || [])].map(String);
    const local = !noteLocator && localUscTarget(context, "8", section, targetPath);
    return {
      family: "usc", targetKind: "usc", targetTitle: "8", targetSection: section, targetPath,
      inaSection: String(member.section), resolution: local ? "local" : "official-source-only", forceOfficial: noteLocator,
      officialUrl: houseSectionUrl("8", section)
    };
  }
  if (normalized.includes("haitian refugee immigration fairness act")) {
    return { family: "public-law", targetKind: "public-law", targetCongress: "105", targetLaw: "277", targetPath: ["division-A", "title-IX", `section-${member.section}`, ...member.tokens], officialUrl: "https://www.govinfo.gov/app/details/PLAW-105publ277" };
  }
  if (normalized.includes("nicaraguan adjustment and central american relief act")) {
    return { family: "public-law", targetKind: "public-law", targetCongress: "105", targetLaw: "100", targetPath: ["title-II", `section-${member.section}`, ...member.tokens], officialUrl: "https://www.govinfo.gov/app/details/PLAW-105publ100" };
  }
  if (normalized.includes("selective training and service act of 1940")) {
    return { family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: "54", targetPage: "885", targetPath: [`section-${member.section}`, ...member.tokens], officialUrl: "https://www.govinfo.gov/app/details/STATUTE-54/STATUTE-54-Pg885" };
  }
  if (normalized.includes("selective service act of 1948")) {
    return { family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: "62", targetPage: "604", targetPath: [`section-${member.section}`, ...member.tokens], officialUrl: "https://www.govinfo.gov/app/details/STATUTE-62/STATUTE-62-Pg604" };
  }
  if (normalized.startsWith("nationality act of 1940")) {
    return { family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: "54", targetPage: "1137", targetPath: [`section-${member.section}`, ...member.tokens], officialUrl: "https://www.govinfo.gov/app/details/STATUTE-54/STATUTE-54-Pg1137" };
  }
  const learnedCodification = context.namedActCodifications?.get(`${normalized}:${String(member.section || "").toLowerCase()}`);
  if (learnedCodification) {
    const targetPath = [...(member.tokens || [])].map(String);
    const local = learnedCodification.title === "8" && localUscTarget(context, learnedCodification.title, learnedCodification.section, targetPath);
    return {
      family: "usc", targetKind: "usc", targetTitle: learnedCodification.title, targetSection: learnedCodification.section,
      targetPath, resolution: local ? "local" : "official-source-only", officialUrl: houseSectionUrl(learnedCodification.title, learnedCodification.section)
    };
  }
  const learnedStatute = context.namedActStatutes?.get(normalized);
  if (learnedStatute) {
    return {
      family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: learnedStatute.volume, targetPage: learnedStatute.page,
      targetPath: [`section-${member.section}`, ...(member.tokens || [])], officialUrl: `https://www.govinfo.gov/app/details/STATUTE-${learnedStatute.volume}/STATUTE-${learnedStatute.volume}-Pg${learnedStatute.page}`
    };
  }
  const learnedPublicLaw = context.namedActPublicLaws?.get(normalized);
  if (learnedPublicLaw) {
    const division = normalized.includes("illegal immigration reform and immigrant responsibility act") && !writtenContainers.some(token => token.toLowerCase() === "division-c") ? ["division-C"] : [];
    return {
      family: "public-law", targetKind: "public-law", targetCongress: learnedPublicLaw.congress, targetLaw: learnedPublicLaw.law,
      targetPath: [...writtenContainers, ...division, `s${member.section}`, ...(member.tokens || [])], officialUrl: `https://www.govinfo.gov/app/details/PLAW-${learnedPublicLaw.congress}publ${learnedPublicLaw.law}`
    };
  }
  const catalogAct = context.namedActs?.get(normalized);
  const writtenPublicLaw = cleanActName.match(/\b(?:Public\s+Law|Pub\.\s*L\.)\s+(\d+)[–—-](\d+)\b/i);
  const publicLaw = catalogAct?.publicLaw?.match(/^(\d+)[–—-](\d+)$/) || writtenPublicLaw;
  if (publicLaw) {
    const congress = publicLaw[1], law = publicLaw[2];
    const division = normalized.includes("illegal immigration reform and immigrant responsibility act") && !writtenContainers.some(token => token.toLowerCase() === "division-c") ? ["division-C"] : [];
    return {
      family: "public-law", targetKind: "public-law", targetCongress: congress, targetLaw: law,
      targetPath: [...writtenContainers, ...division, `section-${member.section}`, ...member.tokens],
      officialUrl: `https://www.govinfo.gov/app/details/PLAW-${congress}publ${law}`
    };
  }
  return {
    family: "unknown", targetKind: "act", targetTitle: cleanActName || "Named Act",
    targetSection: String(member.section || ""), targetPath: [...(member.tokens || [])],
    officialUrl: govInfoSearchUrl(`${cleanActName} section ${member.section}${canonicalPath(member.tokens)}`)
  };
}

function packedTargetBase(target) {
  if (!target) return null;
  const forceOfficial = target.forceOfficial || target.resolution === "official-source-only";
  if (target.family === "statutes-at-large") return { family: target.family, title: target.targetVolume, section: target.targetPage, path: [...(target.targetPath || [])], forceOfficial };
  if (target.family === "public-law") return { family: target.family, title: target.targetCongress, section: target.targetLaw, path: [...(target.targetPath || [])], forceOfficial };
  return { family: target.family, title: target.targetTitle, section: target.targetSection, path: [...(target.targetPath || [])], forceOfficial };
}

function namedActNameBefore(input, before, context) {
  const source = String(input || "").slice(0, before).toLowerCase();
  let result = null;
  const names = new Set([
    "Immigration and Nationality Act",
    "Immigration and Naturalization Act",
    "Immigration and Nationality Act of 1952",
    ...(context.namedActs?.keys?.() || [])
  ]);
  for (const name of names) {
    const index = source.lastIndexOf(String(name).toLowerCase());
    if (index < 0) continue;
    const left = source[index - 1] || " ", right = source[index + name.length] || " ";
    if (/[a-z0-9]/i.test(left) || /[a-z0-9]/i.test(right)) continue;
    if (!result || index + name.length > result.end) result = { name, end: index + name.length };
  }
  return result?.name || genericNamedActBefore(input, before);
}

function enclosingAuthoritySectionTarget(context, section, tokens = []) {
  const authority = context.enclosingAuthority;
  if (!authority || authority.family !== "public-law" || !authority.title || !authority.section) return null;
  return { family: "public-law", title: authority.title, section: authority.section, path: [`s${section}`, ...tokens.map(String)] };
}

function referencedActSectionTargets(section) {
  const targets = new Map();
  for (const note of section?.notes || []) {
    if (note.topic !== "referencesInText") continue;
    const text = String(note.text || "");
    // House headings are flattened into note text, so the first word can be
    // joined as “References in TextSection …”. Accept that source boundary
    // without accepting “section” embedded in arbitrary words.
    const pattern = /(?:\b|Text)section\s+(\d+[A-Za-z]*(?:\([A-Za-z0-9-]+\)){0,7})(?=[\s,;:.])[\s\S]{0,220}?\bis\s+section\s+\1\s+of\s+act\b[\s\S]{0,220}?\b(\d+)\s+Stat\.\s+(\d+)\b/gi;
    for (const match of text.matchAll(pattern)) {
      const address = match[1];
      const sectionMatch = address.match(/^(\d+[A-Za-z]*)/);
      if (!sectionMatch) continue;
      const sourceSection = sectionMatch[1];
      const sourcePath = pathTokens(address);
      const key = `${sourceSection.toLowerCase()}:${sourcePath.map(token => token.toLowerCase()).join("/")}`;
      targets.set(key, {
        family: "statutes-at-large",
        title: match[2],
        section: match[3],
        path: [`section-${sourceSection}`, ...sourcePath]
      });
    }
  }
  return targets;
}

function uniqueActSectionCodifications(corpus) {
  const candidates = new Map();
  const add = (key, title, section, forceOfficial = false) => {
    const normalizedKey = String(key || "").toLowerCase();
    if (!normalizedKey || !title || !section) return;
    const identity = `${title}:${section}`;
    if (!candidates.has(normalizedKey)) candidates.set(normalizedKey, new Map());
    candidates.get(normalizedKey).set(identity, { family: "usc", title: String(title), section: String(section), path: [], forceOfficial });
  };
  const resolvedAddresses = members => {
    const addresses = [];
    let section = "";
    let previousPath = [];
    for (const member of members || []) {
      let memberPath;
      if (member.type === "absolute-section-address") {
        section = String(member.section || "");
        memberPath = (member.tokens || []).map(String);
      } else if (section) {
        const relative = (member.tokens || []).map(String);
        const retained = Math.max(0, previousPath.length - Math.max(1, relative.length));
        memberPath = [...previousPath.slice(0, retained), ...relative];
      }
      if (!section || !memberPath) continue;
      previousPath = memberPath;
      addresses.push({ section, path: memberPath });
    }
    return addresses;
  };
  const bracketedUscAddresses = bracket => {
    const explicit = String(bracket || "").match(/\b(?:former\s+|now\s+)?(\d+)\s+U\.?S\.?C\.?\s+/i);
    if (!explicit || !EmbeddedReferences?.parseNumberedSectionReferences) return [];
    const body = String(bracket).slice((explicit.index || 0) + explicit[0].length)
      .replace(/\b(?:former|now)\s+(?=\d)/gi, "")
      .replace(/\s+(?:et\s+seq\.?|note)\b[\s\S]*$/i, "").trim();
    const parsed = EmbeddedReferences.parseNumberedSectionReferences(`${body} of title ${explicit[1]}`)[0];
    return resolvedAddresses(parsed?.members).map(address => ({ ...address, title: explicit[1] }));
  };
  const collect = value => {
    const text = String(value || "");
    // Learn exact source-section-to-Code-section relationships from the
    // House's bracketed parallel citations. A target may omit the written
    // source path (243(h) ... [8 U.S.C. 1253]); in that case the source path
    // remains the intended subdivision under the codified section.
    const pattern = /\bsection\s+(\d+[A-Za-z]*)((?:\([A-Za-z0-9-]+\)){0,7})\s+of\s+(?:the\s+)?[A-Z][A-Za-z0-9’'&.,\-–— ]{0,100}?\s+Act(?:\s+of\s+\d{4})?\s*\[\s*(?:former\s+)?(\d+)\s+U\.?S\.?C\.?\s+(\d+[A-Za-z-]*)((?:\([A-Za-z0-9-]+\)){0,7})/g;
    for (const match of text.matchAll(pattern)) {
      const sourcePath = pathTokens(match[2]);
      const targetPath = pathTokens(match[5]);
      if (targetPath.length && (sourcePath.length !== targetPath.length || !sourcePath.every((token, index) => token.toLowerCase() === targetPath[index].toLowerCase()))) continue;
      const sourceSection = match[1].toLowerCase();
      const exactKey = `${sourceSection}:${sourcePath.map(token => token.toLowerCase()).join("/")}`;
      const nearby = text.slice(match.index, Math.min(text.length, match.index + match[0].length + 180));
      const historical = /\bformer\s+\d+\s+U\.?S\.?C\.?|\bas\s+in\s+effect\b|\bimmediately\s+before\b/i.test(nearby);
      add(sourceSection, match[3], match[4], historical);
      add(exactKey, match[3], match[4], historical);
      if (historical) add(`former:${sourceSection}`, match[3], match[4], true);
    }
    // Also learn coordinated mappings such as “section 319(e) or 322(d) of
    // such Act [8 U.S.C. 1430(e), 1433(d)]”. The source and target lists must
    // have the same cardinality and compatible written paths.
    if (EmbeddedReferences?.parseNumberedSectionReferences) {
      for (const parsed of EmbeddedReferences.parseNumberedSectionReferences(text)) {
        if (!["named-act", "this-act", "that-act", "such-act"].includes(parsed.scope?.type)) continue;
        const suffix = text.slice(parsed.scope.end);
        const bracketMatch = suffix.match(/^\s*\[([^\]]+)\]/);
        if (!bracketMatch) continue;
        const sourceAddresses = resolvedAddresses(parsed.members);
        const targetAddresses = bracketedUscAddresses(bracketMatch[1]);
        if (!sourceAddresses.length || sourceAddresses.length !== targetAddresses.length) continue;
        const nearby = `${bracketMatch[1]} ${suffix.slice(bracketMatch[0].length, bracketMatch[0].length + 160)}`;
        const historical = /\bformer\s+\d+\s+U\.?S\.?C\.?|\bas\s+in\s+effect\b|\bimmediately\s+before\b/i.test(nearby);
        sourceAddresses.forEach((source, index) => {
          const target = targetAddresses[index];
          if (target.path.length && (source.path.length !== target.path.length || !source.path.every((token, pathIndex) => token.toLowerCase() === target.path[pathIndex].toLowerCase()))) return;
          const sourceSection = source.section.toLowerCase();
          add(sourceSection, target.title, target.section, historical);
          add(`${sourceSection}:${source.path.map(token => token.toLowerCase()).join("/")}`, target.title, target.section, historical);
          if (historical) add(`former:${sourceSection}`, target.title, target.section, true);
        });
      }
    }
  };
  const walkNodes = nodes => {
    for (const node of nodes || []) {
      collect(node.heading);
      collect(node.text);
      walkNodes(node.children);
    }
  };
  for (const section of corpus?.title8?.sections || []) {
    collect(section.heading);
    collect(section.preamble);
    walkNodes(section.body);
    for (const note of section.notes || []) { collect(note.heading); collect(note.text); }
  }
  const unique = new Map();
  for (const [sourceSection, targets] of candidates) if (targets.size === 1) unique.set(sourceSection, [...targets.values()][0]);
  return unique;
}

function discoveredNamedActAuthorities(corpus) {
  const publicLawCandidates = new Map();
  const codificationCandidates = new Map();
  const statuteCandidates = new Map();
  const add = (map, key, identity, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(identity, value);
  };
  const collect = value => {
    const text = String(value || "");
    if (!text || !EmbeddedReferences) return;
    // House notes sometimes flatten a heading directly into its authority
    // line ("Some Act of 1980Pub. L. ..."), while References in Text states
    // the same relationship in prose. Both are exact, corpus-derived
    // evidence of an Act's public-law identity.
    const actNamePattern = "[A-Z][A-Za-z0-9’'&,–—-]*(?:\\s+(?:[A-Z][A-Za-z0-9’'&,–—-]*|and|of|the|for|Fiscal|Years?)){0,14}\\s+Act(?:\\s+of\\s+\\d{4})?";
    const gluedAuthorityPattern = new RegExp(`\\b(${actNamePattern})(?=(?:Public\\s+Law|Pub\\.\\s*L\\.)\\s+\\d+[–—-]\\d+\\b)`, "g");
    for (const match of text.matchAll(gluedAuthorityPattern)) {
      const authority = text.slice(match.index + match[0].length).match(/^(?:Public\s+Law|Pub\.\s*L\.)\s+(\d+)[–—-](\d+)\b/i);
      if (authority) add(publicLawCandidates, canonicalActName(match[1]).toLowerCase(), `${authority[1]}-${authority[2]}`, { congress: authority[1], law: authority[2] });
    }
    const knownAsPattern = new RegExp(`\\b(?:Public\\s+Law|Pub\\.\\s*L\\.)\\s+(\\d+)[–—-](\\d+)\\b[^.;]{0,180}?\\bknown\\s+as\\s+the\\s+(${actNamePattern})`, "gi");
    for (const match of text.matchAll(knownAsPattern)) {
      add(publicLawCandidates, canonicalActName(match[3]).toLowerCase(), `${match[1]}-${match[2]}`, { congress: match[1], law: match[2] });
    }
    for (const match of text.matchAll(/\b(?:Public\s+Law|Pub\.\s*L\.)\s+(\d+)[–—-](\d+)\s*\(\s*[“"']([^()"'”]{2,100}?\s+Act(?:\s+of\s+\d{4})?)[”"']\s*\)/gi)) {
      add(publicLawCandidates, canonicalActName(match[3]).toLowerCase(), `${match[1]}-${match[2]}`, { congress: match[1], law: match[2] });
    }
    const statuteIdentityPattern = new RegExp(`\\b(?:The\\s+)?(${actNamePattern})(?:,\\s*\\d{4})?([\\s\\S]{0,300}?)\\b[Ii]s\\s+[Aa]ct\\b[\\s\\S]{0,180}?\\b(\\d+)\\s+Stat\\.\\s+([\\d,]+)\\b`, "g");
    for (const match of text.matchAll(statuteIdentityPattern)) {
      if (/\bAct\b/.test(match[2])) continue;
      const page = match[4].replace(/,/g, "");
      add(statuteCandidates, canonicalActName(match[1]).toLowerCase(), `${match[3]}:${page}`, { volume: match[3], page });
    }
    const parsed = [
      ...(EmbeddedReferences.parseNumberedSectionReferences?.(text) || []),
      ...(EmbeddedReferences.parseEmbeddedReferences?.(text) || [])
    ];
    for (const candidate of parsed) {
      const scope = candidate.scope || candidate.base?.scope;
      if (!scope || !["named-act", "this-act", "that-act", "such-act"].includes(scope.type)) continue;
      const actName = scope.type === "named-act" ? canonicalActName(scope.actName) : genericNamedActBefore(text, scope.start);
      const actKey = actName.toLowerCase();
      const sourceSection = String(candidate.members?.find(member => member.section)?.section || candidate.baseSection || "");
      const sourceTokens = candidate.members?.find(member => member.section)?.tokens || candidate.baseTokens || [];
      if (!actKey || !sourceSection) continue;
      const suffix = text.slice(scope.end, Math.min(text.length, scope.end + 260));
      const publicLaw = suffix.match(/^([^.;“”]{0,180}?)(?:Public\s+Law|Pub\.\s*L\.)\s+(\d+)[–—-](\d+)\b/i);
      if (publicLaw && !/\b(?:Subsec|Amendment)\b/i.test(publicLaw[1])) {
        add(publicLawCandidates, actKey, `${publicLaw[2]}-${publicLaw[3]}`, { congress: publicLaw[2], law: publicLaw[3] });
      }
      const exactPublicLaw = suffix.match(new RegExp(`^[\\s\\S]{0,320}?\\bis\\s+section\\s+${sourceSection}(?:\\([A-Za-z0-9-]+\\)){0,7}\\s+of\\s+(?:Public\\s+Law|Pub\\.\\s*L\\.)\\s+(\\d+)[–—-](\\d+)\\b`, "i"));
      if (exactPublicLaw) add(publicLawCandidates, actKey, `${exactPublicLaw[1]}-${exactPublicLaw[2]}`, { congress: exactPublicLaw[1], law: exactPublicLaw[2] });
      const usc = suffix.match(/^([^.;“”]{0,180}?)[\[(]\s*(\d+)\s+U\.?S\.?C\.?\s+(\d+[A-Za-z-]*)((?:\([A-Za-z0-9-]+\)){0,7})/i);
      if (!usc || /\b(?:Subsec|Amendment)\b/i.test(usc[1])) continue;
      const afterUsc = suffix.slice((usc.index || 0) + usc[0].length);
      // "8 U.S.C. 1522 note" locates uncodified source material under a
      // Code section; it does not codify the named Act as section 1522.
      if (/^\s+note\b/i.test(afterUsc)) continue;
      const targetPath = pathTokens(usc[4]);
      const compatible = !sourceTokens.length || !targetPath.length || sourceTokens.every((token, index) => String(token).toLowerCase() === String(targetPath[index] || "").toLowerCase());
      if (compatible) add(codificationCandidates, `${actKey}:${sourceSection.toLowerCase()}`, `${usc[2]}:${usc[3]}`, { title: usc[2], section: usc[3] });
    }
  };
  const walkNodes = nodes => {
    for (const node of nodes || []) {
      collect(node.heading);
      collect(node.text);
      walkNodes(node.children);
    }
  };
  for (const section of corpus?.title8?.sections || []) {
    collect(section.heading);
    collect(section.preamble);
    walkNodes(section.body);
    for (const note of section.notes || []) { collect(note.heading); collect(note.text); }
  }
  const namedActPublicLaws = new Map();
  for (const [key, values] of publicLawCandidates) if (values.size === 1) namedActPublicLaws.set(key, [...values.values()][0]);
  const namedActCodifications = new Map();
  for (const [key, values] of codificationCandidates) if (values.size === 1) namedActCodifications.set(key, [...values.values()][0]);
  const namedActStatutes = new Map();
  for (const [key, values] of statuteCandidates) if (values.size === 1) namedActStatutes.set(key, [...values.values()][0]);
  return { namedActPublicLaws, namedActCodifications, namedActStatutes };
}

function anaphoricActSectionTarget(input, candidate, member, context) {
  const scope = candidate?.scope || candidate?.base?.scope;
  if (!scope || !["this-act", "that-act", "such-act"].includes(scope.type)) return null;
  if (scope.type === "this-act") {
    const enclosing = enclosingAuthoritySectionTarget(context, member.section, member.tokens || []);
    if (enclosing) return enclosing;
  }
  const exactKey = `${String(member.section || "").toLowerCase()}:${(member.tokens || []).map(token => String(token).toLowerCase()).join("/")}`;
  const referencedTarget = context.actSectionTargets?.get(exactKey);
  if (referencedTarget) return { ...referencedTarget, path: [...referencedTarget.path] };
  const sourceText = String(input || "");
  const ownHistoricalContext = sourceText.slice(candidate.start, Math.min(sourceText.length, (candidate.scope?.end || candidate.end || 0) + 220));
  const precedingDescription = sourceText.slice(Math.max(0, candidate.start - 120), candidate.start);
  const historicalVersion = /\b(?:old|former)\b|\bas\s+in\s+effect\b|\bimmediately\s+before\b/i.test(ownHistoricalContext) ||
    /\bsuspension\s+of\s+deportation[\s\S]{0,80}\b(?:under|pursuant\s+to)\s*$/i.test(precedingDescription) ||
    /\bdeportation\s+(?:is|being|was|has\s+been)?\s*withheld[\s\S]{0,50}\bunder\s*$/i.test(precedingDescription);
  const learnedExact = context.kind === "usc" ? context.actSectionCodifications?.get(exactKey) : null;
  const learnedFormer = context.kind === "usc" && historicalVersion
    ? context.actSectionCodifications?.get(`former:${String(member.section || "").toLowerCase()}`)
    : null;
  const learnedCodification = learnedFormer || learnedExact;
  if (learnedCodification) return { ...learnedCodification, path: (member.tokens || []).map(String), forceOfficial: Boolean(learnedCodification.forceOfficial || historicalVersion) };
  const nearbyActName = genericNamedActBefore(input, scope.start);
  if (nearbyActName) return packedTargetBase(namedActTarget(nearbyActName, member, context));
  // This index is learned from Title 8's own bracketed parallel citations.
  // Do not project it into CFR prose, whose “Act” antecedent is governed by
  // that CFR scope's separate named-Act policy and local source context.
  const codification = context.kind === "usc"
    ? context.actSectionCodifications?.get(String(member.section || "").toLowerCase())
    : null;
  if (codification) return { ...codification, path: (member.tokens || []).map(String), forceOfficial: Boolean(codification.forceOfficial || historicalVersion) };
  const actName = namedActNameBefore(input, scope.start, context);
  return actName ? packedTargetBase(namedActTarget(actName, member, context)) : null;
}

function immediateBracketedParallelTargets(candidate, sourceText = "") {
  if (!EmbeddedReferences?.parseNumberedSectionReferences) return [];
  const after = Number(candidate?.scope?.end ?? candidate?.base?.scope?.end ?? candidate?.end ?? 0);
  const bracket = String(sourceText || "").slice(after).match(/^\s*\[([^\]]+)\]/);
  if (!bracket) return [];
  const explicit = bracket[1].match(/\b(?:former\s+|now\s+)?(\d+)\s+U\.?S\.?C\.?\s+/i);
  if (!explicit) return [];
  const body = bracket[1].slice((explicit.index || 0) + explicit[0].length)
    .replace(/\b(?:former|now)\s+(?=\d)/gi, "")
    .replace(/\s+(?:et\s+seq\.?|note)\b[\s\S]*$/i, "").trim();
  const parsed = EmbeddedReferences.parseNumberedSectionReferences(`${body} of title ${explicit[1]}`)[0];
  if (!parsed?.members?.length || parsed.members.length !== (candidate.members || []).length) return [];
  let section = "";
  let previousPath = [];
  return parsed.members.map(member => {
    let path;
    if (member.type === "absolute-section-address") {
      section = String(member.section || "");
      path = (member.tokens || []).map(String);
    } else if (section) {
      const continuation = (member.tokens || []).map(String);
      let retained = previousPath.length;
      while (retained >= 0 && !plausibleContinuationDepth(previousPath, retained, continuation)) retained--;
      if (retained < 0) return null;
      path = [...previousPath.slice(0, retained), ...continuation];
    }
    if (!section || !path) return null;
    previousPath = path;
    return {
      family: "usc", title: explicit[1], section, path,
      parallelEvidence: "immediate-bracket", parallelMatch: "aligned-list",
      forceOfficial: /\bformer\b/i.test(bracket[1])
    };
  });
}

function followingParallelTarget(candidate, member, anchorReferences = [], allowPathProjection = false, sourceText = "") {
  const suffix = [...(member?.tokens || [])].map(String);
  if (!suffix.length && !member?.section) return null;
  const after = Number(candidate?.base?.scope?.end ?? candidate?.scope?.end ?? candidate?.base?.end ?? candidate?.end ?? 0);
  const references = anchorReferences
    .filter(reference => reference.start >= after && reference.start - after <= 500 && ["usc", "public-law", "statutes-at-large"].includes(reference.family))
    .sort((left, right) => {
      const qualifier = reference => String(sourceText || "").slice(Math.max(after, reference.start - 24), reference.start).match(/\b(now|former)\s*$/i)?.[1]?.toLowerCase() || "";
      const priority = reference => qualifier(reference) === "now" ? 0 : 1;
      return priority(left) - priority(right) || left.start - right.start || left.end - right.end;
    });
  for (const reference of references) {
    const target = packedTargetBase(reference);
    if (!target?.section) continue;
    const targetPath = (target.path || []).map(String);
    const projectionBridge = String(sourceText || "").slice(after, reference.start);
    const isImmediateBracketedParallel = /^\s*[\[(]\s*(?:\[\s*)?(?:former|now)?\]?\s*$/i.test(projectionBridge);
    const qualifier = String(sourceText || "").slice(Math.max(after, reference.start - 24), reference.start).match(/\b(now|former)\s*$/i)?.[1]?.toLowerCase() || "";
    const isCodeNoteLocator = reference.family === "usc" && /^\s+note\b/i.test(String(sourceText || "").slice(reference.end));
    if (isCodeNoteLocator) return { ...target, path: [], parallelEvidence: "note-locator", parallelMatch: "note-locator", forceOfficial: true };
    if (qualifier === "now") return { ...target, parallelEvidence: "current-recodification", parallelMatch: "current-recodification", forceOfficial: true };
    if (suffix.length && pathEndsWith(targetPath, suffix)) return {
      ...target,
      parallelEvidence: isImmediateBracketedParallel ? "immediate-bracket" : "following-context",
      parallelMatch: "exact-path"
    };
    // Parallel codifications sometimes cite either the enclosing section
    // ("243(h) ... [8 U.S.C. 1253]") or a more specific subdivision named
    // elsewhere in the sentence. The written Act path remains the exact
    // target path when it is a prefix of, or omitted from, that USC anchor.
    if (allowPathProjection && isImmediateBracketedParallel && target.family === "usc" && (targetPath.length === 0 || suffix.every((token, index) => token.toLowerCase() === String(targetPath[index] || "").toLowerCase()))) {
      return { ...target, path: [...suffix], parallelEvidence: "immediate-bracket", parallelMatch: "projected-path" };
    }
    if (allowPathProjection && isImmediateBracketedParallel && target.family === "public-law" && targetPath.length === 0 && member?.section) {
      return { ...target, path: [`s${member.section}`, ...suffix], parallelEvidence: "immediate-bracket", parallelMatch: "projected-path" };
    }
    const namedActPublicLaw = (candidate?.scope || candidate?.base?.scope)?.type === "named-act" && target.family === "public-law" &&
      targetPath.length === 0 && member?.section && reference.start - after <= 240 && !/[.;!?]\s+[A-Z]/.test(projectionBridge);
    if (namedActPublicLaw) {
      const scopedActName = (candidate?.scope || candidate?.base?.scope)?.actName;
      const containers = namedActContainerPath(scopedActName);
      if (canonicalActName(scopedActName).toLowerCase().includes("illegal immigration reform and immigrant responsibility act") && !containers.some(token => token.toLowerCase() === "division-c")) containers.push("division-C");
      return { ...target, path: [...containers, `s${member.section}`, ...suffix], parallelEvidence: "same-citation-public-law", parallelMatch: "same-citation-public-law", forceOfficial: true };
    }
  }
  return null;
}

function followingParallelBase(candidate, anchorReferences = [], allowPathProjection = false, sourceText = "") {
  if (allowPathProjection && candidate?.baseSection) {
    const writtenBase = followingParallelTarget(candidate, {
      section: candidate.baseSection,
      tokens: candidate.baseTokens || []
    }, anchorReferences, true, sourceText);
    if (writtenBase) return writtenBase;
  }
  for (const member of candidate?.members || []) {
    const target = followingParallelTarget(candidate, member, anchorReferences, allowPathProjection, sourceText);
    if (!target) continue;
    return { ...target, path: target.path.slice(0, target.path.length - member.tokens.length) };
  }
  return null;
}

function followingDefinedTermBase(input, phrase, anchorReferences = []) {
  if (phrase?.members?.length !== 1) return null;
  const suffix = (phrase.members[0].tokens || []).map(String);
  if (!suffix.length) return null;
  const candidates = [];
  for (const reference of anchorReferences
    .filter(item => item.start >= phrase.end && item.start - phrase.end <= 120)
    .sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (!/\bas\s+defined\s+in\b/i.test(String(input || "").slice(phrase.end, reference.start))) continue;
    const target = packedTargetBase(reference);
    if (!target?.section) continue;
    for (let index = 0; index + suffix.length <= target.path.length; index++) {
      if (!suffix.every((token, offset) => String(target.path[index + offset]).toLowerCase() === token.toLowerCase())) continue;
      candidates.push({ ...target, path: target.path.slice(0, index) });
      break;
    }
  }
  const unique = new Map(candidates.map(target => [`${target.family}:${target.title}:${target.section}:${target.path.join("/")}`, target]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function writtenBaseTarget(candidate, anchorReferences = []) {
  if (!candidate?.baseSection) return null;
  const expectedPath = (candidate.baseTokens || []).map(String);
  const reference = anchorReferences.find(item => {
    if (item.start < candidate.base.start || item.end > candidate.base.end) return false;
    const sourceSection = String(item.inaSection || item.targetSection || "");
    return sourceSection.toLowerCase() === String(candidate.baseSection).toLowerCase() &&
      pathEndsWith((item.targetPath || []).map(String), expectedPath);
  });
  return packedTargetBase(reference);
}

function referenceFieldsForTarget(context, target) {
  const local = embeddedTargetExists(context, target);
  const fields = {
    family: target.family,
    targetKind: target.family,
    targetPath: [...(target.path || [])],
    forceOfficial: Boolean(target.forceOfficial),
    resolution: target.forceOfficial ? "official-source-only" : local ? "local" : "official-source-only",
    officialUrl: embeddedOfficialUrl(target)
  };
  if (target.family === "statutes-at-large") Object.assign(fields, { targetVolume: target.title, targetPage: target.section });
  else if (target.family === "public-law") Object.assign(fields, { targetCongress: target.title, targetLaw: target.section });
  else Object.assign(fields, { targetTitle: target.title, targetSection: target.section });
  return fields;
}

function namedInstrumentTarget(instrumentName, member) {
  const normalized = String(instrumentName || "").toLowerCase();
  if (normalized === "agreement regarding the headquarters of the united nations") {
    return {
      family: "statutes-at-large",
      targetKind: "statutes-at-large",
      targetVolume: "61",
      targetPage: "758",
      targetPath: [`section-${member.section}`, ...member.tokens],
      officialUrl: "https://www.govinfo.gov/app/details/STATUTE-61/STATUTE-61-Pg758"
    };
  }
  return null;
}

function namedInstrumentBaseAfter(input, candidate) {
  if (!candidate?.baseSection) return null;
  const suffix = String(input || "").slice(candidate.base.end);
  const match = suffix.match(/^\s+of\s+(?:the\s+)?(Agreement\s+regarding\s+the\s+Headquarters\s+of\s+the\s+United\s+Nations|Headquarters\s+Agreement\s+with\s+the\s+United\s+Nations)\b/i);
  if (!match) return null;
  const target = namedInstrumentTarget("Agreement regarding the Headquarters of the United Nations", {
    section: candidate.baseSection,
    tokens: candidate.baseTokens || []
  });
  if (!target) return null;
  return {
    family: target.family,
    title: target.targetVolume,
    section: target.targetPage,
    path: target.targetPath,
    kind: candidate.baseKind,
    sourceId: candidate.sourceId,
    start: candidate.base.start,
    end: candidate.base.end + match[0].length,
    text: String(input || "").slice(candidate.base.start, candidate.base.end + match[0].length)
  };
}

function numberedSectionEvidence(context, member, candidate, reference, title, section, path) {
  return {
    resolverVersion: EMBEDDED_RESOLVER_VERSION,
    ruleId: reference.ruleId,
    sourceArtifact: context.uscSourceArtifact || "house-title-8-xml",
    sourceId: context.sourceId,
    sourceField: context.sourceField || "text",
    sourceTextSha256: context.sourceTextSha256 || sourceTextHash(context.sourceText || ""),
    sourceSpan: { start: member.start, end: member.end, text: member.text },
    parsedUnit: "section",
    relativePath: [...(member.tokens || [])],
    base: { kind: "section", path: [], sourceId: context.sourceId, start: candidate.start, end: candidate.end, text: candidate.text },
    target: { family: reference.family, title: title || reference.targetCongress || reference.targetVolume || "", section: section || reference.targetLaw || reference.targetPage || "", path: [...path] },
    validation: { sectionExists: Boolean(section || reference.targetLaw || reference.targetPage), pathExists: reference.resolution === "local", unitCompatible: true, unique: true }
  };
}

function precedingPublicLawAuthority(input, before, anchorReferences = []) {
  const reference = anchorReferences
    .filter(item => item.family === "public-law" && item.end <= before && before - item.end <= 700)
    .sort((left, right) => right.end - left.end)[0];
  if (!reference) return null;
  const bridge = String(input || "").slice(reference.end, before);
  if (/\]|;|[!?][”"')\]]*\s+|\.[”"')\]]*\s+[A-Z]/.test(bridge)) return null;
  return packedTargetBase(reference);
}

function publicLawMemberTarget(authority, member) {
  if (!authority || authority.family !== "public-law") return null;
  const authorityPath = (authority.path || []).map(String);
  let sectionIndex = -1;
  for (let index = authorityPath.length - 1; index >= 0; index--) {
    if (/^(?:s|section-)\d+[A-Za-z]*$/i.test(authorityPath[index])) { sectionIndex = index; break; }
  }
  const containers = sectionIndex >= 0 ? authorityPath.slice(0, sectionIndex) : authorityPath;
  return {
    family: "public-law", targetKind: "public-law", targetCongress: authority.title, targetLaw: authority.section,
    targetPath: [...containers, `s${member.section}`, ...(member.tokens || [])], resolution: "official-source-only",
    officialUrl: `https://www.govinfo.gov/app/details/PLAW-${authority.title}publ${authority.section}`
  };
}

function numberedSectionReferenceCandidates(text, context, anchorReferences = []) {
  if (!EmbeddedReferences?.parseNumberedSectionReferences) return [];
  const input = String(text || "");
  const parsed = EmbeddedReferences.parseNumberedSectionReferences(input);
  const results = [];
  for (const [index, match] of [...input.matchAll(/\bsections?\s+(\d+[A-Za-z-]*)((?:\s*\([A-Za-z0-9-]+\))+?)\s+of\s+([A-Z][A-Z0-9-]{2,})\b/g)].entries()) {
    const catalogAct = context.namedActs?.get(String(match[3]).toLowerCase());
    if (!catalogAct) continue;
    const member = { start: match.index, end: match.index + match[0].length, text: match[0], section: match[1], tokens: pathTokens(match[2]) };
    const target = namedActTarget(catalogAct.name || match[3], member, context);
    if (!target) continue;
    const reference = {
      id: makeId(context, match.index, "embedded-named-act-section", index),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      ...target,
      resolution: target.resolution || "official-source-only",
      provenance: "deterministic-context",
      ruleId: "embedded-named-act-section"
    };
    const evidenceTarget = packedTargetBase(target);
    reference.evidenceRecord = numberedSectionEvidence(context, member, { start: member.start, end: member.end, text: member.text }, reference,
      evidenceTarget?.title, evidenceTarget?.section, evidenceTarget?.path || []);
    results.push(reference);
  }
  let authorityTitle = "";
  const precedingTitle = before => {
    const reference = anchorReferences.filter(item => item.family === "usc" && item.targetTitle && item.end <= before).sort((left, right) => left.end - right.end).at(-1);
    return String(reference?.targetTitle || "");
  };
  for (const candidate of parsed) {
    if (candidate.scope.type === "named-act" || candidate.scope.type === "named-instrument" || candidate.scope.type === "public-law" || ["this-act", "that-act", "such-act"].includes(candidate.scope.type)) {
      const ruleId = candidate.scope.type === "named-instrument" ? "embedded-named-instrument-section" : "embedded-named-act-section";
      const toSectionBoundary = candidate.members.findIndex((member, index) => index > 0 && /\bto\s+sections?\b/i.test(input.slice(candidate.members[index - 1].end, member.start)));
      const precedingAuthority = toSectionBoundary > 0 ? precedingPublicLawAuthority(input, candidate.start, anchorReferences) : null;
      let sourceSection = "";
      let previousSourcePath = [];
      const resolvedMembers = candidate.members.map(member => {
        let tokens;
        if (member.type === "absolute-section-address") {
          sourceSection = String(member.section);
          tokens = [...(member.tokens || [])].map(String);
        } else {
          if (!sourceSection) return null;
          tokens = resolvedSectionContinuationPath(context, String(context.title || "8"), sourceSection, previousSourcePath, member.tokens || []);
        }
        if (!tokens) return null;
        previousSourcePath = tokens;
        return { ...member, section: sourceSection, tokens };
      });
      const alignedParallelTargets = immediateBracketedParallelTargets(candidate, input);
      const references = resolvedMembers.map((member, index) => {
        if (!member) return null;
        const parallel = alignedParallelTargets[index] || followingParallelTarget(candidate, member, anchorReferences, context.kind === "usc", input);
        const anaphoricTarget = anaphoricActSectionTarget(input, candidate, member, context);
        const priorPublicLawTarget = precedingAuthority && index < toSectionBoundary ? publicLawMemberTarget(precedingAuthority, member) : null;
        const namedTarget = priorPublicLawTarget || (candidate.scope.type === "public-law"
            ? {
              family: "public-law", targetKind: "public-law", targetCongress: candidate.scope.congress, targetLaw: candidate.scope.law,
              targetPath: [...(candidate.scope.containers || []), `s${member.section}`, ...(member.tokens || [])], resolution: "official-source-only",
              officialUrl: `https://www.govinfo.gov/app/details/PLAW-${candidate.scope.congress}publ${candidate.scope.law}`
            }
          : candidate.scope.type === "named-act"
            ? namedActTarget(candidate.scope.actName, member, context)
            : candidate.scope.type === "named-instrument"
              ? namedInstrumentTarget(candidate.scope.instrumentName, member)
              : anaphoricTarget ? referenceFieldsForTarget(context, anaphoricTarget) : null);
        const namedBase = packedTargetBase(namedTarget);
        const sameTargetIgnoringCase = namedBase && parallel && namedBase.family === parallel.family &&
          String(namedBase.title).toLowerCase() === String(parallel.title).toLowerCase() &&
          String(namedBase.section).toLowerCase() === String(parallel.section).toLowerCase() &&
          namedBase.path.length === (parallel.path || []).length && namedBase.path.every((token, pathIndex) => String(token).toLowerCase() === String(parallel.path[pathIndex]).toLowerCase());
        const parallelDropsKnownContainers = namedBase && parallel && namedBase.family === parallel.family &&
          String(namedBase.title).toLowerCase() === String(parallel.title).toLowerCase() &&
          String(namedBase.section).toLowerCase() === String(parallel.section).toLowerCase() &&
          namedBase.path.length > (parallel.path || []).length && pathEndsWith(namedBase.path, parallel.path || []);
        // Exact matching paths and explicit current/note locators can supply
        // an unknown authority. An adjacent bracket can override a known
        // target when it identifies a genuinely different codification, but
        // not merely to copy a publisher's case typo into the statutory path.
        const parallelCanSupplyUnknown = (!namedTarget || namedTarget.family === "unknown") && ["exact-path", "current-recodification", "note-locator", "same-citation-public-law"].includes(parallel?.parallelMatch);
        const target = parallel && ((parallel.parallelEvidence === "immediate-bracket" && !sameTargetIgnoringCase && !parallelDropsKnownContainers) || parallelCanSupplyUnknown)
          ? referenceFieldsForTarget(context, parallel)
          : namedTarget;
        if (!target) return null;
        const historicalVersion = /\b(?:old|former)\s*$/i.test(input.slice(Math.max(0, candidate.start - 24), candidate.start)) ||
          /\bas\s+in\s+effect\s+before\b/i.test(input.slice(candidate.start, Math.min(input.length, candidate.scope.end + 140)));
        const forceOfficial = Boolean(historicalVersion || target.forceOfficial);
        const resolution = forceOfficial ? "official-source-only" : target.resolution || "official-source-only";
        const reference = {
          id: makeId(context, member.start, ruleId, index), start: member.start, end: member.end, text: member.text,
          ...target, resolution, forceOfficial, provenance: "deterministic-context", ruleId
        };
        const evidenceTarget = packedTargetBase(target);
        reference.evidenceRecord = numberedSectionEvidence(context, member, candidate, reference, evidenceTarget?.title, evidenceTarget?.section, evidenceTarget?.path || []);
        return reference;
      }).filter(Boolean);
      const complete = references.length === candidate.members.length;
      recordEmbeddedAudit(context, complete ? (references.every(reference => reference.resolution === "local") ? "resolved-local" : "resolved-official-source-only") : "unresolved", candidate, { ruleId, reason: "named-authority-continuation-failed" });
      results.push(...references);
      continue;
    }
    const cfrThisTitle = context.kind === "cfr" && candidate.scope.type === "this-title" &&
      candidate.members.some(member => member.type === "absolute-section-address" && String(member.section).includes("."));
    let title = cfrThisTitle ? String(context.title || "")
      : candidate.scope.type === "numbered-title" ? String(candidate.scope.title)
      : candidate.scope.type === "this-title" ? String(context.title || "8")
      : candidate.scope.type === "such-title" || candidate.scope.type === "that-title" ? writtenTitleBefore(input, candidate.scope.start)
      : authorityTitle || precedingTitle(candidate.start);
    if (!title) {
      recordEmbeddedAudit(context, "ambiguous", candidate, { ruleId: "embedded-numbered-section-list", reason: "missing-title-antecedent" });
      continue;
    }
    let earlierGroupTitle = "";
    let finalTitleGroupStart = 0;
    if (candidate.scope.type === "numbered-title") {
      for (let index = 1; index < candidate.members.length; index++) {
        if (/\bsections?\s*$/i.test(input.slice(candidate.members[index - 1].end, candidate.members[index].start))) finalTitleGroupStart = index;
      }
      if (finalTitleGroupStart > 0) earlierGroupTitle = precedingTitle(candidate.members[finalTitleGroupStart].start);
      if (!earlierGroupTitle || earlierGroupTitle === title) finalTitleGroupStart = 0;
    }
    authorityTitle = title;
    let section = "";
    let previousPath = [];
    const references = [];
    for (const [index, member] of candidate.members.entries()) {
      const memberTitle = finalTitleGroupStart > 0 && index < finalTitleGroupStart ? earlierGroupTitle : title;
      let targetPath;
      if (member.type === "absolute-section-address") {
        section = String(member.section);
        targetPath = (member.tokens || []).map(String);
      } else {
        if (!section) continue;
        targetPath = cfrThisTitle
          ? resolvedCfrContinuationPath(context, memberTitle, section, previousPath, member.tokens || [])
          : resolvedSectionContinuationPath(context, memberTitle, section, previousPath, member.tokens || []);
      }
      if (!targetPath) continue;
      previousPath = targetPath;
      const local = cfrThisTitle ? localCfrTarget(context, memberTitle, section, targetPath) : localUscTarget(context, memberTitle, section, targetPath);
      const reference = {
        id: makeId(context, member.start, "embedded-numbered-section-list", index), start: member.start, end: member.end, text: member.text,
        family: cfrThisTitle ? "cfr" : "usc", targetKind: cfrThisTitle ? "cfr" : "usc", targetTitle: memberTitle, targetSection: section, targetPath,
        resolution: local ? "local" : "official-source-only", officialUrl: cfrThisTitle ? ecfrSectionUrl(memberTitle, section) : houseSectionUrl(memberTitle, section),
        provenance: "deterministic-context", ruleId: "embedded-numbered-section-list"
      };
      reference.evidenceRecord = numberedSectionEvidence(context, member, candidate, reference, memberTitle, section, targetPath);
      references.push(reference);
    }
    if (references.length !== candidate.members.length) recordEmbeddedAudit(context, "unresolved", candidate, { ruleId: "embedded-numbered-section-list", reason: "section-continuation-failed" });
    else recordEmbeddedAudit(context, references.every(reference => reference.resolution === "local") ? "resolved-local" : "resolved-official-source-only", candidate, { ruleId: "embedded-numbered-section-list" });
    results.push(...references);
  }
  return results;
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
  const family = reference?.family || (context.kind === "cfr" ? "cfr" : "usc");
  const title = family === "public-law" ? reference?.targetCongress
    : family === "statutes-at-large" ? reference?.targetVolume
    : reference?.targetTitle;
  const section = family === "public-law" ? reference?.targetLaw
    : family === "statutes-at-large" ? reference?.targetPage
    : reference?.targetSection;
  if (!section) return null;
  const match = String(reference.text || "").match(/\b(section|subsection|paragraph|subparagraph|clause|subclause|item|subitem)s?\b/i);
  const sectionRules = new Set(["explicit-usc", "explicit-ina", "context-bare-usc-section", "context-bare-usc-address", "context-cfr-ina-act-section", "embedded-numbered-section-list", "embedded-named-act-section"]);
  const kind = unitKind(match?.[1]) || (sectionRules.has(reference.ruleId) || reference.provenance === "house-uslm-ref" ? "section" : "");
  if (!kind) return null;
  return {
    kind,
    family,
    title: String(title || (family === "usc" ? "8" : context.title || "")),
    section: String(section),
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
  const sameSource = compatible.filter(frame => frame.sourceId === sourceId);
  if (sameSource.length) return sameSource.sort((left, right) => left.end - right.end || left.start - right.start).at(-1);
  return compatible.at(-1);
}

function inheritedExplicitSourceSectionBase(state, candidate, context) {
  if (!candidate?.baseSection || !state?.frames?.length) return null;
  const sourceSection = String(candidate.baseSection).toLowerCase();
  const sectionMarkers = new Set([`s${sourceSection}`, `section-${sourceSection}`]);
  const baseTokens = (candidate.baseTokens || []).map(String);
  const matches = (state.frames || [])
    .filter(frame => frame.sourceId === context.sourceId && frame.end <= candidate.base.start && ["public-law", "statutes-at-large"].includes(frame.family))
    .map(frame => {
      const markerIndex = (frame.path || []).findLastIndex(token => sectionMarkers.has(String(token).toLowerCase()));
      if (markerIndex < 0) return null;
      return {
        family: frame.family,
        title: String(frame.title || ""),
        section: String(frame.section || ""),
        path: [...frame.path.slice(0, markerIndex + 1), ...baseTokens],
        end: frame.end
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.end - left.end);
  return matches[0] || null;
}

function frameTargetUnitKind(frame, context) {
  if (!frame?.path?.length) return "section";
  if (frame.family !== "usc") return "";
  const record = context.uscUnits?.get(unitPathKey(frame.title, frame.section, frame.path));
  return Number.isInteger(record?.unitType) ? LEVELS[record.unitType] || "" : "";
}

function inheritedFrameContainers(state, kind, context, before) {
  if (!kind || !state?.frames?.length) return [];
  const compatible = state.frames.filter(frame => frame.section && frame.path && frameTargetUnitKind(frame, context) === kind && (frame.sourceId !== context.sourceId || frame.end <= before));
  if (!compatible.length) return [];
  const sameSource = compatible.filter(frame => frame.sourceId === context.sourceId);
  const ancestorSource = compatible.filter(frame => frame.sourceId !== context.sourceId && String(context.sourceId || "").startsWith(`${frame.sourceId}-`));
  const relationship = sameSource.length ? "same-source" : ancestorSource.length ? "ancestor-source" : "other-source";
  const selected = sameSource.length ? sameSource : ancestorSource.length ? ancestorSource : compatible;
  const unique = new Map();
  for (const frame of [...selected].sort((left, right) => right.end - left.end || right.start - left.start)) {
    const target = {
      title: String(frame.title || "8"),
      section: String(frame.section),
      path: [...frame.path].map(String),
      inheritedRelationship: relationship,
      inheritedEnd: Number(frame.end) || 0
    };
    const identity = `${target.title}:${target.section}:${target.path.join("/")}`.toLowerCase();
    if (!unique.has(identity)) unique.set(identity, target);
  }
  return [...unique.values()];
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
  const direct = embeddedUnitPhrases(input, context);
  const implicit = implicitUnitPhrases(input);
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
    const exactWrittenContainer = candidate.containerType === "explicit" || ["this", "such", "preceding", "following"].includes(candidate.anaphorType);
    if (local && !compatible && !exception && !exactWrittenContainer && !base?.allowUnitMismatch) return null;
    const reference = {
      id: makeId(context, member.start, ruleId, index),
      start: member.start,
      end: member.end,
      text: member.text,
      family: target.family,
      targetKind: target.family,
      targetPath: [...target.path],
      resolution: local ? "local" : "official-source-only",
      officialUrl: exception?.officialUrl || embeddedOfficialUrl(target),
      provenance: exception ? "reviewed-exception" : "deterministic-context",
      ruleId,
      evidenceRecord: embeddedEvidence(context, member, candidate, target, base, ruleId)
    };
    if (target.family === "statutes-at-large") Object.assign(reference, { targetVolume: target.title, targetPage: target.section });
    else if (target.family === "public-law") Object.assign(reference, { targetCongress: target.title, targetLaw: target.section });
    else Object.assign(reference, { targetTitle: target.title, targetSection: target.section });
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
      const writtenCfrBase = context.kind === "cfr" && candidate.baseTokens?.length ? {
        family: "cfr", title: String(context.title || ""), section: String(context.section || ""),
        path: candidate.baseTokens.map(String)
      } : null;
      base = writtenCfrBase && embeddedTargetExists(context, writtenCfrBase) ? writtenCfrBase : currentContainerTarget(context, candidate.baseKind);
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
      const scopedBase = candidate.base?.scope;
      if (candidate.baseSection && scopedBase?.type === "numbered-title") {
        base = {
          family: "usc", title: String(scopedBase.title), section: String(candidate.baseSection), path: [...candidate.baseTokens].map(String),
          kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
      } else if (candidate.baseSection && scopedBase?.type === "this-title") {
        base = {
          family: "usc", title: String(context.title || "8"), section: String(candidate.baseSection), path: [...candidate.baseTokens].map(String),
          kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
      } else if (candidate.baseSection && (scopedBase?.type === "such-title" || scopedBase?.type === "that-title")) {
        const title = writtenTitleBefore(input, scopedBase.start);
        if (title) base = {
          family: "usc", title, section: String(candidate.baseSection), path: [...candidate.baseTokens].map(String),
          kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
      } else if (candidate.baseSection && scopedBase?.type === "public-law") {
        base = {
          family: "public-law", title: String(scopedBase.congress), section: String(scopedBase.law), path: [...(scopedBase.containers || []), `s${candidate.baseSection}`, ...candidate.baseTokens.map(String)],
          kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
        ruleId = "embedded-named-act-section";
      } else if (candidate.baseSection && scopedBase?.type === "named-act") {
        const target = packedTargetBase(namedActTarget(scopedBase.actName, { section: candidate.baseSection, tokens: candidate.baseTokens || [] }, context));
        if (target) base = {
          ...target, kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
        ruleId = "embedded-named-act-section";
      } else if (candidate.baseSection && scopedBase?.type === "named-instrument") {
        const target = packedTargetBase(namedInstrumentTarget(scopedBase.instrumentName, { section: candidate.baseSection, tokens: candidate.baseTokens || [] }));
        if (target) base = {
          ...target, kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
        ruleId = "embedded-named-instrument-section";
      } else if (candidate.baseSection && ["this-act", "that-act", "such-act"].includes(scopedBase?.type)) {
        const target = anaphoricActSectionTarget(input, candidate, { section: candidate.baseSection, tokens: candidate.baseTokens || [] }, context);
        if (target) base = {
          ...target, kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text",
          start: candidate.base.start, end: scopedBase.end, text: input.slice(candidate.base.start, scopedBase.end)
        };
        ruleId = "embedded-named-act-section";
      }
      const externalInstrument = namedInstrumentBaseAfter(input, candidate);
      if (!base && externalInstrument) {
        base = { ...externalInstrument, sourceId: context.sourceId, sourceField: context.sourceField || "text" };
        ruleId = "embedded-named-instrument-section";
      }
      const inheritedSourceSection = inheritedExplicitSourceSectionBase(state, candidate, context);
      if (!base && inheritedSourceSection) {
        base = {
          ...inheritedSourceSection,
          kind: candidate.baseKind,
          sourceId: context.sourceId,
          sourceField: context.sourceField || "text",
          start: candidate.base.start,
          end: candidate.base.end,
          text: candidate.base.text
        };
        ruleId = "embedded-named-act-section";
      }
      const writtenBase = writtenBaseTarget(candidate, anchorReferences);
      if (!base && writtenBase) base = {
        ...writtenBase,
        kind: candidate.baseKind,
        sourceId: context.sourceId,
        sourceField: context.sourceField || "text",
        start: candidate.base.start,
        end: candidate.base.end,
        text: candidate.base.text
      };
      const precedingAnchor = candidate.baseSection ? null : precedingAnchorForWrittenContainer(context, candidate, anchorReferences);
      if (!base && precedingAnchor) base = {
        ...precedingAnchor,
        path: [...precedingAnchor.path, ...candidate.baseTokens.map(String)],
        kind: candidate.baseKind,
        sourceId: context.sourceId,
        sourceField: context.sourceField || "text",
        start: candidate.base.start,
        end: candidate.base.end,
        text: candidate.base.text
      };
      const parallelBase = followingParallelBase(candidate, anchorReferences, context.kind === "usc" && ["this-act", "that-act", "such-act"].includes(scopedBase?.type), input);
      const anaphoricActBaseCanYield = parallelBase?.family === "public-law" && ["this-act", "that-act", "such-act"].includes(scopedBase?.type) && !["public-law", "statutes-at-large"].includes(base?.family);
      if (parallelBase && candidate.baseSection && (!base || base.family === "unknown" || anaphoricActBaseCanYield)) {
        base = {
          ...parallelBase,
          kind: candidate.baseKind,
          sourceId: context.sourceId,
          sourceField: context.sourceField || "text",
          start: candidate.base.start,
          end: candidate.base?.scope?.end || candidate.base.end,
          text: input.slice(candidate.base.start, candidate.base?.scope?.end || candidate.base.end)
        };
      }
      const nested = candidateAt.get(candidate.base.start);
      if (!base && nested && nested !== candidate && nested.list?.end === candidate.base.end) {
        const nestedResolution = resolveCandidate(nested);
        if (nestedResolution?.targets?.length === 1) base = { ...nestedResolution.targets[0], kind: candidate.baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.base.start, end: candidate.base.end, text: candidate.base.text };
      }
      if (!base && !candidate.baseSection && candidate.baseTokens?.length && context.kind !== "cfr") {
        const container = inferredDirectContainer(context, { start: candidate.base.start, unitKind: candidate.baseKind, members: [{ tokens: candidate.baseTokens }] }, anchorReferences, state);
        if (container) base = {
          ...container,
          path: [...container.path, ...candidate.baseTokens.map(String)],
          kind: candidate.baseKind,
          sourceId: context.sourceId,
          sourceField: context.sourceField || "text",
          start: candidate.base.start,
          end: candidate.base.end,
          text: candidate.base.text
        };
      }
      if (!base && candidate.baseSection && !scopedBase && context.sourceKind === "usc-note" && !context.uscSections?.has(`8:${candidate.baseSection}`)) {
        const target = enclosingAuthoritySectionTarget(context, candidate.baseSection, candidate.baseTokens || []);
        if (target) base = {
          ...target,
          kind: candidate.baseKind,
          sourceId: context.sourceId,
          sourceField: context.sourceField || "text",
          start: candidate.base.start,
          end: candidate.base.end,
          text: candidate.base.text
        };
        ruleId = "embedded-named-act-section";
      }
      if (!base && (candidate.baseSection || context.kind === "cfr")) base = {
        family: context.kind === "cfr" ? "cfr" : "usc",
        title: String(context.title || "8"),
        section: String(candidate.baseSection || context.section || ""),
        path: [...candidate.baseTokens].map(String),
        kind: candidate.baseKind,
        sourceId: context.sourceId,
        sourceField: context.sourceField || "text",
        start: candidate.base.start,
        end: candidate.base.end,
        text: candidate.base.text
      };
      const precedingOverride = precedingAnchorForWrittenContainer(context, candidate, anchorReferences);
      if (!candidate.baseSection && precedingOverride) base = {
        ...precedingOverride,
        path: [...precedingOverride.path, ...candidate.baseTokens.map(String)],
        kind: candidate.baseKind,
        sourceId: context.sourceId,
        sourceField: context.sourceField || "text",
        start: candidate.base.start,
        end: candidate.base.end,
        text: candidate.base.text
      };
      addEmbeddedFrame(state, base);
    }
    if (!base) {
      recordEmbeddedAudit(context, "ambiguous", candidate, { ruleId, reason: `missing-${candidate.baseKind}-antecedent` });
      resolving.delete(candidate);
      resolved.set(candidate, null);
      return null;
    }
    const references = [];
    const resolvedTargets = resolvedEmbeddedTargets(context, base, candidate);
    base = resolvedTargets.base;
    const targets = [];
    candidate.members.forEach((member, index) => {
      const target = resolvedTargets.targets[index];
      const reference = makeReference(member, candidate, target, base, ruleId, index);
      if (reference) { references.push(reference); targets.push(target); }
    });
    auditResolution(candidate, references, ruleId);
    const returnedReferences = [...references];
    if (candidate.containerType === "explicit" && candidate.baseTokens?.length && candidate.base?.end > candidate.base?.start) {
      const local = embeddedTargetExists(context, base);
      const baseReference = {
        id: makeId(context, candidate.base.start, "embedded-a-explicit-container-base"),
        start: candidate.base.start,
        end: candidate.base.end,
        text: input.slice(candidate.base.start, candidate.base.end),
        ...referenceFieldsForTarget(context, base),
        resolution: local ? "local" : "official-source-only",
        provenance: "deterministic-context",
        ruleId: "embedded-a-explicit-container-base",
        evidenceRecord: embeddedEvidence(context, {
          start: candidate.base.start,
          end: candidate.base.end,
          text: input.slice(candidate.base.start, candidate.base.end),
          tokens: [...(candidate.baseTokens || [])]
        }, { unitKind: candidate.baseKind }, base, null, "embedded-a-explicit-container-base")
      };
      returnedReferences.push(baseReference);
    }
    if (!candidate.unitPlural && targets.length === 1) addEmbeddedFrame(state, { ...targets[0], kind: candidate.unitKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: candidate.start, end: candidate.end, text: candidate.text, ruleId });
    const value = { references: returnedReferences, targets, base, ruleId };
    resolved.set(candidate, value);
    resolving.delete(candidate);
    return value;
  };

  const events = [
    ...parsed.map(candidate => ({ start: candidate.start, priority: 0, candidate })),
    ...direct.filter(phrase => !parsed.some(candidate => candidate.start === phrase.start && candidate.list?.end === phrase.list.end)).map(phrase => ({ start: phrase.start, priority: 1, phrase })),
    ...implicit.map(phrase => ({ start: phrase.start, priority: 2, phrase }))
  ].sort((left, right) => left.start - right.start || left.priority - right.priority);

  for (const event of events) {
    if (event.candidate) {
      for (const reference of resolveCandidate(event.candidate)?.references || []) results.push(reference);
      continue;
    }
    const phrase = event.phrase;
    const baseKind = parentContainerKind(phrase.unitKind);
    const container = followingDefinedTermBase(input, phrase, anchorReferences) || inferredDirectContainer(context, phrase, anchorReferences, state);
    if (!container) {
      recordEmbeddedAudit(context, "ambiguous", phrase, { ruleId: "embedded-inferred-unit", reason: `no-unique-${baseKind || "container"}` });
      continue;
    }
    const base = { ...container, kind: baseKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: phrase.start, end: phrase.unitSpan.end, text: phrase.unitSpan.text };
    const candidate = { ...phrase, ruleId: "embedded-inferred-unit" };
    const targets = [];
    const references = [];
    const expandedTargets = expandedEmbeddedTargets(context, base, candidate);
    phrase.members.forEach((member, index) => {
      const target = expandedTargets[index] || targetFrom(base.family, base.title, base.section, [...base.path, ...member.tokens]);
      const reference = makeReference(member, candidate, target, base, "embedded-inferred-unit", index);
      if (reference) { results.push(reference); references.push(reference); targets.push(target); }
    });
    auditResolution(candidate, references, "embedded-inferred-unit");
    if (!phrase.unitPlural && targets.length === 1) addEmbeddedFrame(state, { ...targets[0], kind: phrase.unitKind, sourceId: context.sourceId, sourceField: context.sourceField || "text", start: phrase.start, end: phrase.end, text: phrase.text, ruleId: "embedded-inferred-unit" });
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
  return results;
}

function generatedReferences(text, context, existing = []) {
  const footnoteCorrectedExisting = [...(existing || [])].map(reference => applyHouseEditorialCorrection(reference, context));
  const footnoteCorrectedBases = [...explicitReferenceCandidates(text, context), ...bareSectionReferenceCandidates(text, context), ...inaActReferenceCandidates(text, context), ...scopedCfrActReferenceCandidates(text, context), ...contextualReferenceCandidates(text, context)]
    .map(reference => applyHouseEditorialCorrection(reference, context));
  const footnoteCorrectedDeterministic = [
    ...footnoteCorrectedBases,
    ...explicitCitationContinuationCandidates(text, context, footnoteCorrectedBases).map(reference => applyHouseEditorialCorrection(reference, context)),
    ...sourceAuthoritySectionCandidates(text, context, footnoteCorrectedBases).map(reference => applyHouseEditorialCorrection(reference, context))
  ];
  const bracketCorrected = applyBracketedSourceCorrections([...footnoteCorrectedExisting, ...footnoteCorrectedDeterministic], context);
  const deterministic = bracketCorrected.slice(footnoteCorrectedExisting.length).map(reference => canonicalizeUscReference(reference, context));
  const correctedExisting = correctTruncatedHouseCitations(
    bracketCorrected.slice(0, footnoteCorrectedExisting.length).map(reference => canonicalizeUscReference(reference, context)),
    deterministic,
    context
  );
  const occupied = retainNavigableReferences(correctedExisting, context).sort((a, b) => a.start - b.start || a.end - b.end);
  const anchors = [...correctedExisting, ...deterministic];
  const numbered = numberedSectionReferenceCandidates(text, context, anchors);
  const contextualAnchors = [...anchors, ...numbered];
  const candidates = retainNavigableReferences([...deterministic, ...precedingSharedContainerReferenceCandidates(text, context, contextualAnchors), ...sharedTrailingContainerReferenceCandidates(text, context, contextualAnchors), ...numbered, ...embeddedReferenceCandidates(text, context, contextualAnchors)]
    .map(reference => applyHouseEditorialCorrection(reference, context))
    .map(reference => canonicalizeUscReference(reference, context))
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
  const contextualized = applySourceTypoTrailingContainerContext(applyEnclosingPublicLawAmendmentContext(occupied, context), context);
  const finalized = applyHistoricalSourceContext(contextualized, context);
  for (const reference of finalized) delete reference.evidenceRecord;
  return finalized;
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
  const uscCanonicalPaths = new Map();
  const addUscUnit = (section, path, types, virtual = false) => {
    const aliases = new Set([String(section), ...(uscAliases.get(String(section)) || [])]);
    for (const alias of aliases) {
      uscPaths.add(`${alias}:${path.join("/")}`);
      uscUnits.set(unitPathKey("8", alias, path), { path: [...path], unitTypes: [...types], unitType: types.at(-1), virtual });
      uscCanonicalPaths.set(unitPathKey("8", alias, path).toLowerCase(), [...path].map(String));
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
  const namedActs = new Map();
  for (const act of corpus?.namedActs || []) {
    for (const name of [act.name, ...(act.aliases || [])]) if (name) namedActs.set(String(name).toLowerCase(), act);
  }
  const embeddedExceptions = new Map((corpus?.legalReferenceExceptions?.exceptions || []).map(exception => [exception.id, exception]));
  const houseFootnotes = new Map();
  for (const section of corpus.title8?.sections || []) {
    for (const footnote of section.houseEditorialFootnotes || []) houseFootnotes.set(footnote.id, footnote);
  }
  const uscSourceArtifact = corpus.sources?.title8?.sourceArtifact || "house-title-8-xml";
  const cfrSourceArtifacts = new Map();
  for (const source of corpus.cfr?.sources || []) {
    cfrSourceArtifacts.set(`${source.title}:${source.part || "*"}`, source.url || `ecfr-title-${source.title}${source.part ? `-part-${source.part}` : ""}`);
  }
  return { uscSections, uscPaths, uscUnits, uscSiblingLists, uscCanonicalPaths, cfrSections, cfrPaths, cfrUnits, cfrSiblingLists, inaMap, namedActs, embeddedExceptions, houseFootnotes, uscSourceArtifact, cfrSourceArtifacts, legalReferencePolicy: corpus.legalReferencePolicy || null };
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
  const editorialCorrectionUsage = new Set();
  const houseSourceEditorialCorrectionUsage = new Set();
  const sourceBracketCorrectionUsage = new Set();
  const houseTruncatedCitationCorrectionUsage = new Set();
  const learnedNamedActAuthorities = discoveredNamedActAuthorities(corpus);
  const shared = {
    ...legalReferenceContext(corpus),
    actSectionCodifications: uniqueActSectionCodifications(corpus),
    ...learnedNamedActAuthorities,
    referenceAudit, referenceEvidence, embeddedExceptionUsage, editorialCorrectionUsage, houseSourceEditorialCorrectionUsage, sourceBracketCorrectionUsage, houseTruncatedCitationCorrectionUsage
  };
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
      sourceFootnoteReferences: source[`${field}FootnoteReferences`] || [],
      embeddedState
    }, source[property] || []);
    generated += source[property].length - before;
  };
  const walkUsc = (section, nodes, path = [], parentState = newState(), actSectionTargets = referencedActSectionTargets(section)) => {
    let siblingState = newState(parentState.frames);
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const context = {
        kind: "usc", title: "8", section: String(section.section), path: nodePath,
        sourceId: `usc-${section.section}-${nodePath.join("-")}`, suppressSelfReferences: true,
        actSectionTargets
      };
      const nodeState = newState(siblingState.frames);
      attach(node, "heading", context, nodeState);
      attach(node, "text", {
        ...context,
        inlineUnitMarkers: StatuteRunIns?.statuteRunInPathMarkers?.(section, node, nodePath) || []
      }, nodeState);
      walkUsc(section, node.children, nodePath, nodeState, actSectionTargets);
      siblingState = newState(nodeState.frames);
    }
  };
  for (const section of corpus.title8?.sections || []) {
    const context = {
      kind: "usc", title: "8", section: String(section.section), path: [], sourceId: `usc-${section.section}`,
      actSectionTargets: referencedActSectionTargets(section)
    };
    const sectionState = newState();
    attach(section, "heading", { ...context, suppressSelfReferences: true }, sectionState);
    attach(section, "preamble", { ...context, suppressSelfReferences: true }, sectionState);
    attach(section, "sourceCredit", context, newState());
    walkUsc(section, section.body, [], sectionState, context.actSectionTargets);
    (section.notes || []).forEach((note, index) => {
      const enclosingAuthority = packedTargetBase((note.references || []).find(reference => reference.family === "public-law"));
      const noteContext = { ...context, sourceKind: "usc-note", enclosingAuthority, sourceId: `usc-${section.section}-note-${index + 1}` };
      const noteState = newState();
      attach(note, "heading", noteContext, noteState);
      attach(note, "text", noteContext, noteState);
    });
    (section.houseEditorialFootnotes || []).forEach(footnote => attach(footnote, "text", { ...context, sourceId: footnote.id }, newState()));
  }
  const attachCfrBlocks = (section, blocks, pathPrefix = [], inheritedState = newState()) => {
    const stateByPath = new Map([["", newState(inheritedState.frames)]]);
    (blocks || []).forEach((block, index) => {
      const path = pathTokens(block.a || block.u?.at(-1)?.a || block.c || "");
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
    houseEditorialCitationCorrections: editorialCorrectionUsage.size,
    houseSourceEditorialCitationCorrections: houseSourceEditorialCorrectionUsage.size,
    sourceBracketCitationCorrections: sourceBracketCorrectionUsage.size,
    houseTruncatedCitationCorrections: houseTruncatedCitationCorrectionUsage.size,
    rules: ["house-uslm-ref", "house-editorial-correction", "house-source-span-correction", "source-bracket-editorial-correction", "explicit-usc", "explicit-usc-continuation", "explicit-ina", "explicit-ina-continuation", "explicit-cfr", "explicit-cfr-continuation", "explicit-public-law", "explicit-statutes-at-large", "explicit-federal-register", "source-authority-section", "source-authority-section-list", "source-authority-section-continuation", "context-bare-usc-section", "context-bare-usc-address", "context-bare-historical-act-section", "context-bare-trailing-title-section", "context-cfr-ina-act-section", "context-cfr-scoped-act-section", "context-path-this-section", "embedded-a-explicit-container-base", "embedded-a-preceding-container", "embedded-a-shared-trailing-container", "embedded-explicit-container", "embedded-this-container", "embedded-such-container", "embedded-relative-container", "embedded-numbered-section-list", "embedded-named-act-section", "embedded-named-instrument-section", "embedded-inferred-unit", "embedded-exception"]
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
      const path = pathTokens(block.a || block.u?.at(-1)?.a || block.c || "");
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
  numberedSectionReferenceCandidates,
  inaActReferenceCandidates,
  legalReferenceContext,
  pathTokens,
  validateEmbeddedReferenceExceptions,
  validateLegalReferencePolicy
};
});
