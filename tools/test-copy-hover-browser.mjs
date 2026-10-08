#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const session = await startInspection({
  url: pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href,
  outputDir: resolve('tmp/copy-hover-browser')
});
const page = session.page;
await page.addInitScript(() => {
  window.qaCopies = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => qaCopies.push(text) } });
});
const frames = () => page.evaluate(async () => {
  for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
});
async function snapshot() {
  return page.evaluate(() => {
    const state = INASearchTest.getState();
    return { query: document.querySelector('#searchInput').value, location: state.statuteNavigationLocation,
      history: state.statuteNavigationHistory, historyIndex: state.statuteNavigationHistoryIndex,
      live: state.mainLiveLocation, pinned: state.mainLivePinned,
      panes: state.focusedCitationPanes.map(pane => ({ query: pane.input.value,
        location: pane.readerState.statuteNavigationLocation, history: pane.commandHistory, index: pane.commandHistoryIndex })) };
  });
}
async function geometry(paneIndex = null) {
  return page.evaluate(paneIndex => {
    const state = INASearchTest.getState(), pane = paneIndex == null ? null : state.focusedCitationPanes[paneIndex];
    const detail = pane?.detail || document.querySelector('#detailPanel');
    const anchor = detail.querySelector('.statutory-node.target > .statutory-line, .statutory-runin-line.citation-target, .cfr-block.target, .cfr-unit-wrapper.target');
    const rect = pane?.scrollRoot.getBoundingClientRect();
    const top = rect?.top ?? Math.max(document.querySelector('.topbar').getBoundingClientRect().bottom,
      document.querySelector('#statuteNavigator').hidden ? 0 : document.querySelector('#statuteNavigator').getBoundingClientRect().bottom);
    const height = rect?.height ?? innerHeight - top;
    return { scroll: pane?.scrollRoot.scrollTop ?? scrollY, anchorTop: anchor?.getBoundingClientRect().top,
      line: top + height * INASearchTest.getProfile().preferences.pageViewOffsetPercent / 100 };
  }, paneIndex);
}
async function exercise(query, offset, paneIndex = null, narrow = false) {
  await page.mouse.move(300, 25);
  await page.setViewportSize({ width: narrow ? 671 : 1054, height: narrow ? 561 : 918 });
  await page.evaluate(({ query, offset }) => {
    const api = INASearchTest;
    api.getProfile().preferences.backupReminder = 'disabled';
    api.setAnimatedCitationJumps(false);
    api.setReadingOffsetPreference('pageViewOffsetPercent', offset);
    api.applySearchQuery(query, false, true);
    document.activeElement?.blur();
  }, { query, offset });
  await frames();
  await page.evaluate(paneIndex => {
    const root = paneIndex == null ? window : INASearchTest.getState().focusedCitationPanes[paneIndex].scrollRoot;
    root.scrollBy({ top: 70, behavior: 'instant' });
  }, paneIndex);
  await frames();
  const rail = paneIndex == null ? page.locator('#mainReaderActions') : page.locator('.focused-citation-pane').nth(paneIndex).locator('.pane-reader-actions');
  const before = await geometry(paneIndex);
  assert(Number.isFinite(before.anchorTop), `Missing selected provision: ${query}`);
  assert(Math.abs(before.anchorTop - before.line) > 20, 'Fixture must start away from the reading offset.');
  await rail.locator('[data-live-citation-action="copy-citation"]').hover();
  await frames();
  assert.equal((await geometry(paneIndex)).scroll, before.scroll, 'Citation-only hover must not scroll.');
  for (const action of ['copy-text', 'copy-citation-text']) {
    const history = await snapshot();
    await rail.locator(`[data-live-citation-action="${action}"]`).hover();
    await frames();
    const during = await geometry(paneIndex);
    assert(Math.abs(during.anchorTop - during.line) <= 2, `${action} did not align the selected provision at ${offset}%: ${JSON.stringify(during)}`);
    assert.deepEqual(await snapshot(), history, 'Hover changed the citation or navigation history.');
    if (paneIndex == null && action === 'copy-text') await page.screenshot({ path: resolve(session.artifacts, `${narrow ? 'narrow' : query.startsWith('8 CFR') ? 'cfr' : 'statute'}-hover.png`) });
    await page.mouse.move(300, 25);
    await frames();
    assert(Math.abs((await geometry(paneIndex)).scroll - before.scroll) <= 1, 'Leaving the copy button did not restore the original scroll position.');
    assert.deepEqual(await snapshot(), history, 'Returning from hover changed navigation history.');
    await rail.locator(`[data-live-citation-action="${action}"]`).hover();
    await frames();
    await rail.locator(`[data-live-citation-action="${action}"]`).click();
    await frames();
    const copied = await page.evaluate(() => qaCopies.at(-1));
    assert(copied?.length > 30, 'Hovering must leave text copying operational.');
    if (paneIndex != null) assert.equal((await snapshot()).panes[paneIndex].history.at(-1).scrollTop, before.scroll,
      'A copy click must save the original reading position in history.');
    await page.mouse.move(300, 25);
    await frames();
    assert(Math.abs((await geometry(paneIndex)).scroll - before.scroll) <= 1, 'Leaving the copy button did not restore the original scroll position.');
  }
  await page.screenshot({ path: resolve(session.artifacts, `${paneIndex == null ? narrow ? 'narrow' : query.startsWith('8 CFR') ? 'cfr' : 'statute' : `pane-${paneIndex}`}-restored.png`) });
  console.log(`PASS ${query}, offset ${offset}%, ${paneIndex == null ? 'main' : `pane ${paneIndex}`}: alignment, copying, and scroll restoration`);
}

