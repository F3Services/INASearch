#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const session = await startInspection({
  url: pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href,
  outputDir: resolve('audits/citation-preference-migration-browser')
});
const { page } = session;
const preference = () => page.evaluate(() => INASearchTest.getProfile().preferences.statutoryLinkCitationSystem);
const saved = () => page.waitForFunction(() => !INASearchTest.getState().profileChanged);
const ready = () => page.waitForFunction(() => !!window.INASearchTest);

async function choosePreference(value) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.locator('#inaCitationLinksToggle').selectOption(value);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await saved();
}

async function navigate(query) {
  await page.locator('#searchInput').fill(query);
  await page.locator('#searchInput').press('Enter');
}

try {
  await ready();
  for (const legacyValue of ['ina', 'usc']) {
    await saved();
    // Seed the raw old browser vault, bypassing current profile normalization.
    await page.evaluate(async value => {
      const state = INASearchTest.getState();
      const profile = structuredClone(INASearchTest.getProfile());
      profile.preferences.statutoryLinkCitationSystem = value;
      delete profile.preferences.statutoryLinkCitationSystemVersion;
      profile.preferences.theme = 'dark';
      await INASearchStorage.saveProfile({
        format: 'INASearchData', schemaVersion: 1,
        vaultId: state.vaultId || 'citation-migration-fixture',
        revision: state.vaultRevision, profile
      }, { expectedRevision: state.cacheRevision });
    }, legacyValue);
    await page.reload();
    await ready();
    assert.equal(await preference(), 'view', `Legacy ${legacyValue} must migrate to Follow View Setting`);
    assert.equal(await page.evaluate(() => INASearchTest.getProfile().preferences.statutoryLinkCitationSystemVersion), 2);
    assert.equal(await page.evaluate(() => INASearchTest.getProfile().preferences.theme), 'dark', 'Unrelated settings must survive');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    assert.equal(await page.locator('#inaCitationLinksToggle').inputValue(), 'view');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    console.log(`PASS legacy ${legacyValue} browser profile migrates to Follow View Setting`);

    for (const choice of ['ina', 'usc', 'view']) {
      await choosePreference(choice);
      await navigate('INA 212(a)');
      await page.locator('#mainReaderAuthorityToggle').click();
      await navigate('8 USC 1101(a)(15)');
      await page.locator('#mainReaderAuthorityToggle').click();
      await page.locator('#mainSearchHistoryBack').click();
      await page.locator('#mainSearchHistoryForward').click();
      await navigate('INA 212(a), INA 237(a)');
      await page.locator('.focused-citation-pane .main-reader-authority').first().click();
      assert.equal(await preference(), choice, 'Navigation must preserve the explicit preference');
      await saved();
      await page.reload();
      await ready();
      assert.equal(await preference(), choice, 'Reload must preserve choices made after migration');
      console.log(`PASS explicit ${choice} survives navigation, format toggles, split panes, and reload`);
    }
  }
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await session.capture('settings-after-migration');
  assert.deepEqual(session.events.filter(event => event.type === 'pageerror' || event.type === 'error'), []);
} finally {
  await session.close();
}
