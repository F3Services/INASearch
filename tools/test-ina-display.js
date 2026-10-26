#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const { runtime, plain, contextFor } = require('./audit-ina-display');
const { readArtifact, collectFields } = require('./audit-inline-references');
const corpus = readArtifact('INASearch-Uncompressed.html');
const api = runtime(fs.readFileSync('src/INASearch.template.html', 'utf8'), corpus);
const fields = collectFields(corpus);
function render(text, references, context, match = null, footnotes = []) {
  return api.linkifyStatutoryText(text, references, 0, undefined, match, footnotes, context);
}
// Exercise the actual reader boundary, including citations split by inline styles.
for (const [title, section, indices] of [[8, '212.18', [0]], [22, '41.24', [4,5,6]]]) {
  const record = corpus.cfr.sections.find(row => row.title === title && row.section === section);
  for (const index of indices) {
    const block = record.blocks[index], context = {kind:'cfr',title,sourceHost:{kind:'cfr',title,section}};
    assert.equal(plain(api.renderCfrStyledRange(block, 0, undefined, null, context)), plain(render(block.x, block.xReferences, context)), 'Reader styling cannot split citation conversion');
    assert.equal(plain(api.renderCfrStyledRange(block, 0, undefined, null, {...context,citationDisplaySystem:'usc'})), block.x);
  }
}
const historicalBlock = corpus.cfr.sections.find(row => row.title === 8 && row.section === '208.13').blocks.find(row => row.x?.includes('212(a)(3)(B)(i)(I),(II)'));
const historicalRef = historicalBlock.xReferences.find(ref => ref.resolution === 'unresolved');
for (const highlighting of [false,true]) {
  api.profile.preferences.highlightInaCitationLinks = highlighting;
  const html = render(historicalBlock.x, historicalBlock.xReferences, {kind:'cfr',title:8}, {start:historicalRef.start,end:historicalRef.end});
  assert(html.includes('data-statute-search-match'), 'Unresolved converted citations retain search matches');
}
const styledUnresolved = 'section 212(a)(3)(B)(i)(I) of the Act';
const styledReference = {...historicalRef,start:0,end:styledUnresolved.length,text:styledUnresolved};
const styledHtml = api.renderCfrStyledRange({x:styledUnresolved,xReferences:[styledReference],r:[{x:styledUnresolved,s:'i'}]},0,undefined,{start:0,end:styledUnresolved.length},{kind:'cfr'});
assert(styledHtml.includes('font-style:italic') && styledHtml.includes('data-statute-search-match'), 'Unresolved conversion projects source presentation and search together');
assert(!styledHtml.includes('data-legal-reference'), 'Unresolved display normalization creates no navigation');
for(const part of corpus.cfr.parts.filter(row=>['245a','501','502'].includes(String(row.part))&&row.headingReferences?.length)) {
 assert(api.cfrHeadingDisplayText(part.heading).includes('INA '), 'Hierarchy metadata reuses the owning heading references');
}
const printedList = 'sections 101(a)(15)(T)(ii) and 101(a)(15)(T)(iii) of the Act';
const printedRefs = ['sections 101(a)(15)(T)(ii)', '101(a)(15)(T)(iii) of the Act'].map(text => ({text,start:printedList.indexOf(text),end:printedList.indexOf(text)+text.length,family:'ina',ruleId:'context-cfr-ina-act-section',inaSection:'101',targetTitle:'8',targetSection:'1101',targetPath:['a','15','T','ii'],resolution:'local'}));
assert.equal(plain(render(printedList,printedRefs,{kind:'cfr'})), 'INA 101(a)(15)(T)(ii) and (iii)', 'Coordinated labels preserve different printed classifications even when their reviewed destinations agree');
const namedChapter = 'under any provision of chapter 3 of title III of the Immigration and Nationality Act of 1952';
assert.equal(plain(api.linkifyCfrText(namedChapter,[])), 'under any provision of INA title III, chapter 3');
for (const section of ['68.53','68.55']) {
 const record = corpus.cfr.sections.find(row=>row.title===28&&row.section===section);
 assert(!/section 274/i.test(api.cfrHeadingDisplayText(`§ ${section} ${record.heading}`)), 'Hierarchy labels with a section-number prefix reuse the owning heading conversion');
}
const parallelBlock = corpus.cfr.sections.find(row=>row.id==='20:655.600').blocks.find(block=>block.x?.includes('section 258 of the INA (8 U.S.C. 1288)'));
assert(parallelBlock, 'The parenthetical-parallel regression must exercise captured text');
assert(plain(api.linkifyCfrText(parallelBlock.x,parallelBlock.xReferences)).includes('INA 258 (8 U.S.C. 1288)'), 'Named INA conversion retains the balanced Code parallel');
const datedBlock = corpus.cfr.sections.find(row=>row.id==='8:1240.11').blocks.find(block=>block.x?.includes('section 101 or 104 of the Act of October 28, 1977'));
assert(plain(api.linkifyCfrText(datedBlock.x,datedBlock.xReferences)).includes('section 101 or 104 of the Act of October 28, 1977'), 'A dated foreign Act keeps its complete source identity');
const lawAuthority = corpus.cfr.parts.find(row=>row.title===8&&String(row.part)==='1245');
assert(plain(api.linkifyCfrText(lawAuthority.authority,lawAuthority.authorityReferences)).includes('section 202, Public Law 105-100'), 'Public Law section wording survives INA conversion of the preceding USC list');
const decimalBlock = corpus.cfr.sections.find(row=>row.id==='8:103.38').blocks.find(block=>block.x?.includes('Sections 103.38 through 103.41'));
assert(plain(api.linkifyCfrText(decimalBlock.x,decimalBlock.xReferences)).includes('Sections 103.38 through 103.41'), 'A decimal CFR range cannot turn into an INA prefix');
// Start from the delivered lazy-reference state and the default Follow view
// preference, rather than the audit's eagerly expanded/forced-INA corpus.
for (const artifact of ['INASearch.html','INASearch-Uncompressed.html']) {
 const packed = require('./read-build-corpus').readBuildCorpus(artifact);
 const fresh = runtime(fs.readFileSync('src/INASearch.template.html','utf8'),packed);
 fresh.profile.preferences.statutoryLinkCitationSystem = 'view';
 fresh.state.statuteHierarchyAuthority = 'ina';
 const part = packed.cfr.parts.find(record=>record.title===8&&String(record.part)==='245a');
 assert(part._lr?.h && !part.headingReferences, 'The fixture must begin with lazily packed heading references');
 const unrelated = packed.cfr.sections.find(record=>record.blocks?.some(block=>block._lr?.x));
 const block = unrelated.blocks.find(block=>block._lr?.x);
 const first = fresh.cfrHeadingDisplayText(part.heading);
 assert(first.includes('INA 245A') && !first.includes('<'), 'Fresh packed headings convert to actual plain text in Follow view');
 const reservedHeading = '§ 41.82 Certain parents and children of section 101(a)(27)(I) special immigrants. [Reserved]';
 assert(fresh.cfrHeadingDisplayText(reservedHeading).includes('of INA 101(a)(27)(I)'), 'A generic reserved heading cannot shadow the matching citation owner');
 assert(part.headingReferences?.length && block._lr?.x, 'Heading lookup hydrates only its owning heading, not the corpus');
 fresh.hydrateLegalReferences(part);
 assert.equal(fresh.cfrHeadingDisplayText(part.heading),first,'Later owner hydration cannot stale the heading cache');
 fresh.state.statuteHierarchyAuthority = 'usc';
 assert.equal(fresh.cfrHeadingDisplayText(part.heading),part.heading,'Follow view retains source wording in the USC hierarchy');
 fresh.profile.preferences.statutoryLinkCitationSystem = 'ina';
 assert.equal(fresh.cfrHeadingDisplayText(part.heading),first,'Explicit INA mode returns the same plain heading in either hierarchy');
 fresh.state.statuteHierarchyAuthority = 'ina';
 fresh.profile.preferences.statutoryLinkCitationSystem = 'usc';
 assert.equal(fresh.cfrHeadingDisplayText(part.heading),part.heading,'Source preference retains the source heading');
 const replacementText = 'Replacement under SECTION 101(a)(43) OF THE INA';
 const written = 'SECTION 101(a)(43) OF THE INA', offset = replacementText.indexOf(written);
 packed.cfr = {...packed.cfr,parts:[{heading:replacementText,headingReferences:[{start:offset,end:replacementText.length,text:written,family:'ina',inaSection:'101',targetTitle:'8',targetSection:'1101',targetPath:['a','43'],resolution:'local',ruleId:'context-cfr-ina-act-section'}]}],sections:[],appendices:[]};
 fresh.profile.preferences.statutoryLinkCitationSystem = 'view';
 assert.equal(fresh.cfrHeadingDisplayText(replacementText),'Replacement under INA 101(a)(43)','Replacing the CFR root invalidates the owning-heading index');
}
const historicalRedesignation = corpus.cfr.sections.find(row=>row.id==='8:1245.22').blocks.find(block=>block.x?.includes('242 or 242A (redesignated as section 238)'));
const historicalDisplay = plain(api.linkifyCfrText(historicalRedesignation.x,historicalRedesignation.xReferences));
assert(historicalDisplay.includes('INA 242 or 242A (redesignated as INA 238) (as in effect prior to April 1, 1997)'), 'Redesignation suffix cleanup retains both parenthetical qualifiers');
assert.equal(plain(api.linkifyCfrText(historicalRedesignation.x,historicalRedesignation.xReferences,0,undefined,null,{citationDisplaySystem:'usc'})),historicalRedesignation.x,'Redesignation source wording remains exact');
const sectionContext = { kind: 'ina', uscSection: '1226' };
// CFR decimal section numbers must never inherit the historical status of a
// similarly normalized U.S. Code section (1.2 -> 12, 1.3 -> 13).
for (const [section, prefix, expected] of [
  ['1.2', 'Aggravated felony means', 'described in INA 101(a)(43).'],
  ['1.3', '(3) An alien', 'pursuant to INA 212(d)(5) for less than 1 year']
]) {
  const record = corpus.cfr.sections.find(row => row.title === 8 && row.section === section);
  const block = record.blocks.find(row => row.x?.startsWith(prefix));
  const context = { kind: 'cfr', title: 8, sourceHost: { kind: 'cfr', title: 8, section } };
  api.profile.preferences.highlightInaCitationLinks = true;
  const html = render(block.x, block.xReferences, context);
  assert(plain(html).includes(expected), `8 CFR ${section}: reader context must convert an INA Act citation`);
  assert(html.includes('citation-display-ina'), 'A converted citation receives the optional highlight');
  assert.equal(render(block.x, block.xReferences, { ...context, plainText: true }), plain(html), 'Copy and reader wording agree');
  assert.equal(plain(render(block.x, block.xReferences, { ...context, citationDisplaySystem: 'usc' })), block.x, 'Source view preserves the complete original text');
}
api.profile.preferences.highlightInaCitationLinks = false;
for (const [id, expected] of [
  ['8-1226-c-1-B', 'is deportable by reason of having committed any offense covered in INA 237(a)(2)(A)(ii), (A)(iii), (B), (C), or (D),'],
  ['8-1226-c-1-E-i', 'is inadmissible under paragraph (6)(A), (6)(C), or (7) of INA 212(a); and']
]) {
  const field = fields.find(f => f.sourceId === id && f.field === 'text');
  const html = render(field.text, field.references, sectionContext);
  assert.equal(plain(html.replace(/<template>[\s\S]*?<\/template>/g, '')), expected);
  assert.equal((html.match(/data-legal-reference/g) || []).length, field.references.length);
  for (const reference of field.references) assert(html.includes(`data-reference-source-text="${reference.text}"`));
}
function refsFor(text, phrases, paths, family = 'usc', section = '1227') {
  let cursor = 0;
  return phrases.map((phrase, index) => {
    const start = text.indexOf(phrase, cursor); assert(start >= 0); cursor = start + phrase.length;
    return { start, end: cursor, text: phrase, family, targetKind: 'usc', targetTitle: '8', targetSection: section, targetPath: paths[index], resolution: 'local', ...(family === 'ina' ? { ruleId: 'context-cfr-ina-act-section', inaSection: '101' } : {}) };
  });
}
for (const [last, paths, expected] of [
  ['(b)(1)', [['a','1'],['a','2'],['b','1']], 'INA 237(a)(1), (a)(2), and (b)(1)'],
  ['(a)(3)', [['a','1'],['a','2'],['a','3']], 'INA 237(a)(1), (2), and (3)']
]) {
  const phrases = ['section 1227(a)(1) of this title','section 1227(a)(2) of this title',`section 1227${last} of this title`];
  const text = `${phrases[0]}, ${phrases[1]}, and ${phrases[2]}`;
  const refs = refsFor(text, phrases, paths);
  assert.equal(plain(render(text, refs, sectionContext)), expected);
  api.profile.preferences.statutoryLinkCitationSystem = 'usc';
  assert.equal(plain(render(text, refs, sectionContext)), text);
  api.profile.preferences.statutoryLinkCitationSystem = 'ina';
}
const redundantRelative = 'section 1227(a)(1), (a)(2), or (a)(3) of this title';
assert.equal(plain(render(redundantRelative, refsFor(redundantRelative, ['section 1227(a)(1)', '(a)(2)', '(a)(3)'], [['a','1'],['a','2'],['a','3']]), sectionContext)), 'INA 237(a)(1), (2), or (3)');
const actText = 'A special immigrant under section 101(a)(27)(H) or (J) of the Act;';
const actRefs = refsFor(actText, ['section 101(a)(27)(H)', '(J) of the Act'], [['a','27','H'],['a','27','J']], 'ina','1101');
assert.equal(plain(render(actText, actRefs, {kind:'cfr',title:'8'})), 'A special immigrant under INA 101(a)(27)(H) or (J);');
const andOrText = 'section 101(a)(15)(H) and/or (L) of the Act';
assert.equal(plain(render(andOrText, refsFor(andOrText, ['section 101(a)(15)(H)', '(L) of the Act'], [['a','15','H'],['a','15','L']], 'ina','1101'), {kind:'cfr',title:'8'})), 'INA 101(a)(15)(H) and/or (L)');
for (const sourceSection of ['1.2', '1.3']) {
  const context = { kind: 'cfr', title: 8, sourceHost: { kind: 'cfr', title: 8, section: sourceSection } };
  assert.equal(plain(render(actText, actRefs, context)), 'A special immigrant under INA 101(a)(27)(H) or (J);', 'Coordinated CFR citations share their authority in the reader');
  assert.equal(render(actText, actRefs, { ...context, plainText: true }), 'A special immigrant under INA 101(a)(27)(H) or (J);', 'Copy retains the same coordinated grammar');
  const mixed = 'sections 101(a)(15) and 212(a) of the Act';
  const mixedRefs = refsFor(mixed, ['sections 101(a)(15)', '212(a) of the Act'], [['a','15'],['a']], 'ina', '1101');
  Object.assign(mixedRefs[1], { inaSection: '212', targetSection: '1182' });
  assert.equal(plain(render(mixed, mixedRefs, context)), 'INA 101(a)(15) and 212(a)', 'Different sections share the INA prefix without a dangling Act suffix');
}
assert.equal(plain(render(actText, actRefs, { kind: 'usc', sourceHost: { kind: 'usc', title: 8, section: '12' } })), actText, 'An actual historical U.S. Code host retains its original citation wording');
const capitalizedAct = 'Section 101(a)(27)(H) of the Act provides';
assert.equal(plain(render(capitalizedAct, refsFor(capitalizedAct, ['Section 101(a)(27)(H) of the Act'], [['a','27','H']], 'ina','1101'), {kind:'cfr',title:'8'})), 'INA 101(a)(27)(H) provides');
const separated = 'section 1227(a)(1) of this title, except as provided in section 1227(a)(2) of this title';
assert.equal(plain(render(separated, refsFor(separated, ['section 1227(a)(1) of this title','section 1227(a)(2) of this title'], [['a','1'],['a','2']]), sectionContext)), 'INA 237(a)(1), except as provided in INA 237(a)(2)');
const historicalNote = fields.find(field => field.sourceId === '8-1101-note-17' && field.field === 'text');
for (const [start, token] of [[4391, 'b'], [4513, 'a'], [4521, 'c']]) {
  const reference = historicalNote.references.find(ref => ref.start === start);
  assert.equal(reference.targetSection, '1105a', 'Historical such-section antecedent must retain the former section');
  assert.deepEqual(reference.targetPath, [token]);
  assert.equal(reference.resolution, 'official-source-only', 'Former section must not use its unrelated current codification');
}
for (const subsection of ['a', 'b']) {
  const field = fields.find(field => field.sourceId === `8-1612-${subsection}-2-C-iii` && field.field === 'text');
  for (const [start, token] of [[77,'i'],[84,'ii'],[162,'i'],[169,'ii']]) {
    const reference = field.references.find(ref => ref.start === start);
    assert.equal(reference.targetSection, '1612', 'Intervening prose must prevent a remote section from capturing the clause list');
    assert.deepEqual(reference.targetPath, [subsection,'2','C',token]);
    assert.equal(reference.resolution, 'local');
  }
}
for (const section of ['240.66', '1240.66']) {
  const field = fields.find(field => field.sourcePath === `cfr.records[8:${section}].blocks[2]` && field.field === 'x');
  assert(field.references.some(ref => ref.targetSection === '1182' && ref.targetPath.join('/') === 'a/2'));
  assert(field.references.some(ref => ref.targetSection === '1182' && ref.targetPath.join('/') === 'a/3'));
}
let count = 0, unresolvedCount = 0;
for (const field of fields) {
  const context = contextFor(field, corpus);
  for (const reference of field.references) {
    assert(Number.isInteger(reference.start) && Number.isInteger(reference.end) && reference.start >= 0 && reference.end > reference.start && reference.end <= field.text.length,
      `${field.sourcePath}.${field.field}: reference ${reference.start}–${reference.end} must fit its delivered source text`);
    assert.equal(field.text.slice(reference.start, reference.end), reference.text, `${field.sourcePath}.${field.field}: reference source text must round-trip`);
  }
  const html = render(field.text, field.references, context);
  const links = [...html.matchAll(/data-reference-source-text="([^"]*)"/g)].map(match => plain(match[1]));
  const resolved = field.references.filter(reference => reference.resolution !== 'unresolved');
  assert.deepEqual(links, resolved.map(ref => ref.text), `${field.sourcePath}.${field.field}: source link order and membership`);
  for (const reference of field.references.filter(reference => reference.resolution === 'unresolved')) {
    assert.equal(field.text.slice(reference.start, reference.end), reference.text, `${field.sourcePath}.${field.field}: unresolved source span`);
    const sourceHtml = api.linkifyStatutoryText(field.text, field.references, reference.start, reference.end, null, [], { ...context, citationDisplaySystem: 'usc' });
    assert.equal(plain(sourceHtml), reference.text, `${field.sourcePath}.${field.field}: unresolved citation retains source text`);
    assert(!sourceHtml.includes('data-legal-reference'), `${field.sourcePath}.${field.field}: unresolved citation must not invent a destination`);
    unresolvedCount++;
  }
  count += links.length;
}
console.log(`PASS INA display: examples, repeated citation ancestors, CFR alternatives, prose boundaries, preference off, ${count} source links in exact order, and ${unresolvedCount} unresolved citations retained as text`);

