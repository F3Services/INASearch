#!/usr/bin/env node
"use strict";

// Resolve citations in case text against the exact INA/USC/CFR hierarchy that
// INASearch ships.  OCR repair is deliberately candidate-based: source text is
// never rewritten, and an ambiguous repair is retained for review rather than
// silently selected.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const LegalReferences = require("./legal-references");

const ROOT = path.resolve(__dirname, "..");

function loadCorpus() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const filename of ["src/INASearch-Corpus.js", "src/INASearch-CFR.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, filename), "utf8"), sandbox, { filename });
  }
  return { ...sandbox.window.INA_SEARCH_CORPUS, cfr: sandbox.window.INA_SEARCH_CFR };
}

const corpus = loadCorpus();
const canonical = LegalReferences.legalReferenceContext(corpus);

function key(title, section, unitPath = []) {
  return `${title}:${section}:${unitPath.join("/")}`;
}

function pathTokens(value) {
  return [...String(value || "").matchAll(/\(([^()]*)\)/g)].map(match => match[1]);
}

const CONFUSIONS = Object.freeze({
  I: ["I", "1"], i: ["i", "1"], l: ["l", "1"], "|": ["|", "1"],
  O: ["O", "0"], o: ["o", "0"], S: ["S", "5"], B: ["B", "8"]
});

function alternatives(value, limit = 256) {
  let values = [{ value: "", repairs: [] }];
  for (const [offset, character] of [...String(value)].entries()) {
    const choices = CONFUSIONS[character] || [character];
    const next = [];
    for (const current of values) for (const choice of choices) {
      next.push({
        value: current.value + choice,
        repairs: choice === character ? current.repairs : [...current.repairs, { offset, from: character, to: choice }]
      });
      if (next.length >= limit) break;
    }
    values = next;
    if (values.length >= limit) break;
  }
  return values;
}

function cartesianTokens(tokens, limit = 256) {
  let values = [{ tokens: [], repairs: [] }];
  for (const [tokenIndex, token] of tokens.entries()) {
    const next = [];
    for (const current of values) for (const candidate of alternatives(token, 32)) {
      next.push({
        tokens: [...current.tokens, candidate.value],
        repairs: [...current.repairs, ...candidate.repairs.map(repair => ({ ...repair, tokenIndex }))]
      });
      if (next.length >= limit) break;
    }
    values = next;
  }
  return values;
}

function inaTarget(inaSection, unitPath) {
  const mapping = canonical.inaMap.get(String(inaSection).toLowerCase());
  if (!mapping?.uscSection) return null;
  const section = String(mapping.uscSection);
  const canonicalPath = canonical.uscCanonicalPaths.get(key("8", section, unitPath).toLowerCase());
  if (unitPath.length && !canonicalPath) return null;
  return {
    family: "ina", targetKind: "usc", targetTitle: "8", targetSection: section,
    targetPath: canonicalPath || [], inaSection: String(inaSection), resolution: "local"
  };
}

function uscTarget(title, section, unitPath) {
  const canonicalPath = canonical.uscCanonicalPaths.get(key(title, section, unitPath).toLowerCase());
  if (!canonical.uscSections.has(`${title}:${section}`) || (unitPath.length && !canonicalPath)) return null;
  return { family: "usc", targetKind: "usc", targetTitle: title, targetSection: section, targetPath: canonicalPath || [], resolution: "local" };
}

function cfrTarget(title, section, unitPath) {
  if (!canonical.cfrSections.has(`${title}:${section}`) || (unitPath.length && !canonical.cfrPaths.has(`${title}:${section}:${unitPath.join("/")}`))) return null;
  return { family: "cfr", targetKind: "cfr", targetTitle: title, targetSection: section, targetPath: unitPath, resolution: "local" };
}

