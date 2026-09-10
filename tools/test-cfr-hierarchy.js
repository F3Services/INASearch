#!/usr/bin/env node
"use strict";
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const H = require('../src/INASearch-CFR-Hierarchy');
const box={window:{}}; vm.runInNewContext(fs.readFileSync('src/INASearch-CFR.js','utf8'),box);
const cfr=box.window.INA_SEARCH_CFR, records=[...cfr.sections,...cfr.appendices];
const template=fs.readFileSync('src/INASearch.template.html','utf8');
function declaration(name) { const start=template.indexOf('    function '+name+'('); assert(start>=0,name); const end=template.indexOf('\n    }',start)+6; return template.slice(start,end); }
const names=['parseCfr','indexedCfrSection','resolveIndexedCfrPath','componentTokens','compactHierarchyTokens','canonicalPath','normCitationPart','cfrSectionNumberKey','compareCompactCitationPaths','romanNumeralValue','romanNumeralForValue','commonCompactCandidatePrefixLength','cfrSectionFamilyHtml','cfrParagraphNavigationSegments','cfrChildNavigationSegment','citationAmbiguityRange','citationWithStatuteInterpretation'];
const cfrSectionMap=new Map(cfr.sections.map(r=>[`${r.title}:${r.section.replace(/[^a-z0-9-]/gi,'').toLowerCase()}`,r]));
const cfrSectionsByNumber=new Map();for(const r of cfr.sections){const key=r.section.toLowerCase();if(!cfrSectionsByNumber.has(key))cfrSectionsByNumber.set(key,[]);cfrSectionsByNumber.get(key).push(r);}
const ctx={ INASearchCfrHierarchy:H, corpus:{cfr}, cfrSectionMap,cfrSectionsByNumber, cfrSectionIdMap:new Map(cfr.sections.map(r=>[r.id,r])),parseCfrHierarchy:()=>null, cachedCfrBlockPaths:r=>H.index(r).paths, normalize:v=>String(v).toLowerCase(),escapeHtml:v=>String(v),navigationTitleCase:v=>v,truncate:v=>v,cfrPathLevelLabel:i=>String(i)};
const api=vm.runInNewContext(names.map(declaration).join('\n')+'\n({'+names.join(',')+'})',ctx);
const same=(a,b)=>assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
let canonical=0,compact=0,boundaries=0,ambiguous=0,scopes=0,shared=0;
for(const r of cfr.sections){
 for(const path of H.index(r).paths){
  const tokens=H.tokens(path);const result=api.parseCfr(r.title,r.section+path);
  assert(result.valid,`${r.id}${path}: ${result.message}`);same(result.path,tokens);canonical++;
  const spelling=tokens.join('');const indexed=api.indexedCfrSection(r.section+spelling,r.title);
  if(/^\d/.test(spelling) || (indexed && indexed.section!==r.section)){boundaries++;continue;}
  for(const spellingCase of [spelling,spelling.toLowerCase()]){
   const found=api.parseCfr(r.title,r.section+spellingCase);assert(found.valid,`${r.id} ${spellingCase}`);
   assert(H.address(found.path)===path || found.ambiguity?.options.some(option=>H.address(option.path)===path),`${r.id} ${spellingCase} => ${H.address(found.path)} expected ${path}`);compact++;
   if(found.ambiguity)ambiguous++;
  }
 }
}
// Independent forward boundary scan, without consulting the engine's parent stack.
for(const r of records){
 const rows=H.flatten(r.blocks);
 for(const node of H.index(r).nodes){
  const wanted=node.path, selected=H.scope(r,wanted,node.row.blockPath);assert(selected.length,`${r.id}${wanted}`);
  const expected=[];let active=false,done=false;
  for(const row of rows){
   if(done)break;const b=row.block, text=b.x||'';
   const markers=b.u?.length?b.u:[...(b.a?[{a:b.a,s:0}]:[])];
   const range=markers.length>1 && /\[Reserved\]/.test(text) && !markers.at(-1).a.startsWith(markers[0].a+'(');
   if(row.excluded || b.k==='citation' || /^\[(?:\d+ FR |[A-Z][^\]]* FR )/.test(text)){if(active)done=true;continue;}
   if(b.c && H.index(r).byPath.has(b.c) && active && !(b.c===wanted || b.c.startsWith(wanted+'('))){done=true;break;}
   let start=0,end=text.length;
   if(!active){
    if(row.block!==node.row.block)continue;
    const marker=markers.find(u=>u.a===wanted || node.aliases.includes(u.a));if(!marker)continue;
    start=range?0:marker.s;active=true;
   }
   const boundary=markers.find(u=>u.s>=(row.block===node.row.block?start+1:0) && !(u.a===wanted && row.block===node.row.block) && !u.a.startsWith(wanted+'(') && !(range && markers.some(marker=>marker.a===wanted || marker.a.startsWith(wanted+'('))));
   if(boundary){end=boundary.s;done=true;}
   if(end>start || b.t==='table' || b.t==='graphic')expected.push({blockPath:row.blockPath,start,end});
  }
  const actual=selected.filter(x=>x.end>x.start || x.block.t==='table' || x.block.t==='graphic').map(({blockPath,start,end})=>({blockPath,start,end}));
  try { same(actual,expected); } catch(error) { error.message = r.id + wanted + " " + error.message; throw error; } scopes++;
 }
 for(const b of r.blocks) if((b.u||[]).length>1 && /\[Reserved\]/.test(b.x||'')){
  for(const u of b.u){assert(H.scope(r,u.a).some(range=>range.block===b));shared++;}
 }
}
const s214=cfr.sections.find(r=>r.id==='8:214.2');
for(const [path,count] of [['(h)',684],['(h)(2)',42],['(h)(2)(i)',37],['(h)(2)(i)(A)',1]])assert.strictEqual(H.scope(s214,path).filter(r=>r.block.a).length,count,path);
const ambiguous214=api.parseCfr(8,'214.2h2ii');same(ambiguous214.path,['h','2','ii']);assert.strictEqual(ambiguous214.ambiguity.options.length,2);
same(api.parseCfr(8,'214.2h2iI').path,['h','2','i','I']);
assert.strictEqual(api.citationWithStatuteInterpretation('214.2h2ii',ambiguous214.ambiguity,ambiguous214.ambiguity.options.find(o=>o.path.at(-1)==='I')),'214.2h2iI');
for(const [input,section,path] of [['4.7','4.7',[]],['4.7a','4.7a',[]],['4.7(a)','4.7',['a']]]){const r=api.parseCfr(19,input);assert.strictEqual(r.section,section);same(r.path,path);}
assert(api.cfrSectionFamilyHtml(cfr.sections.find(r=>r.id==='19:4.7')).includes('19 CFR 4.7d'));
const letters=cfr.sections.filter(r=>/\.\d+[a-z]+$/i.test(r.section));assert.strictEqual(letters.length,54);
for(const r of letters)assert(api.parseCfr(r.title,r.section).valid,r.id);
for (const r of cfr.sections) for (const block of r.blocks) if (block.u?.length > 1 && /\[Reserved\]/.test(block.x || '')) {
 for (const marker of block.u) {
  const path=H.tokens(marker.a), menus=api.cfrParagraphNavigationSegments(r,path);
  assert(menus.at(-1).options.some(option=>H.address(option.path)===marker.a),`${r.id}${marker.a}: reserved endpoint omitted`);
 }
}
const admissions=cfr.sections.find(r=>r.id==='8:214.1');
same(H.rebindAnchor(admissions,{exact:'Is admissible;'}),null); // Repeated quote cannot identify an occurrence.
const unique=H.rebindAnchor(admissions,{exact:'Every nonimmigrant alien who applies for admission to, or an extension of stay in, the United States'});
same(unique.path,['a','3','i']);
same(H.rebindAnchor(admissions,{exact:'Text that no longer appears in the source.'}),null);
const results={canonical,compact,boundaries,ambiguous,scopes,shared,letterSuffixedSections:letters.length};
fs.writeFileSync('sources/legal/cfr-hierarchy/verification.json',JSON.stringify(results,null,2)+'\n');
console.log(results);
