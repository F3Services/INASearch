#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const session = await startInspection({ outputDir: resolve('audits/homepage-browser') });
const { page } = session;
const mainRail = page.locator('#mainReaderActions');
const swap = mainRail.locator('.main-reader-authority');
const header = page.locator('#authorityBrowseTitle');
const cfr = page.locator('.home-cfr-index');
const search = page.getByRole('searchbox', { name: 'Search INA, CFR, and notes', exact: true });
async function ready() {
  await page.waitForFunction(() => window.INASearchTest && !document.querySelector('#searchWorkspace').classList.contains('boot-workspace'));
  await settle();
}
async function settle() { await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }); }
async function query(value) {
  await search.fill(value);
  await search.press('Enter');
  await settle();
}
async function home() { await page.getByRole('button', { name: 'INASearch home', exact: true }).click(); await settle(); }
async function checkRail(rail, enabled) {
  assert(await rail.isVisible());
  assert.equal(await rail.locator('button:visible').count(), 7);
  assert.equal(await rail.locator('button:enabled').count(), enabled);
}
async function authority() { return page.evaluate(() => INASearchTest.getState().statuteHierarchyAuthority); }

try {
  await page.goto(url);
  await ready();
  assert.equal(await header.innerText(), 'INA');
  assert(await cfr.isVisible());
  await checkRail(mainRail, 2);
  assert.equal(await page.locator('.focused-citation-pane').count(), 0);
  assert.equal(await page.locator('#emptySearchViewSelect, #closeBlankCompanionOnSectionOpenToggle').count(), 0);
  assert.equal(await search.inputValue(), '');
  await page.screenshot({ path: resolve(session.artifacts, 'home-ina.png'), fullPage: true });
  console.log('PASS fresh stacked homepage and persistent disabled controls');

  await cfr.getByRole('button', { name: 'Expand Title 8', exact: true }).focus();
  await cfr.getByRole('button', { name: 'Expand Title 8', exact: true }).press('Enter');
  assert(await cfr.getByRole('button', { name: 'Collapse Title 8', exact: true }).evaluate(element => element === document.activeElement), 'Keyboard expansion must retain focus.');
  await page.locator('#resultList > .hierarchy-list').getByRole('button', { name: 'Expand Title II', exact: true }).click();
  await swap.click();
  await settle();
  assert.equal(await header.innerText(), '8 U.S.C.');
  assert.equal(await page.locator('#resultList > .hierarchy-list > .hierarchy-row').count(), 16);
  assert.equal(await cfr.getByRole('button', { name: 'Collapse Title 8', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-hierarchy-row="usc:title:8:chapter:1"] .hierarchy-status').innerText(), 'REPEALED OR OMITTED');
  assert.equal(await page.locator('[data-hierarchy-row="usc:title:8:chapter:9"] .hierarchy-status').innerText(), 'REPEALED OR TRANSFERRED');
  assert.equal(await page.locator('[data-hierarchy-row="usc:title:8:chapter:12"] .hierarchy-status').innerText(), 'Contains INA');
  await page.locator('[data-hierarchy-expand-all="usc:title:8"]').click();
  assert.equal(await page.locator('[data-hierarchy-row="usc:section:8-1101"] .ina-membership').count(), 2);
  assert.equal(await page.locator('[data-hierarchy-row="usc:section:8-1252c"] .ina-membership').count(), 0);
  assert(await page.locator('[data-hierarchy-row="usc:section:8-1252b"] .hierarchy-status.repealed').isVisible());
  await page.locator('[data-hierarchy-collapse-all="usc:title:8"]').click();
  assert.equal(await cfr.getByRole('button', { name: 'Collapse Title 8', exact: true }).getAttribute('aria-expanded'), 'true');
  await cfr.getByRole('button', { name: 'Collapse All', exact: true }).click();
  assert(await cfr.getByRole('button', { name: 'Collapse All', exact: true }).evaluate(element => element === document.activeElement));
  assert.equal(await cfr.locator('[data-hierarchy-expand][aria-expanded="true"]').count(), 0);
  await swap.click();
  assert.equal(await page.locator('[data-hierarchy-expand="ina:title:II"]').getAttribute('aria-expanded'), 'true');
  await swap.click();
  await settle();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(session.artifacts, 'home-title8.png'), fullPage: true });
  console.log('PASS shared homepage swap, independent expansion, all Title 8 chapters, INA and disposition badges');

  // Returning to Home after a reader or a cleared search uses the shared state.
  await query('8 USC 1101(a)');
  assert.equal(await authority(), 'usc');
  await checkRail(mainRail, 7);
  await swap.click();
  assert.equal(await authority(), 'ina');
  await home();
  assert.equal(await header.innerText(), 'INA');
  await swap.click();
  await query('8 USC 1101(a)');
  await search.fill('');
  await settle();
  assert.equal(await header.innerText(), '8 U.S.C.');
  await query('INA');
  assert.equal(await header.innerText(), 'INA');
  assert.equal(await cfr.count(), 0);
  await page.locator('[data-hierarchy-expand="ina:title:II"]').click();
  await swap.click();
  await page.getByRole('button', { name: 'Back to INA', exact: true }).click();
  await settle();
  assert.equal(await header.innerText(), 'INA');
  assert.equal(await cfr.count(), 0);
  assert.equal(await authority(), 'ina');
  assert.equal(await page.locator('[data-hierarchy-expand="ina:title:II"]').getAttribute('aria-expanded'), 'true');
  await swap.click();
  const link = await page.evaluate(() => INASearchTest.currentViewShareLink().href);
  assert.equal(new URL(link).searchParams.get('q'), '8 U.S.C.');
  await page.waitForFunction(() => !INASearchTest.getState().profileChanged && !INASearchTest.getState().browserSaveInProgress);
  await page.reload();
  await ready();
  assert.equal(await header.innerText(), '8 U.S.C.');
  assert.equal(await search.inputValue(), '');
  await page.goto(link);
  await ready();
  assert.equal(await header.innerText(), '8 U.S.C.');
  assert.equal(await cfr.count(), 0);
  await page.evaluate(() => { INASearchTest.getProfile().preferences.automaticStatutoryNavigationSystem = false; });
  await query('INA');
  assert.equal(await authority(), 'usc');
  assert.equal(await header.innerText(), '8 U.S.C.', 'The root index must use the shared switch when automatic following is off.');
  await query('INA 101(a)');
  assert.equal(await authority(), 'usc', 'Automatic citation following must remain disabled in readers.');
  await home();
  assert.equal(await header.innerText(), '8 U.S.C.');
  await page.evaluate(() => { INASearchTest.getProfile().preferences.automaticStatutoryNavigationSystem = true; });
  console.log('PASS shared reader state, Home, cleared search, history, persistence, and root share links');

  await query('INA, CFR');
  const panes = page.locator('.focused-citation-pane');
  assert.equal(await panes.count(), 2);
  assert.equal(await panes.locator('.home-cfr-index').count(), 0);
  await checkRail(panes.nth(0).locator('.pane-reader-actions'), 2);
  await checkRail(panes.nth(1).locator('.pane-reader-actions'), 2);
  assert((await panes.nth(0).innerText()).includes('Contains INA'), 'A root pane must display the same USC state as its shared switch.');
  const firstSwap = panes.nth(0).locator('.main-reader-authority');
  // Start with the shared USC state. Changing it in a hierarchy pane updates that pane.
  await firstSwap.click();
  await settle();
  assert.equal(await authority(), 'ina');
  await firstSwap.click();
  await settle();
  assert.equal(await authority(), 'usc');
  assert((await panes.nth(0).innerText()).includes('Contains INA'));
  await query('INA 101(a), 8 CFR 103.2');
  await checkRail(panes.nth(0).locator('.pane-reader-actions'), 7);
  await checkRail(panes.nth(1).locator('.pane-reader-actions'), 7);
  await panes.nth(0).locator('.main-reader-authority').click();
  const shared = await authority();
  await home();
  assert.equal(await header.innerText(), shared === 'ina' ? 'INA' : '8 U.S.C.');
  await page.evaluate(() => INASearchTest.setLegalNavigatorVisibility('all'));
  await checkRail(mainRail, 2);
  assert(await page.locator('#statuteNavigator').isVisible());
  await page.evaluate(() => INASearchTest.setLegalNavigatorVisibility('single'));
  await checkRail(mainRail, 2);
  await query('8 USC Chapter 12');
  await checkRail(mainRail, 2);
  await query('in:INA naturalization');
  await page.waitForSelector('.occurrence-search-view');
  await checkRail(mainRail, 1);
  console.log('PASS explicit split panes, hierarchy rails, shared pane switching, and search rails');

  // Optional chapter metadata backfills an older corpus without discarding its CFR cache.
  await page.evaluate(async () => {
    const corpus = structuredClone(await window.INA_SEARCH_CORPUS_READY);
    delete corpus.title8.chapterDispositions;
    corpus.homepageCacheSentinel = 'retained';
    await INASearchStorage.activateCorpus(corpus, { reason: 'homepage-test-legacy-cache' });
  });
  await page.goto(url);
  await ready();
  if (await authority() !== 'usc') await swap.click();
  assert.equal(await page.locator('[data-hierarchy-row="usc:title:8:chapter:1"] .hierarchy-status').innerText(), 'REPEALED OR OMITTED');
  assert.equal(await page.evaluate(async () => (await window.INA_SEARCH_CORPUS_READY).homepageCacheSentinel), 'retained');
  console.log('PASS source-matched chapter metadata fallback for an existing cached corpus');

  await page.setViewportSize({ width: 390, height: 844 });
  await home();
  await checkRail(mainRail, 2);
  const geometry = await page.evaluate(() => {
    const rail = document.querySelector('#mainReaderActions').getBoundingClientRect();
    const panel = document.querySelector('#resultsPanel').getBoundingClientRect();
    return { overlap: rail.right > panel.left, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.deepEqual(geometry, { overlap: false, overflow: false });
  await page.screenshot({ path: resolve(session.artifacts, 'home-narrow.png'), fullPage: true });
  await page.emulateMedia({ media: 'print' });
  assert.equal(await mainRail.isVisible(), false);
  assert.equal(session.events.filter(event => event.type === 'pageerror').length, 0, JSON.stringify(session.events));
  console.log('PASS narrow layout, print exclusion, and no browser runtime errors');
} finally {
  await session.close();
}
