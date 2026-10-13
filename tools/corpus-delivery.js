"use strict";

// Preserve the full evidence in the canonical build input; the reader only
// needs the resolved citation targets and spans, not the resolver's audit.
function prepareDeliveryCorpus(source) {
  const corpus = structuredClone(source);
  delete corpus.legalReferenceAudit;
  delete corpus.legalReferenceEvidence;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value._lr) for (const [key, refs] of Object.entries(value._lr)) {
      const rows = typeof refs === "string" ? refs.split(";").map(row => row.split(",").map(Number)) : refs;
      const stripped = rows.map(row => Array.isArray(row) && row[0] === 1 ? row.slice(0, 4) : row);
      value._lr[key] = typeof refs === "string" ? stripped.map(row => row.join(",")).join(";") : stripped;
    }
    Object.values(value).forEach(visit);
  }
  visit(corpus);
  return corpus;
}

module.exports = { prepareDeliveryCorpus };
