#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const occurrence = require("../src/INASearch-Occurrence");
const query = require("../src/INASearch-Query");
const command = require("../src/INASearch-Command");
const annotations = require("../src/INASearch-Annotations");

const linkedText = "Consult section 16 and section 1101 and section 16.";
const ref = (title, section, start, end) => ({ family: "usc", targetTitle: String(title), targetSection: section, targetPath: [], start, end, resolution: "official-source-only" });
const corpus = {
  schemaVersion: 1, corpusVersion: "referenced-usc-search-fixture",
  title8: { sections: [{ id: "8-1101", section: "1101", heading: "INA source", body: [
    { label: "a", text: linkedText, references: [ref(18, "16", 8, 18), ref(18, "1101", 23, 35), ref(22, "16", 40, 50)] },
    { label: "b", text: "sharedneedle immigration prose" }
  ] }] },
  inaCrosswalk: [{ inaSection: "101", uscSection: "1101", localSection: "1101" }],
  referencedUsc: { schemaVersion: 1, titles: [
    { number: 18, name: "Crimes and Criminal Procedure", sections: [
      { id: "18-16", title: 18, section: "16", heading: "Crime of violence", preamble: "crimepreamble", body: [
        { label: "a", text: "sharedneedle force", children: [{ label: "1", text: "alphaneedle" }, { label: "2", text: "betaneedle" }] },
        { label: "b", text: "offenseneedle" }
      ], notes: [] },
      { id: "18-1101", title: 18, section: "1101", heading: "Separate criminal section", body: [{ label: "b", text: "sharedneedle immigration prose" }], notes: [] }
    ] },
    { number: 22, name: "Foreign Relations", sections: [{ id: "22-16", title: 22, section: "16", heading: "Foreign section", body: [{ label: "a", text: "sharedneedle diplomatic prose" }], notes: [] }] }
  ] },
  cfr: { sections: [{ id: "8:1.1", title: 8, section: "1.1", blocks: [{ t: "p", a: "(a)", x: "sharedneedle regulation prose" }] }], appendices: [] }
};
const rows = result => result.materializeOccurrences({ limit: 1000 }).rows;
const scope = (title, id, path = []) => ({ valid: true, family: "usc", title, sectionIds: new Set([id]), pathsBySection: new Map([[id, path]]) });
function scoped(projection, input, scopes = [], citationScopes = [], personal = {}) {
  const ast = command.parseCommand(input);
  assert.equal(ast.status, "valid", JSON.stringify(ast.errors));
  return query.search(projection, ast, { plan: { branches: [{ kind: "law", scopes }], citationScopes }, personal });
}