try {
  await page.reload();
  await page.waitForFunction(() => window.INASearchTest && !document.querySelector('.boot-workspace'));
  await exercise('INA 212(a)(1)(A)(ii)', 35);
  await exercise('INA 212(a)(1)(A)(ii)', 3, null, true);
  await exercise('8 CFR 214.2(h)(1)', 15);
  const dual = 'INA 212(a)(1)(A)(ii), 8 CFR 214.2(h)(1)';
  await exercise(dual, 35, 0);
  await exercise(dual, 35, 1);
  await page.mouse.move(300, 25);
  await page.evaluate(() => {
    INASearchTest.applySearchQuery('INA 237(a)(3)', false, true);
    INASearchTest.getState().mainLivePinned = false;
    const line = document.querySelector('[data-legal-unit-citation="INA 237(d)(1)"]').closest('.statutory-line');
    scrollBy(0, line.getBoundingClientRect().top - INASearchTest.statuteReadingLine() - 20);
  });
  await frames();
  const liveBefore = await snapshot(), liveScroll = await page.evaluate(() => scrollY);
  const copies = page.locator('#liveCitationCopies');
  for (const action of ['copy-text', 'copy-citation-text']) {
    await copies.locator(`[data-live-citation-action="${action}"]`).hover();
    await frames();
    assert(await page.evaluate(() => {
      const target = INASearchTest.mainReaderActionTarget();
      return Math.abs(target.trigger.closest('.statutory-line').getBoundingClientRect().top - INASearchTest.statuteReadingLine()) < 2;
    }), 'The live copy target must stay fixed when crossing between text buttons.');
    assert.deepEqual(await snapshot(), liveBefore, 'A preview of the live citation changed navigation.');
  }
  await copies.locator('[data-live-citation-action="copy-citation"]').hover();
  await frames();
  assert.equal(await page.evaluate(() => scrollY), liveScroll, 'Moving to citation-only must restore the reader.');
  await copies.locator('[data-live-citation-action="copy-text"]').hover();
  await page.keyboard.press('Escape');
  await frames();
  assert.equal(await page.evaluate(() => scrollY), liveScroll, 'Escape must restore the reader.');
  assert.equal(await page.evaluate(() => INASearchTest.getState().copyActionPreview), null);
  console.log('PASS live target, text-button transitions, citation-only return, and Escape cancellation');
  assert.equal(session.events.filter(event => event.type === 'pageerror').length, 0, JSON.stringify(session.events));
} finally {
  await session.close();
}
