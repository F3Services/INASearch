"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const occurrence = require("../src/INASearch-Occurrence");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");

const target = { family: "usc", targetTitle: "8", targetSection: "1151", targetPath: ["c"], resolution: "local", start: 4, end: 14, text: "INA 201(c)" };
const node = { label: "a", text: "See INA 201(c)", _lr: { t: "1,4,10,0" } };
const section = { section: "1153", body: [node] };
const block = { t: "p", x: node.text, _lr: { x: "1,4,10,0" } };
const regulation = { section: "999.1", blocks: [block] };
const corpus = { legalReferencePacking: { legalTargets: ["u|1|8|1151|c"] } };
const context = {
  corpus, sectionMap: new Map([["1153", section]]), cfrSectionMap: new Map([["8:9991", regulation]]),
  normCitationPart: value => String(value).replace(/[^a-z0-9]/gi, "").toLowerCase(),
  statuteNodeAtPath: () => node, INA_SEARCH_OCCURRENCE: occurrence
};
const details = vm.runInNewContext(`(${functionSource(template, "sourceRecordReferenceDetails")})`, context);
for (const [kind, unit, recordPath, field] of [["usc", "1153", ["a"], "text"], ["cfr", "999.1", [0], "x"]]) {
  const result = details({ sourceHost: { kind, title: 8, section: unit }, sourceRecord: { kind: kind === "usc" ? "node-text" : "cfr-unit", recordPath, field } });
  assert.deepEqual(JSON.parse(JSON.stringify(result.references)), [target], "A saved excerpt cannot resolve before its reader section is hydrated.");
}
assert(node._lr && !node.references && block._lr && !block.xReferences, "Resolving an excerpt eagerly expanded source references.");
console.log("PASS saved excerpts: packed INA/CFR references resolve without whole-section hydration");
