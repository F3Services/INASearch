#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const session = await startInspection({url:pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href,outputDir:resolve('audits/search-reference-display-browser')});
const {page} = session;
const inaLabel = 'INA 101(a)(15)(H)(i)(b)';
const mainHit = () => page.getByRole('button',{name:'Open INA 212(j)(2) at this hit',exact:true});
async function preference(value) {
  await page.getByRole('button',{name:'Open settings',exact:true}).click();
  await page.locator('#inaCitationLinksToggle').selectOption(value);
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
}
async function search(value) {
  await page.locator('#searchInput').fill(value);
  await page.locator('#searchInput').press('Enter');
  await mainHit().waitFor();
}
async function authority(value) {
  const button = page.locator('#mainReaderAuthorityToggle');
  if (!(await button.innerText()).includes(value.toUpperCase())) await button.click();
}
async function marks(locator) { return locator.locator('mark').allTextContents(); }
try {
  await page.waitForFunction(()=>!!window.INASearchTest);
  await preference('view');
  await search('in:212(j) "this title"');
  await authority('ina');
  assert.deepEqual(await marks(mainHit()),[inaLabel]);
  const query = await page.locator('#searchInput').inputValue();
  await authority('usc');
  assert.deepEqual(await marks(mainHit()),['this title']);
  assert.equal(await page.locator('#searchInput').inputValue(),query);
  assert((await page.locator('.occurrence-search-summary').first().innerText()).includes('2 hits in 1 section'));
  await preference('ina');
  assert.deepEqual(await marks(mainHit()),[inaLabel]);
  await authority('ina');
  await preference('usc');
  assert.deepEqual(await marks(mainHit()),['this title']);
  await preference('view');
  await search('in:212(j) "this title", in:8 CFR 106.4 cites:101a15hib');
  const cfrHit = page.getByRole('button',{name:'Open 8 CFR 106.4(c)(2) at this hit',exact:true});
  await cfrHit.waitFor();
  await preference('usc');
  assert.deepEqual(await marks(mainHit()),['this title']);
  assert((await cfrHit.innerText()).includes('section 101(a)(15)(H)(i)(b) of the INA'));
  await preference('ina');
  assert.deepEqual(await marks(mainHit()),[inaLabel]);
  assert.deepEqual(await marks(cfrHit),[inaLabel]);
  await preference('view');
  const swaps = page.locator('.focused-citation-pane .main-reader-authority');
  if (!(await swaps.first().innerText()).includes('INA')) await swaps.first().click();
  assert.deepEqual(await marks(mainHit()),[inaLabel]);
  assert.deepEqual(await marks(cfrHit),[inaLabel]);
  await session.capture('split-search-ina');
  await swaps.first().click();
  assert.deepEqual(await marks(mainHit()),['this title']);
  assert((await cfrHit.innerText()).includes('section 101(a)(15)(H)(i)(b) of the INA'));
  await page.getByRole('button',{name:'Open INA 212(j)(2)',exact:true}).click();
  await page.locator('.focused-citation-pane .statutory-node').first().waitFor();
  assert.deepEqual(session.events.filter(event=>event.type==='pageerror'||event.type==='error'),[]);
  console.log('PASS search reference browser: live swaps, setting overrides, unchanged query/counts, both panes, highlights and result navigation');
} finally { await session.close(); }
