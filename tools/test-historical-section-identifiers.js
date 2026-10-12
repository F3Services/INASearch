"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const functionSource = require("./test-function-source");

const source = fs.readFileSync(path.join(__dirname, "../src/INASearch-Startup.js"), "utf8");
const openingChunks = vm.runInNewContext(`(${functionSource(source, "openingChunks")})`, {
  INA_SEARCH_COMMAND: { scanCommandSegments: query => ({ segments: [{ text: query }] }) },
  Set, String, Number
});
const corpus = {
  title8: { sections: [
    { title: 8, section: "137–1" },
    { title: 8, section: "1371" },
    { title: 8, section: "5a–1" }
  ] },
  inaCrosswalk: []
};
const mapping = { usc: [11, 12, 13] };
for (const [query, expected] of [
  ["8 USC137–1", 11], ["8 USC137-1", 11],
  ["8 USC1371", 12], ["8 USC5a–1", 13], ["8 USC5a-1", 13]
]) {
  const chunks = openingChunks(corpus, mapping, query);
  assert(chunks?.includes(expected), `${query} omitted its section's startup chunk: ${chunks}`);
}
assert(!openingChunks(corpus, mapping, "8 USC1371").includes(11), "Current §1371 loaded former §137–1 as the same identifier");

console.log("PASS historical section identifiers: dashed former sections retain distinct startup chunks.");
