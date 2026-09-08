#!/usr/bin/env node
"use strict";
// Semantic regressions from the independent authority/table review. These
// assertions name legal destinations, rather than reproducing parser rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {readArtifact} = require('./audit-inline-references');
const engine = require('./legal-references');
const root = path.resolve(__dirname, '..');
const corpus = readArtifact(path.join(root, 'INASearch-Uncompressed.html'));
const shared = engine.legalReferenceContext(corpus);
const context = { ...shared, kind:'cfr', title:'22', part:'42', section:'42.11', path:[], sourceId:'authority-regression' };
const browser = {}; vm.createContext(browser);
for (const file of ['embedded-references.js','legal-references.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),browser);
const target = r => [r.family,r.targetTitle||r.targetCongress||r.targetVolume||'',r.targetSection||r.targetLaw||r.targetPage||'',r.targetPath||[]];
function check(text, expected, forbidden=[]) {
 const references=engine.generatedReferences(text,{...context,sourceText:text});
 const runtime=browser.INASearchLegalReferences.generatedReferences(text,{...context,sourceText:text});
 assert.deepEqual(JSON.parse(JSON.stringify(runtime.map(target))),references.map(target),'Browser/Node authority parity: '+text);
 for(const [surface,destination] of expected) assert(references.some(r=>r.text===surface&&JSON.stringify(target(r))===JSON.stringify(destination)),`Missing ${surface} -> ${JSON.stringify(destination)} in ${text}: ${JSON.stringify(references.map(r=>[r.text,target(r)]))}`);
 for(const family of forbidden) assert(!references.some(r=>r.family===family),`Wrong ${family} owner in ${text}`);
}
check('Section 101(e) of Public Law 100-202', [['101(e)',['public-law','100','202',['s101','e']]]],['ina']);
check('Sections 401(b), 411(b), 422(b) or 423(d) of Public Law 104-193.', ['401','411','422'].map(n=>[`${n}(b)`,['public-law','104','193',[`s${n}`,'b']]]).concat([['423(d)',['public-law','104','193',['s423','d']]]]),['ina']);
check('section 303(b)(3)(A) (ii) or (iii) of Div. C. of Pub. L. 104-208', [['303(b)(3)(A) (ii)',['public-law','104','208',['division-C','s303','b','3','A','ii']]],['(iii)',['public-law','104','208',['division-C','s303','b','3','A','iii']]]],['ina']);
check('section 501(c)(3) of the Internal Revenue Code of 1986; activities underlying section 501(c)(3)', [['501(c)(3)',['usc','26','501',['c','3']]],['section 501(c)(3)',['usc','26','501',['c','3']]]],['ina']);
check('section 202(a)(1)(B) of NACARA', [['202(a)(1)(B)',['public-law','105','100',['title-II','section-202','a','1','B']]]],['ina']);
check('section 501(e) of the Refugee Education Assistance Act of 1980', [['501(e)',['public-law','96','422',['s501','e']]]],['ina']);
check('Section 1059 of Public Law 109-163', [['1059',['public-law','109','163',['s1059']]]],['ina']);
check('Sec. 610 of the Appropriations Act (Pub. L. 102-395)', [['610',['public-law','102','395',['s610']]]],['ina']);
check('INA 201(b) & Section 2 of the Virgin Islands Nonimmigrant Alien Adjustment Act (Pub. L. 97-271)', [['2',['public-law','97','271',['s2']]]]);
check('INA 203(c) & 203(d)', [['203(d)',['ina','8','1153',['d']]]]);
check('section 564 of the Food, Drug, and Cosmetic Act, 21 U.S.C. 360bbb-3', [['564',['usc','21','360bbb-3',[]]]],['ina']);
check('section 319 of the Public Health Service Act, 42 U.S.C. 247d, or section 564 of the Food, Drug, and Cosmetic Act, 21 U.S.C. 360bbb-3', [['319',['usc','42','247d',[]]],['564',['usc','21','360bbb-3',[]]]],['ina']);
check('section 101(e) of an unrelated agreement', [], ['ina','usc']);
check('section 1324 of the National Flood Insurance Act of 1968, pursuant to section 1 of Public Law 109-64 (119 Stat. 1997, 42 U.S.C. 4031)', [['1324',['usc','42','4031',[]]],['1',['public-law','109','64',['s1']]]], ['ina']);
check('section 101(b)(1) of the Act of the alien who was eligible', [['section 101(b)(1) of the Act',['ina','8','1101',['b','1']]]]);

function visaRows(section) { return corpus.cfr.sections.find(s=>s.id===`22:${section}`).blocks.filter(b=>b.t==='table').flatMap(b=>b.rows).filter(r=>r.length===3&&!r[0].h); }
const rows41=visaRows('41.12'),rows42=visaRows('42.11');
function lawRow(rows,symbol,expected) {
 const row=rows.find(r=>r[0].x===symbol);assert(row,'Missing visa '+symbol);
 const refs=row.flatMap(c=>c.xReferences||[]);
 for(const [surface,destination]of expected) assert(refs.some(r=>r.text===surface&&JSON.stringify(target(r))===JSON.stringify(destination)),`${symbol}: ${surface} -> ${JSON.stringify(destination)}`);
}
lawRow(rows41,'C2',[['11.(3)',['statutes-at-large','61','758',['section-11','3']]],['(4)',['statutes-at-large','61','758',['section-11','4']]],['(5)',['statutes-at-large','61','758',['section-11','5']]]]);
for(const symbol of ['CW1','CW2','E2C']) lawRow(rows41,symbol,[['702(a)',['public-law','110','229',['s702','a']]], [`6(${symbol==='E2C'?'c':'d'})`,['public-law','94','241',['s6',symbol==='E2C'?'c':'d']]]]);
for(const symbol of ['AM1','AM2','AM3']) {
 // The source itself prints 100-102. Preserve that written public-law number;
 // the accompanying audit records that the intended law is 100-202.
 lawRow(rows42,symbol,[['101(e)',['public-law','100','102',['s101','e']]]]);
 const row=rows42.find(r=>r[0].x===symbol);assert(!row[2].xReferences.some(r=>r.family==='ina'));
}
for(const symbol of ['SI1','SI2','SI3']) lawRow(rows42,symbol,[['1059',['public-law','109','163',['s1059']]]]);
for(const symbol of ['SQ1','SQ2','SQ3']) lawRow(rows42,symbol,[['602(b)',['public-law','111','8',['division-F','title-VI','s602','b']]],['1244',['public-law','110','181',['s1244']]]]);
lawRow(rows42,'SP',[['421',['public-law','107','56',['s421']]]]);
for(const symbol of ['SR1','SR2','SR3']) lawRow(rows42,symbol,[['(III)',['ina','8','1101',['a','27','C','ii','III']]]]);
for(const symbol of ['DV2','DV3']) lawRow(rows42,symbol,[['203(d)',['ina','8','1153',['d']]]]);
for(const row of [...rows41,...rows42]) for(const cell of row) for(const ref of cell.xReferences||[]) assert.equal(cell.x.slice(ref.start,ref.end),ref.text,'Table span must preserve source text');
console.log(`PASS authority regressions, Node/browser parity, and both visa-table checks (${rows41.length+rows42.length} visa rows).`);

for (const id of ['8:208.13','8:208.16','8:1208.13','8:1208.16']) {
 const block=corpus.cfr.sections.find(s=>s.id===id).blocks.find(b=>b.x?.includes('section 319 of the Public Health Service Act, 42 U.S.C. 247d'));
 for (const [surface,destination] of [['319',['usc','42','247d',[]]],['564',['usc','21','360bbb-3',[]]]]) assert(block.xReferences.some(r=>r.text===surface&&JSON.stringify(target(r))===JSON.stringify(destination)),id+': '+surface+' must bind to its own Act and explicit Code codification');
}
