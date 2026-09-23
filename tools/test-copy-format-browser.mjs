#!/usr/bin/env node
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { startInspection } = await import(pathToFileURL(resolve(homedir(), '.codex/tools/browser-inspection/session.mjs')));
const url = pathToFileURL(resolve(process.argv[2] || 'INASearch.html')).href;
const session = await startInspection({url, outputDir:resolve('audits/shared-copy-format/browser')});
const page = session.page;
await page.addInitScript(() => {
  window.qaCopies = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => qaCopies.push(text) } });
});
const settle = () => page.evaluate(async () => {for(let i=0;i<3;i++) await new Promise(requestAnimationFrame);});
async function query(q) {
  await page.evaluate(q => { INASearchTest.applySearchQuery(q, false, true); document.activeElement?.blur(); },q);
  await settle();
}
async function swap(authority, button = page.locator('#mainReaderAuthorityToggle')) {
  if (await page.evaluate(() => INASearchTest.getState().statuteHierarchyAuthority) !== authority) await button.click();
  await settle();
}
const copied = () => page.evaluate(() => qaCopies.at(-1));
const rendered = () => page.locator('#detailPanel .node-text, #detailPanel .node-heading, #detailPanel .statute-preamble, #detailPanel .cfr-block').evaluateAll(es=>es.map(e=>e.innerText).join('\n'));
async function readExpected() {
  return page.evaluate(() => {
    const api=INASearchTest, t=api.mainReaderActionTarget();
    const c=api.legalUnitContextForLocation(t.kind,t.sectionId,t.path,t.query,null,t.occurrenceBlockPath);
    return {source:c.text, text:api.legalUnitCopyText(c), combined:api.citationWithLegalText(c), citation:c.citation};
  });
}
try {
  await page.goto(`${url}?q=8cfr1245.1`);
  await page.waitForFunction(() => window.INASearchTest?.getState().selected);
  await page.evaluate(() => {
    INASearchTest.setAnimatedCitationJumps(false);
    INASearchTest.getProfile().preferences.backupReminder='disabled';
    INASearchTest.getProfile().preferences.highlightInaCitationLinks=true;
  });
  // Explicit source and INA expectations, independent of clipboard wiring.
  const fixtures=[['8 CFR 1245.1', /section 245 of the Act/, /INA 245/], ['29 CFR 501.6', /8 U\.S\.C\. 1188/, /INA 218/], ['22 CFR 41.12', /INA 101/, /INA 101/], ['22 CFR 42.11', /101\(b\)\(1\) of the INA/, /INA 101\(b\)\(1\)/], ['8 USC 1227', /section 1182/, /INA 212/]];
  for (const [q,sourcePattern,inaPattern] of fixtures) {
    await query(q);
    const texts=await page.evaluate(() => {
      const a=INASearchTest, s=a.getState().selected.item, c=s.title ? 'cfr' : 'usc';
      return {source:c==='cfr'?a.cfrUnitText(s):a.statuteUnitText(s), ina:c==='cfr'?a.cfrUnitText(s,[],null,'ina'):a.statuteUnitText(s,[],'ina')};
    });
    assert.match(texts.source,sourcePattern,q+' source fixture');
    assert.match(texts.ina,inaPattern,q+' INA fixture');
    let sourceView,inaView,destinations;
    for (const pref of ['usc','ina','view']) {
      await page.evaluate(pref=>INASearchTest.setStatutoryLinkCitationSystem(pref),pref);
      for (const authority of ['usc','ina']) {
        await swap(authority);
        const visible=await rendered();
        const displayIna=pref==='ina'||(pref==='view'&&authority==='ina');
        if (displayIna) {if(inaView!==undefined) assert.equal(visible,inaView,q+' INA display');inaView=visible;}
        else {if(sourceView!==undefined) assert.equal(visible,sourceView,q+' source display');sourceView=visible;}
        const refs=await page.locator('#detailPanel [data-legal-reference]').evaluateAll(es=>es.map(e=>[e.dataset.referenceFamily,e.dataset.referenceTitle,e.dataset.referenceSection,e.dataset.referencePath,e.dataset.referenceUrl]));
        if(destinations) assert.deepEqual(refs,destinations,q+' destinations changed'); else destinations=refs;
        const full=await page.evaluate(()=>{const a=INASearchTest,s=a.getState().selected.item;return a.legalUnitCopyText({kind:s.title?'cfr':'usc',section:s,path:[],text:s.title?a.cfrUnitText(s):a.statuteUnitText(s)});});
        assert.equal(full,authority==='ina'?texts.ina:texts.source,q+' copy ignores display');
        const expected=await readExpected();
        await page.locator('#mainReaderActions [data-live-citation-action="copy-text"]').click();
        assert.equal(await copied(),expected.text,q+' main copy');
        await page.locator('#mainReaderActions [data-live-citation-action="copy-citation-text"]').click();
        assert.equal(await copied(),expected.combined,q+' citation plus text');
        assert.match(expected.combined,/ states the following -\n\n/);
        const label=await page.locator('#mainReaderAuthorityToggle .statute-authority-cycle-current').innerText();
        assert.equal(label,authority==='ina'?'INA':q.includes('CFR')?'CFR':'USC');
        const native=page.locator('#detailPanel [data-reference-family="ina"]');
        assert(await native.evaluateAll(es=>es.filter(e=>/^INA\b/.test(e.dataset.referenceSourceText)).every(e=>!e.classList.contains('citation-display-ina'))));
        const yellow=await page.locator('#detailPanel .citation-display-ina').count();
        assert.equal(yellow>0, displayIna,q+' yellow only on altered wording: '+JSON.stringify(await page.locator('#detailPanel .citation-display-ina').evaluateAll(es=>es.map(e=>[e.textContent,e.dataset.referenceSourceText]))));
      }
    }
    console.log(`PASS six display/copy combinations, link destinations, labels and highlighting: ${q}`);
  }
  const structures=await page.evaluate(()=>{
    const a=INASearchTest;
    const results=[];
    for(const number of ['1101','1154','1158','1182','1183a','1184','1186a','1187']) {
      const s=a.parseCitation('8 USC '+number).record.item;
      const source=a.statuteUnitText(s), ina=a.statuteUnitText(s,[],'ina');
      const markers=text=>text.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g)||[];
      results.push({number,source:markers(source),ina:markers(ina),sourceLines:source.split('\n').length,inaLines:ina.split('\n').length});
    }
    for(const number of ['41.12','42.11']) {
      const s=a.parseCitation('22 CFR '+number).record.item;
      const source=a.cfrUnitText(s), ina=a.cfrUnitText(s,[],null,'ina');
      results.push({number,source:source.split('\n').map(l=>(l.match(/\t/g)||[]).length),ina:ina.split('\n').map(l=>(l.match(/\t/g)||[]).length)});
    }
    return results;
  });
  for(const row of structures) {assert.deepEqual(row.ina,row.source,row.number+' markers/table layout');if(row.sourceLines) assert.equal(row.sourceLines,row.inaLines);}
  console.log('PASS statutory footnotes, paragraph boundaries and CFR table structure');
  // Citation menu keeps source target but reads the switch when clicked.
  await query('8 CFR 1245.1(a)');
  await page.evaluate(()=>INASearchTest.setStatutoryLinkCitationSystem('ina'));
  for(const authority of ['usc','ina']) {
    await swap(authority);
    await page.locator(`#detailPanel [data-legal-unit-kind="cfr"][data-legal-unit-path='["a"]']`).first().click();
    const expect=await page.evaluate(()=>INASearchTest.legalUnitCopyText(INASearchTest.getState().legalUnitContext));
    await page.locator('#copyLegalUnitTextButton').click(); assert.equal(await copied(),expect);
  }
  console.log('PASS citation menu text copies use shared state under Always');
  // Reference-preview and inserted-card copying, including a switch after insertion.
  await query('8 CFR 1245.1(a)');
  const ref=page.locator(`#detailPanel [data-reference-section="1255"][data-reference-path='["a"]']`).first();
  for(const authority of ['usc','ina']) {
    await swap(authority); await ref.hover(); await page.locator("#copyLegalReferenceTextButton").waitFor({state:"visible"});
    const expect=await page.evaluate(()=>INASearchTest.legalUnitCopyText(INASearchTest.getState().legalReferenceContext));
    await page.locator('#copyLegalReferenceTextButton').click(); assert.equal(await copied(),expect);
    await page.keyboard.press('Escape');
  }
  await ref.hover(); await page.locator('#insertLegalReferenceButton').click();
  const insertCopy=page.locator('[data-inserted-copy-text]').first(); await insertCopy.waitFor();
  for(const authority of ['usc','ina']) {
    await swap(authority);
    const expect=await page.evaluate(()=>{const a=INASearchTest,s=a.parseCitation('8 USC 1255').record.item; return a.getState().statuteHierarchyAuthority==='ina'?a.statuteUnitText(s,['a'],'ina'):a.statuteUnitText(s,['a']);});
    await insertCopy.click(); assert.equal(await copied(),expect);
  }
  console.log('PASS reference preview and inserted excerpt copy; switch evaluated after insertion');
  await query('8 CFR 1245.1(a), INA 237(a)(3)');
  const panes=page.locator('.focused-citation-pane'); await panes.nth(1).waitFor();
  const toggle=panes.first().locator('.main-reader-authority');
  await swap('usc',toggle);
  assert.deepEqual(await panes.locator('.statute-authority-cycle-current').allTextContents(),['CFR','USC']);
  for(const authority of ['usc','ina']) {
    await swap(authority,toggle);
    for(let i=0;i<2;i++) {
      await panes.nth(i).locator('[data-live-citation-action="copy-text"]').click();
      const text=await copied(); assert(text.length>60);
      if(i===0) assert.match(text,authority==='ina'?/INA 245/:/section 245\(a\) of the Act/);
    }
  }
  console.log('PASS mixed panes share INA state and contextual CFR/USC labels');
  await page.evaluate(()=>INASearchTest.setStatutoryLinkCitationSystem('usc'));
  await swap('ina',toggle);
  await page.waitForFunction(()=>!INASearchTest.getState().profileChanged);
  await page.screenshot({path:resolve('audits/shared-copy-format/browser/mixed-panes.png')});
  await page.reload(); await page.waitForFunction(()=>window.INASearchTest?.getState().selected);
  assert.equal(await page.evaluate(()=>INASearchTest.getProfile().preferences.statutoryLinkCitationSystem),'usc');
  assert.equal(await page.evaluate(()=>INASearchTest.getState().statuteHierarchyAuthority),'ina');
  console.log('PASS saved display preference and shared state survive reload');
  await query('in:8cfr1245.1 immigrant');
  await page.locator('[data-occurrence-copy="text"]').first().waitFor();
  for(const authority of ['usc','ina']) {
    await swap(authority);
    assert.equal(await page.locator('#mainReaderAuthorityToggle .statute-authority-cycle-current').innerText(),authority==='ina'?'INA':'CFR');
    const expected=await page.evaluate(()=>{
      const a=INASearchTest,p=a.getState().mainOccurrencePane;
      const button=document.querySelector('[data-occurrence-copy="text"]'),el=button.closest('[data-occurrence-row]');
      const row=p.searchState.rowsBySection.get(decodeURIComponent(el.dataset.occurrenceRowSection)).rows[Number(el.dataset.occurrenceRow)];
      return a.occurrenceRowUnitText(row,a.getState().statuteHierarchyAuthority);
    });
    await page.locator('[data-occurrence-copy="text"]').first().click(); assert.equal(await copied(),expected);
  }
  console.log('PASS scoped CFR search copies and contextual source label');
  assert.deepEqual(session.events.filter(event=>event.type==='pageerror'),[]);

} finally {await session.close();}
