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
function check(text, expected, forbidden=[], overrides={}) {
 const referenceContext={...context,...overrides,sourceText:text};
 const references=engine.generatedReferences(text,referenceContext);
 const runtime=browser.INASearchLegalReferences.generatedReferences(text,referenceContext);
 const meaning=r=>[target(r),r.resolution,r.officialUrl,r.citationNote||'',r.targetEdition||'',Boolean(r.targetNote)];
 assert.deepEqual(JSON.parse(JSON.stringify(runtime.map(meaning))),JSON.parse(JSON.stringify(references.map(meaning))),'Browser/Node authority parity: '+text);
 for(const [surface,destination] of expected) assert(references.some(r=>r.text===surface&&JSON.stringify(target(r))===JSON.stringify(destination)),`Missing ${surface} -> ${JSON.stringify(destination)} in ${text}: ${JSON.stringify(references.map(r=>[r.text,target(r)]))}`);
 for(const family of forbidden) assert(!references.some(r=>r.family===family),`Wrong ${family} owner in ${text}`);
 for(const reference of references) assert.equal(text.slice(reference.start,reference.end),reference.text,'Reference span must preserve source text');
 return references;
}
for (const source of ['Authority: 8 U.S.C. 1188(c)(4); 41 Op.A.G. 406 (1959).', 'Authority: 8 U.S.C. 1255; section 202, Public Law 105-100.', 'Authority: 8 U.S.C. 1103, 11f58.']) {
 const refs = check(source, [], [], {title:'8',sourceField:'authority'});
 assert(!refs.some(ref => ref.family === 'usc' && ['41','202','11f'].includes(ref.targetSection)), 'A new authority or malformed token cannot continue a USC list');
}
check('under INA(101)(a)(27) (A) or (B)', [['INA(101)(a)(27) (A)',['ina','8','1101',['a','27','A']]]]);
check('under section 313 INA', [['section 313 INA',['ina','8','1424',[]]]]);
check('INA sec. 274A(b)', [['INA sec. 274A(b)',['ina','8','1324a',['b']]]]);
assert(!check('IAA section 301(a) and INA section 204(d)(2)',[],[]).some(ref=>ref.family==='ina'&&ref.inaSection==='301'), 'IAA cannot inherit INA authority');
const rangeReferences = check('Authority: 8 U.S.C. 1185, 1731-32, 1440-1.', [
 ['1731',['usc','8','1731',[]]], ['32',['usc','8','1732',[]]], ['1440-1',['usc','8','1440-1',[]]]
],[],{title:'8',sourceField:'authority'});
assert(!rangeReferences.some(ref=>ref.officialUrl?.includes('s1731-32')), 'Range endpoints use actual section destinations');
check('section 101, paragraphs (a)(15)(A)(i), or (a)(15)(G)(ii) of the Immigration and Nationality Act', [
 ['section 101',['ina','8','1101',[]]], ['(a)(15)(A)(i)',['ina','8','1101',['a','15','A','i']]]
],[],{title:'8',chapter:'V',part:'1245',section:'1245.3'});
const historicalBare = check('section 212(a)(28)(I)(ii) in conjunction with section 249 of the Act',[
 ['section 212(a)(28)(I)(ii)',['ina','8','1182',['a','28','I','ii']]]
],[],{title:'8',chapter:'V',part:'1249',section:'1249.1'});
assert.equal(historicalBare[0].resolution,'unresolved','A missing historical path has a written label without a fabricated current destination');
assert(!check('The Mutual Educational and Cultural Exchange Act of 1961 (the “Act”). Section 102 of the Act, 22 U.S.C. 2452, and section 101(a)(15)(J) of the Immigration and Nationality Act.',[],[],{title:'22',part:'62',section:'62.1'}).some(ref=>ref.inaSection==='102'), 'A separate Act defined in the text cannot inherit an adjacent explicit INA citation');
check('Authority: 8 U.S.C. 1101, 11f58, 1182, 1184.', [
 ['1182',['usc','8','1182',[]]],['1184',['usc','8','1184',[]]]
],[],{title:'8',sourceField:'authority'});
for (const text of [
 'Authority: 8 U.S.C. 1255; section 202, Public Law 105-100, 111 Stat. 2160; section 902, Public Law 105-277.',
 'under section 101 or 104 of the Act of October 28, 1977',
 'Sections 103.38 through 103.41 comprise the regulations.'
]) assert(!check(text,[],[],{title:'8',chapter:'V',part:'1240',section:'1240.11',sourceField:'authority'}).some(ref=>ref.family==='ina'), 'A written Public Law, dated Act, or CFR decimal locator must not inherit INA authority');
const parallelIna = check('section 258 of the INA (8 U.S.C. 1288)',[],[],{title:'20',part:'655',section:'655.600'});
assert(!parallelIna.some(ref=>ref.text==='INA (8'||ref.inaSection==='8'), 'The opening parenthesis of a USC parallel is not a parenthesized INA section');
const redesignation = check('under section 242 or 242A (redesignated as section 238) of the Act (as in effect prior to April 1, 1997)', [], [], {title:'8',chapter:'V',part:'1245',section:'1245.22'});
assert.equal(redesignation.find(ref=>ref.text==='section 242')?.resolution,'unresolved', 'A historical date scopes the original coordinated list across a redesignation parenthesis');
assert.equal(redesignation.find(ref=>ref.text==='section 238')?.targetSection,'1228', 'The separately named redesignated provision retains its identity');
const classificationTableContext = {title:'8',chapter:'I',part:'214',section:'214.1',path:[],tableHeaders:['Section','Designation'],tableColumn:0};
check('Authority: 8 U.S.C. 1101 and note, 1102, 1103; 1182; 1440 and note, and 1440-1; 22 U.S.C. 2651a.', [
 ['1102',['usc','8','1102',[]]], ['1103',['usc','8','1103',[]]], ['1182',['usc','8','1182',[]]], ['1440-1',['usc','8','1440-1',[]]], ['22 U.S.C. 2651a',['usc','22','2651a',[]]]
], [], { title:'8', part:'212', section:'', sourceField:'authority' });
check('Authority: 8 U.S.C. 1185 (E.O. 13323, 69 FR 241), 1357; 48 U.S.C. 1806.', [
 ['1357',['usc','8','1357',[]]], ['48 U.S.C. 1806',['usc','48','1806',[]]]
], [], { title:'8', part:'215', section:'', sourceField:'authority' });
check('Section 212(a)(6) (tuberculosis). Apply section 212(a)(6) of the Act.', [
 ['Section 212(a)(6)',['ina','8','1182',['a','6']]]
], [], { title:'8', chapter:'V', part:'1212', section:'1212.7' });
check('section 212(a)(3)(A) (other than clause (ii)), (B), or (C) of the Act', [
 ['(B)',['ina','8','1182',['a','3','B']]], ['(C) of the Act',['ina','8','1182',['a','3','C']]]
], [], { title:'8', chapter:'V', part:'1235', section:'1235.8' });
check('section 203(1) of the Adult Education and Family Literacy Act',[
 ['203(1)',['usc','29','3272',['1']]]
]);
check('under the authority contained in section 412(a)(9), Immigration and Nationality Act (8 U.S.C. 1522(a)(9)).',[
 ['section 412(a)(9), Immigration and Nationality Act',['ina','8','1522',['a','9']]]
],[],{title:'45',part:'401',section:'401.12'});
check('if the arrival falls under subsection (i) or (ii).',[
 ['(i)',['cfr','8','235.1',['b','8','i']]], ['(ii)',['cfr','8','235.1',['b','8','ii']]]
],[],{title:'8',chapter:'I',part:'235',section:'235.1',path:['b','8']});
assert(!check('Section 101 of the Act states the rule in subsection (i) or (ii).',[],[],
 {title:'8',chapter:'I',part:'235',section:'235.1',path:['b','8']}).some(reference=>reference.family==='cfr'),
 'Nonstandard CFR subsection terminology does not override a preceding foreign authority');
check('the applicable fiscal year in (h)(8)(iii)(A)(4), and the other provisions',[
 ['(h)(8)(iii)(A)(4)',['cfr','8','214.2',['h','8','iii','A','4']]]
],[],{title:'8',chapter:'I',part:'214',section:'214.2',path:['h','8','v','B']});
assert(!check('the provision in (h)(8)(iii)(A)(4) of another Act applies.',[],[],
 {title:'8',chapter:'I',part:'214',section:'214.2',path:['h','8','v','B']}).some(reference=>reference.family==='cfr'),
 'A unit-noun omission does not override a written foreign owner');
assert(!check('An ordinary parenthetical (h)(8)(iii)(A)(4) follows.',[],[],
 {title:'8',chapter:'I',part:'214',section:'214.2',path:['h','8','v','B']}).some(reference=>reference.family==='cfr'),
 'A matching path alone does not turn a parenthetical into a reference');
assert(!check('Section 101(a) of the Act provides the rule in (h)(8)(iii)(A)(4).',[],[],
 {title:'8',chapter:'I',part:'214',section:'214.2',path:['h','8','v','B']}).some(reference=>reference.family==='cfr'),
 'An omitted unit noun cannot borrow the CFR section after a foreign authority anchor');
check('101(a)(15)(S) qualified family members',[
 ['101(a)(15)(S)',['ina','8','1101',['a','15','S']]]
],[],classificationTableContext);
check('nonimmigrant students at § 214.1, 214.2(f), and/or 214.2(m); change of classification',[
 ['§ 214.1',['cfr','8','214.1',[]]], ['214.2(f)',['cfr','8','214.2',['f']]], ['214.2(m)',['cfr','8','214.2',['m']]]
],[],{title:'8',chapter:'I',part:'214',section:'214.3'});
for(const [title,section,index] of [['8','214.2',1779],['8','214.2',1782],['22','41.57',1]]) {
 const block=corpus.cfr.sections.find(record=>record.id===`${title}:${section}`).blocks[index];
 const refs=check(block.x,[],[],{title,chapter:'I',part:section.split('.')[0],section,path:engine.pathTokens(block.a||'')});
 const cultural=refs.filter(reference=>reference.targetSection==='1101'&&reference.targetPath.slice(0,3).join('/')==='a/15/Q');
 assert(cultural.length,'The cultural-exchange citation remains linked');
 for(const reference of cultural) {assert.deepEqual(reference.targetPath,['a','15','Q'],'The continuing Q-1 provision no longer has an (i) designation');assert.match(reference.citationNote,/108-449/);}
}
for(const [section,route] of [['729','728'],['742','728'],['133','132'],['134','132'],['135','132'],['136','132'],
 ['9','1'],['10','1'],['137–3','132'],['145','137b'],['202','201'],['218','204c'],['226a','221'],['230','229'],
 ['338','331'],['381','351'],['409','351'],['459','451'],['724','701'],['726','725'],['809','801'],['902','901'],
 ['906','904'],['1005','1001'],['1485','1484']]) {
 const original={family:'usc',targetTitle:'8',targetSection:section,targetPath:['b'],officialUrl:`https://uscode.house.gov/us/usc/t8/s${section.replace(/[–—]/g,'-')}/`};
 const corrected=engine.normalizeOfficialDestination(original);
 assert.equal(corrected.officialUrl,`https://uscode.house.gov/us/usc/t8/s${route}/`,'Former section uses its verified grouped repeal page');
 assert.equal(corrected.targetSection,section,'A publisher route correction does not reclassify the legal target');
 assert.deepEqual(corrected.targetPath,['b']);
 assert.match(corrected.citationNote,/repeal history/);
 assert.deepEqual(engine.normalizeOfficialDestination(corrected),corrected,'Grouped-history normalization is idempotent');
 assert.deepEqual(JSON.parse(JSON.stringify(browser.INASearchLegalReferences.normalizeOfficialDestination(original))),corrected,'Browser/Node grouped-history destination parity');
 const archived={...original,targetEdition:'1946',historicalOfficialUrl:'https://example.test/archive',officialUrl:'https://example.test/archive'};
 assert.deepEqual(engine.normalizeOfficialDestination(archived),archived,'A verified historical edition is never replaced by a repeal-history page');
}
const headquartersSource=corpus.cfr.sections.find(section=>section.id==='22:46.7').blocks[0].x;
const headquartersRefs=check(headquartersSource,[
 ['11 (4)',['statutes-at-large','61','758',['section-11','4']]], ['11(5)',['statutes-at-large','61','758',['section-11','5']]]
]);
for(const reference of headquartersRefs.filter(reference=>reference.targetVolume==='61'&&reference.targetPage==='758'))
 assert.match(reference.officialUrl,/STATUTE-61-Pg756-2\.pdf#page=6$/,'The complete Headquarters Agreement archive contains section11');
check('a veteran (as defined in section 101, 1101, or 1301, or as described in section 107 of title 38) with a discharge',[
 ['section 101',['usc','38','101',[]]], ['1101',['usc','38','1101',[]]], ['1301',['usc','38','1301',[]]], ['section 107',['usc','38','107',[]]]
],[],{kind:'usc',title:'8',section:'1612'});
for (const [act,section,path,title,codeSection] of [
 ['Social Security Act','1614',['f'],'42','1382c'], ['Social Security Act','1616',['a'],'42','1382e'],
 ['Social Security Act','1633',['a'],'42','1383b'], ['Fair Labor Standards Act of 1938','3',['f'],'29','203'],
 ['FLSA','3',['m'],'29','203'], ['FLSA','7',['a'],'29','207'],
 ['Trafficking Victims Protection Act','107',['c','3'],'22','7105'], ['TVPA','107',['c'],'22','7105']
]) {
 const locator=section+path.map(token=>'('+token+')').join('');
 check(`section ${locator} of the ${act}`,[[locator,['usc',title,codeSection,path]]]);
}
const scopePolicySandbox={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'src/INASearch-Legal-Reference-Policy.js'),'utf8'),scopePolicySandbox);
const tvpaDefinition=corpus.cfr.sections.find(section=>section.id==='8:214.201').blocks[0].x;
const tvpaAmendment=check(tvpaDefinition,[['107(e)',['public-law','106','386',['division-A','s107','e']]]])
 .find(reference=>reference.text==='107(e)');