async function main() {
  const projection = occurrence.buildProjection(corpus);
  assert.deepEqual(rows(occurrence.search(projection, "offenseneedle")).map(row => [row.recordId, row.authority, row.citation, row.readerCommand]),
    [["18-16", "usc", "18 U.S.C. 16(b)", "18 U.S.C. 16(b)"]], "Referenced statute body must be searchable and navigate with its actual USC title.");
  assert.deepEqual(rows(occurrence.search(projection, "sharedneedle", { authorities: "usc" })).map(row => row.recordId),
    ["8-1101", "18-16", "18-1101", "22-16"], "USC search must include mapped INA and added USC while excluding CFR.");
  assert.deepEqual(rows(occurrence.search(projection, "sharedneedle", { authorities: "ina" })).map(row => row.citation), ["INA 101(b)"], "INA search must remain limited to mapped INA.");
  assert.deepEqual(rows(occurrence.search(projection, "sharedneedle", { authorities: "cfr" })).map(row => row.citation), ["8 CFR 1.1(a)"], "Existing CFR citations must be preserved.");
  for (const alias of ["USC", "statute", "statutes", "statutory"]) {
    assert.equal(occurrence.search(projection, command.parseCommand(`in:${alias} offenseneedle`)).totalOccurrences, 1, `The ${alias} scope must include referenced USC body text.`);
  }
  assert.equal(occurrence.search(projection, command.parseCommand("in:INA offenseneedle")).totalOccurrences, 0, "The INA command scope must exclude cross-title USC.");
  assert.equal(occurrence.search(projection, "alphaneedle betaneedle", { authorities: "usc" }).totalOccurrences, 0);
  assert.equal(occurrence.search(projection, "alphaneedle betaneedle", { authorities: "usc", common: { statute: "subsection" } }).totalOccurrences, 2, "Statutory Common levels must apply to external USC.");
  assert.deepEqual(rows(occurrence.search(projection, "sharedneedle", { scope: { system: "usc", title: 18, sections: ["16"] } })).map(row => row.recordId), ["18-16"], "A USC title scope must exclude identical section numbers in other titles.");
  assert.deepEqual(rows(occurrence.search(projection, "sharedneedle", { scope: { ina: { uscRanges: ["1101", "1101"] } } })).map(row => row.recordId), ["8-1101"], "Legacy INA USC-number ranges must remain limited to Title 8.");
  assert.deepEqual(rows(scoped(projection, "offenseneedle", [scope(18, "18-16", ["b"])] )).map(row => row.citation), ["18 U.S.C. 16(b)"], "Resolved USC citation scopes must match external statute fragments.");
  assert.equal(scoped(projection, "offenseneedle", [scope(18, "18-16", ["a"])]).totalOccurrences, 0, "A resolved subsection scope must remain a hard fence.");
  for (const [title, section, text] of [[18, "16", "section 16"], [18, "1101", "section 1101"], [22, "16", "section 16"]]) {
    const result = rows(scoped(projection, "", [], [[scope(title, `${title}-${section}`)]]));
    assert.equal(result.length, 1, `Cites search must identify the title-specific target ${title} USC ${section}.`);
    assert.equal(result[0].recordId, "8-1101");
    assert.equal(result[0].snippet.parts.filter(part => part.match).map(part => part.text).join(""), text);
    assert(!projection.fragments.find(fragment => fragment.recordId === "8-1101" && fragment.path.join("/") === "a").references.some(reference => reference.displayText), "A cross-title reference must never receive an INA display label by section-number collision.");
  }
  const personal = { notes: [{ associations: [{ family: "usc", title: 18, start: { unit: "1101", path: ["b"] } }] }] };
  assert.deepEqual(rows(scoped(projection, "sharedneedle has:notes", [], [], personal)).map(row => row.recordId), ["18-1101"], "Personal USC notes must not leak between titles sharing a section number.");
  const selectedText = "sharedneedle immigration prose";
  const highlighted = { highlights: [{ id: "h", segments: [{ id: "s", association: { family: "usc", title: 18, start: { unit: "1101", path: ["b"] } }, anchor: annotations.quoteAnchor(selectedText, 0, 12) }] }] };
  assert.deepEqual(rows(scoped(projection, "sharedneedle has:highlights", [], [], highlighted)).map(row => row.recordId), ["18-1101"], "Personal USC highlights must not leak between titles sharing a section number.");
  const asyncProjection = await occurrence.buildProjectionAsync(corpus, { sliceMs: 0, yieldControl: () => Promise.resolve() });
  assert.deepEqual(rows(occurrence.search(asyncProjection, "sharedneedle")).map(row => row.citation), ["INA 101(b)", "18 U.S.C. 16(a)", "18 U.S.C. 1101(b)", "22 U.S.C. 16(a)", "8 CFR 1.1(a)"], "Async projection must include each USC record once in the same order as sync projection.");
  assert.deepEqual(asyncProjection.fragments, projection.fragments, "Async and sync projection must produce identical statute fragments and source locations.");
  assert(occurrence.buildProjection(corpus, { authorities: "ina" }).fragments.every(fragment => fragment.authority === "ina"));
  assert(occurrence.buildProjection(corpus, { authorities: "usc" }).fragments.some(fragment => fragment.recordId === "18-16"));
  const hierarchyResult = occurrence.search(projection, "offenseneedle");
  assert(hierarchyResult.hierarchy.some(node => node.id === "usc:title:18" && node.totalOccurrences === 1), "USC hits must aggregate under their real USC title.");
  console.log("Referenced USC search, title scopes, citation targets, personal associations, and async parity passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
