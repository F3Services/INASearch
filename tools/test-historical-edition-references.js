#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { applyHistoricalReferences } = require("./historical-ina");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");

const historical = (year, page) => ({
  versionLabel: `${year} U.S. Code, Title 8`,
  sourceArtifact: `sources/legal/raw/historical-usc/loc/${year}/chapter-09.pdf`,
  sourceUrl: `https://tile.loc.gov/example-${year}.pdf#page=${page}`
});
const old = {
  title: 8, section: "500", heading: "See 8 U.S.C. 243", preamble: "Compare 8 U.S.C. 244.",
  body: [{ label: "", text: "Under 8 U.S.C. 243(a), section 243 of this Act applies; see 8 U.S.C. 245 and section 243 of Public Law 70-100." }],
  historical: historical(1934, 9)
};
const sameEdition = { title: 8, section: "243", status: "repealed", heading: "Former provision", body: [{ label: "a", text: "Earlier rule." }], historical: historical(1934, 4) };
const changedEdition = { title: 8, section: "244", status: "repealed", heading: "Later provision", body: [], historical: historical(1946, 5) };
const current = { title: 8, section: "245", heading: "Current provision", body: [{ label: "a", text: "Current rule." }] };
const modernSource = { title: 8, section: "501", heading: "See 8 U.S.C. 245", body: [] };
const enactedSource = { title: 8, section: "502", heading: "See 8 U.S.C. 245", body: [], historical: {
  versionLabel: "Historical enacted text of Public Law 89-236",
  sourceArtifact: "sources/legal/raw/historical-usc/statutes/STATUTE-79-Pg911.pdf",
  sourceUrl: "https://www.govinfo.gov/content/pkg/STATUTE-79/pdf/STATUTE-79-Pg911.pdf"
} };
const former1254 = { title: 8, section: "1254", status: "repealed", heading: "Suspension of deportation", historical: historical(1995, 1),
  body: [{ label: "a", text: "The 1995 introductory rule.", children: [{ label: "3", text: "The former remedy." }] }] };
const datedSource = { title: 8, section: "1229a", heading: "Removal proceedings", body: [{ label: "c",
  text: "See section 1254(a)(3) of this title (as in effect on March 31, 1997)." }] };
const houseDatedText = "section 1254(a)(3) of this title (as in effect on March 31, 1997).";
const houseDatedSource = { title: 8, section: "1229b", heading: "Cancellation of removal", body: [{ label: "b", text: houseDatedText,
  references: [{ id: "house-date", start: 0, end: houseDatedText.indexOf(" of this title"),
    text: houseDatedText.slice(0, houseDatedText.indexOf(" of this title")), family: "usc", targetKind: "usc", targetTitle: "8",
    targetSection: "1254", targetPath: ["a", "3"], resolution: "local", houseHref: "/us/usc/t8/s1254/a/3",
    provenance: "house-uslm-ref", ruleId: "house-uslm-ref" }] }] };
const bracketedSource = { title: 8, section: "503", heading: "Amendment note", notes: [{ id: "n",
  text: "See section 244(a)(3) of this Act [former 8 U.S.C. 1254(a)(3)] (as in effect before April 1, 1997)." }] };