// Bare section citations use their resolved Title 8 target, including notes
// and regulation text; the preference must never rewrite the stored source.
const bareExample = fields.find(field => field.sourceId === '8-1182-d-3-B-i' && field.field === 'text');
const bareReference = bareExample.references.find(reference => reference.text === 'section 1252(a)(2)(D)');
assert.equal(bareReference.targetSection, '1252');
const bareHtml = render(bareExample.text, bareExample.references, contextFor(bareExample, corpus));
assert(plain(bareHtml).includes('to the extent provided in INA 242(a)(2)(D).'));
assert(bareHtml.includes('data-reference-source-text="section 1252(a)(2)(D)"'));
api.profile.preferences.statutoryLinkCitationSystem = 'usc';
assert.equal(plain(render(bareExample.text, bareExample.references, contextFor(bareExample, corpus))), bareExample.text);
api.profile.preferences.statutoryLinkCitationSystem = 'ina';
const bareText = 'Review under section 1252(a)(2)(D) remains available.';
const bareRefs = refsFor(bareText, ['section 1252(a)(2)(D)'], [['a','2','D']], 'usc', '1252');
for (const context of [{kind:'ina',uscSection:'1182'}, {kind:'ina',uscSection:'1252'}, {kind:'cfr',title:'8'}, {kind:'usc',uscSection:'15'}, null]) {
  assert.equal(plain(render(bareText, bareRefs, context)), 'Review under INA 242(a)(2)(D) remains available.');
}
const otherAuthority = bareRefs.map(reference => ({...reference, targetTitle:'28', resolution:'official-source-only'}));
assert.equal(plain(render(bareText, otherAuthority, sectionContext)), bareText, 'Other U.S.C. titles must not inherit an INA crosswalk.');
console.log('PASS bare-section INA display: exact user example, source metadata, preference off, self-reference, CFR context and other-title exclusion');
const mixedQualifiedField = fields.find(field => field.sourceId === '8-1327' && field.field === 'preamble');
assert(mixedQualifiedField, 'Missing qualified INA 277 citation-list fixture');
const qualifiedDisplay = plain(render(mixedQualifiedField.text, mixedQualifiedField.references, contextFor(mixedQualifiedField, corpus)));
assert(qualifiedDisplay.includes('INA 212(a)(2)') && qualifiedDisplay.includes('INA 212(a)(3) (other than subparagraph (E) thereof) to enter'), 'Qualified list must convert both addresses and retain the parenthetical without a dangling USC title');
const selfQualifiedText = 'Review under section 1252(a)(2)(D) of this title remains available.';
const selfQualifiedRefs = refsFor(selfQualifiedText, ['section 1252(a)(2)(D)'], [['a','2','D']], 'usc', '1252');
assert.equal(plain(render(selfQualifiedText, selfQualifiedRefs, sectionContext)), 'Review under INA 242(a)(2)(D) remains available.');
const sharedPrefixText = '8 U.S.C. 1182(a)(2), (3), 1227(a)(3), (4)';
const sharedPrefixRefs = refsFor(sharedPrefixText, ['8 U.S.C. 1182(a)(2)', '(3)', '1227(a)(3)', '(4)'], [['a','2'],['a','3'],['a','3'],['a','4']]);
sharedPrefixRefs.forEach((reference,index)=>{ reference.targetSection = index<2?'1182':'1227'; reference.ruleId='explicit-usc-continuation'; });
assert.equal(plain(render(sharedPrefixText, sharedPrefixRefs, sectionContext)), 'INA 212(a)(2), (3), 237(a)(3), (4)', 'Shared USC prefixes and abbreviated members must convert together');
const title28Fields = fields.filter(field => field.text.includes('section 1361 or 1651 of such title'));
assert.equal(title28Fields.length, 2);
for(const field of title28Fields) assert.equal(field.references.find(reference=>reference.text==='section 1361').targetTitle, '28', 'Such title must inherit Title 28 rather than collide with INA 291');
const executiveField = fields.find(field=>field.text.includes('section 1101(4) of Ex. Ord. No. 12656'));
assert(!executiveField.references.some(reference=>reference.targetTitle==='8'&&reference.targetSection==='1101'), 'Executive Order section 1101 must not resolve to INA 101');
const former22Field = fields.find(field=>field.text.includes('former section 1501 et seq. of title 22'));
assert.equal(former22Field.references.find(reference=>reference.text==='section 1501').targetTitle,'22', 'Et seq. must not hide an explicit Title 22 scope');
console.log('PASS reviewed authority tails, qualified continuation list, shared-prefix preservation, Title 28, executive-order and former Title 22 regressions');
const historicAlternative = fields.find(field => field.sourceId === '8-1229b-b-4-A-ii' && field.field === 'text');
const historicAlternativeDisplay = plain(render(historicAlternative.text, historicAlternative.references, contextFor(historicAlternative, corpus)));
assert(historicAlternativeDisplay.includes('INA 240A(b)(2) or 1254(a)(3) of this title (as in effect before'), 'An unresolved historical alternative must retain the printed citation and temporal qualifier');
const historicalAlternativeReference = historicAlternative.references.find(reference => reference.targetSection === '1254');
assert.equal(historicalAlternativeReference.resolution, 'unresolved');
assert.equal(render(historicalAlternativeReference.text, [{...historicalAlternativeReference,start:0,end:historicalAlternativeReference.text.length}], contextFor(historicAlternative, corpus)), historicalAlternativeReference.text, 'An unverified historical alternative must remain plain source text');
const oldRange = fields.find(field => (field.sourceId === '8-701 to 724a-note-26' || field.owner.sourceNoteId === '8-701 to 724a-note-26') && field.field === 'text');
assert(oldRange, 'The combined House record’s relative-range note must survive historical section expansion');
assert(plain(render(oldRange.text,oldRange.references,contextFor(oldRange,corpus))).endsWith('See INA 329(a)–(c).'), 'A relative paragraph range must preserve endpoints and remove the dangling title container');
const longListStart = performance.now();
assert.equal(api.inUnfinishedStatutoryList('sections '+'1'.repeat(12000)+' unrelated prose'),false);
assert(performance.now()-longListStart<250,'Section-list scope scanning backtracks on a long numeric token');
console.log('PASS mixed historical list, relative range and linear list-scope scanning');

