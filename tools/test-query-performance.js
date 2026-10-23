#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readBuildCorpus } = require('./read-build-corpus');
const { performance } = require('node:perf_hooks');
const occurrence = require('../src/INASearch-Occurrence');
const command = require('../src/INASearch-Command');
const query = require('../src/INASearch-Query');
const annotations = require('../src/INASearch-Annotations');
const root = path.resolve(__dirname, '..');
const plan = { branches: [{ kind: 'law', scopes: [] }], citationScopes: [] };
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

function highlightFixture() {
  let identityReads = 0;
  const corpus = { title8: { sections: Array.from({length:1200}, (_,i) => ({id:`8-${i+1}`,section:String(i+1),heading:'Fixture',body:[{label:'a',text:'The president may act.'}]})) }, cfr:{sections:[],appendices:[]} };
  const projection = occurrence.buildProjection(corpus);
  for (const fragment of projection.fragments) {
    const section = fragment.section;
    Object.defineProperty(fragment, 'section', { get() { identityReads++; return section; } });
  }
  const personal = { highlights: [{id:'saved',color:'pink',segments:[{id:'segment',association:{family:'usc',title:8,start:{unit:'600',path:['a']}},anchor:annotations.quoteAnchor('The president may act.',4,13)}]}] };
  return { projection, personal, reads:()=>identityReads, reset:()=>{identityReads=0;} };
}

async function checkHighlightIndexReuse() {
  const {projection,personal,reads,reset} = highlightFixture();
  const first = query.resolveHighlights(projection,personal);
  assert.equal(first.size,1);
  assert.strictEqual(query.resolveHighlights(projection,personal),first,'Unchanged saved highlights did not reuse resolved coverage.');
  reset();
  personal.highlights[0].color = 'cyan';
  const edited = query.resolveHighlights(projection,personal);
  assert.equal([...edited.values()][0][0].color,'cyan','An in-place edit reused stale coverage.');
  assert(reads()<100,`Editing one saved highlight rescanned ${reads()} fragment identities instead of reusing the projection lookup.`);
  personal.highlights[0].segments[0].anchor.status = 'needs-review';
  assert.equal(query.resolveHighlights(projection,personal).size,0);
  personal.highlights = [];
  assert.equal(query.resolveHighlights(projection,personal).size,0,'Deleting saved highlights retained coverage.');
}

async function checkColdHighlightCancellation() {
  const {projection,personal,reads,reset} = highlightFixture();
  const ast = command.parseCommand('in:highlights president');
  const options = {plan:{branches:[{kind:'law',highlightMode:'presence',scopes:[]}],citationScopes:[]},personal};
  let checks=0;
  await assert.rejects(query.searchAsync(projection,ast,{...options,isCancelled:()=>++checks>=4,sliceMs:1}),error=>error.name==='AbortError');
  assert(reads()<projection.fragments.length/2,'Cancellation was checked only after the entire cold highlight lookup.');
  reset();
  const result = query.search(projection,ast,options);
  assert.equal(result.totalOccurrences,1,'An interrupted lookup published incomplete highlight coverage.');
  assert(reads()>projection.fragments.length/2,'A cancelled projection lookup was published before it was complete.');

  // A timer must get a turn while a cold index is built, rather than after all
  // saved quotes were already resolved on the main thread.
  const fresh = highlightFixture(), controller = new AbortController();
  const cancelled = query.searchAsync(fresh.projection,ast,{...options,personal:fresh.personal,signal:controller.signal,sliceMs:-1});
  setTimeout(()=>controller.abort(),0);
  await assert.rejects(cancelled,error=>error.name==='AbortError');
  assert(fresh.reads()<fresh.projection.fragments.length/2,'Cold highlight indexing did not yield for cancellation.');

  let quoteCalls = 0;
  const sandbox = { INA_SEARCH_OCCURRENCE:occurrence, INA_SEARCH_ANNOTATIONS:{...annotations,resolveQuoteAnchor(...args) { quoteCalls++; return annotations.resolveQuoteAnchor(...args); }} };
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/INASearch-Query.js'),'utf8'),sandbox);
  const quotes = highlightFixture();
  quotes.personal.highlights.push({...quotes.personal.highlights[0],id:'second'});
  await assert.rejects(sandbox.INA_SEARCH_QUERY.searchAsync(quotes.projection,ast,{...options,personal:quotes.personal,isCancelled:()=>quoteCalls>=1}),error=>error.name==='AbortError');
  assert.equal(quoteCalls,1,'Cancellation waited for all saved quotes to resolve.');
  const retried = sandbox.INA_SEARCH_QUERY.resolveHighlights(quotes.projection,quotes.personal);
  assert.equal([...retried.values()][0].length,2,'Cancellation published partial quote coverage.');
  assert.equal(quoteCalls,3,'Retry reused a partially resolved highlight cache.');
}

