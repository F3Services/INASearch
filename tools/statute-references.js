"use strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function statuteNodeMap(corpus) {
  const map = new Map();
  const occurrences = new Map();
  function walk(section, nodes, path = []) {
    for (const node of nodes || []) {
      const nodePath = [...path, String(node.label)];
      const baseKey = `${section}:${nodePath.join("/")}`;
      const occurrence = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, occurrence);
      map.set(occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`, node);
      walk(section, node.children, nodePath);
    }
  }
  for (const section of corpus.title8?.sections || []) walk(String(section.section), section.body);
  return map;
}

function statuteSourceMap(corpus) {
  const map = statuteNodeMap(corpus);
  for (const section of corpus.title8?.sections || []) {
    const sectionNumber = String(section.section);
    (section.notes || []).forEach((note, index) => map.set(`${sectionNumber}:note:${index + 1}`, note));
    (section.houseEditorialFootnotes || []).forEach(footnote => map.set(`${sectionNumber}:house-footnote:${footnote.xmlId}`, footnote));
    if (section.sourceCredit) map.set(`${sectionNumber}:source-credit`, section);
    map.set(`${sectionNumber}:preamble`, section);
  }
  return map;
}

function referenceProperty(field) {
  return field === "text" ? "references" : `${field}References`;
}

function legacySources(referenceSource) {
  return Object.entries(referenceSource.references || {}).map(([sourceKey, references]) => ({
    sourceKey,
    sourceField: sourceKey.endsWith(":source-credit") ? "sourceCredit" : sourceKey.endsWith(":preamble") ? "preamble" : "text",
    sourceKind: references[0]?.sourceKind || "other",
    references
  }));
}

function applyStatuteReferences(corpus, referenceSource) {
  const sources = statuteSourceMap(corpus);
  const sections = new Set((corpus.title8?.sections || []).map(section => String(section.section)));
  const nodes = statuteNodeMap(corpus);
  const records = Array.isArray(referenceSource.sources) ? referenceSource.sources : legacySources(referenceSource);
  let applied = 0;
  let local = 0;
  const unitTypeCounts = {};
  const unitTypeCodes = {
    subsection: 0,
    paragraph: 1,
    subparagraph: 2,
    clause: 3,
    subclause: 4,
    item: 5,
    subitem: 6,
    subsubitem: 7,
    level: 8
  };
  for (const [sourceKey, unitType] of Object.entries(referenceSource.unitTypes || {})) {
    const source = sources.get(sourceKey);
    if (!source) throw new Error(`Statute unit type points to missing source ${sourceKey}.`);
    if (!Object.hasOwn(unitTypeCodes, unitType)) throw new Error(`Unknown House statute unit type ${unitType} at ${sourceKey}.`);
    const pathDepth = String(sourceKey.split(":")[1] || "").split("/").filter(Boolean).length - 1;
    const defaultCode = pathDepth >= 0 && pathDepth <= 8 ? pathDepth : 8;
    if (unitTypeCodes[unitType] !== defaultCode) source.u = unitTypeCodes[unitType];
    unitTypeCounts[unitType] = (unitTypeCounts[unitType] || 0) + 1;
  }
  for (const record of records) {
    const source = sources.get(record.sourceKey);
    if (!source || !Object.hasOwn(source, record.sourceField)) throw new Error(`Statute-reference source points to missing field ${record.sourceKey}.${record.sourceField}.`);
    const sourceText = String(source[record.sourceField] || "");
    let cursor = 0;
    const verified = record.references.map(reference => {
      const value = sourceText.slice(reference.start, reference.end);
      if (value !== reference.text) throw new Error(`Statute-reference text mismatch at ${record.sourceKey}.${record.sourceField}:${reference.start}-${reference.end}.`);
      if (reference.start < cursor) throw new Error(`Overlapping statute references at ${record.sourceKey}.${record.sourceField}.`);
      cursor = reference.end;
      const isLocal = reference.resolution === "local" || (!reference.resolution && sections.has(String(reference.targetSection)));
      if (isLocal) {
        if (!sections.has(String(reference.targetSection))) throw new Error(`Local statute-reference target section ${reference.targetSection} is not in Title 8.`);
        if ((reference.targetPath || []).length && !nodes.has(`${reference.targetSection}:${reference.targetPath.join("/")}`)) {
          throw new Error(`Local statute-reference target ${reference.targetSection}:${reference.targetPath.join("/")} does not exist.`);
        }
        local += 1;
      }
      return clone(reference);
    });
    source[referenceProperty(record.sourceField)] = verified;
    applied += verified.length;
  }
  const kinds = kind => records.filter(record => record.sourceKind === kind).length;
  corpus.title8.referenceMetadata = {
    schemaVersion: referenceSource.schemaVersion,
    sourceUrl: referenceSource.sourceUrl,
    sourceReleasePoint: referenceSource.sourceReleasePoint,
    capturedAt: referenceSource.capturedAt,
    generatedReferences: applied,
    localReferences: local,
    officialSourceOnlyReferences: records.flatMap(record => record.references).filter(reference => reference.resolution === "official-source-only").length,
    unresolvedReferences: records.flatMap(record => record.references).filter(reference => reference.resolution === "unresolved").length,
    sourcesWithReferences: records.length,
    nodesWithReferences: kinds("operative"),
    notesWithReferences: kinds("note"),
    houseFootnotesWithReferences: kinds("houseFootnote"),
    sourceCreditsWithReferences: kinds("sourceCredit"),
    preamblesWithReferences: kinds("preamble"),
    familyCounts: clone(referenceSource.extraction?.familyCounts || {}),
    unitTypes: Object.values(unitTypeCounts).reduce((sum, count) => sum + count, 0),
    unitTypeCounts: clone(unitTypeCounts)
  };
  return corpus;
}

module.exports = { applyStatuteReferences, referenceProperty, statuteNodeMap, statuteSourceMap };