assert.match(tvpaAmendment.officialUrl,/PLAW-106publ386\.pdf#page=15$/,'TVPA amendatory subsection uses the original public law');
assert.match(tvpaAmendment.citationNote,/amendatory/);
check('Regulations means regulations in this subpart issued under sections 1102, 1631(c) and 1633(a) of the Act, unless otherwise indicated.',
 [['1633(a)',['usc','42','1383b',['a']]]],[],{title:'20',part:'416',section:'416.1002',legalReferencePolicy:scopePolicySandbox.window.INA_SEARCH_LEGAL_REFERENCE_POLICY});
check('satisfied the requirements of clause (1) or (2) of the first sentence of section 1440(a) of this title.',[
 ['(1)',['usc','8','1440',['a','1']]], ['(2)',['usc','8','1440',['a','2']]]
],[],{kind:'usc',title:'8',section:'1440–1',path:['c','1','B']});
const interruptedStatutoryGrounds = corpus.cfr.sections.find(section=>section.id==='8:245a.4').blocks[111].x;
assert(!check(interruptedStatutoryGrounds,[],[],{title:'8',part:'245a',section:'245a.4',path:['b','11','i']}).some(reference=>reference.family==='cfr'),
 'Semicolon-separated statutory grounds with explanatory parentheses must not be truncated into a local CFR paragraph guess');
const maintainedExceptions = new Map(JSON.parse(fs.readFileSync(path.join(root,'sources/legal/embedded-reference-exceptions.json'),'utf8')).exceptions.map(exception=>[exception.id,exception]));
const adultEducationSource=corpus.cfr.sections.find(section=>section.id==='8:214.3').blocks[22].x;
check(adultEducationSource,[['203(1)',['usc','29','3272',['1']]],['U.S.C. 3272(1)',['usc','29','3272',['1']]]],[],
 {title:'8',chapter:'I',part:'214',section:'214.3',sourceId:'cfr-8:214.3-22',sourceField:'x',embeddedExceptions:maintainedExceptions});
const absentLawSectionSource=corpus.title8.sections.find(section=>section.section==='1357').notes[2].text;
const absentLawSections=check(absentLawSectionSource,[],[],{kind:'usc',title:'8',section:'1357',sourceId:'usc-1357-note-3',sourceField:'text',sourceKind:'usc-note',sourceTopic:'amendments',embeddedExceptions:maintainedExceptions})
 .filter(reference=>reference.text==='section 726');
assert.equal(absentLawSections.length,2,'Both quoted nonexistent-law locators retain their source identity');
for(const reference of absentLawSections) {
 assert.equal(reference.family,'public-law'); assert.equal(reference.targetCongress,'109'); assert.equal(reference.targetLaw,'162');
 assert.equal(reference.resolution,'unresolved'); assert.equal(reference.officialUrl,'');
 assert.match(reference.citationNote,/does not contain/);
}
for(const [section,index,surface,destination] of [
 ['204.2',174,'201(b)',['usc','8','1151',['b']]],
 ['214.6',110,'(i)(1)',['cfr','8','214.6',['i','1']]],
 ['217.5',18,'8 U.S.C. 217(h)(3)(C)(iv)',['usc','8','1187',['h','3','C','iv']]]
]) {
 const source=corpus.cfr.sections.find(sectionRecord=>sectionRecord.id==='8:'+section).blocks[index].x;
 check(source,[[surface,destination]],[],{title:'8',chapter:'I',part:section.split('.')[0],section,sourceId:`cfr-8:${section}-${index}`,sourceField:'x',embeddedExceptions:maintainedExceptions});
}
for(const index of [5,9,12,13]) {
 const source=corpus.cfr.sections.find(section=>section.id==='8:214.7').blocks[index].x;
 const refs=check(source,[],[],{title:'8',chapter:'I',part:'214',section:'214.7',sourceId:`cfr-8:214.7-${index}`,sourceField:'x',embeddedExceptions:maintainedExceptions});
 const compacts=refs.filter(reference=>reference.targetTitle==='Compacts of Free Association (FSM, RMI, and Palau), §');
 assert.equal(compacts.length,index===9?2:1,'Every collective Compact citation retains all three instruments');
 for(const reference of compacts) {
  assert.equal(reference.targetSection,'141'); assert.deepEqual(reference.targetPath,['a']);
  assert.equal(reference.targetEdition,'2024');
  assert.match(reference.officialUrl,/USCODE-2024-title48-chap18\.pdf$/);
  assert.match(reference.citationNote,/1901.*1921.*1931/);
 }
}
const irishProgramSource=corpus.cfr.sections.find(section=>section.id==='8:1212.1').blocks[50].x;
const irishProgramRef=check(irishProgramSource,[['section 101(a)(15)(Q)(ii) of the Act',['usc','8','1101',['a','15','Q','ii']]]],[],
 {title:'8',chapter:'V',part:'1212',section:'1212.1',sourceId:'cfr-8:1212.1-50',sourceField:'x',embeddedExceptions:maintainedExceptions})
 .find(reference=>reference.text==='section 101(a)(15)(Q)(ii) of the Act');
assert.equal(irishProgramRef.targetEdition,'2007','The repealed Irish program remains distinct from the continuing Q cultural-exchange class');
for(const [section,index,surface,destination,edition] of [
 ['101.1',10,'section 8(a)(1) of the Act of March 24, 1934',['public-law','73','127',['s8','a','1']],'1934'],
 ['101.1',18,'section 4(a) 1924 Act',['public-law','68','139',['s4','a']],'1924'],
 ['204.6',80,'section 610(a) of the Appropriations Act',['public-law','102','395',['title-VI','s610','a']],'2020']
]) {
 const source=corpus.cfr.sections.find(record=>record.id==='8:'+section).blocks[index].x;
 const refs=check(source,[[surface,destination]],[],{title:'8',section,sourceId:`cfr-8:${section}-${index}`,sourceField:'x',embeddedExceptions:maintainedExceptions});
 const cited=refs.filter(reference=>reference.text===surface);
 assert.equal(cited.length,section==='101.1'&&index===18?2:1,'Every historical Act occurrence is retained');
 for(const reference of cited) assert.equal(reference.targetEdition,edition,'Historical instrument edition is explicit');
}
const facilitySource=corpus.cfr.sections.find(section=>section.id==='20:655.1102').blocks[42].x;
check(facilitySource,[['(2)',['instrument','20 CFR 655.1102, definition “Facility,” paragraph','2',[]]]],[],
 {title:'20',section:'655.1102',sourceId:'cfr-20:655.1102-42',sourceField:'x',embeddedExceptions:maintainedExceptions});
const militaryDerivativeSource=corpus.cfr.sections.find(section=>section.id==='8:204.9').blocks[11].x;
check(militaryDerivativeSource,[['section 103(a)(27)(K)',['usc','8','1101',['a','27','K']]]],[],
 {title:'8',part:'204',section:'204.9',sourceId:'cfr-8:204.9-11',sourceField:'x',embeddedExceptions:maintainedExceptions});
const legacyMedicalSource=corpus.cfr.sections.find(section=>section.id==='8:245a.4').blocks[107].x;
const legacyMedicalRefs=check(legacyMedicalSource,[],[],{title:'8',part:'245a',section:'245a.4',path:['b','9','i'],sourceId:'cfr-8:245a.4-107',sourceField:'x',embeddedExceptions:maintainedExceptions})
 .filter(reference=>reference.targetSection==='1182');
assert.equal(legacyMedicalRefs.length,6,'Five former medical grounds and their shared statutory container remain represented');
for(const reference of legacyMedicalRefs) assert.equal(reference.targetEdition,'1988','Legacy medical grounds must not navigate to same-number current grounds');
const priorViolations=corpus.cfr.sections.find(section=>section.id==='8:214.2').blocks[991].x;
const priorViolationRefs=check(priorViolations,[],[],{title:'8',part:'214',section:'214.2',path:['h','10','v','F'],sourceId:'cfr-8:214.2-991',sourceField:'x',embeddedExceptions:maintainedExceptions})
 .filter(reference=>reference.text==='(h)(10)(iv)(B)');
assert.equal(priorViolationRefs.length,2,'Both repeated stale violator cross-references must remain linked');
for(const reference of priorViolationRefs) assert.deepEqual(reference.targetPath,['h','10','v','B'],'Both occurrences follow the verified redesignation');
const formerTitle5Note = corpus.title8.sections.find(section=>section.section==='1553').notes[1].text;
check(formerTitle5Note,[['section 342b–1 of Title 5',['usc','8','1553',[]]]],[],
 {kind:'usc',title:'8',section:'1553',sourceKind:'usc-note',sourceId:'usc-1553-note-2',sourceField:'text',embeddedExceptions:maintainedExceptions});
for (const [noteIndex,surface,path,edition] of [
 [1,'Section 403–3 of title 50',[],'2002'],[3,'section 403–3(c)(7) of title 50',['c','7'],'2002'],[3,'section 403–3(c)(6) of title 50',['c','6'],'2000']
]) {
 const source=corpus.title8.sections.find(section=>section.section==='1721').notes[noteIndex].text;
 const refs=check(source,[[surface,['usc','50','403-3',path]]],[],{kind:'usc',title:'8',section:'1721',sourceKind:'usc-note',sourceId:`usc-1721-note-${noteIndex+1}`,sourceField:'text',embeddedExceptions:maintainedExceptions});
 assert.equal(refs.find(reference=>reference.text===surface).targetEdition,edition,'Repealed intelligence provisions retain the edition matching their quoted numbering');
}
for (const [section,index,surface,path] of [
 ['245a.4',111,'(14)',['a','14']], ['210.3',29,'(10)',['a','10']], ['245a.4',27,'212(a)(19)',['a','19']]
]) {
 const source=corpus.cfr.sections.find(record=>record.id==='8:'+section).blocks[index].x;
 const refs=check(source,[[surface,['usc','8','1182',path]]],[],{title:'8',section,sourceId:`cfr-8:${section}-${index}`,sourceField:'x',embeddedExceptions:maintainedExceptions});
 const historical=refs.find(reference=>reference.text===surface);
 assert.equal(historical.targetEdition,'1988','Legacy exclusion grounds retain their pre-1990 numbering and edition');
 assert(historical.officialUrl.includes('uscode1988-002008012.pdf#page='));
 assert.equal(historical.resolution,'official-source-only');
}
const traffickingDefinition = corpus.cfr.sections.find(section=>section.id==='8:214.201').blocks[0].x;
const traffickingChapter = check(traffickingDefinition,[],[],{title:'8',part:'214',section:'214.201',sourceId:'cfr-8:214.201-0',sourceField:'x',embeddedExceptions:maintainedExceptions}).find(reference=>reference.text==='18 U.S.C. 77');
assert.equal(traffickingChapter?.targetChapter,'77','The trafficking definition cites Chapter 77, not nonexistent section 77');
assert.equal(traffickingChapter.targetSection,undefined,'A corrected chapter target must not also carry a section number');
assert.equal(traffickingChapter.targetKind,'usc-hierarchy');
assert(traffickingChapter.officialUrl.endsWith('/t18/partI-chapter77-front.html'));
const recruitmentCriteria = corpus.cfr.sections.find(section=>section.id==='20:655.739').blocks[12].x;
check(recruitmentCriteria,[['(b) (1)',['cfr','20','655.739',['f','1']]],['(3)',['cfr','20','655.739',['f','3']]]],[],
 {title:'20',part:'655',section:'655.739',path:['f'],sourceId:'cfr-20:655.739-12',sourceField:'x',embeddedExceptions:maintainedExceptions});
const aggravatedFelonyNote = corpus.title8.sections.find(section=>section.section==='1101').notes[4].text;
const smugglingTypo = check(aggravatedFelonyNote,[],[],{kind:'usc',title:'8',section:'1101',sourceKind:'usc-note',sourceId:'usc-1101-note-5',sourceField:'text',embeddedExceptions:maintainedExceptions})
 .find(reference=>reference.text==='section 274(a)(1) of title 18');
assert.deepEqual(smugglingTypo && target(smugglingTypo),['usc','8','1324',['a','1']],'The quoted alien-smuggling locator belongs to INA 274, not Title 18');
assert(/printed.*18/.test(smugglingTypo.citationNote),'An incorrect printed authority must retain a correction notice');
check('An alien described in section 3(b) of the Presidential Proclamation of June 3, 2024, as defined in 8 CFR 208.13(h).', [
 ['section 3(b)',['instrument','Proclamation 10773 (as amended September 27, 2024), §','3',['b']]]
], [], {title:'8',part:'208',section:'208.35',path:['a','1']});
const agriculturalDefinition = 'An agricultural commodity in sec. 15(g) of the Agricultural Marketing Act, as amended, 12 U.S.C. 1141j; see also 12 U.S.C. 1141j(g).';
const commodityRefs = check(agriculturalDefinition,[['15(g)',['usc','12','1141j',['f']]],['12 U.S.C. 1141j',['usc','12','1141j',[]]],['12 U.S.C. 1141j(g)',['usc','12','1141j',['f']]]],[],
 {title:'29',part:'501',section:'501.3',path:['b','1','i','C']});
assert(commodityRefs.filter(reference=>reference.targetPath[0]==='f').every(reference=>/redesignated/.test(reference.citationNote)), 'Former AMA numbering must retain an explanatory notice');
check('12 U.S.C. 1141j(g)',[['12 U.S.C. 1141j(g)',['usc','12','1141j',['g']]]],[],{title:'29',part:'501',section:'501.3'});
for (const [surface,section,path] of [
 ['101(a)(15)(A)(i)','1101',['a','15','A','i']], ['212(d)(8)','1182',['d','8']],
 ['101(a)(15)(B)(ii)','1101',['a','15','B']], ['101(a)(15)(H)(i)(C)','1101',['a','15','H','i','c']],
 ['101(a)(15)(H)(iv)','1101',['a','15','H']], ['101(a)(15)(T)(iii)','1101',['a','15','T','ii']],
 ['101(a)(15)(Q)(i)','1101',['a','15','Q']]
]) check(surface,[[surface,['ina','8',section,path]]],[],classificationTableContext);
assert(!check('101(a)(15)(B)(ii)',[],[],{title:'8',section:'214.1'}).length,'Administrative classification inference requires its actual table column');
assert(!check('101(a)(15)(Q)(ii)',[],[],classificationTableContext).length,'The former Irish program must not map to the surviving current Q cultural-exchange provision');
for (const [clause,expectedPath] of [['ii',['a','15','Q','ii']],['iii',['a','15','Q','ii','II']]]) {
 const surface=`101(a)(15)(Q)(${clause})`;
 const rows=corpus.cfr.sections.find(section=>section.id==='8:214.1').blocks[12].rows;
 const row=rows.findIndex(row=>row[0].x===surface);
 const refs=check(surface,[[surface,['usc','8','1101',expectedPath]]],[],{...classificationTableContext,sourceId:`cfr-8:214.1-12-cell-${row}-0`,sourceField:'x',
  embeddedExceptions:new Map(JSON.parse(fs.readFileSync(path.join(root,'sources/legal/embedded-reference-exceptions.json'),'utf8')).exceptions.map(exception=>[exception.id,exception]))});
 assert(refs.some(reference=>reference.targetEdition==='2007'&&reference.resolution==='official-source-only'&&reference.officialUrl.includes('USCODE-2007')),
  'Irish program classes retain their historical edition and official archive');
}
check('Paragraphs (a)(1) thru (a)(6) and paragraphs (b) and (c) of this section also apply to the H-1B1 and E-3 visa categories.', [
 ['(a)(1)',['cfr','20','655.760',['a','1']]], ['(a)(6)',['cfr','20','655.760',['a','6']]]
], [], {title:'20',part:'655',section:'655.760',path:[]});
check('15 U.S.C. 80b–1 et seq.', [['15 U.S.C. 80b–1',['usc','15','80b-1',[]]]]);
check('Sections 78o–5(a)(1)(A) and 78q–1(b)(4)(A) of this title.', [
 ['78o–5(a)(1)(A)',['usc','15','78o-5',['a','1','A']]],
 ['78q–1(b)(4)(A)',['usc','15','78q-1',['b','4','A']]]
],[],{kind:'usc',title:'15',section:'78o'});
check('15 U.S.C. 80b–1, 80b–11 and 78q–1(b)', [['80b–11',['usc','15','80b-11',[]]],['78q–1(b)',['usc','15','78q-1',['b']]]]);
check('42 U.S.C. 2000e–5(a)', [['42 U.S.C. 2000e–5(a)',['usc','42','2000e-5',['a']]]]);
check('(See §§ 416.974(b)(6) (i) and (ii), and 416.975(a)).', [['(ii)',['cfr','20','416.974',['b','6','ii']]]],[],{title:'20'});
check('8 CFR 245a.3(b)(10) and/or (12)', [['(12)',['cfr','8','245a.3',['b','12']]]]);
check('33 CFR 101.105 and 101.514-515', [['101.514',['cfr','33','101.514',[]]],['515',['cfr','33','101.515',[]]]]);
check('8 CFR 274a.1-274a.11', [['8 CFR 274a.1',['cfr','8','274a.1',[]]],['274a.11',['cfr','8','274a.11',[]]]]);
check('28 CFR 45.735-7', [['28 CFR 45.735-7',['cfr','28','45.735-7',[]]]]);
for(const obsolete of ['8 CFR 3.2','8 CFR 1241.13','8 CFR 1212.5(b)']) {
 const refs=check(obsolete,[],[]);assert(refs.length);assert(refs.every(r=>r.resolution==='unresolved'),'A complete current-title inventory must not assert an absent section or paragraph');
}
check('26 CFR 1.414(b)-1(a), (c)-2 and (m)-5', [['(c)-2',['cfr','26','1.414(c)-2',[]]],['(m)-5',['cfr','26','1.414(m)-5',[]]]]);
check('29 U.S.C. 206(FLSA)', [['29 U.S.C. 206',['usc','29','206',[]]]]);
check('as defined in section 300gg–91 of this title', [['section 300gg–91',['usc','42','300gg-91',[]]]],[],{kind:'usc',title:'42',section:'1396a'});
check('paragraph (3) (other than subparagraph (E)) of section 1182(a)', [['(3)',['usc','8','1182',['a','3']]]],[],{kind:'usc',title:'8',section:'1102'});
check('section 2339C (relating to financing of terrorism), or section 2339D (relating to training) of this title, section 46502 of title 49', [['section 2339C',['usc','18','2339C',[]]]],[],{kind:'usc',title:'18',section:'1956'});
check('Violations involving offenses described in paragraph (c)(7)(E)', [['(c)(7)(E)',['usc','18','1956',['c','7','E']]]],[],{kind:'usc',title:'18',section:'1956',path:['e']});
check('an individual described in section 1396d(s) of this title whose income (as determined under paragraph (3) of that section) exceeds the limit', [['(3)',['usc','42','1396d',['s','3']]]],[],{kind:'usc',title:'42',section:'1396o',path:['d']});
check('a board described in subsection (a) or (b), as appropriate, of section 9910 of this title', [['(a)',['usc','42','9910',['a']]],['(b)',['usc','42','9910',['b']]]],[],{kind:'usc',title:'42',section:'9902',path:['1','A','ii']});
check('substituted “subsection (a)” for “section 202(a)” in original, which for purposes of codification had been translated as “subsection (a)”.',
 [['section 202(a)',['usc','8','1152',['a']]]],[],{kind:'usc',title:'8',section:'1152'});
check('A prior section 241 of act June 27, 1952, was renumbered section 237, and is classified to section 1227 of this title.',
 [['section 237',['usc','8','1227',[]]]],[],{kind:'usc',title:'8',section:'1227',sourceKind:'usc-note'});
const enumeratedDuties=check('(i) promote economic self-sufficiency, (ii) provide English training, (iii) insure that cash assistance encourages self-support, in accordance with subsection (e)(2), and (iv) insure equal opportunities for women.',[],[],{kind:'usc',title:'8',section:'1522',path:['a','1','A']});
assert(!enumeratedDuties.some(r=>r.text==='(iv)'), 'An enumerated duty cannot become a continuation of an intervening citation');
const datedInaList=check('section 101(a)(43)(B), (E)(ii) or (F) of the Act (as in effect on April 1, 1997)', [],[],{title:'8',chapter:'V',part:'1236',section:'1236.1'});
assert(datedInaList.length>=3);
assert(datedInaList.every(r=>r.resolution==='unresolved'&&r.historicalEditionGuard),'A terminal date qualifies the entire coordinated INA list');
const pageRange=check('39 Stat. 885–887', [['39 Stat. 885–887',['statutes-at-large','39','885–887',[]]]]);
assert.equal(pageRange[0].officialUrl,'https://www.govinfo.gov/app/details/STATUTE-39');
const malformedRange=check('42 U.S.C. 2000e-2000e17',[],[]);
assert.equal(malformedRange.length,1);assert.equal(malformedRange[0].resolution,'unresolved');
check('45 CFR 401.120ff', [['45 CFR 401.120ff',['cfr','45','401.120',[]]]]);
const nonexistentLaw=check('section 1086 of Public Law 108-458 [Public Law 108-458 does not contain section 1086]',[],[]);
assert(nonexistentLaw.filter(r=>r.targetPath?.includes('s1086')).every(r=>r.resolution==='unresolved'));
const nonexistentArticle=check('section 1086 of Public Law 108-458 [Public Law 108-458 does not contain a section 1086]',[],[]);
assert(nonexistentArticle.filter(r=>r.targetPath?.includes('s1086')).every(r=>r.resolution==='unresolved'));
check('20 U.S.C. 1070b—1070b-3; 20 U.S.C. 1070c-1070c-4', [
 ['20 U.S.C. 1070b',['usc','20','1070b',[]]],['1070b-3',['usc','20','1070b-3',[]]],
 ['20 U.S.C. 1070c',['usc','20','1070c',[]]],['1070c-4',['usc','20','1070c-4',[]]]]);
const truncatedRangeText='8 U.S.C. 1151–1153';
const truncatedRange=engine.generatedReferences(truncatedRangeText,{...context,kind:'usc',title:'8',section:'1101',sourceText:truncatedRangeText},[
 {id:'truncated-range',start:0,end:truncatedRangeText.length-1,text:truncatedRangeText.slice(0,-1),family:'usc',targetTitle:'8',targetSection:'1151–115',targetPath:[],
  houseHref:'/us/usc/t8/s1151–115',provenance:'house-uslm-ref',ruleId:'house-uslm-ref'}]);
assert.deepEqual(truncatedRange.map(r=>[r.text,r.targetSection]),[['8 U.S.C. 1151','1151'],['1153','1153']]);
check('section 703 of the Civil Rights Act of 1964', [['703',['usc','42','2000e-2',[]]]]);
check('section 203(c)(3) of the Cuban Liberty and Democratic Solidarity (LIBERTAD) Act of 1996 [22 U.S.C. 6063(c)]', [['203(c)(3)',['usc','22','6063',['c','3']]]],[],{kind:'usc',title:'8',section:'1255'});
check('subsections (c), (e), (f), (g), and (h) of section 106 of the Foreign Intelligence Surveillance Act of 1978',
 ['c','e','f','g','h'].map(x=>[`(${x})`,['usc','50','1806',[x]]]),[],{kind:'usc',title:'8',section:'1534'});
check('searches authorized under the Foreign Intelligence Surveillance Act of 1978 (50 U.S.C. 1801 et seq.) without regard to subsections (c), (e), (f), (g), and (h) of section 106 of that Act',
 ['c','e','f','g','h'].map(x=>[`(${x})`,['usc','50','1806',[x]]]),[],{kind:'usc',title:'8',section:'1534'});
const exceptionText='The waiver under INA 214(l) is cited as 8 U.S.C. 1194(l).';
const quotedOwner = { kind:'usc', title:'8', section:'1101', sourceKind:'usc-note',
 quotedScope:{start:0,end:10000,children:[],units:[],authority:{family:'public-law',title:'107',section:'56',path:['tIV','s411','c']}},
 enclosingAuthority:{family:'public-law',title:'107',section:'56',path:['tIV','s411','c']} };
check('section 415 of this title', [['section 415',['public-law','105','277',['dC','tIV','s415']]]],[],{
 ...quotedOwner, enclosingAuthority:{family:'public-law',title:'105',section:'277',path:['dC','tIV','s416']},
 quotedScope:{start:0,end:1000,children:[],units:[],authority:{family:'public-law',title:'105',section:'277',path:['dC','tIV','s416']}}});
check('Section 244 of the Immigration and Nationality Act [8 U.S.C. 1254a] (including subsection (h) thereof) applies under this section. Subsections (b)(1), (b)(2), and (i) of such section 244 shall not apply.',
 [['(h)',['usc','8','1254a',['h']]],['(b)(1)',['usc','8','1254a',['b','1']]],['(b)(2)',['usc','8','1254a',['b','2']]],['(i)',['usc','8','1254a',['i']]]],[],quotedOwner);
check('Subsec. (c)(3)(A). Pub. L. 102–232, § 204(1), substituted “after consultation in accordance with paragraph (6)” for prior text.',
 [['(6)',['usc','8','1184',['c','6']]]],[],{kind:'usc',title:'8',section:'1184',sourceKind:'usc-note',sourceTopic:'amendments'});
check('section 902 of section 101(h) of div. A of Pub. L. 105–277',
 [['section 902',['public-law','105','277',['division-A','s101','h','s902']]]],[],quotedOwner);
const partialQuoteText='Subject to subparagraph (B), the number applies.';
check(partialQuoteText,[['(B)',['public-law','106','313',['tI','s106','d','2','B']]]],[],{
 ...quotedOwner, enclosingAuthority:{family:'public-law',title:'106',section:'313',path:['tI','s106','d']},
 quotedScope:{start:0,end:partialQuoteText.length,children:[],authority:{family:'public-law',title:'106',section:'313',path:['tI','s106','d']},
 units:[{start:0,end:partialQuoteText.length,kind:'paragraph',label:'2'},{start:0,end:partialQuoteText.length,kind:'subparagraph',label:'A'}]}});
check('Under section 204(a)(1)(A)(ii) of the Immigration and Nationality Act, a petition is filed. For purposes of such section 204(a)(1)(A)(ii), the rule applies.',
 [['section 204(a)(1)(A)(ii)',['usc','8','1154',['a','1','A','ii']]]],[],quotedOwner);
check('Section 219 organizations are those designated under section 219 of the Immigration and Nationality Act. The amendments made by subsection (a) apply.',
 [['Section 219',['usc','8','1189',[]]],['(a)',['public-law','107','56',['tIV','s411','a']]]],[],quotedOwner);
check('Notwithstanding section 203(c) (or section 203(e), in the case of the next fiscal year) of the Immigration and Nationality Act, visas are available.',
 [['section 203(c)',['usc','8','1153',['c']]],['section 203(e)',['usc','8','1153',['e']]]],[],quotedOwner);
check('Pub. L. 87–301, §§ 3(b), 10, substituted “section 1101(b)(1)(E) or (F)” for “section 1101(b)(1)(E)”.',
 [['(F)',['usc','8','1101',['b','1','F']]]],[],{kind:'usc',title:'8',section:'1155',sourceKind:'usc-note'});
check('Pub. L. 108–78, §§ 107(c), 402(1), (2), Dec. 3, 2003.',
 [['402(1)',['public-law','108','78',['s402','1']]],['(2)',['public-law','108','78',['s402','2']]]],[],{kind:'usc',title:'8',section:'1184'});
check('Pub. L. 100–525, § 4(a)(2)(A), (d), amended Pub. L. 99–500.',
 [['(d)',['public-law','100','525',['s4','d']]]],[],{kind:'usc',title:'8',section:'1356'});
check('Pub. L. 101–649, title II, §§ 205(a), 207(b), Nov. 29, 1990.',
 [['207(b)',['public-law','101','649',['title-II','s207','b']]]],[],{kind:'usc',title:'8',section:'1184'});
check('Pub. L. 114–113, div. O, title II, §§ 202(a), (b), 203–205(a), 206, 207(a), 209, Dec. 18, 2015.',
 [['207(a)',['public-law','114','113',['division-O','title-II','s207','a']]]],[],{kind:'usc',title:'8',section:'1187'});
const creditedSection=JSON.parse(JSON.stringify(corpus.title8.sections.find(s=>s.section==='1324c')));
for (const owner of [creditedSection,...creditedSection.notes]) for (const key of Object.keys(owner)) {
 if (/references$/i.test(key) && Array.isArray(owner[key])) owner[key]=owner[key].filter(r=>r.provenance==='house-uslm-ref');
}
const creditCorpus={title8:{sections:[creditedSection]}};
engine.applyGeneratedLegalReferences(creditCorpus);
const creditedAmendment=creditedSection.notes.find(n=>n.topic==='amendments').references.find(r=>r.text==='Pub. L. 104–208, § 212(a)(1)');
assert.deepEqual(creditedAmendment.targetPath.map(t=>t.replace(/^division-/,'d').replace(/^title-/,'t')),['dC','tII','s212','a','1'],
 'An amendment citation inherits the same provision’s unambiguous division and title from its own section source credit');
const reconstructedSection=JSON.parse(JSON.stringify(corpus.title8.sections.find(s=>s.section==='1252a')));
const reconstructedCorpus={title8:{sections:[reconstructedSection,corpus.title8.sections.find(s=>s.section==='1252')]}};
engine.applyGeneratedLegalReferences(reconstructedCorpus);
const historicalCrossReferences=[];
function collectHistoricalReferences(nodes) {for(const node of nodes||[]) {historicalCrossReferences.push(...(node.references||[]));collectHistoricalReferences(node.children)}}
collectHistoricalReferences(reconstructedSection.body);
const formerDeportation=historicalCrossReferences.filter(r=>r.targetSection==='1252');
assert(formerDeportation.length>0);
assert(formerDeportation.every(r=>r.resolution==='unresolved'&&r.historicalEditionGuard),
 'A reconstructed 1996 deportation statute cannot open the different current judicial-review section 1252');
const repeatedAmendment=check('Pub. L. 102–232, title III, § 307(l), Dec. 12, 1991, 105 Stat. 1756, provided that the amendment made by section 307(l) is effective as if included in section 603(a) of the Immigration Act of 1990, Pub. L. 101–649.',
 [['307(l)',['public-law','102','232',['title-III','s307','l']]]],[],{kind:'usc',title:'8',section:'1159'});
assert.equal(repeatedAmendment.filter(r=>r.text==='307(l)'&&r.targetLaw==='232').length,2,'Both the source credit and repeated amending section retain their owner');
const concatenatedCredit=check('Effective Date of 1991 AmendmentPub. L. 102–232, title III, § 307(l), Dec. 12, 1991, 105 Stat. 1756, provided that the amendment made by section 307(l) is effective as if included in section 603(a) of the Immigration Act of 1990, Pub. L. 101–649.',[],[],{kind:'usc',sourceKind:'usc-note',title:'8',section:'1159'});
assert.equal(concatenatedCredit.filter(r=>r.text==='307(l)'&&r.targetLaw==='232').length,2,'A source heading concatenated with the credit must not hide the owning Public Law');
check('Section 503(b)(1)–(3) of Pub. L. 116–113', [['503(b)(1)',['public-law','116','113',['s503','b','1']]]],[],{kind:'usc',title:'8',section:'1184'});
check('section 201(b) of this title', [['section 201(b)',['public-law','107','56',['tIV','s201','b']]]],[],quotedOwner);
check('[section 1251 [now 1227] of this title]', [['section 1251',['usc','8','1251',[]]]],[],quotedOwner);
const publicLawAnchorText='Section 503(b)(1)–(3) of Pub. L. 116–113';
const publicLawAnchor=engine.generatedReferences(publicLawAnchorText,{...context,kind:'usc',title:'8',section:'1184',sourceText:publicLawAnchorText},[
 {start:0,end:17,text:publicLawAnchorText.slice(0,17),family:'usc',targetTitle:'8',targetSection:'503',targetPath:['b','1'],houseHref:'/us/usc/t8/s503/b/1',provenance:'house-uslm-ref',ruleId:'house-uslm-ref'}]);
assert(publicLawAnchor.some(r=>r.family==='public-law'&&r.targetLaw==='113'&&r.targetPath.includes('s503')),'The explicitly named Public Law corrects a conflicting bare-section House hyperlink');
assert(!publicLawAnchor.some(r=>r.family==='usc'&&r.targetSection==='503'));
const reviewedException={id:'verified-printing-error',sourceArtifact:'test-source',sourceId:'authority-regression',sourceField:'text',sourceText:exceptionText,sourceTextSha256:require('node:crypto').createHash('sha256').update(exceptionText).digest('hex'),start:exceptionText.indexOf('8 U.S.C.'),end:exceptionText.length-1,text:'8 U.S.C. 1194(l)',reason:'The named INA provision supplies the intended Code identity.',reviewedAt:'2026-10-21',officialUrl:'https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title8-section1184',citationNote:'The source prints 1194(l); the named INA provision is codified at 1184(l).',target:{family:'usc',title:'8',section:'1184',path:['l']}};
const exceptionContext={embeddedExceptions:new Map([[reviewedException.id,reviewedException]]),sourceField:'text'};
check(exceptionText, [['8 U.S.C. 1194(l)',['usc','8','1184',['l']]]],[],exceptionContext);
check(exceptionText+' Changed source.', [['8 U.S.C. 1194(l)',['usc','8','1194',['l']]]],[],exceptionContext);
check(exceptionText, [['8 U.S.C. 1194(l)',['usc','8','1194',['l']]]],[],{...exceptionContext,sourceId:'different-source'});
const abstainingException={...reviewedException,resolution:'unresolved',citationNote:'The printed reference is ambiguous; no destination has been verified.'};
const abstained=check(exceptionText,[],[],{...exceptionContext,embeddedExceptions:new Map([[abstainingException.id,abstainingException]])});
assert.equal(abstained.find(r=>r.ruleId==='embedded-exception').resolution,'unresolved');
const abstainedDelivery={title8:{sections:[{section:'1101',body:[{text:exceptionText,references:abstained}]}]}};
require('./pack-legal-references').packLegalReferences(abstainedDelivery);
require('./pack-legal-references').unpackLegalReferences(abstainedDelivery);
assert.equal(abstainedDelivery.title8.sections[0].body[0].references.find(r=>r.ruleId==='embedded-exception').resolution,'unresolved','Reviewed abstention must remain plain text after packing');
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
check('sections 101(6) and 106, Division A, Title I of Public Law 118-83',[
 ['sections 101(6)',['public-law','118','83',['division-A','title-I','s101','6']]],
 ['106',['public-law','118','83',['division-A','title-I','s106']]]
],['ina']);
for(const [section,usc] of [['201','401'],['210','410'],['215','415'],['218','418'],['218A','418a'],['223','423'],['230','430']])
 check(`section ${section} of the Social Security Act`,[[section,['usc','42',usc,[]]]],['statutes-at-large']);
check('section 1181(b) of the Social Security Act', [['1181(b)',['usc','42','1320e',['b']]]],['statutes-at-large']);
check('section 1855(d) of the Social Security Act', [['1855(d)',['usc','42','1395w-25',['d']]]],['statutes-at-large']);
check('section 211 of the Investment Advisers Act of 1940 [15 U.S.C. 80b–11]', [['211',['usc','15','80b-11',[]]]]);
check('section 1931(b)(2) of the Social Security Act', [['1931(b)(2)',['usc','42','1396u-1',['b','2']]]],['ina']);
check('section 319 of the Public Health Service Act', [['319',['usc','42','247d',[]]]],['ina']);
check('section 101(a) of the Higher Education Act of 1965', [['101(a)',['usc','20','1001',['a']]]],['ina']);
check('section 16 of the TWEA', [['16',['usc','50','4315',[]]]],['ina','public-law']);
check('section 1324 of the National Flood Insurance Act of 1968, pursuant to section 1 of Public Law 109-64 (119 Stat. 1997, 42 U.S.C. 4031)', [['1324',['usc','42','4031',[]]],['1',['public-law','109','64',['s1']]]], ['ina']);
check('section 101(b)(1) of the Act of the alien who was eligible', [['section 101(b)(1) of the Act',['ina','8','1101',['b','1']]]]);
// Parallel lists align by member, including parentheses with nested paths.
// The first Code section must not become the owner of every Act member.
check('sections 203(b)(5) and 216A of the Immigration and Nationality Act (8 U.S.C. 1153(b)(5) and 1186b)',[
 ['203(b)(5)',['usc','8','1153',['b','5']]],['216A',['usc','8','1186b',[]]]
],[],{kind:'usc',title:'8',section:'1153',sourceKind:'usc-note'});
check('sections 205 and 221(i) of the Immigration and Nationality Act (8 U.S.C. 1155, 1201(i))',[
 ['205',['usc','8','1155',[]]],['221(i)',['usc','8','1201',['i']]]
],[],{kind:'usc',title:'8',section:'1155',sourceKind:'usc-note'});
check('sections 203(b)(5) and 216A of the Immigration and Nationality Act (8 U.S.C. 1153)',[
 ['216A',['usc','8','1186b',[]]]
],[],{kind:'usc',title:'8',section:'1153',sourceKind:'usc-note'});
const quotedAct={kind:'usc',title:'8',section:'1101',sourceKind:'usc-note',quotedScope:{authority:{family:'public-law',title:'104',section:'208',path:['dC','tIII','s309']},units:[]},enclosingAuthority:{family:'public-law',title:'104',section:'208',path:['dC','tIII','s309']}};
check('Section 212(a)(3)(B) of the Immigration and Nationality Act (8 U.S.C. 1182(a)(3)(B)). For purposes of such section 212(a)(3)(B), the exception applies.', [['section 212(a)(3)(B)',['usc','8','1182',['a','3','B']]]],['public-law'],quotedAct);
check('A petition under section 203 of the Immigration and Nationality Act. It shall be considered under section 203(a)(3) or section 203(a)(4), respectively, of such Act.', [['section 203(a)(3)',['usc','8','1153',['a','3']]],['section 203(a)(4)',['usc','8','1153',['a','4']]]],['public-law'],quotedAct);
check('See section 308(a) of this division.', [['section 308(a)',['public-law','104','208',['dC','tIII','s308','a']]]],[],quotedAct);
check('See section 308(a) of this title.', [['section 308(a)',['public-law','104','208',['dC','tIII','s308','a']]]],['usc'],quotedAct);
check('section 258(c) (8 U.S.C. 1288(c))', [['section 258(c)',['usc','8','1288',['c']]]],['public-law'],quotedAct);
check('section 245 [this section]', [['section 245',['usc','8','1255',[]]]],['public-law'],{...quotedAct,section:'1255'});
check('Applicants under section 207 of the INA and Refugee-escapees paroled pursuant to section 1 of the Act of July 14, 1960.',[
 ['207',['usc','8','1157',[]]]
],[],{kind:'cfr',title:'8',part:'264',section:'264.1'});
check('8 U.S.C. 1184(c), section 214(c) of the INA and 20 CFR part 655, subpart A',[
 ['214(c)',['usc','8','1184',['c']]]
]);
check('section 204(b) of such Act (3 U.S.C. 1154(b)) [8 U.S.C. 1154(b)]',[
 ['204(b)',['usc','8','1154',['b']]]
],[],quotedAct);
check('section 240(c)(7)(C)(iv) of the Immigration and Nationality Act (8 U.S.C. 1229a(c)(7))', [['240(c)(7)(C)(iv)',['usc','8','1229a',['c','7','C','iv']]]],[],quotedAct);
check('The definitions contained in section 101(a) and (b) of the Immigration and Nationality Act [section 1101(a), (b) of this title] shall apply.',[
 ['101(a)',['usc','8','1101',['a']]],['(b)',['usc','8','1101',['b']]]
],['public-law'],quotedAct);
check('Ex. Ord. No. 14159. Pursuant to section 235(b)(1)(A)(iii)(I) of the INA (8 U.S.C. 1225(b)(1)(A)(iii)(I)), apply section 235(b)(1)(A)(i) and (ii) of the INA to aliens designated under section 235(b)(1)(A)(iii)(II).',[
 ['235(b)(1)(A)(iii)(I)',['usc','8','1225',['b','1','A','iii','I']]],
 ['235(b)(1)(A)(i)',['usc','8','1225',['b','1','A','i']]],
 ['section 235(b)(1)(A)(iii)(II)',['usc','8','1225',['b','1','A','iii','II']]]
],[],{kind:'usc',title:'8',section:'1103',sourceKind:'usc-note'});
check('Ex. Ord. No. 12208. Sections 101(a)(42)(B) and 207(a), (b), (d), and (e) of the Immigration and Nationality Act. Sections 207(a)(1), 207(a)(2), 207(a)(3) and 207(b) [8 U.S.C. 1157(a)(1) to (3) and (b)]. To fix the number of refugees to be admitted under Section 207(b).',[
 ['207(b)',['usc','8','1157',['b']]],['Section 207(b)',['usc','8','1157',['b']]]
],[],{kind:'usc',title:'8',section:'1157',sourceKind:'usc-note'});
check('A waiver under section 214(l) of the Immigration and Nationality Act (8 U.S.C. 1194(l)).',[
 ['214(l)',['usc','8','1184',['l']]]
]);
const wrongChapter=check('See § 236.5(b) of this chapter.', [],[],{kind:'cfr',title:'8',chapter:'V',part:'1212',section:'1212.5'});
assert(wrongChapter.every(r=>r.resolution==='unresolved'),'A this-chapter qualifier cannot route to a different CFR chapter');
const formerIna=check('Suspension of deportation pursuant to former section 244(a) of the Act (as in effect prior to April 1, 1997).',[
 ['section 244(a) of the Act',['ina','8','1254',['a']]]
],[],{kind:'cfr',title:'8',chapter:'V',part:'1003',section:'1003.43'});
assert(!formerIna[0].targetEdition);
assert.equal(formerIna[0].resolution,'local');
assert.match(formerIna[0].citationNote,/verified.*prior to April 1, 1997/);
const pre1990Ina=check('A conviction under former section 241(a)(11) of the Act.',[
 ['section 241(a)(11) of the Act',['ina','8','1251',['a','11']]]
],[],{kind:'cfr',title:'8',chapter:'I',part:'212',section:'212.3'});
assert.equal(pre1990Ina[0].resolution,'unresolved','A pre-1990 paragraph absent from the 1994 archive must remain plain text');
assert(!pre1990Ina[0].targetEdition,'Do not label a missing historical paragraph as the 1994 edition');
const mixedVersions=check('In accordance with former section 242 of the Act (before amended by section 306 of the IIRIRA of 1996, Div. C, Public Law 104-208) or current sections 235(b), 238, and 240 of the Act.',[
 ['section 242 of the Act',['ina','8','1252',[]]],['sections 235(b)',['ina','8','1225',['b']]],['238',['ina','8','1228',[]]]
],[],{kind:'cfr',title:'8',chapter:'I',part:'212',section:'212.6'});
assert.equal(mixedVersions.find(r=>r.inaSection==='242').resolution,'unresolved','An exact pre-amendment version cannot be assumed to equal the 1994 annual edition');
assert(!mixedVersions.find(r=>r.inaSection==='242').targetEdition);
assert(!mixedVersions.some(r=>['235','238','240'].includes(r.inaSection)&&r.targetEdition),'Former qualifier must not leak to the current coordinated list');
const formerWithholding=check('denial of withholding of deportation under section 243(h)(2) of the Act.',[
 ['section 243(h)(2) of the Act',['ina','8','1253',['h','2']]]
],[],{kind:'cfr',title:'8',chapter:'V',part:'1208',section:'1208.23'});
assert.equal(formerWithholding[0].targetEdition,'1994');
const explicit1946=check('8 U.S.C. 801, 1946 ed.', [['8 U.S.C. 801',['usc','8','801',[]]]]);
assert(!explicit1946.some(r=>r.targetSection==='1946'),'An edition year is not another Code section');
assert.equal(explicit1946[0].targetEdition,'1946');
assert.match(explicit1946[0].officialUrl,/loc\.gov/);
const statutoryNote=check('8 U.S.C. 1522 note', [['8 U.S.C. 1522',['usc','8','1522',[]]]]);
assert.equal(statutoryNote[0].targetNote,true);
assert.equal(statutoryNote[0].resolution,'official-source-only','A statutory note must not open the host section body');
check('section 501(a) of the Refugee Education Assistance Act of 1980, 8 U.S.C. 1522 note',[
 ['501(a)',['public-law','96','422',['s501','a']]]
]);
const explicitCfr1997=check('8 CFR 242.1 (1997) as it existed prior to April 1, 1997.', [['8 CFR 242.1 (1997)',['cfr','8','242.1',[]]]]);
assert.equal(explicitCfr1997[0].targetEdition,'1997');
assert(!/\/current\//.test(explicitCfr1997[0].officialUrl));
const historicalCfrDate=check('8 CFR 240.21 (as in effect prior to September 30, 1998)',[]);
assert.equal(historicalCfrDate[0].resolution,'unresolved','A current CFR body does not establish the expressly dated regulation');
const datedCfrList=check('8 CFR 214.2(h)(1) and (2)(1997)',[
 ['8 CFR 214.2(h)(1)',['cfr','8','214.2',['h','1']]],
 ['(2)(1997)',['cfr','8','214.2',['h','2']]]
]);
assert(datedCfrList.every(r=>r.targetEdition==='1997'),'A terminal CFR edition governs the complete coordinated list');
const datedCfrSections=check('8 CFR 214.2 and 214.3(1997)',[
 ['8 CFR 214.2',['cfr','8','214.2',[]]],['214.3(1997)',['cfr','8','214.3',[]]]
]);
assert(datedCfrSections.every(r=>r.targetEdition==='1997'));
for (const text of ['8 CFR 214.2 (1995) and 214.3 (1997)', '8 CFR 214.2(h)(1) (1995) and (2) (1997)']) {
 const refs=check(text,[]).filter(r=>r.family==='cfr');
 assert.deepEqual(refs.map(r=>r.targetEdition),['1995','1997'],'Each separately printed CFR edition owns its member');
 assert(refs.every(r=>!r.targetPath.some(token=>/^19\d\d$/.test(token))),'Edition years are not paragraph labels');
}
const separateUscEditions=check('8 U.S.C. 1182 (1994) and 1184 (2000)',[]).filter(r=>r.family==='usc');
assert.deepEqual(separateUscEditions.map(r=>r.targetEdition),['1994','2000']);
for(const first of ['1182(a)(2)','1254']) {
 const refs=check(`8 U.S.C. ${first} (1994) and 8 U.S.C. 1254 (as in effect on March 31, 1997).`,[]).filter(r=>r.family==='usc');
 assert.equal(refs[0].targetEdition,'1994','A later date cannot replace an independently printed edition');
 assert.equal(refs[0].resolution,'official-source-only');
}
const mixedDate=check('INA 101(a)(15)(T), 101(a)(15)(U), 106, 240A(b)(2), and 244(a)(3) (as in effect on March 31, 1997)',[]);
assert(mixedDate.filter(r=>r.inaSection!=='244').every(r=>!r.historicalEditionGuard),'A parenthetical on the last distinct provision does not date unrelated provisions');
const mixedCodeDate=check('relief under sections 1101(a)(15)(T), 1101(a)(15)(U), 1105a, 1229b(b)(2), and 1254a(a)(3) of this title (as in effect on March 31, 1997)',[],[],{kind:'usc',title:'8',section:'1255',path:['l','7']});
assert(mixedCodeDate.filter(r=>r.targetSection!=='1254a').every(r=>!r.historicalEditionGuard),'A trailing historical parenthetical does not date the distinct T/U and VAWA provisions in a Code list');
for(const text of ['INA 405(a)', 'INA 405(a) and (b)']) {
 const refs=check(text,[]).filter(r=>r.inaSection==='405');assert(refs.length);
 assert(refs.every(r=>r.targetNote&&r.resolution==='official-source-only'&&!r.targetPath.length),'Explicit INA note locators must not open the host section body');
}
const separateCfrEditions=check('8 CFR 214.2(h)(1); compare 8 CFR 214.3(1997)',[]);
assert(!separateCfrEditions.find(r=>r.targetSection==='214.2').targetEdition,'An edition cannot cross intervening prose');
const historicalSubpart={title8:{sections:structuredClone(corpus.title8.sections.filter(s=>['1225','1231','1251','1254','1254a'].includes(s.section)))},inaCrosswalk:corpus.inaCrosswalk.filter(r=>['235','241','244'].includes(r.inaSection)),cfr:{parts:[],sections:[
 {id:'8:999.1',title:8,section:'999.1',hierarchy:[{type:'chapter',number:'I'},{type:'part',number:'999'},{type:'subpart',number:'A'}],blocks:[{t:'p',x:'All references to the Act contained in this subpart are references to the Act in effect prior to April 1, 1997.'}]},
 {id:'8:999.2',title:8,section:'999.2',hierarchy:[{type:'chapter',number:'I'},{type:'part',number:'999'},{type:'subpart',number:'A'}],blocks:[{t:'p',x:'See sections 235, 241(a)(2), and 244(a)(3) of the Immigration and Nationality Act.'}]},
 {id:'8:999.3',title:8,section:'999.3',hierarchy:[{type:'chapter',number:'I'},{type:'part',number:'999'},{type:'subpart',number:'B'}],blocks:[{t:'p',x:'See section 241 of the Immigration and Nationality Act.'}]}
]}};
engine.applyGeneratedLegalReferences(historicalSubpart);
const oldSubpartRefs=historicalSubpart.cfr.sections[1].blocks[0].xReferences;
assert.equal(oldSubpartRefs.find(r=>r.inaSection==='241')?.targetSection,'1251','A source-defined historical Act owns every citation in that subpart');
assert.equal(oldSubpartRefs.find(r=>r.inaSection==='235')?.resolution,'unresolved','No verified date-matching text must remain plain');
assert.equal(oldSubpartRefs.find(r=>r.inaSection==='244')?.targetSection,'1254');
assert.equal(oldSubpartRefs.find(r=>r.inaSection==='244')?.resolution,'local','The independently verified final1254 text covers March31,1997');
assert.equal(historicalSubpart.cfr.sections[2].blocks[0].xReferences[0].targetSection,'1231','The historical definition must not cross its subpart boundary');
check('section 203(b)(5) or 216A of the Immigration and Nationality Act (8 U.S.C. 1153(b)(5) and 1186b)',[
 ['203(b)(5)',['usc','8','1153',['b','5']]],['216A',['usc','8','1186b',[]]]
],['public-law'],quotedAct);
check('paragraph (2) or (3) of section 212(a) or paragraph (2), (3), or (4) of section 237(a) of the Immigration and Nationality Act',[
 ['(2)',['usc','8','1182',['a','2']]],['(3)',['usc','8','1182',['a','3']]],['section 212(a)',['usc','8','1182',['a']]],
 ['(4)',['usc','8','1227',['a','4']]]
],['public-law'],quotedAct);
const educationRefs=check('Institution of higher education means an institution as defined in section 101(a) of the Higher Education Act of 1965. Section 101(a) of that Act, 20 U.S.C. 1001(a)(2000), provides the definition.',[
 ['101(a)',['usc','20','1001',['a']]]
],['ina'],{kind:'cfr',title:'20',part:'656',section:'656.40'});
assert(educationRefs.filter(reference=>reference.text==='101(a)').every(reference=>reference.targetEdition==='2000'&&reference.resolution==='official-source-only'),'The restated named-Act citations retain their expressly supplied Code edition');
check('Is defined as a tax exempt organization under the Internal Revenue Code of 1986, section 501(c)(3), (c)(4), or (c)(6) (26 U.S.C. 501(c)(3), (c)(4) or (c)(6)); and',[
 ['section 501(c)(3)',['usc','26','501',['c','3']]],['(c)(4)',['usc','26','501',['c','4']]],['(c)(6)',['usc','26','501',['c','6']]]
],['ina'],{kind:'cfr',title:'20',part:'656',section:'656.3'});

// A trailing named CFR authority owns the complete decimal address even in
// USC prose. Keep the historical number printed by INA 218(c)(3)(B)(vi).
const uscContext={kind:'usc',title:'8',section:'1188',path:['c','3','B','vi']};
const employerText='An employer shall not be liable for payments under section 655.202(b)(6) of title 20, Code of Federal Regulations (or any successor regulation) with respect to an H–2A worker who is displaced due to compliance with the requirement of this subparagraph, if the Secretary of Labor certifies that the H–2A worker was displaced because of the employer’s compliance with clause (i) of this subparagraph.';
const employerReferences=check(employerText,[['655.202(b)(6)',['cfr','20','655.202',['b','6']]]],[],uscContext);
const employerCfr=employerReferences.find(r=>r.text==='655.202(b)(6)');
assert.equal(employerCfr.officialUrl,'https://www.ecfr.gov/current/title-20/part-655/section-655.202');
assert(!employerReferences.some(r=>r.family!=='cfr'&&r.start<employerCfr.end&&r.end>employerCfr.start),'A USC fallback must not occupy the CFR address');
for(const scope of ['of title 20, Code of Federal Regulations','of title 20 of the Code of Federal Regulations','of title 20, the Code of Federal Regulations','of title 20, C.F.R.','of title 20 CFR']) {
 check(`section 655.202(b)(6) ${scope}`,[['655.202(b)(6)',['cfr','20','655.202',['b','6']]]],['usc','ina'],uscContext);
}
check('section 655.202 of title 20, Code of Federal Regulations',[['655.202',['cfr','20','655.202',[]]]],['usc','ina'],uscContext);
check('sections 655.202(b)(6), (7), and 655.203(c) of title 20, Code of Federal Regulations',[
 ['655.202(b)(6)',['cfr','20','655.202',['b','6']]],['(7)',['cfr','20','655.202',['b','7']]],['655.203(c)',['cfr','20','655.203',['c']]]
],['usc','ina'],uscContext);
check('paragraph (6) of section 655.202(b) of title 20, Code of Federal Regulations',[
 ['(6)',['cfr','20','655.202',['b','6']]],['section 655.202(b)',['cfr','20','655.202',['b']]]
],['usc','ina'],uscContext);
// An earlier statutory authority must not supply the title for part of a
// later list that expressly names its own CFR authority.
check('8 U.S.C. 1188; sections 655.202(b) and section 655.203(c) of title 20, Code of Federal Regulations',[
 ['655.202(b)',['cfr','20','655.202',['b']]],['655.203(c)',['cfr','20','655.203',['c']]]
],[],uscContext);
// A coincidentally indexed USC section must not win by starting at "section"
// before the numbered CFR member starts, including an integer CFR address.
check('section 1101.1(a) of title 8, Code of Federal Regulations',[['1101.1(a)',['cfr','8','1101.1',['a']]]],['usc','ina'],uscContext);
check('section 1101(a) of title 8, Code of Federal Regulations',[['1101(a)',['cfr','8','1101',['a']]]],['usc','ina'],uscContext);
for(const [zone,token] of [['Prince William Sound','b'],['Western Alaska','a']]) {
 const text=`The term "${zone} Captain of the Port Zone" means the area described in section 3.85–15(${token}) of title 33, Code of Federal Regulations.`;
 const refs=check(text,[[`3.85–15(${token})`,['cfr','33','3.85-15',[token]]]],['usc','ina'],uscContext);
 assert.equal(refs.length,1,'A hyphenated CFR section must produce one complete address');
 assert.equal(refs[0].resolution,'official-source-only','Title 33 is not in the embedded corpus');
 assert.equal(refs[0].officialUrl,'https://www.ecfr.gov/current/title-33/part-3/section-3.85-15');
}
check('sections 3.85-15(a) and 3.85-20(b) of title 33, Code of Federal Regulations',[
 ['3.85-15(a)',['cfr','33','3.85-15',['a']]],['3.85-20(b)',['cfr','33','3.85-20',['b']]]
],['usc','ina'],uscContext);
check('paragraph (b) of section 3.85–15 of title 33, Code of Federal Regulations',[
 ['(b)',['cfr','33','3.85-15',['b']]],['3.85–15',['cfr','33','3.85-15',[]]]
],['usc','ina'],uscContext);
check('3.85–15(b) of title 33, Code of Federal Regulations',[['3.85–15(b)',['cfr','33','3.85-15',['b']]]],['usc','ina'],uscContext);
check('section 412.352 of title 42 of the Code of Federal Regulations, section 412.308(c) of that title, and section 412.328(e)(1) of that title',[
 ['412.352',['cfr','42','412.352',[]]],['412.308(c)',['cfr','42','412.308',['c']]],['412.328(e)(1)',['cfr','42','412.328',['e','1']]]
],['usc','ina'],uscContext);
check('paragraph (d)(4) of section 412.529 of title 42, Code of Federal Regulations, including payments under section 412.525 of such title',[
 ['(d)(4)',['cfr','42','412.529',['d','4']]],['412.529',['cfr','42','412.529',[]]],['412.525',['cfr','42','412.525',[]]]
],['usc','ina'],uscContext);
check('section 412.529 of title 42, Code of Federal Regulations, and paragraph (e)(1) of section 412.328 of that title',[
 ['412.529',['cfr','42','412.529',[]]],['(e)(1)',['cfr','42','412.328',['e','1']]],['412.328',['cfr','42','412.328',[]]]
],['usc','ina'],uscContext);
check('section 413.77(e) of title 42, Code of Federal Regulations; section 1395ww(d) of title 42, United States Code, and section 1395x(v) of that title',[
 ['413.77(e)',['cfr','42','413.77',['e']]],['section 1395ww(d)',['usc','42','1395ww',['d']]],['1395x(v)',['usc','42','1395x',['v']]]
],[],uscContext);
// Periods in abbreviations or sentences do not imply CFR ownership, and a
// decimal alone must not override a different explicitly named authority.
check('Sec. 1188(c) of title 8.',[['1188(c)',['usc','8','1188',['c']]]],['cfr'],uscContext);
check('section 1188(c) of title 8, United States Code.',[['section 1188(c)',['usc','8','1188',['c']]]],['cfr'],uscContext);
check('section 655.202(b) of title 20, United States Code.',[['655.202(b)',['usc','20','655.202',['b']]]],['cfr'],uscContext);
check('section 655.202(b) of title 20. Code of Federal Regulations provisions follow.',[['655.202(b)',['usc','20','655.202',['b']]]],['cfr'],uscContext);
check('section 655.202(b)(6) applies.',[],['cfr'],uscContext);
// Full-corpus audit: a named CFR title before a section symbol owns that
// citation, and a trailing parallel citation identifies the same provision.
check('Title 46, Code of Federal Regulations, § 67.01-67.45.',[
 ['§ 67.01',['cfr','46','67.01',[]]]
],[],{kind:'cfr',title:'19',section:'4.0',path:[]});
check('§ 30.10 of the Census Bureau’s Foreign Trade Regulations (15 CFR 30.10)',[
 ['§ 30.10',['cfr','15','30.10',[]]],['15 CFR 30.10',['cfr','15','30.10',[]]]
],[],{kind:'cfr',title:'19',section:'4.15',path:[]});
check('Title 46, Code of Federal Regulations. Local requirements are in § 30.10.',[
 ['§ 30.10',['cfr','19','30.10',[]]]
],[],{kind:'cfr',title:'19',section:'4.15',path:[]});
check('§ 30.10 of this part concerns a different provision (15 CFR 30.11)',[
 ['§ 30.10',['cfr','19','30.10',[]]],['15 CFR 30.11',['cfr','15','30.11',[]]]
],[],{kind:'cfr',title:'19',section:'4.15',path:[]});
check('paragraphs (c)(3) (i) and (ii) of this section',[
 ['(c)(3) (i)',['cfr','19','4.7a',['c','3','i']]],['(ii)',['cfr','19','4.7a',['c','3','ii']]]
],[],{kind:'cfr',title:'19',section:'4.7a',path:[]});
check('paragraphs (b)(3)(iv), (v), (x), (xii), (xiii), (xiv), (xvi), (xviii), and (xix) of this section',[
 ['(xix)',['cfr','19','4.7b',['b','3','xix']]]
],[],{kind:'cfr',title:'19',section:'4.7b',path:[]});
check('paragraph (ii) of this section',[
 ['(ii)',['cfr','19','4.7a',['ii']]]
],[],{kind:'cfr',title:'19',section:'4.7a',path:[]});
check('paragraphs (b)(1) (iii) and (iv) of this section',[
 ['(iv)',['cfr','20','416.212',['b','1','iv']]]
],[],{kind:'cfr',title:'20',section:'416.212',path:[]});
check('paragraphs (b) (1) and (2) of this section',[
 ['(2)',['cfr','20','416.269',['b','2']]]
],[],{kind:'cfr',title:'20',section:'416.269',path:[]});
check('paragraph (b) (1) through (3) of this section',[
 ['(3)',['cfr','20','416.542',['b','3']]]
],[],{kind:'cfr',title:'20',section:'416.542',path:[]});
// A foreign section cited in an ancestor or earlier clause does not own an
// unqualified unit when the host statute supplies the exact named unit.
check('except as provided in subsection (a)(4), the proportion of the visa numbers made available under each of paragraphs (1) through (4) of section 1153(a) of this title applies.',[
 ['(a)(4)',['usc','8','1152',['a','4']]]
],[],{kind:'usc',title:'8',section:'1152',path:['e','2'],sourceId:'usc-1152-e-2',embeddedState:{frames:[{kind:'section',family:'usc',title:'8',section:'1153',path:[],sourceId:'usc-1152-e',start:0,end:90}]}});
const employmentText='Visas shall be made available, in a number not to exceed 28.6 percent of such worldwide level, plus any visas not required for the classes specified in paragraphs (1) and (2), to the following classes of aliens who are not described in paragraph (2):';
const employmentReferences=check(employmentText,[['(1)',['usc','8','1153',['b','1']]],['(2)',['usc','8','1153',['b','2']]]],[],{kind:'usc',title:'8',section:'1153',path:['b','3','A'],sourceId:'usc-1153-b-3-A',embeddedState:{frames:[{kind:'section',family:'usc',title:'8',section:'1151',path:['d'],sourceId:'usc-1153-b',start:0,end:80}]}});
assert(employmentReferences.filter(r=>r.text==='(2)').every(r=>r.targetSection==='1153'&&JSON.stringify(r.targetPath)==='["b","2"]'));
const relationshipReferences=check('with respect to a relationship described in subsection (a)(2)(A), a petition filed under section 1154 of this title for classification of an alien child under subsection (a)(2)(A); or',[
 ['(a)(2)(A)',['usc','8','1153',['a','2','A']]]
],[],{kind:'usc',title:'8',section:'1153',path:['h','2','A']});
assert(relationshipReferences.filter(r=>r.text==='(a)(2)(A)').every(r=>r.targetSection==='1153'));
// An explicit anaphor still carries the named foreign section.
check('section 1151(d) of this title and paragraph (1) of such section',[
 ['(1)',['usc','8','1151',['d','1']]]
],[],{kind:'usc',title:'8',section:'1153',path:['b','3','A']});
// A parent expressly introducing another section's provisions governs its
// child list even where the owner happens to have the same paragraph labels.
const exclusionFixture={title8:{sections:['1160','1182'].map(section=>({...structuredClone(corpus.title8.sections.find(s=>s.section===section)),notes:[]}))},cfr:{parts:[],sections:[]}};
function retainSourceReferences(value) {
 if(!value||typeof value!=='object') return;
 for(const [key,child] of Object.entries(value)) {
  if(/references$/i.test(key)&&Array.isArray(child)) value[key]=child.filter(reference=>reference.provenance==='house-uslm-ref');
  else retainSourceReferences(child);
 }
}
retainSourceReferences(exclusionFixture);
engine.applyGeneratedLegalReferences(exclusionFixture);
const criminalGrounds=exclusionFixture.title8.sections[0].body[2].children[1].children[1].children[1].children[0].references;
for(const token of ['A','B']) assert(criminalGrounds.some(r=>r.targetSection==='1182'&&JSON.stringify(r.targetPath)===JSON.stringify(['a','2',token])),'The expressly introduced section 1182(a) list must retain both criminal grounds');
check('Nothing in any paragraph of subsection (a) (other than paragraph (1)) shall exclude from the term "wages"—',[
 ['(1)',['usc','26','3121',['a','1']]]
],[],{kind:'usc',title:'26',section:'3121',path:['v','1']});
check('With respect to the designated Federal programs under paragraph (3) (other than subparagraph (C)), paragraph (1) shall not apply to an alien until 5 years after the date—',[
 ['(C)',['usc','8','1612',['b','3','C']]]
],[],{kind:'usc',title:'8',section:'1612',path:['b','2','A','ii']});
check('Clause (i) shall not apply to an alien who would be described in paragraph (6)(A)(ii) if “violation of the terms of the alien’s nonimmigrant visa” were substituted for “unlawful entry into the United States” in subclause (III) of that paragraph.',[
 ['(III)',['usc','8','1182',['a','6','A','ii','III']]]
],[],{kind:'usc',title:'8',section:'1182',path:['a','9','B','iii','IV']});
check('For purposes of paragraph (1) with respect to individuals described in subparagraph (A) or (B) of that paragraph, the State shall establish an income level.',[
 ['(A)',['usc','42','1396a',['l','1','A']]],['(B)',['usc','42','1396a',['l','1','B']]]
],[],{kind:'usc',title:'42',section:'1396a',path:['l','2','A','i']});
check('The amount determined under clause (iv) (other than subclause (I)) shall apply.',[
 ['(I)',['usc','42','1395ww',['d','5','F','iv','I']]]
],[],{kind:'usc',title:'42',section:'1395ww',path:['d','5','F','xiv','I']});
check('Notwithstanding any provision of title XIX of the Social Security Act [42 U.S.C. 1396 et seq.] (including subparagraphs (B) and (C) of section 1902(a)(10) of such Act [42 U.S.C. 1396a(a)(10)(B), (C)]), aliens who, but for subparagraph (A), would be ineligible for medical assistance under paragraph (1), are only eligible for such assistance with respect to—',[
 ['(A)',['usc','8','1255a',['h','3','A']]]
],[],{kind:'usc',title:'8',section:'1255a',path:['h','3','B','i']});
check('Law enforcement officials may submit written requests to the Secretary of Homeland Security, in accordance with section 1229b(b)(6) of title 8, to permit the parole into the United States of certain relatives of an alien described in subparagraph (A)(i).',[
 ['(A)(i)',['usc','22','7105',['c','3','A','i']]]
],[],{kind:'usc',title:'22',section:'7105',path:['c','3','B']});
// An unlabeled OCR body is the section itself, not an empty address component.
const flatSectionRefs=check('subsections (a), (b), (d), (g), (h), and (i) of this section',[
 ['(i)',['usc','8','746',['i']]]
],[],{kind:'usc',title:'8',section:'746',path:['']});
assert(flatSectionRefs.every(r=>r.targetPath.every(Boolean)), 'Unlabeled source nodes must not create empty citation components');
// Written sibling prefixes remain part of the locator even when the target
// endpoint is absent from the current embedded edition.
const absentCfrRefs=check('paragraphs (b)(1) through (4) of this section',[
 ['(4)',['cfr','20','416.920b',['b','4']]]
],[],{kind:'cfr',title:'20',section:'416.920b',path:[]});
assert.equal(absentCfrRefs.find(r=>r.text==='(4)').resolution,'official-source-only');
for(const separator of ['-', '–', '—']) check(`paragraphs (c)(3)(i)${separator}(v) of this section`,[
 ['(c)(3)(i)',['cfr','20','416.920c',['c','3','i']]], ['(v)',['cfr','20','416.920c',['c','3','v']]]
],[],{kind:'cfr',title:'20',section:'416.920c',path:[]});
// Suppression of a corrected local self/ancestor citation must not resurrect
// the inaccurate root-only fallback. The other list endpoint stays linked.
for(const [section,phrase,sourcePath,endPath,endText] of [
 ['214.2','paragraphs (e)(8)(iv)(A) through (C) of this section',['e','8','iv','C'],['e','8','iv','C'],'(C)'],
 ['214.2','paragraphs (h)(5)(xi)(B) and (C) of this section',['h','5','xi','C','2'],['h','5','xi','C'],'(C)'],
 ['214.2','paragraphs (h)(6)(i)(C) and (D) of this section',['h','6','i','D','2'],['h','6','i','D'],'(D)'],
 ['214.3','paragraphs (g)(1)(i) through (x) of this section',['g','1','x'],['g','1','x'],'(x)'],
 ['245a.4','paragraphs (b)(4)(iv)(A)(5) and (6) of this section',['b','4','iv','A','6'],['b','4','iv','A','6'],'(6)'],
 ['1003.1','paragraph (d)(2)(i) or (ii) of this section',['d','2','ii'],['d','2','ii'],'(ii)']
]) {
 const overrides={kind:'cfr',title:'8',section,path:sourcePath};
 check(phrase,[[endText,['cfr','8',section,endPath]]],[],overrides);
 const suppressed=check(phrase,[],[],{...overrides,suppressSelfReferences:true});
 assert(!suppressed.some(r=>r.text===endText),'A local self/ancestor endpoint must remain plain source text');
 assert(suppressed.length>0,'The distinct list endpoint remains navigable');
}
// This exact source wording omits subsection (f); the maintained exception
// is bound to the whole source field, not to a generic paragraph pattern.
const transition = corpus.title8.sections.find(s=>s.section==='1101').notes.find(n=>n.id==='8-1101-note-17');
const exceptions = JSON.parse(fs.readFileSync(path.join(root,'sources/legal/embedded-reference-exceptions.json'),'utf8'));
const compactActNote = corpus.title8.sections.find(section=>section.section==='1105').notes[5].text;
const compactActRanges = check(compactActNote,[
 ['42 U.S.C. 14611–16',['usc','34','40311–40316',[]]], ['34 U.S.C. 40311–16',['usc','34','40311–40316',[]]]
],[],{kind:'usc',title:'8',section:'1105',sourceKind:'usc-note',sourceId:'usc-1105-note-6',sourceField:'text',
 embeddedExceptions:new Map(exceptions.exceptions.map(exception=>[exception.id,exception]))});
assert(compactActRanges.filter(reference=>reference.targetSection==='40311–40316').every(reference=>reference.targetEdition==='2024'&&reference.officialUrl.includes('chap403-subchapII.pdf')),
 'Complete Code ranges open the verified full subchapter archive with its edition, not an invented single-section URL');
assert.equal(engine.validateEmbeddedReferenceExceptions(exceptions).exceptions,exceptions.exceptions.length,'The exact maintained build-input manifest must validate');
const historicalHeadingException=exceptions.exceptions.find(e=>e.sourceId==='usc-1486'&&e.sourceField==='heading');
assert(historicalHeadingException,'The retained original INA heading must not lose its historical section identity');
assert.deepEqual(historicalHeadingException.target,{family:'usc',title:'8',section:'1484',path:['a','2']});
assert.equal(historicalHeadingException.resolution,'unresolved','The historical heading must not open the unrelated current Code section 352');
assert.equal(historicalHeadingException.text,'Section 352(a)(2)');
assert.equal(historicalHeadingException.sourceText.slice(historicalHeadingException.start,historicalHeadingException.end),historicalHeadingException.text);
assert.throws(()=>engine.validateEmbeddedReferenceExceptions({...exceptions,exceptions:[{...historicalHeadingException,resolution:'official-source-only'}]}),/incomplete/,'A navigable exception still requires an official destination');
const replacedCodeException=exceptions.exceptions.find(e=>e.id==='usc-1255-note-3-replaced-code-section');
assert(replacedCodeException,'The quoted replaced Code provision must retain its historical identity');
assert.deepEqual(replacedCodeException.target,{family:'usc',title:'8',section:'1151',path:['a']});
assert.equal(replacedCodeException.resolution,'unresolved');
const reviewedDelivery={title8:{sections:[{section:'1101',body:[]}]},cfr:{parts:[],sections:[]}};
for (const [index, exception] of exceptions.exceptions.entries()) {
 if (!exception.sourceText) continue;
 const overrides={...shared,kind:exception.sourceId.startsWith('cfr-')?'cfr':'usc',title:'8',section:'1101',sourceId:exception.sourceId,sourceField:exception.sourceField,sourceText:exception.sourceText,embeddedExceptions:new Map([[exception.id,exception]])};
 const refs=engine.generatedReferences(exception.sourceText,overrides);
 const browserRefs=browser.INASearchLegalReferences.generatedReferences(exception.sourceText,{...overrides,sourceId:overrides.kind==='cfr'?'runtime-'+exception.sourceId:exception.sourceId});
 const ref=refs.find(r=>r.start===exception.start&&r.end===exception.end);
 const runtime=browserRefs.find(r=>r.start===exception.start&&r.end===exception.end);
 assert.deepEqual(target(ref),[exception.target.family,exception.target.title,exception.target.section||'',exception.target.path],exception.id);
 assert.equal(ref.targetChapter,exception.target.chapter,exception.id+' chapter identity');
 assert.equal(runtime.targetChapter,ref.targetChapter,'Runtime chapter identity must survive the source exception');
 assert(ref.citationNote === exception.citationNote || ref.citationNote?.startsWith(exception.citationNote + " The official "), "The exception notice must be retained before any archive-search notice");
 assert.deepEqual(JSON.parse(JSON.stringify(target(runtime))),target(ref),'Runtime source identity must retain the exact-source exception');
 assert.equal(runtime.historicalOfficialUrl,ref.historicalOfficialUrl);
 reviewedDelivery.title8.sections[0].body.push({label:String(index),text:exception.sourceText,references:refs});
}
require('./pack-legal-references').packLegalReferences(reviewedDelivery);
require('./pack-legal-references').unpackLegalReferences(reviewedDelivery);
for(const node of reviewedDelivery.title8.sections[0].body) {
 const exception=exceptions.exceptions[+node.label];const ref=node.references.find(r=>r.start===exception.start&&r.end===exception.end);
 assert.deepEqual(target(ref),[exception.target.family,exception.target.title,exception.target.section||'',exception.target.path]);
 assert.equal(ref.targetChapter,exception.target.chapter,'Packed exceptions retain chapter identity');
 assert(ref.citationNote === exception.citationNote || ref.citationNote?.startsWith(exception.citationNote + ' The official '), 'Correction notices survive standalone delivery');
 if(exception.target.edition) {assert.equal(ref.targetEdition,exception.target.edition);assert.equal(ref.officialUrl,exception.officialUrl);}
}
const archivedDelivery={title8:{sections:[{section:'1101',body:[{label:'a',text:'8 U.S.C. 801, 1946 ed.',references:explicit1946},{label:'b',text:'8 CFR 242.1 (1997)',references:explicitCfr1997}]}]},cfr:{parts:[],sections:[]}};
require('./pack-legal-references').packLegalReferences(archivedDelivery);
require('./pack-legal-references').unpackLegalReferences(archivedDelivery);
assert.match(archivedDelivery.title8.sections[0].body[0].references[0].officialUrl,/loc\.gov/);
assert.match(archivedDelivery.title8.sections[0].body[1].references[0].officialUrl,/CFR-1997-title8-vol1-sec242-1/);
const transitionContext = {...shared,kind:'usc',title:'8',section:'1101',path:[],sourceKind:'usc-note',sourceId:'usc-1101-note-17',sourceField:'text',sourceText:transition.text,sourceLayout:transition.layout,sourceTextSha256:require('node:crypto').createHash('sha256').update(transition.text).digest('hex'),embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))};
const pilotNote=corpus.title8.sections.find(section=>section.section==='1324a').notes.find(note=>note.heading==='Pilot Programs for Employment Eligibility Confirmation');
const pilotRefs=engine.generatedReferences(pilotNote.text,{...shared,kind:'usc',title:'8',section:'1324a',sourceKind:'usc-note',sourceId:'usc-1324a-note-14',sourceText:pilotNote.text,sourceLayout:pilotNote.layout},pilotNote.references.filter(reference=>reference.provenance==='house-uslm-ref'));
const defined274a=pilotRefs.filter(reference=>/^section 274a\b/i.test(reference.text));
assert(defined274a.length>=33,'Retain all directly linked section 274A locators governed by the subtitle definition');
assert(defined274a.every(reference=>reference.family==='usc'&&reference.targetTitle==='8'&&reference.targetSection==='1324a'),'The subtitle expressly defines every section 274A reference as INA 274A, not Public Law 104-208 section 274A');
for(const [section,id,offset] of [['1103','8-1103-note-30',5521],['1229c','8-1229c-note-8',2886]]) {
 const note=corpus.title8.sections.find(item=>item.section===section).notes.find(item=>item.id===id);
 const references=engine.generatedReferences(note.text,{...shared,kind:'usc',title:'8',section,sourceKind:'usc-note',sourceId:id,sourceText:note.text,sourceLayout:note.layout},note.references.filter(reference=>reference.provenance==='house-uslm-ref'));
 assert(!references.some(reference=>reference.start===offset&&reference.family==='usc'),'Internal executive-instrument subdivisions cannot inherit the hosting Code section');
 assert(references.some(reference=>reference.family==='usc'&&reference.targetTitle==='8'),'Keep the instrument\'s explicit Code citations');
}
const transitionAnchors=(transition.references||[]).filter(r=>r.provenance==='house-uslm-ref');
const transitionResults=engine.generatedReferences(transition.text,transitionContext,transitionAnchors);
const transitionBrowser=browser.INASearchLegalReferences.generatedReferences(transition.text,transitionContext,transitionAnchors);
const transitionReference=transitionResults.find(r=>r.start===16585&&r.end===16588);
assert.deepEqual(target(transitionReference),['public-law','104','208',['dC','tIII','s309','f','1']]);
assert.equal(transitionReference.resolution,'official-source-only');
assert.equal(transitionReference.officialUrl,'https://www.govinfo.gov/content/pkg/PLAW-105publ100/html/PLAW-105publ100.htm');
assert.match(transitionReference.citationNote||'',/added by.*105.*100/);
const browserException=transitionBrowser.find(r=>r.start===16585&&r.end===16588);
assert.deepEqual(JSON.parse(JSON.stringify(browserException)),JSON.parse(JSON.stringify(transitionReference)),'Source-bound exception must match in Node and browser');
const unbound=engine.generatedReferences(transition.text,{...transitionContext,sourceTextSha256:'0'.repeat(64)},transitionAnchors).find(r=>r.start===16585&&r.end===16588);
assert.notEqual(unbound?.ruleId,'embedded-exception','Changed source text must not silently retain a stale exception');
const transitionCorpus={title8:{sections:[structuredClone(corpus.title8.sections.find(s=>s.section==='1101'))]},cfr:{parts:[],sections:[]},legalReferenceExceptions:{...exceptions,exceptions:exceptions.exceptions.filter(e=>e.id==='usc-1101-note-17-pl-104-208-309-f-1')}};
engine.applyGeneratedLegalReferences(transitionCorpus);
const appliedTransition=transitionCorpus.title8.sections[0].notes.find(n=>n.id==='8-1101-note-17').references.find(r=>r.start===16585&&r.end===16588);
assert.deepEqual(target(appliedTransition),['public-law','104','208',['dC','tIII','s309','f','1']],'Whole-corpus traversal must bind the exception to the actual source-note identity');
assert.equal(appliedTransition.citationNote,transitionReference.citationNote);
require('./pack-legal-references').packLegalReferences(transitionCorpus);
require('./pack-legal-references').unpackLegalReferences(transitionCorpus);
const packedTransition=transitionCorpus.title8.sections[0].notes.find(n=>n.id==='8-1101-note-17').references.find(r=>r.start===16585&&r.end===16588);
assert.equal(packedTransition.officialUrl,transitionReference.officialUrl,'Standalone packing must retain the verified amending-law source, rather than reconstruct the unamended governing law');
assert.equal(packedTransition.citationNote,transitionReference.citationNote);
// Date-qualified CFR references must not preview an unverified current local
// edition. Retain the printed locator and identify the official link's scope.
for(const text of [
 'section 208.30 of title 8, Code of Federal Regulations (as in effect on January 1, 2018)',
 'section 214.2(h)(2)(i)(D) of title 8, Code of Federal Regulations (as in effect on the day before the date of the enactment of this Act)',
 'section 412.64(h)(4)(vi) of title 42, Code of Federal Regulations, as in effect for fiscal year 2018',
 'the rate in effect on September 30, 1995 (as described in section 412.352 of title 42 of the Code of Federal Regulations)'
]) {
 const refs=check(text,[],['usc','ina'],uscContext);
 assert.equal(refs.length,1,'The dated CFR provision must remain linked');
 assert.equal(refs[0].resolution,'official-source-only','A historical date must not expose current local CFR text as the cited version');
 assert.match(refs[0].citationNote||'',/historical version/i,'The link must disclose that the cited version is historical');
 assert.match(refs[0].citationNote||'',/current CFR section/i,'The link must disclose that its official destination is the current locator');
}
const currentCfrRefs=check('section 208.30 of title 8, Code of Federal Regulations applies. Other rules were as in effect on January 1, 2018.',[
 ['208.30',['cfr','8','208.30',[]]]
],['usc','ina'],uscContext);
assert.equal(currentCfrRefs[0].resolution,'local','An unrelated later date must not qualify a CFR citation');
assert(!currentCfrRefs[0].citationNote,'An unrelated later date must not add a historical-version notice');
const datedContainerRefs=check('paragraph (b) of section 208.30 of title 8, Code of Federal Regulations (as in effect on January 1, 2018)',[
 ['(b)',['cfr','8','208.30',['b']]],['208.30',['cfr','8','208.30',[]]]
],['usc','ina'],uscContext);
const datedPacked={title8:{sections:[{section:'1188',body:[{text:'paragraph (b) of section 208.30 of title 8, Code of Federal Regulations (as in effect on January 1, 2018)',references:datedContainerRefs}]}]}};
require('./pack-legal-references').packLegalReferences(datedPacked);
require('./pack-legal-references').unpackLegalReferences(datedPacked);
for(const reference of datedPacked.title8.sections[0].body[0].references) {
 assert.equal(reference.resolution,'official-source-only','Delivery must preserve the historical-version preview guard');
 assert.match(reference.citationNote||'',/current CFR section/i,'Delivery must preserve the historical-version link notice');
}

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