// Fully written USC citations participate in the same saved display mode as
// contextual citations, while the original source and exact locator survive.
const explicitText = 'Requirements under 8 U.S.C. 1188 apply.';
const explicitRefs = refsFor(explicitText, ['8 U.S.C. 1188'], [[]], 'usc', '1188');
api.profile.preferences.statutoryLinkCitationSystem = 'view';
for (const [authority, expected] of [['ina', 'Requirements under INA 218 apply.'], ['usc', explicitText]]) {
  api.state.statuteHierarchyAuthority = authority;
  const html = render(explicitText, explicitRefs, { kind: 'cfr', title: '29' });
  assert.equal(plain(html.replace(/<template>[\s\S]*?<\/template>/g, '')), expected);
  assert(html.includes('data-reference-source-text="8 U.S.C. 1188"'));
  assert(html.includes('data-reference-section="1188"'));
}
api.state.statuteHierarchyAuthority = 'ina';
api.profile.preferences.statutoryLinkCitationSystem = 'ina';
for (const [text, phrase] of [
  ['8 U.S.C. 1101 note', '8 U.S.C. 1101'],
  ['8 U.S.C. 1101 [note]', '8 U.S.C. 1101'],
  ['8 U.S.C. 1101 et seq.', '8 U.S.C. 1101'],
  ['note under 8 U.S.C. 1101', '8 U.S.C. 1101'],
  ['former 8 U.S.C. 1101', '8 U.S.C. 1101']
]) assert.equal(plain(render(text, refsFor(text, [phrase], [[]], 'usc', '1101'), sectionContext)), text);
const parallelText = 'section 101(a) of the Immigration and Nationality Act (8 U.S.C. 1101(a))';
const parallelRefs = refsFor(parallelText, ['section 101(a)', '8 U.S.C. 1101(a)'], [['a'], ['a']], 'usc', '1101');
parallelRefs[0].ruleId = 'embedded-a-explicit-container-base';
assert.equal(plain(render(parallelText, parallelRefs, sectionContext)), 'INA 101(a) (8 U.S.C. 1101(a))');
const allFields = require('./audit-explicit-usc-display').fields(corpus);
for (const [title, section, phrase, expected] of [
  [20, '655.500', '(1) Under the prevailing practice exception', 'in INA 258(c),'],
  [20, '655.700', 'The term “labor condition application”', 'under INA 212(t)(1) for an E-3'],
  [20, '655.700', 'The term “labor condition application”', 'under INA 101(a)(15)(E)(iii) and (H)(i)(b1) (8 U.S.C.'],
  [20, '416.1619', 'temporary protected status', 'under INA 244A.'],
  [8, '208.13', 'as it existed prior to April 1, 1997', 'INA 212(a)(3)(B)(i)(I),(II), and (III) as it existed prior to April 1, 1997'],
  [8, '207.7', '(c) Relationship.', '(D), or (E), respectively, must have existed'],
  [8, '204.5', '(f) Maintaining the priority date', 'INA 203(b)(3), respectively, as in effect']
]) {
  const field = allFields.find(row => Number(row.context.sourceHost?.title) === title && row.context.sourceHost.section === section && row.text.includes(phrase));
  assert(field, `${title} CFR ${section}: source fixture exists`);
  const html = render(field.text, field.references, field.context);
  assert(plain(html).includes(expected), `${title} CFR ${section}: normalize written INA authority and preserve its surrounding grammar`);
  assert.equal(render(field.text, field.references, { ...field.context, plainText: true }), plain(html), 'Historical and named-Act copy normalization matches reader text');
  const unresolved = field.references.filter(reference => reference.resolution === 'unresolved');
  for (const reference of unresolved) assert(!html.includes(`data-reference-source-text="${reference.text}"`), 'Display normalization must not turn an unresolved source citation into a link');
}
const cfrSourceContext = { kind: 'cfr', title: 8, sourceHost: { kind: 'cfr', title: 8, section: '214.1' } };
const classificationText = '101(a)(15)(T)(iii)';
const classificationReference = { ...refsFor(classificationText, [classificationText], [['a','15','T','ii']], 'ina', '1101')[0], citationNote: 'The printed administrative classification is preserved; the link opens its underlying INA provision.' };
const classificationHtml = render(classificationText, [classificationReference], cfrSourceContext);
assert.equal(plain(classificationHtml), 'INA 101(a)(15)(T)(iii)', 'Printed classification suffix stays independent of the link destination');
assert(classificationHtml.includes('data-show-citation="INA 101(a)(15)(T)(ii)"'), 'Classification navigation retains the reviewed underlying provision');
const articleText = 'covered by a section 101(a)(27)(K) of the Act agreement';
assert.equal(plain(render(articleText, refsFor(articleText, ['section 101(a)(27)(K) of the Act'], [['a','27','K']], 'ina', '1101'), cfrSourceContext)), 'covered by an INA 101(a)(27)(K) agreement', 'INA conversion adjusts an immediately preceding indefinite article');
const namedInaText = 'section 212(t)(1) of the INA';
const namedInaReference = { ...refsFor(namedInaText, ['212(t)(1)'], [['t','1']], 'usc', '1182')[0], ruleId: 'embedded-named-act-section', inaSection: '212' };
assert.equal(plain(api.linkifyCfrText(namedInaText, [namedInaReference])), 'INA 212(t)(1)', 'CFR headings and source details retain CFR display context without a reader host');
api.profile.preferences.highlightInaCitationLinks = true;
for (const field of allFields.filter(field => field.context.sourceHost?.title === 22 && ['41.12', '42.11'].includes(field.context.sourceHost.section))) {
  if (field.references.some(reference => reference.inaSection && !['explicit-ina', 'explicit-ina-continuation'].includes(reference.ruleId))) continue;
  const html = render(field.text, field.references, field.context);
  assert.equal(plain(html), field.text, 'Standard INA classification citations retain their wording');
  assert(!html.includes('citation-display-ina'), 'Already-standard INA classification citations do not receive a conversion highlight');
}
api.profile.preferences.highlightInaCitationLinks = false;
for (const [title, section, sourcePhrase, retainedParallel] of [
  [8, '212.17', 'waivers of inadmissibility', '8 U.S.C. 1182(d)(3)(B) or (d)(14)'],
  [20, '655.1', 'Section 214(c)(1)', '8 U.S.C. 1184(c)(1)'],
  [45, '410.1208', 'Special Immigrant Juvenile', '8 U.S.C. 1101(a)(27)(J)'],
  [20, '655.700', 'formerly INA section 214(m)', '(8 U.S.C. 1184(n))']
]) {
  const field = allFields.find(field => field.context.title === title && field.context.sourceHost.section === section && field.text.includes(sourcePhrase));
  assert(field, `${title} CFR ${section}`);
  assert(plain(render(field.text, field.references, field.context)).includes(retainedParallel), `${title} CFR ${section}: preserve the USC parallel after an INA annotation`);
}
const historicalList = allFields.find(field => field.sourceId === '8-1101-note-17' && field.text.includes('236 or 242 and 242B'));
for (const [text, section] of [['236', '1226'], ['242', '1252'], ['242B', '1252b']]) {
  const reference = historicalList.references.find(reference => reference.text === text && reference.start >= 2696 && reference.start <= 2711);
  assert.equal(reference.targetSection, section, 'Distinct INA sections in a historical list must retain distinct destinations');
  assert.equal(reference.targetEdition, '1994');
}
const motivation = allFields.find(field => field.context.title === 29 && field.context.sourceHost.section === '501.6' && field.text.includes('8 U.S.C. 1188'));
assert(motivation);
assert(plain(render(motivation.text, motivation.references, motivation.context)).includes('INA 218'));
const dated = allFields.flatMap(field => field.references.filter(reference => reference.targetEdition &&
  (/\((?:1994|1999|2000)\)\s*$/.test(reference.text) || reference.text === '8 U.S.C. 1226(e)(1)')).map(reference => ({ field, reference })));
