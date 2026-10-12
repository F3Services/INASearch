"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "sources/legal/historical-usc.json");
const REVIEWED_MANIFESTS = [
  "sources/legal/historical-usc-reviewed.json",
  "sources/legal/historical-usc-reviewed-early.json",
  "sources/legal/historical-usc-reviewed-later.json",
  "sources/legal/historical-usc-reviewed-naturalization.json",
];
const { parseHistoricalUnits } = require("./historical-ina");

function readHistoricalUsc() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  for (const source of data.sources || []) {
    const bytes = fs.readFileSync(path.join(ROOT, source.file));
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== source.bytes || sha !== source.sha256) throw new Error(`Historical USC source checksum mismatch: ${source.file}`);
  }
  return data;
}

function readReviewedUsc() {
  const output = { sections: [], captures: [] };
  const seen = new Set();
  for (const manifest of REVIEWED_MANIFESTS) {
    const file = path.join(ROOT, manifest);
    if (!fs.existsSync(file)) continue;
    const reviewed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const capture of reviewed.captures || []) {
      const bytes = fs.readFileSync(path.join(ROOT, capture.file));
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== capture.bytes || sha !== capture.sha256) throw new Error(`Reviewed historical USC source checksum mismatch: ${capture.file}`);
      output.captures.push(capture);
    }
    for (const section of reviewed.sections || []) {
      if (seen.has(section.uscSection)) throw new Error(`Duplicate reviewed historical USC section: ${section.uscSection}`);
      seen.add(section.uscSection);
      const sha = crypto.createHash("sha256").update(JSON.stringify(section.units)).digest("hex");
      if (section.unitsSha256 && sha !== section.unitsSha256) throw new Error(`Reviewed historical USC transcription checksum mismatch: ${section.uscSection}`);
      output.sections.push(section);
    }
  }
  return output;
}

function applyHistoricalUsc(corpus, data = readHistoricalUsc(), reviewed = readReviewedUsc()) {
  corpus.corpusVersion = "2026.10.11-historical-usc.1";
  const groups = new Map(data.groups.map(group => [group.section, group]));
  const singles = new Map((data.singles || []).map(section => [section.section, section]));
  const reviewedByNumber = new Map((reviewed.sections || []).map(section => [section.uscSection, section]));
  const groupSources = [];
  const output = [];
  const existing = new Map(corpus.title8.sections.map(s => [s.section, s]));
  const enrich = (section, member, source) => {
    if (member.status) section.status = member.status;
    if (member.heading && !section.historical) section.heading = member.heading;
    if (member.headingSource) section.headingSource = member.headingSource;
    if (source && section !== source) section.houseHeading = source.heading;
    if (member.statusReason) section.statusReason = { ...member.statusReason, sourceUrl: member.statusReason.sourceUrl || source?.url || section.url };
    if (member.transferTargets?.length) section.transferTargets = member.transferTargets;
    else if (source?.transferTargets) section.transferTargets = source.transferTargets.filter(target => target.source === member.section);
    if (!section.transferTargets?.length) delete section.transferTargets;
    const record = reviewedByNumber.get(member.section);
    if (record && !section.historical) {
      const { units, ...metadata } = record;
      section.historical = metadata;
      section.heading = record.displayHeading || (record.originalTitle?.toLowerCase().startsWith("same;") ? member.heading : record.originalTitle) || member.heading;
      if (section.heading !== record.originalTitle && !section.historical.headingOrigin) {
        section.historical.headingOrigin = "editorial-contextualization";
        section.historical.headingEvidence = `Printed catchline: ${record.originalTitle}`;
      }
      Object.assign(section, parseHistoricalUnits(units));
    } else if (!section.historical && member.historical) {
      section.historical = member.historical;
      if (member.body?.length) section.body = member.body;
      if (member.preamble) section.preamble = member.preamble;
    }
    return section;
  };
  for (const source of corpus.title8.sections) {
    const group = groups.get(source.section);
    if (!group) {
      const member = singles.get(source.section);
      output.push(member ? enrich(source, member) : source);
      continue;
    }
    groupSources.push(structuredClone(source));
    if (!group.members?.length) throw new Error(`Historical USC group has no evidenced members: ${group.section}`);
    for (const member of group.members) {
      const reviewed = existing.get(member.section);
      if (reviewed && reviewed !== source) {
        enrich(reviewed, member, source);
        continue;
      }
      const section = structuredClone(source);
      section.id = `8-${member.section}`;
      section.section = member.section;
      section.identifier = `/us/usc/t8/s${member.section}`;
      section.combinedHouseRecord = source.id;
      section.houseHeading = source.heading;
      delete section.headingReferences;
      delete section.headingFootnoteReferences;
      const noteIds = new Set(member.noteIds || []);
      section.notes = (source.notes || []).filter(note => noteIds.has(note.id)).map((note, index) => ({ ...note, sourceNoteId: note.id, id: `${section.id}-note-${index + 1}` }));
      delete section.body;
      delete section.preamble;
      delete section.historical;
      output.push(enrich(section, member, source));
    }
  }
  const expected = new Set(groups.keys());
  for (const record of groupSources) expected.delete(record.section);
  if (expected.size) throw new Error(`Historical USC groups missing from corpus: ${[...expected].join(", ")}`);
  corpus.title8.sections = output;
  const historical = output.filter(s => s.status && s.status !== "current");
  corpus.historicalUsc = { schemaVersion: data.schemaVersion || 1, groupSources, sourceManifest: "sources/legal/historical-usc.json", reviewedSourceManifest: fs.existsSync(path.join(ROOT, REVIEWED_MANIFESTS[0])) ? REVIEWED_MANIFESTS[0] : null,
    additionalReviewedSourceManifests: REVIEWED_MANIFESTS.slice(1).filter(manifest => fs.existsSync(path.join(ROOT, manifest))),
    coverage: { ...data.coverage, deliveredSections: historical.length, withoutHistoricalText: historical.filter(s => !(s.body?.length || s.preamble)).map(s => s.section) } };
  return corpus;
}

module.exports = { readHistoricalUsc, readReviewedUsc, applyHistoricalUsc };
