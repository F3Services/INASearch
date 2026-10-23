#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { compareCorpora } = require('./compare-reference-corpora');
function decodeArtifact(file, runtimeRoot = path.resolve(__dirname, '..')) {
  const root = fs.realpathSync(runtimeRoot), files = {}, seen = new Set();
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const readerPath = require.resolve(path.join(root, 'tools/read-build-corpus.js'));
  const packerPath = require.resolve(path.join(root, 'tools/pack-legal-references.js'));
  const reader = require(readerPath), packer = require(packerPath);
  const corpus = packer.unpackLegalReferences(reader.readBuildCorpus(file));
  const visit = module => {
    if (!module || seen.has(module.id)) return;
    seen.add(module.id);
    if (module.filename?.startsWith(root + path.sep)) files[path.relative(root,module.filename)] = hash(fs.readFileSync(module.filename));
    module.children.forEach(visit);
  };
  visit(require.cache[readerPath]); visit(require.cache[packerPath]);
  return { corpus, decoder: { root, files } };
}
function main(args) {
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const beforeFile = option('--before'), afterFile = option('--after'), output = option('--out');
  if (!beforeFile || !afterFile || !output) throw Error('Usage: node tools/audit-cfr-parser-diff.js --before BEFORE.html --after AFTER.html --out OUTPUT_DIRECTORY [--before-runtime FROZEN_RUNTIME_ROOT] [--after-runtime RUNTIME_ROOT]');
  const beforeDecoded = decodeArtifact(beforeFile, option('--before-runtime') || undefined);
  const afterDecoded = decodeArtifact(afterFile, option('--after-runtime') || undefined);
  const before = beforeDecoded.corpus, after = afterDecoded.corpus;
  const result = compareCorpora(before, after), dir = path.resolve(output);
  fs.mkdirSync(path.join(dir, 'field-contexts'), { recursive: true });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const fieldFiles = new Map();
  for (const [key, context] of result.fieldContexts) {
    const file = `field-contexts/${hash(key).slice(0, 20)}.json`;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(context) + '\n'); fieldFiles.set(key, file);
  }
  const currentFieldFiles = new Set(fieldFiles.values());
  for (const file of fs.readdirSync(path.join(dir, 'field-contexts'))) if (/^[a-f0-9]{20}\.json$/.test(file) && !currentFieldFiles.has(`field-contexts/${file}`)) fs.unlinkSync(path.join(dir, 'field-contexts', file));
  const rows = result.rows.map(row => ({ ...row, fieldContextFile: fieldFiles.get(row.referenceArrayPointer) }));
  const jsonl = (name, values) => fs.writeFileSync(path.join(dir, name), values.map(value => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''));
  jsonl('changes.jsonl', rows); jsonl('rule-id-only-changes.jsonl', result.ruleOnlyChanges); jsonl('source-changes.jsonl', result.sourceChanges); jsonl('configuration-changes.jsonl', result.configurationChanges);
  jsonl('historical-target-registry.jsonl', result.historicalTargetRegistry);
  jsonl('historical-target-changes.jsonl', result.historicalTargetChanges);
  jsonl('historical-target-reindexings.jsonl', result.historicalTargetReindexings);
  jsonl('historical-target-diagnostics.jsonl', result.historicalTargetDiagnostics);
  for (let i = 0; i < 3; i++) jsonl(`review-${i + 1}.jsonl`, rows.filter((_, index) => index % 3 === i));
  const summary = { ...result.summary, beforeSha256: hash(fs.readFileSync(beforeFile)), afterSha256: hash(fs.readFileSync(afterFile)), packedBefore: before.legalReferencePacking?.references, packedAfter: after.legalReferencePacking?.references, ignoredReferenceProperties: { parsedFamilyBearingRecordsOnly: ['id', 'evidenceId'], rawAndSupplementalRecords: [] }, ruleId: 'Compared separately; never hides changes to any other property.', historicalTargetScope: 'Every complete target record is compared by content with before/after IDs and all reference bindings. Reference identity dereferences historicalTargetId; reindexings are recorded separately, and missing target IDs fail integrity validation. Raw IDs and resolved targets remain in row and field evidence.', referenceScope: 'Every reference-property array, including raw records, supplemental markers, and derived fields.', sourceScope: 'Every string outside reference arrays, derived reference metadata (including the separately audited historical target registry), and separately recorded resolver configuration; unlinked fields included.' };
  summary.toolSha256 = Object.fromEntries(['audit-cfr-parser-diff.js', 'compare-reference-corpora.js', 'read-build-corpus.js', 'pack-legal-references.js', 'legal-references.js'].map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
  summary.decoders = { before: beforeDecoded.decoder, after: afterDecoded.decoder };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(summary);
  if (result.sourceChanges.length || result.historicalTargetDiagnostics.length) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { main, decodeArtifact };
