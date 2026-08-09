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
  if (!footnoteSource || Number(footnoteSource.extraction?.footnotes) !== 118 || Number(footnoteSource.extraction?.affectedFields) !== 116) {
    throw new Error("The House footnote overlay is incomplete; expected 118 footnotes across 116 fields.");
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
  if (cleanedFields !== 116 || references !== 118 || footnotes !== 118) {
    throw new Error(`House footnote application count mismatch (${footnotes} notes, ${references} references, ${cleanedFields} fields).`);
  }
  corpus.schemaVersion = Math.max(Number(corpus.schemaVersion) || 1, Number(footnoteSource.corpusSchemaVersion) || 3);
  corpus.title8.houseFootnoteMetadata = {
    schemaVersion: footnoteSource.schemaVersion,
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