function repairedCandidates(text) {
  const input = String(text || "");
  const results = [];
  const patterns = [
    {
      family: "usc",
      regex: /\b([0-9Il|]{1,2})\s+U\.?\s*S\.?\s*C\.?\s*(?:§{1,2}|[sS]ections?)?\s*([0-9Il|OSB]{3,5}[A-Za-z]?)((?:\s*\([A-Za-z0-9Il|OSB-]+\))*)/g,
      build: (title, section, unitPath) => uscTarget(title, section, unitPath)
    },
    {
      family: "cfr",
      regex: /\b([0-9Il|]{1,2})\s+C\.?\s*F\.?\s*R\.?\s*(?:§{1,2}|[sS]ections?)?\s*([0-9Il|OSB]{1,4}\.[0-9Il|OSB]{1,4}[A-Za-z]?)((?:\s*\([A-Za-z0-9Il|OSB-]+\))*)/g,
      build: (title, section, unitPath) => cfrTarget(title, section, unitPath)
    },
    {
      family: "ina",
      regex: /\bINA\s*(?:§|[sS]ection)?\s*([0-9Il|OSB]{3}[A-Za-z]?)((?:\s*\([A-Za-z0-9Il|OSB-]+\))*)/g,
      ina: true,
      build: (_title, section, unitPath) => inaTarget(section, unitPath)
    },
    {
      family: "ina",
      regex: /\b[sS]ection\s*([0-9Il|OSB]{3}[A-Za-z]?)((?:\s*\([A-Za-z0-9Il|OSB-]+\))*)\s+of\s+(?:the\s+)?(?:Immigration\s+and\s+Nationality\s+Act|INA|Act)\b/g,
      ina: true,
      build: (_title, section, unitPath) => inaTarget(section, unitPath)
    }
  ];
  for (const pattern of patterns) for (const match of input.matchAll(pattern.regex)) {
    const writtenTitle = pattern.ina ? "8" : match[1];
    const writtenSection = pattern.ina ? match[1] : match[2];
    const writtenPath = pathTokens(pattern.ina ? match[2] : match[3]);
    const valid = [];
    for (const title of alternatives(writtenTitle, 16)) for (const section of alternatives(writtenSection, 64)) {
      for (const unit of cartesianTokens(writtenPath, 128)) {
        const target = pattern.build(title.value, section.value, unit.tokens);
        if (!target) continue;
        const repairs = [
          ...title.repairs.map(repair => ({ ...repair, component: "title" })),
          ...section.repairs.map(repair => ({ ...repair, component: "section" })),
          ...unit.repairs.map(repair => ({ ...repair, component: "path" }))
        ];
        valid.push({ target, repairs });
      }
    }
    const unique = new Map(valid.map(candidate => [JSON.stringify(candidate.target), candidate]));
    const candidates = [...unique.values()].sort((a, b) => a.repairs.length - b.repairs.length || JSON.stringify(a.target).localeCompare(JSON.stringify(b.target)));
    if (!candidates.length) continue;
    results.push({
      start: match.index, end: match.index + match[0].length, text: match[0], family: pattern.family,
      provenance: candidates.length === 1 && candidates[0].repairs.length === 0 ? "deterministic-case-parser" : "ocr-contextual-repair",
      ruleId: candidates.length === 1 && candidates[0].repairs.length === 0 ? `case-explicit-${pattern.family}` : `case-ocr-${pattern.family}`,
      confidence: candidates.length === 1 ? (candidates[0].repairs.length ? Math.max(0.6, 0.94 - candidates[0].repairs.length * 0.08) : 1) : 0.35,
      resolution: candidates.length === 1 ? "local" : "ambiguous",
      ...(candidates.length === 1 ? candidates[0].target : {}),
      repairs: candidates.length === 1 ? candidates[0].repairs : [],
      alternatives: candidates.map(candidate => ({ ...candidate.target, repairs: candidate.repairs }))
    });
  }
  return results;
}

