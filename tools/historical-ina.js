"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "sources/legal/historical-ina.json");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function readHistoricalIna() {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  if (data.sections.length !== 14) throw new Error("Historical INA import must contain exactly 14 bodies.");
  for (const capture of data.captures) {
    const bytes = fs.readFileSync(path.join(ROOT, capture.file));
    if (bytes.length !== capture.bytes || hash(bytes) !== capture.sha256) throw new Error(`Historical source checksum mismatch: ${capture.file}`);
  }
  for (const section of data.sections) if (hash(JSON.stringify(section.units)) !== section.unitsSha256) throw new Error(`Historical transcription checksum mismatch: INA ${section.inaSection}`);
  return data;
}

function parseHistoricalUnits(units) {
  const body = [], nodes = new Map();
  let preamble = "";
  for (const unit of units) {
    if (!unit.path.length) { if (preamble) throw new Error("Duplicate historical preamble"); preamble = unit.text || ""; continue; }
    const key = unit.path.join("/");
    if (nodes.has(key) && !(unit.duplicateDesignation === true && unit.path.length === 1 && unit.path[0] === "c")) throw new Error(`Duplicate historical path: ${key}`);
    const node = { label: unit.path.at(-1), path: unit.path.slice(), ...Object.fromEntries(["heading", "text", "continuation"].filter(k => unit[k]).map(k => [k, unit[k]])) };
    nodes.set(key, node);
    if (unit.path.length === 1) body.push(node);
    else {
      const parent = nodes.get(unit.path.slice(0, -1).join("/"));
      if (!parent) throw new Error(`Missing historical parent: ${key}`);
      (parent.children ||= []).push(node);
    }
  }
  return { body, ...(preamble ? { preamble } : {}) };
}

function applyHistoricalIna(corpus, data = readHistoricalIna()) {
  corpus.corpusVersion = "2026.09.19-historical.4";
  if (!corpus.approvedDomains.includes("tile.loc.gov")) corpus.approvedDomains.push("tile.loc.gov");
  const sections = corpus.title8.sections;
  const grouped = sections.find(s => s.section === "1484 to 1487");
  for (const record of data.sections) {
    let section = sections.find(s => s.section === record.uscSection);
    if (!section) {
      if (!["1484", "1485", "1486", "1487"].includes(record.uscSection) || !grouped) throw new Error(`No House record for ${record.uscSection}`);
      section = { ...structuredClone(grouped), id: `8-${record.uscSection}`, section: record.uscSection, identifier: `/us/usc/t8/s${record.uscSection}`, combinedHouseRecord: grouped.id };
      section.notes = section.notes.filter(note => note.text.startsWith(`Section ${record.uscSection},`)).map((note, index) => ({ ...note, id: `${section.id}-note-${index + 1}` }));
      sections.splice(sections.indexOf(grouped), 0, section);
    }
    section.houseHeading = section.heading;
    section.heading = record.originalTitle;
    delete section.headingReferences;
    delete section.headingFootnoteReferences;
    Object.assign(section, parseHistoricalUnits(record.units));
    section.status = record.status || "repealed";
    const capture = data.captures.find(c => c.file.endsWith(`/${record.sourceFile}`));
    const { units, ...metadata } = record;
    section.historical = { ...metadata, sourceSha256: capture.sha256, sourceArtifact: capture.file, sourceCapturedAt: capture.capturedAt };
    // Keep the current House source, repeal heading and editorial notes intact.
    const row = corpus.inaCrosswalk.find(r => r.inaSection === record.inaSection);
    if (row) {
      row.originalCrosswalk = { title: row.title, localSection: row.localSection, uscSection: row.uscSection, hasEquivalent: row.hasEquivalent, uscLabel: row.uscLabel };
      Object.assign(row, { status: record.status || "repealed", title: record.originalTitle, localSection: record.uscSection, uscSection: record.uscSection, hasEquivalent: true, uscLabel: `8 U.S.C. ${record.uscSection}`, historicalMapping: true });
    }
  }
  for (const row of corpus.inaCrosswalk) if (data.titles[row.inaSection]) {
    row.title = data.titles[row.inaSection];
    if (row.inaSection === "242A") row.status = "transferred";
  }
  for (const section of corpus.inaHierarchy?.sections || []) if (data.titles[section.inaSection]) section.heading = data.titles[section.inaSection];
  corpus.historicalIna = { schemaVersion: data.schemaVersion, sections: data.sections.map(r => r.uscSection), sourceManifest: "sources/legal/historical-ina.json" };
  return corpus;
}
module.exports = { readHistoricalIna, parseHistoricalUnits, applyHistoricalIna };

