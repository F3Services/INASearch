#!/usr/bin/env node
// Real Chromium checks using the isolated local-browser-inspection runtime.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const session = await startInspection({ url, outputDir: resolve('audits/live-navigation-browser') });
const page = session.page;
await page.addInitScript(() => {
  window.qaCopies = [];
  window.qaOpens = [];
  window.qaPrints = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.qaCopies.push(text); } } });
  window.open = address => { window.qaOpens.push(address); return { opener: null }; };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { ...descriptor, get() {
    const frame = descriptor.get.call(this);
    if (frame) frame.print = () => window.qaPrints.push(frame.document.body.innerText);
    return frame;
  } });
});

async function reset(query = 'INA 237(a)(3)', collapsed = false, offset = 3, animated = false) {
  await page.goto(`${url}?q=${encodeURIComponent(query)}`);
  await page.waitForFunction(() => window.INASearchTest?.getState().statuteNavigationLocation?.view === 'reader');
  await page.evaluate(({ query, collapsed, offset, animated }) => {
    const api = INASearchTest;
    api.getProfile().preferences.hideLocalShareWarning = true;
    api.setMainNavigatorCollapsed(collapsed);
    api.setReadingOffsetPreference('pageViewOffsetPercent', offset);
    api.setAnimatedCitationJumps(animated);
    api.applySearchQuery(query, false, true);
    document.activeElement?.blur();
  }, { query, collapsed, offset, animated });
  await aligned();
}

async function aligned() {
  await page.waitForFunction(() => {
    const s = INASearchTest.getState();
    if (s.restoringLegalHistory) return false;
    const detail = document.querySelector('#detailPanel');
    const anchor = detail.querySelector('[data-statute-search-match], [data-cfr-search-match], [data-statute-inline-target], .statutory-node.target > .statutory-line, .cfr-unit-wrapper.target, .cfr-block.target')
      || detail.querySelector('[data-statute-start], [data-cfr-start]');
    if (!anchor) return false;
    const delta = anchor.getBoundingClientRect().top - INASearchTest.statuteReadingLine();
    return Math.abs(delta) < 2 || (scrollY === 0 && delta < 0)
      || (scrollY + innerHeight >= document.documentElement.scrollHeight - 2 && delta > 0);
  });
}

async function scrollToPath(path, query = `INA 237${path.map(x => `(${x})`).join('')}`) {
  const delta = await page.evaluate(path => {
    const encoded = JSON.stringify(path);
    const node = [...document.querySelectorAll('#detailPanel .statutory-node')].find(el => el.dataset.statutePath === encoded);
    return node.querySelector(':scope > .statutory-line').getBoundingClientRect().top - INASearchTest.statuteReadingLine();
  }, path);
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(query => INASearchTest.getState().mainLiveLocation?.query === query, query);
}

async function snapshot() {
  return page.evaluate(() => {
    const s = INASearchTest.getState();
    return { query: s.query, input: document.querySelector('#searchInput').value, history: s.statuteNavigationHistory,
      index: s.statuteNavigationHistoryIndex, live: s.mainLiveLocation?.query, highlight: document.querySelector('.statutory-node.target')?.dataset.statutePath,
      backDisabled: document.querySelector('#mainSearchHistoryBack').disabled, forwardDisabled: document.querySelector('#mainSearchHistoryForward').disabled };
  });
}

