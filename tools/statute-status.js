"use strict";

/*
 * Reviewed transfer destinations derived from the House Title 8 codification
 * notes already embedded in INASearch-Corpus.js. Current status remains
 * implicit; only exceptional top-level records receive this derived index.
 */
const TRANSFER_TARGETS = Object.freeze({
  "31, 32": [["31", 52, "10101"], ["32", 52, "10102"]],
  "41 to 43": [["41", 42, "1981"], ["42", 42, "1982"], ["43", 42, "1983"]],
  "46 to 51": [["46", 42, "1984"], ["47", 42, "1985"], ["48", 42, "1986"], ["49", 42, "1987"], ["50", 42, "1989"], ["51", 42, "1990"]],
  "53 to 56": [["53", 42, "1991"], ["54", 42, "1992"], ["55", 42, "1993", "former"], ["56", 42, "1994"]],
  "71 to 78": Array.from({ length: 8 }, (_, index) => [String(71 + index), 48, String(1501 + index)]),
  "83 to 86": Array.from({ length: 4 }, (_, index) => [String(83 + index), 48, String(1509 + index)]),
  "100, 101": [["100", 8, "1551"], ["101", 8, "1552"]],
  "109a to 109d": [["109a", 8, "1353a"], ["109b", 8, "1353b"], ["109c", 8, "1353d"], ["109d", 8, "1555", "see"]],
  "111": [["111", 8, "1554"]],
  "238": [["238", 8, "1557"]],
  "606": [["606", 8, "1407", "see"]],
  "724a–1": [["724a–1", 8, "1440", "note"]],
  "800": [["800", 8, "1481", "note"]],
  "903a, 903b": [["903a", 22, "1731"], ["903b", 22, "1732"]],
  "1186": [["1186", 8, "1188"]],
  "1251": [["1251", 8, "1227"]],
  "1252a": [["1252a", 8, "1228"]],
  "1556": [["1556", 8, "1353d"]]
});

function expandedTarget(tuple) {
  const [source, title, section, qualifier = ""] = tuple;
  return {
    source,
    title,
    section,
    ...(qualifier === "note" ? { placement: "note" } : {}),
    ...(qualifier === "see" ? { relation: "see" } : {}),
    ...(qualifier === "former" ? { former: true } : {})
  };
}

function applyStatuteStatusMetadata(corpus) {
  const sections = corpus?.title8?.sections || [];
  const transferred = sections.filter(section => section.status === "transferred");
  const transferredLabels = new Set(transferred.map(section => String(section.section)));
  const configuredLabels = new Set(Object.keys(TRANSFER_TARGETS));
  const missing = [...transferredLabels].filter(label => !configuredLabels.has(label));
  const stale = [...configuredLabels].filter(label => !transferredLabels.has(label));
  if (missing.length || stale.length) {
    throw new Error(`Transferred-section destination index is out of sync (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}).`);
  }
  for (const section of transferred) section.transferTargets = TRANSFER_TARGETS[String(section.section)].map(expandedTarget);
  return corpus;
}

module.exports = { TRANSFER_TARGETS, applyStatuteStatusMetadata };
