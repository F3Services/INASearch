'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const [baseline,current,out]=process.argv.slice(2);if(!out)throw Error('Usage: node changes.js baseline-directory current-directory output-directory');
const read=d=>fs.readFileSync(path.join(d,'display.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const before=read(baseline),after=read(current);assert.equal(before.length,after.length);
const changes=[];let fields=0;
for(let i=0;i<before.length;i++){
 const b=before[i],a=after[i];assert.equal(a.sourcePath,b.sourcePath);assert.equal(a.field,b.field);assert.equal(a.original,b.original);
 if(a.displayed!==b.displayed)fields++;
 const keyed = row => new Map(row.references.map((reference,index)=>[`${reference.start}:${reference.end}:${reference.text}`,{reference,link:row.links[index]}]));
 const old=keyed(b),current=keyed(a);
 for(const key of new Set([...old.keys(),...current.keys()])) {
  const prev=old.get(key),next=current.get(key);
  const semantic = value => value ? {reference: Object.fromEntries(Object.entries(value.reference).filter(([key])=> !['id','evidenceId'].includes(key))),link: value.link ? Object.fromEntries(Object.entries(value.link).filter(([key])=> !['displayStart','displayEnd'].includes(key))) : null} : null;
  if(JSON.stringify(semantic(prev))===JSON.stringify(semantic(next)))continue;
  const ref=next?.reference || prev.reference;
  changes.push({id:changes.length+1,scope:a.scope,sourceId:a.sourceId,sourcePath:a.sourcePath,field:a.field,reference:ref,beforeReference:prev?.reference || null,afterReference:next?.reference || null,before:prev?.link || null,after:next?.link || null,beforeContext:prev?.link ? b.displayed.slice(Math.max(0,prev.link.displayStart-160),prev.link.displayEnd+220) : null,afterContext:next?.link ? a.displayed.slice(Math.max(0,next.link.displayStart-160),next.link.displayEnd+220) : null,originalContext:a.original.slice(Math.max(0,ref.start-350),Math.min(a.original.length,ref.end+350)),originalField:a.original,beforeField:b.displayed,afterField:a.displayed});
 }

}
const covered = new Set(changes.map(row => `${row.sourcePath}:${row.field}`));
const proseOnly = after.flatMap((row,index) => row.displayed !== before[index].displayed && !covered.has(`${row.sourcePath}:${row.field}`) ? [{id:0,sourceId:row.sourceId,sourcePath:row.sourcePath,field:row.field,original:row.original,before:before[index].displayed,after:row.displayed,references:row.references,links:row.links}] : []).map((row,index)=>({...row,id:index+1}));
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,"prose-only-evidence.json"),JSON.stringify(proseOnly,null,2));fs.writeFileSync(path.join(out,'changes.json'),JSON.stringify(changes,null,2));
for(let shard=0;shard<3;shard++)fs.writeFileSync(path.join(out,`shard-${shard+1}.json`),JSON.stringify(changes.filter((_,i)=>i%3===shard),null,2));
const summary={referencesChanged:changes.length,fieldsChanged:fields,detectionAndTargetsUnchanged:changes.every(row=>JSON.stringify(row.beforeReference)===JSON.stringify(row.afterReference)),baseline:JSON.parse(fs.readFileSync(path.join(baseline,'display-summary.json'))),current:JSON.parse(fs.readFileSync(path.join(current,'display-summary.json')))};fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({referencesChanged:changes.length,fieldsChanged:fields,shards:[0,1,2].map(s=>changes.filter((_,i)=>i%3===s).length)}));
