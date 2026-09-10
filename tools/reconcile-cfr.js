#!/usr/bin/env node
"use strict";
const fs = require("fs"), crypto = require("crypto");
const engine = require("../src/INASearch-CFR-Hierarchy");
const corpus = JSON.parse(fs.readFileSync(0, "utf8"));
const corrections = [];
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
for (const record of [...corpus.sections, ...corpus.appendices]) {
  const sourceSha256 = hash(engine.flatten(record.blocks).map(row => engine.evidence(row.block)));
  engine.reconcile(record, finding => corrections.push({ ...finding, sourceSha256, blockSha256: hash(finding.before) }));
}
corpus.structureRevision = engine.revision;
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify({ schemaVersion: 1, structureRevision: engine.revision, currentThrough: corpus.currentThrough, sources: corpus.sources, structureSources: corpus.structureSources, corrections }, null, 2) + "\n");
process.stdout.write(JSON.stringify(corpus));
