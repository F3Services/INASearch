'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert/strict');
const evidence = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'cycle12-evidence.json.gz'))));
const summary = JSON.parse(fs.readFileSync(path.join(__dirname, 'cycle12-summary.json')));
const seen = new Set();
for (let shard = 1; shard <= 3; shard++) {
  const reviews = JSON.parse(fs.readFileSync(path.join(__dirname, `cycle12-review-${shard}.json`)));
  for (const review of reviews) {
    assert(!seen.has(review.id), `Duplicate review ${review.id}`);
    seen.add(review.id);
    const change = evidence.changes.find(row => row.id === review.id);
    assert(change, `Stale review ${review.id}`);
    assert.equal(review.sourceId, change.sourceId);
    assert.equal(review.referenceText, change.reference.text);
    assert.equal(review.afterContext || null, change.afterContext);
    assert.equal(review.verdict, 'pass', `Unresolved flag ${review.id}`);
    assert(review.rationale.length > 40);
  }
}
assert.equal(seen.size, evidence.changes.length);
assert.equal(seen.size, summary.referencesChanged);
const proseEvidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'cycle12-prose-only-evidence.json')));
const proseReview = JSON.parse(fs.readFileSync(path.join(__dirname, 'cycle12-prose-only-review.json')));
assert.equal(proseReview.length, proseEvidence.length);
assert.equal(new Set(proseReview.map(row => row.id)).size, proseEvidence.length);
let supplementalReferences = 0;
for (const field of proseEvidence) {
  const review = proseReview.find(row => row.id === field.id);
  assert.equal(review.sourcePath, field.sourcePath);
  assert.equal(review.afterText, field.after);
  assert.equal(review.verdict, 'pass');
  assert.equal(review.references.length, field.references.length);
  assert.equal(new Set(review.references.map(row => row.start)).size, field.references.length);
  for (const reference of field.references) {
    const reviewed = review.references.find(row => row.start === reference.start);
    assert.equal(reviewed.text, reference.text);
    assert.equal(reviewed.verdict, 'pass');
    for (const [key,value] of Object.entries(reviewed.target)) assert.deepEqual(reference[key], value);
    supplementalReferences++;
  }
}
const visibleFields = evidence.fields.filter(row => row.beforeField !== row.afterField);
assert.equal(visibleFields.length + proseEvidence.length, summary.fieldsChanged, 'Changed prose field missing from review');
const root = path.resolve(__dirname, '../../..');
for (const [file, key] of [['INASearch-Uncompressed.html', 'artifactSha256'], ['src/INASearch.template.html', 'templateSha256']]) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  assert.equal(hash, summary.current[key], `${file} changed after review`);
}
console.log(`PASS ${seen.size} unique changed reference reviews plus ${supplementalReferences} references in ${proseEvidence.length} prose-only fields; all ${summary.fieldsChanged} changed display fields covered; artifact and template hashes match.`);
