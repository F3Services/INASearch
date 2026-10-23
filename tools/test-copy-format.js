#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const { runtime } = require('./audit-ina-display');
const { readArtifact, collectFields } = require('./audit-inline-references');
const functionSource = require('./test-function-source');
const template = fs.readFileSync('src/INASearch.template.html','utf8');
const corpus = readArtifact('INASearch-Uncompressed.html');
const api = runtime(template,corpus);
for (const name of ['superscriptNumber','textWithHouseFootnoteMarkers','statuteTextRangeWithHouseFootnotes','legalFieldPlainText','statuteNodePlainText','cfrBlockPlainText']) vm.runInContext(functionSource(template,name),api);
const fields=collectFields(corpus);
const field=fields.find(f=>f.sourceId==='8-1226-c-1-B'&&f.field==='text');
const expected='is deportable by reason of having committed any offense covered in INA 237(a)(2)(A)(ii), (A)(iii), (B), (C), or (D),';
for (const preference of ['ina','usc','view']) for(const state of ['ina','usc']) {
  api.profile.preferences.statutoryLinkCitationSystem=preference;
  api.state.statuteHierarchyAuthority=state;
  assert.equal(api.legalFieldPlainText({text:field.text,references:field.references},'text',{kind:'usc',uscSection:'1226'}),expected,'Explicit serialization must be independent of display state');
}
const source={text:'A < B & C > D; “quoted”',textFootnoteReferences:[{id:'n1',number:1,offset:5},{id:'n2',number:2,offset:8}]};
const used=new Set();
assert.equal(api.legalFieldPlainText(source,'text',{},used,0,8),'A < B¹ & ');
assert.deepEqual([...used],['n1'],'A footnote at the next unit boundary belongs to that unit');
assert.equal(api.legalFieldPlainText(source,'text',{}),'A < B¹ & ²C > D; “quoted”','Plain text must preserve punctuation and must not HTML-escape source characters');
for (const name of ['preferredLegalUnitCitation','legalUnitCopyText','citationCopyPreface','citationWithLegalText']) vm.runInContext(functionSource(template,name),api);
api.state.statuteHierarchyAuthority='usc';
api.profile.preferences.citationCopyPreface='[citation] - [text]';
const copyCases=[
  {path:['a','1'],text:'(1) Original source text.\n  (A) Child text.',want:'Original source text.\n  (A) Child text.'},
  {path:['a'],text:'(a) Heading Text citing INA 237(a)(2).\n  (1) Child text.',want:'Heading Text citing INA 237(a)(2).\n  (1) Child text.'},
  {path:['a','15','H'],text:'(15)(H) A run-in unit.',want:'A run-in unit.'},
  {path:['a'],text:'(a)(1) A compound marker with a child unit.',want:'(1) A compound marker with a child unit.'},
  {path:['t'],duplicates:true,text:'(t) ¹¹First heading\n  (1) First child.\n\n(t) ¹²Second heading\n  (1) Second child.',want:'¹¹First heading\n  (1) First child.\n\n¹²Second heading\n  (1) Second child.'},
  {path:[],text:'§1101. Definitions\n\n(a) First subsection.',want:'Definitions\n\n(a) First subsection.'},
  {path:[],historical:true,text:'REPEALED—NOT CURRENT LAW.\n\n§1101. Historical heading\n\n(a) Historical text.',want:'REPEALED—NOT CURRENT LAW.\n\nHistorical heading\n\n(a) Historical text.'},
  {path:['1'],historical:true,text:'TRANSFERRED—NOT CURRENT AT THIS LOCATION. Source notice.\n\n(1) Historical text.',want:'TRANSFERRED—NOT CURRENT AT THIS LOCATION. Source notice.\n\nHistorical text.'},
  {path:[],historical:true,text:'REPEALED—NOT CURRENT LAW. Source notice.\n\n§137–5. Limits\n\n(a) Historical text.',want:'REPEALED—NOT CURRENT LAW. Source notice.\n\nLimits\n\n(a) Historical text.'},
  {path:['a'],text:'Text already without a marker.',want:'Text already without a marker.'},
  {path:['a'],text:'(1) Child text when the selected parent has no marker.',want:'(1) Child text when the selected parent has no marker.'}
];
for(const fixture of copyCases) {
  const citation='8 U.S.C. 1101'+fixture.path.map(token=>`(${token})`).join('');
  const context={kind:'usc',path:fixture.path,uscCitation:citation,text:fixture.text,statuteSection:fixture.historical?{historical:{status:'repealed'}}:fixture.duplicates?{body:[{label:'t'},{label:'t'}]}:null};
  assert.equal(api.citationWithLegalText(context),citation+' - '+fixture.want,'The template must not repeat the selected citation unit in [text]');
  api.profile.preferences.citationCopyPreface='[TeXt]\n\n[CiTaTiOn]';
  assert.equal(api.citationWithLegalText(context),fixture.want+'\n\n'+citation,'Custom token order and capitalization must preserve the same text boundary');
  api.profile.preferences.citationCopyPreface='[citation] - [text]';
  assert.equal(context.text,fixture.text,'Template formatting must not alter the source used for printing');
}
const markers=text=>text.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g)||[];
let checked=0;
for(const section of corpus.title8.sections) for(const node of section.body||[]) {
  const source=api.statuteNodePlainText(node);
  const text=api.statuteNodePlainText(node,0,new Set(),{kind:'usc',uscSection:section.section,sourceHost:{kind:'usc',title:8,section:section.section}});
  assert.deepEqual(markers(text),markers(source),`Copy loses footnote markers in ${section.id}/${node.label}`);
  assert.equal(text.split('\n').length,source.split('\n').length,`Copy changes paragraph structure in ${section.id}/${node.label}`);
  checked++;
}
console.log(`PASS explicit copy formatting: display independence, literal punctuation, footnote boundaries and ${checked} statutory subtrees`);
