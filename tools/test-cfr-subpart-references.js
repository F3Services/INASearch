#!/usr/bin/env node
'use strict';
const assert=require('assert/strict');
const {readArtifact}=require('./audit-inline-references');
const {generatedReferences,legalReferenceContext}=require('./legal-references');
const corpus=readArtifact('INASearch-Uncompressed.html');
const shared=legalReferenceContext(corpus);
const context={...shared,kind:'cfr',title:'29',part:'501',section:'501.6',path:[],sourceId:'subpart-regression'};
function targets(text, ctx=context){return generatedReferences(text,ctx).map(r=>[r.text,r.family,String(r.targetTitle),r.targetSection,r.targetPath,r.resolution,r.officialUrl]);}
const refs=targets('8 U.S.C. 1188, 20 CFR part 655, subpart B, or this part.');
assert(refs.some(r=>r[0]==='20 CFR part 655, subpart B'&&r[2]==='20'&&r[3]==='655.B'&&r[5]==='local'&&r[6].endsWith('/part-655/subpart-B')));
assert(!refs.some(r=>r[1]==='usc'&&r[3]==='20'));
assert.deepEqual(targets('29 CFR part 501 or 503.').filter(r=>r[1]==='cfr').map(r=>r[3]),['501','503']);
assert.deepEqual(targets('20 CFR part 655, subpart A or B.').map(r=>r[3]),['655.A','655.B']);
assert.deepEqual(targets('20 CFR part 655, subparts F and G.').map(r=>r[3]),['655.F','655.G']);
assert.deepEqual(targets('this subpart and of 29 CFR part 501.').map(r=>r[3]),['501']);
assert.deepEqual(targets('subpart B of 20 CFR part 655.').map(r=>r[3]),['655.B']);
assert.deepEqual(targets('subpart B of this part.',{...context,title:'20',part:'655'}).map(r=>r[3]),['655.B']);
assert.deepEqual(targets('§§ 416.1202, 1205, 1234, 1236, and 1237.',{...context,title:'20',part:'416'}).map(r=>r[3]),['416.1202','416.1205','416.1234','416.1236','416.1237']);
assert.equal(targets('Restatement (Second) Contracts § 356; 22 Am.Jur.2d Damages §§ 683, 686, 690.').length,0);
const section=corpus.cfr.sections.find(r=>r.id==='29:501.6');
assert.equal(section.blocks.flatMap(b=>b.xReferences||[]).filter(r=>r.targetSection==='655.B'&&r.officialUrl.endsWith('/subpart-B')).length,2);
for(const part of corpus.cfr.parts)assert(corpus.cfr.titleNames[part.title],`No official name for Title ${part.title}`);
console.log('CFR part/subpart, authority boundaries, shorthand section lists, packed URLs, and title metadata passed.');