// These identities were reviewed against the House disposition/amendment notes.
// A modern destination is informational; it never becomes the historical target.
function applyHistoricalReferences(corpus) {
  const sections = new Map(corpus.title8.sections.map(s => [s.section, s]));
  const targets = [null], targetIds = new Map();
  const register = target => {
    const key = JSON.stringify(target);
    if (!targetIds.has(key)) { targetIds.set(key, targets.length); targets.push(target); }
    return targetIds.get(key);
  };
  const currentUrl = section => `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8-section${section}&num=0&edition=prelim`;
  const availablePath = (section, path = []) => {
    if (!section?.historical) return false;
    if (!path.length || (section.runInPaths || []).some(p => p.join("/") === path.join("/"))) return true;
    let candidates = [{ children: section.body }];
    for (const token of path) {
      candidates = candidates.flatMap(parent => (parent.children || []).filter(node => node.label === token));
      if (!candidates.length) return false;
    }
    return true;
  };
  const numbered = (reference, source) => {
    if (!["usc", "ina"].includes(reference.family) || String(reference.targetTitle || 8) !== "8") return null;
    const number = String(reference.targetSection), path = reference.targetPath || [];
    if (number === "1105a") return { status: "repealed", heading: "Former INA §106 — Judicial review of orders of deportation and exclusion", message: "The former judicial-review provision was repealed by Public Law 104-208 in 1996, effective April 1, 1997 with transitional provisions. The Code number was reused in 2006 for a different provision concerning battered spouses. Historical target text is not included in this corpus.", url: currentUrl(number), historicalUrl: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-1995-title8-section1105a&num=0&edition=1995", destination: { citation: "Current judicial-review provision: 8 U.S.C. 1252", url: currentUrl("1252") } };
    if (number === "1252") return { status: "replaced", heading: "Former INA §242 — Apprehension and deportation of aliens", message: "The former deportation provision was replaced by Public Law 104-208. Current 8 U.S.C. 1252 concerns judicial review and is a different provision. The historical target text is not included in this corpus.", url: currentUrl(number), historicalUrl: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-1995-title8-section1252&num=0&edition=1995" };
    if (number === "1251") return { status: "transferred", heading: "Former INA §241 — Deportable aliens", message: "The deportability provision was transferred to INA §237 (8 U.S.C. 1227). This link preserves its historical location and subsection identity; the historical target text is not included in this corpus.", url: currentUrl(number), destination: { citation: "INA 237 / 8 U.S.C. 1227", url: currentUrl("1227") } };
    if (number === "1253" && source.section === "1252a") return { status: "replaced", heading: "Former INA §243 — Countries to which aliens shall be deported", message: "The former destination-of-deportation provision was replaced by IIRIRA. Current 8 U.S.C. 1253 concerns penalties. Historical target text is not included in this corpus.", url: currentUrl(number), historicalUrl: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-1995-title8-section1253&num=0&edition=1995" };
    if (number === "1450" && source.section === "1459") return { status: "replaced", heading: "Former INA §339 — Functions and duties of clerks", message: "The court-clerk provisions cited here were replaced by Public Law 101-649 §407(c). Today's subsection lettering does not identify the former provisions. Historical target text is not included in this corpus.", url: currentUrl(number) };
    const target = sections.get(number);
    if (target?.historical && ["repealed", "transferred"].includes(target.status)) return { status: target.status, heading: target.historical?.originalTitle || `Former 8 U.S.C. ${number}`, message: (target.status === "transferred" ? "Transferred—not current at this location." : "Repealed—not current law.") + (!availablePath(target, path) ? " The cited historical target text is not available in the imported final version." : ""), url: target.url, available: availablePath(target, path) };
    return null;
  };
  for (const section of corpus.title8.sections.filter(s => s.historical)) {
    const visit = (node, fields) => {
      for (const field of fields) {
        if (!node[field]) continue;
        const property = field === "text" ? "references" : `${field}References`;
        const refs = node[property] ||= [];
        for (const correction of section.historical.referenceCorrections || []) {
          if (correction.field !== field || correction.path.join("/") !== (node.path || []).join("/")) continue;
          const start = node[field].indexOf(correction.phrase), end = start + correction.phrase.length;
          if (start < 0 || node[field].indexOf(correction.phrase, start + 1) >= 0) throw new Error(`Historical reference correction is not unique: ${correction.phrase}`);
          for (let i = refs.length - 1; i >= 0; i--) if (refs[i].start < end && refs[i].end > start) refs.splice(i, 1);
          let cursor = start;
          for (const citation of correction.citations) {
            const at = node[field].indexOf(citation.text, cursor);
            if (at < cursor || at + citation.text.length > end) throw new Error(`Historical reference span mismatch: ${citation.text}`);
            refs.push({ start: at, end: at + citation.text.length, text: citation.text, family: "usc", targetKind: "usc", targetTitle: citation.title, targetSection: citation.section, targetPath: citation.path, resolution: citation.title === "8" ? "local" : "official-source-only", ruleId: "historical-reviewed-reference" });
            cursor = at + citation.text.length;
          }
        }
        // Named historical acts have independent identities, including when a
        // modern number happens to match their former Code classification.
        for (const match of node[field].matchAll(/(?:(?:subsections\s+\(b\)\s+and\s+\(c\)\s+of\s+)?section\s+(404|406)(?:\([a-z]\))?\s+of\s+the\s+)?Nationality Act of 1940|Classification Act of 1949/g)) {
          const nationality = match[0].includes("Nationality");
          const target = nationality
            ? { status: "repealed", heading: match[0], message: "The Nationality Act of 1940 provisions were repealed by INA §403(a)(42) in 1952. This is the historical Act, not a current INA section with the same number. Historical target text is not included in this corpus.", url: "https://uscode.house.gov/statviewer.htm?volume=66&page=279" }
            : { status: "repealed", heading: "Classification Act of 1949", message: "The Classification Act of 1949 was repealed and recodified by Public Law 89-554 in 1966. Historical target text is not included in this corpus.", url: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title13-section23&num=0&edition=prelim" };
          const start = match.index, end = start + match[0].length;
          for (let i = refs.length - 1; i >= 0; i--) if (refs[i].start < end && refs[i].end > start) refs.splice(i, 1);
          refs.push({ start, end, text: match[0], family: "statutes-at-large", targetKind: "statutes-at-large", targetVolume: nationality ? "54" : "63", targetPage: nationality ? "1137" : "954", targetPath: match[1] ? [`section-${match[1]}`, ...[...match[0].matchAll(/\(([a-z])\)/g)].map(m => m[1])] : [], resolution: "official-source-only", ruleId: "historical-reviewed-reference", historicalTargetId: register(target) });
        }
        for (const ref of refs) {
          if (ref.historicalTargetId) continue;
          const target = numbered(ref, section);
          if (target) {
            ref.historicalTargetId = register(target);
            if (!target.available) ref.resolution = "official-source-only";
          }
        }
        refs.sort((a,b) => a.start-b.start);
      }
      for (const child of node.children || []) visit(child, ["heading", "text", "continuation"]);
    };
    visit(section, ["preamble"]);
    for (const node of section.body || []) visit(node, ["heading", "text", "continuation"]);
  }
  // Existing House references were captured before historical bodies were
  // imported. Upgrade only citations whose exact target is now locally present.
  const upgrade = object => {
    if (!object || typeof object !== "object") return;
    if (["usc", "ina"].includes(object.family) && String(object.targetTitle || 8) === "8" && !object.historicalTargetId && availablePath(sections.get(String(object.targetSection)), object.targetPath || [])) object.resolution = "local";
    for (const child of Object.values(object)) if (child && typeof child === "object") upgrade(child);
  };
  upgrade(corpus);
  const references = [];
  const collect = object => {
    if (!object || typeof object !== "object") return;
    if (Number.isInteger(object.start) && Number.isInteger(object.end) && object.resolution && object.ruleId) references.push(object);
    for (const value of Object.values(object)) if (value && typeof value === "object") collect(value);
  };
  collect(corpus);
  const evidence = corpus.legalReferenceEvidence?.records;
  if (evidence) {
    const used = [...new Set(references.filter(r => Number.isInteger(r.evidenceId)).map(r => r.evidenceId))].sort((a,b) => a-b);
    const ids = new Map(used.map((id,index) => [id,index]));
    corpus.legalReferenceEvidence.records = used.map(id => evidence[id]);
    for (const reference of references) if (Number.isInteger(reference.evidenceId)) reference.evidenceId = ids.get(reference.evidenceId);
    corpus.legalReferenceMetadata.embeddedResolvedReferences = used.length;
  }
  corpus.legalReferenceMetadata.historicalReviewedReferences = references.filter(r => r.ruleId === "historical-reviewed-reference").length;
  corpus.legalReferenceMetadata.rules.push("historical-reviewed-reference");
  corpus.historicalReferenceTargets = targets;
  return corpus;
}
module.exports.applyHistoricalReferences = applyHistoricalReferences;