for (const id of ['8:208.13','8:208.16','8:1208.13','8:1208.16']) {
 const block=corpus.cfr.sections.find(s=>s.id===id).blocks.find(b=>b.x?.includes('section 319 of the Public Health Service Act, 42 U.S.C. 247d'));
 for (const [surface,destination] of [['319',['usc','42','247d',[]]],['564',['usc','21','360bbb-3',[]]]]) assert(block.xReferences.some(r=>r.text===surface&&JSON.stringify(target(r))===JSON.stringify(destination)),id+': '+surface+' must bind to its own Act and explicit Code codification');
}

const formerList=check('excluding former section 241(a)(2), (3), or (4) of the Act, as in effect prior to April 1, 1997.',[],[],{title:'8',chapter:'I',part:'240',section:'240.70'});
assert(formerList.some(r=>r.inaSection==='241'),'The former list must be represented');
assert(formerList.filter(r=>r.inaSection==='241').every(r=>r.resolution==='unresolved'),'An inferred 1994 archive cannot stand in for the expressly required final pre-1997 provision');
const effectiveList=check('section 320 or 322 of the Immigration and Nationality Act [8 U.S.C. 1431, 1433], as in effect on such effective date.',[],[],{kind:'usc',title:'8',section:'1431',sourceKind:'usc-note'});
assert(effectiveList.filter(r=>['1431','1433'].includes(r.targetSection)).every(r=>r.resolution==='unresolved'),'The effective-date qualifier after the whole list applies to both members');

