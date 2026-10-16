#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const fn = require("./test-function-source"), { readArtifact } = require("./audit-inline-references");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
const corpus = readArtifact("INASearch-Uncompressed.html");
require("./pack-legal-references").unpackLegalReferences(corpus);
const api = require("./audit-ina-display").runtime(template, corpus);
Object.assign(api, { INASearchCfrHierarchy: require("../src/INASearch-CFR-Hierarchy"),
  hydrateLegalReferences: value => value,
  componentTokens: value => [...String(value || "").matchAll(/\(([^)]+)\)/g)].map(match => match[1]),
  legalAugmentationSlotHtml: () => "" });
for (const name of ["superscriptNumber", "legalFieldPlainText", "cfrBlockPlainText", "flattenedCfrBlocks", "cfrUnitText",
  "legalUnitCitationRows", "legalUnitPrintHtml", "linkifyCfrText", "renderCfrStyledRange", "cfrReferenceContext",
  "legalUnitTriggerHtml", "legalCitationSelectionAttributes", "renderCfrParagraphContents"]) vm.runInContext(fn(template, name), api);
const reg = number => corpus.cfr.sections.find(section => section.title === 8 && section.section === number);
const graphicSection = corpus.cfr.sections.find(section => section.title === 19 && section.section === "4.38");
assert.match(api.cfrUnitText(graphicSection), /\[Graphic: Official CFR graphic ec14no91\.167\.gif\]/,
  "Whole-section text must disclose a graphic just as scoped text does");
const headingCopy = api.cfrUnitText(reg("212.4"), [], null, "ina").split("\n")[0];
assert(headingCopy.includes("INA 212(d)(1)"), "Standardized whole-section output must convert citations in its heading");
const output = api.cfrUnitText(reg("212.4"), ["a", "1"]);
assert.match(output, /^  \(i\) The reasons/m, "CFR exports retain a child's relative hierarchy depth");
assert.match(output, /^If the alien desires/m, "CFR parent continuation returns to the parent depth");
const print = api.legalUnitPrintHtml({ kind: "cfr", text: output, citation: "8 CFR 212.4(a)(1)", heading: "Fixture" });
assert.match(print, /padding-inline-start:1\.5em"><strong>\(i\)<\/strong>/,
  "The shared printer preserves hierarchy supplied by the CFR adapter");
const reserved = reg("103.2");
assert.equal(api.cfrUnitText(reserved, ["c"]), api.cfrUnitText(reserved, ["d"]), "Reserved aliases keep one source range");
const repeated = reg("274a.2"), path = ["b", "1", "v", "B", "1", "vi"];
const occurrences = api.INASearchCfrHierarchy.index(repeated).byPath.get(api.canonicalPath(path));
assert.match(api.cfrUnitText(repeated, path, occurrences[1].row.blockPath), /Military dependent's identification card/);
assert.doesNotMatch(api.cfrUnitText(repeated, path, occurrences[1].row.blockPath), /U\.S\. military card/);
const block = { t: "p", a: "(a)(1)", x: "(1) Italic marker.", u: [{ a: "(a)(1)", s: 0, e: 3 }],
  r: [{ x: "(" }, { x: "1", s: "i" }, { x: ") Italic marker." }] };
const marker = api.renderCfrParagraphContents(block, [0], null, { id: "8:999.1", title: 8, section: "999.1" }, "8 CFR 999.1");
assert.match(marker, /<button[^>]+>[\s\S]*?\(<em>1<\/em>\)<\/button>/, "Clickable markers preserve the publisher's italic numeral");
console.log("PASS viewer output: graphics, heading conversion, hierarchy, continuations, aliases, occurrences and styled markers");