const corpus = { title8: { sections: [old, sameEdition, changedEdition, current, modernSource, enactedSource, former1254, datedSource, houseDatedSource, bracketedSource] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(corpus);

const allOldReferences = [old.headingReferences, old.preambleReferences, ...old.body.map(node => node.references)].flat();
const at = (references, phrase) => references.find(reference => reference.text === phrase);
for (const reference of [at(old.headingReferences, "8 U.S.C. 243"), at(old.body[0].references, "8 U.S.C. 243(a)")]) {
  assert(reference, "same-edition citation should be identified");
  assert.equal(reference.resolution, "official-source-only");
  assert.equal(reference.targetEdition, "1934");
  assert.equal(reference.officialUrl, sameEdition.historical.sourceUrl);
}
for (const target of ["244", "245"]) {
  const reference = allOldReferences.find(item => item.family === "usc" && item.targetSection === target);
  assert(!reference || reference.resolution === "unresolved", `1934 source must not link to non-1934 section ${target}`);
}
const actStart = old.body[0].text.indexOf("section 243 of this Act");
const actEnd = actStart + "section 243 of this Act".length;
assert(!old.body[0].references.some(reference => ["usc", "ina"].includes(reference.family) && reference.resolution !== "unresolved" && reference.start < actEnd && reference.end > actStart), `this Act must not become a Code link: ${JSON.stringify(old.body[0].references)}`);
assert(old.body[0].references.some(reference => reference.family === "public-law" && reference.targetCongress === "70" && reference.targetLaw === "100"), "printed Public Law citation must retain its original authority");
assert.equal(at(modernSource.headingReferences, "8 U.S.C. 245")?.resolution, "local", "modern source keeps ordinary local resolution");
assert.equal(at(enactedSource.headingReferences, "8 U.S.C. 245")?.resolution, "unresolved", "historical source without a Code edition must not inherit the present Code");
assert(corpus.legalReferenceAudit.historicalEdition?.unresolved >= 3, "audit should count blocked later or reused numbers");
assert(corpus.legalReferenceAudit.historicalEdition.issues.some(issue => issue.reason === "source-edition-unknown"));
const datedReference = datedSource.body[0].references.find(reference => reference.targetSection === "1254" && reference.targetPath.join("/") === "a/3");
assert(datedReference, "explicit as-of citation should retain its former Code target");
assert.equal(datedReference.targetSection, "1254");
assert.deepEqual(datedReference.targetPath, ["a", "3"]);
assert.equal(datedReference.resolution, "unresolved", "a 1995 body must not stand in for the law as of March 31, 1997");
assert.equal(datedReference.historicalEditionGuard, true);
assert(!datedReference.officialUrl);
const houseDatedReference = houseDatedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(houseDatedReference?.resolution, "unresolved");
assert.equal(houseDatedReference.provenance, "house-uslm-ref");
assert.equal(houseDatedReference.ruleId, "house-uslm-ref");
const bracketedReferences = bracketedSource.notes[0].references.filter(reference => reference.targetSection === "1254");
assert.equal(bracketedReferences.length, 2, "both the Act citation and bracketed Code parallel should be retained");
assert(bracketedReferences.every(reference => reference.resolution === "unresolved"), "the printed former-version context cannot open unverified text");

const verified1254 = { ...structuredClone(former1254), historical: {
  ...historical(1995, 1), sourceUrl:"https://www.govinfo.gov/content/pkg/USCODE-1995-title8/html/USCODE-1995-title8.htm", versionLabel: "Final former text as amended April 24, 1996",
  reviewStatus: "visually-reviewed", validFromDate: "1996-04-24", validThroughDate: "1997-03-31"
} };
const coveredDate = { title: 8, section: "1229a", heading: "Removal proceedings", body: [{ label: "c",
  text: "See section 1254(a)(3) of this title (as in effect on March 31, 1997)." }] };
const outsideDate = { title: 8, section: "1229b", heading: "Cancellation of removal", body: [{ label: "a",
  text: "See section 1254(a)(3) of this title (as in effect on April 1, 1997)." }] };
const verifiedCorpus = { title8: { sections: [verified1254, coveredDate, outsideDate] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(verifiedCorpus);
assert.match(coveredDate.body[0].references.find(reference => reference.targetSection === "1254")?.citationNote,/1995 base edition.*subsequent amendments/);
assert.equal(coveredDate.body[0].references.find(reference => reference.targetSection === "1254")?.resolution, "local", "a verified final text may serve a date inside its effective interval");
assert.equal(outsideDate.body[0].references.find(reference => reference.targetSection === "1254")?.resolution, "unresolved", "a date beyond the verified interval cannot use local text");

applyHistoricalReferences(corpus);
for (const target of ["244", "245"]) {
  const reference = allOldReferences.find(item => item.family === "usc" && item.targetSection === target);
  assert(!reference || (reference.resolution === "unresolved" && !reference.historicalTargetId),
    `final historical postpass must not restore a link to non-1934 section ${target}`);
}
assert.equal(at(old.body[0].references, "8 U.S.C. 243(a)")?.resolution, "official-source-only", "same-edition source stays official-only");
assert.equal(at(modernSource.headingReferences, "8 U.S.C. 245")?.resolution, "local", "modern source remains local after the historical postpass");
assert.equal(datedReference.resolution, "unresolved", "historical postpass must not restore a wrong-date local link");
assert(bracketedReferences.every(reference => reference.resolution === "unresolved"), "historical postpass must honor the parser's former-version decision");

packLegalReferences(corpus);
unpackLegalReferences(corpus);
const unpackedDate = datedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(unpackedDate?.resolution, "unresolved", "packed standalone data must retain the date guard");
assert.match(unpackedDate?.citationNote || "", /No text verified for that date/);
const unpackedHouseDate = houseDatedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(unpackedHouseDate?.resolution, "unresolved");
assert.equal(unpackedHouseDate?.ruleId, "house-uslm-ref", "guarded House citation must keep its rule through packing");
assert.equal(unpackedHouseDate?.provenance, "house-uslm-ref", "guarded House citation must keep its source provenance through packing");
assert.match(unpackedHouseDate?.citationNote || "", /No text verified for that date/);

console.log("PASS historical edition reference safeguard: exact edition, reused numbers, Act authority, and current-source isolation.");

// An unsupported historical edition must remain plain text after both delivery
// decoders; reconstructing a URL is not evidence that an archive exists.
const engine = require('./legal-references');
const missingArchiveText='8 U.S.C. 1182(a)(2)(1988)';
const missingArchiveRefs=engine.generatedReferences(missingArchiveText,{...engine.legalReferenceContext(corpus),kind:'usc',title:'8',section:'501',sourceText:missingArchiveText});
assert.equal(missingArchiveRefs[0].resolution,'unresolved');
const missingArchive={title8:{sections:[{section:'501',body:[{text:missingArchiveText,references:missingArchiveRefs}]}]}};
packLegalReferences(missingArchive);
const browserMissingArchive=structuredClone(missingArchive);
unpackLegalReferences(missingArchive);
assert.equal(missingArchive.title8.sections[0].body[0].references[0].resolution,'unresolved');
const fs=require('node:fs'),vm=require('node:vm');
const template=fs.readFileSync(require('node:path').join(__dirname,'../src/INASearch.template.html'),'utf8');
const api=require('./audit-ina-display').runtime(template,corpus);
api.hydratedLegalReferenceRoots=new WeakSet();
vm.runInContext(require('./test-function-source')(template,'hydrateLegalReferences'),api);
api.hydrateLegalReferences(browserMissingArchive,browserMissingArchive);
const hydrated=browserMissingArchive.title8.sections[0].body[0].references[0];
assert.equal(hydrated.resolution,'unresolved');
assert.equal(api.legalReferenceHtml(hydrated,hydrated.text),hydrated.text,'Unknown archive must not render a clickable link');
console.log('PASS unsupported historical editions stay unresolved through Node and browser packing');

const noteText = '8 U.S.C. 1522 note';
const noteCorpus = { title8: { sections: [{ title: 8, section: '501', body: [{ text: noteText }] }] },
  cfr: { sections: [] }, inaCrosswalk: [], namedActs: [], sources: {} };
engine.applyGeneratedLegalReferences(noteCorpus);
packLegalReferences(noteCorpus);
const browserNoteCorpus = structuredClone(noteCorpus);
unpackLegalReferences(noteCorpus);
api.hydrateLegalReferences(browserNoteCorpus, browserNoteCorpus);
for (const delivered of [noteCorpus, browserNoteCorpus]) {
  const note = delivered.title8.sections[0].body[0].references[0];
  assert.equal(note.targetNote, true, 'the statutory note locator survives delivery');
  assert.equal(note.resolution, 'official-source-only');
  assert.equal(api.legalReferenceCitation(note), '8 U.S.C. 1522 note');
  assert.equal(api.statutoryReferenceCrosswalk(note), null, 'a note must not be presented as the codified section body');
}
packLegalReferences(verifiedCorpus);
const browserVerifiedCorpus = structuredClone(verifiedCorpus);
unpackLegalReferences(verifiedCorpus);
api.hydrateLegalReferences(browserVerifiedCorpus, browserVerifiedCorpus);
for (const delivered of [verifiedCorpus, browserVerifiedCorpus]) {
  const ref = delivered.title8.sections[1].body[0].references[0];
  assert.equal(ref.resolution, 'local');
  assert.equal(ref.officialUrl, verified1254.historical.sourceUrl, 'the verified historical body retains its archive destination');
}
console.log('PASS note identity and verified historical archive survive Node and browser packing');

const archiveManifest=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../sources/legal/embedded-reference-exceptions.json'),'utf8'));
const archiveException=archiveManifest.exceptions.find(row=>row.sourceId==='usc-705-a-6'&&row.text==='(5)');
assert(archiveException, 'The source-bound 1950 self-reference is available');
const exceptionCorpus={title8:{sections:[{section:'705',body:[{label:'a',children:[{label:'5',text:'Historical target.'}]}]}]},
 legalReferenceExceptions:{...archiveManifest,exceptions:[archiveException]}};
const exceptionRefs=engine.generatedReferences(archiveException.sourceText,{...engine.legalReferenceContext(exceptionCorpus),
 kind:'usc',title:'8',section:'705',path:['a','6'],sourceId:archiveException.sourceId,sourceField:'text',sourceText:archiveException.sourceText});
const selected=exceptionRefs.find(r=>r.start===archiveException.start);
assert.equal(selected.officialUrl,'https://www.govinfo.gov/content/pkg/STATUTE-64/pdf/STATUTE-64-Pg987.pdf#page=27');
const delivery={title8:{sections:[{section:'705',body:[{text:archiveException.sourceText,references:[selected]}]}]}};
packLegalReferences(delivery);const browserDelivery=structuredClone(delivery);unpackLegalReferences(delivery);
api.hydrateLegalReferences(browserDelivery,browserDelivery);
for(const delivered of [delivery,browserDelivery]) {
 const ref=delivered.title8.sections[0].body[0].references[0];
 assert.equal(ref.officialUrl,selected.officialUrl,'The verified enacted source must survive both delivery decoders');
 assert(api.legalReferenceHtml(ref,ref.text).includes('STATUTE-64-Pg987.pdf#page=27'),'The rendered official-source action must use the verified archive');
}
console.log('PASS source-bound historical archive survives Node/browser delivery and rendered source action');

const olderLawText='section 4 of Public Law 70-100';
const olderLaw={title8:{sections:[{section:'1188',body:[{text:olderLawText}]}]},inaCrosswalk:[],namedActs:[],sources:{},cfr:{sections:[]}};
engine.applyGeneratedLegalReferences(olderLaw);
const olderLawRef=olderLaw.title8.sections[0].body[0].references[0];
assert(!olderLawRef.officialUrl.includes('/PLAW-70publ100'),'Pre-104 Congress laws cannot use unavailable slip-law packages');
assert.match(olderLawRef.officialUrl,/govinfo.gov\/app\/search\//);
assert.match(olderLawRef.citationNote,/search/i);
const customFallback={start:0,end:12,text:'INA 244A',family:'ina',targetSection:'244A',targetPath:[],resolution:'official-source-only',ruleId:'explicit-ina',officialUrl:'https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act'};
olderLaw.title8.sections[0].body.push({text:'INA 244A',references:[customFallback]});
packLegalReferences(olderLaw);const olderLawBrowser=structuredClone(olderLaw);unpackLegalReferences(olderLaw);api.hydrateLegalReferences(olderLawBrowser,olderLawBrowser);
for(const delivered of [olderLaw,olderLawBrowser]) {
 const [law,fallback]=delivered.title8.sections[0].body.map(node=>node.references[0]);
 assert.equal(law.officialUrl,olderLawRef.officialUrl);
 assert.match(law.citationNote,/search/i);
 assert.equal(fallback.officialUrl,customFallback.officialUrl,'Delivery cannot invent a Code target for an unmapped INA provision');
}
console.log('PASS older Public Laws use a labeled official search and custom official destinations survive delivery');

const irca=engine.generatedReferences('section 403(a)(4)(D) of Public Law 99-603',{kind:'usc',title:'8',section:'1188'}).find(r=>r.family==='public-law');
assert.equal(irca.officialUrl,'https://www.govinfo.gov/content/pkg/STATUTE-100/pdf/STATUTE-100-Pg3445.pdf','Use the verified IRCA archive, not a guessed printed-page filename');
const statutes=engine.generatedReferences('66 Stat. 280',{kind:'usc',title:'8',section:'1429'}).find(r=>r.family==='statutes-at-large');
assert.equal(statutes.officialUrl,'https://www.govinfo.gov/link/statute/66/280','The official citation service locates the verified interior INA page');
assert.match(statutes.citationNote,/printed page/);
const oldHouse={title8:{sections:[{body:[{text:'66 Stat. 280',references:[{...statutes,houseHref:'/us/stat/66/280',provenance:'house-uslm-ref',historicalOfficialUrl:undefined,citationNote:undefined,officialUrl:'https://www.govinfo.gov/app/details/STATUTE-66/STATUTE-66-Pg280'}]}]}]}};
packLegalReferences(oldHouse);const oldHouseBrowser=structuredClone(oldHouse);unpackLegalReferences(oldHouse);api.hydrateLegalReferences(oldHouseBrowser,oldHouseBrowser);
for(const delivered of [oldHouse,oldHouseBrowser]) assert.equal(delivered.title8.sections[0].body[0].references[0].officialUrl,statutes.officialUrl);

// A grouped House repeal record may have the first section's current URL.
// Historical delivery must use the individual provision's captured archive.
const registryArchive = 'https://tile.loc.gov/example-1964.pdf#page=95';
const registrySource = { section: '1486', status: 'repealed', historical: historical(1964, 96), body: [{ text: 'section 1485(1)', references: [{ start: 0, end: 15, text: 'section 1485(1)', family: 'usc', targetTitle: '8', targetSection: '1485', targetPath: ['1'], resolution: 'local', ruleId: 'historical-reviewed-reference' }] }] };
const registryDestination = { section: '1485', status: 'repealed', url: 'https://example.test/current1484', historical: { ...historical(1964, 95), sourceUrl: registryArchive, originalTitle: 'Historical exception' }, body: [{ label: '1', text: 'Retained historical rule.' }] };
const registryCorpus = { title8: { sections: [registrySource, registryDestination] }, legalReferenceMetadata: { rules: [] } };
applyHistoricalReferences(registryCorpus);
let registryReference = registrySource.body[0].references[0];
assert.equal(registryCorpus.historicalReferenceTargets[registryReference.historicalTargetId].url, registryArchive, 'Grouped current House URL must not replace the captured historical destination');
assert.equal(registryReference.historicalOfficialUrl, registryArchive, 'Historical postpass references need an archive that survives packing');
packLegalReferences(registryCorpus);
const browserRegistry = structuredClone(registryCorpus);
unpackLegalReferences(registryCorpus); api.hydrateLegalReferences(browserRegistry, browserRegistry);
for (const delivered of [registryCorpus, browserRegistry]) {
 const reference = delivered.title8.sections[0].body[0].references[0];
 assert.equal(reference.officialUrl, registryArchive);
 assert.equal(delivered.historicalReferenceTargets[reference.historicalTargetId].url, registryArchive);
}
const datedRegistrySource = { section: '139', historical: historical(1946, 15), body: [{ text: '(h)', references: [{ start: 0, end: 3, text: '(h)', family: 'usc', targetTitle: '8', targetSection: '136', targetPath: ['h'], targetEdition: '1946', historicalOfficialUrl: 'https://tile.loc.gov/1946-code.pdf#page=10', resolution: 'official-source-only', ruleId: 'embedded-exception' }] }] };
const datedRegistryCorpus = { title8: { sections: [datedRegistrySource, { section: '136', status: 'repealed', url: 'https://example.test/current132', historical: historical(1946, 10), body: [{ label: 'h', text: 'Historical exclusions.' }] }] }, legalReferenceMetadata: { rules: [] } };
applyHistoricalReferences(datedRegistryCorpus);
assert(!datedRegistrySource.body[0].references[0].historicalTargetId, 'An explicit edition already supplies its preview identity and must not acquire a conflicting registry wrapper');
const replacedSource = { section: '1459', historical: historical(1988, 1), body: [{ text: 'section 1450(a)', references: [{ start: 0, end: 15, text: 'section 1450(a)', family: 'usc', targetTitle: '8', targetSection: '1450', targetPath: ['a'], resolution: 'official-source-only', ruleId: 'historical-reviewed-reference' }] }] };
const replacedCorpus = { title8: { sections: [replacedSource] }, legalReferenceMetadata: { rules: [] } };
applyHistoricalReferences(replacedCorpus);
assert.match(replacedCorpus.historicalReferenceTargets[1].message, /407\(d\)\(17\)/, 'The general revision of clerk functions is section 407(d)(17)');
console.log('PASS historical registry delivery preserves individual archives and explicit editions.');
const guardedRegistrySource = { section: '1251', status:'transferred', historical:historical(1995,1), body:[{label:'a',text:'(a)',references:[{start:0,end:3,text:'(a)',family:'usc',targetTitle:'8',targetSection:'1251',targetPath:['a'],resolution:'unresolved',officialUrl:'',citationNote:'No matching historical destination has been verified.',ruleId:'embedded-exception'}]}]};
const guardedRegistryCorpus={title8:{sections:[guardedRegistrySource]},legalReferenceMetadata:{rules:[]}};
applyHistoricalReferences(guardedRegistryCorpus);
assert.equal(guardedRegistrySource.body[0].references[0].resolution,'unresolved','The historical postpass cannot override a reviewed abstention simply because a same-number body exists');
assert(!guardedRegistrySource.body[0].references[0].historicalTargetId);

const hierarchyDelivery = { title8: { sections: [{ body: [
 { text:'section 321(b)', references:[{start:0,end:14,text:'section 321(b)',family:'public-law',targetCongress:'104',targetLaw:'208',targetPath:['division-C','title-III','s321','b'],resolution:'official-source-only',ruleId:'house-uslm-ref',provenance:'house-uslm-ref',houseHref:'/us/pl/104/208/s321/b'}] },
 { text:'section 5902(b)', references:[{start:0,end:15,text:'section 5902(b)',family:'public-law',targetCongress:'117',targetLaw:'263',targetPath:['dE','tLIX','s5902','b'],resolution:'official-source-only',ruleId:'house-uslm-ref',provenance:'house-uslm-ref',houseHref:'/us/pl/117/263/s5902/b'}] },
 { text:'8 U.S.C. 1254', references:[{start:0,end:13,text:'8 U.S.C. 1254',family:'usc',targetTitle:'8',targetSection:'1254',targetPath:[],resolution:'unresolved',officialUrl:'',citationNote:'No matching historical edition is verified.',ruleId:'ambiguous-antecedent',provenance:'deterministic-context'}] }
] }] } };
const originalDelivery = structuredClone(hierarchyDelivery);
vm.runInContext(require('./test-function-source')(template,'expandPackedHouseHref'),api);
packLegalReferences(hierarchyDelivery);
const browserHierarchyDelivery = structuredClone(hierarchyDelivery);
unpackLegalReferences(hierarchyDelivery); api.hydrateLegalReferences(browserHierarchyDelivery,browserHierarchyDelivery);
for (const delivered of [hierarchyDelivery,browserHierarchyDelivery]) {
 delivered.title8.sections[0].body.forEach((node,index)=>{
  const reference=node.references[0], original=originalDelivery.title8.sections[0].body[index].references[0];
  assert.deepEqual(Array.from(reference.targetPath),original.targetPath,'House href shorthand must not discard an enriched Public Law division or title');
  if(index<2) assert(api.legalReferenceHtml(reference,node.text).includes(`data-reference-path="${JSON.stringify(original.targetPath).replace(/"/g,'&quot;')}"`),'Rendered navigation must retain the complete Public Law hierarchy');
  else {
   assert.equal(reference.officialUrl,'','An explicitly absent official destination must remain absent after delivery');
   assert.equal(reference.provenance,'deterministic-context','Ambiguous antecedent provenance must match in Node and browser');
   assert(!api.legalReferenceHtml(reference,node.text).includes('<a'),'Unresolved citations remain plain text');
  }
 });
}
console.log('PASS complete Public Law hierarchy, empty destinations, and provenance survive Node/browser delivery.');

const canonicalText='8 U.S.C. 1101(a)(15)(u)';
const canonicalCorpus={title8:{sections:[
 {section:'1101',body:[{label:'a',children:[{label:'15',children:[{label:'U',text:'The U classification.'}]}]}]},
 {section:'1255',notes:[{text:canonicalText,references:[{start:0,end:canonicalText.length,text:canonicalText,family:'usc',targetTitle:'8',targetSection:'1101',targetPath:['a','15','u'],houseHref:'/us/usc/t8/s1101/a/15/U',provenance:'house-uslm-ref',ruleId:'house-uslm-ref'}]}]}
]},cfr:{parts:[],sections:[]}};
applyGeneratedLegalReferences(canonicalCorpus);
packLegalReferences(canonicalCorpus);
const canonicalBrowser=structuredClone(canonicalCorpus);
unpackLegalReferences(canonicalCorpus);api.hydrateLegalReferences(canonicalBrowser,canonicalBrowser);
for(const delivered of [canonicalCorpus,canonicalBrowser]) {
 const ref=delivered.title8.sections[1].notes[0].references[0];
 assert.deepEqual(Array.from(ref.targetPath),['a','15','U']);
 assert.equal(ref.text,canonicalText,'Canonical destination case does not alter printed source case');
 assert(api.legalReferenceHtml(ref,ref.text).includes('1101(a)(15)(U)'),'The delivered action opens the actual uppercase U provision');
}
console.log('PASS canonical House destination case survives Node/browser delivery and action rendering');

for (const [path, label] of [
 [['s2'], 'Public Law 83-86, § 2'],
 [['division-C','title-III','s321','b'], 'Public Law 104-208, Division C, Title III, § 321(b)'],
 [['dE','tLIX','s5902','b'], 'Public Law 117-263, Division E, Title LIX, § 5902(b)']
]) {
 const [congress,law]=path[0]==='s2'?['83','86']:path[0]==='dE'?['117','263']:['104','208'];
 const ref={family:'public-law',targetCongress:congress,targetLaw:law,targetPath:path,resolution:'official-source-only',officialUrl:'https://www.govinfo.gov/example.pdf#page=2'};
 assert.equal(api.legalReferenceCitation(ref),label,'Public Law action labels must include the exact section and enclosing containers');
 assert(api.legalReferenceHtml(ref,'section 2 of this Act').includes(`data-reference-citation="${label}"`),'The rendered action must carry the complete legal locator');
}

const subdivisionReference={family:'public-law',targetCongress:'105',targetLaw:'277',targetPath:['division-G','subdivision-B','title-XXII','s2226','a'],resolution:'official-source-only',officialUrl:'https://www.govinfo.gov/app/details/PLAW-105publ277'};
const subdivisionLabel='Public Law 105-277, Division G, Subdivision B, Title XXII, § 2226(a)';
const subdivisionBefore=structuredClone(subdivisionReference);
assert.equal(api.legalReferenceCitation(subdivisionReference),subdivisionLabel,'A Public Law subdivision is part of the complete citation label');
const subdivisionHtml=api.legalReferenceHtml(subdivisionReference,'§ 2226(a)');
assert(subdivisionHtml.includes(`data-reference-citation="${subdivisionLabel}"`),'The rendered citation action must include the subdivision');
assert(subdivisionHtml.includes('subdivision-B')&&subdivisionHtml.includes('PLAW-105publ277'),'Label formatting must preserve the action path and official URL');
assert.deepEqual(subdivisionReference,subdivisionBefore,'Formatting must not retarget or mutate the stored reference');

const retainedArchive='https://uscode.house.gov/view.xhtml?req=granuleid:USC-1995-title8-section1252b&num=0&edition=1995';
const retainedCrosswalkCorpus={title8:{sections:[{section:'1252b',status:'repealed',historical:{sourceUrl:retainedArchive,versionLabel:'Final text immediately before repeal effective 1997-04-01'},body:[{label:'e',children:[{label:'1',text:'Failure to appear.'},{label:'4',text:'Asylum hearing.'}]}]}]},
 inaCrosswalk:[{inaSection:'242B',uscSection:'1252b',historicalMapping:true}],
 cfr:{parts:[],sections:[{id:'8:212.3',title:'8',chapter:'I',part:'212',section:'212.3',blocks:[{t:'p',a:'(f)(5)',x:'The barring acts in section 242B(e) (1) through (4) of the Immigration and Nationality Act.'}]}]}};
applyGeneratedLegalReferences(retainedCrosswalkCorpus);
packLegalReferences(retainedCrosswalkCorpus);
const retainedBrowser=structuredClone(retainedCrosswalkCorpus);
unpackLegalReferences(retainedCrosswalkCorpus);api.hydrateLegalReferences(retainedBrowser,retainedBrowser);
for(const delivered of [retainedCrosswalkCorpus,retainedBrowser]) {
 const refs=delivered.cfr.sections[0].blocks[0].xReferences;
 assert.equal(refs.length,2);
 assert.deepEqual(Array.from(refs,r=>Array.from(r.targetPath)),[['e','1'],['e','4']]);
 for(const ref of refs) {
  assert.equal(ref.resolution,'local','A retained historical body remains available locally');
  assert.equal(ref.officialUrl,retainedArchive,'The source action uses the historical archive');
  assert.equal(ref.historicalOfficialUrl,retainedArchive);
  assert.match(ref.citationNote,/retained historical text.*base source.*amendments/i);
  assert(api.legalReferenceHtml(ref,ref.text).includes('USC-1995-title8-section1252b'),'Rendered source metadata must preserve the historical archive');
 }
}
console.log('PASS historical INA crosswalk archives and notices survive Node/browser delivery');

const crossTitleText='Pub. L. 101-649, title I, § 124, provided that: “The amendment in section 206(b)(2) of this Act applies. Section 123 of this title also applies.”';
const crossTitleCorpus={title8:{sections:[{section:'1153',notes:[{text:crossTitleText,references:[{start:0,end:crossTitleText.indexOf(', provided'),text:crossTitleText.slice(0,crossTitleText.indexOf(', provided')),houseHref:'/us/pl/101/649/tI/s124',family:'public-law',targetCongress:'101',targetLaw:'649',targetPath:['tI','s124'],resolution:'official-source-only',provenance:'house-uslm-ref',ruleId:'house-uslm-ref'}],layout:[{tag:'p',start:0,end:crossTitleText.length,children:[{tag:'ref',start:0,end:crossTitleText.indexOf(', provided'),href:'/us/pl/101/649/tI/s124'},{tag:'quotedContent',start:crossTitleText.indexOf('“'),end:crossTitleText.length,origin:'/us/pl/101/649/tI/s124'}]}]}]}]},cfr:{parts:[],sections:[]}};
applyGeneratedLegalReferences(crossTitleCorpus);
packLegalReferences(crossTitleCorpus);
const crossTitleBrowser=structuredClone(crossTitleCorpus);
unpackLegalReferences(crossTitleCorpus);api.hydrateLegalReferences(crossTitleBrowser,crossTitleBrowser);
for(const delivered of [crossTitleCorpus,crossTitleBrowser]) {
 const refs=delivered.title8.sections[0].notes[0].references;
 const cross=refs.find(ref=>ref.text.includes('206(b)(2)'));
 const sameTitle=refs.find(ref=>ref.text.includes('123'));
 assert.deepEqual(Array.from(cross.targetPath),['s206','b','2'],'This Act cannot project the citing section’s title onto a different section');
 assert.deepEqual(Array.from(sameTitle.targetPath),['tI','s123'],'An explicit this-title citation retains its title container');
 assert.equal(cross.targetCongress,'101');assert.equal(cross.targetLaw,'649');
 assert(!api.legalReferenceCitation(cross).includes('Title I'),'The rendered action must not claim an unsupported title ancestor');
}
console.log('PASS cross-section Act scope is distinct from explicit title scope through Node/browser delivery');
