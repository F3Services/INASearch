"use strict";

const PROPERTY_CODES = {
  references: "t",
  headingReferences: "h",
  preambleReferences: "p",
  sourceCreditReferences: "s",
  xReferences: "x",
  authorityReferences: "a",
  sourceReferences: "o"
};
const CODE_PROPERTIES = Object.fromEntries(Object.entries(PROPERTY_CODES).map(([property, code]) => [code, property]));
const PROPERTY_FIELDS = { references: "text", headingReferences: "heading", preambleReferences: "preamble", sourceCreditReferences: "sourceCredit", xReferences: "x", authorityReferences: "authority", sourceReferences: "source" };
const REFERENCE_KEYS = {
  id: "i", start: "s", end: "e", text: "x", family: "f", resolution: "r", targetKind: "k",
  targetTitle: "t", targetSection: "n", targetPath: "a", targetCongress: "c", targetLaw: "l",
  targetVolume: "v", targetPage: "g", houseHref: "h", officialUrl: "u", provenance: "p",
  ruleId: "q", sourceKind: "z", inaSection: "d"
};
const KEY_REFERENCES = Object.fromEntries(Object.entries(REFERENCE_KEYS).map(([property, key]) => [key, property]));
const FAMILY_CODES = { usc: "u", ina: "i", cfr: "c", "public-law": "p", "statutes-at-large": "s", "federal-register": "f", unknown: "?" };
const CODE_FAMILIES = Object.fromEntries(Object.entries(FAMILY_CODES).map(([family, code]) => [code, family]));
const RULES = ["", "explicit-usc", "explicit-ina", "explicit-cfr", "explicit-public-law", "explicit-statutes-at-large", "explicit-federal-register", "context-named-unit", "context-path-this-section", "context-title8-cfr-the-act", "ambiguous-antecedent"];