check('§ 245a.3(b)(10) and/or (12) of this section', [['(12)',['cfr','8','245a.3',['b','12']]]],[],{title:'8',part:'245a',section:'245a.3',path:['b','7']});
check('paragraphs (h)(3)(i), (i), (j), (l)(1), and (l)(2) of this section', [['(i)',['cfr','8','245.15',['i']]]],[],{title:'8',part:'245',section:'245.15',path:['m']});

check('paragraph (1) of section 201(b) of this title', [['(1)',['public-law','107','56',['tIV','s201','b','1']]]],[],{kind:'usc',title:'8',section:'1182',quotedScope:{authority:{family:'public-law',title:'107',section:'56',path:['tIV','s411','c']},units:[]},enclosingAuthority:{family:'public-law',title:'107',section:'56',path:['tIV','s411','c']}});

const oldProceedings=check('section 242 or 242A of the Act (as in effect prior to April 1, 1997)',[],[],{title:'8',chapter:'V',part:'1245',section:'1245.10'});
assert.equal(oldProceedings.filter(r=>r.inaSection).length,2);
assert(oldProceedings.every(r=>r.resolution==='unresolved'),'A coordinated INA proceedings list shares its expressly stated former date');

const amendmentActText = 'section 9 of the Immigration and Nationality Act Amendments of 1976';
const amendmentAct = check(amendmentActText, [], ['ina'], { title:'8', part:'204', section:'204.7' });
assert(!amendmentAct.some(r=>r.family==='usc'&&r.targetSection==='9'), 'A longer amending Act name cannot become the base INA or an unrelated Code provision');
const unknownIna = check('INA 9', [], [], { title:'8', part:'204', section:'204.7' });
assert(unknownIna.length && unknownIna.every(r=>r.resolution!=='local'), 'An unmapped INA number must not be upgraded merely because the same U.S. Code number exists');
const caseText='8 U.S.C. 1101(a)(15)(u)';
const caseAnchor={id:'canonical-house-path',start:0,end:caseText.length,text:caseText,family:'usc',targetTitle:'8',targetSection:'1101',targetPath:['a','15','u'],houseHref:'/us/usc/t8/s1101/a/15/U',provenance:'house-uslm-ref',ruleId:'house-uslm-ref',resolution:'local'};
for(const api of [engine,browser.INASearchLegalReferences]) {
 const refs=api.generatedReferences(caseText,{...context,sourceText:caseText},[caseAnchor]);
 assert.deepEqual(Array.from(refs[0].targetPath),['a','15','U'],'Canonical House href and stored targetPath must identify the same uppercase U provision');
 assert.equal(refs[0].text,caseText,'Canonical target casing must not edit the printed source');
}

