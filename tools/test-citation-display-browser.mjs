#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const outputDir = resolve('audits/citation-display-browser');
const session = await startInspection({ url, outputDir });
const page = session.page;
const timings = [];

async function navigate(query, offset = 3) {
  await page.evaluate(({ query, offset }) => {
    INASearchTest.setAnimatedCitationJumps(false);
    INASearchTest.setReadingOffsetPreference('pageViewOffsetPercent', offset);
    INASearchTest.applySearchQuery(query, false, true);
    document.activeElement?.blur();
  }, { query, offset });
  await page.waitForFunction(() => {
    const anchor = document.querySelector('.statutory-node.target > .statutory-line, .statutory-runin-line.citation-target, .cfr-block.target, .cfr-unit-wrapper.target');
    return anchor && Math.abs(anchor.getBoundingClientRect().top - INASearchTest.statuteReadingLine()) < 2;
  });
  await page.mouse.move(900, 50);
}

async function setting(value) {
  await page.locator('#settingsMenuButton').click();
  await page.locator('#inaCitationLinksToggle').selectOption(value);
  await page.locator('#closeSavingMenuButton').click();
}

try {
  await page.setViewportSize({ width: 1054, height: 918 });
  await page.goto(`${url}?q=INA%20237`);
  await page.waitForFunction(() => window.INASearchTest?.getState().selected);
  await page.locator('#settingsMenuButton').click();
  assert.deepEqual(await page.locator('#inaCitationLinksToggle option').allTextContents(), ['Always', 'Follow View Setting', 'Never']);
  assert.equal(await page.locator('#inaCitationLinksToggle').inputValue(), 'view');
  await page.locator('#highlightInaCitationLinksToggle').check();
  await page.locator('#inaCitationLinksToggle').selectOption('view');
  await page.getByRole('button', { name: 'Defined-term highlighting warning' }).hover();
  await page.locator('#definedTermExperimentalWarning').waitFor({state:'visible'});
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#definedTermExperimentalWarning')).opacity === '1');
  assert.match(await page.locator('#definedTermExperimentalWarning').innerText(), /national or international acclaim/);
  await page.screenshot({ path: resolve(outputDir, 'settings-warning.png') });
  await page.locator('#closeSavingMenuButton').click();

  for (const query of ['INA 237(a)(3)', 'INA 101(a)(15)(H)(i)(b)', 'INA 212(a)(6)(C)(i)']) {
    for (const offset of [0, 3, 100]) {
      await navigate(query, offset);
      for (let repeat = 0; repeat < 4; repeat++) {
        const result = await page.evaluate(async () => {
          const api = INASearchTest, state = api.getState();
          const line = api.statuteReadingLine();
          const units = [...document.querySelectorAll('#detailPanel .statutory-node > .statutory-line, #detailPanel .statutory-runin-line')];
          const anchor = units.filter(el => el.getBoundingClientRect().top <= line + 1).at(-1);
          const y = anchor.getBoundingClientRect().top;
          const history = JSON.stringify(state.statuteNavigationHistory);
          const selected = document.querySelector('.statutory-node.target, .statutory-runin-line.citation-target');
          const start = performance.now();
          document.querySelector('#mainReaderAuthorityToggle').click();
          const elapsed = performance.now() - start;
          const immediate = anchor.getBoundingClientRect().top - y;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return { elapsed, immediate, afterPaint: anchor.getBoundingClientRect().top - y,
            sameSelection: selected.isConnected && selected === document.querySelector('.statutory-node.target, .statutory-runin-line.citation-target'),
            sameHistory: history === JSON.stringify(state.statuteNavigationHistory),
            allConverted: [...document.querySelectorAll('#detailPanel [data-citation-display]')].every(el => el.dataset.citationDisplay === state.statuteHierarchyAuthority),
            highlighted: document.querySelectorAll('#detailPanel .citation-display-ina').length,
            authority: state.statuteHierarchyAuthority };
        });
        timings.push(result.elapsed);
        assert(Math.abs(result.immediate) < 1, `${query} at ${offset}% moved during swap: ${result.immediate}`);
        assert(Math.abs(result.afterPaint) < 1, `${query} at ${offset}% moved after repaint: ${result.afterPaint}`);
        assert(result.sameSelection && result.sameHistory, 'Swapping must retain the same selected DOM unit and history');
        assert(result.allConverted);
        assert.equal(result.highlighted > 0, result.authority === 'ina');
        assert(result.elapsed < 100, `Format swap blocked for ${result.elapsed}ms`);
      }
    }
  }
  console.log(`PASS anchored in-place swaps at 0/3/100%: ${timings.length} swaps, max ${Math.max(...timings).toFixed(1)}ms`);

  await navigate('INA 237(a)(3)');
  await setting('ina');
  await navigate('INA 237(a)(3)');
  const alwaysText = await page.locator('#detailPanel').innerText();
  await page.locator('#mainReaderAuthorityToggle').click();
  assert.equal(await page.locator('#detailPanel').innerText(), alwaysText, 'Always must ignore the view switch');
  await setting('usc');
  await navigate('INA 237(a)(3)');
  const neverText = await page.locator('#detailPanel').innerText();
  await page.locator('#mainReaderAuthorityToggle').click();
  assert.equal(await page.locator('#detailPanel').innerText(), neverText, 'Never must ignore the view switch');
  assert.notEqual(alwaysText, neverText);
  await setting('view');
  await page.waitForFunction(() => !INASearchTest.getState().profileChanged);
  await page.reload();
  await page.waitForFunction(() => window.INASearchTest?.getState().selected);
  assert.equal(await page.evaluate(() => INASearchTest.getProfile().preferences.statutoryLinkCitationSystem), 'view');
  console.log('PASS Always/Never independence and saved Follow View Setting');

  for (const query of ['22 CFR 42.11', '22 CFR 41.12']) {
    await page.evaluate(query => INASearchTest.applySearchQuery(query, false, true), query);
    const native = page.locator('#detailPanel [data-reference-family="ina"]');
    await native.first().waitFor();
    assert(await native.count() > 10);
    assert(await native.evaluateAll(elements => elements.filter(el => /^INA\b/.test(el.dataset.referenceSourceText)).every(el => !el.classList.contains('citation-display-ina'))));
    await page.locator('#liveOfficialSource').hover();
    assert.equal(await page.locator('.official-source-action-label').innerText(), 'Open in eCFR.gov');
  }
  console.log('PASS native INA table links remain blue and official source identifies eCFR');

  await navigate('INA 237(a)(3)');
  await page.evaluate(() => {
    const visible = document.querySelector('.statutory-node.target [data-citation-visible]');
    const walker = document.createTreeWalker(visible, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) if (!text.parentElement.closest('a') && text.length > 25) break;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 25);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator('[data-annotation-selection-action="highlight"]').click();
  const highlightedText = await page.locator('mark.user-highlight').allTextContents();
  assert(highlightedText.length > 0);
  await page.locator('#mainReaderAuthorityToggle').click();
  assert.deepEqual(await page.locator('mark.user-highlight').allTextContents(), highlightedText, 'User highlighting must survive replacement of a citation display fragment');
  await page.locator('#mainReaderAuthorityToggle').click();
  assert.deepEqual(await page.locator('mark.user-highlight').allTextContents(), highlightedText);
  console.log('PASS saved text highlights survive both display forms');

  const bubble = page.locator('#liveCitationCopies');
  assert.equal(await bubble.locator('button').count(), 3);
  assert.equal(await bubble.locator(':scope > svg').count(), 1);
  const copy = bubble.locator('[data-live-citation-action="copy-citation"]');
  await page.mouse.move(900, 50);
  assert.equal(await copy.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)');
  await copy.hover();
  assert.notEqual(await copy.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)');
  await page.locator('#liveOfficialSource').hover();
  assert.equal(await page.locator('.official-source-action-label').innerText(), 'Open in House.gov');
  assert((await page.locator('#liveOfficialSource').boundingBox()).width > 100);
  await page.screenshot({ path: resolve(outputDir, 'source-hover.png') });
  await page.mouse.move(900, 50);
  assert((await page.locator('#liveOfficialSource').boundingBox()).width <= 31);
  await page.locator('[data-live-citation-action="print"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'liveOfficialSource');
  assert(await page.locator('.official-source-action-label').isVisible());
  await page.screenshot({ path: resolve(outputDir, 'source-keyboard-focus.png') });
  await page.setViewportSize({ width: 390, height: 918 });
  await page.screenshot({ path: resolve(outputDir, 'narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('PASS shared copy bubble, hover borders, expanding source label, keyboard focus, and narrow layout');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await page.evaluate(() => INASearchTest.applySearchQuery('INA 237(a)(3), INA 101(a)(15)(H)(i)(b)', false, true));
  const panes = page.locator('.focused-citation-pane');
  await panes.nth(1).waitFor();
  const first = panes.first();
  await page.evaluate(async () => { for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame); });
  const paneResult = await first.evaluate(async pane => {
    const paneState = INASearchTest.getState().focusedCitationPanes.find(item => item.element === pane);
    const root = paneState.scrollRoot.getBoundingClientRect();
    const line = root.top + root.height * .03;
    const target = [...pane.querySelectorAll('.statutory-node > .statutory-line, .statutory-runin-line')].filter(el => el.getBoundingClientRect().top <= line + 1).at(-1);
    const before = target.getBoundingClientRect().top;
    pane.querySelector('.main-reader-authority').click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { delta: target.getBoundingClientRect().top - before,
      systems: [...document.querySelectorAll('.focused-citation-pane')].map(el => [...el.querySelectorAll('[data-citation-display]')].every(wrapper => wrapper.dataset.citationDisplay === 'usc')) };
  });
  assert(Math.abs(paneResult.delta) < 1, JSON.stringify(paneResult));
  assert(paneResult.systems.every(Boolean), 'All panes must follow the shared format control');
  console.log('PASS synchronized pane conversion and scroll anchoring');
} finally {
  await session.close();
}
