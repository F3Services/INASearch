#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
const {startInspection}=await import(pathToFileURL(resolve(homedir(),'.codex/tools/browser-inspection/session.mjs')));
const target=process.argv[2]||'INASearch.html';
const url=/^https?:\/\//.test(target)?target:pathToFileURL(resolve(target)).href;
const firefoxRun=process.env.INAS_TEST_BROWSER==='firefox';
const outputDir=resolve(`audits/copy-button-expansion/${firefoxRun?'firefox':'browser'}`);
async function startFirefoxInspection(){
  const {firefox}=await import(pathToFileURL(resolve(homedir(),'.codex/tools/browser-inspection/node_modules/playwright/index.mjs')));
  await mkdir(outputDir,{recursive:true});
  const browser=await firefox.launch();const context=await browser.newContext();const page=await context.newPage();
  const events=[];page.on('pageerror',error=>events.push({type:'pageerror',text:error.message}));
  await context.tracing.start({screenshots:true,snapshots:true});
  return {page,events,close:async()=>{try{await context.tracing.stop({path:resolve(outputDir,'trace.zip')});}finally{await browser.close();}}};
}
const session=await (firefoxRun?startFirefoxInspection():startInspection({url,outputDir}));const page=session.page;
await page.addInitScript(()=>{window.qaCopies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>qaCopies.push(text)}});});
const settle=()=>page.evaluate(async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame);});
const main=page.locator('#mainReaderActions');
const copy=(rail,type)=>rail.locator(`[data-live-citation-action="${type}"]`);
const copied=()=>page.evaluate(()=>qaCopies.at(-1));
async function assertUnclipped(button) {
  const size = await button.locator('.copy-action-label').evaluate(el => ({ width:el.clientWidth, contentWidth:el.scrollWidth, height:el.clientHeight, contentHeight:el.scrollHeight, overflow:getComputedStyle(el).textOverflow, lineHeight:parseFloat(getComputedStyle(el).lineHeight) }));
  assert.notEqual(size.overflow,'ellipsis','Copy labels must never substitute dots');
  assert(size.contentWidth<=size.width+1 && size.contentHeight<=size.height+1,`Copy label is clipped: ${JSON.stringify(size)}`);
  assert(size.height<=size.lineHeight+1,`Copy label must stay on one line: ${JSON.stringify(size)}`);
  const bounds = await button.evaluate(el => ({ button: el.getBoundingClientRect().toJSON(), label: el.querySelector('.copy-action-label').getBoundingClientRect().toJSON() }));
  assert(bounds.label.right <= bounds.button.right - 0.5,`Copy button background must enclose its label: ${JSON.stringify(bounds)}`);
}
async function checkRail(rail){
  await page.mouse.move(900,40); await page.evaluate(()=>document.activeElement?.blur());
  const citation=copy(rail,'copy-citation'), text=copy(rail,'copy-text'),combined=copy(rail,'copy-citation-text');
  const before=await citation.boundingBox();
  await citation.hover();
  assert((await citation.boundingBox()).width>before.width+20);
  assert.equal(await citation.getAttribute('title'),null);
  await assertUnclipped(citation);await citation.click();assert.equal(await citation.locator('.copy-action-label').innerText(),await copied());
  await text.hover();assert.equal(await text.locator('.copy-action-label').innerText(),'Highlighted text');assert.equal(await text.getAttribute('title'),null);await assertUnclipped(text);
  await combined.hover();const label=await combined.locator('.copy-action-label').innerText();await assertUnclipped(combined);
  assert(!label.toLowerCase().includes('[citation]'));
  assert.equal(await combined.getAttribute('title'),null);
  await combined.click();assert.equal(label,(await copied()).split('\n')[0]);
  assert(Math.abs((await combined.boundingBox()).height-53)<0.1,'Expanding the label must not increase button height');
  await page.mouse.move(900,40);await citation.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert(await citation.locator('.copy-action-label').isVisible(),'Keyboard focus must expand the citation');
}
try{
 await page.setViewportSize({width:1280,height:918});
 await page.goto(`${url}?q=8cfr1245.1(a)`);await page.waitForFunction(()=>window.INASearchTest?.getState().selected);
 await page.evaluate(()=>{INASearchTest.setAnimatedCitationJumps(false);INASearchTest.getProfile().preferences.backupReminder='disabled';});
 await settle();await checkRail(main);
 await copy(main,'copy-citation-text').hover();await page.screenshot({path:resolve(outputDir,'main-expanded.png')});
 console.log('PASS immediate expansion, exact clipboard labels, keyboard focus and no native tooltips');
 await page.locator('#settingsMenuButton').click();const input=page.locator('#citationCopyPrefaceInput');
 assert.equal(await input.evaluate(e=>e.tagName),'TEXTAREA');
 const defaults='[Citation] states the following -\n\n';assert.equal(await input.inputValue(),defaults);
 const custom='Under [cItAtIoN]:\n  This is the second line.\n\n';await input.fill(custom);
 await page.locator('#closeSavingMenuButton').click();await copy(main,'copy-text').click();const text=await copied();
 await copy(main,'copy-citation').click();const citation=await copied();
 await copy(main,'copy-citation-text').hover();assert.equal(await copy(main,'copy-citation-text').locator('.copy-action-label').innerText(),`Under ${citation}:`);
 await copy(main,'copy-citation-text').click();assert.equal(await copied(),custom.replace(/\[citation\]/gi,citation)+text);
 // Firefox also exercises the rendered hover/copy surfaces. Profile persistence
 // is covered by the Chromium run; Firefox's isolated context aborts IndexedDB saves.
 if(!firefoxRun){await page.waitForFunction(()=>!INASearchTest.getState().profileChanged);await page.reload();await page.waitForFunction(()=>window.INASearchTest?.getState().selected);}
 await page.locator('#settingsMenuButton').click();assert.equal(await input.inputValue(),custom);
 await input.fill('[citation][/n]\n');await page.locator('#closeSavingMenuButton').click();await copy(main,'copy-citation-text').click();assert.match(await copied(),/\[\/n\]\n/);
 await page.locator('#settingsMenuButton').click();await page.locator('#resetCitationCopyPrefaceButton').click();assert.equal(await input.inputValue(),defaults);
 assert.equal(await page.locator('#citationCopyPrefaceWarning').isVisible(),false);await page.screenshot({path:resolve(outputDir,'multiline-settings.png')});
 await page.locator('#closeSavingMenuButton').click();await checkRail(main);
 console.log(`PASS literal multiline whitespace, citation substitution, ${firefoxRun?'':'persistence, '}old tokens treated literally, and Reset`);
 await page.locator('#settingsMenuButton').click();
 await input.fill('[citation] — '+ 'Additional context for the complete copied provision. '.repeat(4)+'\n\n');
 await page.locator('#closeSavingMenuButton').click();await copy(main,'copy-citation-text').hover();await assertUnclipped(copy(main,'copy-citation-text'));
 assert((await copy(main,'copy-citation-text').boundingBox()).width>560,'Use available space beyond the old 560px cap');
 await page.screenshot({path:resolve(outputDir,'long-label-expanded.png')});
 await page.setViewportSize({width:390,height:918});await settle();await checkRail(main);
 await copy(main,'copy-citation-text').hover();await assertUnclipped(copy(main,'copy-citation-text'));
 assert(Math.abs((await copy(main,'copy-citation-text').boundingBox()).height-53)<0.1,'Long labels must stay on one line at narrow widths');
 await page.screenshot({path:resolve(outputDir,'long-label-narrow.png')});
 await page.setViewportSize({width:1280,height:918});await page.locator('#settingsMenuButton').click();await page.locator('#resetCitationCopyPrefaceButton').click();await page.locator('#closeSavingMenuButton').click();
 console.log('PASS content-sized single-line labels beyond 560px, including narrow layouts');

 await page.evaluate(()=>INASearchTest.applySearchQuery('8 CFR 1245.1(a), INA 237(a)(3)',false,true));await settle();
 const panes=page.locator('.focused-citation-pane');await panes.nth(1).waitFor();
 for(let index=0;index<2;index++){
   const rail=panes.nth(index).locator('.pane-reader-actions');await checkRail(rail);
   await copy(rail,'copy-citation-text').hover();
   await assertUnclipped(copy(rail,'copy-citation-text'));
 }
 await page.screenshot({path:resolve(outputDir,'split-expanded.png')});
 // The transparent rail must not swallow clicks in the reader beside the icons.
 const usable=await panes.first().locator('.cfr-block').first().evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.right-20,Math.max(r.top,110)+12);return !hit.closest('.pane-reader-actions');});assert(usable);
 await panes.first().locator('.main-reader-authority').click();await checkRail(panes.nth(1).locator('.pane-reader-actions'));
 console.log('PASS split-pane expansion and targets, synchronized citation labels and unobstructed reader interaction');
 await page.setViewportSize({width:390,height:918});await page.evaluate(()=>INASearchTest.applySearchQuery('8 CFR 1245.1(a)',false,true));await settle();await checkRail(main);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(outputDir,'narrow-expanded.png')});
 assert.deepEqual(session.events.filter(e=>e.type==='pageerror'),[]);
 console.log('PASS narrow layout and browser runtime checks');
}finally{await session.close();}
