#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const outputDir = resolve('audits/share-preview-browser');
const session = await startInspection({ url, outputDir });
const page = session.page;
await page.addInitScript(() => {
  window.qaCopies = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => qaCopies.push(text) } });
});
async function frames() {
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
}
async function navigate(query, collapsed = false, offset = 3) {
  await page.mouse.move(700, 40);
  await page.evaluate(({ query, collapsed, offset }) => {
    const api = INASearchTest, prefs = api.getProfile().preferences;
    prefs.hideLocalShareWarning = true;
    prefs.statuteNavigationDepth = 8;
    prefs.scrollUpdatesSearch = false;
    api.setAnimatedCitationJumps(false);
    api.setReadingOffsetPreference('pageViewOffsetPercent', offset);
    prefs.mainNavigatorCollapsed = collapsed;
    api.applySearchQuery(query, false, true);
    document.activeElement?.blur();
  }, { query, collapsed, offset });
  await frames();
}
async function snapshot() {
  return page.evaluate(() => {
    const s = INASearchTest.getState();
    return { input: document.querySelector('#searchInput').value, query: INASearchTest.currentShareQuery(),
      history: s.statuteNavigationHistory, index: s.statuteNavigationHistoryIndex, live: s.mainLiveLocation,
      selected: s.statuteNavigationLocation, pinned: s.mainLivePinned,
      panes: s.focusedCitationPanes.map(p => ({ query: p.query, input: p.input.value, entry: p.entry.text,
        history: p.commandHistory, index: p.commandHistoryIndex, location: p.readerState.statuteNavigationLocation,
        path: p.readerState.statuteNavigationPath })) };
  });
}
async function leave() {
  await page.mouse.move(700, 40);
  await page.waitForFunction(() => !INASearchTest.getState().shareViewPreview);
  assert.equal(await page.locator('html.share-view-preview').count(), 0);
}

