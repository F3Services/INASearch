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
    if (section.sourceCredit) map.set(`${sectionNumber}:source-credit`, section);
    if (section.preamble) map.set(`${sectionNumber}:preamble`, section);
  }
  return map;
}

function applyStatuteReferences(corpus, referenceSource) {
  const sources = statuteSourceMap(corpus);
  const sections = new Set((corpus.title8?.sections || []).map(section => String(section.section)));
  let applied = 0;
  for (const [key, references] of Object.entries(referenceSource.references || {})) {
    const source = sources.get(key);
    if (!source) throw new Error(`Statute-reference source points to missing text record ${key}.`);
    const sourceText = key.endsWith(":source-credit") ? source.sourceCredit : key.endsWith(":preamble") ? source.preamble : source.text;
    const verified = references.map(reference => {
      const value = String(sourceText || "").slice(reference.start, reference.end);
      if (value !== reference.text) throw new Error(`Statute-reference text mismatch at ${key}:${reference.start}-${reference.end}.`);
      if (!sections.has(String(reference.targetSection))) throw new Error(`Statute-reference target section ${reference.targetSection} is not in Title 8.`);
      return clone(reference);
    });
    if (verified.length) {
      if (key.endsWith(":source-credit")) source.sourceCreditReferences = verified;
      else if (key.endsWith(":preamble")) source.preambleReferences = verified;
      else source.references = verified;
      applied += verified.length;
    }
  }
  const sourceKeys = Object.keys(referenceSource.references || {});
  corpus.title8.referenceMetadata = {
    schemaVersion: referenceSource.schemaVersion,
    sourceUrl: referenceSource.sourceUrl,
    sourceReleasePoint: referenceSource.sourceReleasePoint,
    capturedAt: referenceSource.capturedAt,
    localReferences: applied,
    sourcesWithReferences: sourceKeys.length,
    nodesWithReferences: sourceKeys.filter(key => !key.includes(":note:") && !key.endsWith(":source-credit") && !key.endsWith(":preamble")).length,
    notesWithReferences: sourceKeys.filter(key => key.includes(":note:")).length,
    sourceCreditsWithReferences: sourceKeys.filter(key => key.endsWith(":source-credit")).length,
    preamblesWithReferences: sourceKeys.filter(key => key.endsWith(":preamble")).length
  };
  return corpus;
}

module.exports = { applyStatuteReferences, statuteNodeMap, statuteSourceMap };
