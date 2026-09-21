/*
 * Pure INASearch command-language helpers.
 *
 * This file intentionally has no DOM or corpus dependency. The application supplies
 * its own citation-prefix classifier when deciding whether untagged input is legal
 * navigation or an ordinary text search.
 */
(function installINASearchCommand(factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.INA_SEARCH_COMMAND = api;
})(function createINASearchCommand() {
  "use strict";

  const STATUTE_COMMON_LEVELS = Object.freeze([
    "deepest", "section", "subsection", "paragraph", "subparagraph",
    "clause", "subclause", "item", "subitem", "subsubitem"
  ]);
  const CFR_COMMON_LEVELS = Object.freeze([
    "deepest", "section", "paragraph-1", "paragraph-2", "paragraph-3",
    "paragraph-4", "paragraph-5", "paragraph-6"
  ]);
  const COMMON_AUTHORITIES = Object.freeze(["statute", "cfr"]);
  const CONTENT_SCOPES = Object.freeze(["ina", "cfr", "notes", "annotations", "highlights", "highlights-exact"]);
  const ARTIFACT_KINDS = Object.freeze(["notes", "highlights"]);

  const issue = (code, message, index = null) => ({ code, message, ...(index === null ? {} : { index }) });
  const normalizedWord = value => String(value || "").trim().toLowerCase();

  function modifierListComma(input, index, tokenStart) {
    if (input[index] !== "," || !input[index + 1] || /[\s,)]/.test(input[index + 1])) return false;
    const token = input.slice(tokenStart, index);
    return /^(?:in|is|has):[^\s()]*$/i.test(token) || /^common:[^,\s()]*$/i.test(token);
  }

  function normalizeAuthority(value) {
    const authority = normalizedWord(value).replace(/[.\s]/g, "");
    if (["ina", "usc", "statute", "statutes", "statutory"].includes(authority)) return "statute";
    if (["cfr", "regulation", "regulations", "regulatory"].includes(authority)) return "cfr";
    return null;
  }

  function normalizeAuthorities(values, fallback = COMMON_AUTHORITIES) {
    const input = Array.isArray(values) ? values : values ? [values] : fallback;
    return [...new Set(input.map(normalizeAuthority).filter(Boolean))];
  }

  function normalizeCommonLevel(value, authority = null) {
    const normalizedAuthority = normalizeAuthority(authority);
    const compact = normalizedWord(value).replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-");
    const joined = compact.replace(/-/g, "");
    if (["deepest", "deepestcitableunit", "smallest", "smallestunit"].includes(joined)) return "deepest";
    if (joined === "section") return "section";
    const cfrParagraph = compact.match(/^p([1-6])$/) || compact.match(/^paragraph(?:-?level)?-?([1-6])$/) || compact.match(/^paragraph-([1-6])$/);
    if (cfrParagraph) return `paragraph-${cfrParagraph[1]}`;
    if (normalizedAuthority === "cfr" && joined === "paragraph") return "paragraph-1";
    const statuteAliases = {
      subsection: "subsection",
      paragraph: "paragraph",
      subparagraph: "subparagraph",
      clause: "clause",
      subclause: "subclause",
      item: "item",
      subitem: "subitem",
      subsubitem: "subsubitem"
    };
    const level = statuteAliases[joined] || null;
    if (!level) return null;
    return normalizedAuthority === "cfr" ? null : level;
  }

  function commonLevelsForAuthority(authority) {
    return normalizeAuthority(authority) === "cfr" ? CFR_COMMON_LEVELS : normalizeAuthority(authority) === "statute" ? STATUTE_COMMON_LEVELS : [];
  }

  function commonDepth(authority, level) {
    const normalizedAuthority = normalizeAuthority(authority);
    const normalizedLevel = normalizeCommonLevel(level, normalizedAuthority);
    const levels = commonLevelsForAuthority(normalizedAuthority);
    if (!normalizedLevel || !levels.includes(normalizedLevel)) return null;
    if (normalizedLevel === "deepest") return Infinity;
    return levels.indexOf(normalizedLevel) - 1;
  }

  function commonLevelAtDepth(authority, depth) {
    const normalizedAuthority = normalizeAuthority(authority);
    const levels = commonLevelsForAuthority(normalizedAuthority);
    if (!levels.length) return { ok: false, level: null, depth: null, clamped: false };
    if (depth === Infinity || normalizedWord(depth) === "deepest") return { ok: true, level: "deepest", depth: Infinity, clamped: false };
    const requestedDepth = Number(depth);
    if (!Number.isFinite(requestedDepth) || requestedDepth < 0) return { ok: false, level: null, depth: null, clamped: false };
    const integralDepth = Math.floor(requestedDepth);
    const maximumDepth = levels.length - 2;
    const selectedDepth = Math.min(maximumDepth, integralDepth);
    return {
      ok: true,
      level: levels[selectedDepth + 1],
      depth: selectedDepth,
      requestedDepth: integralDepth,
      clamped: selectedDepth !== integralDepth
    };
  }

  function mapCommonLevel(level, fromAuthority, toAuthority) {
    const sourceAuthority = normalizeAuthority(fromAuthority);
    const targetAuthority = normalizeAuthority(toAuthority);
    const depth = commonDepth(sourceAuthority, level);
    if (!sourceAuthority || !targetAuthority || depth === null) {
      return { ok: false, level: null, depth: null, clamped: false, fromAuthority: sourceAuthority, toAuthority: targetAuthority };
    }
    const mapped = commonLevelAtDepth(targetAuthority, depth);
    return { ...mapped, fromAuthority: sourceAuthority, toAuthority: targetAuthority };
  }

  function scanCommandSegments(value) {
    const input = String(value || "");
    const boundaries = [];
    const scopeSpans = extractQueryScopes(input).spans;
    const errors = [];
    let start = 0;
    let depth = 0;
    let quoteStart = -1;
    let escaped = false;
    let hasTopLevelComma = false;

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (quoteStart >= 0) {
        if (character === '"') quoteStart = -1;
        continue;
      }
      if (character === '"') { quoteStart = index; continue; }
      if (character === "(") { depth += 1; continue; }
      if (character === ")") {
        if (!depth) errors.push(issue("unmatched-close-parenthesis", "A closing parenthesis has no matching opening parenthesis.", index));
        else depth -= 1;
        continue;
      }
      const tokenStart = Math.max(input.lastIndexOf(" ", index - 1), input.lastIndexOf("\t", index - 1), input.lastIndexOf("\n", index - 1), input.lastIndexOf("(", index - 1), input.lastIndexOf(")", index - 1)) + 1;
      const modifierComma = depth === 0 && (modifierListComma(input, index, tokenStart) || scopeSpans.some(span => index >= span.start && index < span.end));
      if (character === "," && depth === 0 && !modifierComma) {
        hasTopLevelComma = true;
        boundaries.push([start, index]);
        start = index + 1;
      }
    }
    boundaries.push([start, input.length]);

    const segments = boundaries.map(([rawStart, rawEnd], index) => {
      const raw = input.slice(rawStart, rawEnd);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const startIndex = rawStart + leading;
      const endIndex = Math.max(startIndex, rawEnd - trailing);
      return { index, raw, text: input.slice(startIndex, endIndex), start: startIndex, end: endIndex };
    });
    const incomplete = [];
    if (escaped) incomplete.push(issue("dangling-escape", "The final escape character needs a character after it.", Math.max(0, input.length - 1)));
    if (quoteStart >= 0) incomplete.push(issue("open-quote", "The quoted phrase is not finished.", quoteStart));
    if (depth > 0) incomplete.push(issue("open-parenthesis", "The parenthesized alternatives are not finished."));
    if (hasTopLevelComma && segments.some(segment => !segment.text)) incomplete.push(issue("empty-command", "Finish the command on each side of the comma."));
    const status = errors.length ? "invalid" : incomplete.length ? "incomplete" : "valid";
    return { input, status, ok: status === "valid", segments, hasTopLevelComma, errors: [...errors, ...incomplete] };
  }

  function splitTopLevelCommands(value, options = {}) {
    const scanned = scanCommandSegments(value);
    if (options.allowMultiple === false && scanned.hasTopLevelComma) {
      return {
        ...scanned,
        status: "invalid",
        ok: false,
        errors: [issue("child-multiple-commands", "A pane search cannot create another pane. Use the main search bar to enter comma-separated views.")]
      };
    }
    return scanned;
  }

  function lexCommand(value) {
    const input = String(value || "");
    const tokens = [];
    const errors = [];
    let word = "";
    let wordStart = -1;
    let wordEscaped = false;
    let quote = "";
    let quoteStart = -1;
    let quoteEscaped = false;
    let depth = 0;
    let hadQuote = false;

    const flushWord = end => {
      if (wordStart < 0) return;
      tokens.push({ type: "atom", kind: "word", value: word, raw: input.slice(wordStart, end), start: wordStart, end, escaped: wordEscaped });
      word = "";
      wordStart = -1;
      wordEscaped = false;
    };

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (quoteStart >= 0) {
        if (character === "\\") {
          if (index + 1 >= input.length) {
            quoteEscaped = true;
            errors.push(issue("dangling-escape", "The quoted phrase ends with an unfinished escape.", index));
            continue;
          }
          quoteEscaped = true;
          quote += input[index + 1];
          index += 1;
          continue;
        }
        if (character === '"') {
          tokens.push({ type: "atom", kind: "phrase", value: quote, raw: input.slice(quoteStart, index + 1), start: quoteStart, end: index + 1, escaped: quoteEscaped });
          quote = "";
          quoteStart = -1;
          quoteEscaped = false;
          continue;
        }
        quote += character;
        continue;
      }

      if (/\s/.test(character)) { flushWord(index); continue; }
      if (character === "\\") {
        if (wordStart < 0) wordStart = index;
        wordEscaped = true;
        if (index + 1 >= input.length) {
          errors.push(issue("dangling-escape", "The final escape character needs a character after it.", index));
          continue;
        }
        word += input[index + 1];
        index += 1;
        continue;
      }
      if (character === '"') {
        flushWord(index);
        hadQuote = true;
        quoteStart = index;
        continue;
      }
      if (character === "(") {
        flushWord(index);
        tokens.push({ type: "open", raw: character, start: index, end: index + 1 });
        depth += 1;
        continue;
      }
      if (character === ")") {
        flushWord(index);
        tokens.push({ type: "close", raw: character, start: index, end: index + 1 });
        depth = Math.max(0, depth - 1);
        continue;
      }
      const commaTokenStart = wordStart < 0 ? index : wordStart;
      if (character === "," && depth === 0 && modifierListComma(input, index, commaTokenStart)) {
        word += character;
        continue;
      }
      if (character === "," && depth === 0) {
        flushWord(index);
        tokens.push({ type: "comma", raw: character, start: index, end: index + 1 });
        continue;
      }
      if (wordStart < 0) wordStart = index;
      word += character;
    }
    flushWord(input.length);
    if (quoteStart >= 0) errors.push(issue("open-quote", "The quoted phrase is not finished.", quoteStart));
    const status = errors.length ? "incomplete" : "valid";
    return { input, status, ok: status === "valid", tokens, hadQuote, errors };
  }

  function parseModifierList(value, prefix, allowed) {
    const match = String(value || "").match(new RegExp(`^${prefix}:(.*)$`, "i"));
    if (!match) return null;
    const rawValues = match[1].split(",");
    if (!match[1] || rawValues.some(item => !item.trim())) return { error: issue(`missing-${prefix}-value`, `Choose a value after ${prefix}:`) };
    const values = [];
    for (const rawValue of rawValues) {
      const normalized = normalizedWord(rawValue).replace(/[.\s]/g, "");
      const value = prefix === "in" && ["usc", "statute", "statutes", "statutory"].includes(normalized) ? "ina" : normalized;
      if (!allowed.includes(value)) return { error: issue(`invalid-${prefix}-modifier`, `“${rawValue}” is not a valid ${prefix}: value.`) };
      if (!values.includes(value)) values.push(value);
    }
    return { values, rawValues };
  }

  function parseInModifier(value) {
    const parsed = parseModifierList(value, "in", CONTENT_SCOPES);
    if (!parsed || parsed.error) return parsed;
    const authorities = [...new Set(parsed.values.filter(item => ["ina", "cfr"].includes(item)).map(item => item === "ina" ? "statute" : "cfr"))];
    const authority = authorities.length === 1 && parsed.values.every(item => ["ina", "cfr"].includes(item)) ? authorities[0] : null;
    const rawLegalValues = parsed.rawValues.map(item => normalizedWord(item).replace(/[.\s]/g, "")).filter(item => ["ina", "usc", "statute", "statutes", "statutory", "cfr", "regulation", "regulations", "regulatory"].includes(item));
    const citationSystem = authorities.length === 1
      ? authorities[0] === "cfr" ? "cfr" : rawLegalValues.some(item => item === "usc") ? "usc" : "ina"
      : null;
    return {
      ...parsed,
      contentScopes: parsed.values,
      authorities,
      authority,
      citationSystem,
      rawValue: parsed.rawValues.join(",")
    };
  }

  function parseIsModifier(value) {
    return parseModifierList(value, "is", ARTIFACT_KINDS);
  }

  function parseHasModifier(value) {
    return parseModifierList(value, "has", ARTIFACT_KINDS);
  }

  function parseCommonModifier(value) {
    const match = String(value || "").match(/^common:(.*)$/i);
    if (!match) return null;
    const body = match[1];
    if (!body) return { error: issue("missing-common-level", "Choose a Common level after common:.") };
    if (body.includes(",")) {
      if (body.includes("=") || body.split(",").length !== 2) return { error: issue("invalid-common-pair", "Use common:STATUTE-LEVEL,CFR-LEVEL to set the two authorities separately.") };
      const [statuteLevel, cfrLevel] = body.split(",");
      if (!statuteLevel || !cfrLevel) return { error: issue("missing-common-level", "Choose both a statutory level and a CFR P-number after common:.") };
      return { authority: null, pairLevels: { statute: statuteLevel, cfr: cfrLevel }, raw: value };
    }
    const equals = body.indexOf("=");
    if (equals !== body.lastIndexOf("=")) return { error: issue("invalid-common-modifier", "A Common modifier may contain only one equals sign.") };
    if (equals < 0) return { authority: null, rawLevel: body, raw: value };
    const qualifier = body.slice(0, equals);
    const authority = normalizeAuthority(qualifier);
    if (!authority) return { error: issue("invalid-common-authority", `Unknown Common authority “${qualifier}”.`) };
    const rawLevel = body.slice(equals + 1);
    if (!rawLevel) return { error: issue("missing-common-level", "Choose a Common level after the equals sign.") };
    return { authority, rawLevel, raw: value, qualifier };
  }

  function resolveCommonModifiers(entries, authorities = COMMON_AUTHORITIES) {
    const activeAuthorities = normalizeAuthorities(authorities);
    const levels = Object.fromEntries(activeAuthorities.map(authority => [authority, "deepest"]));
    const assigned = new Set();
    const errors = [];
    const adjustments = [];
    let unqualified = null;

    const assignLevel = (authority, rawLevel) => {
      if (!activeAuthorities.includes(authority)) {
        errors.push(issue("common-authority-out-of-scope", `The ${authority === "statute" ? "INA/U.S.C." : "CFR"} Common level is outside this search scope.`));
        return false;
      }
      if (assigned.has(authority)) {
        errors.push(issue("duplicate-common-authority", `The ${authority === "statute" ? "INA/U.S.C." : "CFR"} Common level is specified more than once.`));
        return false;
      }
      const level = normalizeCommonLevel(rawLevel, authority);
      if (!level || !commonLevelsForAuthority(authority).includes(level)) {
        errors.push(issue("invalid-common-level", `“${rawLevel}” is not a valid ${authority === "statute" ? "statutory" : "CFR"} Common level.`));
        return false;
      }
      levels[authority] = level;
      assigned.add(authority);
      return true;
    };

    for (const entry of entries || []) {
      if (entry?.error) { errors.push(entry.error); continue; }
      if (entry?.pairLevels) {
        if (activeAuthorities.length !== 2) {
          errors.push(issue("common-pair-out-of-scope", "A comma-separated Common pair is available only when both statutes and CFR are searched."));
          continue;
        }
        assignLevel("statute", entry.pairLevels.statute);
        assignLevel("cfr", entry.pairLevels.cfr);
        continue;
      }
      if (!entry?.authority) {
        if (unqualified) errors.push(issue("duplicate-common-level", "Only one unqualified Common modifier may be used."));
        else unqualified = entry;
        continue;
      }
      assignLevel(entry.authority, entry.rawLevel);
    }

    if (unqualified) {
      const rawLevel = unqualified.rawLevel;
      const direct = activeAuthorities.length === 1
        ? { authority: activeAuthorities[0], level: normalizeCommonLevel(rawLevel, activeAuthorities[0]) }
        : /^p(?:aragraph(?:-?level)?-?)?[1-6]$/i.test(String(rawLevel).replace(/[\s_]+/g, "-"))
          ? { authority: "cfr", level: normalizeCommonLevel(rawLevel, "cfr") }
          : { authority: "statute", level: normalizeCommonLevel(rawLevel, "statute") };
      if (!direct.level || !commonLevelsForAuthority(direct.authority).includes(direct.level)) {
        errors.push(issue("invalid-common-level", `“${unqualified.rawLevel}” is not valid for this search scope.`));
      } else {
        if (assignLevel(direct.authority, rawLevel)) {
          const otherAuthority = direct.authority === "statute" ? "cfr" : "statute";
          if (activeAuthorities.includes(otherAuthority) && !assigned.has(otherAuthority)) {
            const mapped = mapCommonLevel(direct.level, direct.authority, otherAuthority);
            if (mapped.ok) {
              levels[otherAuthority] = mapped.level;
              assigned.add(otherAuthority);
              if (mapped.clamped) adjustments.push(mapped);
            }
          }
        }
      }
    }

    return {
      ok: !errors.length,
      status: errors.length ? "invalid" : "valid",
      present: Boolean((entries || []).length),
      authorities: activeAuthorities,
      levels,
      explicitlyAssigned: [...assigned],
      adjustments,
      errors
    };
  }

  function canonicalizeCommon(levels = {}, options = {}) {
    const inferredAuthorities = Object.keys(levels || {}).filter(authority => normalizeAuthority(authority));
    const authorities = normalizeAuthorities(options.authorities, inferredAuthorities.length ? inferredAuthorities : COMMON_AUTHORITIES);
    const normalized = Object.fromEntries(authorities.map(authority => {
      const level = normalizeCommonLevel(levels[authority] ?? "deepest", authority);
      return [authority, level && commonLevelsForAuthority(authority).includes(level) ? level : "deepest"];
    }));
    const includeDeepest = options.includeDeepest === true;
    const cfrSyntax = level => /^paragraph-([1-6])$/.test(level) ? `P${level.match(/[1-6]/)[0]}` : level;
    if (authorities.length === 1) {
      const level = normalized[authorities[0]];
      return level === "deepest" && !includeDeepest ? "" : `common:${authorities[0] === "cfr" ? cfrSyntax(level) : level}`;
    }
    if (authorities.length === 2) {
      if (!includeDeepest && authorities.every(authority => normalized[authority] === "deepest")) return "";
      const statuteLevel = normalized.statute || "deepest";
      const cfrLevel = normalized.cfr || "deepest";
      const analogous = mapCommonLevel(statuteLevel, "statute", "cfr");
      return analogous.ok && analogous.level === cfrLevel
        ? `common:${statuteLevel}`
        : `common:${statuteLevel},${cfrSyntax(cfrLevel)}`;
    }
    return "";
  }

  function initializeCommonLevels(currentLevels = {}, nextAuthorities = COMMON_AUTHORITIES, options = {}) {
    const authorities = normalizeAuthorities(nextAuthorities);
    const levels = {};
    const adjustments = [];
    for (const authority of authorities) {
      const level = normalizeCommonLevel(currentLevels[authority], authority);
      if (level && commonLevelsForAuthority(authority).includes(level)) levels[authority] = level;
    }
    const preferredSource = normalizeAuthority(options.sourceAuthority);
    for (const authority of authorities) {
      if (levels[authority]) continue;
      const candidates = [preferredSource, ...authorities].filter(candidate => candidate && candidate !== authority && levels[candidate]);
      const sourceAuthority = candidates[0] || null;
      const mapped = sourceAuthority ? mapCommonLevel(levels[sourceAuthority], sourceAuthority, authority) : null;
      levels[authority] = mapped?.ok ? mapped.level : "deepest";
      if (mapped?.clamped) adjustments.push(mapped);
    }
    return { ok: true, levels, authorities, adjustments };
  }

  function applyCommonSelection(currentLevels, authority, level, options = {}) {
    const selectedAuthority = normalizeAuthority(authority);
    const authorities = normalizeAuthorities(options.authorities);
    const initialized = initializeCommonLevels(currentLevels, authorities, { sourceAuthority: selectedAuthority });
    const selectedLevel = normalizeCommonLevel(level, selectedAuthority);
    if (!selectedAuthority || !authorities.includes(selectedAuthority) || !selectedLevel || !commonLevelsForAuthority(selectedAuthority).includes(selectedLevel)) {
      return { ok: false, levels: initialized.levels, authorities, synchronized: false, adjustments: [], errors: [issue("invalid-common-selection", "The selected Common level is not available in this search scope.")] };
    }
    const levels = { ...initialized.levels, [selectedAuthority]: selectedLevel };
    const adjustments = [...initialized.adjustments];
    let synchronized = false;
    const syncAcrossAuthorities = options.syncAcrossAuthorities ?? options.syncCfrFromStatute !== false;
    const otherAuthority = selectedAuthority === "statute" ? "cfr" : "statute";
    if (authorities.includes(otherAuthority) && syncAcrossAuthorities) {
      const mapped = mapCommonLevel(selectedLevel, selectedAuthority, otherAuthority);
      if (mapped.ok) {
        levels[otherAuthority] = mapped.level;
        synchronized = true;
        if (mapped.clamped) adjustments.push(mapped);
      }
    }
    return { ok: true, levels, authorities, synchronized, adjustments, errors: [] };
  }

  function modifierTokenValue(tokens, index, prefix) {
    const token = tokens[index];
    if (token?.type !== "atom" || token.kind !== "word" || token.escaped) return null;
    if (normalizedWord(token.value) !== `${prefix}:`) return token.value;
    const next = tokens[index + 1];
    if (next?.type !== "atom" || next.kind !== "word" || next.escaped) return token.value;
    return `${token.value}${next.value}`;
  }

  function parseTextCommand(value, options = {}) {
    const input = String(value || "");
    const split = scanCommandSegments(input);
    if (split.hasTopLevelComma) return { type: "search", input, status: "invalid", ok: false, errors: [issue("multiple-commands", "Use the workspace parser for comma-separated commands.")] };
    if (split.status !== "valid") return { type: "search", input, status: split.status, ok: false, errors: split.errors };
    const lexed = lexCommand(input);
    if (lexed.status !== "valid") return { type: "search", input, status: lexed.status, ok: false, errors: lexed.errors, forcedSearch: lexed.hadQuote };

    const filtered = [];
    const commonEntries = [];
    const has = [];
    const errors = [];
    let scope = null;
    let listing = null;
    let depth = 0;
    for (let index = 0; index < lexed.tokens.length; index += 1) {
      const token = lexed.tokens[index];
      if (token.type === "open") { depth += 1; filtered.push(token); continue; }
      if (token.type === "close") { depth = Math.max(0, depth - 1); filtered.push(token); continue; }
      if (token.type !== "atom" || token.kind !== "word" || token.escaped) { filtered.push(token); continue; }
      const lower = normalizedWord(token.value);
      const combinedIn = modifierTokenValue(lexed.tokens, index, "in");
      const inModifier = parseInModifier(combinedIn);
      const looksLikeInModifier = lower.startsWith("in:");
      const combinedCommon = modifierTokenValue(lexed.tokens, index, "common");
      const commonModifier = parseCommonModifier(combinedCommon);
      const looksLikeCommonModifier = lower.startsWith("common:");
      const combinedIs = modifierTokenValue(lexed.tokens, index, "is");
      const isModifier = parseIsModifier(combinedIs);
      const looksLikeIsModifier = lower.startsWith("is:");
      const combinedHas = modifierTokenValue(lexed.tokens, index, "has");
      const hasModifier = parseHasModifier(combinedHas);
      const looksLikeHasModifier = lower.startsWith("has:");
      const recognizedModifier = inModifier || commonModifier || isModifier || hasModifier;
      const looksLikeModifier = looksLikeInModifier || looksLikeCommonModifier || looksLikeIsModifier || looksLikeHasModifier;
      if (!recognizedModifier && !looksLikeModifier) { filtered.push(token); continue; }
      if (depth > 0) {
        errors.push(issue("modifier-inside-group", "Search modifiers cannot appear inside a parenthesized alternative group.", token.start));
        continue;
      }
      if (inModifier && !inModifier.error) {
        if (scope) errors.push(issue("duplicate-in-modifier", "Only one in: authority scope may be used.", token.start));
        else scope = inModifier;
        if (normalizedWord(token.value) === "in:") index += 1;
        continue;
      }
      if (looksLikeInModifier) {
        errors.push(inModifier?.error || issue("invalid-in-modifier", "Use in:INA, in:CFR, in:notes, or in:highlights.", token.start));
        continue;
      }
      if (commonModifier) {
        commonEntries.push(commonModifier);
        if (normalizedWord(token.value) === "common:") index += 1;
        continue;
      }
      if (looksLikeCommonModifier) {
        errors.push(commonModifier?.error || issue("invalid-common-modifier", "The Common modifier is not valid.", token.start));
        continue;
      }
      if (isModifier && !isModifier.error) {
        if (listing) errors.push(issue("duplicate-is-modifier", "Only one is: listing modifier may be used.", token.start));
        else listing = { kinds: isModifier.values, rawValues: isModifier.rawValues };
        if (normalizedWord(token.value) === "is:") index += 1;
        continue;
      }
      if (looksLikeIsModifier) {
        errors.push(isModifier?.error || issue("invalid-is-modifier", "Use is:notes, is:highlights, or is:notes,highlights.", token.start));
        continue;
      }
      if (hasModifier && !hasModifier.error) {
        has.push({ kinds: hasModifier.values, rawValues: hasModifier.rawValues });
        if (normalizedWord(token.value) === "has:") index += 1;
        continue;
      }
      errors.push(hasModifier?.error || issue("invalid-has-modifier", "Use has:notes, has:highlights, or has:notes,highlights.", token.start));
    }

    const authorities = normalizeAuthorities(options.authorities, scope?.authorities?.length ? scope.authorities : COMMON_AUTHORITIES);
    const activeAuthorities = scope ? scope.authorities : authorities;
    const common = resolveCommonModifiers(commonEntries, activeAuthorities);
    errors.push(...common.errors);

    const atoms = token => token.type === "atom";
    const atomValue = token => ({ type: "atom", kind: token.kind, value: token.value, raw: token.raw });
    const isOperator = (token, operator) => atoms(token) && token.kind === "word" && !token.escaped && normalizedWord(token.value) === operator;
    const items = [];
    let nestedDepth = 0;
    for (let index = 0; index < filtered.length; index += 1) {
      const token = filtered[index];
      if (token.type === "comma") { errors.push(issue("multiple-commands", "Use the workspace parser for comma-separated commands.", token.start)); continue; }
      if (token.type === "close") { errors.push(issue("unmatched-close-parenthesis", "A closing parenthesis has no matching opening parenthesis.", token.start)); continue; }
      if (token.type === "open") {
        nestedDepth += 1;
        const alternatives = [];
        let previousWasOr = false;
        let closed = false;
        for (index += 1; index < filtered.length; index += 1) {
          const inner = filtered[index];
          if (inner.type === "open") {
            errors.push(issue("nested-group", "Nested parenthesized groups are not supported.", inner.start));
            nestedDepth += 1;
            continue;
          }
          if (inner.type === "close") {
            nestedDepth -= 1;
            if (!nestedDepth) { closed = true; break; }
            continue;
          }
          if (isOperator(inner, "not")) { errors.push(issue("not-unsupported", "NOT is not supported. Use positive terms and flat OR alternatives.", inner.start)); continue; }
          if (isOperator(inner, "or")) {
            if (!alternatives.length || previousWasOr) errors.push(issue("misplaced-or", "OR must appear between two alternatives.", inner.start));
            previousWasOr = true;
            continue;
          }
          if (!atoms(inner)) continue;
          if (!inner.value) errors.push(issue("empty-term", "An empty quoted phrase cannot be searched.", inner.start));
          else alternatives.push(atomValue(inner));
          previousWasOr = false;
        }
        if (!closed) errors.push(issue("open-parenthesis", "The parenthesized alternatives are not finished.", token.start));
        if (previousWasOr) errors.push(issue("misplaced-or", "OR must be followed by another alternative."));
        if (!alternatives.length) errors.push(issue("empty-group", "A parenthesized alternative group cannot be empty.", token.start));
        else items.push({ type: "item", grouped: true, alternatives });
        continue;
      }
      if (isOperator(token, "not")) { errors.push(issue("not-unsupported", "NOT is not supported. Use positive terms and flat OR alternatives.", token.start)); continue; }
      if (isOperator(token, "or")) { items.push({ type: "or", token }); continue; }
      if (atoms(token)) {
        if (!token.value) errors.push(issue("empty-term", "An empty quoted phrase cannot be searched.", token.start));
        else items.push({ type: "item", grouped: false, alternatives: [atomValue(token)] });
      }
    }

    const clauses = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.type === "or") { errors.push(issue("misplaced-or", "OR must appear between two search terms.", item.token.start)); continue; }
      const alternatives = [...item.alternatives];
      let grouped = item.grouped;
      while (items[index + 1]?.type === "or") {
        if (items[index + 2]?.type !== "item") {
          errors.push(issue("misplaced-or", "OR must be followed by another search term.", items[index + 1].token.start));
          index += 1;
          break;
        }
        alternatives.push(...items[index + 2].alternatives);
        grouped = true;
        index += 2;
      }
      clauses.push({ type: "clause", operator: alternatives.length > 1 || grouped ? "OR" : "ATOM", alternatives });
    }

    if (listing && (scope || has.length || commonEntries.length || clauses.length)) {
      errors.push(issue("is-exclusive", "is: only lists notes or highlights. Use in:notes or in:highlights to search their text."));
    }
    if (has.length && scope?.contentScopes?.some(item => ARTIFACT_KINDS.includes(item))) {
      errors.push(issue("has-artifact-scope", "has: returns legal-text rows, so its in: scope may contain only INA or CFR."));
    }
    if (commonEntries.length && !activeAuthorities.length) {
      errors.push(issue("common-without-legal-scope", "common: is available only when INA or CFR is in scope."));
    }

    const status = errors.length ? "invalid" : "valid";
    return {
      type: "search",
      input,
      status,
      ok: status === "valid",
      forcedSearch: lexed.hadQuote,
      scope,
      listing,
      has,
      common,
      clauses,
      errors
    };
  }


  const QUERY_VERSION = 2;
  const PERSONAL_SCOPES = new Set(["notes", "annotations", "highlights", "highlights-exact"]);

  // Read citation syntax before the text lexer interprets its parentheses as OR groups.
  // Corpus validation is deliberately separate: incomplete/unknown citations never become words.
  function readScopeValue(input, start) {
    const tail = input.slice(start);
    const quoted = tail.match(/^"((?:\\.|[^"\\])*)"/);
    if (quoted) return { value: quoted[1].replace(/\\(.)/g, "$1"), end: start + quoted[0].length };
    const content = tail.match(/^(notes|annotations|highlights-exact|highlights)(?=$|[\s,])/i);
    if (content) return { value: content[1].toLowerCase(), end: start + content[0].length };
    const authority = tail.match(/^(?:(?:\d+\s*)?c\.?\s*f\.?\s*r\.?|(?:8\s*)?u\.?\s*s\.?\s*c\.?|i\.?\s*n\.?\s*a\.?|statutes?)(?=\s|\d|§|$|,)/i);
    let end = authority ? authority[0].length : 0;
    const rest = tail.slice(end);
    const locator = rest.match(/^\s*(?:§+\s*)?(?:(?:part|title|chapter|subchapter|subpart)\s+)?(?:\d+[a-z0-9]*(?:\.\d+[a-z0-9-]*)?|[IVX]+)(?![a-z0-9:])(?:\s*\([a-z0-9]+\))*(?:\s*[-–—]\s*(?:(?:\d+\s*)?(?:INA|CFR|U\.?S\.?C\.?)\s*)?(?:\d+[a-z0-9]*(?:\.\d+[a-z0-9-]*)?)?(?:\s*\([a-z0-9]+\))*)?/i);
    if (locator) end += locator[0].length;
    if (!end) {
      const word = tail.match(/^[^\s,]+/);
      return { value: word?.[0] || "", end: start + (word?.[0].length || 0) };
    }
    // Include unfinished path tokens so typing cannot launch an accidentally broader search.
    const unfinished = tail.slice(end).match(/^\s*\([^)]*$/);
    if (unfinished) end += unfinished[0].length;
    return { value: tail.slice(0, end).trim(), end: start + end };
  }

  function extractQueryScopes(value) {
    const input = String(value || ""), groups = [], cites = [], errors = [], spans = [];
    let text = "", cursor = 0, depth = 0;
    while (cursor < input.length) {
      const ch = input[cursor];
      if (ch === "\\") { text += input.slice(cursor, cursor + 2); cursor += 2; continue; }
      if (ch === '"') {
        let end = cursor + 1;
        while (end < input.length) { if (input[end] === "\\") end += 2; else if (input[end++] === '"') break; }
        text += input.slice(cursor, end); cursor = end; continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      const tag = (cursor === 0 || /\s|\(/.test(input[cursor - 1])) && input.slice(cursor).match(/^(in|cites|is):\s*/i);
      if (!tag) { text += ch; cursor++; continue; }
      const start = cursor, name = tag[1].toLowerCase();
      if (depth) errors.push(issue("modifier-inside-group", "Put scope tags outside text alternative groups.", start));
      if (name === "is") errors.push(issue("retired-is-modifier", "Use in:notes or in:highlights-exact instead of is:.", start));
      cursor += tag[0].length;
      const values = [];
      while (true) {
        const read = readScopeValue(input, cursor);
        if (!read.value) { errors.push(issue("missing-scope-value", `Enter a value after ${name}:`, cursor)); break; }
        values.push(read.value); cursor = read.end;
        if (input[cursor] !== "," || /\s/.test(input[cursor + 1] || "")) break;
        cursor++;
      }
      if (name === "cites") cites.push(values);
      else if (name === "in") groups.push(values);
      spans.push({ start, end: cursor, name, values });
      text += " ";
    }
    return { text: text.trim(), groups, cites, errors, spans };
  }

  function scopeBranches(groups) {
    let combinations = [[]];
    for (const group of groups) {
      combinations = combinations.flatMap(previous => group.map(value => [...previous, value]));
      if (combinations.length > 128) throw new SyntaxError("Use at most 128 scope alternatives.");
    }
    return combinations.map(values => {
      const contents = [...new Set(values.filter(value => PERSONAL_SCOPES.has(value.toLowerCase())).map(value => value.toLowerCase()))];
      const locations = values.filter(value => !PERSONAL_SCOPES.has(value.toLowerCase()));
      const modes = contents.filter(value => value.startsWith("highlights"));
      const kinds = contents.filter(value => !value.startsWith("highlights"));
      if (kinds.length > 1 || (kinds.length && modes.length)) throw new SyntaxError("These content scopes do not intersect. Use a comma list for alternatives.");
      return { kind: kinds[0] || "law", locations, highlightMode: modes.includes("highlights-exact") ? "exact" : modes.length ? "presence" : null };
    });
  }

  function parseCommand(value, options = {}) {
    const input = String(value || ""), extracted = extractQueryScopes(input);
    let branches = [];
    try { branches = scopeBranches(extracted.groups); }
    catch (error) { extracted.errors.push(issue("incompatible-scopes", error.message)); }
    const hasExplicitScope = extracted.groups.length > 0;
    if (!hasExplicitScope) branches = [{ kind: "law", locations: [], highlightMode: null }, { kind: "notes", locations: [], highlightMode: null }];
    const inferAuthority = location => /c\.?\s*f\.?\s*r/i.test(location) || /^\d+\./.test(location) ? "cfr" : "statute";
    const legalBranches = branches.filter(branch => branch.kind !== "notes");
    const authorities = [...new Set(legalBranches.flatMap(branch => branch.locations.length ? branch.locations.map(inferAuthority) : normalizeAuthorities(options.authorities)))];
    const ast = parseTextCommand(extracted.text, { ...options, authorities: authorities.length ? authorities : COMMON_AUTHORITIES });
    const errors = [...extracted.errors, ...(ast.errors || [])];
    if (ast.has?.length) {
      if (hasExplicitScope && branches.some(branch => branch.kind !== "law")) errors.push(issue("has-artifact-scope", "has: filters legal text. Use a legal scope with has:."));
      branches = branches.filter(branch => branch.kind === "law");
    }
    if (!legalBranches.length && ast.common?.present) errors.push(issue("common-without-legal-scope", "common: applies to legal text only."));
    for (const group of [...extracted.groups, ...extracted.cites]) for (const item of group) {
      if (PERSONAL_SCOPES.has(item.toLowerCase())) continue;
      if (!/^(?:\d|§|INA|USC|U\.|CFR|C\.|statute)/i.test(item)) errors.push(issue("invalid-in-modifier", `“${item}” is not a legal citation or supported scope.`));
    }
    const simpleScope = extracted.groups.length === 1 ? parseInModifier(`in:${extracted.groups[0].join(",")}`) : null;
    const contentScopes = [...new Set(branches.flatMap(branch => branch.kind === "law" ? (branch.locations.length ? branch.locations.map(inferAuthority).map(a => a === "statute" ? "ina" : "cfr") : ["ina", "cfr"]) : [branch.kind]))];
    const scope = hasExplicitScope ? simpleScope && !simpleScope.error ? simpleScope : { contentScopes, authorities, authority: authorities.length === 1 ? authorities[0] : null } : null;
    const incomplete = ast.status === "incomplete" || errors.some(error => error.code === "missing-scope-value") || [...extracted.groups, ...extracted.cites].flat().some(v => (v.match(/\(/g) || []).length !== (v.match(/\)/g) || []).length);
    return { ...ast, input, queryVersion: QUERY_VERSION, scope, scopeGroups: extracted.groups, citationGroups: extracted.cites, branches, scopeSpans: extracted.spans,
      status: incomplete ? "incomplete" : errors.length ? "invalid" : "valid", ok: !incomplete && !errors.length, errors };
  }

  function migrateQuery(value, version = 1) {
    if (Number(version) >= QUERY_VERSION) return String(value || "");
    const replacements = extractQueryScopes(value).spans.filter(span => span.name === "is" || (span.name === "in" && span.values.some(v => /^highlights$/i.test(v)))).map(span => ({
      start: span.start, end: span.end,
      value: `in:${span.values.map(v => /^highlights$/i.test(v) ? "highlights-exact" : v).join(",")}`
    }));
    let result = String(value || "");
    for (const item of replacements.reverse()) result = result.slice(0, item.start) + item.value + result.slice(item.end);
    return result;
  }
  function escapePhrase(value) {
    return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function serializeAtom(atom) {
    if (atom?.kind === "phrase") return escapePhrase(atom.value);
    const value = String(atom?.value || "");
    if (/^(?:or|not)$/i.test(value) || /^(?:in|is|cites|has|common):/i.test(value)) return `\\${value}`;
    return value.replace(/([\\\s(),"])/g, "\\$1");
  }

  function serializeCommand(ast, options = {}) {
    if (!ast || ast.type !== "search" || ast.status !== "valid") return "";
    const parts = [];
    if (ast.queryVersion === QUERY_VERSION) {
      for (const group of ast.scopeGroups || []) parts.push(`in:${group.join(",")}`);
      for (const group of ast.citationGroups || []) parts.push(`cites:${group.join(",")}`);
    }
    if (!ast.queryVersion && ast.scope?.contentScopes?.length) parts.push(`in:${ast.scope.contentScopes.map(value => value === "ina" ? "INA" : value === "cfr" ? "CFR" : value).join(",")}`);
    else if (!ast.queryVersion && ast.scope?.authority === "statute") parts.push("in:INA");
    else if (!ast.queryVersion && ast.scope?.authority === "cfr") parts.push("in:CFR");
    const commonText = canonicalizeCommon(ast.common?.levels, {
      authorities: ast.common?.authorities || (ast.scope ? [ast.scope.authority] : options.authorities),
      includeDeepest: options.includeDeepestCommon === true
    });
    if (commonText) parts.push(commonText);
    for (const clause of ast.has || []) if (clause.kinds?.length) parts.push(`has:${clause.kinds.join(",")}`);
    for (const clause of ast.clauses || []) {
      const alternatives = (clause.alternatives || []).map(serializeAtom);
      if (!alternatives.length) continue;
      parts.push(alternatives.length > 1 || clause.operator === "OR" ? `(${alternatives.join(" ")})` : alternatives[0]);
    }
    return parts.join(" ");
  }

  function canonicalizeCommand(value, options = {}) {
    const parsed = parseCommand(value, options);
    return { ...parsed, canonical: parsed.ok ? serializeCommand(parsed, options) : "" };
  }

  function classifyCitationResult(value) {
    if (value === true) return "valid";
    if (value === false || value == null) return "invalid";
    if (typeof value === "string") {
      const result = normalizedWord(value);
      if (["valid", "navigation", "exact"].includes(result)) return "valid";
      if (["prefix", "navigation-prefix", "incomplete", "recognized"].includes(result)) return "prefix";
      return "invalid";
    }
    if (typeof value === "object") {
      if (value.valid === true || value.mode === "navigation" || value.status === "valid") return "valid";
      if (value.prefix === true || value.canContinue === true || value.recognized === true || value.status === "prefix" || value.status === "incomplete") return "prefix";
    }
    return "invalid";
  }

  function hasForcedSearchToken(lexed) {
    let depth = 0;
    for (let index = 0; index < (lexed?.tokens || []).length; index += 1) {
      const token = lexed.tokens[index];
      if (token.type === "open") { depth += 1; continue; }
      if (token.type === "close") { depth = Math.max(0, depth - 1); continue; }
      if (token.type !== "atom" || token.kind !== "word" || token.escaped || depth > 0) continue;
      const value = normalizedWord(token.value);
      if (/^(?:in|is|cites|has|common):/.test(value) || value === "or" || value === "not") return true;
    }
    return false;
  }

  function classifySingleInput(value, options = {}) {
    const input = String(value || "");
    if (!input.trim()) return { type: "classification", input, mode: "empty", status: "valid", ok: true, ast: null, errors: [] };
    const lexed = lexCommand(input);
    const forcedSearch = lexed.hadQuote || hasForcedSearchToken(lexed);
    // citationClassifier may return a boolean, valid/prefix/invalid string, or
    // an object carrying valid, prefix, canContinue, recognized, mode, or status.
    if (!forcedSearch && typeof options.citationClassifier === "function") {
      try {
        const citationStatus = classifyCitationResult(options.citationClassifier(input));
        if (citationStatus === "valid") return { type: "classification", input, mode: "navigation", status: "valid", ok: true, ast: null, errors: [] };
        if (citationStatus === "prefix") return { type: "classification", input, mode: "navigation-prefix", status: "incomplete", ok: true, ast: null, errors: [] };
      } catch (error) {
        return { type: "classification", input, mode: "invalid", status: "invalid", ok: false, ast: null, errors: [issue("citation-classifier-error", String(error?.message || error))] };
      }
    }
    const ast = parseCommand(input, options);
    return {
      type: "classification",
      input,
      mode: ast.status === "invalid" ? "invalid" : "search",
      status: ast.status,
      ok: ast.status !== "invalid",
      ast,
      errors: ast.errors
    };
  }

  function parseWorkspaceCommands(value, options = {}) {
    const input = String(value || "");
    const split = splitTopLevelCommands(input, { allowMultiple: options.allowMultiple !== false });
    if (split.status !== "valid") return { type: "workspace", input, status: split.status, ok: false, segments: split.segments, commands: [], errors: split.errors };
    const commands = split.segments.map(segment => ({ segment, classification: classifySingleInput(segment.text, options) }));
    const invalid = commands.find(command => command.classification.status === "invalid");
    const incomplete = commands.find(command => command.classification.status === "incomplete");
    const status = invalid ? "invalid" : incomplete ? "incomplete" : "valid";
    return { type: "workspace", input, status, ok: status === "valid", segments: split.segments, commands, errors: commands.flatMap(command => command.classification.errors || []) };
  }

  function parseChildCommand(value, options = {}) {
    const split = splitTopLevelCommands(value, { allowMultiple: false });
    if (split.hasTopLevelComma) return { type: "classification", input: String(value || ""), mode: "invalid", status: "invalid", ok: false, ast: null, errors: split.errors };
    return classifySingleInput(split.segments[0]?.text ?? String(value || ""), options);
  }

  function classifyInput(value, options = {}) {
    const split = splitTopLevelCommands(value, { allowMultiple: options.child !== true });
    if (options.child === true) return parseChildCommand(value, options);
    if (split.hasTopLevelComma) return parseWorkspaceCommands(value, options);
    if (split.status !== "valid") {
      const single = classifySingleInput(value, options);
      return single.status === "valid" && split.status === "incomplete" ? { ...single, status: "incomplete" } : single;
    }
    return classifySingleInput(split.segments[0]?.text || "", options);
  }

  return Object.freeze({
    QUERY_VERSION,
    extractQueryScopes,
    migrateQuery,
    scopeBranches,
    STATUTE_COMMON_LEVELS,
    CFR_COMMON_LEVELS,
    COMMON_AUTHORITIES,
    CONTENT_SCOPES,
    ARTIFACT_KINDS,
    normalizeAuthority,
    normalizeAuthorities,
    normalizeCommonLevel,
    commonLevelsForAuthority,
    commonDepth,
    commonLevelAtDepth,
    mapCommonLevel,
    scanCommandSegments,
    splitTopLevelCommands,
    lexCommand,
    parseInModifier,
    parseIsModifier,
    parseHasModifier,
    parseCommonModifier,
    resolveCommonModifiers,
    canonicalizeCommon,
    initializeCommonLevels,
    applyCommonSelection,
    parseCommand,
    serializeCommand,
    canonicalizeCommand,
    classifyCitationResult,
    classifyInput,
    parseWorkspaceCommands,
    parseChildCommand
  });
});
