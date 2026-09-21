#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const command = require('../src/INASearch-Command');
const occurrence = require('../src/INASearch-Occurrence');
const query = require('../src/INASearch-Query');
const annotations = require('../src/INASearch-Annotations');
const ref = text => ({ family: 'usc', targetTitle: '8', targetSection: '1182', targetPath: ['a'], start: text.indexOf('212'), end: text.indexOf('212') + 3, resolution: 'local' });
const a = 'The president may waive 212 restrictions.';
const b = 'The president applies another rule.';
const corpus = {
  corpusVersion: 'scopes-fixture', title8: { sections: [
    { id:'8-1227', section:'1227', heading:'Source', body:[{label:'a',children:[{label:'1',text:a,references:[ref(a)]},{label:'2',text:b}]}], sourceCredit:'Creditneedle', notes:[{heading:'Editorial note',text:'Editorialneedle'}], houseEditorialFootnotes:[{id:'f1',text:'Footnoteneedle'}]},
    { id:'8-1182', section:'1182', heading:'Target', body:[{label:'a',text:'Target'}] }
  ] },
  inaCrosswalk:[{inaSection:'237',uscSection:'1227',localSection:'1227'},{inaSection:'212',uscSection:'1182',localSection:'1182'}],
  cfr:{parts:[],sections:[{id:'8:1.1',title:8,section:'1.1',heading:'Regulation',blocks:[{t:'p',a:'(a)',x:a,xReferences:[ref(a)]},{t:'note',noteType:'editorial',blocks:[{t:'p',x:'Cfreditorialneedle'}]},{t:'footnote',x:'Ordinaryfootneedle'}]}],appendices:[]}
};
const projection = occurrence.buildProjection(corpus);
// Search positions stay in the normalized index until a visible row needs a
// source offset. Count Unicode compatibility characters as source occurrences.
const unicodeText = '— Café,  oﬃce  ½ 𐐀 president; PRESIDENT.';
const unicodeCorpus = structuredClone(corpus);
unicodeCorpus.title8.sections[0].body = [{label:'a',text:unicodeText}];
const unicodeProjection = occurrence.buildProjection(unicodeCorpus);
for (const [input, expected] of [['cafe',['Café']],['f',['f','ﬃ']],['"1 2"',['½']],['president',['president','PRESIDENT']],['𐐀',['𐐀']]]) {
  const ast = command.parseCommand(input);
  const result = query.search(unicodeProjection, ast, {plan:{branches:[{kind:'law',scopes:[{valid:true,family:'usc',sectionIds:new Set(['8-1227']),pathsBySection:new Map()}]}],citationScopes:[]}});
  assert.equal(result.totalOccurrences,expected.length,input);
  assert.deepEqual(result.materializeOccurrences({limit:100}).rows.map(row=>unicodeText.slice(row.snippet.matchStart,row.snippet.matchEnd)),expected,input);
}
function scope(raw) {
  const str=raw.replace(/\s+/g,'').toLowerCase();
  if(str==='ina') return {valid:true,family:'usc',sectionIds:new Set(['8-1227','8-1182']),pathsBySection:new Map()};
  if(['cfr','8cfr'].includes(str)) return {valid:true,family:'cfr',sectionIds:new Set(['8:1.1']),pathsBySection:new Map()};
  const section=str.replace(/^(ina|8usc)/,'').match(/^\d+/)?.[0];
  const id=['237','1227'].includes(section)?'8-1227':'8-1182';
  return {valid:true,family:'usc',sectionIds:new Set([id]),pathsBySection:new Map([[id,[...str.matchAll(/\(([^)]+)\)/g)].map(x=>x[1])]])};
}
function run(text, personal={}) {
  const ast=command.parseCommand(text);assert.equal(ast.status,'valid',JSON.stringify(ast.errors));
  const plan={branches:ast.branches.map(branch=>({...branch,scopes:branch.locations.map(scope)})),citationScopes:ast.citationGroups.map(g=>g.map(scope))};
  return query.search(projection,ast,{plan,personal});
}
function rows(result){return result.materializeOccurrences({limit:1000}).rows;}
for(const input of ['in:237 cites:212','cites:212 in:237','in:237  cites:212','in: INA 237 cites: INA 212']) {
  const result=run(input);assert.equal(result.totalOccurrences,1,input);assert.equal(rows(result)[0].recordId,'8-1227');assert.deepEqual(rows(result)[0].path,['a','1']);
}
assert.equal(run('in:237(a)(2) cites:212').totalOccurrences,0);
assert.equal(run('in:8cfr cites:212 president').totalOccurrences,1,'CFR body evidence must participate');
assert.equal(run('in:237 cites:212 another').totalOccurrences,0);
assert.equal(run('in:237 cites:212 another common:section').totalOccurrences,1);
assert.equal(run('in:237(a)(1) cites:212 another common:section').totalOccurrences,0,'Common must not expand source scope');
for(const needle of ['Creditneedle','Editorialneedle','Footnoteneedle','Cfreditorialneedle']) {assert.equal(run(needle).totalOccurrences,0);assert.equal(run(`in:annotations ${needle}`).totalOccurrences,needle==='Editorialneedle'?2:1);}
assert.equal(run('Ordinaryfootneedle').totalOccurrences,1);
const association={family:'usc',title:8,start:{unit:'1227',path:['a','1']}};
const anchor=annotations.quoteAnchor(a,a.indexOf('waive'),a.indexOf('waive')+5,{path:['a','1']});
const personal={highlights:[{id:'h1',color:'pink',segments:[{id:'s1',association,anchor}]}]};
assert.equal(run('in:237 president').totalOccurrences,2);
assert.equal(run('in:237 president',personal).totalOccurrences,2,'Highlight must not alter default counts');
assert.equal(run('in:237 in:highlights president',personal).totalOccurrences,1);
assert.equal(run('in:237 in:highlights another',personal).totalOccurrences,0,'Sibling highlight must not qualify');
assert.equal(run('in:237 in:highlights another common:section',personal).totalOccurrences,1);
assert.equal(run('in:237(a)(2) in:highlights another common:section',personal).totalOccurrences,0);
assert.equal(run('in:highlights-exact president',personal).totalOccurrences,0);
assert.equal(run('in:highlights-exact waive',personal).totalOccurrences,1);
assert.equal(rows(run('in:highlights-exact waive',personal))[0].snippet.parts.map(p=>p.text).join(''),'waive');
const doubled={highlights:[...personal.highlights,{...personal.highlights[0],id:'h2'}]};
assert.equal(run('in:highlights-exact waive',doubled).totalOccurrences,1,'Overlapping selections cannot duplicate hits');
assert.equal(run('in:highlights president',{highlights:[{...personal.highlights[0],segments:[{id:'s',association,anchor:{...anchor,status:'needs-review'}}]}]}).totalOccurrences,0);
assert.equal(run('in:237 cites:212 has:notes').totalOccurrences,0);
assert.equal(run('in:237 cites:212 has:notes',{notes:[{associations:[association]}]}).totalOccurrences,1);
const preview=rows(run('in:237 waive',personal))[0].snippets[0].parts;
assert(preview.some(part=>part.highlightColor==='pink'&&part.match));
assert.deepEqual(command.parseCommand('in:notes in:8 CFR president').branches,[{kind:'notes',locations:['8 CFR'],highlightMode:null}]);
assert.equal(command.parseCommand('is:notes').status,'invalid');
assert.equal(command.migrateQuery('is:highlights',1),'in:highlights-exact');
assert.equal(command.migrateQuery('in:highlights president',1),'in:highlights-exact president');
assert.equal(command.migrateQuery('in:highlights president',2),'in:highlights president');
assert.equal(command.migrateQuery('"in:highlights"',1),'"in:highlights"');
assert.equal(command.classifyInput('in:237(a)(1),212 cites:212').mode,'search');
assert.equal(command.scanCommandSegments('in:237(a)(1),212 cites:212').segments.length,1);
// Selected intervals may combine terms, but phrases cannot bridge unselected words.
const select = (text, start, end, id) => ({id,color:'cyan',segments:[{id,association,anchor:annotations.quoteAnchor(text,start,end)}]});
const disjoint={highlights:[select(a,4,13,'president'),select(a,18,23,'waive')]};
assert.equal(run('in:highlights-exact "president may waive"',disjoint).totalOccurrences,0);
assert.equal(run('in:highlights-exact president waive',disjoint).totalOccurrences,2);
assert.equal(run('in:highlights-exact president another',disjoint).totalOccurrences,0);
assert.equal(command.migrateQuery('is: highlights',1),'in:highlights-exact');
assert.equal(command.migrateQuery('in: highlights president',1),'in:highlights-exact president');
assert.equal(run('in:237 president president').totalOccurrences,2,'Repeated clauses share the same textual evidence');
for (const input of ['in:ina in:notes president','in:notes in:ina president']) assert.deepEqual(command.parseCommand(input).branches,[{kind:'notes',locations:['ina'],highlightMode:null}]);
const range={valid:true,family:'usc',sectionIds:new Set(['8-1227']),pathsBySection:new Map(),pathAlternativesBySection:new Map([['8-1227',[['a','1']]]])};
assert(query.scopeMatches(projection.fragments.find(f=>f.text===a),range));
assert(!query.scopeMatches(projection.fragments.find(f=>f.text===b),range));
assert.equal(query.intersectScopePaths([range,{...range,pathAlternativesBySection:new Map([['8-1227',[['a','2']]]])}],'8-1227').length,0);
const compoundCorpus=structuredClone(corpus);
const compound='(a) The president issues orders. (b) The president signs laws.';
compoundCorpus.cfr.sections[0].blocks=[{t:'p',x:compound,u:[{a:'(a)',s:0},{a:'(b)',s:compound.indexOf('(b)')}]}];
const compoundProjection=occurrence.buildProjection(compoundCorpus);
const compoundAst=command.parseCommand('in:8cfr in:highlights president');
const compoundPersonal={highlights:[{id:'compound',segments:[{id:'s',association:{family:'cfr',title:8,start:{unit:'1.1',path:['a']}},anchor:annotations.quoteAnchor(compound,compound.lastIndexOf('president'),compound.lastIndexOf('president')+9)}]}]};
const compoundResult=query.search(compoundProjection,compoundAst,{personal:compoundPersonal,plan:{branches:[{kind:'law',highlightMode:'presence',scopes:[scope('8cfr')]}],citationScopes:[]}});
assert.equal(compoundResult.totalOccurrences,1,'A shared rendered CFR host cannot qualify an unrelated sibling');
assert.deepEqual(rows(compoundResult)[0].path,['b']);
const inlineProjection={...projection,fragments:projection.fragments.map(f=>({...f,source:{...f.source,path:['a']}}))};
assert.equal(query.resolveHighlights(inlineProjection,personal).size,1,'A run-in must resolve by its legal path, not only its parent source record path');
(async()=>{const ast=command.parseCommand('in:237 cites:212');const options={plan:{branches:ast.branches.map(b=>({...b,scopes:b.locations.map(scope)})),citationScopes:ast.citationGroups.map(g=>g.map(scope))}};assert.deepEqual(rows(await query.searchAsync(projection,ast,options)),rows(query.search(projection,ast,options)));assert.deepEqual(rows(query.search(await occurrence.buildProjectionAsync(corpus),ast,options)),rows(query.search(projection,ast,options)));console.log('PASS structured scopes, citations/Common, annotations, highlight modes, previews and migrations');})().catch(e=>{console.error(e);process.exitCode=1;});