check('The benefits of subsection (a) of this section, except that contained in subdivision (2) thereof.', [['(2)',['usc','8','717',['a','2']]]], [], {kind:'usc',title:'8',section:'717',path:['c']});
check('The amendments made by paragraphs (2), (5), and (6) of subsection (b) shall apply.', [['(2)',['public-law','97','116',['s5','b','2']]],['(5)',['public-law','97','116',['s5','b','5']]],['(6)',['public-law','97','116',['s5','b','6']]]], [], {kind:'usc',title:'8',section:'1182',sourceKind:'usc-note',enclosingAuthority:{family:'public-law',title:'97',section:'116',path:['s5','c']},quotedScope:{authority:{family:'public-law',title:'97',section:'116',path:['s5','c']},units:[]}});
const newExceptionCorpus = {title8:{sections:[]},cfr:{parts:[],sections:structuredClone(corpus.cfr.sections.filter(s=>['8:204.7','8:209.2'].includes(s.id)))},legalReferenceExceptions:{...exceptions,exceptions:exceptions.exceptions.filter(e=>['cfr-8:204.7-0-amending-act-1976','cfr-8:209.2-8-refugee-definition'].includes(e.id))},inaCrosswalk:[],namedActs:corpus.namedActs};
engine.applyGeneratedLegalReferences(newExceptionCorpus);
const savings = newExceptionCorpus.cfr.sections.find(s=>s.id==='8:204.7').blocks[0].xReferences.find(r=>r.text===amendmentActText);
assert(savings,'The complete name of the 1976 amending Act must receive a verified reference');
assert.deepEqual(target(savings),['public-law','94','571',['s9']]);
assert.equal(savings.officialUrl,'https://www.govinfo.gov/link/statute/90/2707');
assert.match(savings.citationNote,/1976/);
const refugee = newExceptionCorpus.cfr.sections.find(s=>s.id==='8:209.2').blocks[8].xReferences.find(r=>r.text.includes('10l(a)(42)'));
assert.deepEqual(target(refugee),['usc','8','1101',['a','42']]);
assert.match(refugee.citationNote,/prints.*10l/);
const oldJurisdiction = exceptions.exceptions.find(e=>e.id==='usc-33-1321-n-reviewed-139');
assert.deepEqual(oldJurisdiction.target.path,['i','1'],'The verified old identity uses digit one while preserving the printed letter ell');
assert.equal(oldJurisdiction.resolution,'unresolved');
check('Pub. L. 105–277, div. C, title IV, § 421, div. G, title XXII, § 2222(e)', [['2222(e)',['public-law','105','277',['division-G','title-XXII','s2222','e']]]],[],{kind:'usc',title:'8',section:'1101',sourceField:'sourceCredit'});
check('Pub. L. 106–386, div. A, § 107(e)(1), (4), div. B, title V, §§ 1503(a), 1513(b)', [['1503(a)',['public-law','106','386',['division-B','title-V','s1503','a']]],['1513(b)',['public-law','106','386',['division-B','title-V','s1513','b']]]],[],{kind:'usc',title:'8',section:'1101',sourceField:'sourceCredit'});
check('Pub. L. 105–277, div. A, § 101(b) [title I, § 114], div. C, title IV, § 414(b)', [['414(b)',['public-law','105','277',['division-C','title-IV','s414','b']]]],[],{kind:'usc',title:'8',section:'1356',sourceField:'sourceCredit'});
check('29 CFR 1910.142(b)(2), (3), (9), (10), and (11), (c), (d)(1), (9), and (10)', [['(c)',['cfr','29','1910.142',['c']]]]);
check('Subject to paragraphs (f)(9)(i) and (ii) and (f)(10)(i) of this section and 8 CFR 274a.12(b)(6)(i) and (iii) and (c)(3)(iii), employment continues.', [['(iii)',['cfr','8','274a.12',['b','6','iii']]]],[],{title:'8',section:'214.2',part:'214',path:['f','8','viii']});
const headingLabel=check('(a) Applications under section 212(d)(3)(A)—(1) General. Applications may be filed.',[],[],{title:'8',section:'212.4',part:'212',chapter:'I',path:['a']});
assert(!headingLabel.some(r=>r.text==='(1)'), 'The em-dash run-in heading is not another statutory citation');
const oldCodeList=check('amending sections 1430, 1440 and 1440–1 of this title', [['1440–1',['usc','8','1440-1',[]]]],[],{kind:'usc',title:'8',section:'1440'});
assert(!oldCodeList.some(r=>r.targetSection==='1'), 'A numeric compound Code identifier must not become a separate suffix section');
for(const n of ['2','3','9']) {
 const refs=check(`Section 137–${n}, act Oct. 16, 1918, was repealed.`,[],[],{kind:'usc',title:'8',section:`137–${n}`,sourceKind:'usc-note'});
 assert(!refs.some(r=>r.targetSection===n), 'A removed compound section cannot become its suffix');
}
check('1998—Subsec. (b)(3). The Job Training Partnership Act was amended. 1997—Subsec. (b)(1)(C). Substituted “section 241(b)(3) of such Act” for prior text.', [['241(b)(3)',['usc','8','1231',['b','3']]]],[],{kind:'usc',title:'8',section:'1613',sourceKind:'usc-note',sourceTopic:'amendments',actSectionCodifications:new Map([['241:b/3',{family:'usc',title:'8',section:'1231',path:[]}]])});
const historicalHierarchy = check('Notwithstanding any provision in subchapter III of this chapter, naturalization under that subchapter is restricted.',[],[],{kind:'usc',title:'8',section:'1106',sourceField:'text',historicalUscSource:{versionLabel:'the retained former agricultural-worker provision'}});
assert.equal(historicalHierarchy.filter(r=>r.targetSubchapter==='III').length,2);
assert(historicalHierarchy.every(r=>r.resolution==='unresolved' && !r.officialUrl),'An old hierarchy must not navigate to the current chapter without a verified matching edition');
const historicalNoteRange=check('See section 1440(a)–(c) of this title.',[],[],{kind:'usc',title:'8',section:'724a',sourceKind:'usc-note',sourceField:'text',historicalUscSource:{versionLabel:'1948 act as corrected in 1949'}});
assert.deepEqual(historicalNoteRange.map(r=>r.targetPath),[['a'],['c']]);
assert(historicalNoteRange.every(r=>r.resolution==='unresolved'&&r.historicalEditionGuard&&!r.officialUrl),'Historical note ranges retain their source edition in Node and browser parsing');
const blankRoot=check('Aliens not within any other provisions of this paragraph (2).',[['(2)',['usc','8','137',['2']]]],[],{kind:'usc',title:'8',section:'137',path:['']});
check('a veteran (as defined in section 101, 1101, or 1301, or as described in section 107 of title 38)', [['1101',['usc','38','1101',[]]],['1301',['usc','38','1301',[]]]],[],{kind:'usc',title:'8',section:'1612'});
check('under section 6011 of the Internal Revenue Code of 1986 or regulations thereunder (or on reports filed by a State under section 418(e) of this title)', [['6011',['usc','26','6011',[]]]],[],{kind:'usc',title:'42',section:'413'});
check('Subsec. (a)(4). Substituted “child described in clause (ii) of subparagraph (E) or (F) of section 1101(b)(1) of this title”.', [['subparagraph (E)',['usc','8','1101',['b','1','E']]]],[],{kind:'usc',title:'8',section:'1433',sourceKind:'usc-note',sourceTopic:'amendments'});
check('Subsec. (c). Struck out “without regard to the provisions of subsection (a) of this section (other than paragraphs (3) and (9)(C))”.',[['(3)',['usc','8','1182',['a','3']]],['(9)(C)',['usc','8','1182',['a','9','C']]]],[],{kind:'usc',title:'8',section:'1182',sourceKind:'usc-note',sourceTopic:'amendments'});
check('Pub. L. 104–208, div. C, title VI, § 604(c), provided that: “The amendment made by subsection (a) applies.” Pub. L. 104–132, title IV, § 421(b), provided that: “The amendment made by subsection (a) applies.”', [['(a)',['public-law','104','132',['title-IV','s421','a']]]],[],{kind:'usc',title:'8',section:'1158',sourceKind:'usc-note',enclosingAuthority:{family:'public-law',title:'104',section:'208',path:['division-C','title-VI','s604','c']}});
check('Pub. L. 103–416, title I, § 102(e), as added by Pub. L. 104–208, div. C, title VI, § 671(b)(2), provided that the amendment made by subsection (a) applies.', [['(a)',['public-law','103','416',['title-I','s102','a']]]],[],{kind:'usc',title:'8',section:'1433',sourceKind:'usc-note'});
check('The program under section 132 of Public Law 101-649 is extended under the amendments made by subsection (a).', [['(a)',['public-law','103','416',['tII','s217','a']]]],[],{kind:'usc',title:'8',section:'1153',sourceKind:'usc-note',quotedScope:{authority:{family:'public-law',title:'103',section:'416',path:['tII','s217','b']},units:[]},enclosingAuthority:{family:'public-law',title:'103',section:'416',path:['tII','s217','b']}});
check('Pub. L. 108–447, div. J, title IV, § 424(a)(2), provided that: “The amendment made by paragraph (1) applies.”', [['(1)',['public-law','108','447',['division-J','title-IV','s424','a','1']]]],[],{kind:'usc',title:'8',section:'1182',sourceKind:'usc-note'});
check('Pub. L. 106–386, div. B, title V, § 1506(c)(1)(B), provided that: “The amendment made by subparagraph (A) applies.”', [['(A)',['public-law','106','386',['division-B','title-V','s1506','c','1','A']]]],[],{kind:'usc',title:'8',section:'1229a',sourceKind:'usc-note'});
check('The amendments made by paragraphs (1)(A) and (1)(B) apply.', [['(1)(A)',['public-law','102','232',['tIII','s309','a','1','A']]],['(1)(B)',['public-law','102','232',['tIII','s309','a','1','B']]]],[],{kind:'usc',title:'8',section:'1356',sourceKind:'usc-note',quotedScope:{authority:{family:'public-law',title:'102',section:'232',path:['tIII','s309','a','3']},units:[]}});
check('Pub. L. 104–208, div. C, title I, § 124(b)(2), provided that: “The amendment made by paragraph (1) applies.”', [['(1)',['public-law','104','208',['division-C','title-I','s124','b','1']]]],[],{kind:'usc',title:'8',section:'1182',sourceKind:'usc-note'});
check('Subsec. (c). Substituted “subsection (a) of this section (other than subparagraphs (A), (B), (C), or (E) of paragraph (3))” for prior text.', [['(A)',['usc','8','1182',['a','3','A']]],['(E)',['usc','8','1182',['a','3','E']]]],[],{kind:'usc',title:'8',section:'1182',sourceKind:'usc-note',sourceTopic:'amendments'});
check('Subsec. (c). Substituted “paragraphs (3) and (9)(C)” for “subparagraphs (A), (B), (C), or (E) of paragraph (3)”.', [['(3)',['usc','8','1182',['a','3']]],['(9)(C)',['usc','8','1182',['a','9','C']]]],[],{kind:'usc',title:'8',section:'1182',sourceKind:'usc-note',sourceTopic:'amendments'});
check('Amendment by section 1(a)(2) [title XI, § 1102(b), (d)(1)] of Pub. L. 106–553 applies.', [['1102(b)',['public-law','106','553',['title-XI','s1102','b']]],['(d)(1)',['public-law','106','553',['title-XI','s1102','d','1']]]],[],{kind:'usc',title:'8',section:'1184',sourceKind:'usc-note'});
check('repeal by Pub. L. 99–500, § 101(b) [title II, § 206(a), formerly § 206], Oct. 18, 1986', [['206(a)',['public-law','99','500',['title-II','s206','a']]]],[],{kind:'usc',title:'8',section:'1223',sourceKind:'usc-note'});
const incorporatedRepealer=check('repeal by Pub. L. 99–500, § 101(b) [title II, § 206(a), formerly § 206], Oct. 18, 1986, 100 Stat. 1783–39; renumbered § 206(a) and amended Pub. L. 100–525, § 4(b)(1), (3).',[],[],{kind:'usc',title:'8',section:'1223',sourceKind:'usc-note'});
assert.equal(incorporatedRepealer.filter(r=>r.text==='206(a)'&&r.targetCongress==='99'&&r.targetLaw==='500').length,2,'Renumbering preserves the underlying incorporated provision rather than assigning it to the later amending law');
check('renumbered section 244A as section 244, which is classified to section 1254a of this title.', [['section 244A',['usc','8','1254a',[]]]],[],{kind:'usc',title:'8',section:'1534',sourceKind:'usc-note'});
check('pursuant to section 1 [Div. C, Title XXXVI section 3646] of Public Law 106-398', [['3646',['public-law','106','398',['division-C','title-XXXVI','s3646']]]],[],{title:'20',part:'416',section:'416'});
const editorialActCorpus={title8:{sections:[{section:'1613',notes:[{topic:'referencesInText',text:'References in TextSection 243 of such Act, referred to in subsec. (b)(1)(C), is section 243 of act June 27, 1952, which is classified to section 1253 of this title. Section 1253 of this title was amended generally by Pub. L. 104–208, div. C, title III, § 307(a), Sept. 30, 1996, 110 Stat. 3009–612, and, as so amended, no longer contains a subsec. (h).'}],body:[{label:'a',text:'withholding under section 243(h) of such Act'}]}]},cfr:{parts:[],sections:[]}};
engine.applyGeneratedLegalReferences(editorialActCorpus);
const learnedOld=editorialActCorpus.title8.sections[0].body[0].references.find(r=>r.text.includes('243'));
assert.equal(learnedOld.targetSection,'1253');assert.deepEqual(learnedOld.targetPath,['h']);
assert.equal(learnedOld.resolution,'unresolved','The editorial note expressly distinguishes the replaced version');
assert(!editorialActCorpus.title8.sections[0].notes[0].references.some(r=>r.text.includes('243')&&r.targetVolume==='110'),'The later amending law publication cannot own the earlier Act section');
// Historical quotation fragments omit their external owner; a current path
// with the same labels is not evidence that it is the quoted provision.
for (const [id,section,expectedPath] of [
 ['usc-1101-note-5-former-inadmissibility-38756','1182',['a','11']],
 ['usc-1101-note-5-former-inadmissibility-38762','1182',['a','12']],
 ['usc-1101-note-5-former-inadmissibility-38772','1182',['a','31']],
 ['usc-1101-note-5-former-inadmissibility-38993','1182',['a','23']],
 ['usc-1157-note-4-security-ground-687','1182',['a','3','A']],
 ['usc-1157-note-4-security-ground-711','1182',['a','3','A']],
 ['usc-1255a-note-5-security-ground-4450','1182',['a','3']],
 ['usc-1372-note-4-former-registration-2055','1372',['e','1','A']],
 ['usc-1154-note-3-quoted-subclause-1228','1154',['a','1','B','i','II']],
 ['usc-1622-note-3-unverified-clause-972','1622',['b','3','C','i']],
 ['usc-1622-note-3-unverified-clause-979','1622',['b','3','C','ii']]
]) {
 const exception=exceptions.exceptions.find(e=>e.id===id);
 assert(exception,`Missing historical quotation correction ${id}`);
 assert.deepEqual(exception.target,{family:'usc',title:'8',section,path:expectedPath});
 assert.equal(exception.resolution,'unresolved');
 assert.equal(exception.officialUrl,'');
}
for (const offset of [75,494,569]) {
 const exception=exceptions.exceptions.find(e=>e.id===`usc-1440c-enacted-section-2-${offset}`);
 assert.deepEqual(exception?.target,{family:'public-law',title:'83',section:'86',path:['s2']});
 assert.equal(exception.historicalOfficialUrl,'https://www.govinfo.gov/content/pkg/STATUTE-67/pdf/STATUTE-67-Pg108.pdf#page=2');
}
const marriageGround=exceptions.exceptions.find(e=>e.id==='usc-1251-marriage-fraud-ground-4021');
assert.deepEqual(marriageGround?.target,{family:'usc',title:'8',section:'1251',path:['a','1','B'],edition:'1995'});
const former242B=check('section 242B(e) (1) through (4) of the Act', [], [], {title:'8',chapter:'I',section:'212.3',part:'212',path:['f','5']}).filter(r=>r.inaSection==='242B');
assert.deepEqual(former242B.map(r=>r.targetPath),[['e','1'],['e','4']]);
for(const ref of former242B) {
 assert.equal(ref.resolution,'local','The retained final historical body contains the exact former clauses');
 assert.equal(ref.officialUrl,corpus.title8.sections.find(s=>s.section==='1252b').historical.sourceUrl,'A historical INA crosswalk must use its captured archive, not the current repeal stub');
 assert.equal(ref.historicalOfficialUrl,ref.officialUrl);
 assert.match(ref.citationNote,/retained historical text/i);
 assert.match(ref.citationNote,/base source.*amendments/i);
}
check('Eligibility requirements found in paragraphs (k)(1) through (k)(3) of § 204.5.', [
 ['(k)(1)',['cfr','8','204.5',['k','1']]],
 ['(k)(3)',['cfr','8','204.5',['k','3']]]
], [], {title:'8',part:'204',section:'204.12',path:['c']});
check('At all steps in the disciplinary process provided in paragraph (a), sanctions shall be commensurate.', [
 ['(a)',['cfr','6','115.78',['a']]]
], [], {title:'6',part:'115',section:'115.78',path:['b']});
check('A principal beneficiary granted a renewal of employment authorization under paragraph (p)(3)(i) that remains valid.', [
 ['(p)(3)(i)',['cfr','8','204.5',['p','3','i']]]
], [], {title:'8',part:'204',section:'204.5',path:['p','3','ii']});
check('USCIS has received all of the required evidence in paragraph (d), and the time period will be reset.', [
 ['(d)',['cfr','8','204.11',['d']]]
], [], {title:'8',part:'204',section:'204.11',path:['g','1']});
const foreignParagraph = check('The requirement in paragraph (a) of the agreement applies.', [], [], {title:'6',section:'115.78',path:['b']});
assert(!foreignParagraph.some(r=>r.text==='(a)'), 'A written non-CFR owner must not inherit the containing CFR section');
const ambiguousParagraph = check('See paragraph (i).', [], [], {title:'8',section:'214.2',path:['f','1'],cfrPaths:new Set(['8:214.2:i','8:214.2:f/1/i'])});
assert(!ambiguousParagraph.some(r=>r.text==='(i)'), 'An unqualified label with two locally valid container depths must remain ambiguous');
check('The asylum application is filed after the period of time in 208.13(g) during which the alien entered.', [
 ['208.13(g)',['cfr','8','208.13',['g']]]
], [], {title:'8',part:'208',section:'208.35',path:['d','2','ii']});
check('Consistent with section 10(c) of the Administrative Procedure Act, 5 U.S.C. 704, the decision is final.', [
 ['10(c)',['usc','5','704',[]]]
], [], {title:'8',part:'103',section:'103.6',path:['f','1']});
const renumberedDeportability = exceptions.exceptions.find(e=>e.id==='cfr-8:214.2-28-reviewed-245');
const renumberedReferences = check(renumberedDeportability.sourceText, [
 ['section 241(a)(1)(C)(i) of the Act',['usc','8','1227',['a','1','C','i']]]
], [], {title:'8',part:'214',section:'214.2',path:['a','10'],sourceId:'cfr-8:214.2-28',sourceField:'x',
 embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))}).filter(r=>r.text==='section 241(a)(1)(C)(i) of the Act');