try {
  await page.setViewportSize({ width: 1054, height: 918 });
  await page.goto(`${url}?q=INA%20237`);
  await page.waitForFunction(() => window.INASearchTest?.getState().selected);
  await frames();
  const heading = await page.locator('.legal-reader-heading').evaluate(el => {
    const title = el.querySelector('.detail-title').getBoundingClientRect();
    const button = el.querySelector('.detail-heading-actions .button').getBoundingClientRect();
    return { titleCenter: title.top + parseFloat(getComputedStyle(el.querySelector('.detail-title')).lineHeight) / 2,
      buttonCenter: button.top + button.height / 2 };
  });
  assert(Math.abs(heading.titleCenter - heading.buttonCenter) < 2);
  assert.equal(Math.round((await page.locator('#statuteNavigatorInner').boundingBox()).x), 12);
  assert.equal(await page.locator('.reader-note-icon text').textContent(), 'N+');
  const dividers = await page.locator('#liveCitationCopies .copy-option-divider').evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
  assert.deepEqual(dividers, [29, 18, 18]);
  await page.screenshot({ path: resolve(outputDir, 'layout.png') });

  await navigate('INA 237(a)(3)');
  await page.evaluate(() => {
    INASearchTest.getState().mainLivePinned = false;
    const target = document.querySelector('[data-legal-unit-citation="INA 237(d)(1)"]');
    scrollBy(0, target.getBoundingClientRect().top - INASearchTest.statuteReadingLine() - 5);
  });
  await frames();
  const beforeBubble = await snapshot();
  const bubble = page.locator('#liveCitationCopies');
  for (const element of [bubble.locator(':scope > svg'), ...await bubble.locator('.copy-option-divider').all()]) {
    await element.hover();
    assert.equal(await page.locator('.citation-hover-target').getAttribute('data-statute-path'), '["d","1"]');
  }
  const box = await bubble.boundingBox();
  await page.mouse.move(box.x + 1, box.y + 4);
  assert.equal(await page.locator('.citation-hover-target').count(), 1, 'Padding also previews');
  assert.deepEqual(await snapshot(), beforeBubble, 'Bubble hover must not log a citation');
  await page.locator('#mainReaderAuthorityToggle').hover();
  assert.equal(await page.locator('.citation-hover-target').count(), 0);
  console.log('PASS whole-bubble hover, separators, paper note icon, heading alignment, and nav padding');

  for (const collapsed of [false, true]) for (const offset of [0, 3, 100]) {
    await navigate('INA 237(a)(3)', collapsed, offset);
    await page.evaluate(() => {
      INASearchTest.getProfile().preferences.statuteNavigationDepth = 1;
      INASearchTest.getState().mainLivePinned = false;
      const line = document.querySelector('[data-legal-unit-citation="INA 237(a)(2)(D)"]').closest('.statutory-line');
      scrollBy(0, line.getBoundingClientRect().top - INASearchTest.statuteReadingLine() + 20);
    });
    await page.waitForFunction(() => INASearchTest.getState().mainLiveLocation?.query === 'INA 237(a)'
      && JSON.stringify(INASearchTest.getState().statuteNavigationPath) === '["a","2","D"]');
    const before = await snapshot(), y = await page.evaluate(() => scrollY);
    await page.locator('#mainShareButton').hover();
    assert.equal(await page.locator('html.share-view-preview').count(), 1);
    assert.equal(await page.locator('#localShareWarningPopover').isVisible(), false, 'Only the warning icon opens the local-file warning on hover');
    assert.notEqual(await page.evaluate(() => scrollY), y);
    assert.deepEqual(await snapshot(), before, 'Preview must preserve history, input, live location and selection');
    assert(await page.evaluate(() => {
      const line = document.querySelector('[data-legal-unit-citation="INA 237(a)"]').closest('.statutory-line');
      return Math.abs(line.getBoundingClientRect().top - INASearchTest.statuteReadingLine()) < 2 || scrollY === 0;
    }));
    if (!collapsed && offset === 3) await page.screenshot({ path: resolve(outputDir, 'share-preview.png') });
    await leave();
    assert.equal(await page.evaluate(() => scrollY), y);
    assert.deepEqual(await snapshot(), before);
  }
  console.log('PASS instant frozen share destinations and exact restoration, expanded/collapsed at 0/3/100%');

  await navigate('INA 237(a)(3)');
  await page.evaluate(() => {
    INASearchTest.getState().mainLivePinned = false;
    const line = document.querySelector('[data-legal-unit-citation="INA 237(d)(1)"]').closest('.statutory-line');
    scrollBy(0, line.getBoundingClientRect().top - INASearchTest.statuteReadingLine() + 25);
  });
  await page.waitForFunction(() => INASearchTest.currentShareQuery() === 'INA 237(d)(1)');
  const beforeCopy = await snapshot(), copyY = await page.evaluate(() => scrollY);
  await page.locator('#mainShareButton').click();
  assert.equal(new URL(await page.evaluate(() => qaCopies.at(-1))).searchParams.get('q'), 'INA 237(d)(1)');
  assert.equal((await snapshot()).history.length, beforeCopy.history.length + 1);
  await page.locator('#mainShareButton').click();
  assert.equal((await snapshot()).history.length, beforeCopy.history.length + 1);
  await leave();
  assert.equal(await page.evaluate(() => scrollY), copyY);
  await page.locator('#mainShareButton').hover();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('html.share-view-preview').count(), 0);
  assert.equal(await page.evaluate(() => scrollY), copyY);
  assert.equal(await page.locator('#detailPanel').isVisible(), true);
  await leave();
  await page.locator('#searchInput').focus();
  // Tab through the two search citation copy controls to Share.
  for (let i = 0; i < 6 && await page.evaluate(() => document.activeElement.id !== 'mainShareButton'); i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mainShareButton');
  assert.equal(await page.locator('html.share-view-preview').count(), 1);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !INASearchTest.getState().shareViewPreview);
  assert.equal(await page.evaluate(() => scrollY), copyY);
  console.log('PASS click commits once, copies the frozen link, and keyboard preview/Escape restore');

  await navigate('INA 237(a)(3), 8 CFR 214.2(h)(13)(iii)(A)');
  await page.locator('.focused-citation-pane').nth(1).waitFor();
  await frames();
  const paneStarts = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(p => p.scrollRoot.scrollTop));
  await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.forEach(p => p.scrollRoot.scrollBy({ top: 200, behavior: 'instant' })));
  await frames();
  const beforePanes = await snapshot();
  const panePositions = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(p => p.scrollRoot.scrollTop));
  await page.locator('#mainShareButton').hover();
  const previewPositions = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(p => p.scrollRoot.scrollTop));
  previewPositions.forEach((value, index) => assert(Math.abs(value - paneStarts[index]) < 2, `Pane ${index} differs from its actual opening destination`));
  assert.deepEqual(await snapshot(), beforePanes);
  await page.screenshot({ path: resolve(outputDir, 'split-preview.png') });
  await leave();
  assert.deepEqual(await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(p => p.scrollRoot.scrollTop)), panePositions);
  assert.deepEqual(await snapshot(), beforePanes);
  console.log('PASS independent statute/CFR pane destinations, restored scrolls and untouched histories');

  await navigate('in:INA national');
  await page.locator('.occurrence-row').first().waitFor();
  await page.evaluate(() => scrollTo(0, 1500));
  await frames();
  const searchY = await page.evaluate(() => scrollY);
  await page.evaluate(() => {
    window.qaSearchState = INASearchTest.getState().mainOccurrencePane.searchState;
    window.qaSearchDom = document.querySelector('#detailPanel').firstChild;
  });
  const beforeSearch = await snapshot();
  await page.locator('#mainShareButton').hover();
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.locator('.occurrence-row').first().waitFor();
  assert.equal((await snapshot()).query, beforeSearch.query);
  await leave();
  assert.equal(await page.evaluate(() => scrollY), searchY);
  assert(await page.evaluate(() => qaSearchState === INASearchTest.getState().mainOccurrencePane.searchState && qaSearchDom === document.querySelector('#detailPanel').firstChild));
  assert.deepEqual(await snapshot(), beforeSearch);
  await navigate('define: alien');
  await page.waitForFunction(() => INASearchTest.getState().view === 'definitions');
  await page.evaluate(() => scrollTo(0, 200));
  await frames();
  const definitionsY = await page.evaluate(() => scrollY), beforeDefinitions = await snapshot();
  await page.locator('#mainShareButton').hover();
  assert.equal(await page.evaluate(() => scrollY), 0);
  await leave();
  assert.equal(await page.evaluate(() => scrollY), definitionsY);
  assert.deepEqual(await snapshot(), beforeDefinitions);
  console.log('PASS search/definition sharing and exact search DOM/state restoration');

  await navigate('INA 237(a)(3)');
  await page.locator('#mainShareButton').hover();
  await page.evaluate(() => INASearchTest.applySearchQuery('INA 104', false, true));
  await frames();
  assert.equal(await page.locator('html.share-view-preview').count(), 0);
  assert.equal((await snapshot()).query, 'INA 104', 'A pending preview return must not undo new navigation');
  await page.mouse.move(700, 40);
  await page.locator('#mainShareButton').hover();
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => !INASearchTest.getState().shareViewPreview);
  assert.equal(await page.locator('html.share-view-preview').count(), 0);
  console.log('PASS new navigation and manual scrolling cancel a preview');

  await navigate('INA 237');
  await page.setViewportSize({ width: 390, height: 918 });
  await frames();
  await page.locator('#mainShareButton').hover();
  await page.screenshot({ path: resolve(outputDir, 'narrow-preview.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.mouse.move(250, 350);
  await page.waitForFunction(() => !INASearchTest.getState().shareViewPreview);
  const errors = session.events.filter(event => event.type === 'pageerror');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS narrow layout and no browser errors');
} finally {
  await session.close();
}
