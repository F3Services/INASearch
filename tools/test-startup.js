#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const packing = require("../src/INASearch-Corpus-Packing");
const shards = require("../src/INASearch-Corpus-Shards");
const command = require("../src/INASearch-Command");
const { readBuildCorpus } = require("./read-build-corpus");
const full = readBuildCorpus(require.resolve("../INASearch.html"));
const { metadata, chunks } = shards.partitionPackedCorpus(full);
const mapping = metadata._shards;
const headings = metadata;
function startup(elements = new Map(), marks = []) {
  const context = { INASearchCorpusPacking: packing, INASearchCorpusShards: shards, INA_SEARCH_COMMAND: command,
    crypto: globalThis.crypto, DecompressionStream, Blob, Response, TextDecoder, TextEncoder, Uint8Array, atob, setTimeout,
    document: { readyState: "loading", getElementById: id => elements.has(id) ? {} : null, addEventListener() {}, removeEventListener() {} }, INA_SEARCH_MARK_PERFORMANCE: (name, detail) => marks.push({ name, detail }) };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/INASearch-Startup"), "utf8"), context);
  for (const id of elements.keys()) if (id) context.INASearchStartup.register(id);
  return context;
}
const select = startup().INASearchStartup.openingChunks;
for (const [query, kind, recordId] of [
  ["101a15h2a", "usc", "8-1101"], ["I.N.A. 101(a)(15)(H)(ii)(a)", "usc", "8-1101"],
  ["8usc1101a15h2a", "usc", "8-1101"], ["1101a15h2a", "usc", "8-1101"],
  ["8 U.S.C. 1 to 18", "usc", "8-1"], ["8 U.S.C. 1 to 18", "usc", "8-18"],
  ["61 to 65", "usc", "8-61"], ["61 to 65", "usc", "8-65"],
  ["INA 329A", "usc", "8-1440–1"], ["INA 401", "usc", "8-1106"], ["INA 242A", "usc", "8-1252a"],
  ["8cfr214.2h13iiia", "cfr", "8:214.2"], ["214.2h13iiia", "cfr", "8:214.2"],
  ["8 CFR 214.2(h)(2)", "cfr", "8:214.2"]
]) {
  const records = kind === "usc" ? headings.title8.sections : headings.cfr.sections;
  const index = records.findIndex(record => record.id === recordId);
  assert(index >= 0, `${query}: missing fixture ${recordId}`);
  assert(select(headings, mapping, query).includes(mapping[kind][index]), `${query}: opening body was not selected`);
}
assert.equal(select(headings, mapping, "president"), null);
assert.deepEqual([...select(headings, mapping, "")], []);
assert.deepEqual([...select(headings, mapping, "about")], []);
assert.equal(select(headings, mapping, '"about"'), null);
assert.deepEqual([...select(headings, mapping, "INA Title II")], []);
const combined = select(headings, mapping, "101a15h2a,8cfr214.2h13iiia");
assert(combined.includes(mapping.usc[headings.title8.sections.findIndex(record => record.id === "8-1101")]));
assert(combined.includes(mapping.cfr[headings.cfr.sections.findIndex(record => record.id === "8:214.2")]));
async function checkFallbackPersistence(rejectLoading = false, legacy = false) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    let embeddedBaselineFallbackScheduled"), template.indexOf("    function createSearchWorkerClient()"));
  let resolveComplete, rejectComplete;
  const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
  const saved = [];
  const corpus = { title8: { sections: [{ id: "8-1101" }] } };
  const context = { corpus, corpusManifest: {}, loadErrors: {}, Blob,
    requestIdleCallback: callback => callback(),
    INASearchStorage: { ensureActiveCorpus: value => saved.push(structuredClone(value)) },
    INA_SEARCH_CORPUS_LOAD_SOURCE: legacy ? "indexeddb" : "embedded", INA_SEARCH_CORPUS_FULLY_LOADED: false,
    INA_SEARCH_ACTIVE_CORPUS_RECORD: legacy ? { recordSchemaVersion: 2, sourceCorpusSha256: "legacy-identity", legalReferencesPacked: false, sourceState: { authority: "updated-cfr" } } : null,
    INA_SEARCH_CORPUS_COMPLETE: complete };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source + "\nscheduleEmbeddedBaselinePersistence();", context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, 0, "Worker failure persisted a partially loaded corpus");
  if (rejectLoading) rejectComplete(new Error("Background content could not be verified"));
  else {
    corpus.title8.sections[0].body = "Verified complete statutory text";
    context.INA_SEARCH_CORPUS_FULLY_LOADED = true;
    resolveComplete();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, rejectLoading ? 0 : 1, "Fallback persistence ignored the background load outcome");
  if (!rejectLoading) assert.equal(saved[0].title8.sections[0].body, "Verified complete statutory text");
}
async function checkNoteMetadataUpgrade(hierarchyOnly = false) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    function corpusRequiresEmbeddedUpgrade"), template.indexOf("    if (loadedCorpus && !corpus)"));
  const embedded = { legalReferenceMetadata: { cfrHierarchyVersion: 1, uscHierarchyVersion: 1 }, title8: { runInRevision: 1, houseFootnoteMetadata: { noteLayoutRevision: 1 } }, cfr: { currentThrough: { 8: "2026-01-01" } } };
  const previous = structuredClone(embedded);
  if (hierarchyOnly) delete previous.legalReferenceMetadata.uscHierarchyVersion;
  else delete previous.title8.houseFootnoteMetadata.noteLayoutRevision;
  previous.cfr = { currentThrough: { 8: "2026-02-01" }, parts: [{ id: "8:214" }] };
  previous.corpusVersion = "newer-cfr-download";
  const context = { corpus: previous, build: { cfrHierarchyVersion: 1, uscHierarchyVersion: 1, statuteRunInRevision: 1, statuteNoteLayoutRevision: 1 },
    loadEmbeddedINASearchCorpus: async () => structuredClone(embedded), isValidCorpus: () => true, hydrateLegalReferences() {},
    INA_SEARCH_CORPUS_COMPLETE: Promise.resolve(), INASearchLegalReferences: { applyCfrReferences() {} }, TextEncoder,
    INASearchStorage: { sha256Bytes: async bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex") } };
  context.window = context;
  vm.createContext(context);
  await vm.runInContext(`(async () => { ${source} })()`, context);
  assert.equal(context.corpus.title8.houseFootnoteMetadata.noteLayoutRevision, 1, "An existing cache must receive the structured editorial notes");
  assert.equal(context.corpus.legalReferenceMetadata.uscHierarchyVersion, 1, "An existing cache must receive chapter and subchapter references");
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE, "upgraded-cache");
  assert.equal(context.corpus.cfr.currentThrough[8], "2026-02-01", "The note upgrade must preserve newer downloaded regulations");
  assert.equal(context.INA_SEARCH_UPGRADED_CORPUS_SHA256, require("node:crypto").createHash("sha256").update(JSON.stringify(context.corpus)).digest("hex"), "An upgraded reader must identify its new content with the same hash used by its next cached startup.");
}
async function checkTrailingCfrReferenceUpgrade(previousVersion = 5) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    function corpusRequiresEmbeddedUpgrade"), template.indexOf("    if (loadedCorpus && !corpus)"));
  const dated = previousVersion === 6;
  const text = dated ? "section 208.30 of title 8, Code of Federal Regulations (as in effect on January 1, 2018)"
    : "section 655.202(b)(6) of title 20, Code of Federal Regulations";
  const embedded = { title8: { sections: [{ section: "1188", body: [{ text }] }] }, cfr: { currentThrough: {}, parts: [], sections: [] } };
  const engine = require("./legal-references");
  engine.applyGeneratedLegalReferences(embedded);
  const previous = structuredClone(embedded);
  previous.legalReferenceMetadata.cfrHierarchyVersion = previousVersion;
  const staleReference = previous.title8.sections[0].body[0].references[0];
  if (dated) {
    staleReference.resolution = "local";
    delete staleReference.citationNote;
  } else Object.assign(staleReference, { family: "usc", targetKind: "usc", officialUrl: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title20-section655.202" });
  const context = { corpus: previous, build: {
    cfrHierarchyVersion: embedded.legalReferenceMetadata.cfrHierarchyVersion,
    uscHierarchyVersion: embedded.legalReferenceMetadata.uscHierarchyVersion
  }, loadEmbeddedINASearchCorpus: async () => structuredClone(embedded), isValidCorpus: () => true,
  hydrateLegalReferences() {}, INA_SEARCH_CORPUS_COMPLETE: Promise.resolve(), TextEncoder,
  INASearchLegalReferences: engine,
  INASearchStorage: { sha256Bytes: async bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex") } };
  context.window = context;
  vm.createContext(context);
  await vm.runInContext(`(async () => { ${source} })()`, context);
  const reference = context.corpus.title8.sections[0].body[0].references[0];
  assert.equal(reference.family, "cfr", "A saved corpus with the former trailing-title parser must receive the corrected CFR owner");
  assert.equal(reference.targetTitle, dated ? "8" : "20");
  assert.equal(reference.targetSection, dated ? "208.30" : "655.202");
  assert.deepEqual(reference.targetPath, dated ? [] : ["b", "6"]);
  assert.equal(reference.officialUrl, dated ? "https://www.ecfr.gov/current/title-8/part-208/section-208.30" : "https://www.ecfr.gov/current/title-20/part-655/section-655.202");
  assert.equal(reference.resolution, "official-source-only", "An intermediate cache must receive the historical-version preview guard");
  if (dated) assert.match(reference.citationNote || "", /historical version/, "An intermediate cache must receive the historical-version notice");
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE, "upgraded-cache");
  vm.runInContext(require("./test-function-source")(template, "corpusRequiresEmbeddedUpgrade"), context);
  assert.equal(context.corpusRequiresEmbeddedUpgrade(context.corpus, context.build), false, "The corrected cache must remain reusable on the next startup");
}
async function checkCfrSharedPathUpgrade(missingEndpoint = false) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    function corpusRequiresEmbeddedUpgrade"), template.indexOf("    if (loadedCorpus && !corpus)"));
  const engine = require("./legal-references");
  const embedded = { title8: { sections: [] }, cfr: { currentThrough: {}, parts: [], sections: [{ title: 19, section: "4.7a", blocks: [
    { a: "(c)(3)(i)", x: "First statement." }, { a: "(c)(3)(ii)", x: "Second statement." },
    { a: "(c)(3)(iii)", x: "The statements in paragraphs (c)(3) (i) and (ii) of this section apply." }
  ] }] } };
  if (missingEndpoint) embedded.cfr.sections = [{ title: 20, section: "416.920b", blocks: [
    { a: "(b)(1)", x: "First statement." }, { a: "(c)", x: "Other requirements." },
    { a: "(d)", x: "The statements in paragraphs (b)(1) through (4) of this section apply." }
  ] }];
  engine.applyGeneratedLegalReferences(embedded);
  const previous = structuredClone(embedded);
  previous.legalReferenceMetadata.cfrHierarchyVersion = missingEndpoint ? 8 : 7;
  const terminal = missingEndpoint ? "(4)" : "(ii)";
  Object.assign(previous.cfr.sections[0].blocks[2].xReferences.find(r => r.text === terminal), { targetPath: [missingEndpoint ? "4" : "ii"], resolution: "official-source-only" });
  const context = { corpus: previous, build: {
    cfrHierarchyVersion: embedded.legalReferenceMetadata.cfrHierarchyVersion,
    uscHierarchyVersion: embedded.legalReferenceMetadata.uscHierarchyVersion
  }, loadEmbeddedINASearchCorpus: async () => structuredClone(embedded), isValidCorpus: () => true,
  hydrateLegalReferences() {}, INA_SEARCH_CORPUS_COMPLETE: Promise.resolve(), TextEncoder,
  INASearchLegalReferences: engine,
  INASearchStorage: { sha256Bytes: async bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex") } };
  context.window = context;
  vm.createContext(context);
  await vm.runInContext(`(async () => { ${source} })()`, context);
  const reference = context.corpus.cfr.sections[0].blocks[2].xReferences.find(r => r.text === terminal);
  assert.deepEqual(reference.targetPath, missingEndpoint ? ["b", "4"] : ["c", "3", "ii"], "A saved version-7 or version-8 corpus must receive the complete written CFR paragraph prefix");
  assert.equal(reference.resolution, missingEndpoint ? "official-source-only" : "local");
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE, "upgraded-cache");
}
async function checkOperativeUscScopeUpgrade(previousVersion = 9) {
  const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");
  const source = template.slice(template.indexOf("    function corpusRequiresEmbeddedUpgrade"), template.indexOf("    if (loadedCorpus && !corpus)"));
  const engine = require("./legal-references");
  const embedded = { title8: { sections: previousVersion === 10 ? [
    { section: "1160", body: [{ label: "c", children: [{ label: "2", text: "The following provisions of section 1182(a) of this title may not be waived:", children: [{ label: "A", text: "Paragraph (2)(B)." }, { label: "B", text: "A different provision." }] }] }] },
    { section: "1182", body: [{ label: "a", children: [{ label: "2", children: [{ label: "B", text: "Criminal ground." }] }] }] }
  ] : [
    { section: "1152", body: [{ label: "(a)", children: [{ label: "(4)", text: "Local allocation." }] },
      { label: "(e)", text: "Immigrant visas under section 1153(a) of this title.", children: [{ label: "(2)", text: "The rules in subsection (a)(4) apply." }] }] },
    { section: "1153", body: [{ label: "(a)", children: [{ label: "(4)", text: "A different allocation." }] }] }
  ] }, cfr: { currentThrough: {}, parts: [], sections: [] } };
  engine.applyGeneratedLegalReferences(embedded);
  const previous = structuredClone(embedded);
  previous.legalReferenceMetadata.cfrHierarchyVersion = previousVersion;
  const referenceAt = corpus => previousVersion === 10
    ? corpus.title8.sections[0].body[0].children[0].children[0].references.find(reference => reference.text === "(2)(B)")
    : corpus.title8.sections[0].body[1].children[0].references.find(reference => reference.text === "(a)(4)");
  Object.assign(referenceAt(previous), { targetSection: previousVersion === 10 ? "1160" : "1153", targetPath: previousVersion === 10 ? ["c","2","B"] : ["a","4"] });
  const context = { corpus: previous, build: {
    cfrHierarchyVersion: embedded.legalReferenceMetadata.cfrHierarchyVersion,
    uscHierarchyVersion: embedded.legalReferenceMetadata.uscHierarchyVersion
  }, loadEmbeddedINASearchCorpus: async () => structuredClone(embedded), isValidCorpus: () => true,
  hydrateLegalReferences() {}, INA_SEARCH_CORPUS_COMPLETE: Promise.resolve(), TextEncoder,
  INASearchLegalReferences: engine,
  INASearchStorage: { sha256Bytes: async bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex") } };
  context.window = context;
  vm.createContext(context);
  await vm.runInContext(`(async () => { ${source} })()`, context);
  assert.equal(referenceAt(context.corpus).targetSection, previousVersion === 10 ? "1182" : "1152", "An older saved corpus must receive the reviewed statutory scope correction");
  assert.deepEqual(referenceAt(context.corpus).targetPath, previousVersion === 10 ? ["a", "2", "B"] : ["a", "4"]);
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE, "upgraded-cache");
}
async function checkRevision13DeliveryUpgrade(previousVersion = 13) {
  const template=fs.readFileSync(require.resolve('../src/INASearch.template.html'),'utf8');
  const source=template.slice(template.indexOf('    function corpusRequiresEmbeddedUpgrade'),template.indexOf('    if (loadedCorpus && !corpus)'));
  const engine=require('./legal-references');
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../sources/legal/embedded-reference-exceptions.json'),'utf8'));
  const savingsException=manifest.exceptions.find(item=>item.id==='cfr-8:204.7-0-amending-act-1976');
  const enactedExceptions=manifest.exceptions.filter(item=>item.id.startsWith('usc-1440c-enacted-section-2-'));
  assert.equal(enactedExceptions.length,3);
  const embedded={title8:{sections:[{section:'1184',body:[{text:'section 321(b) of division C, title III of Public Law 104-208'}]}]},cfr:{currentThrough:{8:'2026-01-01'},parts:[{id:'8:204',title:8,part:'204'}],sections:[{id:'8:204.7',title:8,part:'204',partId:'8:204',section:'204.7',blocks:[{t:'p',x:savingsException.sourceText}]}]},legalReferenceExceptions:{...manifest,exceptions:[savingsException]}};
  embedded.title8.sections.push({section:'724a',historical:{versionLabel:'1948 act as corrected in 1949'},notes:[{text:'See section 1440(a)–(c) of this title.',source:{resource:'United States Code, Title 8',url:'https://uscode.house.gov/view.xhtml?edition=1948'}}]},
    {section:'1440',body:[{label:'a',text:'Current paragraph a.'},{label:'c',text:'Current paragraph c.'}]});
  embedded.title8.sections.push({section:'1440c',preamble:enactedExceptions[0].sourceText});
  embedded.title8.sections.push({section:'1182',notes:[{text:'Pub. L. 108–447, div. J, title IV, § 424(a)(2), provided that: “The amendment made by paragraph (1) applies.”'}]});
  const titleScopeText='Pub. L. 101-649, title I, § 124, provided that: “section 206(b)(2) of this Act applies.”';
  const titleScopeLeadEnd=titleScopeText.indexOf(', provided');
  embedded.title8.sections.push({section:'1153',notes:[{text:titleScopeText,
    references:[{start:0,end:titleScopeLeadEnd,text:titleScopeText.slice(0,titleScopeLeadEnd),houseHref:'/us/pl/101/649/tI/s124',family:'public-law',targetCongress:'101',targetLaw:'649',targetPath:['tI','s124'],resolution:'official-source-only',provenance:'house-uslm-ref',ruleId:'house-uslm-ref'}],
    layout:[{tag:'p',start:0,end:titleScopeText.length,children:[{tag:'ref',start:0,end:titleScopeLeadEnd,href:'/us/pl/101/649/tI/s124'},{tag:'quotedContent',start:titleScopeText.indexOf('“'),end:titleScopeText.length,origin:'/us/pl/101/649/tI/s124'}]}]}]});
  embedded.legalReferenceExceptions.exceptions.push(...enactedExceptions);
  engine.applyGeneratedLegalReferences(embedded);
  const reference=embedded.title8.sections[0].body[0].references.find(r=>r.family==='public-law');
  reference.targetPath=['division-C','title-III','s321','b'];
  reference.officialUrl='https://www.govinfo.gov/app/details/PLAW-104publ208';
  const previous=structuredClone(embedded);previous.legalReferenceMetadata.cfrHierarchyVersion=previousVersion;
  previous.legalReferenceExceptions.exceptions=[];
  previous.title8.sections.find(s=>s.section==='1153').notes[0].references.find(r=>r.text.includes('206(b)(2)')).targetPath=['tI','s206','b','2'];
  previous.title8.sections.find(s=>s.section==='1182').notes[0].references.find(r=>r.text==='(1)').targetPath=['division-J','title-IV','s424','1'];
  for(const ref of previous.title8.sections.find(s=>s.section==='1440c').preambleReferences.filter(r=>r.targetLaw==='86')) {
    Object.assign(ref,{family:'usc',targetKind:'usc',targetTitle:'22',targetSection:'2601',targetPath:[],resolution:'unresolved',officialUrl:''});
    delete ref.targetCongress;delete ref.targetLaw;delete ref.historicalOfficialUrl;
  }
  previous.cfr.currentThrough[8]='2026-02-01';
  previous.cfr.sections[0].blocks[0].xReferences=[{start:savingsException.start,end:savingsException.end,text:savingsException.text,family:'ina',targetTitle:'8',targetSection:'9',inaSection:'9',targetPath:[],resolution:'local',ruleId:'context-cfr-ina-act-section',provenance:'deterministic-context'}];
  const stale=previous.title8.sections[0].body[0].references.find(r=>r.family==='public-law');
  stale.targetPath=['s321','b'];stale.officialUrl='https://example.test/stale';
  for(const ref of previous.title8.sections[1].notes[0].references) {
    ref.resolution='local';ref.officialUrl='https://uscode.house.gov/view.xhtml?edition=prelim';
    delete ref.historicalEditionGuard;delete ref.citationNote;
  }
  const context={corpus:previous,build:{cfrHierarchyVersion:embedded.legalReferenceMetadata.cfrHierarchyVersion,uscHierarchyVersion:embedded.legalReferenceMetadata.uscHierarchyVersion},loadEmbeddedINASearchCorpus:async()=>structuredClone(embedded),isValidCorpus:()=>true,hydrateLegalReferences(){},INA_SEARCH_CORPUS_COMPLETE:Promise.resolve(),TextEncoder,INASearchLegalReferences:engine,INASearchStorage:{sha256Bytes:async bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex')}};
  context.window=context;vm.createContext(context);await vm.runInContext(`(async () => { ${source} })()`,context);
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE,'upgraded-cache','A saved revision-13 corpus cannot mask corrected delivery metadata');
  assert.deepEqual(Array.from(context.corpus.title8.sections.find(s=>s.section==='1153').notes[0].references.find(r=>r.text.includes('206(b)(2)')).targetPath),['s206','b','2'],'Saved reference data must not retain a title borrowed from another section of the Act');
  assert.deepEqual(Array.from(context.corpus.title8.sections.find(s=>s.section==='1182').notes[0].references.find(r=>r.text==='(1)').targetPath),['division-J','title-IV','s424','a','1'],'A saved revision17 snapshot must adopt corrected amendment-parent ancestry');
  const corrected=context.corpus.title8.sections[0].body[0].references.find(r=>r.family==='public-law');
  assert.deepEqual(corrected.targetPath,reference.targetPath);
  assert.equal(corrected.officialUrl,reference.officialUrl);
  assert.equal(context.corpus.legalReferenceExceptions.exceptions[0].id,savingsException.id,'Upgrade adopts the embedded exception policy even while keeping newer CFR source text');
  const correctedSavings=context.corpus.cfr.sections[0].blocks[0].xReferences.find(item=>item.start===savingsException.start);
  assert.equal(correctedSavings.family,'public-law');assert.equal(correctedSavings.targetCongress,'94');assert.equal(correctedSavings.targetLaw,'571');
  assert.deepEqual(Array.from(correctedSavings.targetPath),['s9']);
  assert.equal(correctedSavings.officialUrl,savingsException.officialUrl,'A saved revision13 corpus must receive the actual new source-bound correction');
  const enacted=context.corpus.title8.sections.find(s=>s.section==='1440c').preambleReferences.filter(r=>r.targetCongress==='83');
  assert.equal(enacted.length,3,'A saved revision16 snapshot adopts all new enacted-Act corrections');
  for(const ref of enacted) {
    assert.equal(ref.targetLaw,'86');assert.deepEqual(Array.from(ref.targetPath),['s2']);
    assert.equal(ref.officialUrl,enactedExceptions[0].officialUrl);
  }
  const historicalNote=context.corpus.title8.sections[1].notes[0].references;
  assert.deepEqual(historicalNote.map(ref=>ref.targetPath),[['a'],['c']]);
  assert(historicalNote.every(ref=>ref.resolution==='unresolved'&&ref.historicalEditionGuard&&!ref.officialUrl),'Saved references, including revision15, must receive the actual historical-note navigation guard');
  vm.runInContext(require('./test-function-source')(template,'corpusRequiresEmbeddedUpgrade'),context);
  assert.equal(context.corpusRequiresEmbeddedUpgrade(context.corpus,context.build),false,'The corrected snapshot can be reused');
}
async function checkRevision11NamedOwnerUpgrade() {
  const template=fs.readFileSync(require.resolve('../src/INASearch.template.html'),'utf8');
  const source=template.slice(template.indexOf('    function corpusRequiresEmbeddedUpgrade'),template.indexOf('    if (loadedCorpus && !corpus)'));
  const engine=require('./legal-references');
  const embedded={title8:{sections:[]},cfr:{currentThrough:{},parts:[],sections:[{id:'8-212.1',title:8,part:'212',section:'212.1',blocks:[{t:'p',x:'sections 101(6) and 106, Division A, Title I of Public Law 118-83'}]}]}};
  engine.applyGeneratedLegalReferences(embedded);
  const previous=structuredClone(embedded);previous.legalReferenceMetadata.cfrHierarchyVersion=11;
  const first=corpus=>corpus.cfr.sections[0].blocks[0].xReferences.find(r=>r.text==='sections 101(6)');
  Object.assign(first(previous),{family:'ina',targetKind:'ina',targetTitle:'8',targetSection:'1101',targetPath:['6']});
  const context={corpus:previous,build:{cfrHierarchyVersion:embedded.legalReferenceMetadata.cfrHierarchyVersion,uscHierarchyVersion:embedded.legalReferenceMetadata.uscHierarchyVersion},loadEmbeddedINASearchCorpus:async()=>structuredClone(embedded),isValidCorpus:()=>true,hydrateLegalReferences(){},INA_SEARCH_CORPUS_COMPLETE:Promise.resolve(),TextEncoder,INASearchLegalReferences:engine,INASearchStorage:{sha256Bytes:async bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex')}};
  context.window=context;vm.createContext(context);await vm.runInContext(`(async () => { ${source} })()`,context);
  assert.equal(context.INA_SEARCH_CORPUS_LOAD_SOURCE,'upgraded-cache');
  assert.equal(first(context.corpus).family,'public-law');
  assert.equal(first(context.corpus).targetCongress,'118');
  assert.deepEqual(first(context.corpus).targetPath,['division-A','title-I','s101','6']);
}
(async () => {
  await checkRevision13DeliveryUpgrade();
  await checkRevision13DeliveryUpgrade(14);
  await checkRevision13DeliveryUpgrade(15);
  await checkRevision13DeliveryUpgrade(16);
  await checkRevision13DeliveryUpgrade(17);
  await checkRevision13DeliveryUpgrade(18);
  await checkRevision13DeliveryUpgrade(19);
  await checkRevision11NamedOwnerUpgrade();
  await checkOperativeUscScopeUpgrade();
  await checkOperativeUscScopeUpgrade(10);
  await checkCfrSharedPathUpgrade();
  await checkCfrSharedPathUpgrade(true);
  await checkTrailingCfrReferenceUpgrade();
  await checkTrailingCfrReferenceUpgrade(6);
  await checkNoteMetadataUpgrade();
  await checkNoteMetadataUpgrade(true);
  await checkFallbackPersistence();
  await checkFallbackPersistence(true);
  await checkFallbackPersistence(false, true);
  const parser = startup();
  parser.document.getElementById = () => ({ textContent: "partial payload" });
  let arrived = false;
  const waiting = parser.INASearchStartup.waitForData("streamingChunk").then(() => { arrived = true; });
  await Promise.resolve();
  assert.equal(arrived, false, "A parser-created element was read before its closing script arrived");
  parser.INASearchStartup.register("streamingChunk");
  await waiting;
  const selected = select(headings, mapping, "101a15h2a");
  const marks = [], context = startup(new Map(), marks);
  const reads = [], chunkWaiters = new Map();
  context.INASearchStorage = { readCorpusChunk(_record, id) {
    reads.push(id);
    if (selected.includes(id)) return Promise.resolve(structuredClone(chunks[id]));
    return new Promise(resolve => chunkWaiters.set(id, () => resolve(structuredClone(chunks[id]))));
  } };
  const record = { chunks };
  const opened = await context.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "101a15h2a");
  assert.deepEqual(JSON.parse(JSON.stringify(opened.title8.sections.find(record => record.id === "8-1101").body)), full.title8.sections.find(record => record.id === "8-1101").body);
  assert(!opened.cfr.sections.some(record => record.blocks?.length), "Unrequested CFR bodies were parsed before paint");
  const hierarchy = require("../src/INASearch-CFR-Hierarchy");
  const cfrRecord = opened.cfr.sections.find(record => record.id === "8:214.2");
  assert.equal(hierarchy.index(cfrRecord).paths.length, 0);
  context.INA_SEARCH_CONTINUE_LOADING();
  let complete = false;
  context.INA_SEARCH_CORPUS_COMPLETE.then(() => { complete = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(complete, false, "Withheld cached content should not finish loading");
  context.INASearchStorage.readCorpusChunk = (_record, id) => { reads.push(id); return Promise.resolve(structuredClone(chunks[id])); };
  chunkWaiters.forEach(resolve => resolve());
  await context.INA_SEARCH_CORPUS_COMPLETE;
  assert(hierarchy.index(cfrRecord).paths.length > 0, "A pre-loading CFR structure cache stayed empty after body arrival");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), full, "Background loading changed legal content or record identity");
  assert.equal(marks.filter(mark => mark.name === "content-chunk-ready").length, chunks.length, "A cached chunk loaded more than once");
  const text = startup();
  text.INASearchStorage = { readCorpusChunk: (_record, id) => Promise.resolve(structuredClone(chunks[id])) };
  const textCorpus = await text.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "president");
  assert.equal(text.INA_SEARCH_OPENING_REQUIRES_FULL_CORPUS, false, "Ordinary cached searches should use their saved index before complete records");
  assert.equal(text.INA_SEARCH_CORPUS_FULLY_LOADED, false);
  text.INA_SEARCH_CONTINUE_LOADING();
  await text.INA_SEARCH_CORPUS_COMPLETE;
  assert.deepEqual(JSON.parse(JSON.stringify(textCorpus)), full);
  for (const [query, profile] of [["in:notes", null], ["has:highlight president", null], ["president", { notes: [{ id: "saved-note" }] }], ["president", { highlights: [{ id: "saved-highlight" }] }]]) {
    const annotated = startup();
    annotated.INA_SEARCH_PROFILE = profile;
    annotated.INASearchStorage = { readCorpusChunk: (_record, id) => Promise.resolve(structuredClone(chunks[id])) };
    await annotated.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, query);
    assert.equal(annotated.INA_SEARCH_OPENING_REQUIRES_FULL_CORPUS, true, `${query}: annotations were searched against incomplete legal records`);
    await annotated.INA_SEARCH_CORPUS_COMPLETE;
  }
  const bad = startup();
  bad.INASearchStorage = { readCorpusChunk: () => Promise.reject(new Error("Cached corpus failed its SHA-256 integrity check")) };
  await bad.INASearchStartup.openCachedCorpus({ corpus: structuredClone(metadata), record }, "");
  bad.INA_SEARCH_CONTINUE_LOADING();
  await assert.rejects(bad.INA_SEARCH_CORPUS_COMPLETE, /SHA-256 integrity check/);
  console.log("PASS staged startup: compact and historical citations, split queries, withheld background bytes, exact final content, single hydration and corrupt background detection");
})().catch(error => { console.error(error); process.exitCode = 1; });
