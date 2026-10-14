#!/usr/bin/env node
"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runtime, plain } = require('./audit-ina-display');
const { readArtifact } = require('./audit-inline-references');
const { generatedReferences, legalReferenceContext } = require('./legal-references');
const corpus = readArtifact('INASearch-Uncompressed.html');
const shared = legalReferenceContext(corpus);
const api = runtime(fs.readFileSync('src/INASearch.template.html', 'utf8'), corpus);
function render(text, title = '8', section = '1101', options = {}) {
  const references = generatedReferences(text, { ...shared, kind: 'usc', title, section, path: [], sourceField: 'text', sourceText: text });
  const context = { kind: 'usc', title, uscSection: section, sourceHost: { title, section }, ...options };
  return { text: plain(api.linkifyStatutoryText(text, references, 0, undefined, null, [], context)), references,
    html: api.linkifyStatutoryText(text, references, 0, undefined, null, [], context) };
}
for (const [source, expected, section] of [
  ['As used in this chapter—', 'As used in the INA—'],
  ['This chapter applies.', 'The INA applies.'],
  ['As used in subchapters I and II—', 'As used in Titles I and II—'],
  ['Access to classified information under this subchapter.', 'Access to classified information under Title V.', '1532'],
  ['As used in subchapter III—', 'As used in Title III—'],
  ['Under subchapter III of this chapter, benefits follow.', 'Under Title III of the INA, benefits follow.'],
  ['Under this subchapter.', 'Under Title II.', '1151'],
  ['Under this subchapter.', 'Under Chapter 2 of Title IV.', '1522'],
  ['Under part IV of this subchapter.', 'Under Chapter 4 of Title II.', '1252'],
  ['Under part IV of this subchapter, proceedings under such part begin.', 'Under Chapter 4 of Title II, proceedings under such chapter begin.', '1252'],
  ['Under part IV of this subchapter and part I of another Act, such part applies.', 'Under Chapter 4 of Title II and part I of another Act, such part applies.', '1252'],
  ['Under part VII of subchapter II of chapter 12 of title 8, United States Code.', 'Under Chapter 7 of Title II of the INA.'],
  ['As provided in section 1151 of this chapter.', 'As provided in INA 201.'],
  ['Under subchapter III of this chapter and that subchapter.', 'Under Title III of the INA and Title III.'],
  ['Under subchapters II and IV of this chapter.', 'Under Title II and Chapter 2 of Title IV of the INA.']
]) {
  assert.equal(render(source, '8', section || '1101').text, expected, source);
  assert.equal(render(source, '8', section || '1101', { plainText: true }).text, expected, `copy: ${source}`);
  assert.equal(render(source, '8', section || '1101', { citationDisplaySystem: 'usc' }).text, source, `USC: ${source}`);
}
for (const [text,title,section] of [
  ['For purposes of this chapter.', '8', '1611'],
  ['Title III [subchapter III of this chapter] applies.', '8', '1101'],
  ['Under this chapter and section 923 of this title.', '18', '922'],
  ['Under subchapters II, XVI, and XIX of this chapter.', '42', '405'],
  ['Title III of the Act is classified principally to subchapter III (§ 1401 et seq.) of this chapter.', '8', '1440e']
]) assert.equal(render(text,title,section).text,text);
const converted = render('Under this chapter and subchapters I and II.');
assert.equal((converted.html.match(/data-legal-reference/g)||[]).length, converted.references.length);
assert(converted.html.includes('data-show-citation="INA"'), 'Converted hierarchy links must navigate with a canonical INA address');
const external = render('chapter 43 of title 38 and such chapter; subchapter XVI (or subchapter II).','42','405');
assert(external.references.some(r=>r.text==='such chapter'&&r.targetTitle==='38'&&r.targetChapter==='43'));
assert(external.references.some(r=>r.text==='subchapter II'&&r.targetTitle==='42'&&r.targetSubchapter==='II'));
const suchTitle=render('chapter 33 of title 5 or chapter 35 of such title.','26','3121');
assert(suchTitle.references.some(r=>r.text==='chapter 35'&&r.targetTitle==='5'&&r.targetChapter==='35'));
const inheritedChapter=render('chapter 7 of title 42 and subchapter II of that chapter.','26','3121');
assert(inheritedChapter.references.some(r=>r.text==='subchapter II'&&r.targetTitle==='42'&&r.targetChapter==='7'));
const multiple = render('Benefits under subchapters II, VIII, and XVI for individuals entitled under more than one such subchapter.','42','405');
assert(!multiple.references.some(r=>r.text==='such subchapter'), 'A plural antecedent must not be narrowed to its last item');
for (const [text, title, section, target] of [
  ['Under section 12301(d) of this title or under section 502(f) of title 32.', '10', '101', '12301'],
  ['A financial institution (as defined in section 984(c)(2)(A) of this title) with a covered institution under section 5318(j)(1) of title 31.', '18', '981', '984']
]) {
  const refs = render(text, title, section).references.filter(ref=>ref.targetSection===target);
  assert(refs.length && refs.every(ref=>ref.targetTitle===title), 'An explicit this-title qualifier must outrank a later, unrelated numbered title');
}
console.log('PASS INA hierarchy conversion, exact scope, compound grammar, copy, USC mode, and external title resolution');

// Source-backed note fixture: keep the codifier's bracketed locator inside
// the quoted savings clause, even when the surrounding reader uses the INA.
const savings = corpus.title8.sections.find(section => section.section === '1101').notes
  .find(note => note.text?.includes('title III [subchapter III of this chapter]'));
assert(savings?.references.some(ref => ref.text === 'subchapter III'));
const savingsHtml = api.linkifyStatutoryText(savings.text, savings.references, 0, undefined, null, [], {
  kind: 'usc', title: '8', uscSection: '1101', sourceHost: {title:'8', section:'1101'}, sourceLayout: savings.layout
});
assert(plain(savingsHtml).includes('title III [subchapter III of this chapter]'));
let qualified = 0;
for (const section of [...corpus.title8.sections, ...corpus.referencedUsc.titles.flatMap(title => title.sections)]) {
  if (section.historical) continue;
  const title = String(section.title || 8);
  const walk = node => {
    for (const [field, property] of [['text','references'], ['continuation','continuationReferences'], ['preamble','preambleReferences']]) {
      for (const reference of node[property] || []) {
        if (reference.family !== 'usc' || !reference.targetSection || reference.targetEdition) continue;
        if (!/\bof this (?:title|chapter|subchapter)\b/i.test(reference.text) &&
            !/^\s+of this (?:title|chapter|subchapter)\b/i.test(String(node[field] || '').slice(reference.end))) continue;
        assert.equal(reference.targetTitle, title, `${title} USC ${section.section}: ${reference.text} must retain its source title`);
        qualified++;
      }
    }
    for (const child of [...node.body || [], ...node.children || []]) walk(child);
  };
  walk(section);
}
assert(qualified > 1800, 'Exercise qualified references across the current USC corpus');
console.log(`PASS source-backed quoted locator and ${qualified} current-law source-title qualifiers`);
