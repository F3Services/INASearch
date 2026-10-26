"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const engine = require("./legal-references");
const packing = require("./pack-legal-references");
const { createBrowserReferenceDecoder } = require("./browser-reference-decoder");
const functionSource = require("./test-function-source");
function assigned(file, property) {
  const scope = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve(`../src/${file}`), "utf8"), scope);
  return structuredClone(scope.window[property]);
}
const authored = assigned("INASearch-Corpus.js", "INA_SEARCH_CORPUS");
const cfr = assigned("INASearch-CFR.js", "INA_SEARCH_CFR");
const manifest = require("../sources/legal/embedded-reference-exceptions.json");
const exceptionFixture = manifest.exceptions[0];
for (const start of [exceptionFixture.start, exceptionFixture.end - 1]) {
  const overlapping = { ...exceptionFixture, id: "overlapping-source-span", start };
  assert.throws(() => engine.validateEmbeddedReferenceExceptions({ ...manifest, exceptions: [exceptionFixture, overlapping] }),
    /Overlapping embedded-reference exceptions/, "One source span cannot have conflicting reviewed interpretations");
}
for (const changes of [{ start: exceptionFixture.end, end: exceptionFixture.end + 1 }, { sourceId: "different-source" }, { sourceField: "different-field" }, { sourceTextSha256: "0".repeat(64) }]) {
  assert.doesNotThrow(() => engine.validateEmbeddedReferenceExceptions({ ...manifest, exceptions: [exceptionFixture, { ...exceptionFixture, id: "independent-source-span", ...changes }] }),
    "Adjacent spans and distinct source identities remain independent");
}
const ids = ["cfr-20:416.1619-0-former-ina-244a", "cfr-22:42.11-1-cell-136-2-ina-101-child",
  ...manifest.exceptions.filter(exception => exception.sourceId === "cfr-8:245.7-9").map(exception => exception.id)];
const source = {
  title8: { sections: authored.title8.sections.filter(section => ["1101", "1182"].includes(section.section)) },
  inaCrosswalk: authored.inaCrosswalk.filter(row => ["101", "212"].includes(row.inaSection)),
  cfr: { parts: cfr.parts.filter(part => ["8:214", "8:245", "20:416", "22:42"].includes(part.id)), sections: cfr.sections.filter(section => ["8:214.1", "8:245.7", "20:416.1619", "22:42.11"].includes(section.id)) },
  legalReferenceExceptions: { ...manifest, exceptions: manifest.exceptions.filter(exception => ids.includes(exception.id)) }
};
const corpus = engine.applyGeneratedLegalReferences(structuredClone(source));
const exclusionBlock = corpus.cfr.sections.find(section => section.id === "8:245.7").blocks[9];
for (const [start, targetPath] of [[140, ["a", "28", "F"]], [149, ["a", "32"]]]) {
  const references = exclusionBlock.xReferences.filter(reference => reference.start === start);
  assert.equal(references.length, 1, "A reviewed historical replacement must not retain a competing unresolved span");
  assert.deepEqual([references[0].resolution, references[0].targetEdition, references[0].targetPath], ["official-source-only", "1988", targetPath]);
}
const tpsBlock = corpus.cfr.sections.find(section => section.id === "20:416.1619").blocks[0];
const tps = tpsBlock.xReferences.find(reference => reference.text.includes("244A"));
assert.equal(tps?.resolution, "unresolved", "A historical INA locator with no verified destination must not open the current INA landing page");
assert.equal(tps.officialUrl, "");
assert.match(tps.citationNote, /historical|former/i);
const childCell = corpus.cfr.sections.find(section => section.id === "22:42.11").blocks[1].rows[136][2];
const child = childCell.xReferences.find(reference => reference.text === "INA 1101(b)(1)");
assert.deepEqual([child?.family, child?.targetTitle, child?.targetSection, child?.targetPath, child?.resolution], ["usc", "8", "1101", ["b", "1"], "local"]);
assert.match(child.citationNote, /prints INA 1101\(b\)\(1\).*INA 101\(b\)\(1\)/);
assert.equal(childCell.x, source.cfr.sections.find(section => section.id === "22:42.11").blocks[1].rows[136][2].x, "Correction notices must preserve the official printed source");
const browserDecode = createBrowserReferenceDecoder();
const currentCodeUrl = "https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title8-section1184";
const stableCodeUrl = "https://uscode.house.gov/us/usc/t8/s1184/";
const currentCode = { family: "usc", targetTitle: "8", targetSection: "1184", targetPath: ["l"], officialUrl: currentCodeUrl };
assert.equal(engine.normalizeOfficialDestination(currentCode).officialUrl, stableCodeUrl, "Current Code destinations use OLRC's published stable current-edition links");
assert.equal(engine.normalizeOfficialDestination({ ...currentCode, officialUrl: currentCodeUrl.replace("section1184", "section1440%E2%80%931") }).officialUrl,
  "https://uscode.house.gov/us/usc/t8/s1440-1/", "House routes use an ASCII hyphen for the printed typographic section dash");
