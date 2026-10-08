#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const runtime=process.env.INASEARCH_BROWSER_RUNTIME || path.join(os.homedir(),'.codex/tools/browser-inspection');
const engines=createRequire(path.join(runtime,'package.json'))('playwright');
const engine=process.argv.includes('--firefox')?'firefox':'chromium';
const mode=['selection','corpus','upgrade','queued','reverse','cancel','burst','manual'].find(flag=>process.argv.includes(`--${flag}`)) || 'matrix';
const browser=await engines[engine].launch({headless:true,...(engine==='firefox'&&process.argv.includes('--spring')?{firefoxUserPrefs:{'general.smoothScroll.msdPhysics.enabled':true}}:{})});
const output=path.resolve('tmp/citation-navigation');fs.mkdirSync(output,{recursive:true});
const report={engine,mode,result:'failed',selection:[],jumps:[],errors:[]};
const only=['--selection','--corpus','--upgrade'].some(flag=>process.argv.includes(flag))?'selection':process.argv.includes('--scroll')?'scroll':null;
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
await context.tracing.start({screenshots:mode!=='matrix',snapshots:mode!=='matrix'});
page.on('pageerror',error=>report.errors.push(error.message));

async function input(query){await page.locator('#searchInput').fill(query);}
async function selected(query){
 await page.waitForFunction(query=>{
  const result=window.INASearchTest.parseCitation(query),state=window.INASearchTest.getState();
  return state.citation?.valid && state.citation.record?.item?.id===result.record?.item?.id
   && JSON.stringify(state.citation.path)===JSON.stringify(result.path)
   && document.querySelector('#detailPanel [aria-label="Citation target"], #detailPanel [data-statute-start], #detailPanel [data-cfr-start]');
 },query);
 await page.evaluate(()=>new Promise(requestAnimationFrame));
}
async function settled(){
 await page.evaluate(()=>new Promise(resolve=>{
  let last=window.scrollY,stable=0,start=performance.now();
  const frame=()=>{const now=window.scrollY;stable=Math.abs(now-last)<0.1?stable+1:0;last=now;
   if(stable>=12 || performance.now()-start>2500)resolve();else requestAnimationFrame(frame);};requestAnimationFrame(frame);
 }));
}
async function geometry(){return page.evaluate(()=>{
 const target=document.querySelector('#detailPanel [data-statute-inline-target], #detailPanel .statutory-node.target, #detailPanel .cfr-subtree.target, #detailPanel .cfr-unit-wrapper.target, #detailPanel .cfr-block.target');
 const anchor=target?.matches('.statutory-node')?target.querySelector('.statutory-line'):target || document.querySelector('#detailPanel [data-statute-start], #detailPanel [data-cfr-start]');
 const top=anchor?.getBoundingClientRect().top,line=window.INASearchTest.statuteJumpLine();
 const maximum=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
 const expected=Math.min(maximum,Math.max(0,window.scrollY+top-line));
 return {scrollY:window.scrollY,top,line,expected,error:Math.abs(expected-window.scrollY),path:window.INASearchTest.getState().citation?.path};
});}

