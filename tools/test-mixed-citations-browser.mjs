#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createParser} = require('./test-mixed-citations');
const {startInspection} = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const outputDir = resolve('tmp/mixed-citations/browser');
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const session = await startInspection({url, outputDir});
const page = session.page;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = {navigation: [], filters: [], corpus: {usc: 0, ina: 0, cfr: 0}};

async function navigation(query, label, path) {
  await page.locator('#searchInput').fill(query);
  await page.waitForFunction(label => INASearchTest.getState().citation?.valid && INASearchTest.getState().citation.label === label, label);
  await page.waitForFunction(path => {
    if (!path.length) return !!document.querySelector('#detailPanel [data-statute-start], #detailPanel [data-cfr-start]');
    const target = document.querySelector('#detailPanel [aria-label="Citation target"]');
    return target && ((target.dataset.statuteInlinePath || target.dataset.statutePath) === JSON.stringify(path) || target.dataset.cfrPath === path.map(token => `(${token})`).join(''));
  }, path);
  report.navigation.push({query, label, path});
}
async function search(query) {
  console.log(`Checking search: ${query}`);
  await page.locator('#searchInput').fill(query);
  await page.locator('#searchInput').press('Enter');
  await page.waitForSelector('.occurrence-search-summary');
  await page.waitForFunction(query => INASearchTest.getState().query === query && !INASearchTest.getState().occurrenceSearchPending, query);
  return page.locator('.occurrence-search-summary').innerText();
}
try {
  await page.setViewportSize({width: 1440, height: 1000});
  await page.waitForFunction(() => !!window.INASearchTest && !document.querySelector('.boot-workspace'));
  await page.evaluate(() => INASearchTest.setAnimatedCitationJumps(false));
  await navigation('274a', 'INA 274A', []);
  await navigation('274(a)', 'INA 274(a)', ['a']);
  for (const tail of ['a2b', '(a)2b', '(a)2(B)', '(a)(2)b', 'a(2)b']) {
    await navigation(`274${tail}`, 'INA 274(a)(2)(B)', ['a','2','B']);
    await navigation(`INA274${tail}`, 'INA 274(a)(2)(B)', ['a','2','B']);
    await navigation(`8 U.S.C.1324${tail}`, '8 U.S.C. 1324(a)(2)(B)', ['a','2','B']);
  }
  await navigation('8 CFR214.2(h)2iA', '8 CFR 214.2(h)(2)(i)(A)', ['h','2','i','A']);
  await navigation('214.2h(2)iA', '8 CFR 214.2(h)(2)(i)(A)', ['h','2','i','A']);
  await navigation('INA101(a)15hii', 'INA 101(a)(15)(H)(ii)', ['a','15','H','ii']);
  assert.match(await page.locator('#detailPanel [aria-label="Citation target"]').innerText(), /perform agricultural labor/);

  // Slow typing crosses both the lettered-section boundary and unfinished units.
  await page.locator('#searchInput').fill('');
  await page.locator('#searchInput').pressSequentially('274(a)2b', {delay: 90});
  await navigation('274(a)2b', 'INA 274(a)(2)(B)', ['a','2','B']);
  for (const query of ['274(a)2(', '274(a2)b', '274(a)99z', '274((a))2b']) {
    await page.locator('#searchInput').fill(query);
    await page.locator('#searchInput').press('Enter');
    const state = await page.evaluate(() => ({citation: INASearchTest.getState().citation, classification: INASearchTest.getState().pendingCommandClassification?.mode, view: INASearchTest.getState().view}));
    assert(!state.citation?.valid, `${query} navigated to a valid unit`);
    assert.equal(state.classification, 'navigation-prefix', `${query} became an ordinary search`);
  }
  await navigation('Ina 101(a)15(o)iii', 'INA 101(a)(15)(O)(iii)', ['a','15','O','iii']);
  await page.getByRole('button', {name: 'INA 101(a)(15)(O)(ii)(I)', exact: true}).click();
  assert.equal(await page.locator('#searchInput').inputValue(), 'Ina 101(a)15(o)iiI');
  await navigation('Ina 101(a)15(o)iiI', 'INA 101(a)(15)(O)(ii)(I)', ['a','15','O','ii','I']);
  await navigation('8 USC1101(a)27(c)iii', '8 U.S.C. 1101(a)(27)(C)(iii)', ['a','27','C','iii']);
  await page.getByRole('button', {name: '8 U.S.C. 1101(a)(27)(C)(ii)(I)', exact: true}).click();
  assert.equal(await page.locator('#searchInput').inputValue(), '8 USC1101(a)27(c)iiI');
  await navigation('8 USC1101(a)27(c)iiI', '8 U.S.C. 1101(a)(27)(C)(ii)(I)', ['a','27','C','ii','I']);

  for (const [mixed, canonical] of [
    ['in:274(a)2b years', 'in:INA274(a)(2)(B) years'],
    ['in:8 CFR214.2(h)2iA petition', 'in:8 CFR214.2(h)(2)(i)(A) petition'],
    ['cites:INA212(a)9b', 'cites:INA212(a)(9)(B)'],
    ['in:274(a)2(A)–(a)2b years', 'in:INA274(a)(2)(A)–INA274(a)(2)(B) years'],
    ['in:274(a)2b,274(a)2(A) years', 'in:INA274(a)(2)(B),INA274(a)(2)(A) years'],
    ['in:274(a)2b (years imprisonment)', 'in:INA274(a)(2)(B) (years imprisonment)']
  ]) {
    const expected = await search(canonical), actual = await search(mixed);
    assert.equal(actual, expected, mixed);
    assert.match(actual, /^[1-9]\d* hits? in /, `${mixed} needs actual results to verify the locator`);
    report.filters.push({mixed, expected});
  }
  await page.locator('#searchInput').fill('INA274(a)2b, 8 CFR214.2(h)2iA');
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => INASearchTest.getState().focusedCitationPanes.length === 2);
  const panes = page.locator('.focused-citation-pane');
  const panePaths = await page.evaluate(() => INASearchTest.getState().focusedCitationPanes.map(pane => pane.entry.result.path));
  assert.deepEqual(panePaths, [['a','2','B'], ['h','2','i','A']]);
  await panes.first().locator('.focused-citation-pane-search').fill('INA274(a)1(A)i');
  await panes.first().locator('.focused-citation-pane-search').press('Enter');
  await page.waitForFunction(() => INASearchTest.getState().focusedCitationPanes[0].entry.result?.label === 'INA 274(a)(1)(A)(i)');
  await session.capture('mixed-comparison');

  // Exercise the complete production parser as well as the path-index unit audit.
  // Keep the first unit explicit to preserve the section-prefix precedence rule.
  const {api, corpus} = createParser();
  const cases = [];
  for (const section of corpus.title8.sections) for (const candidates of api.compactStatutePathIndex('usc', section.section, section).values()) for (const candidate of candidates) {
    const parts = candidate.inputParts;
    const tail = `(${parts[0]})${parts.slice(1).join('')}`;
    cases.push({query: `8 USC${section.section}${tail}`, path: candidate.path, id: section.id, kind: 'usc'});
    const row = corpus.inaCrosswalk.find(row => row.hasEquivalent && !row.isNote && (row.localSection || row.uscSection) === section.section);
    if (row) cases.push({query: `INA${row.inaSection}${tail}`, path: candidate.path, id: section.id, kind: 'ina'});
  }
  for (const section of corpus.cfr.sections) for (const candidates of require('../src/INASearch-CFR-Hierarchy').index(section).byCompact.values()) for (const candidate of candidates) {
    cases.push({query: `${section.title} CFR${section.section}(${candidate.path[0]})${candidate.path.slice(1).join('')}`, path: candidate.path, id: section.id, kind: 'cfr'});
  }
  for (let offset = 0; offset < cases.length; offset += 1000) {
    const result = await page.evaluate(cases => {
      const counts = {usc: 0, ina: 0, cfr: 0}, failures = [];
      for (const item of cases) {
        const result = INASearchTest.parseCitation(item.query);
        const paths = [result?.path, ...(result?.ambiguity?.options || []).map(option => option.path)];
        if (!result?.valid || result.record?.item?.id !== item.id || !paths.some(path => JSON.stringify(path) === JSON.stringify(item.path))) failures.push({item, label: result?.label, path: result?.path, message: result?.message});
        counts[item.kind]++;
      }
      return {counts, failures};
    }, cases.slice(offset, offset + 1000));
    assert.deepEqual(result.failures, [], 'Production corpus parser lost mixed paths');
    for (const kind of ['usc', 'ina', 'cfr']) report.corpus[kind] += result.counts[kind];
  }
  await navigation('274(a)2b', 'INA 274(a)(2)(B)', ['a','2','B']);
  await session.capture('mixed-citation');
  await page.screenshot({path: resolve(outputDir, 'mixed-citation-viewport.png'), fullPage: false});
  assert.deepEqual(errors, []);
  fs.writeFileSync(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS mixed browser: ${report.navigation.length} navigation cases, typing, invalid input, ambiguity, panes, ${report.filters.length} filters/ranges; production parser ${JSON.stringify(report.corpus)}`);
} catch (error) {
  await session.capture('failure');
  fs.writeFileSync(resolve(outputDir, 'failure-state.txt'), await page.locator('body').innerText());
  throw error;
} finally {
  await session.close();
}