function pathTokens(value) {
  return [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
}

function compactHouseHref(value) {
  return String(value || "")
    .replace(/^\/us\/usc\/t/, "u")
    .replace(/^\/us\/pl\//, "p")
    .replace(/^\/us\/stat\//, "s")
    .replace(/^\/us\/act\//, "a");
}

function expandHouseHref(value) {
  const input = String(value || "");
  if (input.startsWith("u")) return `/us/usc/t${input.slice(1)}`;
  if (input.startsWith("p")) return `/us/pl/${input.slice(1)}`;
  if (input.startsWith("s")) return `/us/stat/${input.slice(1)}`;
  if (input.startsWith("a")) return `/us/act/${input.slice(1)}`;
  return input;
}

function compactReference(reference, houseHrefIndex = () => 0, legalTargetIndex = () => 0, previousEnd = 0) {
  const houseReference = reference.provenance === "house-uslm-ref" && reference.houseHref;
  const resolution = reference.resolution === "local" ? 1 : reference.resolution === "unresolved" ? 2 : 0;
  if (houseReference) return [0, reference.start - previousEnd, reference.end - reference.start, houseHrefIndex(reference.houseHref), resolution];
  const derivedPath = reference.ruleId === "context-path-this-section";
  const target = [FAMILY_CODES[reference.family] || "?", resolution,
    reference.targetTitle || 0, reference.targetSection || 0, !derivedPath && reference.targetPath?.length ? reference.targetPath : 0,
    reference.targetCongress || 0, reference.targetLaw || 0, reference.targetVolume || 0, reference.targetPage || 0,
    Math.max(0, RULES.indexOf(reference.ruleId || "")), reference.inaSection || 0];
  while (target.at(-1) === 0) target.pop();
  return [1, reference.start - previousEnd, reference.end - reference.start, legalTargetIndex(target)];
}

function expandReference(reference, sourceText = "", houseHrefs = [], source = null, legalTargets = [], previousEnd = 0) {
  const output = {};
  const start = previousEnd + Number(reference?.[1] || 0);
  const end = start + Number(reference?.[2] || 0);
  if (Array.isArray(reference) && reference[0] === 0) Object.assign(output, { start, end, houseHref: expandHouseHref(houseHrefs[reference[3]]), resolution: reference[4] });
  else if (Array.isArray(reference)) {
    const packedTarget = legalTargets[reference[3]] || [];
    const target = typeof packedTarget === "string" ? packedTarget.split("|") : packedTarget;
    if (typeof target[4] === "string") target[4] = target[4] ? target[4].split("/") : [];
    Object.assign(output, { start, end, family: CODE_FAMILIES[target[0]] || "unknown", resolution: Number(target[1] || 0), targetTitle: target[2] || "", targetSection: target[3] || "", targetPath: target[4] || [], targetCongress: target[5] || "", targetLaw: target[6] || "", targetVolume: target[7] || "", targetPage: target[8] || "", ruleId: RULES[target[9] || 0] || "", inaSection: target[10] || "" });
  }
  else for (const [key, value] of Object.entries(reference || {})) output[KEY_REFERENCES[key] || key] = value;
  output.resolution = output.resolution === 1 ? "local" : output.resolution === 2 ? "unresolved" : "official-source-only";
  if (!output.targetPath) output.targetPath = [];
  output.text = String(sourceText || "").slice(output.start, output.end);
  if (output.ruleId === "context-path-this-section" && !output.targetPath.length) output.targetPath = pathTokens(output.text);
  if (output.houseHref) {
    output.provenance = "house-uslm-ref";
    output.ruleId = "house-uslm-ref";
    let match = output.houseHref.match(/^\/us\/usc\/t([^/]+)\/s([^/]+)(?:\/(.*))?$/);
    if (match) Object.assign(output, { family: "usc", targetKind: "usc", targetTitle: match[1], targetSection: match[2], targetPath: match[3] ? match[3].split("/").filter(Boolean) : [], officialUrl: `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title${match[1]}-section${match[2]}`)}` });
    else if ((match = output.houseHref.match(/^\/us\/pl\/(\d+)\/(\d+)(?:\/(.*))?$/))) Object.assign(output, { family: "public-law", targetKind: "public-law", targetCongress: match[1], targetLaw: match[2], targetPath: match[3] ? match[3].split("/").filter(Boolean) : [], officialUrl: `https://www.govinfo.gov/app/details/PLAW-${match[1]}publ${match[2]}` });
    else if ((match = output.houseHref.match(/^\/us\/stat\/([^/]+)\/([^/]+)(?:\/(.*))?$/))) Object.assign(output, { family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: match[1], targetPage: match[2], targetPath: match[3] ? match[3].split("/").filter(Boolean) : [], officialUrl: `https://www.govinfo.gov/app/details/STATUTE-${match[1]}/STATUTE-${match[1]}-Pg${match[2]}` });
    else if (/^\/us\/act\//.test(output.houseHref)) Object.assign(output, { family: "public-law", targetKind: "act", targetPath: output.houseHref.split("/").filter(Boolean).slice(2), officialUrl: `https://www.govinfo.gov/app/search/%7B%22query%22%3A%22${encodeURIComponent(output.text || "")}%22%7D` });
  } else {
    output.provenance = String(output.ruleId || "").startsWith("context-") || output.ruleId === "ambiguous-antecedent" ? "deterministic-context" : "deterministic-parser";
    output.targetKind = output.family === "ina" && output.resolution !== "local" ? "ina" : output.family;
    if (output.family === "usc" && output.targetSection) output.officialUrl = `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title${output.targetTitle}-section${output.targetSection}`)}`;
    else if (output.family === "cfr" && output.targetSection) output.officialUrl = `https://www.ecfr.gov/current/title-${encodeURIComponent(output.targetTitle)}/part-${encodeURIComponent(String(output.targetSection).split(".")[0])}/section-${encodeURIComponent(output.targetSection)}`;
    else if (output.family === "public-law") output.officialUrl = `https://www.govinfo.gov/app/details/PLAW-${output.targetCongress}publ${output.targetLaw}`;
    else if (output.family === "statutes-at-large") output.officialUrl = `https://www.govinfo.gov/app/details/STATUTE-${output.targetVolume}/STATUTE-${output.targetVolume}-Pg${output.targetPage}`;
    else if (output.family === "federal-register") output.officialUrl = `https://www.govinfo.gov/app/search/%7B%22query%22%3A%22${encodeURIComponent(output.text || "")}%22%7D`;
    else if (output.family === "ina") output.officialUrl = output.targetSection ? `https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=${encodeURIComponent(`granuleid:USC-prelim-title8-section${output.targetSection}`)}` : "https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act";
  }
  return output;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => visit(item, callback)); return; }
  callback(value);
  Object.values(value).forEach(child => visit(child, callback));
}

function packLegalReferences(corpus) {
  let sources = 0;
  let references = 0;
  const houseHrefs = [];
  const houseHrefIndexes = new Map();
  const houseHrefIndex = href => {
    const compact = compactHouseHref(href);
    if (!houseHrefIndexes.has(compact)) { houseHrefIndexes.set(compact, houseHrefs.length); houseHrefs.push(compact); }
    return houseHrefIndexes.get(compact);
  };
  const legalTargets = [];
  const legalTargetIndexes = new Map();
  const legalTargetIndex = target => {
    const key = target.map(value => Array.isArray(value) ? value.join("/") : String(value || "")).join("|").replace(/\|+$/, "");
    if (!legalTargetIndexes.has(key)) { legalTargetIndexes.set(key, legalTargets.length); legalTargets.push(key); }
    return legalTargetIndexes.get(key);
  };
  visit(corpus, source => {
    const packed = {};
    for (const [property, code] of Object.entries(PROPERTY_CODES)) {
      if (!Array.isArray(source[property]) || !source[property].length || !source[property].every(reference => Number.isInteger(reference?.start) && Number.isInteger(reference?.end))) continue;
      let previousEnd = 0;
      const packedReferences = source[property].map(reference => {
        const packedReference = compactReference(reference, houseHrefIndex, legalTargetIndex, previousEnd);
        previousEnd = reference.end;
        return packedReference;
      });
      packed[code] = packedReferences.map(reference => reference.join(",")).join(";");
      references += source[property].length;
      delete source[property];
    }
    if (Object.keys(packed).length) { source._lr = packed; sources += 1; }
  });
  corpus.legalReferencePacking = { schemaVersion: 2, sources, references, houseHrefs, legalTargets, hydratedAtRuntime: true };
  return corpus;
}

function unpackLegalReferences(corpus) {
  const houseHrefs = corpus?.legalReferencePacking?.houseHrefs || [];
  const legalTargets = corpus?.legalReferencePacking?.legalTargets || [];
  visit(corpus, source => {
    if (!source._lr) return;
    for (const [code, packedReferences] of Object.entries(source._lr)) {
      const property = CODE_PROPERTIES[code];
      if (property) {
        const references = typeof packedReferences === "string" ? packedReferences.split(";").filter(Boolean).map(reference => reference.split(",").map(Number)) : packedReferences;
        let previousEnd = 0;
        source[property] = references.map(reference => {
          const expanded = expandReference(reference, source[PROPERTY_FIELDS[property]], houseHrefs, source, legalTargets, previousEnd);
          previousEnd = expanded.end;
          return expanded;
        });
      }
    }
    delete source._lr;
  });
  return corpus;
}

module.exports = { compactHouseHref, expandHouseHref, compactReference, expandReference, packLegalReferences, unpackLegalReferences };
