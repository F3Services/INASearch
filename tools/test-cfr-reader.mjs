#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const runtime=process.env.INASEARCH_BROWSER_RUNTIME || path.join(os.homedir(),'.codex/tools/browser-inspection');
const {chromium}=createRequire(path.join(runtime,'package.json'))('playwright');
const browser=await chromium.launch({headless:true});
const results=[];
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(path.resolve('INASearch.html')).href);
 const input=page.getByRole('searchbox');await input.waitFor();
 async function select(query,target,section='8 CFR 214.2'){
  await input.fill(query);
  await page.waitForFunction(({target,section})=>document.querySelector('.detail-heading-citation')?.textContent===section && (target ? document.querySelector('.cfr-subtree.target')?.getAttribute('data-cfr-path')===target : !document.querySelector('.cfr-subtree.target')),{target,section});
  const info=await page.evaluate(()=>{
   const selected=document.querySelector('.cfr-subtree.target');
   return {value:document.querySelector('#searchInput').value,heading:document.querySelector('.detail-heading-citation').textContent,outlines:document.querySelectorAll('.cfr-block.target').length,blocks:selected?.querySelectorAll('.cfr-block').length||0,paths:[...selected?.querySelectorAll('.cfr-unit-wrapper[data-cfr-path]')||[]].map(e=>e.getAttribute('data-cfr-path')),tables:selected?.querySelectorAll('table').length||0,next:selected?.nextElementSibling?.getAttribute('data-cfr-path'),ambiguity:!document.querySelector('#citationAmbiguity').hidden};
  });
  assert.equal(info.outlines,target?1:0);results.push({query,target,...info,paths:undefined});return info;
 }
 for(const [query,target,count,next] of [['214.2h','(h)',697,'(i)'],['214.2h2','(h)(2)',42,'(h)(3)'],['214.2h2i','(h)(2)(i)',37,'(h)(2)(ii)'],['214.2h2ia','(h)(2)(i)(A)',1,'(h)(2)(i)(B)']]){
  const result=await select(query,target);assert.equal(result.blocks,count);assert.equal(result.next,next);
  assert(result.paths.every(path=>path===target || path.startsWith(target+'(')));
 }
 await select('214.2h2i','(h)(2)(i)');await page.waitForFunction(()=>{const top=document.querySelector('.cfr-subtree.target').getBoundingClientRect().top;return top>=document.querySelector('#statuteNavigator').getBoundingClientRect().bottom-3 && top<innerHeight*0.7;});await page.screenshot({path:'tmp/cfr-subtree-reader.png'});
 assert((await select('214.2h2ii','(h)(2)(ii)')).ambiguity);
 const alternative=page.locator('[data-citation-interpretation="214.2h2iI"]');await alternative.click();
 await page.waitForFunction(()=>document.querySelector('.cfr-subtree.target')?.getAttribute('data-cfr-path')==='(h)(2)(i)(I)');assert.equal(await input.inputValue(),'214.2h2iI');
 assert(!(await select('214.2h2iI','(h)(2)(i)(I)')).ambiguity);
 await select('19 CFR 4.7','','19 CFR 4.7');assert.equal(await page.locator('[aria-label="Other separately numbered sections"] a').count(),4);
 await select('19 CFR 4.7a','','19 CFR 4.7a');await select('19 CFR 4.7(a)','(a)','19 CFR 4.7');
 await select('20 CFR 655.510d1iiC2iiiA','(d)(1)(ii)(C)(2)(iii)(A)','20 CFR 655.510');
 const table=await select('214.1a2','(a)(2)','8 CFR 214.1');assert.equal(table.tables,1);
 const corrected=await select('214.1b1','(b)(1)','8 CFR 214.1');assert(corrected.paths.includes('(b)(1)(iv)(B)'));assert.equal(corrected.next,'(b)(2)');
 const docs=await select('274a.2b1vB1','(b)(1)(v)(B)(1)','8 CFR 274a.2');assert.equal(docs.paths.filter(path=>path==='(b)(1)(v)(B)(1)(vi)').length,2);assert.equal(docs.next,'(b)(1)(v)(B)(2)');
 await page.locator('.cfr-unit-wrapper[data-cfr-block-path="24"]').dispatchEvent('click');
 assert.equal(await page.locator('.cfr-subtree.target .cfr-block').count(),10);
 await page.locator('.cfr-unit-wrapper[data-cfr-block-path="30"] [data-legal-unit-kind="cfr"]').click();
 assert.match(await page.locator('#legalUnitMenuTextPreview').textContent(),/Military dependent/);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Open settings',exact:true}).click();await page.getByRole('dialog').waitFor();
 assert.deepEqual(errors,[]);
 fs.writeFileSync('sources/legal/cfr-hierarchy/browser-verification.json',JSON.stringify({result:'pass',checks:results,errors},null,2)+'\n');
 console.log(`CFR reader passed: ${results.length} selections, subtree boundaries, ambiguity switching, lettered sections, seven levels, table, repaired ancestry and Settings.`);
}finally{await browser.close();}
