#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const occurrence = require('../src/INASearch-Occurrence');
const command = require('../src/INASearch-Command');
const query = require('../src/INASearch-Query');
const annotations = require('../src/INASearch-Annotations');
const root = path.resolve(__dirname, '..');
const plan = { branches: [{ kind: 'law', scopes: [] }], citationScopes: [] };
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

async function main() {
  // A large occurrence count must not allocate source maps or consult saved
  // annotations until a visible result page actually requests decoration.
  let mappings = 0, highlightReads = 0, noteReads = 0;
  const sandbox = { INA_SEARCH_ANNOTATIONS: annotations, INA_SEARCH_OCCURRENCE: {
    ...occurrence, normalizedTextWithOffsets(text) { mappings++; return occurrence.normalizedTextWithOffsets(text); }
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/INASearch-Query.js'), 'utf8'), sandbox);
  const text = 'alpha — beta '.repeat(5000);
  const fixture = { corpusVersion:'lazy-evidence',inaCrosswalk:[{inaSection:'101',uscSection:'1101',localSection:'1101'}],title8:{sections:[{id:'8-1101',section:'1101',heading:'Fixture',body:[{label:'a',text}]}]},cfr:{sections:[],appendices:[]} };
  const projection = occurrence.buildProjection(fixture);
  const personal = { get highlights() { highlightReads++; return []; }, get notes() { noteReads++; return []; } };
  const result = sandbox.INA_SEARCH_QUERY.search(projection,command.parseCommand('alpha'),{plan,personal});
  assert.equal(result.totalOccurrences,5000);
  assert.equal(mappings,0,'Counting ordinary matches rebuilt source mappings.');
  assert.equal(highlightReads,0,'Ordinary search membership consulted highlights.');
  assert.equal(noteReads,0,'A legal search without has:notes scanned note coverage.');
  for (const start of [0,2495,4999]) {
    const page = result.materializeOccurrences({start,limit:10});
    assert.equal(page.total,5000);
    assert.equal(page.rows.length,Math.min(10,5000-start));
    for (const [index,row] of page.rows.entries()) {
      assert.equal(row.snippet.matchStart,(start+index)*'alpha — beta '.length);
      assert.equal(text.slice(row.snippet.matchStart,row.snippet.matchEnd),'alpha');
    }
  }
  assert.equal(mappings,1,'Visible pages did not reuse their fragment source map.');
  assert(highlightReads>0,'Previews never requested saved highlight decoration.');
  assert.equal(noteReads,0);

  const html = fs.readFileSync(path.join(root,'INASearch.html'),'utf8');
  const packed = JSON.parse(zlib.gunzipSync(Buffer.from(html.match(/<script id="inaSearchCorpusData"[^>]*>([\s\S]*?)<\/script>/)[1],'base64')));
  const corpus = require('../src/INASearch-Corpus-Packing').hydratePackedCorpus(packed);
  const full = occurrence.buildProjection(corpus);
  const law = {...full,fragments:full.fragments.filter(fragment=>(fragment.contentKind||'law')==='law')};
  const inputs = ['president','"good moral character"','alien citizen','common:section alien citizen'];
  const asts = inputs.map(input=>command.parseCommand(input));
  const expected = asts.map(ast => occurrence.search(law, ast).totalOccurrences);
  for (let i=0;i<asts.length;i++)assert.equal(query.search(full,asts[i],{plan}).totalOccurrences,expected[i],inputs[i]);
  const durations = [], baseline = [];
  for(let round=0;round<3;round++) {
    let started = performance.now();
    for(let i=0;i<asts.length;i++)assert.equal(query.search(full,asts[i],{plan}).totalOccurrences,expected[i]);
    durations.push(performance.now()-started);
    started = performance.now();
    for(let i=0;i<asts.length;i++)assert.equal(occurrence.search(law,asts[i]).totalOccurrences,expected[i]);
    baseline.push(performance.now()-started);
  }
  assert(median(durations)<300,`Four structured searches took ${median(durations).toFixed(1)} ms.`);
  assert(median(durations)<median(baseline)*4+30,'The production structured matcher regressed relative to indexed text searching.');
  const asyncResult = await query.searchAsync(full,asts[0],{plan});
  assert.equal(asyncResult.totalOccurrences,expected[0]);
  assert.deepEqual(asyncResult.materializeOccurrences({limit:1000}),query.search(full,asts[0],{plan}).materializeOccurrences({limit:1000}));
  const frequentStarted = performance.now();
  const frequent = query.search(full,command.parseCommand('the'),{plan});
  assert.equal(frequent.totalOccurrences,occurrence.search(law,command.parseCommand("the")).totalOccurrences);
  assert(performance.now()-frequentStarted<300,'High-frequency structured search eagerly materialized too much work.');
  assert.equal(frequent.materializeOccurrences({start:frequent.totalOccurrences-1,limit:1}).rows.length,1);
  const controller = new AbortController();
  const cancelled = query.searchAsync(full,command.parseCommand('the'),{plan,signal:controller.signal,sliceMs:1});
  controller.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError');
  console.log(`PASS structured search performance: four searches ${median(durations).toFixed(1)} ms (indexed baseline ${median(baseline).toFixed(1)} ms); lazy previews, counts, async parity and cancellation`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
