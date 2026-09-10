#!/usr/bin/env node
// Browser-native XML replay and atomic update checks; no parser dependency ships.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const runtime=process.env.INASEARCH_BROWSER_RUNTIME || path.join(os.homedir(),'.codex/tools/browser-inspection');
const {chromium}=createRequire(path.join(runtime,'package.json'))('playwright');
const H=require('../src/INASearch-CFR-Hierarchy.js');
const fixtures=JSON.parse(fs.readFileSync('sources/legal/cfr-hierarchy/download-fixtures.json','utf8')).fixtures;
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>CFR replay test</title>'}));
 await page.goto('http://localhost:9876/');
 for(const file of ['src/INASearch-CFR-Hierarchy.js','tools/embedded-references.js','tools/legal-references.js','src/INASearch-Updater.js'])await page.addScriptTag({content:fs.readFileSync(file,'utf8')});
 let records=0;
 for(const fixture of fixtures){
  const expected=fixture.normalized.map(record=>H.reconcile(structuredClone(record)));
  let actual;
  try { actual=await page.evaluate(f=>INASearchUpdater.normalizeEcfrXml(f.xml,f).sections,fixture); }
  catch(error) {
    const raw=await page.evaluate(f=>{const saved=INASearchCfrHierarchy.reconcile;INASearchCfrHierarchy.reconcile=r=>r;try{return INASearchUpdater.normalizeEcfrXml(f.xml,f).sections;}finally{INASearchCfrHierarchy.reconcile=saved;}},fixture);
    fs.writeFileSync('tmp/cfr-download-mismatch.json',JSON.stringify({expected:fixture.normalized,actual:raw},null,2));throw error;
  }
  assert.deepEqual(actual,expected,`generator/updater parity: ${fixture.title}:${fixture.part}`);records+=actual.length;
 }
 const fixture=fixtures.find(item=>item.title===8 && item.part==='274a');
 const guard=await page.evaluate(f=>{
  const changed={...f,xml:f.xml.replace('U.S. military card or draft record','Changed military card or draft record'),rendererHtml:f.rendererHtml.replace('U.S. military card or draft record','Changed military card or draft record')};
  try{INASearchUpdater.normalizeEcfrXml(changed.xml,changed);return 'accepted';}catch(error){return error.message;}
 },fixture);
 assert.match(guard,/unreviewed|unclassified|contradicts/,'An unmatched guard accepted changed defective source text');
 const outcome=await page.evaluate(async f=>{
  const normalized=INASearchUpdater.normalizeEcfrXml(f.xml,f);
  const original={schemaVersion:5,corpusVersion:'2026.08.03',title8:{sections:[]},inaHierarchy:{sections:[]},cfr:{schemaVersion:1,structureRevision:INASearchCfrHierarchy.revision,...normalized,currentThrough:{'8':'2026-08-03'},removedParts:[],sources:[],structureSources:[]}};
  let active=structuredClone(original),activations=0,changed=true;
  const storage={loadActiveCorpus:async()=>({corpus:active}),compareVersions:(a,b)=>String(a).localeCompare(String(b)),getMetadata:async()=>null,setMetadata:async()=>{},ensureActiveCorpus:async()=>{},storeSourceArtifact:async()=>{},sha256Bytes:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join(''),activateCorpus:async corpus=>{active=corpus;activations++;}};
  globalThis.INASearchStorage=storage;
  globalThis.fetch=async input=>{
   const url=new URL(input);let data;
   if(url.pathname.endsWith('/titles.json'))data=JSON.stringify({titles:[{number:8,up_to_date_as_of:'2026-08-04',latest_amended_on:'2026-08-04'}]});
   else if(url.pathname.includes('/versions/'))data=JSON.stringify({content_versions:[{title:8,part:'274a',date:'2026-08-04'}]});
   else if(url.pathname.includes('/corrections.json'))data=JSON.stringify({ecfr_corrections:[]});
   else if(url.pathname.includes('/full/'))data=changed?f.xml.replace('U.S. military card or draft record','Changed military card or draft record'):f.xml;
   else if(url.pathname.includes('/enhanced/'))data=changed?f.rendererHtml.replace('U.S. military card or draft record','Changed military card or draft record'):f.rendererHtml;
   else throw Error('Unexpected request '+input);
   return new Response(data,{status:200});
  };
  const before=JSON.stringify(active), failure=await INASearchUpdater.checkAndUpdate(original,{force:true});
  const retained=JSON.stringify(active)===before && activations===0;
  changed=false;
  const success=await INASearchUpdater.checkAndUpdate(original,{force:true});
  const obsolete=structuredClone(active);delete obsolete.cfr.structureRevision;obsolete.cfr.currentThrough['8']='2099-01-01';obsolete.corpusVersion='2099.01.01';active=obsolete;activations=0;
  const replacement=await INASearchUpdater.checkAndUpdate(original,{force:true});
  return {failure,retained,success,replacement,date:active.cfr.currentThrough['8'],revision:active.cfr.structureRevision,activations};
 },fixture);
 assert.equal(outcome.failure.state,'error');assert(outcome.retained,'Failed update changed the active corpus or currency');
 assert.equal(outcome.success.state,'updated',outcome.success.message);
 assert.equal(outcome.replacement.state,'updated',outcome.replacement.message);
 assert.equal(outcome.date,'2026-08-04');assert.equal(outcome.revision,H.revision);assert.equal(outcome.activations,1);
 fs.writeFileSync('sources/legal/cfr-hierarchy/download-verification.json',JSON.stringify({parts:fixtures.length,records,guardFailure:guard,atomicFailure:outcome.failure.message,retained:true,successfulReplay:true,obsoleteCacheRejected:true},null,2)+'\n');
 console.log(`CFR download replay passed: ${fixtures.length} parts, ${records} sections; guarded rejection, atomic rollback, successful update and obsolete cache rejection.`);
} finally {await browser.close();}
