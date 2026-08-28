(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.INASearchEmbeddedReferences = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

/*
 * Parse the small, unambiguous family of statutory references which name a
 * unit list and its containing unit, for example:
 *
 *   subparagraphs (A)(i)(I), (B), (D), and (E) of subsection (a)(2)
 *   paragraphs (1) and (2) of this subsection
 *
 * This module deliberately stops at syntax.  It does not expand ranges,
 * resolve anaphora, or look up a section in a corpus.  All positions are
 * offsets into the supplied JavaScript string (and therefore count UTF-16
 * code units, as String#slice does).
 */

const UNIT_KINDS = Object.freeze([
  "section",
  "subsection",
  "paragraph",
  "subparagraph",
  "clause",
  "subclause",
  "item",
  "subitem"
]);

const UNIT_KIND_SET = new Set(UNIT_KINDS);
const UNIT_WORD = /\b(subsections?|paragraphs?|subdivisions?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi;
const ANAPHOR_WORD = /\b(this|such|preceding|following)\b/iy;
// Labels in the House/USLM hierarchy are words, numbers, or hyphenated
// combinations thereof.  Keeping this conservative prevents prose in a
// parenthetical from becoming a guessed statutory address.
const LABEL = /[A-Za-z0-9]+(?:[-\u2010\u2011\u2012\u2013\u2014][A-Za-z0-9]+)*/y;
const LIST_CONNECTOR = /(?:,|\b(?:and|or|through|to)\b)/iy;

function canonicalUnitName(value) {
  const singular = String(value || "").toLowerCase().replace(/s$/, "");
  if (singular === "subdivision") return "paragraph";
  return UNIT_KIND_SET.has(singular) ? singular : "";
}

function isPluralUnit(value) {
  return /s$/i.test(String(value || ""));
}

function span(input, start, end, extra = {}) {
  return { start, end, text: input.slice(start, end), ...extra };
}

function skipWhitespace(input, position) {
  let cursor = position;
  while (cursor < input.length && /\s/u.test(input[cursor])) cursor += 1;
  return cursor;
}

function readParenthetical(input, position) {
  if (input[position] !== "(") return null;
  const tokenStart = position + 1;
  const close = input.indexOf(")", tokenStart);
  if (close < 0 || close === tokenStart) return null;
  const token = input.slice(tokenStart, close);
  LABEL.lastIndex = 0;
  LABEL.lastIndex = tokenStart;
  const match = LABEL.exec(input);
  if (!match || match.index !== tokenStart || match[0].length !== token.length) return null;
  return {
    start: position,
    end: close + 1,
    token,
    tokenStart,
    tokenEnd: close
  };
}

function memberFromGroups(input, groups) {
  const first = groups[0];
  const last = groups[groups.length - 1];
  const tokenSpans = groups.map(group => span(input, group.tokenStart, group.tokenEnd, { token: group.token }));
  return {
    start: first.start,
    end: last.end,
    text: input.slice(first.start, last.end),
    tokens: groups.map(group => group.token),
    tokenSpans,
    // `parentheticals` is an intentionally explicit alias: it makes it
    // clear that (A)(i)(I) is one listed member, not three sibling members.
    parentheticals: tokenSpans.map(token => ({ ...token }))
  };
}

function readCompoundMember(input, position) {
  let cursor = position;
  const groups = [];
  const malformedNested = input.slice(position).match(/^\(([A-Za-z0-9-]+)\(([A-Za-z0-9-]+)\)\)/);
  if (malformedNested) {
    const end = position + malformedNested[0].length;
    const innerStart = position + 1 + malformedNested[1].length + 1;
    const tokenSpans = [
      span(input, position + 1, position + 1 + malformedNested[1].length, { token: malformedNested[1] }),
      span(input, innerStart, innerStart + malformedNested[2].length, { token: malformedNested[2] })
    ];
    return {
      member: {
        start: position, end, text: input.slice(position, end), tokens: [malformedNested[1], malformedNested[2]],
        tokenSpans, parentheticals: tokenSpans.map(token => ({ ...token })), malformedNested: true
      },
      end
    };
  }
  while (true) {
    const group = readParenthetical(input, cursor);
    if (!group) break;
    groups.push(group);
    const afterGroup = group.end;
    const whitespaceEnd = skipWhitespace(input, afterGroup);
    // Compound parentheticals are accepted with or without spaces.  A
    // sibling requires a comma or a word connector, which is handled by the
    // list reader below.
    if (input[whitespaceEnd] !== "(") break;
    cursor = whitespaceEnd;
  }
  return groups.length ? { member: memberFromGroups(input, groups), end: groups.at(-1).end } : null;
}

function readConnector(input, position) {
  const start = skipWhitespace(input, position);
  LIST_CONNECTOR.lastIndex = 0;
  LIST_CONNECTOR.lastIndex = start;
  const match = LIST_CONNECTOR.exec(input);
  if (!match || match.index !== start) return null;
  const end = start + match[0].length;
  let finalEnd = end;
  // Oxford-style separators are commonly written ", and" / ", or".  Keep
  // the entire separator in one record so the member offsets remain exact.
  if (match[0] === ",") {
    const wordStart = skipWhitespace(input, end);
    const word = input.slice(wordStart).match(/^(?:and|or)\b/i);
    if (word) finalEnd = wordStart + word[0].length;
  }
  const text = input.slice(start, finalEnd);
  const normalized = text.trim().toLowerCase();
  return {
    start,
    end: finalEnd,
    text,
    kind: normalized === "," ? "comma" : normalized.replace(/^,\s*/, "")
  };
}

/**
 * Parse a parenthetical list beginning at `start`.
 *
 * The return value is null for malformed or incomplete syntax.  This pure
 * helper is exported for callers that need to inspect the list independently
 * of its `of ...` container.
 */
function parseUnitList(input, start = 0) {
  const value = String(input || "");
  let cursor = skipWhitespace(value, start);
  const members = [];
  const connectors = [];
  const first = readCompoundMember(value, cursor);
  if (!first) return null;
  members.push(first.member);
  cursor = first.end;

  while (true) {
    const connector = readConnector(value, cursor);
    if (!connector) break;
    const nextStart = skipWhitespace(value, connector.end);
    const next = readCompoundMember(value, nextStart);
    if (!next) break;
    connectors.push(connector);
    members.push(next.member);
    cursor = next.end;
  }

  const end = members.at(-1).end;
  return {
    start: members[0].start,
    end,
    text: value.slice(members[0].start, end),
    members,
    connectors,
    // These aliases retain the distinction between a list and its member
    // address tokens without making callers reconstruct it.
    tokens: members.map(member => [...member.tokens]),
    listMembers: members,
    listTokens: members.map(member => [...member.tokens]),
    next: cursor
  };
}

function readBaseAddress(input, start) {
  let cursor = skipWhitespace(input, start);
  const groups = [];
  while (true) {
    const group = readParenthetical(input, cursor);
    if (!group) break;
    groups.push(group);
    const after = skipWhitespace(input, group.end);
    if (input[after] !== "(") break;
    cursor = after;
  }
  if (!groups.length) return null;
  const first = groups[0];
  const last = groups.at(-1);
  const tokenSpans = groups.map(group => span(input, group.tokenStart, group.tokenEnd, { token: group.token }));
  return {
    start: first.start,
    end: last.end,
    text: input.slice(first.start, last.end),
    tokens: groups.map(group => group.token),
    tokenSpans
  };
}

function readNumberedSectionAddress(input, start) {
  const cursor = skipWhitespace(input, start);
  const match = input.slice(cursor).match(/^((?:\d+[A-Za-z]+-\d+[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?))/);
  if (!match) return null;
  const section = match[1];
  const sectionStart = cursor;
  let end = cursor + section.length;
  const address = readBaseAddress(input, end);
  if (address) end = address.end;
  return {
    start: sectionStart,
    end,
    text: input.slice(sectionStart, end),
    section,
    tokens: address ? [...address.tokens] : [],
    tokenSpans: address ? address.tokenSpans.map(token => ({ ...token })) : []
  };
}

function makeBase(input, kind, unitWord, unitStart, address, anaphor) {
  const baseStart = anaphor ? anaphor.start : unitStart;
  const baseEnd = address?.end || anaphor?.end || unitStart + unitWord.length;
  const baseText = input.slice(baseStart, baseEnd);
  return {
    kind,
    name: kind,
    unitName: kind,
    unitText: unitWord,
    plural: isPluralUnit(unitWord),
    section: address?.section || "",
    tokens: address ? [...address.tokens] : [],
    tokenSpans: address ? address.tokenSpans.map(token => ({ ...token })) : [],
    start: baseStart,
    end: baseEnd,
    text: baseText
  };
}

function candidateFromMatch(input, unitMatch, unitWord, list, base) {
  const unitKind = canonicalUnitName(unitWord);
  const baseKind = base.kind;
  const anaphorType = base.anaphor?.type || null;
  const start = unitMatch.index;
  const end = base.end;
  const candidate = {
    type: "named-unit-list",
    kind: "named-unit-list",
    ruleId: "embedded-named-unit-list",
    start,
    end,
    text: input.slice(start, end),
    unitName: unitKind,
    unitKind,
    unitText: unitWord,
    unitPlural: isPluralUnit(unitWord),
    unitSpan: span(input, start, start + unitWord.length, {
      name: unitKind,
      kind: unitKind,
      plural: isPluralUnit(unitWord)
    }),
    listSpan: span(input, list.start, list.end),
    list,
    members: list.members,
    listMembers: list.members,
    tokens: list.members.map(member => [...member.tokens]),
    listTokens: list.members.map(member => [...member.tokens]),
    baseKind,
    baseName: baseKind,
    baseSection: base.section || "",
    baseTokens: base.tokens,
    baseSpan: span(input, base.start, base.end),
    base,
    anaphorType,
    anaphor: anaphorType ? {
      type: anaphorType,
      start: base.anaphor.start,
      end: base.anaphor.end,
      text: base.anaphor.text
    } : null,
    containerType: anaphorType ? "relative" : "explicit",
    explicitContainer: !anaphorType
  };
  candidate.unit = { ...candidate.unitSpan, unitName: unitKind };
  // Keep a small, source-preserving record of the base phrase.  Unlike a
  // target path, this is only syntax and cannot be mistaken for resolution.
  candidate.baseKindSpan = span(input, base.unitStart, base.unitEnd, {
    name: baseKind,
    text: base.unitText
  });
  return candidate;
}

function readContainerAfterOf(input, position) {
  let cursor = skipWhitespace(input, position);
  const editorialMarker = input.slice(cursor).match(/^\d{1,2}(?=\s+of\b)/i);
  if (editorialMarker) cursor = skipWhitespace(input, cursor + editorialMarker[0].length);
  if (!/^of\b/i.test(input.slice(cursor))) return null;
  cursor = skipWhitespace(input, cursor + 2);
  // Relative containers retain an expressly written address when one is
  // present (for example, “this paragraph (b)”). Resolution still belongs
  // to the corpus-aware resolver rather than this syntax parser.
  ANAPHOR_WORD.lastIndex = 0;
  ANAPHOR_WORD.lastIndex = cursor;
  const anaphorMatch = ANAPHOR_WORD.exec(input);
  if (anaphorMatch && anaphorMatch.index === cursor) {
    const anaphorType = anaphorMatch[1].toLowerCase();
    const kindStart = skipWhitespace(input, cursor + anaphorMatch[0].length);
    const kindMatch = input.slice(kindStart).match(/^(sections?|subsections?|paragraphs?|subdivisions?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
    if (!kindMatch) return null;
    const baseWord = kindMatch[0];
    const baseKind = canonicalUnitName(baseWord);
    const baseEnd = kindStart + baseWord.length;
    const address = readBaseAddress(input, baseEnd);
    const base = makeBase(input, baseKind, baseWord, kindStart, address, {
      type: anaphorType,
      start: cursor,
      end: baseEnd,
      text: input.slice(cursor, baseEnd)
    });
    base.anaphor = { type: anaphorType, start: cursor, end: baseEnd, text: input.slice(cursor, baseEnd) };
    base.anaphorType = anaphorType;
    base.unitStart = kindStart;
    base.unitEnd = baseEnd;
    return base;
  }

  const baseWordMatch = input.slice(cursor).match(/^(sections?|subsections?|paragraphs?|subdivisions?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
  if (!baseWordMatch) return null;
  const baseWord = baseWordMatch[0];
  const baseKind = canonicalUnitName(baseWord);
  const baseUnitStart = cursor;
  const address = baseKind === "section"
    ? readNumberedSectionAddress(input, cursor + baseWord.length)
    : readBaseAddress(input, cursor + baseWord.length);
  if (!address) return null;
  const base = makeBase(input, baseKind, baseWord, baseUnitStart, address, null);
  base.unitStart = baseUnitStart;
  base.unitEnd = baseUnitStart + baseWord.length;
  base.scope = readSectionScope(input, base.end);
  return base;
}

function parentUnitKind(kind) {
  const hierarchy = ["section", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem"];
  const index = hierarchy.indexOf(canonicalUnitName(kind));
  return index > 0 ? hierarchy[index - 1] : "";
}

/*
 * Read a heterogeneous coordination whose groups share a final container:
 *
 *   paragraphs (1), (2), and clauses (i) and (ii) of paragraph (3)
 *     of such subsection
 *
 * Each intervening group must itself be a complete named-unit reference.
 * This keeps the extension bounded to written legal-reference syntax rather
 * than scanning arbitrary prose for a later "of" phrase.
 */
function readSharedTrailingContainer(input, position, outerUnitKind) {
  let cursor = position;
  const groups = [];
  while (true) {
    const connector = readConnector(input, cursor);
    if (!connector) return null;
    const groupStart = skipWhitespace(input, connector.end);
    const unit = input.slice(groupStart).match(/^(subsections?|paragraphs?|subdivisions?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
    if (!unit) return null;
    const nested = parseAt(input, { 0: unit[0], index: groupStart }, { allowSharedContainer: false });
    if (!nested) return null;
    groups.push({ connector, candidate: nested });
    cursor = nested.end;
    const trailingBase = readContainerAfterOf(input, cursor);
    if (trailingBase) {
      const expectedBaseKind = parentUnitKind(outerUnitKind);
      const nestedBase = groups.at(-1).candidate.base;
      // In “paragraphs (1)… and paragraphs (30)… of subsection (a)
      // of this section”, subsection (a)—not this section—is the outer
      // paragraphs' container. In the INA 212(d)(3) construction, the final
      // “such subsection” is the matching parent. Select from the written
      // container chain by structural unit type rather than proximity.
      const base = nestedBase?.kind === expectedBaseKind ? nestedBase
        : trailingBase.kind === expectedBaseKind ? trailingBase
        : null;
      return base ? { base, trailingBase, groups, end: trailingBase.end } : null;
    }
  }
}

function parseAt(input, unitMatch, options = {}) {
  const unitWord = unitMatch[0];
  const unitKind = canonicalUnitName(unitWord);
  if (!unitKind) return null;
  const listStart = skipWhitespace(input, unitMatch.index + unitWord.length);
  const list = parseUnitList(input, listStart);
  if (!list) return null;
  const directBase = readContainerAfterOf(input, list.end);
  if (directBase) return candidateFromMatch(input, unitMatch, unitWord, list, directBase);
  if (options.allowSharedContainer === false) return null;
  const shared = readSharedTrailingContainer(input, list.end, unitKind);
  if (!shared) return null;
  const candidate = candidateFromMatch(input, unitMatch, unitWord, list, shared.base);
  candidate.end = shared.end;
  candidate.text = input.slice(candidate.start, candidate.end);
  candidate.coordinatedGroups = shared.groups.map(group => ({
    connector: { ...group.connector },
    start: group.candidate.start,
    end: group.candidate.end,
    text: group.candidate.text,
    unitKind: group.candidate.unitKind
  }));
  candidate.trailingContainerSpan = span(input, shared.trailingBase.start, shared.trailingBase.end, { kind: shared.trailingBase.kind });
  candidate.sharedTrailingContainer = true;
  return candidate;
}

/**
 * Return every syntactically complete named-unit candidate in `text`.
 * Candidates are sorted by source offset.  No candidate carries a corpus
 * link, inferred target, or expanded range.
 */
function parseEmbeddedStatutoryReferences(text) {
  const input = String(text || "");
  const candidates = [];
  UNIT_WORD.lastIndex = 0;
  let match;
  while ((match = UNIT_WORD.exec(input))) {
    const candidate = parseAt(input, match);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function parseEmbeddedReferenceAst(text) {
  const input = String(text || "");
  return {
    type: "embedded-statutory-references",
    text: input,
    candidates: parseEmbeddedStatutoryReferences(input)
  };
}

function parseEmbeddedStatutoryReference(text) {
  return parseEmbeddedStatutoryReferences(text)[0] || null;
}

function readNumericSectionAddress(input, position) {
  const start = skipWhitespace(input, position);
  const match = input.slice(start).match(/^((?:\d+[A-Za-z]+-\d+[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?))/);
  if (!match) return null;
  const section = match[1];
  let end = start + section.length;
  const groups = [];
  let cursor = skipWhitespace(input, end);
  while (input[cursor] === "(") {
    const group = readParenthetical(input, cursor);
    if (!group) break;
    groups.push(group);
    end = group.end;
    cursor = skipWhitespace(input, group.end);
  }
  return {
    type: "absolute-section-address",
    start,
    end,
    text: input.slice(start, end),
    section,
    tokens: groups.map(group => group.token),
    tokenSpans: groups.map(group => span(input, group.tokenStart, group.tokenEnd, { token: group.token }))
  };
}

function readRelativeSectionAddress(input, position) {
  const start = skipWhitespace(input, position);
  const compound = readCompoundMember(input, start);
  if (!compound) return null;
  return {
    type: "relative-section-address",
    ...compound.member,
    relative: true
  };
}

function readSectionScope(input, position) {
  const start = skipWhitespace(input, position);
  const value = input.slice(start);
  let match = value.match(/^of\s+(this|that|such)\s+title\b/i);
  if (match) return { start, end: start + match[0].length, text: match[0], type: `${match[1].toLowerCase()}-title`, title: "" };
  match = value.match(/^of\s+title\s+(\d+)\b/i);
  if (match) return { start, end: start + match[0].length, text: match[0], type: "numbered-title", title: match[1] };
  match = value.match(/^of\s+(?:division|div\.)\s+([A-Z0-9-]+)\s+of\s+(?:Public\s+Law|Pub\.\s*L\.)\s*(\d+)[–—-](\d+)\b/i);
  if (match) return {
    start,
    end: start + match[0].length,
    text: match[0],
    type: "public-law",
    congress: match[2],
    law: match[3],
    containers: [`division-${match[1].toUpperCase()}`]
  };
  match = value.match(/^of\s+(?:Public\s+Law|Pub\.\s*L\.)\s+(\d+)[–—-](\d+)\b/i);
  if (match) return {
    start,
    end: start + match[0].length,
    text: match[0],
    type: "public-law",
    congress: match[1],
    law: match[2]
  };
  match = value.match(/^of\s+IMMACT\s*90\b/i);
  if (match) return {
    start,
    end: start + match[0].length,
    text: match[0],
    type: "named-act",
    title: "",
    actName: "Immigration Act of 1990"
  };
  match = value.match(/^of\s+(this|that|such|said)\s+Act\b/i);
  if (match) return {
    start,
    end: start + match[0].length,
    text: match[0],
    type: match[1].toLowerCase() === "said" ? "such-act" : `${match[1].toLowerCase()}-act`,
    title: ""
  };
  // A bare "of the Act" is contextual, not a named-Act citation. Requiring
  // a real name token before "Act" also prevents this expression from
  // consuming prose until it encounters a later occurrence of that word.
  match = value.match(/^of\s+(?:the\s+)?((?!Act\b)[A-Z0-9][A-Za-z0-9’'&.,\-–—]*(?:\s+[A-Za-z0-9][A-Za-z0-9’'&.,\-–—]*){0,24}\s+Act(?:\s+of\s+\d{4}|,\s*\d{4}|\s+for\s+Fiscal\s+Year\s+\d{4}|,\s*Fiscal\s+Years?\s+\d{4}(?:\s+and\s+\d{4})?)?)\b/);
  if (match) return { start, end: start + match[0].length, text: match[0], type: "named-act", title: "", actName: match[1].trim() };
  match = value.match(/^of\s+(?:the\s+)?(Agreement\s+regarding\s+the\s+Headquarters\s+of\s+the\s+United\s+Nations)\b/i);
  if (match) return { start, end: start + match[0].length, text: match[0], type: "named-instrument", title: "", instrumentName: match[1].trim() };
  return null;
}

function parseSectionAddressSequence(input, start, hasUnitWord) {
  let cursor = start;
  const members = [];
  const connectors = [];
  let needsConnector = false;
  if (hasUnitWord) {
    const word = input.slice(cursor).match(/^sections?\b/i);
    if (!word) return null;
    cursor += word[0].length;
  }
  while (cursor < input.length) {
    cursor = skipWhitespace(input, cursor);
    const scope = readSectionScope(input, cursor);
    if (scope) return members.length ? { members, connectors, scope, end: scope.end } : null;
    // House editorial-footnote markers can sit directly between a printed
    // section address and its "of title ..." scope. They are not additional
    // section-list members (for example, "section 4605(j) 2 of title 50").
    if (needsConnector) {
      const editorialMarker = input.slice(cursor).match(/^\d{1,2}(?=\s+of\b)/i);
      if (editorialMarker) {
        const markerEnd = skipWhitespace(input, cursor + editorialMarker[0].length);
        const markedScope = readSectionScope(input, markerEnd);
        if (markedScope) return { members, connectors, scope: markedScope, end: markedScope.end };
      }
      const connector = input.slice(cursor).match(/^(?:,\s*(?:and\b|or\b)?|;|\band\b|\bor\b|\bthrough\b|\bto\b)/i);
      if (!connector) return null;
      connectors.push(span(input, cursor, cursor + connector[0].length, { kind: connector[0].toLowerCase() }));
      cursor += connector[0].length;
      needsConnector = false;
      continue;
    }
    const repeatedWord = input.slice(cursor).match(/^sections?\b/i);
    if (repeatedWord) { cursor += repeatedWord[0].length; continue; }
    const absolute = readNumericSectionAddress(input, cursor);
    const relative = absolute ? null : readRelativeSectionAddress(input, cursor);
    const member = absolute || relative;
    if (member) {
      members.push(member);
      cursor = member.end;
      needsConnector = true;
      continue;
    }
    return null;
  }
  return null;
}

function parseNumberedSectionReferences(text) {
  const input = String(text || "");
  const starts = [];
  for (const match of input.matchAll(/\bsections?\b/gi)) starts.push({ start: match.index, hasUnitWord: true });
  for (const match of input.matchAll(/\b(?:\d+[A-Za-z]+-\d+[A-Za-z]*|\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)?)(?=\s*\([A-Za-z0-9-]+\))/g)) {
    if (/\bsections?\s*$/i.test(input.slice(Math.max(0, match.index - 18), match.index))) continue;
    starts.push({ start: match.index, hasUnitWord: false });
  }
  const candidates = [];
  for (const entry of starts.sort((left, right) => left.start - right.start || Number(right.hasUnitWord) - Number(left.hasUnitWord))) {
    if (candidates.some(candidate => entry.start >= candidate.start && entry.start < candidate.end)) continue;
    const sequence = parseSectionAddressSequence(input, entry.start, entry.hasUnitWord);
    if (!sequence || !sequence.members.some(member => member.tokens?.length)) continue;
    candidates.push({
      type: "numbered-section-list",
      kind: "numbered-section-list",
      ruleId: "embedded-numbered-section-list",
      start: entry.start,
      end: sequence.end,
      text: input.slice(entry.start, sequence.end),
      unitWord: entry.hasUnitWord ? input.slice(entry.start).match(/^sections?\b/i)[0] : "",
      members: sequence.members,
      connectors: sequence.connectors,
      scope: sequence.scope
    });
  }
  return candidates;
}

return {
  UNIT_KINDS,
  canonicalUnitName,
  parseEmbeddedReferenceAst,
  parseEmbeddedReferenceCandidates: parseEmbeddedStatutoryReferences,
  parseEmbeddedReferences: parseEmbeddedStatutoryReferences,
  parseEmbeddedStatutoryReference,
  parseEmbeddedStatutoryReferences,
  parseNumberedSectionReferences,
  parseUnitList
};
});