assert.equal(renumberedReferences.length,2,'Both preserved pre-IIRIRA citations receive the enacted redesignation');
assert(renumberedReferences.every(r=>r.resolution==='local'&&r.targetSection==='1227'&&/308\(g\)\(1\)/.test(r.citationNote)),
 'The current counterpart must carry the source-numbering explanation');
const physicianWaiverSource = corpus.cfr.sections.find(s=>s.id==='8:204.12').blocks.find(b=>b.a==='(d)(5)').x;
const physicianWaivers = check(physicianWaiverSource, [
 ['section 214(1) of the Act',['usc','8','1184',['l']]]
], [], {title:'8',part:'204',section:'204.12',path:['d','5'],sourceId:'cfr-8:204.12-26',sourceField:'x',
 embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))}).filter(r=>r.text==='section 214(1) of the Act');
assert.equal(physicianWaivers.length,2);
assert(physicianWaivers.every(r=>r.resolution==='local'&&r.targetPath.join('/')==='l'&&/lowercase/.test(r.citationNote)),
 'Both printed digit-one physician-waiver citations require the verified lowercase-l destination and a correction notice');
const truncatedParagraph = check('If evidence required in paragraph (e)(4), (e)(9) or (e)(10 of this section is unavailable, secondary evidence may be submitted.', [], [],
 {title:'8',part:'1245',section:'1245.13',path:['f']});
