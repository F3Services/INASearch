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
for (const name of ['preferredLegalUnitCitation','legalUnitCopyText','citationCopyPreface','citationWithLegalText','legalUnitTextWithoutCitation','legalTextForCopy']) vm.runInContext(functionSource(template,name),api);
api.state.statuteHierarchyAuthority='usc';
const simpleContext={kind:'usc',uscCitation:'8 U.S.C. 1101(a)(1)',path:['a','1'],text:'(1) First paragraph.\n  (A) Child paragraph.'};
api.profile.preferences.citationCopyPreface='Custom [citation]\n[text]';
assert.equal(api.legalTextForCopy(simpleContext),'First paragraph.\n  (A) Child paragraph.',
  'Default Copy must use simple legal text even with a saved custom template');
api.profile.preferences.simpleCopyIncludeCitation=true;
assert.equal(api.legalTextForCopy(simpleContext),'8 U.S.C. 1101(a)(1) : First paragraph.\n  (A) Child paragraph.',
  'Simple copy optionally prefixes the full citation with a spaced colon');
api.profile.preferences.defaultCopyFormat='custom';
assert.equal(api.legalTextForCopy(simpleContext),'Custom 8 U.S.C. 1101(a)(1)\nFirst paragraph.\n  (A) Child paragraph.');
assert.equal(api.legalTextForCopy(simpleContext,'simple'),'8 U.S.C. 1101(a)(1) : First paragraph.\n  (A) Child paragraph.',
  'Explicit Simple ignores the chosen default and custom template');
api.profile.preferences.simpleCopyIncludeCitation=false;
api.profile.preferences.defaultCopyFormat='simple';
assert.equal(api.legalTextForCopy(simpleContext,'custom'),'Custom 8 U.S.C. 1101(a)(1)\nFirst paragraph.\n  (A) Child paragraph.',
  'Explicit Custom ignores the chosen default and simple prefix preference');
api.profile.preferences.citationCopyPreface='[citation]';
assert.equal(api.legalTextForCopy(simpleContext,'custom'),'8 U.S.C. 1101(a)(1)','Custom may intentionally omit text');
api.profile.preferences.citationCopyPreface='';
assert.equal(api.legalTextForCopy(simpleContext,'custom'),'','An empty custom template remains literal');
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
  assert.equal(api.legalTextForCopy(context,'simple'),fixture.want,'Simple text omits the selected unit marker while retaining child markers and historical notices');
  api.profile.preferences.simpleCopyIncludeCitation=true;
  assert.equal(api.legalTextForCopy(context,'simple'),citation+' : '+fixture.want,'Simple text with a full citation must not repeat the selected unit marker');
  api.profile.preferences.simpleCopyIncludeCitation=false;
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
  '<div><p style="margin:0;margin-left:30pt;text-indent:0.01px;white-space:pre-wrap;tab-size:4">A &lt; B &amp; C</p><p style="margin:0;margin-left:12pt;text-indent:0.01px;white-space:pre-wrap;tab-size:4">child</p><p style="margin:0;margin-left:0pt;text-indent:0.01px;white-space:pre-wrap;tab-size:4"><br></p><p style="margin:0;margin-left:0pt;text-indent:0.01px;white-space:pre-wrap;tab-size:4"><br></p></div>',
  'Rich copy must apply paragraph indentation to wrapped lines, escape source text and preserve blank lines');
