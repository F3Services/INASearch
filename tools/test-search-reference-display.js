#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { runtime, plain } = require('./audit-ina-display');
const functionSource = require('./test-function-source');
const occurrence = require('../src/INASearch-Occurrence');
const query = require('../src/INASearch-Query');
const command = require('../src/INASearch-Command');

const text = 'An employer described in section 1101(a)(15)(H)(i)(b) of this title must comply.';
const phrase = 'section 1101(a)(15)(H)(i)(b) of this title';
const reference = { start: text.indexOf(phrase), end: text.indexOf(phrase) + phrase.length, text: phrase,
  family: 'usc', targetKind: 'usc', targetTitle: '8', targetSection: '1101', targetPath: ['a','15','H','i','b'], resolution: 'local' };
const witnessText = 'A condition in section 1184(a) of this title applies.';
const witnessPhrase = 'section 1184(a) of this title';
const witnessReference = {...reference,start:witnessText.indexOf(witnessPhrase),end:witnessText.indexOf(witnessPhrase)+witnessPhrase.length,text:witnessPhrase,targetSection:'1184',targetPath:['a']};
const section = { id: '8-1184', section: '1184', heading: 'Admission', body: [{ label: 'a', text, references: [reference] },{label:'b',text:witnessText,references:[witnessReference]}] };
const cfrText = 'Intro. (a) Admission under 8 U.S.C. 1101(a)(15)(H)(i)(b) is allowed.';
const cfrPhrase = '8 U.S.C. 1101(a)(15)(H)(i)(b)';
const cfrReference = {...reference,start:cfrText.indexOf(cfrPhrase),end:cfrText.indexOf(cfrPhrase)+cfrPhrase.length,text:cfrPhrase};
const cfrSection = {id:'8:214.2',title:8,section:'214.2',part:'214',blocks:[{t:'p',x:cfrText,xReferences:[cfrReference],u:[{a:['a'],s:7}]}]};
const corpus = { title8: { sections: [section, {id:'8-1101', section:'1101', body:[]}] },
  inaCrosswalk: [{inaSection:'214',uscSection:'1184'}, {inaSection:'101',uscSection:'1101'}], cfr: {sections:[cfrSection],appendices:[]} };