assert(!truncatedParagraph.some(r=>r.text==='(e)'&&r.targetPath.join('/')==='e'),
 'An incomplete adjacent numeric token must not silently broaden a malformed compound citation to its parent');
const secondaryEvidenceSource = corpus.cfr.sections.find(s=>s.id==='8:1245.13').blocks[71].x;
const secondaryEvidenceReferences = check(secondaryEvidenceSource, [
 ['(e)(4)',['cfr','8','1245.13',['e','4']]],
 ['(e)(9)',['cfr','8','1245.13',['e','9']]],
 ['(e)(10',['cfr','8','1245.13',['e','10']]]
], [], {title:'8',part:'1245',section:'1245.13',path:['f'],sourceId:'cfr-8:1245.13-71',sourceField:'x',
 embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))});
assert(secondaryEvidenceReferences.some(r=>r.text==='(e)(10'&&r.resolution==='local'&&/closing parenthesis/.test(r.citationNote)),
 'The reviewed missing parenthesis must retain the source wording and explain its exact destination');
check('The information required by items (ii) and (iii) shall be furnished only with respect to the initial entry. Item (ii) does not apply to a bona fide crewman.', [
 ['(ii)',['cfr','8','212.4',['a','1','ii']]],
 ['(iii)',['cfr','8','212.4',['a','1','iii']]]
], [], {title:'8',part:'212',section:'212.4',path:['a','1']});
const temporaryAdmissionSource = corpus.cfr.sections.find(s=>s.id==='8:212.15').blocks[157].x;
check(temporaryAdmissionSource, [
 ['8 CFR part 212(d)(1)',['cfr','8','212.15',['d','1']]]
], [], {title:'8',part:'212',section:'212.15',path:['n','2'],sourceId:'cfr-8:212.15-157',sourceField:'x',
 embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))});