async function checkHighlightInputSnapshot() {
  const originalRange = ['8-600',4,13,'pink','saved','segment','president'];
  const cases = [
    {name:'recolor',edit:personal=>{personal.highlights[0].color='cyan';},updated:[[...originalRange.slice(0,3),'cyan',...originalRange.slice(4)]]},
    {name:'nested anchor edit',edit:personal=>{personal.highlights[0].segments[0].anchor.status='needs-review';},updated:[]},
    {name:'nested association edit',edit:personal=>{personal.highlights[0].segments[0].association.start.unit='601';},updated:[['8-601',...originalRange.slice(1)]]},
    {name:'segment append',edit:personal=>{personal.highlights[0].segments.push({...structuredClone(personal.highlights[0].segments[0]),id:'added',anchor:annotations.quoteAnchor('The president may act.',14,17)});},updated:[originalRange,['8-600',14,17,'pink','saved','added','may']]},
    {name:'highlight removal',prepare:personal=>{const second=structuredClone(personal.highlights[0]);second.id='second';second.segments[0].association.start.unit='601';personal.highlights.push(second);},edit:personal=>{personal.highlights.pop();},before:[originalRange,['8-601',4,13,'pink','second','segment','president']],updated:[originalRange]}
  ];
  const failures = [];
  for (const scenario of cases) {
    const {projection,personal} = highlightFixture();
    scenario.prepare?.(personal);
    const original = structuredClone(personal), expected = scenario.before || [originalRange];
    const fragmentById = new Map(projection.fragments.map(fragment=>[fragment.id,fragment]));
    const values = coverage => [...coverage].flatMap(([id,ranges])=>ranges.map(range=>[fragmentById.get(id).recordId,range.start,range.end,range.color,range.id,range.segmentId,range.selectedText]));
    const ast = command.parseCommand('in:highlights-exact president');
    const options = {plan:{branches:[{kind:'law',highlightMode:'exact',scopes:[]}],citationScopes:[]},personal,sliceMs:-1};
    // The first call returns at the resolver's first yield. These are the same
    // live nested profile objects supplied by the main-thread fallback.
    const pending = query.searchAsync(projection,ast,options);
    scenario.edit(personal);
    const result = await pending;
    try {
      assert.deepEqual(values(query.resolveHighlights(projection,original)),expected,`${scenario.name}: an in-flight edit polluted the original coverage cache key`);
      assert.deepEqual(values(query.resolveHighlights(projection,personal)),scenario.updated,`${scenario.name}: updated input did not get its own coverage`);
      assert.deepEqual(values(query.resolveHighlights(projection,original)),expected,`${scenario.name}: original input did not remain recoverable after updated input`);
      const synchronous = query.search(projection,ast,{...options,personal:original}).materializeOccurrences({limit:10});
      assert.deepEqual(result.materializeOccurrences({limit:10}),synchronous,`${scenario.name}: async search mixed input versions`);
      const owned = await query.searchAsync(projection,ast,{...options,personal:structuredClone(original)});
      assert.deepEqual(owned.materializeOccurrences({limit:10}),synchronous,`${scenario.name}: owned request and live-profile fallback differ`);
    } catch (error) { failures.push(error.message.split('\n')[0]); }
  }
  assert.deepEqual(failures,[]);
}

async function main() {
  const checks = await Promise.allSettled([checkHighlightIndexReuse(),checkColdHighlightCancellation(),checkHighlightInputSnapshot()]);
  assert.deepEqual(checks.filter(check=>check.status==='rejected').map(check=>check.reason.message),[]);
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

  const corpus = readBuildCorpus(path.join(root,'INASearch.html'));
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
  const frequentQueryDuration = performance.now() - frequentStarted;
  assert.equal(frequent.totalOccurrences,occurrence.search(law,command.parseCommand("the")).totalOccurrences);
  const frequentTotalDuration = performance.now() - frequentStarted;
  assert(frequentTotalDuration<300,`High-frequency structured search and parity check took ${frequentTotalDuration.toFixed(1)} ms (structured query ${frequentQueryDuration.toFixed(1)} ms).`);
  assert.equal(frequent.materializeOccurrences({start:frequent.totalOccurrences-1,limit:1}).rows.length,1);
  const controller = new AbortController();
  const cancelled = query.searchAsync(full,command.parseCommand('the'),{plan,signal:controller.signal,sliceMs:1});
  controller.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError');
  console.log(`PASS structured search performance: four searches ${median(durations).toFixed(1)} ms (indexed baseline ${median(baseline).toFixed(1)} ms); lazy previews, counts, async parity and cancellation`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
