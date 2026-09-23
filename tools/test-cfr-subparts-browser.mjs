#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const session = await startInspection({ outputDir: resolve('audits/cfr-subpart-parser/browser') });
const { page } = session;
const url = pathToFileURL(resolve('INASearch.html')).href;
await page.addInitScript(() => {
  window.qaCopies = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => qaCopies.push(text) } });
});
const search = page.locator('#searchInput');
const settle = () => page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame); });
async function ready() { await page.waitForFunction(() => window.INASearchTest && !document.querySelector('#searchWorkspace').classList.contains('boot-workspace')); await settle(); }
async function query(text) { await search.fill(text); await search.press('Enter'); await settle(); }
try {
  await page.goto(url); await ready();
  const titles = await page.locator('.home-cfr-index .hierarchy-description').allTextContents();
  const titleText = await page.locator('.home-cfr-index').innerText();
  for (const name of ['Domestic Security', "Employees' Benefits", 'Public Welfare']) assert(titleText.includes(name));
  const colors = await page.locator('#mainReaderActions button:disabled').evaluateAll(buttons => buttons.map(button => { const style=getComputedStyle(button); return [style.color,style.backgroundColor,style.borderColor]; }));
  assert(colors.length >= 5); assert(colors.every(color => JSON.stringify(color) === JSON.stringify(colors[0])), JSON.stringify(colors));
  for (const text of ['INA','8USC','usc','8 U.S.C.','8CFR']) { await query(text); assert.equal(await page.locator('.home-cfr-index').count(), 0, text); }
  for (const text of ['20cfr655.b','655.b','part655.b','20 CFR Part 655 Subpart B']) {
    await query(text);
    assert.equal(await page.locator('#authorityBrowseTitle').innerText(), '20 CFR 655.B', text);
    assert.equal(await page.evaluate(() => INASearchTest.getState().citation.valid), true);
    assert(!(await search.inputValue()).includes('(Part)'));
  }
  assert.equal(await page.evaluate(() => INASearchTest.parseCitation('20cfr655.zz').valid), false);
  assert.equal(await page.evaluate(() => INASearchTest.parseCitation('20cfr655.100').record.item.id), '20:655.100');
  await query('29cfr501.6');
  const link=page.locator('[data-show-cfr-citation="20 CFR 655.B"]');
  assert.equal(await link.count(),2);
  assert.equal(await page.locator('[data-reference-family="usc"][data-reference-section="20"]').count(),0);
  await link.first().click(); await settle();
  assert.equal(await page.locator('#authorityBrowseTitle').innerText(),'20 CFR 655.B');
  const row=page.locator('#resultList [data-hierarchy-open]').filter({hasText:'655.210'});
  if (await row.count()) await row.click();
  else await page.locator('[data-show-cfr-citation="20 CFR 655.210"]').click();
  await settle();
  await page.locator('#mainSearchHistoryBack').click(); await settle();
  assert.equal(await page.locator('#authorityBrowseTitle').innerText(),'20 CFR 655.B');
  const position=await page.locator('#resultList [data-hierarchy-open]').filter({hasText:'655.210'}).evaluate(element=>({top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,height:innerHeight}));
  assert(position.top>=0 && position.bottom<=position.height,JSON.stringify(position));
  assert(await page.locator('#mainReaderAuthorityToggle').isEnabled());
  await query('8cfr245.1');
  const before=await page.locator('.legal-reference-link').allTextContents();
  await page.locator('#mainReaderAuthorityToggle').click(); await settle();
  const after=await page.locator('.legal-reference-link').allTextContents();
  assert.notDeepEqual(before,after,'Follow view must change mapped citations within CFR content.');
  await page.locator('[data-live-citation-action="copy-citation-text"]').click();
  assert.match(await page.evaluate(()=>qaCopies.at(-1)),/states the following -\n\n/);
  await page.locator('#settingsMenuButton').click();
  await page.locator('#citationCopyPrefaceInput').fill('[citation]\nQuoted below -\n\n\n');
  await page.locator('#closeSavingMenuButton').click();
  await page.locator('[data-live-citation-action="copy-citation-text"]').click();
  assert.match(await page.evaluate(()=>qaCopies.at(-1)),/\nQuoted below -\n\n\n/);
  await page.evaluate(async () => {
    const corpus = structuredClone(window.INA_SEARCH_CORPUS);
    delete corpus.legalReferenceMetadata.cfrHierarchyVersion;
    delete corpus.cfr.titleNames;
    corpus.cfr.currentThrough['29']='2026-09-21';
    corpus.cfr.cacheSentinel='newer-regulations-preserved';
    await INASearchStorage.activateCorpus(corpus,{reason:'test-legacy-parser-cache'});
  });
  await page.reload(); await ready();
  assert.equal(await page.evaluate(()=>window.INA_SEARCH_CORPUS.cfr.cacheSentinel),'newer-regulations-preserved');
  await query('29cfr501.6');
  assert.equal(await page.locator('[data-show-cfr-citation="20 CFR 655.B"]').count(),2);
  await page.getByRole('button',{name:'INASearch home',exact:true}).click(); await settle();
  assert((await page.locator('.home-cfr-index').innerText()).includes("Employees' Benefits"));
  assert.equal(session.events.filter(e=>e.type==='pageerror').length,0,JSON.stringify(session.events));
  console.log('PASS CFR names, disabled colors, explicit indexes, compact subparts, reference targets, contents history, always-active switch, newline templates, and old-cache upgrade');
} finally { await session.close(); }
