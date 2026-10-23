#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { compareCorpora } = require('./compare-reference-corpora');
const reference = { start: 0, end: 7, text: 'section', family: 'usc', targetTitle: '8', targetSection: '136', targetPath: [], resolution: 'local', officialUrl: 'https://example.test/136', houseHref: '/us/usc/t8/s136/', ruleId: 'old', id: 'old-id', evidenceId: 3 };
const before = { title8: { sections: [{ id: '8-136', text: 'section applies.', references: [reference], continuation: 'Unlinked source.' }] }, namedActs: [{ references: [{ houseIdentifier: '/us/act/1952-06-27', source: { supportingExcerpt: 'An Act.' } }, { houseIdentifier: '/us/act/1952-06-27', source: { supportingExcerpt: 'An Act.' } }] }] };
let after = structuredClone(before);
after.title8.sections[0].references[0].houseHref = '/us/usc/t8/s136';
let result = compareCorpora(before, after);
assert.equal(result.rows.length, 1, 'houseHref-only differences must be audited');
assert.equal(result.rows[0].before[0].houseHref, '/us/usc/t8/s136/');
assert.equal(result.rows[0].after[0].houseHref, '/us/usc/t8/s136');
for (const property of ['targetEdition', 'citationNote', 'historicalOfficialUrl', 'evidenceRecord', 'futureMetadata']) {
 after = structuredClone(before); after.title8.sections[0].references[0][property] = { value: 'changed' };
 assert.equal(compareCorpora(before, after).rows.length, 1, `Unlisted ${property} must be retained`);
}
after = structuredClone(before); Object.assign(after.title8.sections[0].references[0], { id: 'new', evidenceId: 7, ruleId: 'new' });
result = compareCorpora(before, after);
assert.equal(result.rows.length, 0); assert.equal(result.ruleOnlyChanges.length, 1);
after = structuredClone(before); after.namedActs[0].references.reverse();
assert.equal(compareCorpora(before, after).rows.length, 0, 'Raw evidence without spans uses multiset identity');
after.namedActs[0].references.pop();
result = compareCorpora(before, after);
assert.equal(result.rows.length, 1); assert.equal(result.rows[0].before.length, 1); assert.equal(result.rows[0].after.length, 0);
assert.equal(result.rows[0].start, null, 'Raw records must not be paired through undefined spans');
after = structuredClone(before); after.title8.sections[0].references.push(structuredClone(reference));
assert.equal(compareCorpora(before, after).rows[0].after.length, 1, 'Duplicate count changes cannot disappear in a Set');
after = structuredClone(before); after.title8.sections[0].continuation = 'Changed unlinked source.';
assert.equal(compareCorpora(before, after).sourceChanges.length, 1, 'Text without references must also be compared');
after = structuredClone(before); after.definitions = { entries: [{ x: 'section', xReferences: [{ ...reference, end: 7 }] }] };
assert.equal(compareCorpora(before, after).rows.length, 1, 'Traversal covers derived and unfamiliar domains');
const footnotes = { notes: [{ text: 'A note.', textFootnoteReferences: [{ id: 'note-a', xmlId: 'fn1', offset: 2 }] }] };
const changedFootnotes = structuredClone(footnotes); changedFootnotes.notes[0].textFootnoteReferences[0].id = 'note-b';
assert.equal(compareCorpora(footnotes, changedFootnotes).rows.length, 1, 'A supplemental footnote id is the target, not a generated reference identity');
after = structuredClone(before); after.legalReferenceExceptions = { exceptions: [{ target: { path: ['a'] } }] };
result = compareCorpora(before, after);
assert.equal(result.sourceChanges.length, 0); assert.equal(result.configurationChanges.length, 1, 'Resolver configuration changes are recorded separately from legal source text');
console.log('PASS complete reference diff: all metadata, raw records, duplicate counts, rule-only changes, and unlinked source text.');