check('An alien defined in section (101)(a)(15)(A)(iii) of the Act.', [
 ['section (101)(a)(15)(A)(iii) of the Act',['ina','8','1101',['a','15','A','iii']]]
], [], {title:'8',chapter:'I',part:'214',section:'214.2',path:['a','1']});
check('An alien defined in section (101)(a)(15)(G)(v) of the Act.', [
 ['section (101)(a)(15)(G)(v) of the Act',['ina','8','1101',['a','15','G','v']]]
], [], {title:'8',chapter:'I',part:'214',section:'214.2',path:['g','1']});
check('Pursuant to section 2242(d) of the Foreign Affairs Reform and Restructuring Act of 1998.', [
 ['2242(d)',['public-law','105','277',['division-G','subdivision-B','title-XXII','s2242','d']]]
]);
const ac21References = check('H-1B status under sections 106(a) and (b) of AC21, as amended by the 21st Century Department of Justice Appropriations Authorization Act.', [
 ['106(a)',['public-law','106','313',['title-I','s106','a']]],
 ['(b)',['public-law','106','313',['title-I','s106','b']]]
]);
assert(ac21References.filter(r=>r.targetLaw==='313').every(r=>r.resolution==='official-source-only'&&r.officialUrl==='https://uscode.house.gov/us/usc/t8/s1184/'&&/amended/.test(r.citationNote)),
 'AC21 extension provisions must open the amended text in the official Code notes');
const ac21Scope = require('./embedded-references').parseNumberedSectionReferences('sections 106(a) and (b) of AC21, as amended by the 21st Century Department of Justice Appropriations Authorization Act.')[0]?.scope;
assert.equal(ac21Scope?.text,'of AC21','An Act acronym ends before the separate amending instrument');
for (const [section,article,path] of [['204.301','6',['1']],['204.309','5',['c']],['204.313','5',['c']]]) {
 const wording=`The notice under article ${article}(${path[0]}) of the Convention applies.`;
 check(wording, [[`article ${article}(${path[0]}) of the Convention`,['instrument','Hague Adoption Convention, Article',article,path]]], [], {title:'8',chapter:'I',part:'204',section});
}
assert(!check('The notice under article 5(c) of the Convention applies.', [], [], {title:'8',part:'208',section:'208.18'}).some(r=>r.family==='instrument'),
 'A Hague adoption scope must not own a different Convention in the asylum regulations');
const proclamationTitle = 'Proclamation 10773 (as amended September 27, 2024), §';
for (const [section,block,path,expected] of [
 ['208.13',119,['g'],[['section 4(d)',['instrument',proclamationTitle,'4',['d']]],['section 2(a)',['instrument',proclamationTitle,'2',['a']]],['section 2(b)',['instrument',proclamationTitle,'2',['b']]]]],
 ['235.15',0,['a'],[['section 3(b)',['instrument',proclamationTitle,'3',['b']]]]]
]) {
 const source=corpus.cfr.sections.find(s=>s.id==='8:'+section).blocks[block].x;
 const references=check(source,expected,[],{title:'8',chapter:'I',section,path,sourceId:`cfr-8:${section}-${block}`,sourceField:'x',embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))});
 for(const ref of references.filter(r=>r.family==='instrument')) assert.equal(ref.resolution,'official-source-only');
 if(section==='208.13') assert.equal(references.filter(r=>r.family==='instrument'&&r.targetSection==='2'&&r.targetPath[0]==='a').length,2,'Both references to the amended suspension threshold retain the same destination');
}
const staffDefinitionTitle = '6 CFR 115.6, definition “sexual abuse of a detainee by a staff member, contractor, or volunteer,” paragraphs';
for(const section of ['115.76','115.176']) {
const staffDisciplineSection = corpus.cfr.sections.find(s=>s.id===`6:${section}`);
const staffDisciplineIndex = staffDisciplineSection.blocks.findIndex(b=>b.a==='(b)');
const staffDefinitionRefs = check(staffDisciplineSection.blocks[staffDisciplineIndex].x, [
 ['(1)-(4) and (7)-(8)',['instrument',staffDefinitionTitle,'1–4 and 7–8',[]]]
], [], {title:'6',part:'115',section,path:['b'],sourceId:`cfr-6:${section}-${staffDisciplineIndex}`,sourceField:'x',embeddedExceptions:new Map(exceptions.exceptions.map(e=>[e.id,e]))});
assert(staffDefinitionRefs.some(r=>r.family==='instrument'&&r.resolution==='official-source-only'),
 'Repeated numeric labels in separate definitions require the named-definition identity, not an invented section-level paragraph path');
}

console.log(`PASS authority regressions, Node/browser parity, and both visa-table checks (${rows41.length+rows42.length} visa rows).`);
