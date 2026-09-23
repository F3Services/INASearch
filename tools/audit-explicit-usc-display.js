#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { readArtifact } = require("./audit-inline-references");
const { runtime, plain } = require("./audit-ina-display");
const properties = { references: "text", continuationReferences: "continuation", headingReferences: "heading", preambleReferences: "preamble", sourceCreditReferences: "sourceCredit", xReferences: "x", authorityReferences: "authority", sourceReferences: "source" };
function fields(corpus) {
  const result = [], seen = new WeakSet();
  function visit(value, location, context = {}, sourceId = "") {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${location}[${i}]`, context, sourceId)); return; }
    if (value.id) sourceId = value.id;
    if (/^corpus\.title8\.sections\[\d+\]$/.test(location)) context = { kind: "usc", uscSection: value.section, sourceHost: { kind: "usc", title: 8, section: value.section } };
    if (/^corpus\.cfr\.(?:sections|appendices|parts)\[\d+\]$/.test(location)) context = { kind: "cfr", title: value.title, sourceHost: { kind: "cfr", title: value.title, section: value.section || value.part || value.id } };
    for (const [key, field] of Object.entries(properties)) if (value[key]?.length && typeof value[field] === "string") result.push({ key: `${location}.${field}`, sourceId, field, text: value[field], references: value[key], context });
    for (const [key, child] of Object.entries(value)) if (!properties[key]) visit(child, `${location}.${key}`, context, sourceId);
  }
  visit(corpus, "corpus");
  return result;
}
function links(html) {
  return [...html.matchAll(/<a\b([^>]*data-legal-reference[^>]*)>([\s\S]*?)<\/a>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], plain(m[2])]));
    return { text: plain(match[2]), source: attrs["data-reference-source-text"], family: attrs["data-reference-family"], title: attrs["data-reference-title"], section: attrs["data-reference-section"], path: attrs["data-reference-path"], ina: attrs["data-reference-ina-citation"], citation: attrs["data-reference-citation"], navigation: attrs["data-show-citation"] || attrs["data-show-cfr-citation"], url: attrs["data-reference-url"] };
  });
}
function audit(out, beforeTemplate = "audits/explicit-usc-ina/baseline/template.html", beforeArtifact = "audits/explicit-usc-ina/baseline/INASearch-Uncompressed.html", afterTemplate = "src/INASearch.template.html", afterArtifact = "INASearch-Uncompressed.html") {
  const beforeCorpus = readArtifact(beforeArtifact), afterCorpus = readArtifact(afterArtifact);
  const before = runtime(fs.readFileSync(beforeTemplate, "utf8"), beforeCorpus), after = runtime(fs.readFileSync(afterTemplate, "utf8"), afterCorpus);
  const oldFields = fields(beforeCorpus), newFields = fields(afterCorpus);
  assert.equal(oldFields.length, newFields.length);
  const changedFields = [], changes = [], unchanged = [];
  let evidenceOnlyFields = 0;
  // Evidence-table slots are repacked when reviewed corrections supersede an
  // inferred target. Their ordinal changes do not change a detected citation.
  const semanticReferences = references => JSON.stringify(references.map(({ id, evidenceId, ...reference }) => reference));
  for (let index = 0; index < oldFields.length; index++) {
    const old = oldFields[index], current = newFields[index];
    assert.equal(old.key, current.key); assert.equal(old.text, current.text);
    const oldHtml = before.linkifyStatutoryText(old.text, old.references, 0, undefined, null, [], old.context);
    const newHtml = after.linkifyStatutoryText(current.text, current.references, 0, undefined, null, [], current.context);
    const oldLinks = links(oldHtml), newLinks = links(newHtml);
    const oldText = plain(oldHtml), newText = plain(newHtml);
    if (oldText === newText && JSON.stringify(oldLinks) === JSON.stringify(newLinks) && semanticReferences(old.references) === semanticReferences(current.references)) {
      if (JSON.stringify(old.references) !== JSON.stringify(current.references)) evidenceOnlyFields++;
      unchanged.push(old.key); continue;
    }
    const id = `field-${String(changedFields.length + 1).padStart(5, "0")}`;
    const row = { id, key: old.key, sourceId: old.sourceId, context: old.context, original: old.text, before: oldText, after: newText, beforeReferences: old.references, afterReferences: current.references, beforeLinks: oldLinks, afterLinks: newLinks, changedReferenceIds: [] };
    // Rendering must preserve order. A changed link count is retained as review evidence.
    for (let i = 0; i < Math.max(oldLinks.length, newLinks.length); i++) if (JSON.stringify(oldLinks[i]) !== JSON.stringify(newLinks[i])) {
      const changeId = `reference-${String(changes.length + 1).padStart(5, "0")}`;
      changes.push({ id: changeId, fieldId: id, key: old.key, sourceId: old.sourceId, referenceIndex: i,
        beforeReference: old.references[i] || null, afterReference: current.references[i] || null,
        before: oldLinks[i] || null, after: newLinks[i] || null, original: old.text, beforeField: oldText, afterField: newText });
      row.changedReferenceIds.push(changeId);
    }
    if (semanticReferences(old.references) !== semanticReferences(current.references)) row.detectionChanged = true;
    changedFields.push(row);
  }
  fs.mkdirSync(out, { recursive: true });
  const write = (name, rows) => fs.writeFileSync(path.join(out, name), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  write("fields.jsonl", changedFields); write("references.jsonl", changes);
  for (let i = 0; i < 2; i++) write(`references-${i + 1}.jsonl`, changes.filter((_, n) => n % 2 === i));
  const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const summary = { fields: oldFields.length, references: oldFields.reduce((sum, field) => sum + field.references.length, 0), changedFields: changedFields.length, changedReferences: changes.length, proseOnlyFields: changedFields.filter(row => !row.changedReferenceIds.length).length, detectionChanged: changedFields.filter(row => row.detectionChanged).length, evidenceOnlyFields, beforeTemplate: sha(beforeTemplate), afterTemplate: sha(afterTemplate), beforeArtifact: sha(beforeArtifact), afterArtifact: sha(afterArtifact) };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.copyFileSync(afterTemplate, path.join(out, "template.html"));
  return summary;
}
if (require.main === module) console.log(audit(process.argv[2] || "audits/explicit-usc-ina/cycle-1", process.argv[3], process.argv[4], process.argv[5], process.argv[6]));
module.exports = { audit, fields, links };
