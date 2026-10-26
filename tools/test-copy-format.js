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
const formatCases=[
  {format:'[CiTaTiOn][SpAcE][TaB][TeXt]',text:'First\n  Child',want:'8 U.S.C. 1101(a) \tFirst\n  Child'},
  {format:'Heading\n[tab][space][tab][citation]:\n[text]',text:'First\n  Child\n\nLast',want:'Heading\n\t \t8 U.S.C. 1101(a):\n\t \tFirst\n\t \t  Child\n\n\t \tLast'},
  {format:'[tab][citation] - [text]',text:'First\n  Child',want:'\t8 U.S.C. 1101(a) - First\n\t  Child'},
  {format:'[tab][citation]\n[tab][text]',text:'First\n  Child',want:'\t8 U.S.C. 1101(a)\n\tFirst\n\t  Child'},
  {format:'[text]\n[space][space][citation]',text:'First\n  Child',want:'  First\n    Child\n  8 U.S.C. 1101(a)'},
  {format:'See [space][citation]\n[text]',text:'First\n  Child',want:'See  8 U.S.C. 1101(a)\nFirst\n  Child'},
  {format:'\t[citation]\n[text]\n [citation]\n[text]',text:'First\n  Child',want:'\t8 U.S.C. 1101(a)\n\tFirst\n\t  Child\n 8 U.S.C. 1101(a)\n First\n   Child'},
  {format:'[citation][space][text]',text:'Literal [space], [tab] and [unknown].',want:'8 U.S.C. 1101(a) Literal [space], [tab] and [unknown].'},
  {format:'[tab][text]',text:'First\n  Child',want:'\tFirst\n  Child'},
  {format:'[space][tab][citation]:\n[text]',text:'First\r\n  Child\r\n',want:' \t8 U.S.C. 1101(a):\n \tFirst\n \t  Child\n'}
];
for(const fixture of formatCases) {
  api.profile.preferences.citationCopyPreface=fixture.format;
  assert.equal(api.citationCopyPreface('8 U.S.C. 1101(a)',fixture.text),fixture.want,
    `Copy format must expand whitespace and inherit citation indentation: ${JSON.stringify(fixture.format)}`);
}
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
vm.runInContext(functionSource(template,'legalCopyHtml'),api);
assert.equal(api.legalCopyHtml('\t A < B & C\n  child\n\n'),
  '<div><p style="margin:0;margin-left:2.5em;text-indent:0.01px;white-space:pre-wrap;tab-size:4">A &lt; B &amp; C</p><p style="margin:0;margin-left:1em;text-indent:0.01px;white-space:pre-wrap;tab-size:4">child</p><p style="margin:0;margin-left:0em;text-indent:0.01px;white-space:pre-wrap;tab-size:4"><br></p><p style="margin:0;margin-left:0em;text-indent:0.01px;white-space:pre-wrap;tab-size:4"><br></p></div>',
  'Rich copy must apply paragraph indentation to wrapped lines, escape source text and preserve blank lines');
assert(api.legalCopyHtml(' \tline').includes('margin-left:2em'), 'A tab advances to the next four-space stop');
if(process.platform==='darwin'&&process.env.INASEARCH_NATIVE_CLIPBOARD_TESTS==='1') {
  const rich=api.legalCopyHtml('Root\n  (i) Paragraph\n    (A) Subparagraph\n      (1) Clause\n        (i) Deep clause');
  const rtf=require('node:child_process').execFileSync('textutil',['-convert','rtf','-stdout','-format','html','-stdin'],{input:rich,encoding:'utf8'});
  const paragraphs=[...rtf.matchAll(/\\li(\d+)\\fi(-?\d+)/g)].map(match=>({left:Number(match[1]),firstLine:Number(match[2])}));
  assert.equal(paragraphs.length,4,'Native rich-text import must retain all four child indentation levels');
  assert(paragraphs.every((p,index)=>p.firstLine===0&&(!index||p.left>paragraphs[index-1].left)),
    'Native import must indent first and wrapped lines together at every child level');
}

(async()=>{
  let richItems=null,plainText=null;
  const clipboardScope=vm.createContext({Blob,ClipboardItem:class {constructor(data){this.data=data;}},
    navigator:{clipboard:{write:async items=>{richItems=items;},writeText:async text=>{plainText=text;}}},
    legalCopyHtml:api.legalCopyHtml});
  vm.runInContext(functionSource(template,'copyLegalText'),clipboardScope);
  const copied='\t8 U.S.C. 1101(a)\n\tFirst\n\t  Child';
  assert.equal(await clipboardScope.copyLegalText(copied),true);
  assert(richItems,'Indented copy must put a rich representation on the clipboard');
  assert.equal(await richItems[0].data['text/plain'].text(),copied,'Plain-text copy must retain exact tabs and spaces');
  assert.equal(await richItems[0].data['text/html'].text(),api.legalCopyHtml(copied),'Rich and plain copies must describe the same content');
  assert.equal(plainText,null,'A successful rich copy must not be overwritten by plain text');
  clipboardScope.navigator.clipboard.write=async()=>{throw new Error('Rich clipboard unavailable');};
  assert.equal(await clipboardScope.copyLegalText(copied),true);
  assert.equal(plainText,copied,'Rejected rich clipboard writes must fall back to exact plain text');
  plainText=null;
  delete clipboardScope.ClipboardItem;
  assert.equal(await clipboardScope.copyLegalText(copied),true);
  assert.equal(plainText,copied,'Browsers without rich clipboard support must still preserve literal indentation');
  const handlers=new Set(),legacyData=new Map();
  let textareaRemoved=false,prevented=false;
  clipboardScope.navigator.clipboard.writeText=async()=>{throw new Error('Clipboard API unavailable');};
  clipboardScope.document={
    createElement:()=>({style:{},setAttribute(){},select(){},remove(){textareaRemoved=true;}}),body:{append(){}},
    addEventListener:(_type,listener)=>handlers.add(listener),removeEventListener:(_type,listener)=>handlers.delete(listener),
    execCommand:()=>{for(const listener of handlers) listener({clipboardData:{setData:(type,value)=>legacyData.set(type,value)},preventDefault(){prevented=true;}});return true;}
  };
  assert.equal(await clipboardScope.copyLegalText(copied),true);
  assert.equal(legacyData.get('text/plain'),copied,'Legacy copy must keep the exact plain-text payload');
  assert.equal(legacyData.get('text/html'),api.legalCopyHtml(copied),'Legacy copy must retain paragraph formatting when Clipboard API access is unavailable');
  assert.equal(prevented,true);
  assert.equal(handlers.size,0,'A fallback copy must remove its temporary clipboard listener');
  assert.equal(textareaRemoved,true);
  console.log(`PASS explicit copy formatting: whitespace tokens, inherited indentation, rich/plain clipboard, display independence, footnote boundaries and ${checked} statutory subtrees`);
})().catch(error=>{console.error(error);process.exitCode=1;});
