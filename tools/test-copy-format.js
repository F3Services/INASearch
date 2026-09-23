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
for (const name of ['superscriptNumber','textWithHouseFootnoteMarkers','legalFieldPlainText','statuteNodePlainText','cfrBlockPlainText']) vm.runInContext(functionSource(template,name),api);
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