function exactCandidates(text, sourceId) {
  const context = { ...canonical, kind: "case", title: "", section: "", path: [], sourceId };
  return LegalReferences.explicitReferenceCandidates(text, context)
    // OCR can cause the shared exact grammar to stop inside a token (for
    // example `INA § 2l2` becoming the false partial match `INA § 2l`).
    .filter(reference => !/[A-Za-z0-9]/.test(String(text)[reference.end] || ""))
    .map(reference => {
      const targetPath = [...(reference.targetPath || [])];
      const writtenEdition = reference.text.match(/\(((?:18|19|20)\d{2})\)\s*$/);
      const malformedEdition = reference.text.match(/\(1((?:18|19|20)\d{2})\)\s*$/);
      let editionYear = writtenEdition ? Number(writtenEdition[1]) : undefined;
      let normalizedTarget = null;
      const repairs = [];
      if (editionYear && String(targetPath.at(-1)) === String(editionYear)) {
        targetPath.pop();
      } else if (malformedEdition && String(targetPath.at(-1)) === malformedEdition[0].slice(1, -1)) {
        // Some hidden OCR layers insert a leading "1" into a parenthetical
        // edition year: `(2006)` becomes `(12006)`.  Treat it as an edition
        // only when removing it leaves a unit path present in INASearch's
        // canonical hierarchy.  The source span stays untouched and the
        // accepted contextual repair remains explicit in the audit record.
        const basePath = targetPath.slice(0, -1);
        if (reference.family === "usc") {
          normalizedTarget = uscTarget(reference.targetTitle, reference.targetSection, basePath);
        } else if (reference.family === "cfr") {
          normalizedTarget = cfrTarget(reference.targetTitle, reference.targetSection, basePath);
        } else if (reference.family === "ina") {
          normalizedTarget = inaTarget(reference.inaSection || reference.targetSection, basePath);
        }
        if (normalizedTarget) {
          targetPath.pop();
          editionYear = Number(malformedEdition[1]);
          repairs.push({
            component: "editionYear", from: malformedEdition[0].slice(1, -1), to: malformedEdition[1],
            reason: "OCR-leading-1 removed after validating the remaining authority path"
          });
        }
      }
      return {
        ...reference, ...(normalizedTarget || {}), targetPath, ...(editionYear ? { editionYear } : {}),
        ...(repairs.length ? { provenance: "ocr-contextual-repair", ruleId: `case-ocr-${reference.family}-edition` } : {}),
        confidence: repairs.length ? 0.82 : reference.resolution === "local" ? 1 : 0.9, repairs
      };
    });
}

function historicalInaCandidates(text, occupied) {
  const results = [];
  const patterns = [
    /\bINA\s*(?:§|[sS]ection)?\s*(\d{3}[A-Za-z]?)((?:\s*\([A-Za-z0-9-]+\))*)/g,
    /\b[sS]ection\s*(\d{3}[A-Za-z]?)((?:\s*\([A-Za-z0-9-]+\))*)\s+of\s+(?:the\s+)?(?:Immigration\s+and\s+Nationality\s+Act|INA|Act)\b/g
  ];
  for (const pattern of patterns) for (const match of String(text || "").matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (occupied.some(([usedStart, usedEnd]) => start < usedEnd && end > usedStart)) continue;
    results.push({
      start, end, text: match[0], family: "ina", targetKind: "ina", targetTitle: "INA",
      targetSection: match[1], targetPath: pathTokens(match[2]), resolution: "historical-unmapped",
      provenance: "deterministic-case-parser", ruleId: "case-explicit-ina-historical",
      confidence: 0.9, repairs: [], alternatives: []
    });
  }
  return results;
}

// Reporter citations are evidence independently of whether the surrounding
// prose contains treatment language.  Keep this grammar deliberately narrower
// than a fuzzy OCR recognizer: variants printed in the official reporters are
// accepted, but damaged digits are left unresolved for a later, auditable OCR
// repair layer.
const CASE_NAME_PATTERN = String.raw`(?:Matter\s+of\s+[A-Z][A-Za-z0-9 .&'’–—\-]{1,140}?|(?:In\s+re\s+)?[A-Z][A-Z0-9 .&'’–—\-]{1,80}?)`;
const REPORTER_PATTERN = String.raw`I(?:\s*\.)?\s*&\s*N(?:\s*\.)?\s+Dec(?:\s*\.)?`;
const CASE_REPORTER_CITATION = new RegExp(
  String.raw`(?<base>(?<volume>\d{1,2})\s+${REPORTER_PATTERN}\s+(?<page>\d{1,4}))(?<pinpointText>(?:\s*,\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*)(?:\s*\((?<court>[^()\r\n]{0,80}?)\s*(?<year>(?:18|19|20)\d{2})\))?`,
  "g"
);