const historicalTarget = { status: 'repealed', heading: 'Historical provision', message: 'Historical text.', url: 'https://example.test/historical', available: true, destination: { citation: 'Successor', url: 'https://example.test/successor' } };
const historicalBefore = structuredClone(before);
historicalBefore.historicalReferenceTargets = [null, historicalTarget, { ...structuredClone(historicalTarget), heading: 'Unused provision' }];
historicalBefore.title8.sections[0].references[0].historicalTargetId = 1;
after = structuredClone(historicalBefore);
after.historicalReferenceTargets = [null, after.historicalReferenceTargets[2], after.historicalReferenceTargets[1]];
after.title8.sections[0].references[0].historicalTargetId = 2;
result = compareCorpora(historicalBefore, after);
assert.equal(result.sourceChanges.length, 0, 'Derived target registry order is not legal source text');
assert.equal(result.rows.length, 0, 'Reindexed references still resolve to identical complete targets');
assert.equal(result.historicalTargetChanges.length, 0);
assert.equal(result.historicalTargetReindexings.length, 2, 'Index changes remain explicitly inspectable');
assert.equal(result.historicalTargetRegistry.find(entry => entry.target.heading === historicalTarget.heading).afterReferences.length, 1);
for (const change of [target => { target.url += '/changed'; }, target => { target.destination.url += '/changed'; }, target => { target.message += ' Changed.'; }, target => { target.available = false; }, target => { target.futureMetadata = { changed: true }; }]) {
 after = structuredClone(historicalBefore); change(after.historicalReferenceTargets[1]);
 result = compareCorpora(historicalBefore, after);
 assert.equal(result.sourceChanges.length, 0);
 assert.equal(result.rows.length, 1, 'Registry-only content changes must change the effective reference target');
 assert.equal(result.historicalTargetChanges.length, 2, 'Both old and new complete target identities must be recorded');
 assert.equal(result.rows[0].before[0].historicalTargetId, 1, 'Raw references remain intact');
 assert.equal(result.rows[0].beforeHistoricalTargets[0].target.url, historicalTarget.url);
 assert.deepEqual(result.rows[0].afterHistoricalTargets[0].target, after.historicalReferenceTargets[1]);
}
after = structuredClone(historicalBefore);
after.historicalReferenceTargets[1] = { ...historicalTarget, heading: 'Wrong destination' };
after.historicalReferenceTargets[2] = historicalTarget;
result = compareCorpora(historicalBefore, after);
assert.equal(result.rows.length, 1, 'Moving a target without updating the reference must not pass as reindexing');
after = structuredClone(historicalBefore); after.historicalReferenceTargets[2].message += ' Unused target changed.';
assert.equal(compareCorpora(historicalBefore, after).historicalTargetChanges.length, 2, 'Unreferenced registry targets are also compared');
after = structuredClone(historicalBefore); after.historicalReferenceTargets.pop();
assert.equal(compareCorpora(historicalBefore, after).historicalTargetChanges.length, 1, 'Pruned target content is retained in the audit');
after = structuredClone(historicalBefore); after.historicalReferenceTargets.push(structuredClone(historicalTarget));
assert.equal(compareCorpora(historicalBefore, after).historicalTargetChanges.length, 1, 'Duplicate target counts cannot disappear');
after = structuredClone(historicalBefore); after.historicalReferenceTargets[1] = null;
result = compareCorpora(historicalBefore, after);
assert.equal(result.rows.length, 1);
assert.equal(result.historicalTargetDiagnostics.length, 1);
assert.equal(result.historicalTargetDiagnostics[0].side, 'after');
assert.equal(result.rows[0].afterHistoricalTargets[0].status, 'missing');
result = compareCorpora(after, structuredClone(after));
assert.equal(result.historicalTargetDiagnostics.length, 2, 'Unchanged dangling IDs must still fail integrity validation');
after = structuredClone(historicalBefore); after.title8.sections[0].references[0].historicalTargetId = 999;
assert.equal(compareCorpora(historicalBefore, after).historicalTargetDiagnostics.length, 1, 'Out-of-range IDs are diagnosed');
after = structuredClone(historicalBefore); after.title8.sections[0].text += ' Real source change.';
assert.equal(compareCorpora(historicalBefore, after).sourceChanges.length, 1, 'Registry handling must not mask actual legal text edits');
console.log('PASS historical target diff: complete content, reindexing, raw bindings, unused targets, duplicate counts, and missing-ID diagnostics.');

// Equal packed bytes can have different delivered meaning under two runtimes.
// Keep both decoders independently selectable instead of normalizing the old
// artifact through the current implementation before comparison.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reference-decoders-'));
try {
 const legacy=path.join(temporary,'legacy');
 for(const file of ['tools/read-build-corpus.js','tools/pack-legal-references.js','tools/legal-references.js','tools/embedded-references.js','tools/statute-run-ins.js','src/INASearch-Corpus-Packing.js','src/INASearch-Corpus-Shards.js','src/INASearch-Occurrence.js','src/INASearch-USLM.js']) {
  fs.mkdirSync(path.dirname(path.join(legacy,file)),{recursive:true});fs.copyFileSync(path.join(__dirname,'..',file),path.join(legacy,file));
 }
 const legacyPacker=path.join(legacy,'tools/pack-legal-references.js');
 fs.writeFileSync(legacyPacker,fs.readFileSync(legacyPacker,'utf8').replace('if (preservedOfficialUrl !== undefined)','if (preservedOfficialUrl)'));
 const packed={title8:{sections:[{text:'8 U.S.C. 1254',references:[{start:0,end:13,text:'8 U.S.C. 1254',family:'usc',targetTitle:'8',targetSection:'1254',targetPath:[],resolution:'unresolved',officialUrl:'',ruleId:'explicit-usc'}]}]}};
 require('./pack-legal-references').packLegalReferences(packed);
 const payload=JSON.stringify(packed),artifact=path.join(temporary,'same.html');
 fs.writeFileSync(artifact,`<script id="inaSearchCorpusManifest">${JSON.stringify({compression:'none',uncompressedBytes:Buffer.byteLength(payload),uncompressedSha256:crypto.createHash('sha256').update(payload).digest('hex')})}</script><script id="inaSearchCorpusData">${payload}</script>`);
 const {decodeArtifact}=require('./audit-cfr-parser-diff');
 const old=decodeArtifact(artifact,legacy),current=decodeArtifact(artifact,path.resolve(__dirname,'..'));
 const delivery=compareCorpora(old.corpus,current.corpus);
 assert.equal(delivery.rows.length,1,'The artifact-specific runtime difference must remain in the audit even with identical packed input');
 assert.match(delivery.rows[0].before[0].officialUrl,/uscode.house.gov/);
 assert.equal(delivery.rows[0].after[0].officialUrl,'');
 assert.notEqual(old.decoder.files['tools/pack-legal-references.js'],current.decoder.files['tools/pack-legal-references.js']);
 assert.equal(delivery.sourceChanges.length,0);
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
console.log('PASS side-specific decoder comparison preserves changes in delivered meaning and binds dependency hashes.');
