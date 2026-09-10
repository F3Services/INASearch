#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const runtime=process.env.INASEARCH_BROWSER_RUNTIME || path.join(os.homedir(),'.codex/tools/browser-inspection');
const {chromium}=createRequire(path.join(runtime,'package.json'))('playwright');
const browser=await chromium.launch({headless:true});
const baseline=process.argv.includes('--baseline') ? process.argv[process.argv.indexOf('--baseline')+1] : null;
const queries=[['214.2',''],['214.2h','(h)'],['214.2h2','(h)(2)'],['214.2h2i','(h)(2)(i)'],['214.2h2ia','(h)(2)(i)(A)']];
const report={result:'pass',measurement:'Input event to two animation frames after matching reader selection; includes debounce and layout, excludes completion of optional smooth scrolling.',before:[],after:[]};
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
report.artifacts={before:baseline ? digest(baseline) : null,after:digest('INASearch.html')};
async function ready(page,query,target,section='8 CFR 214.2') {
 await page.getByRole('searchbox').fill(query);
 await page.waitForFunction(({target,section})=>document.querySelector('.detail-heading-citation')?.textContent===section && (target ? document.querySelector('.cfr-subtree.target')?.getAttribute('data-cfr-path')===target : !document.querySelector('.cfr-subtree.target')),{target,section});
}
async function measure(file,rate,reuse) {
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 try {
  await page.goto(pathToFileURL(path.resolve(file)).href);
  await page.getByRole('searchbox').waitFor();
  await ready(page,'214.1','','8 CFR 214.1');
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate});
  const measurements=[];
  for(const [query,target] of queries) {
   await page.evaluate(({target})=>{
    window.__navigationPaint=null;
    document.querySelector('#searchInput').addEventListener('input',()=>{
     const start=performance.now();
     const frame=()=>{
      const ready=document.querySelector('.detail-heading-citation')?.textContent==='8 CFR 214.2' && (target ? document.querySelector('.cfr-subtree.target')?.getAttribute('data-cfr-path')===target : !document.querySelector('.cfr-subtree.target'));
      if(ready) requestAnimationFrame(()=>{window.__navigationPaint=performance.now()-start;});else requestAnimationFrame(frame);
     };
     requestAnimationFrame(frame);
    },{once:true});
   },{target});
   await ready(page,query,target);
   await page.waitForFunction(()=>window.__navigationPaint!==null);
   const ms=await page.evaluate(()=>Math.round(window.__navigationPaint));
   measurements.push({query,ms});
   if(!target) await page.evaluate(()=>{
    window.__sourceNodes=[...document.querySelectorAll('.cfr-body .cfr-unit-wrapper')];
    window.__sourceText=document.querySelector('.cfr-body').textContent;
   });
   else if(reuse) assert(await page.evaluate(()=>window.__sourceNodes.every(node=>node.isConnected) && window.__sourceText===document.querySelector('.cfr-body').textContent),'Typing rebuilt source paragraphs or changed the regulatory text');
  }
  if(reuse) {
   const within=measurements.slice(1).map(row=>row.ms).sort((a,b)=>a-b);
   assert(within[2]<250,`CFR navigation remains slow at ${rate}x CPU slowdown: ${JSON.stringify(measurements)}`);
   assert(within.at(-1)<450,'A single CFR navigation step blocks excessively');
  }
  return {cpuSlowdown:rate,measurements};
 } finally {await context.close();}
}
try {
 if(baseline) for(const rate of [1,4]) report.before.push(await measure(baseline,rate,false));
 for(const rate of [1,4]) report.after.push(await measure('INASearch.html',rate,true));
 console.log(JSON.stringify({before:report.before,after:report.after}));
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(path.resolve('INASearch.html')).href);
 await ready(page,'214.1','','8 CFR 214.1');
 const original=await page.locator('.cfr-body').textContent();
 for(const [query,target] of [['214.1b','(b)'],['214.1b1','(b)(1)'],['214.1b','(b)'],['214.1a3i','(a)(3)(i)'],['214.1a3','(a)(3)'],['214.1','']]){
  await ready(page,query,target,'8 CFR 214.1');assert.equal(await page.locator('.cfr-body').textContent(),original,'Compound-boundary updates must not duplicate or lose text');
  assert.equal(await page.locator('.cfr-subtree.target').count(),target?1:0);
 }
 await ready(page,'214.2h2i','(h)(2)(i)');
 // Real insertion UI: the card must survive changing the selected source scope.
 const reference=page.locator('.cfr-subtree.target [data-legal-reference][data-reference-insertion-key]').first();
 await reference.press('ArrowDown');await page.getByRole('button',{name:'Insert after citing provision',exact:true}).click();
 await page.locator('.inserted-reference-card').first().waitFor();
 const insertionText=await page.locator('.inserted-reference-card').first().textContent();
 await page.keyboard.press('Escape');
 await ready(page,'214.2h2ia','(h)(2)(i)(A)');
 assert.equal(await page.locator('.inserted-reference-card').first().textContent(),insertionText);
 await ready(page,'214.2h2','(h)(2)');
 assert.equal(await page.locator('.inserted-reference-card').first().textContent(),insertionText);
 // Re-selecting the same provision must keep its enclosing target.
 await page.locator('.cfr-subtree.target .cfr-unit-wrapper').first().dispatchEvent('click');
 assert.equal(await page.locator('.cfr-subtree.target').count(),1);
 // Saved note content must remain attached as the selected scope changes.
 await ready(page,'214.2h2ia','(h)(2)(i)(A)');
 await page.locator('.cfr-subtree.target [data-legal-unit-kind]').first().click();
 await page.getByRole('menuitem',{name:'Add note',exact:true}).click();
 await page.getByRole('textbox',{name:'Note text',exact:true}).fill('CFR navigation persistence check');
 await ready(page,'214.2h2','(h)(2)');
 await ready(page,'214.2h2i','(h)(2)(i)');
 assert((await page.locator('.citation-note').allTextContents()).some(text=>text.includes('CFR navigation persistence check')),'Saved note was lost while changing the selected scope');
 // A burst of actual keystrokes must leave the latest interpretation displayed.
 await ready(page,'214.2','','8 CFR 214.2');
 await page.getByRole('searchbox').pressSequentially('h2ia',{delay:20});
 await page.waitForFunction(()=>document.querySelector('.cfr-subtree.target')?.dataset.cfrPath==='(h)(2)(i)(A)');
 assert.equal(await page.getByRole('searchbox').inputValue(),'214.2h2ia');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert(await page.locator('.cfr-subtree.target').evaluate(node=>{const rect=node.getBoundingClientRect();return rect.top>=document.querySelector('#statuteNavigator').getBoundingClientRect().bottom-3 && rect.top<innerHeight*0.7;}),'Live typing should immediately bring the latest selected provision into view');
 for(const target of ['(h)(2)(i)','(h)(2)','(h)']) {
  await page.getByRole('searchbox').press('Backspace');
  await page.waitForFunction(target=>document.querySelector('.cfr-subtree.target')?.dataset.cfrPath===target,target);
 }
 await ready(page,'214.2h2ia','(h)(2)(i)(A)');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'tmp/cfr-navigation-performance.png'});
 await context.close();
 report.checks=['source DOM identity and complete text preserved during every suffix change','compound heading split/merge preserves all text','inserted excerpt and saved note survive selection changes','same-provision click retains enclosing target','rapid typing immediately shows the latest provision on screen','backspace updates the parent scope','1x and 4x CPU input-to-paint budgets'];
 fs.writeFileSync('sources/legal/cfr-hierarchy/navigation-performance.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