const historicalCode = { ...currentCode, targetEdition: "1994", officialUrl: currentCodeUrl.replaceAll("prelim", "1994") };
assert.equal(engine.normalizeOfficialDestination(historicalCode).officialUrl, historicalCode.officialUrl, "Dated editions retain their historical destination");
for (const [officialUrl, expectedUrl, edition] of [[currentCodeUrl, stableCodeUrl, 0], [historicalCode.officialUrl, historicalCode.officialUrl, "1994"]]) {
  const target = ["u", 0, "8", "1184", ["l"], 0, 0, 0, 0, 0, 0, 0, 0, edition, 0, 0, 0, 0, officialUrl];
  assert.equal(browserDecode(target, "1184(l)").officialUrl, expectedUrl, "Browser hydration normalizes legacy current links while preserving historical editions");
}
const browser = vm.createContext({ INASEARCH_BROWSER: true });
for (const file of ["embedded-references.js", "legal-references.js"]) vm.runInContext(fs.readFileSync(require.resolve(`./${file}`), "utf8"), browser);
const definitionSource = {
  cfr: { parts: [{ id: "29:501", title: "29", part: "501" }], sections: [
    structuredClone(cfr.sections.find(section => section.id === "29:501.3")),
    { id: "29:501.99", title: "29", partId: "29:501", section: "501.99", blocks: [
      { t: "p", a: "(a)", x: "(a) Definitions." },
      { t: "p", d: 2, x: "Term. See paragraph (a) and paragraph (b) of this section." },
      { t: "p", d: 1, x: "See paragraph (a) of this section." },
      { t: "p", a: "(b)", x: "(b) Other requirements." }
    ] }
  ] }
};
const definitionBuild = engine.applyGeneratedLegalReferences(structuredClone(definitionSource));
const definitionRuntime = structuredClone(definitionSource);
browser.INASearchLegalReferences.applyCfrReferences(definitionRuntime, ["29:501"]);
for (const result of [definitionBuild, definitionRuntime]) {
  assert.equal(result.cfr.sections[0].blocks[3].xReferences.length, 0, "An unnumbered definition retains the enclosing paragraph for self-link suppression");
  const blocks = result.cfr.sections[1].blocks;
  assert.deepEqual(JSON.parse(JSON.stringify(blocks[1].xReferences.map(reference => reference.targetPath))), [["b"]], "Inherited suppression must retain a sibling reference");
  assert.deepEqual(JSON.parse(JSON.stringify(blocks[2].xReferences.map(reference => reference.targetPath))), [["a"]], "An outdented block must not inherit the previous paragraph's suppression scope");
}
const updated = structuredClone(corpus);
browser.INASearchLegalReferences.applyCfrReferences(updated, ["8:214", "8:245", "20:416", "22:42"]);
const classificationRows = value => value.cfr.sections.find(section => section.id === "8:214.1").blocks.find(block => block.t === "table").rows;
const classificationMeaning = value => JSON.parse(JSON.stringify(classificationRows(value), (key, field) => key === "id" ? undefined : field));
assert.deepEqual(classificationMeaning(updated), classificationMeaning(corpus), "Browser updates retain the same classification-table authority and administrative paths");
const b2 = classificationRows(corpus).find(row => row[0].x === "101(a)(15)(B)(ii)")[0].xReferences[0];
assert.deepEqual(b2?.targetPath, ["a", "15", "B"]);
assert.match(b2.citationNote, /administrative classification/);
for (const [sectionId, block, cell] of [["20:416.1619", 0, null], ["22:42.11", 1, [136, 2]], ["8:245.7", 9, null]]) {
  const field = value => {
    const record = value.cfr.sections.find(section => section.id === sectionId).blocks[block];
    return cell ? record.rows[cell[0]][cell[1]] : record;
  };
  const guards = value => field(value).xReferences.filter(reference => reference.ruleId === "embedded-exception").map(({ id, ...reference }) => reference);
  assert.deepEqual(JSON.parse(JSON.stringify(guards(updated))), JSON.parse(JSON.stringify(guards(corpus))), "Browser updates must preserve the same exact-source guards");
}
const treaty = { family: "instrument", targetKind: "instrument", targetTitle: "Hague Adoption Convention, Article", targetSection: "5", targetPath: ["c"],
  text: "article 5(c) of the Convention", resolution: "official-source-only", officialUrl: "https://www.hcch.net/en/instruments/conventions/full-text/?cid=69", citationNote: "The Convention of 29 May 1993 on Protection of Children and Co-operation in Respect of Intercountry Adoption." };
for (const reference of [tps, child, treaty]) {
  const encoded = { text: reference.text, references: [{ ...reference, start: 0, end: reference.text.length }] };
  const packed = packing.packLegalReferences({ fields: [encoded] });
  const decoded = browserDecode(packed.legalReferencePacking.legalTargets[0], reference.text);
  assert.deepEqual([decoded.family, decoded.targetTitle, decoded.targetSection, decoded.resolution, decoded.officialUrl, decoded.citationNote, decoded.targetPath], [reference.family, reference.targetTitle, reference.targetSection, reference.resolution, reference.officialUrl, reference.citationNote, reference.targetPath]);
}
for (const exception of source.legalReferenceExceptions.exceptions) {
  const altered = structuredClone(source);
  const current = altered.legalReferenceExceptions.exceptions.find(item => item.id === exception.id);
  current.sourceText += " Changed.";
  current.sourceTextSha256 = require("node:crypto").createHash("sha256").update(current.sourceText).digest("hex");
  assert.throws(() => engine.applyGeneratedLegalReferences(altered), /Stale embedded-reference exceptions/, "Exact-source exceptions must reject changed source text");
}
const runtime = vm.createContext({ Boolean });
vm.runInContext(functionSource(fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8"), "corpusRequiresEmbeddedUpgrade"), runtime);
const previous = structuredClone(corpus);
previous.legalReferenceMetadata.cfrHierarchyVersion = 21;
assert(runtime.corpusRequiresEmbeddedUpgrade(previous, { cfrHierarchyVersion: corpus.legalReferenceMetadata.cfrHierarchyVersion, uscHierarchyVersion: corpus.legalReferenceMetadata.uscHierarchyVersion }), "Saved revision-21 corpora must receive the corrected CFR paragraph references");
console.log("PASS exact-source reference guards: historical abstention, printed typo correction, delivery parity, stale-source rejection and cache invalidation");
