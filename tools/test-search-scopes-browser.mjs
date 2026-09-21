#!/usr/bin/env node
// Uses Dave's isolated, installed Chromium inspection runtime; no everyday profile data.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve('INASearch.html')).href;
const session = await startInspection({ url, outputDir: resolve('audits/search-scopes-browser') });
const page = session.page;
async function search(q, target = page) {
  await target.locator('#searchInput').fill(q);
  await target.locator('#searchInput').press('Enter');
  await target.waitForSelector('.occurrence-search-summary');
  return (await target.locator('.occurrence-search-summary').innerText()).trim();
}
try {
  await page.waitForFunction(() => globalThis.INA_SEARCH_CORPUS && document.querySelector('#searchInput'));
  for (const q of ['in:237 cites:212', 'cites:212 in:237', 'in: INA 237   cites: INA 212']) assert.equal(await search(q), '23 hits in 1 section', q);
  await page.locator('#searchInput').fill('');
  await page.locator('#searchInput').pressSequentially('in:237 cites:212', { delay: 35 });
  await page.locator('#searchInput').press('Enter');
  await page.waitForSelector('.occurrence-search-summary');
  assert.equal((await page.locator('.occurrence-search-summary').innerText()).trim(), '23 hits in 1 section');
  await page.goto(`${url}?q=${encodeURIComponent('cites:212 in:237')}&qv=2`);
  await page.waitForSelector('.occurrence-search-summary');
  assert.equal((await page.locator('.occurrence-search-summary').innerText()).trim(), '23 hits in 1 section');
  const baseline = await search('president');
  for (const input of ['president','"good moral character"','alien citizen','common:section alien citizen']) {
    const started = performance.now();
    await search(input);
    await page.locator('.occurrence-row').first().waitFor();
    assert(performance.now()-started<350,`Production worker search exceeded 350 ms: ${input}`);
  }
  assert.deepEqual(await page.locator('.occurrence-authority-header strong').allTextContents(), ['INA', 'CFR', 'Notes']);
  await page.evaluate(async () => {
    const snap = await INASearchStorage.loadStartupSnapshot({});
    const profile = structuredClone(snap.profile?.vault?.profile || INA_SEARCH_PROFILE);
    const projection = INA_SEARCH_OCCURRENCE.buildProjection(INA_SEARCH_CORPUS);
    const fragment = projection.fragments.find(f => f.recordId === '8-1227' && f.path.join('/') === 'a/1/C/ii' && f.text.includes('certifies'));
    const association = { family: 'usc', title: 8, citationSystem: 'ina', start: { unit: '1227', path: ['a','1','C','ii'] } };
    const anchor = INA_SEARCH_ANNOTATIONS.quoteAnchor(fragment.text, fragment.text.indexOf('certifies'), fragment.text.indexOf('certifies') + 9);
    profile.notes = [
      { id:'qa-note', text:'President note cites INA 212.', associations:[association] },
      { id:'qa-note2', text:'President elsewhere.', associations:[{...association,start:{unit:'1182',path:[]}}] },
      { id:'qa-unassociated', text:'President unassociated.', associations:[] }
    ];
    profile.highlights = [{id:'qa-highlight',color:'pink',segments:[{id:'qa-segment',association,anchor}]}];
    profile.queryVersion = 2;
    const vault = snap.profile?.vault || {format:'INASearchData',schemaVersion:1,vaultId:'search-scopes-qa',revision:1};
    vault.profile = profile;
    await INASearchStorage.saveProfile(vault,{expectedRevision:snap.profile?.record?.cacheRevision || 0});
  });
  await page.goto(url);
  assert.equal(await search('president'), '137 hits in 67 sections');
  assert.equal(baseline, '134 hits in 64 sections');
  assert.deepEqual(await page.locator('.occurrence-authority-header strong').allTextContents(), ['INA','CFR','Notes']);
  for (const label of ['CFR','Notes']) {
    const header = page.locator('.occurrence-authority-header').filter({has:page.locator('strong',{hasText:new RegExp(`^${label}$`)})});
    await header.evaluate(e => window.scrollTo({top:e.getBoundingClientRect().top + window.scrollY - 50,behavior:'instant'}));
    assert.equal(await header.evaluate(e=>getComputedStyle(e).position),'sticky');
    const box = await header.boundingBox(); assert(box.y >= 0 && box.y < (label === "CFR" ? 100 : 1000), `${label} header must slide into view`);
  }
  assert.equal(await search('in:notes in:237 president'),'1 hit in 1 section');
  assert.equal(await search('in:notes cites:212'),'1 hit in 1 section');
  assert.equal(await search('in:notes'),'3 hits in 3 sections');
  assert.equal(await search('in:ina president'),'53 hits in 14 sections');
  assert.equal(await search('in:8 CFR president'),'37 hits in 21 sections');
  assert.equal(await search('in:8cfr president'),'37 hits in 21 sections');
  assert.equal(await search('in:237 in:highlights deportable'),'1 hit in 1 section');
  assert.equal(await search('in:237 in:highlights-exact deportable'),'0 hits in 0 sections');
  assert.equal(await search('in:237 in:highlights-exact certifies'),'1 hit in 1 section');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme, theme);
    const mark = page.locator('.search-saved-match');
    const style = await mark.evaluate(e=>({opacity:getComputedStyle(e).opacity,background:getComputedStyle(e).backgroundColor,outline:getComputedStyle(e).outlineWidth}));
    assert.equal(style.opacity,'1'); assert.match(style.background,/\/ 0\.6\)/); assert.equal(style.outline,'2px');
    await page.screenshot({path:resolve(`audits/search-scopes-browser/highlight-${theme}.png`)});
  }
  // Virtualized broad results must still decorate the selected source occurrence.
  await search('in:237 a');
  assert(await page.locator('[data-windowed="true"]').count() > 0);
  const highlightedRow = await page.evaluate(async()=>{
    const projection = INA_SEARCH_OCCURRENCE.buildProjection(INA_SEARCH_CORPUS);
    const ast = INA_SEARCH_COMMAND.parseCommand('in:237 a');
    const personal = (await INASearchStorage.loadStartupSnapshot({})).profile.vault.profile;
    const result = INA_SEARCH_QUERY.search(projection,ast,{personal,plan:{branches:[{kind:'law',scopes:[{valid:true,family:'usc',sectionIds:new Set(['8-1227']),pathsBySection:new Map()}]}],citationScopes:[]}});
    return result.materializeOccurrences({limit:10000}).rows.findIndex(row=>row.snippet.parts.some(part=>part.highlightColor));
  });
  assert(highlightedRow >= 0);
  await page.locator('.occurrence-section-rows').evaluate((e,index)=>window.scrollTo({top:e.getBoundingClientRect().top+window.scrollY+index*125-200,behavior:'instant'}),highlightedRow);
  await page.locator('.search-saved-highlight').first().waitFor();
  assert.equal(await page.locator('.search-saved-highlight').first().evaluate(e=>getComputedStyle(e).opacity),'1');
  assert.equal(await search('in:annotations in:8cfr effective'),'7 hits in 2 sections');
  assert.deepEqual(await page.locator('.occurrence-authority-header strong').allTextContents(),['Annotations']);
  await page.locator('.occurrence-row-text').first().click();
  await page.locator('[data-cfr-search-match]').first().waitFor();
  assert(await page.locator('[data-cfr-search-match]').first().isVisible());
  assert.equal(await search('in:annotations in:237 "No cl."'),'1 hit in 1 section');
  await page.locator('.occurrence-row-text').first().click();
  assert(await page.locator('[data-statute-search-match]').first().isVisible());
  await search('in:237 cites:212');
  await page.locator('#searchInput').fill('in:notes');
  await page.locator('#searchInput').fill('in:highlights-exact certifies');
  await page.locator('#searchInput').fill('cites:212 in:237');
  await page.locator('#searchInput').press('Enter');
  await page.waitForSelector('.occurrence-search-summary');
  await page.waitForTimeout(1000);
  assert.equal((await page.locator('.occurrence-search-summary').innerText()).trim(),'23 hits in 1 section');
  // Composed panes use the same query and allow comma alternatives within a scope.
  await page.locator('#searchInput').fill('in:237 cites:212, in:notes');
  await page.locator('#searchInput').press('Enter');
  await page.waitForSelector('.focused-citation-pane .occurrence-search-summary');
  const pane = page.locator('.focused-citation-pane').first();
  assert.equal((await pane.locator('.occurrence-search-summary').innerText()).trim(),'23 hits in 1 section');
  await pane.locator('input[type=search]').fill('cites:212 in:237');
  await pane.locator('input[type=search]').press('Enter');
  await pane.locator('.occurrence-search-summary').waitFor();
  assert.equal((await pane.locator('.occurrence-search-summary').innerText()).trim(),'23 hits in 1 section');
  await pane.locator('.focused-pane-common summary').click();
  await pane.locator('[data-common-authority="statute"][data-common-level="section"]').click();
  await pane.locator('.occurrence-search-summary').waitFor();
  assert.match(await pane.locator('input[type=search]').inputValue(),/common:section/);
  const fallback = await session.context.newPage();
  await fallback.addInitScript(()=>{globalThis.Worker=undefined;});
  await fallback.goto(url);
  assert.equal(await search('in:237 cites:212', fallback),'23 hits in 1 section');
  assert.equal(await search('in:highlights-exact certifies', fallback),'1 hit in 1 section');
  const fallbackStarted = performance.now();
  assert.equal(await search('president', fallback),'137 hits in 67 sections');
  await fallback.locator('.occurrence-row').first().waitFor();
  assert(performance.now()-fallbackStarted<350,'Production fallback search exceeded 350 ms');
  await fallback.close();
  await page.goto(`${url}?q=${encodeURIComponent('in:highlights certifies')}`);
  await page.waitForSelector('.occurrence-search-summary');
  assert.equal(await page.locator('#searchInput').inputValue(),'in:highlights-exact certifies');
  await page.goto(`${url}?q=${encodeURIComponent('in:highlights deportable')}&qv=2`);
  await page.waitForSelector('.occurrence-search-summary');
  assert.equal((await page.locator('.occurrence-search-summary').innerText()).trim(),'1 hit in 1 section');
  assert.deepEqual(session.events.filter(event=>event.type==='pageerror'),[]);
  console.log('PASS browser scopes: typing, paste, links, panes, notes, sticky groups, highlights, themes, virtualization, rapid edits, worker/fallback, migration');
} finally { await session.close(); }