assert(api.legalCopyHtml(' \tline').includes('margin-left:24pt'), 'A tab advances to the next four-space stop');
if(process.env.INASEARCH_LIBREOFFICE_TESTS==='1') {
  const path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
  const directory=fs.mkdtempSync(path.join(process.env.INASEARCH_VERIFICATION_DIR||os.tmpdir(),'inasearch-copy-import-'));
  try {
    const html=path.join(directory,'clipboard.html');
    fs.writeFileSync(html,'<!doctype html><html><head><meta charset="utf-8"></head><body>'+
      api.legalCopyHtml('Root\n  (i) Paragraph\n    (A) Subparagraph\n      (1) Clause\n        (i) Deep clause')+'</body></html>');
    execFileSync(process.env.INASEARCH_SOFFICE_BIN||'soffice',[
      `-env:UserInstallation=${require('node:url').pathToFileURL(path.join(directory,'profile')).href}`,
      '--headless','--convert-to','docx:Office Open XML Text','--outdir',directory,html
    ],{encoding:'utf8',timeout:30000});
    const imported=JSON.parse(execFileSync('python3',['-c',String.raw`
import json,sys
from zipfile import ZipFile
from xml.etree import ElementTree as ET
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with ZipFile(sys.argv[1]) as z:
    root=ET.fromstring(z.read('word/document.xml'))
    paragraphs=[]
    for p in root.findall('.//w:body/w:p',ns):
        text=''.join(t.text or '' for t in p.findall('.//w:t',ns))
        if not text: continue
        ind=p.find('w:pPr/w:ind',ns)
        attrs={} if ind is None else {k.split('}')[-1]:int(v) for k,v in ind.attrib.items()}
        paragraphs.append({'text':text,'left':attrs.get('start',attrs.get('left',0)),'firstLine':attrs.get('firstLine',0)-attrs.get('hanging',0)})
    print(json.dumps(paragraphs))
`,path.join(directory,'clipboard.docx')],{encoding:'utf8'}));
    assert.deepEqual(imported.map(p=>p.text),['Root','(i) Paragraph','(A) Subparagraph','(1) Clause','(i) Deep clause']);
    assert.deepEqual(imported.map(p=>p.left),[0,240,480,720,960],
      'LibreOffice import must preserve twelve-point paragraph indents at every child level');
    assert(imported.every(p=>p.firstLine===0),'First and wrapped lines must share the same child indent');
    console.log('PASS LibreOffice clipboard HTML import: four nested paragraph indents and aligned wrapped lines');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
if(process.platform==='darwin'&&process.env.INASEARCH_NATIVE_CLIPBOARD_TESTS==='1') {
  const rich=api.legalCopyHtml('Root\n  (i) Paragraph\n    (A) Subparagraph\n      (1) Clause\n        (i) Deep clause');
  const rtf=require('node:child_process').execFileSync('textutil',['-convert','rtf','-stdout','-format','html','-stdin'],{input:rich,encoding:'utf8'});
  const paragraphs=[...rtf.matchAll(/\\li(\d+)\\fi(-?\d+)/g)].map(match=>({left:Number(match[1]),firstLine:Number(match[2])}));
  assert.equal(paragraphs.length,4,'Native rich-text import must retain all four child indentation levels');
  assert(paragraphs.every((p,index)=>p.firstLine===0&&(!index||p.left>paragraphs[index-1].left)),
    'Native import must indent first and wrapped lines together at every child level');
}

// Catch native-copy interception of selections/editors and stale split-pane targets.
const copyState={view:'search',focusedCitationMode:false};
let selectedText='',editing=false,dialogOpen=false;
let reducedMotion=false;
const animationCalls=[];
function feedbackElement(id) {
  const animations=[];
  return {id,isConnected:true,getAnimations:()=>animations.filter(animation=>!animation.canceled),
    animate(frames,options){const animation={cancel(){this.canceled=true;}};animations.push(animation);animationCalls.push({id,frames,options,animation});return animation;}};
}
const mainBox=feedbackElement('main-box'),paneBox=feedbackElement('pane-box');
const mainActions={simple:feedbackElement('main-simple'),custom:feedbackElement('main-custom')};
const paneActions={simple:feedbackElement('pane-simple'),custom:feedbackElement('pane-custom')};
const copyTarget={closest:()=>editing?{}:null};
const searchTarget={closest:()=>searchTarget,selectionStart:4,selectionEnd:4};
const pane={id:'second',readerActions:paneActions,context:{kind:'cfr',cfrCitation:'8 CFR 103.2(b)',path:['b'],text:'(b) Second pane text.'}};
const nativeScope=vm.createContext({
  state:copyState,profile:api.profile,els:{search:searchTarget,mainReaderActions:mainActions}, document:{activeElement:copyTarget,querySelector:()=>dialogOpen?{}:null},
  window:{getSelection:()=>({toString:()=>selectedText}),matchMedia:()=>({matches:reducedMotion})},
  getComputedStyle:()=>({backgroundColor:'#ffffff',boxShadow:'none',getPropertyValue:name=>name==='--success'?'#148045':'#ecf9f1'}),
  $:(selector,root)=>root[selector.includes('copy-citation-text')?'custom':'simple'],
  focusedPaneForElement:target=>target?.pane || null,
  focusedPaneById:id=>id===pane.id?pane:null,
  withFocusedCitationPane:(value,callback)=>{copyState.focusedPaneContext=value;try{return callback();}finally{copyState.focusedPaneContext=null;}},
  mainReaderActionContext:()=>copyState.focusedPaneContext?.context || simpleContext,
  mainReaderActionTarget:()=>({preview:copyState.focusedPaneContext?paneBox:mainBox}),
  legalTextForCopy:api.legalTextForCopy, legalCopyHtml:api.legalCopyHtml,toast:()=>{}
});
for(const name of ['readerCopyFeedbackTargets','flashLegalCopyFeedback']) if(template.includes(`function ${name}(`)) vm.runInContext(functionSource(template,name),nativeScope);
vm.runInContext(functionSource(template,'handleReaderCopy'),nativeScope);
function nativeCopy(overrides={}) {
  animationCalls.length=0;
  const data=new Map();
  const event={target:copyTarget,defaultPrevented:false,clipboardData:{setData:(type,text)=>data.set(type,text)},preventDefault(){this.defaultPrevented=true;},...overrides};
  const handled=nativeScope.handleReaderCopy(event);
  return {data,event,handled};
}
api.profile.preferences.citationCopyPreface='Custom [citation]\n[text]';
assert.equal(nativeCopy().data.get('text/plain'),'First paragraph.\n  (A) Child paragraph.',
  'No-selection Copy must copy the complete highlighted provision');
api.profile.preferences.defaultCopyFormat='custom';
assert.equal(nativeCopy().data.get('text/plain'),'Custom 8 U.S.C. 1101(a)(1)\nFirst paragraph.\n  (A) Child paragraph.');
api.profile.preferences.defaultCopyFormat='simple';
copyState.focusedCitationMode=true;
copyState.focusedCitationPanes=[{id:'first'},pane];
assert.equal(nativeCopy({target:{pane,closest:()=>null}}).data.get('text/plain'),'Second pane text.','Copy uses the pane containing the event target');
copyState.focusedCopyPaneId=pane.id;
assert.equal(nativeCopy().data.get('text/plain'),'Second pane text.','Copy retains the last active pane when focus leaves its body');
copyState.focusedCitationMode=false;
for(const selection of ['Selected legal words',' ']) {
  selectedText=selection;
  assert.equal(nativeCopy().event.defaultPrevented,false,'A real text selection must retain native copy behavior');
}
selectedText='';
editing=true;
assert.equal(nativeCopy().event.defaultPrevented,false,'Inputs and clipboard fallback textareas keep native copy');
editing=false;
nativeScope.document.activeElement=searchTarget;
assert.equal(nativeCopy({target:searchTarget}).data.get('text/plain'),'First paragraph.\n  (A) Child paragraph.',
  'A search field with only a caret must still copy the highlighted provision');
searchTarget.selectionEnd=8;
assert.equal(nativeCopy({target:searchTarget}).event.defaultPrevented,false,'Selected search text retains native copy');
nativeScope.document.activeElement=copyTarget;
dialogOpen=true;
assert.equal(nativeCopy().event.defaultPrevented,false,'Copy inside an open dialog must not copy a reader behind it');
dialogOpen=false;
nativeScope.els.savingMenuModal={hidden:false};
assert.equal(nativeCopy().event.defaultPrevented,false,'The Settings modal is a visible backdrop, not a native dialog; it must block copying the reader behind it');
nativeScope.els.savingMenuModal.hidden=true;
assert.equal(nativeCopy({defaultPrevented:true}).data.size,0,'Do not override another copy handler');
assert.equal(nativeCopy({clipboardData:null}).event.defaultPrevented,false);
copyState.view='sources';
assert.equal(nativeCopy().event.defaultPrevented,false,'Nonreader views retain native copy behavior');
copyState.view='search';
const richNative=nativeCopy();
assert.equal(richNative.event.defaultPrevented,true);
assert(richNative.data.get('text/html').includes('margin-left:12pt'),'Native Copy preserves nested indentation in rich paste');
assert.deepEqual(animationCalls.map(call=>call.id),['main-simple','main-box'],'Successful native Simple Copy flashes its sidebar button and highlighted box');
const oldAnimation=animationCalls[0].animation;
nativeCopy();
assert.equal(oldAnimation.canceled,true,'Repeated Copy restarts feedback immediately');
api.profile.preferences.defaultCopyFormat='custom';
nativeCopy();
assert.deepEqual(animationCalls.map(call=>call.id),['main-custom','main-box'],'Custom Copy flashes only the Custom button and highlighted box');
copyState.focusedCitationMode=true;
nativeCopy({target:{pane,closest:()=>null}});
assert.deepEqual(animationCalls.map(call=>call.id),['pane-custom','pane-box'],'Split-pane Copy flashes only its own sidebar and highlighted box');
copyState.focusedCitationMode=false;
selectedText='Native text selection';
nativeCopy();
assert.equal(animationCalls.length,0,'Native selected-text copy must not flash a whole provision');
selectedText='';
reducedMotion=true;
nativeCopy();
assert(animationCalls.every(call=>call.options.iterations===1),'Reduced-motion Copy uses one steady confirmation');
reducedMotion=false;
api.profile.preferences.defaultCopyFormat='simple';

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