const template = fs.readFileSync('src/INASearch.template.html', 'utf8');
const api = runtime(template, corpus);
api.HIGHLIGHT_COLOR_HEX = {yellow:'#ffff00',blue:'#0000ff'};
api.hydratedLegalReferenceRoots = new WeakSet();
api.cfrSectionIdMap = new Map([[cfrSection.id,cfrSection]]);
api.cfrAppendixIdMap = new Map();
for (const name of ['hydrateLegalReferences', 'cfrOccurrenceBlockAtPath', 'occurrenceSnippetSource', 'occurrenceSnippetPartHtml', 'occurrenceConvertedSnippetHtml', 'occurrenceSnippetHtml', 'occurrenceSnippetPartsHtml', 'occurrenceRowTextHtml', 'refreshOccurrenceCitationDisplay']) {
  if (template.includes(`function ${name}(`)) vm.runInContext(functionSource(template, name), api);
}
const projection = occurrence.buildProjection(corpus);
function rows(search, options = {}, contextCharacters = 90) {
  const result = query.search(projection, command.parseCommand(search), {plan:{branches:[{kind:'law',scopes:[]}],citationScopes:[]}, ...options});
  return result.materializeOccurrences({limit:20, contextCharacters}).rows;
}
const visible = html => plain(html.replace(/<template>[\s\S]*?<\/template>/g, ''));
const marks = html => [...html.replace(/<template>[\s\S]*?<\/template>/g, '').matchAll(/<mark\b[^>]*>([\s\S]*?)<\/mark>/g)].map(match => plain(match[1]));
const row = rows('"this title"')[0];
assert(row, 'The raw source phrase must still produce a search hit.');
api.profile.preferences.statutoryLinkCitationSystem = 'view';
for (const [authority, expected, highlighted] of [
  ['ina', 'An employer described in INA 101(a)(15)(H)(i)(b) must comply.', 'INA 101(a)(15)(H)(i)(b)'],
  ['usc', text, 'this title']
]) {
  api.state.statuteHierarchyAuthority = authority;
  const html = api.occurrenceRowTextHtml(row);
  assert.equal(visible(html), expected, 'Search-result references must follow the INA/USC view.');
  assert.deepEqual(marks(html), [highlighted], 'A removed match must highlight the converted reference.');
  assert(!/<a\b/.test(html), 'Result text must not contain links inside its open-result button.');
}
for (const [preference, authority, expected] of [['ina','usc','INA 101(a)(15)(H)(i)(b)'], ['usc','ina',phrase]]) {
  api.profile.preferences.statutoryLinkCitationSystem = preference;
  api.state.statuteHierarchyAuthority = authority;
  assert(visible(api.occurrenceRowTextHtml(row)).includes(expected), 'Always and Never must override the swap button.');
}
api.profile.preferences.statutoryLinkCitationSystem = 'ina';
const employerRow = rows('employer')[0];
assert.deepEqual(marks(api.occurrenceRowTextHtml(employerRow)), ['employer'], 'Converting a nearby reference must preserve an ordinary word match.');
const savedRow = rows('"this title"', {personal:{highlights:[{id:'h',color:'blue',segments:[{id:'s',association:{family:'usc',title:8,start:{unit:'1184',path:['a']}},anchor:{exact:phrase,prefix:'An employer described in ',suffix:' must comply.'}}]}]}})[0];
assert(api.occurrenceRowTextHtml(savedRow).includes('search-saved-match'), 'Saved highlighting must survive reference conversion.');
const savedPrecise = rows('"(15)"', {personal:{highlights:[{id:'h',color:'blue',segments:[{id:'s',association:{family:'usc',title:8,start:{unit:'1184',path:['a']}},anchor:{exact:phrase,prefix:'An employer described in ',suffix:' must comply.'}}]}]}})[0];
const savedPreciseHtml = api.occurrenceRowTextHtml(savedPrecise);
assert.deepEqual([...savedPreciseHtml.matchAll(/<span class="search-saved-highlight search-saved-match"[^>]*>(.*?)<\/span>/g)].map(match=>plain(match[1])), ['15'], 'The saved color must not broaden a precise search match.');
assert.deepEqual(marks(api.occurrenceRowTextHtml(rows('"(15)"')[0])), ['15'], 'A surviving reference substring must retain its precise highlight.');
const titleLetterRow = rows('"i"').find(candidate => candidate.snippet.matchStart === text.indexOf('title') + 1);
assert.deepEqual(marks(api.occurrenceRowTextHtml(titleLetterRow)), ['INA 101(a)(15)(H)(i)(b)'], 'A removed source letter must not move to the same letter elsewhere in the converted address.');
const clipped = rows('"this title"',{},2)[0];
assert.equal(visible(api.occurrenceRowTextHtml(clipped)), '…INA 101(a)(15)(H)(i)(b) m…', 'A clipped match must display the entire converted reference.');
const cfrRow = rows('allowed')[0];
assert.equal(visible(api.occurrenceRowTextHtml(cfrRow)), '(a) Admission under INA 101(a)(15)(H)(i)(b) is allowed.', 'CFR fragments must map snippet offsets into their source block.');
const combined = rows('common:section "this title" condition')[0];
assert(visible(api.occurrenceRowTextHtml(combined)).includes('A condition in INA 214(a) applies.'), 'An additional condition must convert references using its own source field.');
assert.deepEqual(marks(api.occurrenceRowTextHtml(combined)), ['INA 101(a)(15)(H)(i)(b)','condition'], 'Each condition must retain its highlight after conversion.');
const listText = 'sections 1101(a) and section 1184(a) of this title';
const listReferences = [['sections 1101(a)','1101'], ['section 1184(a) of this title','1184']].map(([phrase,section])=>({...reference,start:listText.indexOf(phrase),end:listText.indexOf(phrase)+phrase.length,text:phrase,targetSection:section,targetPath:['a']}));
const listSource = {authority:'ina',recordId:section.id,target:{field:'body',recordPath:[2],subfield:'text'}};
section.body.push({label:'c',text:listText,references:listReferences});
const repeatedStart = listText.indexOf('section ', 1);
const listHtml = api.occurrenceRowTextHtml({ ...listSource, snippets:[{start:0,end:listText.length,parts:[{text:listText.slice(0,repeatedStart)},{text:'section',match:true},{text:listText.slice(repeatedStart+7)}]}] });
assert.deepEqual(marks(listHtml), ['214(a)'], 'A removed repeated section word must highlight its converted list member.');
console.log('PASS search reference display: view, overrides, removed matches, nearby words and saved highlights');

// A preference change must update existing rows, including a search pane with
// no reader record, without changing its query or materialized result set.
api.profile.preferences.statutoryLinkCitationSystem = 'usc';
const textButton = {innerHTML:api.occurrenceRowTextHtml(row)};
const rowElement = {dataset:{occurrenceRowSection:encodeURIComponent('s'),occurrenceRow:'0'},querySelector:()=>textButton};
const pane = {detail:{},entry:{mode:'search-tree'},searchState:{rowsBySection:new Map([['s',{rows:[row]}]])}};
api.$$ = (_selector, root) => root === pane.detail ? [rowElement] : [];
api.occurrenceSectionIdFromToken = decodeURIComponent;
api.refreshLegalCopyDescriptions = api.closeLegalReferencePopover = api.closeScopedDefinitionPopover = () => {};
api.window = {scrollY:10,scrollTo:()=>{}};
api.requestAnimationFrame = callback => callback();
api.withFocusedCitationPane = (_pane, callback) => callback();
api.scopeFocusedPaneIds = api.fitStatuteNavigation = api.syncStatuteNavigationOffset = api.rememberFocusedPaneReadingAnchor = () => {};
api.state.mainOccurrencePane = pane;
vm.runInContext(functionSource(template, 'refreshStatutoryCitationDisplay'), api);
api.profile.preferences.statutoryLinkCitationSystem = 'ina';
api.refreshStatutoryCitationDisplay();
assert(visible(textButton.innerHTML).includes('INA 101(a)(15)(H)(i)(b)'), 'Changing the setting must refresh existing main search rows.');
api.state.focusedCitationMode = true;
api.state.focusedCitationPanes = [{...pane,id:'p',scrollRoot:{scrollTop:50}}];
api.profile.preferences.statutoryLinkCitationSystem = 'usc';
api.refreshStatutoryCitationDisplay();
assert(visible(textButton.innerHTML).includes(phrase), 'Changing the setting must refresh search panes without a reader record.');
console.log('PASS search reference refresh: main and side-by-side results');