const SUFFIX_TREATMENT_PATTERN = [
  String.raw`overruled\s+in\s+part`, String.raw`declined\s+to\s+follow`, String.raw`not\s+followed`,
  String.raw`no\s+longer\s+(?:controlling|good\s+law)`, String.raw`not\s+controlling`,
  "overruled", "modified", "clarified", "distinguished", "reaffirmed", "affirmed", "superseded",
  "vacated", "withdrawn", "reversed", "disapproved", "abrogated", "followed", "limited",
  "approved", "adopted", "criticized", "questioned"
].join("|");
const ACTIVE_TREATMENT_PATTERN = [
  String.raw`overrules?(?:\s+in\s+part)?`, String.raw`withdraws?\s+from`, String.raw`decline(?:s|d)?\s+to\s+follow`,
  String.raw`do(?:es)?\s+not\s+follow`, "modifies?", "clarifies?", "distinguishes?", "reaffirms?", "affirms?",
  "supersedes?", "vacates?", "reverses?", "disapproves?", "abrogates?", "follows?", "limits?",
  "approves?", "adopts?", "criticizes?", "questions?"
].join("|");
const CURRENT_DECISION_SUBJECT = String.raw`(?:we|I|the\s+(?:Board(?:\s+of\s+Immigration\s*Appeals)?|Attorney\s+General|Commissioner)|this\s+(?:Board|office)|USCIS)`;
const ACTIVE_TREATMENT = new RegExp(
  String.raw`\b${CURRENT_DECISION_SUBJECT}\s+(?:hereby\s+|now\s+|expressly\s+|therefore\s+)*(?<phrase>${ACTIVE_TREATMENT_PATTERN})\s*$`,
  "i"
);
const SUFFIX_TREATMENT = new RegExp(
  String.raw`^(?:\s*[,;:]\s*|\s+|\s*\(\s*)(?:(?:is|are|was|were|has\s+been|have\s+been)\s+(?:hereby\s+|now\s+)*)?(?<phrase>${SUFFIX_TREATMENT_PATTERN})(?![A-Za-z])`,
  "i"
);

