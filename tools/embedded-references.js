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
const UNIT_WORD = /\b(subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/gi;
const ANAPHOR_WORD = /\b(this|such|preceding|following)\b/iy;
// Labels in the House/USLM hierarchy are words, numbers, or hyphenated
// combinations thereof.  Keeping this conservative prevents prose in a
// parenthetical from becoming a guessed statutory address.
const LABEL = /[A-Za-z0-9]+(?:[-\u2010\u2011\u2012\u2013\u2014][A-Za-z0-9]+)*/y;
const LIST_CONNECTOR = /(?:,|\b(?:and|or|through|to)\b)/iy;

function canonicalUnitName(value) {
  const singular = String(value || "").toLowerCase().replace(/s$/, "");
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

function makeBase(input, kind, unitWord, unitStart, address, anaphor) {
  const baseStart = anaphor ? anaphor.start : unitStart;
  const baseEnd = anaphor ? anaphor.end : address.end;
  const baseText = input.slice(baseStart, baseEnd);
  return {
    kind,
    name: kind,
    unitName: kind,
    unitText: unitWord,
    plural: isPluralUnit(unitWord),
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

function parseAt(input, unitMatch) {
  const unitWord = unitMatch[0];
  const unitKind = canonicalUnitName(unitWord);
  if (!unitKind) return null;
  const listStart = skipWhitespace(input, unitMatch.index + unitWord.length);
  const list = parseUnitList(input, listStart);
  if (!list) return null;
  let cursor = skipWhitespace(input, list.end);
  if (!/^of\b/i.test(input.slice(cursor))) return null;
  cursor += 2;
  cursor = skipWhitespace(input, cursor);

  // Relative containers intentionally retain only the relation word and
  // kind. No current/source path is accepted here, so syntax parsing cannot
  // guess what “this”, “such”, “preceding”, or “following” denotes.
  ANAPHOR_WORD.lastIndex = 0;
  ANAPHOR_WORD.lastIndex = cursor;
  const anaphorMatch = ANAPHOR_WORD.exec(input);
  if (anaphorMatch && anaphorMatch.index === cursor) {
    const anaphorType = anaphorMatch[1].toLowerCase();
    const kindStart = skipWhitespace(input, cursor + anaphorMatch[0].length);
    const kindMatch = input.slice(kindStart).match(/^(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
    if (!kindMatch) return null;
    const baseWord = kindMatch[0];
    const baseKind = canonicalUnitName(baseWord);
    const baseEnd = kindStart + baseWord.length;
    const base = makeBase(input, baseKind, baseWord, kindStart, null, {
      type: anaphorType,
      start: cursor,
      end: baseEnd,
      text: input.slice(cursor, baseEnd)
    });
    base.anaphor = { type: anaphorType, start: cursor, end: baseEnd, text: input.slice(cursor, baseEnd) };
    base.anaphorType = anaphorType;
    base.unitStart = kindStart;
    base.unitEnd = baseEnd;
    return candidateFromMatch(input, unitMatch, unitWord, list, base);
  }

  const baseWordMatch = input.slice(cursor).match(/^(sections?|subsections?|paragraphs?|subparagraphs?|clauses?|subclauses?|items?|subitems?)\b/i);
  if (!baseWordMatch) return null;
  const baseWord = baseWordMatch[0];
  const baseKind = canonicalUnitName(baseWord);
  const baseUnitStart = cursor;
  const address = readBaseAddress(input, cursor + baseWord.length);
  if (!address) return null;
  const base = makeBase(input, baseKind, baseWord, baseUnitStart, address, null);
  base.unitStart = baseUnitStart;
  base.unitEnd = baseUnitStart + baseWord.length;
  return candidateFromMatch(input, unitMatch, unitWord, list, base);
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

return {
  UNIT_KINDS,
  canonicalUnitName,
  parseEmbeddedReferenceAst,
  parseEmbeddedReferenceCandidates: parseEmbeddedStatutoryReferences,
  parseEmbeddedReferences: parseEmbeddedStatutoryReferences,
  parseEmbeddedStatutoryReference,
  parseEmbeddedStatutoryReferences,
  parseUnitList
};
});
