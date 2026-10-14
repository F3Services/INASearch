"use strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function statuteFootnoteSourceMap(corpus) {
  const map = new Map();
  const occurrences = new Map();
  function walk(sectionNumber, nodes, path = []) {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const baseKey = `${sectionNumber}:${nodePath.join("/")}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      map.set(occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`, node);
      walk(sectionNumber, node.children, nodePath);
    }
  }
  for (const section of corpus.title8?.sections || []) {
    const sectionNumber = String(section.section);
    map.set(`${sectionNumber}:preamble`, section);
    walk(sectionNumber, section.body);
  }
  return map;
}

function normalizedHouseText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function reconstructFlattenedField(cleanText, references) {
  let output = String(cleanText || "");
  let displacement = 0;
  for (const reference of [...(references || [])].sort((a, b) => a.offset - b.offset)) {
    const insertion = `${reference.reconstructionPrefix || ""}${reference.flattenedInsertion || ""}${reference.reconstructionSuffix || ""}`;
    const offset = reference.offset + displacement;
    output = `${output.slice(0, offset)}${insertion}${output.slice(offset)}`;
    displacement += insertion.length;
  }
  return normalizedHouseText(output);
}

function applyStatuteFootnotes(corpus, footnoteSource) {
  const expected = footnoteSource?.extraction;
  if (!expected || ![expected.footnotes, expected.references, expected.affectedFields].every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error("The House footnote overlay is incomplete; measured extraction counts are required.");
  }
  const sources = statuteFootnoteSourceMap(corpus);
  let cleanedFields = 0;
  let references = 0;
  for (const [sourceKey, fields] of Object.entries(footnoteSource.fields || {})) {
    const target = sources.get(sourceKey);
    if (!target) throw new Error(`House footnote source points to missing legal field ${sourceKey}.`);
    for (const [fieldName, field] of Object.entries(fields || {})) {
      if (!Object.hasOwn(target, fieldName)) throw new Error(`House footnote source points to missing ${fieldName} at ${sourceKey}.`);
      const current = normalizedHouseText(target[fieldName]);
      if (current !== field.flattenedText && current !== field.cleanText) {
        throw new Error(`House footnote source mismatch at ${sourceKey}.${fieldName}.`);
      }
      if (reconstructFlattenedField(field.cleanText, field.footnoteReferences) !== field.flattenedText) {
        throw new Error(`House footnote reconstruction failed at ${sourceKey}.${fieldName}.`);
      }
      target[fieldName] = field.cleanText;
      if (target.childTextOffsets && ["text", "preamble"].includes(fieldName)) {
        if (!Array.isArray(field.childTextOffsets) || field.childTextOffsets.length !== target.childTextOffsets.length) {
          throw new Error(`House footnote overlay is missing source order at ${sourceKey}.${fieldName}.`);
        }
        target.childTextOffsets = clone(field.childTextOffsets);
      }
      target[`${fieldName}FootnoteReferences`] = clone(field.footnoteReferences);
      cleanedFields += 1;
      references += field.footnoteReferences.length;
    }
  }
  const sections = new Map((corpus.title8?.sections || []).map(section => [String(section.section), section]));
  let footnotes = 0;
  for (const [sectionNumber, records] of Object.entries(footnoteSource.sections || {})) {
    const section = sections.get(String(sectionNumber));
    if (!section) throw new Error(`House footnote source points to missing section ${sectionNumber}.`);
    section.houseEditorialFootnotes = clone(records);
    footnotes += records.length;
  }
  for (const [sectionNumber, records] of Object.entries(footnoteSource.sectionNotes || {})) {
    const section = sections.get(sectionNumber);
    if (!section || section.notes?.length !== records.length) throw new Error(`House note structure mismatch at ${sectionNumber}.`);
    records.forEach((record, index) => {
      const note = section.notes[index];
      if (note.text !== record.text || note.heading !== record.heading) throw new Error(`House note text mismatch at ${note.id}.`);
      note.role = record.role;
      note.bodyStart = record.bodyStart;
      note.layout = clone(record.layout);
      note.headingLayout = clone(record.headingLayout || []);
      if (record.headingPresentation) note.headingPresentation = clone(record.headingPresentation);
      if (record.uslmReferences) note.uslmReferences = clone(record.uslmReferences);
    });
  }
  for (const [identifier, records] of Object.entries(footnoteSource.divisionNotes || {})) {
    const division = corpus.title8?.divisionNotes?.[identifier];
    if (!division || division.notes?.length !== records.length) throw new Error(`House division note structure mismatch at ${identifier}.`);
    records.forEach((record, index) => {
      const note = division.notes[index];
      if (note.text !== record.text || note.heading !== record.heading) throw new Error(`House division note text mismatch at ${note.id}.`);
      note.role = record.role;
      note.bodyStart = record.bodyStart;
      note.layout = clone(record.layout);
      note.headingLayout = clone(record.headingLayout || []);
      if (record.headingPresentation) note.headingPresentation = clone(record.headingPresentation);
      if (record.uslmReferences) note.uslmReferences = clone(record.uslmReferences);
    });
  }
  let presentationFields = 0;
  for (const [sourceKey, fields] of Object.entries(footnoteSource.presentationFields || {})) {
    const target = sources.get(sourceKey);
    if (!target) throw new Error(`House presentation points to missing legal field ${sourceKey}.`);
    for (const [fieldName, record] of Object.entries(fields || {})) {
      if (normalizedHouseText(target[fieldName]) !== record.text) throw new Error(`House presentation text mismatch at ${sourceKey}.${fieldName}.`);
      target[`${fieldName}Layout`] = clone(record.layout);
      if (record.presentation) target[`${fieldName}Presentation`] = clone(record.presentation);
      if (record.style) target[`${fieldName}Style`] = clone(record.style);
      presentationFields += 1;
    }
  }
  const headingKey = value => normalizedHouseText(value).normalize("NFKC").toLowerCase();
  const targets = new Map();
  for (const section of sections.values()) {
    for (const footnote of section.houseEditorialFootnotes || []) {
      const match = footnote.text.match(/^See (.+?) notes? below\.$/i);
      if (!match) continue;
      const matches = (section.notes || []).filter(note => note.role !== "crossHeading" && headingKey(note.heading) === headingKey(match[1]) && note.text.slice(note.bodyStart ?? 0).trim());
      // Never guess between duplicate headings or navigate to an empty note.
      if (matches.length !== 1) continue;
      footnote.targetNoteId = matches[0].id;
      footnote.targetNoteHeading = matches[0].heading;
      targets.set(footnote.id, { targetNoteId: matches[0].id, targetNoteHeading: matches[0].heading });
    }
  }
  for (const [sourceKey, fields] of Object.entries(footnoteSource.fields || {})) {
    const node = sources.get(sourceKey);
    for (const fieldName of Object.keys(fields)) {
      for (const reference of node[`${fieldName}FootnoteReferences`] || []) Object.assign(reference, targets.get(reference.id) || {});
    }
  }
  if (cleanedFields !== expected.affectedFields || references !== expected.references || footnotes !== expected.footnotes) {
    throw new Error(`House footnote application count mismatch (${footnotes} notes, ${references} references, ${cleanedFields} fields).`);
  }
  corpus.schemaVersion = Math.max(Number(corpus.schemaVersion) || 1, Number(footnoteSource.corpusSchemaVersion) || 3);
  corpus.title8.houseFootnoteMetadata = {
    schemaVersion: footnoteSource.schemaVersion,
    noteLayoutRevision: Object.keys(footnoteSource.sectionNotes || {}).length ? 2 : 0,
    presentationFields,
    sourceUrl: footnoteSource.sourceUrl,
    sourceReleasePoint: footnoteSource.sourceReleasePoint,
    capturedAt: footnoteSource.capturedAt,
    footnotes,
    references,
    affectedFields: cleanedFields,
    statement: "House editorial footnotes are publisher-supplied editorial content and are not operative statutory text."
  };
  return corpus;
}

module.exports = {
  applyStatuteFootnotes,
  normalizedHouseText,
  reconstructFlattenedField,
  statuteFootnoteSourceMap
};