try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const collapsed of [false, true]) {
    await reset('INA 237(a)(3)', collapsed);
    const initial = await snapshot();
    assert.equal(initial.history.length, 1);
    await scrollToPath(['a', '2', 'D']);
    const live = await snapshot();
    assert.deepEqual(live.history, initial.history);
    assert.equal(live.query, 'INA 237(a)(3)');
    assert.equal(live.input, 'INA 237(a)(3)');
    assert.equal(live.highlight, '["a","3"]');
    assert.equal(live.backDisabled, false);
    await page.locator('#mainSearchHistoryBack').click();
    await aligned();
    assert.equal((await snapshot()).live, 'INA 237(a)(3)');
    assert.equal((await snapshot()).index, 0);
    assert.equal((await snapshot()).history.length, 1);
    assert.equal((await snapshot()).backDisabled, true);
  }
  console.log('PASS live scrolling and return-to-current Back in both modes');

  for (const action of ['copy-citation', 'copy-citation-text', 'share', 'print', 'open', 'add-note', 'copy-text', 'menu-copy-text', 'menu-copy-share-link']) {
    await reset();
    await scrollToPath(['d', '1']);
    if (action.startsWith('menu-')) {
      await page.locator('[data-legal-unit-citation="INA 237(d)(1)"]').click();
      assert.equal((await snapshot()).history.length, 2, 'Opening a citation menu commits it');
      await page.locator(`[data-legal-unit-action="${action.slice(5)}"]`).click();
    } else if (action === 'share') await page.locator('#mainShareButton').click();
    else await page.locator(`[data-live-citation-action="${action}"]`).click();
    const committed = await snapshot();
    assert.equal(committed.history.length, 2, action);
    assert.equal(committed.history[0].displayQuery, 'INA 237(a)(3)', `${action}: source presentation changed`);
    assert.deepEqual(committed.history[1].path, ['d', '1'], action);
    assert.equal(committed.highlight, '["d","1"]', action);
    const outputs = await page.evaluate(() => ({ copies: qaCopies, prints: qaPrints, opens: qaOpens,
      notes: INASearchTest.getProfile().notes }));
    if (action === 'share' || action === 'menu-copy-share-link') assert.equal(new URL(outputs.copies.at(-1)).searchParams.get('q'), 'INA 237(d)(1)');
    if (action === 'copy-citation') assert.equal(outputs.copies.at(-1), 'INA 237(d)(1)');
    if (action === 'copy-citation-text') assert.match(outputs.copies.at(-1), /^INA 237\(d\)\(1\) states the following -\n/);
    if (['copy-text', 'menu-copy-text', 'copy-citation-text'].includes(action)) assert.match(outputs.copies.at(-1), /If the Secretary of Homeland Security/);
    if (action === 'print') {
      assert.match(outputs.prints.at(-1), /INA 237\(d\)\(1\)/);
      assert.doesNotMatch(outputs.prints.at(-1), /Failure to register and falsification of documents/);
    }
    if (action === 'open') assert.match(outputs.opens.at(-1), /uscode\.house\.gov/);
    if (action === 'add-note') assert(outputs.notes.some(n => n.associations.some(a => a.start.path.join('/') === 'd/1')));
    await page.locator('#mainSearchHistoryBack').click();
    await aligned();
    assert.equal((await snapshot()).live, 'INA 237(a)(3)', action);
    await page.locator('#mainSearchHistoryForward').click();
    await aligned();
    assert.equal((await snapshot()).live, 'INA 237(d)(1)', action);
  }
  console.log('PASS fixed toolbar/menu action targets, combined copies, history, and highlighting');

  for (const collapsed of [false, true]) {
    await reset('INA 237(a)(3)', collapsed);
    const rail = await page.locator('#mainReaderActions').boundingBox();
    await scrollToPath(['a', '3', 'B', 'ii']);
    assert.equal(await page.evaluate(() => INASearchTest.mainReaderActionTarget().query), 'INA 237(a)(3)');
    await page.locator('[data-live-citation-action="copy-citation"]').hover();
    assert.equal(await page.locator('.citation-hover-target').count(), 0, 'A visible blue selection owns the actions');
    await page.locator('[data-live-citation-action="copy-citation"]').click();
    assert.equal(await page.evaluate(() => qaCopies.at(-1)), 'INA 237(a)(3)');
    assert.equal((await snapshot()).history.length, 1);
    const lastSliver = await page.evaluate(() => {
      const top = document.querySelector('#statuteNavigator').hidden ? document.querySelector('.topbar').getBoundingClientRect().bottom : document.querySelector('#statuteNavigator').getBoundingClientRect().bottom;
      return document.querySelector('.statutory-node.target').getBoundingClientRect().bottom - top - 12;
    });
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, lastSliver);
    await page.waitForFunction(() => {
      const rect = document.querySelector('.statutory-node.target').getBoundingClientRect();
      return rect.top < 0 && rect.bottom < 200;
    });
    assert.equal(await page.evaluate(() => INASearchTest.mainReaderActionTarget().query), 'INA 237(a)(3)', 'Even the last visible portion keeps the selection active');
    await scrollToPath(['d', '1']);
    await page.locator('[data-live-citation-action="copy-citation"]').hover();
    assert.equal(await page.evaluate(() => INASearchTest.mainReaderActionTarget().query), 'INA 237(d)(1)');
    assert.equal(await page.locator('.citation-hover-target').getAttribute('data-statute-path'), '["d","1"]');
    assert.equal((await snapshot()).history.length, 1, 'Hover must not commit a fallback');
    const after = await page.locator('#mainReaderActions').boundingBox();
    assert.deepEqual(after, rail, 'The action column must not move with scrolling');
    assert.equal((await snapshot()).input, 'INA 237(a)(3)', 'Collapsed search also retains the entered citation');
    await page.mouse.move(4, 600);
    assert.equal(await page.locator('.citation-hover-target').count(), 0);
  }
  await reset();
  const beforeNextCitation = await page.evaluate(() => {
    const trigger = document.querySelector('[data-legal-unit-citation="INA 237(d)(2)"]');
    return trigger.getBoundingClientRect().top - INASearchTest.statuteReadingLine() - 20;
  });
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, beforeNextCitation);
  await page.waitForFunction(() => INASearchTest.mainReaderActionTarget()?.query === 'INA 237(d)(2)');
  await page.locator('[data-live-citation-action="copy-citation"]').hover();
  assert.equal(await page.locator('.citation-hover-target').getAttribute('data-statute-path'), '["d","2"]');
  await page.locator('[data-live-citation-action="copy-citation"]').focus();
  await page.locator('#mainReaderAuthorityToggle').hover();
  assert.equal(await page.locator('.citation-hover-target').count(), 0, 'The format switch must not preview a citation, even with an action focused');
  await page.mouse.wheel(0, 20);
  assert.equal(await page.locator('.citation-hover-target').count(), 0, 'Scrolling under the format switch must not restore the preview');
  await page.mouse.move(4, 600);
  await page.locator('#mainReaderAuthorityToggle').focus();
  assert.equal(await page.locator('.citation-hover-target').count(), 0, 'Keyboard focus on the format switch must not preview a citation');
  await page.locator('[data-live-citation-action="copy-text"]').focus();
  assert.equal(await page.locator('.citation-hover-target').count(), 1, 'Keyboard focus on a citation action must still preview its target');
  await page.locator('#mainReaderAuthorityToggle').focus();
  assert.equal(await page.locator('.citation-hover-target').count(), 0);
  console.log('PASS partial-selection precedence, first-below-offset hover, stationary controls, and stable search in both modes');

  await page.setViewportSize({ width: 1054, height: 420 });
  await reset();
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => !INASearchTest.mainReaderActionTarget());
  for (const action of await page.locator('[data-live-citation-action]').all()) {
    assert(await action.isDisabled(), 'Actions must be disabled when only editorial material remains in view');
    await action.hover();
    assert.equal(await page.locator('.citation-hover-target').count(), 0, 'Disabled actions must not preview a citation');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS format switch and disabled action hover suppression');

  await reset();
  await scrollToPath(['d', '1']);
  await page.locator('#citationEquivalentIna').click();
  assert.equal((await snapshot()).history.length, 1, 'Search copies retain their entered target');
  await scrollToPath(['d', '1']);
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  await page.locator('#mainReaderAuthorityToggle').click();
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 U.S.C. 1227(d)(1)');
  assert.equal((await snapshot()).history.length, 2, 'Equivalent citation formats must deduplicate');
  await page.locator('#mainReaderAuthorityToggle').click();
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  await scrollToPath(['d', '2']);
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  assert.equal((await snapshot()).forwardDisabled, false, 'Unlogged scrolling must preserve the forward branch');
  await scrollToPath(['d', '3']);
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  assert.deepEqual((await snapshot()).history.map(x => x.path), [['a', '3'], ['d', '3']]);
  assert.equal((await snapshot()).forwardDisabled, true);
  console.log('PASS format switch, canonical deduplication, and branching');

  await reset();
  await page.locator('#settingsMenuButton').click();
  assert.equal(await page.locator('#citationCopyPrefaceInput').inputValue(), '[Citation] states the following -\n\n');
  assert(!(await page.locator('#citationCopyPrefaceWarning').isVisible()));
  await page.locator('#citationCopyPrefaceInput').fill('Under [cItAtIoN], the text is:\n\n');
  assert(!(await page.locator('#citationCopyPrefaceWarning').isVisible()));
  await page.locator('#closeSavingMenuButton').click();
  await page.locator('[data-live-citation-action="copy-citation-text"]').click();
  assert.match(await page.evaluate(() => qaCopies.at(-1)), /^Under INA 237\(a\)\(3\), the text is:\n\n/);
  await page.locator('#settingsMenuButton').click();
  await page.locator('#citationCopyPrefaceInput').fill('The law says:\n');
  assert.equal(await page.locator('#citationCopyPrefaceWarning').innerText(), '[citation] not detected');
  assert(await page.locator('#citationCopyPrefaceWarning').isVisible());
  await page.locator('#closeSavingMenuButton').click();
  await page.waitForFunction(() => !INASearchTest.getState().profileChanged);
  await page.reload();
  await page.waitForFunction(() => window.INASearchTest?.getState().statuteNavigationLocation?.view === 'reader');
  await aligned();
  await page.locator('[data-live-citation-action="copy-citation-text"]').click();
  assert.match(await page.evaluate(() => qaCopies.at(-1)), /^The law says:\n/);
  await page.locator('#settingsMenuButton').click();
  assert.equal(await page.locator('#citationCopyPrefaceInput').inputValue(), 'The law says:\n');
  await page.locator('#resetCitationCopyPrefaceButton').click();
  await page.locator('#closeSavingMenuButton').click();
  await page.waitForFunction(() => !INASearchTest.getState().profileChanged);
  console.log('PASS case-insensitive preface substitution, exact missing-token warning, and saved preference');

  await reset('INA 237(a)(3)', true);
  await page.locator('#searchInput').focus();
  await scrollToPath(['a', '2', 'D']);
  assert.equal(await page.locator('#searchInput').inputValue(), 'INA 237(a)(3)', 'Focused search must not be overwritten');
  await page.locator('#mainNavigatorToggle').focus();
  assert.equal(await page.locator('#searchInput').inputValue(), 'INA 237(a)(3)');
  await page.locator('#searchInput').fill('INA nope(');
  await page.locator('#mainNavigatorToggle').focus();
  assert.equal(await page.locator('#searchInput').inputValue(), 'INA nope(', 'Unfinished input survives blur');
  await page.locator('#searchInput').press('Escape');
  await aligned();
  assert.equal((await snapshot()).input, 'INA 237(a)(3)');
  console.log('PASS focused editing, unfinished drafts, and cancellation');

  await reset();
  const offsetAnchorTop = await page.locator('.statutory-node.target > .statutory-line').evaluate(el => el.getBoundingClientRect().top);
  await page.evaluate(() => INASearchTest.setReadingOffsetPreference('pageViewOffsetPercent', 50));
  await page.waitForFunction(() => INASearchTest.getState().mainLiveLocation?.query !== 'INA 237(a)(3)');
  assert(Math.abs(await page.locator('.statutory-node.target > .statutory-line').evaluate(el => el.getBoundingClientRect().top) - offsetAnchorTop) < 2,
    'Changing the tracking point must preserve the text position, including browser scroll anchoring when the bar wraps');
  assert.equal((await snapshot()).history.length, 1);
  assert.equal((await snapshot()).highlight, '["a","3"]');
  await reset();
  await scrollToPath(['d', '1']);
  await page.locator('#settingsMenuButton').click();
  await page.locator('#statuteNavigationDepthSelect').selectOption('1');
  await page.locator('#closeSavingMenuButton').click();
  assert.equal((await snapshot()).live, 'INA 237(d)');
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), 'INA 237(d)(1)');
  await page.locator('#settingsMenuButton').click();
  await page.locator('#statuteNavigationDepthSelect').selectOption('8');
  await page.locator('#closeSavingMenuButton').click();
  console.log('PASS offset tracking and exact action targets independent of displayed depth');

  for (const query of ['INA 237', 'INA 237(a)(3)', 'INA 101(a)(15)(H)(i)(b)', 'INA 104', '8 CFR 214.2(h)(13)(iii)(A)']) {
    for (const offset of [0, 3, 100]) {
      for (const animated of [false, true]) {
        await reset(query, false, offset, animated);
        assert.equal((await snapshot()).live, query, `${query}, ${offset}%, animated=${animated}: jump was replaced by scroll tracking`);
        assert.equal((await snapshot()).history.length, 1);
      }
    }
  }
  console.log('PASS whole-section, deep INA/CFR, short-section, and animated jump matrix');

  await reset();
  const anchorOffset = () => page.evaluate(() => document.querySelector('.statutory-node.target > .statutory-line').getBoundingClientRect().top - INASearchTest.statuteReadingLine());
  const before = await anchorOffset();
  await page.locator('#mainNavigatorToggle').click();
  assert(Math.abs(await anchorOffset() - before) < 2, 'Collapse must preserve the reading anchor');
  await page.locator('#mainNavigatorToggle').click();
  assert(Math.abs(await anchorOffset() - before) < 2, 'Expand must preserve the reading anchor');
  await page.locator('#mainNavigatorToggle').click();
  await page.waitForFunction(() => !INASearchTest.getState().profileChanged);
  await page.reload();
  await page.waitForFunction(() => INASearchTest?.getState().statuteNavigationLocation?.view === 'reader');
  assert.equal(await page.locator('#statuteNavigator').isVisible(), false, 'Collapse choice must survive reload');

  for (const width of [390, 768, 1240, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await reset('INA 237');
    const heading = await page.locator('.legal-reader-heading').evaluate(el => {
      const citation = el.querySelector('.legal-unit-section-trigger'), title = el.querySelector('h2');
      return { citationFont: getComputedStyle(citation).fontSize, titleFont: getComputedStyle(title).fontSize,
        citationY: citation.getBoundingClientRect().top, titleY: title.getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(heading.citationFont, heading.titleFont);
    if (width >= 768) assert(Math.abs(heading.citationY - heading.titleY) < 8, 'Wide heading must be one row');
    assert.equal(heading.overflow, false, `Overflow at ${width}px`);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const actions = rect('#mainReaderActions'), panel = rect('#detailPanel');
      const button = rect('#themeCycleButton'), icon = rect('[data-theme-cycle-icon] > svg');
      return { navHeight: rect('#statuteNavigator').height, actionsWidth: actions.width, actionsLeft: actions.left,
        actionsRight: actions.right, panelLeft: panel.left, shareInSearch: Boolean(document.querySelector('#mainShareButton').closest('.global-search')),
        toggleLeft: rect('#mainNavigatorToggle').left, brandLeft: rect('#inaSearchBrand').left,
        iconOffset: Math.abs(button.left + button.width / 2 - icon.left - icon.width / 2) + Math.abs(button.top + button.height / 2 - icon.top - icon.height / 2) };
    });
    assert(layout.navHeight <= 47, 'Navigation must stay on one row');
    assert.equal(layout.actionsWidth, 31);
    assert(layout.actionsLeft >= 0);
    if (width >= 1240) assert(layout.actionsRight <= layout.panelLeft, 'Actions must fit in the existing page gutter');
    assert(layout.shareInSearch);
    assert(layout.toggleLeft < layout.brandLeft);
    assert.equal(await page.locator('#statuteNavigator [data-statute-authority-cycle]').count(), 0);
    assert.equal(await page.locator('#liveCitationCopies [data-live-citation-action="copy-citation"]').count(), 1);
    assert((await page.locator('[data-live-citation-action="copy-citation-text"]').boundingBox()).height > 31);
    assert(layout.iconOffset < 1, 'Theme icon must be centered');
    await page.screenshot({ path: resolve(`audits/live-navigation-browser/expanded-${width}.png`) });
    await page.locator('#mainNavigatorToggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(`audits/live-navigation-browser/collapsed-${width}.png`) });
  }
  await page.setViewportSize({ width: 1000, height: 918 });
  await reset();
  assert(await page.locator('#citationEquivalent').evaluate(el => el.classList.contains('citation-labels-collapsed')));
  assert(await page.locator('.brand-label').isVisible());
  await page.setViewportSize({ width: 800, height: 918 });
  await page.waitForFunction(() => document.querySelector('.topbar').classList.contains('brand-logo-only'));
  assert(!(await page.locator('.topbar').evaluate(el => el.classList.contains('search-on-second-row'))));
  await page.setViewportSize({ width: 320, height: 918 });
  await reset('INA 101(a)(15)(H)(i)(b)');
  await page.locator('#mainNavigatorOverflow > summary').click();
  assert(await page.locator('#mainNavigatorOverflowMenu .statute-nav-option').first().isVisible());
  assert((await page.locator('#statuteNavigator').boundingBox()).height <= 47);
  await page.locator('#mainNavigatorOverflow > summary').press('Escape');
  assert(!(await page.locator('#mainNavigatorOverflow').evaluate(el => el.open)));
  await page.locator('#mainNavigatorOverflow > summary').click();
  await page.locator('#mainNavigatorOverflowMenu').getByRole('menuitem', { name: /^INA 102 / }).click();
  await aligned();
  assert.equal((await snapshot()).live, 'INA 102');
  assert(!(await page.locator('#mainNavigatorOverflow').evaluate(el => el.open)));
  console.log('PASS toggle anchors, gutter actions, staged header collapse, one-row navigation, and responsive widths');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await reset('8 CFR 214.2(h)(13)(iii)(A)');
  const cfrDelta = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.cfr-unit-wrapper[data-cfr-path], .cfr-block[data-cfr-path]')]
      .find(el => el.dataset.cfrPath === '(h)(13)(iii)(B)');
    return target.getBoundingClientRect().top - INASearchTest.statuteReadingLine();
  });
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, cfrDelta);
  await page.waitForFunction(() => INASearchTest.getState().mainLiveLocation?.query === '8 CFR 214.2(h)(13)(iii)(B)');
  assert.equal(await page.evaluate(() => INASearchTest.mainReaderActionTarget().query), '8 CFR 214.2(h)(13)(iii)(A)', 'The last visible portion of the CFR selection still owns the actions');
  await page.locator('[data-live-citation-action="open"]').click();
  assert.equal((await snapshot()).history.length, 1);
  await page.locator('[data-legal-unit-citation="8 CFR 214.2(h)(13)(iii)(B)"]').first().click();
  await page.locator('[data-live-citation-action="open"]').click();
  assert.match(await page.evaluate(() => qaOpens.at(-1)), /ecfr\.gov/);
  assert.equal((await snapshot()).history.length, 2);
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  assert.equal((await snapshot()).live, '8 CFR 214.2(h)(13)(iii)(A)');
  assert(await page.locator('#mainReaderAuthorityToggle').isVisible());
  assert(await page.locator('#mainReaderAuthorityToggle').isEnabled());
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 CFR 214.2(h)(13)(iii)(A)');
  await page.locator('[data-live-citation-action="copy-citation-text"]').click();
  assert.match(await page.evaluate(() => qaCopies.at(-1)), /^8 CFR 214\.2\(h\)\(13\)\(iii\)\(A\) states the following -\n/);
  const leaveCfrSelection = await page.locator('.cfr-subtree.target').evaluate(el => el.getBoundingClientRect().bottom - INASearchTest.statuteReadingLine() + 100);
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, leaveCfrSelection);
  await page.waitForFunction(() => INASearchTest.mainReaderActionTarget()?.query !== '8 CFR 214.2(h)(13)(iii)(A)');
  const cfrFallback = await page.evaluate(() => INASearchTest.mainReaderActionTarget().query);
  await page.locator('[data-live-citation-action="copy-citation"]').hover();
  assert(await page.locator('.cfr-block.citation-hover-target').isVisible());
  await page.locator('#mainReaderAuthorityToggle').hover();
  assert.equal(await page.locator('.citation-hover-target').count(), 0, 'The format switch must clear the previous action preview');
  await page.locator('[data-live-citation-action="copy-citation"]').hover();
  assert(await page.locator('.cfr-block.citation-hover-target').isVisible());
  await page.locator('[data-live-citation-action="copy-citation"]').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), cfrFallback);
  await reset('8 U.S.C. 1252c');
  assert(await page.locator('#mainReaderAuthorityToggle').isVisible());
  assert(await page.locator('#mainReaderAuthorityToggle').isEnabled());
  console.log('PASS CFR and non-INA statutes, always-enabled format switch, and citation copying');

  await page.evaluate(() => INASearchTest.applySearchQuery('in:237 deportable', false, true));
  await page.locator('.occurrence-row [data-occurrence-open]').first().click();
  await aligned();
  const occurrence = await page.evaluate(() => structuredClone(INASearchTest.getState().explicitOccurrenceTarget));
  assert(occurrence, 'Opening a text hit must retain its exact occurrence');
  await page.evaluate(() => INASearchTest.applySearchQuery('INA 104', false, true));
  await aligned();
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  assert.deepEqual(await page.evaluate(() => INASearchTest.getState().explicitOccurrenceTarget), occurrence);
  await page.locator('#mainSearchHistoryBack').click();
  await page.locator('.occurrence-search-summary').waitFor();
  assert.equal(await page.locator('#searchInput').inputValue(), 'in:237 deportable');
  console.log('PASS exact search-hit restoration and return to search results');

  await page.evaluate(() => INASearchTest.applySearchQuery('INA 101, INA 212', false, true));
  await page.locator('.focused-citation-pane').nth(1).waitFor();
  assert.equal(await page.locator('#mainReaderActions').isVisible(), false);
  const first = page.locator('.focused-citation-pane').first();
  await first.locator('.focused-citation-pane-search').fill('INA 237(a)(3)');
  await first.locator('.focused-citation-pane-search').press('Enter');
  await page.waitForFunction(() => INASearchTest.getState().focusedCitationPanes[0].entry.text === 'INA 237(a)(3)');
  await page.locator('.focused-citation-pane').nth(1).locator('[data-focused-citation-remove]').click();
  await page.waitForFunction(() => !INASearchTest.getState().focusedCitationMode);
  assert.equal(await page.locator('#searchInput').inputValue(), 'INA 237(a)(3)', 'Promotion must display only the remaining pane’s citation');
  await page.locator('#mainNavigatorToggle').focus();
  await scrollToPath(['a', '2', 'D']);
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  assert.equal((await snapshot()).live, 'INA 237(a)(3)');
  await page.locator('#mainSearchHistoryBack').click();
  await aligned();
  assert.equal((await snapshot()).live, 'INA 101');
  console.log('PASS unchanged pane controls and promoted main-reader history');
  await page.setViewportSize({ width: 390, height: 918 });
  await page.goto(`${url}?q=INA`);
  await page.waitForFunction(() => document.querySelector('.topbar').classList.contains('search-on-second-row'));
  assert(await page.locator('#mainReaderActions').isVisible(), 'Contents pages retain the side controls at narrow widths');
  assert(await page.locator('#mainShareButton').isVisible());
  console.log('PASS narrow header initialization outside the citation reader');
  assert.equal(session.events.filter(event => ['pageerror', 'error'].includes(event.type)).length, 0, JSON.stringify(session.events));
  console.log('Live navigation browser tests passed.');
} finally {
  await session.close();
}