function sentenceBounds(text, start, end) {
  let before = 0;
  for (const match of text.matchAll(/(?:[.!?][”"')\]]*|\n)\s+(?=[A-Z(])/g)) {
    const boundary = match.index + match[0].length;
    if (boundary > start) break;
    before = boundary;
  }
  const following = text.slice(end);
  const stop = following.match(/[.!?][”"')\]]*(?=\s+(?:[A-Z(]|Matter\b)|$)|\n/);
  const finish = stop ? end + stop.index + stop[0].length : Math.min(text.length, end + 240);
  return [before, finish];
}

function precedingCaseName(text, citationStart) {
  const windowStart = Math.max(0, citationStart - 190);
  const prefix = text.slice(windowStart, citationStart);
  const match = prefix.match(new RegExp(String.raw`(?<name>${CASE_NAME_PATTERN}),[ \t\r\n]*$`));
  if (!match?.groups?.name) return null;
  const nameStart = windowStart + match.index;
  return { name: match.groups.name.trim(), start: nameStart, end: nameStart + match.groups.name.length };
}

function reporterPinpoints(value) {
  const output = [];
  for (const match of String(value || "").matchAll(/(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?/g)) {
    output.push(match[2]
      ? { startPage: Number(match[1]), endPage: Number(match[2]) }
      : { page: Number(match[1]) });
  }
  return output;
}

function caseCitationCandidates(text) {
  const input = String(text || "");
  const results = [];
  for (const match of input.matchAll(CASE_REPORTER_CITATION)) {
    const name = precedingCaseName(input, match.index);
    const end = match.index + match[0].length;
    const [sentenceStart, sentenceEnd] = sentenceBounds(input, match.index, end);
    results.push({
      start: match.index, end, text: match[0], writtenCitation: match.groups.base,
      canonicalCitation: `${Number(match.groups.volume)} I&N Dec. ${Number(match.groups.page)}`,
      citedCaseName: name?.name || null, nameStart: name?.start ?? null, nameEnd: name?.end ?? null,
      citedCaseVolume: Number(match.groups.volume), citedCasePage: Number(match.groups.page),
      pinpoints: reporterPinpoints(match.groups.pinpointText),
      citedCaseBody: match.groups.court?.trim() || null,
      citedCaseYear: match.groups.year ? Number(match.groups.year) : null,
      evidence: input.slice(sentenceStart, sentenceEnd).trim(),
      resolution: "pending-manifest-resolution", provenance: "deterministic-case-reporter-parser",
      ruleId: "case-reporter-citation", confidence: 1, repairs: []
    });
  }
  return results;
}

function normalizeTreatment(phrase) {
  const value = String(phrase || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (/^overrules?|^overruled/.test(value)) return /in part/.test(value) ? "overruled-in-part" : "overruled";
  if (/^(?:decline|do(?:es)? not follow|not followed)/.test(value)) return "not-followed";
  if (/no longer (?:controlling|good law)|not controlling/.test(value)) return "not-controlling";
  if (/^withdraw/.test(value)) return "withdrawn";
  const stems = [
    ["modif", "modified"], ["clarif", "clarified"], ["distinguish", "distinguished"],
    ["reaffirm", "reaffirmed"], ["affirm", "affirmed"], ["supersed", "superseded"],
    ["vacat", "vacated"], ["revers", "reversed"], ["disapprov", "disapproved"],
    ["abrogat", "abrogated"], ["follow", "followed"], ["limit", "limited"],
    ["approv", "approved"], ["adopt", "adopted"], ["criticiz", "criticized"], ["question", "questioned"]
  ];
  return stems.find(([stem]) => value.startsWith(stem))?.[1] || value.replace(/\s+/g, "-");
}

function partyAttribution(text) {
  return /\b(?:respondent|applicant|petitioner|DHS|the\s+Service|counsel)\s+(?:argues?|contends?|asserts?|maintains?|claims?|urges?|submits?)\b/i.test(text);
}

function treatmentRecord(text, legalCitations, occurrence, treatment, bounds, provenance, confidence) {
  const [sentenceStart, contextEnd] = sentenceBounds(text, bounds.start, bounds.end);
  const preceding = sentenceStart > 0 ? sentenceBounds(text, Math.max(0, sentenceStart - 2), sentenceStart)[0] : sentenceStart;
  const contextStart = Math.max(text.lastIndexOf("\n", sentenceStart - 1) + 1, preceding);
  return {
    start: occurrence.start, end: bounds.end,
    citedCaseName: occurrence.citedCaseName || occurrence.canonicalCitation,
    citedCaseCitation: occurrence.canonicalCitation,
    citedCaseVolume: occurrence.citedCaseVolume, citedCasePage: occurrence.citedCasePage,
    citedCaseBody: occurrence.citedCaseBody || "", citedCaseYear: occurrence.citedCaseYear,
    treatment,
    evidence: text.slice(sentenceStart, contextEnd).trim(),
    scopeEvidence: text.slice(contextStart, contextEnd).trim(),
    relatedLegalTargets: legalCitations.filter(citation => citation.start < contextEnd && citation.end > contextStart).map(citation => ({
      family: citation.family, title: citation.targetTitle, section: citation.targetSection, path: citation.targetPath || []
    })),
    provenance, confidence
  };
}

function treatmentCandidates(text, legalCitations, caseCitations = caseCitationCandidates(text)) {
  const results = [];
  for (const occurrence of caseCitations) {
    const targetStart = occurrence.nameStart ?? occurrence.start;
    const prefixStart = Math.max(0, targetStart - 180);
    const prefix = text.slice(prefixStart, targetStart);
    const predicate = prefix.match(ACTIVE_TREATMENT);
    if (predicate?.groups?.phrase) {
      const absoluteStart = prefixStart + predicate.index;
      const [sentenceStart] = sentenceBounds(text, absoluteStart, occurrence.end);
      const attributionPrefix = text.slice(sentenceStart, absoluteStart);
      const requestedAction = /\b(?:requests?|urges?|asks?|moves?)\s+(?:that\s+)?$/i.test(attributionPrefix)
        || /\brequest\s+that\s*$/i.test(attributionPrefix);
      if (!requestedAction && !partyAttribution(attributionPrefix)) {
        const treatment = normalizeTreatment(predicate.groups.phrase);
        results.push(treatmentRecord(
          text, legalCitations, occurrence, treatment,
          { start: absoluteStart, end: occurrence.end }, "explicit-current-decision-predicate-treatment", 1
        ));
      }
    }

    const suffixText = text.slice(occurrence.end, Math.min(text.length, occurrence.end + 100));
    const suffix = suffixText.match(SUFFIX_TREATMENT);
    if (!suffix?.groups?.phrase) continue;
    const suffixEnd = occurrence.end + suffix.index + suffix[0].length;
    // "overruled by Matter of ..." describes a separately named treating
    // authority.  Until both endpoints are represented explicitly, do not
    // misattribute that relationship to the opinion containing the quotation.
    if (/^\s+by\b/i.test(text.slice(suffixEnd, suffixEnd + 20))) continue;
    const [sentenceStart] = sentenceBounds(text, targetStart, suffixEnd);
    const sentencePrefix = text.slice(sentenceStart, targetStart);
    if (partyAttribution(sentencePrefix) && !/\b(?:we|the Board|the Attorney General)\b/i.test(sentencePrefix)) continue;
    let treatment = normalizeTreatment(suffix.groups.phrase);
    if (treatment === "overruled" && /^\s+(?:insofar\s+as|to\s+the\s+extent)\b/i.test(text.slice(suffixEnd, suffixEnd + 60))) {
      treatment = "overruled-in-part";
    }
    if (results.some(item => item.start === occurrence.start && item.treatment === treatment)) continue;
    results.push(treatmentRecord(
      text, legalCitations, occurrence, treatment,
      { start: targetStart, end: suffixEnd }, "explicit-suffix-or-passive-treatment-language", 0.98
    ));
  }
  return results.sort((left, right) => left.start - right.start || left.end - right.end || left.treatment.localeCompare(right.treatment));
}

function annotateApplicability(citations, text, isHeadnote) {
  return citations.map(citation => {
    const [start, end] = sentenceBounds(text, citation.start, citation.end);
    const evidence = text.slice(start, end).trim();
    // "Under" occurs in routine background and party-position citations
    // throughout the reporter.  It is not, by itself, evidence that the
    // current decision construed or applied the cited rule as a holding.
    const holdingCue = /\b(?:hold|held|conclude|within the meaning|govern(?:ed|ing)|requires?|ineligible|eligible|must|may not|properly)\b/i.test(evidence);
    const score = isHeadnote ? 1 : holdingCue ? 0.82 : 0.42;
    return { ...citation, applicability: score >= 0.8 ? "holding-candidate" : "discussed", applicabilityScore: score, evidence };
  });
}

function analyze(input) {
  const text = String(input.text || "");
  const exact = exactCandidates(text, input.sourceId || "case");
  const occupied = exact.map(item => [item.start, item.end]);
  const repaired = repairedCandidates(text).filter(item => !occupied.some(([start, end]) => item.start < end && item.end > start));
  const historicalIna = historicalInaCandidates(text, [...occupied, ...repaired.map(item => [item.start, item.end])]);
  const citations = annotateApplicability([...exact, ...repaired, ...historicalIna].sort((a, b) => a.start - b.start || a.end - b.end), text, Boolean(input.isHeadnote));
  const caseCitations = caseCitationCandidates(text);
  return { schemaVersion: 2, citations, caseCitations, treatments: treatmentCandidates(text, citations, caseCitations) };
}

if (require.main === module) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { buffer += chunk; });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(buffer);
      const output = Array.isArray(input.blocks)
        ? { schemaVersion: 2, blocks: input.blocks.map(block => ({ id: block.id, ...analyze({ ...block, sourceId: `${input.sourceId || "case"}-${block.id}` }) })) }
        : analyze(input);
      process.stdout.write(JSON.stringify(output) + "\n");
    } catch (error) {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    }
  });
}

module.exports = { analyze, alternatives, repairedCandidates, caseCitationCandidates, treatmentCandidates };