assert.equal(dated.length, 4, 'Three edition-qualified citations include both endpoints of the 1994 range');
for (const { field, reference } of dated) {
  assert.equal(reference.resolution, 'official-source-only');
  assert(!reference.targetPath.includes(reference.targetEdition));
  assert(reference.officialUrl.includes(`edition=${reference.targetEdition}`));
  const html = render(field.text, field.references, field.context);
  assert(html.includes(`data-reference-edition="${reference.targetEdition}"`));
  assert(html.includes('data-reference-status="historical"'));
}
console.log('PASS explicit USC display: 29 CFR 501.6, Follow view, source metadata, note/sequence/parallel guards, and historical edition URLs');
const sha = value => require('crypto').createHash('sha256').update(value).digest('hex');
const hashedFields = new Map(allFields.filter(field => field.context.sourceHost).map(field => [`${field.context.sourceHost.kind}:${field.context.sourceHost.title}:${field.context.sourceHost.section}:${field.field}:${sha(field.text)}`, field]));
let guardedHistoricalLocators = 0;
let linkedHistoricalLocators = 0;
const canonicalLocators = JSON.parse(fs.readFileSync('sources/legal/historical-reference-locators.json', 'utf8'));
assert.deepEqual(corpus.historicalLocatorCorrections, canonicalLocators.filter(row => row.kind !== 'usc').map(({ review, reason, sourceSha256, ...guard }) => guard), 'Delivery retains exact runtime guards without build-only USC rows or audit attributes');
for (const correction of canonicalLocators) {
  const field = hashedFields.get(`${correction.kind}:${correction.title}:${correction.section}:${correction.field}:${correction.sourceSha256}`);
  assert(field, correction.id);
  const reference = field.references.find(reference => reference.start === correction.start && reference.end === correction.end);
  assert.equal(reference.text, correction.text);
  assert.equal(reference.targetSection, correction.target.section);
  assert.deepEqual(reference.targetPath, correction.target.path);
  if (reference.resolution === 'unresolved') {
    guardedHistoricalLocators++;
    assert(/as in effect|prior to|before|repeal/i.test(field.text), 'A historical guard must be grounded in the source temporal qualification');
    assert(/historical|verified|effect/i.test(reference.citationNote || ''), 'A guarded locator must explain why its old default edition is insufficient');
    assert(!reference.targetEdition, 'An unverified exact date must not claim a verified edition');
    const isolated = [{...reference,start:0,end:reference.text.length}];
    assert(!render(reference.text, isolated, field.context).includes('data-legal-reference'), 'A guarded historical locator must not render an action');
    assert.equal(render(reference.text, isolated, { ...field.context, citationDisplaySystem: 'usc' }), reference.text, 'A guarded historical locator retains exact source wording in source mode');
    continue;
  }
  if (reference.resolution === 'local' && reference.targetSection === '1254' && !reference.targetEdition) {
    const historical = corpus.title8.sections.find(section => section.section === '1254').historical;
    assert.match(historical.versionLabel, /1995.*104-132/);
    assert.equal(reference.historicalOfficialUrl, historical.sourceUrl);
    assert.match(reference.citationNote, /1995 base edition.*subsequent amendments/);
    assert(render(field.text, field.references, field.context).includes('data-show-citation'), 'The supplemented retained historical body remains locally navigable');
    linkedHistoricalLocators++;
    continue;
  }
  linkedHistoricalLocators++;
  assert.equal(reference.targetEdition, correction.target.edition === 'prelim' ? undefined : correction.target.edition);
  assert.equal(reference.resolution, correction.target.edition === 'prelim' ? 'local' : 'official-source-only');
  const html = render(field.text, field.references, field.context);
  if (correction.target.edition !== 'prelim') assert(html.includes(`data-reference-edition="${correction.target.edition}"`));
  if (correction.target.url) assert.equal(reference.officialUrl, correction.target.url);
  if (correction.citationNote) assert.equal(reference.citationNote, correction.citationNote);
}
assert(guardedHistoricalLocators > 0 && linkedHistoricalLocators > 0, 'Exercise both exact-date abstention and verified historical edition destinations');
console.log(`PASS reviewed historical locators: ${canonicalLocators.length} canonical exact source spans and edition targets survive corpus packing`);