try{
 await page.goto(pathToFileURL(path.resolve(process.env.INASEARCH_TEST_HTML || 'INASearch.html')).href);
 await page.waitForFunction(()=>!!window.INASearchTest&&!document.querySelector('.boot-workspace'));
 report.build=await page.evaluate(()=>JSON.parse(document.querySelector('#inaSearchBuildData').textContent).instanceId);
 await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(true));
 if(only!=='scroll'){
  await input('101a15hii');await selected('101a15hii');await settled();
  const coverage=await page.evaluate(()=>{
   const target=document.querySelector('#detailPanel [aria-label="Citation target"]');
   return {text:target?.textContent,children:[...document.querySelectorAll('[data-statute-inline-path]')]
    .filter(node=>['["a","15","H","ii","a"]','["a","15","H","ii","b"]'].includes(node.dataset.statuteInlinePath))
    .map(node=>({path:node.dataset.statuteInlinePath,covered:target.contains(node)}))};
  });
  report.selection.push(coverage);await page.screenshot({path:path.join(output,'h-ii-selection.png')});
  assert.equal(coverage.children.length,2,'Expected both H(ii) children');
  assert(coverage.children.every(child=>child.covered),'INA 101(a)(15)(H)(ii) highlights only its empty marker, excluding its children');
  assert.match(coverage.text,/perform agricultural labor/);assert.match(coverage.text,/other temporary service or labor/);assert.doesNotMatch(coverage.text,/as a trainee/);
  const copied=await page.evaluate(()=>window.INASearchTest.legalUnitCopyText(window.INASearchTest.legalUnitContextForLocation('usc','8-1101',['a','15','H','ii'],'INA 101(a)(15)(H)(ii)')));
  assert.match(copied,/perform agricultural labor/);assert.match(copied,/other temporary service or labor/);assert.doesNotMatch(copied,/as a trainee/);
  for(const [query,path] of [['101a15h',['a','15','H']],['INA 212(a)(9)(B)',['a','9','B']],['INA 337(a)(5)',['a','5']]]){
   await input(query);await selected(query);await settled();
   const scope=await page.evaluate(path=>{
    const target=document.querySelector('#detailPanel [aria-label="Citation target"]');
    const units=[...document.querySelectorAll('#detailPanel [data-statute-inline-path], #detailPanel .statutory-node[data-statute-path]')];
    return {path:JSON.parse(target.dataset.statuteInlinePath||target.dataset.statutePath),wrongScope:units.filter(unit=>{
     const other=JSON.parse(unit.dataset.statuteInlinePath||unit.dataset.statutePath);
     return target.contains(unit)!==(other.length>=path.length&&path.every((token,index)=>token===other[index]));
    }).map(unit=>unit.dataset.statuteInlinePath||unit.dataset.statutePath)};
   },path);
   assert.deepEqual(scope.path,path);assert.deepEqual(scope.wrongScope,[],`${query} highlights an incorrect subtree`);report.selection.push({query,...scope});
  }
 }
 if(process.argv.includes('--corpus')){
  const require=createRequire(import.meta.url);
  const {hydratePackedCorpus}=require('../src/INASearch-Corpus-Packing.js');
  const {indexStatuteRunIns}=require('./statute-run-ins.js');
  const html=fs.readFileSync('INASearch-Uncompressed.html','utf8');
  const corpus=hydratePackedCorpus(JSON.parse(html.match(/<script id="inaSearchCorpusData"[^>]*>([\s\S]*?)<\/script>/)[1]));
  indexStatuteRunIns(corpus);
  report.corpus={sections:0,units:0,parents:0,descendants:0};
  await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(false));
  for(const section of corpus.title8.sections.filter(section=>section.runInPaths?.length)){
   report.corpus.sections++;
   for(const path of section.runInPaths){
    const query=`8 U.S.C. ${section.section}${path.map(token=>`(${token})`).join('')}`;
    await input(query);await selected(query);
    const result=await page.evaluate(({path,sectionId})=>{
     const targets=[...document.querySelectorAll('#detailPanel [aria-label="Citation target"]')];
     const target=targets[0];
     const lines=[...document.querySelectorAll('#detailPanel [data-statute-inline-path]')];
     const prefix=other=>other.length>path.length&&path.every((token,index)=>token===other[index]);
     return {count:targets.length,targets:targets.map(node=>({path:node.dataset.statuteInlinePath||node.dataset.statutePath,text:node.textContent.slice(0,180)})),path:target?.dataset.statuteInlinePath && JSON.parse(target.dataset.statuteInlinePath),section:window.INASearchTest.getState().citation.record.item.id,
      descendants:lines.filter(line=>prefix(JSON.parse(line.dataset.statuteInlinePath))).length,
      wrongScope:lines.filter(line=>line!==target && target.contains(line)!==prefix(JSON.parse(line.dataset.statuteInlinePath))).map(line=>line.dataset.statuteInlinePath)};
    },{path,sectionId:section.id});
    assert.equal(result.count,1,`${query} must highlight exactly one unit: ${JSON.stringify(result.targets)}`);
    assert.deepEqual(result.path,path,`${query} highlights the wrong address`);
    assert.equal(result.section,section.id,`${query} opens the wrong section`);
    assert.deepEqual(result.wrongScope,[],`${query} includes a sibling or omits a descendant`);
    report.corpus.units++;if(result.descendants){report.corpus.parents++;report.corpus.descendants+=result.descendants;}
   }
   console.log(`Checked ${section.section}: ${section.runInPaths.length} run-in units`);
  }
  assert.equal(report.corpus.units,287);assert.equal(report.corpus.parents,4);
  console.log(JSON.stringify(report.corpus));
 }
 if(process.argv.includes('--upgrade')){
  await page.waitForFunction(()=>!window.INASearchTest.getState().profileChanged);
  await page.evaluate(async()=>{
   const corpus=structuredClone(window.INA_SEARCH_CORPUS);
   delete corpus.title8.runInRevision;
   const section=corpus.title8.sections.find(section=>section.section==='1160');
   section.runInPaths=[['a','2','I'],['a','2','II'],['a','3','B','ii','I'],['a','3','B','ii','II']];
   corpus.cfr.currentThrough['8']='2099-01-01';corpus.corpusVersion='2099.01.01';
   corpus.cfr.sections.find(section=>section.id==='8:214.1').heading='Preserved newer CFR heading';
   await window.INASearchStorage.activateCorpus(corpus,{reason:'isolated-regression-fixture'});
   const profile=structuredClone(window.INASearchTest.getProfile());
   const association={family:'usc',title:8,citationSystem:'ina',start:{unit:'1160',path:['a','2','I']},label:'INA 210(a)(2)(I)'};
   profile.notes=[{id:'legacy-note',text:'Preserved ambiguous note',associations:[association]}];
   profile.highlights=[{id:'legacy-highlight',color:'yellow',segments:[{id:'legacy-segment',association:structuredClone(association),citation:association.label,ordinal:1,aliases:[],anchor:{exact:'the date the alien was granted such temporary resident status',status:'active'}}]}];
   const cached=await window.INASearchStorage.loadActiveProfile();
   await window.INASearchStorage.saveProfile({format:'INASearchData',schemaVersion:1,vaultId:'regression-vault',revision:1,updatedAt:new Date().toISOString(),profile},{expectedRevision:cached?.record.cacheRevision||0});
   await window.INASearchStorage.setMetadata('annotation-index:regression-vault',{schemaVersion:1,profileId:profile.profileId,profileUpdatedAt:profile.updatedAt||null,snapshot:new window.INA_SEARCH_ANNOTATIONS.AnnotationIndex(profile).snapshot()});
  });
  await page.reload();await page.waitForFunction(()=>!!window.INASearchTest&&!document.querySelector('.boot-workspace'));
  await input('INA 210(a)(2)');await selected('INA 210(a)(2)');await settled();
  report.upgrade=await page.evaluate(()=>({source:window.INA_SEARCH_CORPUS_LOAD_SOURCE,revision:window.INA_SEARCH_CORPUS.title8.runInRevision,
   date:window.INA_SEARCH_CORPUS.cfr.currentThrough['8'],heading:window.INA_SEARCH_CORPUS.cfr.sections.find(section=>section.id==='8:214.1').heading,
   note:window.INASearchTest.getProfile().notes.find(note=>note.id==='legacy-note'),segment:window.INASearchTest.getProfile().highlights.find(highlight=>highlight.id==='legacy-highlight').segments[0],
   notices:document.querySelectorAll('.user-highlight-needs-review').length,visibleNote:document.querySelector('#detailPanel').textContent.includes('Preserved ambiguous note')}));
  assert.equal(report.upgrade.source,'upgraded-cache');assert.equal(report.upgrade.revision,2);assert.equal(report.upgrade.date,'2099-01-01');assert.equal(report.upgrade.heading,'Preserved newer CFR heading');
  assert.equal(report.upgrade.note.associations[0].structureStatus,'needs-review');assert.deepEqual(report.upgrade.note.associations[0].start.path,['a','2','I']);
  assert.equal(report.upgrade.segment.anchor.status,'needs-review');assert.equal(report.upgrade.notices,1);assert(report.upgrade.visibleNote);
  for(const letter of ['A','B'])for(const roman of ['I','II']){
   const query=`INA 210(a)(2)(${letter})(${roman})`;await input(query);await selected(query);await settled();
   assert.equal(await page.locator('#detailPanel [aria-label="Citation target"]').count(),1);
   assert.equal(await page.locator('#detailPanel [aria-label="Citation target"]').getAttribute('data-statute-inline-path'),JSON.stringify(['a','2',letter,roman]));
  }
  console.log('PASS warm cache upgrade, newer CFR preservation, and ambiguous saved annotation review');
 }
 if(only!=='selection'){
  if(process.argv.includes('--manual')){
   for(const action of ['citation-click','view-change','wheel']){
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(false));
    await input('101a1');await selected('101a1');await settled();
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(true));
    await input('101a43f');await selected('101a43f');await page.waitForTimeout(80);
    assert((await geometry()).error>100,'Manual action must interrupt an unfinished jump');
    if(action==='wheel')await page.mouse.wheel(0,200);
    const interruption=await page.evaluate(action=>{
     if(action==='citation-click'){
      const line=[...document.querySelectorAll('#detailPanel .statutory-line, #detailPanel .statutory-runin-line')].find(line=>{
       const box=line.getBoundingClientRect();return box.top>200&&box.top<900;
      });
      if(!line)throw new Error('Expected a visible citation line to select');
      line.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
     }else if(action==='view-change')document.querySelector('[data-view="definitions"]').click();
     return {action,top:window.scrollY,path:window.INASearchTest.getState().citation?.path};
    },action);
    await page.waitForTimeout(900);
    interruption.after=await page.evaluate(()=>window.scrollY);report.jumps.push(interruption);console.log(interruption);
    assert(Math.abs(interruption.after-interruption.top)<3,`${action} did not stop the previous citation jump`);
   }
  }else if(process.argv.includes('--queued')){
   await input('101a1');await selected('101a1');await settled();
   const interruption=await page.evaluate(()=>new Promise(resolve=>{
    // The old render has scheduled its jump, but its paint callback has not run.
    window.INASearchTest.applySearchQuery('101a43f',false,true);
    const input=document.querySelector('#searchInput');input.value='101a43';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
    const top=window.scrollY,samples=[];
    const sample=()=>{samples.push(window.scrollY);if(samples.length<4)requestAnimationFrame(sample);else resolve({top,samples});};requestAnimationFrame(sample);
   }));
   report.jumps.push(interruption);
   assert(interruption.samples.every(top=>Math.abs(top-interruption.top)<1),'A queued render callback restarts a canceled obsolete jump');
   await selected('101a43');await settled();assert((await geometry()).error<3);
   console.log('PASS cancellation before the previous render paint callback');
  }else if(process.argv.includes('--reverse')){
   for(const width of [1440,800,390]) for(const delay of [0,16,80,160]){
    await page.setViewportSize({width,height:1000});
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(false));
    await input('101a15h');await selected('101a15h');await settled();
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(true));
    await page.locator('#searchInput').press('Backspace');
    await selected('101a15');await page.waitForTimeout(delay);const during=await geometry();
    await page.locator('#searchInput').pressSequentially('m');await selected('101a15m');await settled();
    const after=await geometry();report.jumps.push({width,delay,reverse:'H → (15) → M',during,after});console.log(JSON.stringify(report.jumps.at(-1)));
    assert.deepEqual(after.path,['a','15','M']);assert(after.error<3,`Reversed parent jump stops ${after.error.toFixed(1)}px away from M`);
   }
  }else if(process.argv.includes('--cancel')){
   await input('INA 101(a)(1)');await selected('INA 101(a)(1)');await settled();
   await input('101a43f');await selected('101a43f');await page.waitForTimeout(80);
   const during=await geometry();assert(during.error>100,'The cancellation test must interrupt a moving scroll');
   await page.evaluate(()=>{
    document.querySelector('#searchInput').addEventListener('input',()=>{
     const start=performance.now(),top=window.scrollY,samples=[];
     // Editing must freeze the old jump throughout the deletion debounce.
     const sample=()=>{samples.push(window.scrollY);if(samples.length<4)requestAnimationFrame(sample);else window.__interruptedScroll={top,samples,elapsed:performance.now()-start};};
     requestAnimationFrame(sample);
    },{once:true});
   });
   await page.locator('#searchInput').press('Backspace');await page.waitForFunction(()=>!!window.__interruptedScroll);
   const interruption=await page.evaluate(()=>window.__interruptedScroll);report.jumps.push(interruption);console.log(interruption);
   assert(interruption.samples.every(top=>Math.abs(top-interruption.top)<1),'Editing a citation leaves the old scroll animation running while the new query is being parsed');
   await selected('101a43');await settled();assert((await geometry()).error<3);
  }else if(process.argv.includes('--burst')){
   for(const width of [1440,800,390]) for(const delay of [20,80,160]){
    await page.setViewportSize({width,height:1000});
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(false));
    await input('INA 101(a)(1)');await selected('INA 101(a)(1)');await settled();
    await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(true));
    await input('101a43f');await selected('101a43f');
    await page.locator('#searchInput').press('ControlOrMeta+A');
    await page.locator('#searchInput').pressSequentially('101a15hii',{delay});
    await selected('101a15hii');await settled();
    const after=await geometry();report.jumps.push({width,delay,burst:'101a43f → 101a15hii',after});console.log(JSON.stringify(report.jumps.at(-1)));
    assert.deepEqual(after.path,['a','15','H','ii']);
    assert(after.error<3,`Typing over an animated jump at ${delay}ms/key stopped ${after.error.toFixed(1)}px away from H(ii)`);
   }
  }else{
  const pairs=[['101a15hii','101a3','8-1101',['a','3']],['101a3','101a43f','8-1101',['a','43','F']],['101a43f','101a15hii','8-1101',['a','15','H','ii']],['212a9b','212a2ai','8-1182',['a','2','A','i']],['101a15hii','INA 245(a)','8-1255',['a']],['101a15hi','101a15hii','8-1101',['a','15','H','ii']],['INA 212(a)(9)(B)(i)','INA 101(a)(15)(H)(ii)(b)','8-1101',['a','15','H','ii','b']],['101a43f','INA 101(a)','8-1101',['a']],['INA 101(a)(15)(H)(ii)','INA 212(a)(9)(B)(ii)','8-1182',['a','9','B','ii']],['101a43f','8 CFR 214.2(h)(2)(i)(A)','8:214.2',['h','2','i','A']],['8 CFR 214.2(h)(2)(i)(A)','101a15m','8-1101',['a','15','M']]];
  for(const width of [1440,800,390]) for(const delay of [0,16,80,300]) for(const [first,next,sectionId,path] of pairs){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(false));
   await input('INA 101(a)(1)');await selected('INA 101(a)(1)');await settled();
   await page.evaluate(()=>window.INASearchTest.setAnimatedCitationJumps(true));
   await input(first);await selected(first);
   await page.waitForTimeout(delay);
   const during=await geometry();
   await input(next);await selected(next);await settled();
   const after=await geometry();report.jumps.push({width,first,next,delay,during,after});console.log(JSON.stringify(report.jumps.at(-1)));
   assert.deepEqual(after.path,path,`${next} resolved the wrong citation path`);
   assert.equal(await page.evaluate(()=>window.INASearchTest.getState().citation.record.item.id),sectionId,`${next} opened the wrong section`);
   assert(after.error<3,`Interrupted jump ${first} → ${next} stopped ${after.error.toFixed(1)}px away from its target`);
  }
  }
 }
 assert.deepEqual(report.errors,[]);
 report.result='pass';
 console.log('PASS citation selection and interrupted navigation');
}finally{
 fs.writeFileSync(path.join(output,`${engine}-${mode}-report.json`),JSON.stringify(report,null,2));
 await context.tracing.stop({path:path.join(output,`${engine}-${mode}-trace.zip`)});await browser.close();
}
