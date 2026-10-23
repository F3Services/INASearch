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
const ids = ["cfr-20:416.1619-0-former-ina-244a", "cfr-22:42.11-1-cell-136-2-ina-101-child"];
const source = {
  title8: { sections: [authored.title8.sections.find(section => section.section === "1101")] },
  inaCrosswalk: authored.inaCrosswalk.filter(row => row.inaSection === "101"),
  cfr: { parts: cfr.parts.filter(part => ["20:416", "22:42"].includes(part.id)), sections: cfr.sections.filter(section => ["20:416.1619", "22:42.11"].includes(section.id)) },
  legalReferenceExceptions: { ...manifest, exceptions: manifest.exceptions.filter(exception => ids.includes(exception.id)) }
};
const corpus = engine.applyGeneratedLegalReferences(structuredClone(source));
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
const browser = vm.createContext({ INASEARCH_BROWSER: true });
for (const file of ["embedded-references.js", "legal-references.js"]) vm.runInContext(fs.readFileSync(require.resolve(`./${file}`), "utf8"), browser);
const updated = structuredClone(corpus);
browser.INASearchLegalReferences.applyCfrReferences(updated, ["20:416", "22:42"]);
for (const [sectionId, block, cell] of [["20:416.1619", 0, null], ["22:42.11", 1, [136, 2]]]) {
  const field = value => {
    const record = value.cfr.sections.find(section => section.id === sectionId).blocks[block];
    return cell ? record.rows[cell[0]][cell[1]] : record;
  };
  const guards = value => field(value).xReferences.filter(reference => reference.ruleId === "embedded-exception").map(({ id, ...reference }) => reference);
  assert.deepEqual(JSON.parse(JSON.stringify(guards(updated))), JSON.parse(JSON.stringify(guards(corpus))), "Browser updates must preserve the same exact-source guards");
}
for (const reference of [tps, child]) {
  const encoded = { text: reference.text, references: [{ ...reference, start: 0, end: reference.text.length }] };
  const packed = packing.packLegalReferences({ fields: [encoded] });
  const decoded = browserDecode(packed.legalReferencePacking.legalTargets[0], reference.text);
  assert.deepEqual([decoded.resolution, decoded.officialUrl, decoded.citationNote, decoded.targetPath], [reference.resolution, reference.officialUrl, reference.citationNote, reference.targetPath]);
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
previous.legalReferenceMetadata.cfrHierarchyVersion = 20;
assert(runtime.corpusRequiresEmbeddedUpgrade(previous, { cfrHierarchyVersion: corpus.legalReferenceMetadata.cfrHierarchyVersion, uscHierarchyVersion: corpus.legalReferenceMetadata.uscHierarchyVersion }), "Saved revision-20 corpora must receive the corrected source guards");
console.log("PASS exact-source reference guards: historical abstention, printed typo correction, delivery parity, stale-source rejection and cache invalidation");
