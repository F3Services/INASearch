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
const sectionContext = { kind: 'ina', uscSection: '1226' };
for (const [id, expected] of [
  ['8-1226-c-1-B', 'is deportable by reason of having committed any offense covered in INA 237(a)(2)(A)(ii), (A)(iii), (B), (C), or (D),'],
  ['8-1226-c-1-E-i', 'is inadmissible under paragraph (6)(A), (6)(C), or (7) of INA 212(a); and']
]) {
  const field = fields.find(f => f.sourceId === id && f.field === 'text');
  const html = render(field.text, field.references, sectionContext);
  assert.equal(plain(html), expected);
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
let count = 0;
for (const field of fields) {
  const html = render(field.text, field.references, contextFor(field, corpus));
  const links = [...html.matchAll(/data-reference-source-text="([^"]*)"/g)].map(match => plain(match[1]));
  assert.deepEqual(links, field.references.map(ref => ref.text), `${field.sourcePath}.${field.field}: source link order and membership`);
  count += links.length;
}
console.log(`PASS INA display: examples, repeated citation ancestors, CFR alternatives, prose boundaries, preference off, and ${count} source links in exact order`);

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
assert.equal(plain(render(sharedPrefixText, sharedPrefixRefs, sectionContext)), sharedPrefixText, 'A member of a shared USC prefix must not be converted in isolation');
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
assert(historicAlternativeDisplay.includes('INA 240A(b)(2) or 8 U.S.C. 1254(a)(3) (as in effect before'), 'An unmapped historical alternative must retain explicit USC authority and its temporal qualifier');
const oldRange = fields.find(field=>field.sourceId==='8-701 to 724a-note-26'&&field.field==='text');
assert(plain(render(oldRange.text,oldRange.references,contextFor(oldRange,corpus))).endsWith('See INA 329(a)–(c).'), 'A relative paragraph range must preserve endpoints and remove the dangling title container');
const longListStart = performance.now();
assert.equal(api.inUnfinishedStatutoryList('sections '+'1'.repeat(12000)+' unrelated prose'),false);
assert(performance.now()-longListStart<250,'Section-list scope scanning backtracks on a long numeric token');
console.log('PASS mixed historical list, relative range and linear list-scope scanning');
