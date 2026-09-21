#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const outputDir = resolve('audits/pane-actions-browser');
const session = await startInspection({ url, outputDir });
const page = session.page;
await page.addInitScript(() => {
  window.qaCopies = []; window.qaOpens = []; window.qaPrints = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => qaCopies.push(text) } });
  window.open = address => { qaOpens.push(address); return { opener: null }; };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { ...descriptor, get() {
    const frame = descriptor.get.call(this);
    if (frame) frame.print = () => qaPrints.push(frame.document.body.innerText);
    return frame;
  } });
});
const panes = page.locator('.focused-citation-pane');
const rail = index => panes.nth(index).locator('.pane-reader-actions');
const action = (index, name) => rail(index).locator(`[data-live-citation-action="${name}"]`);
async function settle() { await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }); }
async function query(text, count = 2) {
  await page.evaluate(text => INASearchTest.applySearchQuery(text, false, true), text);
  await page.waitForFunction(count => INASearchTest.getState().focusedCitationPanes.length === count, count);
  await settle();
}
async function geometry() {
  return page.evaluate(() => [...document.querySelectorAll('.focused-citation-pane-head')].map(head => {
    const box = head.querySelector('.focused-pane-search-field').getBoundingClientRect();
    const center = box.top + box.height / 2;
    const chips = [...head.querySelectorAll('.focused-pane-citation-pair')].map(el => el.getBoundingClientRect());
    const controls = [...head.querySelectorAll('.focused-citation-pane-history button, .focused-pane-citation-pair, .focused-citation-pane-remove')];
    return { centered: controls.every(el => Math.abs(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - center) < 1),
      inside: chips.every(r => r.left > box.left && r.right < box.right && r.top > box.top && r.bottom < box.bottom),
      overflow: head.scrollWidth > head.clientWidth };
  }));
}
try {
  await page.setViewportSize({ width: 1054, height: 918 });
  await page.goto(`${url}?q=237,212`);
  await page.waitForFunction(() => INASearchTest.getState().focusedCitationPanes.length === 2);
  await page.evaluate(() => {
    INASearchTest.setAnimatedCitationJumps(false);
    INASearchTest.getProfile().preferences.statutoryLinkCitationSystem = 'view';
    INASearchTest.getProfile().preferences.backupReminder = 'disabled';
  });
  await settle();
  for (const item of await geometry()) assert(item.centered && item.inside && !item.overflow, JSON.stringify(item));
  assert.equal(await rail(0).locator('button').count(), 7);
  assert.equal(await rail(1).locator('button').count(), 7);
  assert.equal(await page.locator('[id="liveCitationCopies"]').count(), 1, 'Pane rails must not duplicate main IDs');
  await page.screenshot({ path: resolve(outputDir, 'layout.png') });
  console.log('PASS aligned header controls and citation copies inside both search fields');

  await query('INA 237(a)(3), INA 101(a)(15)(H)(i)(b)');
  const stable = await page.evaluate(async () => {
    const state = INASearchTest.getState(), panes = state.focusedCitationPanes;
    const anchors = panes.map(pane => {
      const r = pane.scrollRoot.getBoundingClientRect(), line = r.top + r.height * .03;
      return [...pane.detail.querySelectorAll('.statutory-node > .statutory-line, .statutory-runin-line')].filter(el => el.getBoundingClientRect().top <= line + 1).at(-1);
    });
    const before = anchors.map(el => el.getBoundingClientRect().top);
    const history = panes.map(pane => JSON.stringify(pane.commandHistory));
    const commands = panes.map(pane => pane.input.value);
    const started = performance.now();
    panes[1].readerActions.querySelector('.main-reader-authority').click();
    const elapsed = performance.now() - started;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return { elapsed, delta: anchors.map((el, i) => el.getBoundingClientRect().top - before[i]),
      stable: panes.every((pane, i) => commands[i] === pane.input.value && history[i] === JSON.stringify(pane.commandHistory)),
      converted: panes.every(pane => [...pane.detail.querySelectorAll('[data-citation-display]')].every(el => el.dataset.citationDisplay === 'usc')),
      labels: panes.map(pane => pane.readerActions.querySelector('.statute-authority-cycle-current').textContent) };
  });
  assert(stable.delta.every(d => Math.abs(d) < 1), JSON.stringify(stable));
  assert(stable.stable && stable.converted);
  assert.deepEqual(stable.labels, ['USC', 'USC']);
  assert(stable.elapsed < 100, `Synchronized swap took ${stable.elapsed}ms`);
  console.log(`PASS shared switch, preserved histories and both reading anchors (${stable.elapsed.toFixed(1)}ms)`);

  await action(0, 'copy-citation').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 U.S.C. 1227(a)(3)');
  await action(1, 'copy-citation').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 U.S.C. 1101(a)(15)(H)(i)(b)');
  await action(0, 'copy-text').click();
  const text = await page.evaluate(() => qaCopies.at(-1));
  assert.match(text, /Failure to register/);
  await action(0, 'copy-citation-text').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), `8 U.S.C. 1227(a)(3) states the following -\n${text}`);
  await action(1, 'open').click();
  assert.match(await page.evaluate(() => qaOpens.at(-1)), /1101/);
  await action(0, 'print').click();
  assert.match(await page.evaluate(() => qaPrints.at(-1)), /Failure to register/);
  await action(1, 'add-note').click();
  await panes.nth(1).locator('[data-citation-note-editor]').waitFor();
  assert.equal(await panes.first().locator('[data-citation-note-editor]').count(), 0);
  assert.equal(await panes.nth(1).locator('[data-citation-note-editor]').evaluate(el => el === document.activeElement), true);
  await panes.nth(1).locator('[data-citation-note-editor]').fill('Pane-specific verification note');
  await panes.nth(1).locator('.focused-citation-pane-search').click();
  console.log('PASS independent citation/text/combined copy, official source, print, and note actions');

  await query('INA 237(a)(1), INA 212');
  const initialRail = await rail(0).boundingBox();
  await panes.first().locator('.focused-citation-pane-scroll').evaluate(el => el.scrollTop += 250);
  await settle();
  assert.match(await action(0, 'copy-citation').getAttribute('aria-label'), /1227\(a\)\(1\)$/);
  assert.equal((await rail(0).boundingBox()).y, initialRail.y, 'Actions must stay stationary');
  await panes.first().evaluate(el => {
    const root = el.querySelector('.focused-citation-pane-scroll'), selected = el.querySelector('.statutory-node.target');
    root.scrollTop += selected.getBoundingClientRect().bottom - root.getBoundingClientRect().top - 10;
  });
  await settle();
  assert.match(await action(0, 'copy-citation').getAttribute('aria-label'), /1227\(a\)\(1\)$/, 'Ten visible pixels of the selection still win');
  await panes.first().locator('.focused-citation-pane-scroll').evaluate(el => el.scrollTop += 200);
  await settle();
  const fallback = await action(0, 'copy-citation').getAttribute('aria-label');
  assert.doesNotMatch(fallback, /1227\(a\)\(1\)$/);
  await rail(0).locator('.live-citation-copies > svg').hover();
  assert.equal(await panes.first().locator('.citation-hover-target').count(), 1, 'Bubble header must preview the fallback');
  assert.equal(await panes.nth(1).locator('.citation-hover-target').count(), 0);
  await rail(0).locator('.main-reader-authority').hover();
  assert.equal(await page.locator('.citation-hover-target').count(), 0, 'Switch must never highlight');
  await action(0, 'copy-citation').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), fallback.replace('Copy citation: ', ''));
  assert.equal((await rail(0).boundingBox()).y, initialRail.y);
  console.log('PASS stationary pane actions, partially visible selections, and pane-local fallback previews');

  await query('INA 237(a)(3), 8 USC 1554, 8 CFR 214.2(h)(1)', 3);
  for (let toggle = 0; toggle < 2; toggle++) {
    await rail(0).locator('.main-reader-authority').click();
    const states = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(pane => {
      const button = pane.readerActions.querySelector('.main-reader-authority');
      return { disabled: button.disabled, label: button.querySelector('.statute-authority-cycle-current').textContent };
    }));
    assert.deepEqual(states.map(s => s.disabled), [false, true, true]);
    assert(states.every(s => s.label === states[0].label));
    await rail(2).locator('.main-reader-authority').hover();
    assert.equal(await page.locator('.citation-hover-target').count(), 0);
  }
  await action(1, 'copy-citation').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 U.S.C. 1554');
  await action(2, 'copy-citation').click();
  assert.equal(await page.evaluate(() => qaCopies.at(-1)), '8 CFR 214.2(h)(1)');
  await action(2, 'open').hover();
  assert.equal(await rail(2).locator('.official-source-action-label').innerText(), 'Open in eCFR.gov');
  await page.screenshot({ path: resolve(outputDir, 'mixed-panes.png') });
  console.log('PASS independently disabled switches with a synchronized label across INA, non-INA USC, and CFR');

  await query('INA 237, INA 212');
  const beforeOther = await panes.nth(1).locator('.focused-citation-pane-search').inputValue();
  await panes.first().locator('.focused-citation-pane-search').fill('INA 101');
  await panes.first().locator('.focused-citation-pane-search').press('Enter');
  await settle();
  await rail(0).locator('.main-reader-authority').click();
  const format = await rail(0).locator('.statute-authority-cycle-current').innerText();
  await panes.first().locator('[data-focused-history="back"]').click();
  await settle();
  assert.equal(await panes.first().locator('.focused-citation-pane-search').inputValue(), 'INA 237');
  assert.equal(await panes.nth(1).locator('.focused-citation-pane-search').inputValue(), beforeOther);
  assert.deepEqual(await page.locator('.pane-reader-actions .statute-authority-cycle-current').allTextContents(), [format, format]);
  await panes.first().locator('[data-focused-history="forward"]').click();
  await settle();
  assert.equal(await panes.first().locator('.focused-citation-pane-search').inputValue(), 'INA 101');
  console.log('PASS independent pane history keeps the shared format');

  await page.evaluate(() => INASearchTest.setLegalNavigatorVisibility('all'));
  await settle();
  const navRail = await rail(0).boundingBox();
  await panes.first().locator('.focused-citation-pane-scroll').evaluate(el => el.scrollTop += 1500);
  await settle();
  assert.equal((await rail(0).boundingBox()).y, navRail.y, 'Visible pane navigation must not move the action rail on scroll');
  const paneOffsets = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(pane => {
    const root = pane.scrollRoot.getBoundingClientRect(), line = root.top + root.height * .03;
    const candidates = [...pane.detail.querySelectorAll('.detail-heading-row, .statutory-node > .statutory-line, .statutory-runin-line')];
    const anchor = candidates.filter(el => el.getBoundingClientRect().top <= line + 1).at(-1) || candidates[0];
    pane.qaAnchor = anchor;
    return anchor.getBoundingClientRect().top - line;
  }));
  await rail(0).locator('.main-reader-authority').click();
  await settle();
  const afterOffsets = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(pane => {
    const root = pane.scrollRoot.getBoundingClientRect();
    return pane.qaAnchor.getBoundingClientRect().top - root.top - root.height * .03;
  }));
  assert(afterOffsets.every((value, i) => Math.abs(value - paneOffsets[i]) < 1));
  await page.evaluate(() => INASearchTest.setLegalNavigatorVisibility('single'));
  const promotionFormat = await rail(0).locator('.statute-authority-cycle-current').innerText();
  await panes.nth(1).locator('[data-focused-citation-remove]').click();
  await page.waitForFunction(() => !INASearchTest.getState().focusedCitationMode);
  assert.equal(await page.locator('#mainReaderAuthorityToggle .statute-authority-cycle-current').innerText(), promotionFormat);
  console.log('PASS visible pane navigation and promotion preserve the shared format');

  await page.setViewportSize({ width: 780, height: 600 });
  await query('INA 237, INA 212, 8 USC 1554, 8 CFR 214.2', 4);
  for (const item of await geometry()) assert(item.centered && item.inside && !item.overflow, JSON.stringify(item));
  await action(3, 'open').hover();
  assert(await action(3, 'open').isVisible(), 'Bottom action remains reachable in a short pane');
  await page.screenshot({ path: resolve(outputDir, 'four-short-panes.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 390, height: 918 });
  await query('INA 237, INA 212');
  await settle();
  for (const item of await geometry()) assert(item.centered && item.inside && !item.overflow, JSON.stringify(item));
  await page.screenshot({ path: resolve(outputDir, 'narrow-panes.png') });
  console.log('PASS narrow and short-pane layout with reachable actions');
  assert.deepEqual(session.events.filter(event => event.type === 'pageerror'), []);
} catch (error) {
  console.log(await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(p => ({query:p.query, status:p.status.textContent, head:p.element.querySelector('header').getBoundingClientRect().toJSON(), nav:p.navigator.hidden, rail:p.readerActions.getBoundingClientRect().toJSON(), grid:getComputedStyle(p.element).gridTemplateRows}))));
  await page.screenshot({path:resolve(outputDir,'failure.png')});
  throw error;
} finally { await session.close(); }
