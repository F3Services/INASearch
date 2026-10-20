#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hierarchy = require("../src/INASearch-CFR-Hierarchy");
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../sources/legal/cfr-hierarchy/download-fixtures.json"), "utf8")).fixtures;
const records = new Map(fixtures.flatMap(fixture => fixture.normalized).map(record => [record.id, structuredClone(record)]));

for (const record of records.values()) {
  const originalText = hierarchy.flatten(record.blocks).map(row => row.block.x || "");
  hierarchy.reconcile(record);
  assert.deepStrictEqual(hierarchy.flatten(record.blocks).map(row => row.block.x || ""), originalText, `${record.id}: reconciliation changed source text`);
}

const fee = records.get("8:106.3");
assert.deepStrictEqual(fee.blocks[20].u, [
  { a: "(a)(3)(i)(M)", s: 0, e: 3 },
  { a: "(a)(3)(ii)", s: 99, e: 103 }
]);
assert.strictEqual(fee.blocks[21].a, "(a)(3)(ii)(A)");
assert.strictEqual(fee.blocks[28].a, "(a)(3)(ii)(H)");
const feeScope = hierarchy.scope(fee, "(a)(3)(ii)");
assert.strictEqual(feeScope[0].block.x.slice(feeScope[0].start).startsWith("(ii) The following form fees"), true);
assert.strictEqual(feeScope.length, 9);

const admission = records.get("8:214.1");
assert.deepStrictEqual(admission.blocks[29].u.map(marker => marker.a), ["(b)", "(b)(1)"]);
assert.strictEqual(admission.blocks[30].a, "(b)(1)(i)");
assert.strictEqual(admission.blocks[45].a, "(b)(3)(iv)");

const exchange = records.get("8:214.2");
const duplicates = hierarchy.index(exchange).byPath.get("(j)(1)(iv)");
assert.strictEqual(duplicates.length, 2);
assert(duplicates[0].row.block.x.startsWith("(iv) Extensions of Stay."));
assert(duplicates[1].row.block.x.startsWith("(iv) Extension of stay."));
assert.strictEqual(hierarchy.scope(exchange, "(j)(1)(iv)", duplicates[0].row.blockPath).length, 1);
assert.strictEqual(hierarchy.scope(exchange, "(j)(1)(iv)", duplicates[1].row.blockPath).length, 7);

const changedFee = structuredClone(fixtures.flatMap(fixture => fixture.normalized).find(record => record.id === "8:106.3"));
changedFee.blocks[20].x += " Changed source.";
assert.throws(() => hierarchy.reconcile(changedFee), /unreviewed repeated designation/, "Changed source text must not inherit the guarded correction");
console.log(`PASS CFR captured-source reconciliation: ${records.size} records, joined headings, source duplicates, unchanged text, and stale-guard rejection`);
