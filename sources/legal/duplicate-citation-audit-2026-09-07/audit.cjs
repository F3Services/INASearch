// Read-only audit of the built artifact. Exact tokens retain case and boundaries.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const {readArtifact}=require(path.join(root,'tools/audit-inline-references'));
const {statuteRunInPathMarkers}=require(path.join(root,'tools/statute-run-ins'));
const artifact=path.join(root,'INASearch-Uncompressed.html');
const corpus=readArtifact(artifact);
const statutes=new Map(), runIns=new Map(), regulations=new Map();
let structuralUnits=0, inlineMarkers=0;
const add=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value)};
const duplicates=map=>[...map].filter(([,v])=>v.length>1).map(([citation,occurrences])=>({citation,occurrences}));
for(const section of corpus.title8.sections){
 const mapping=corpus.inaCrosswalk.find(r=>String(r.uscSection)===String(section.section));
 const visit=(nodes,tokens=[],location='body')=>{for(const[index,node]of(nodes||[]).entries()){
  const current=[...tokens,String(node.label)], locator=`${location}[${index}]`;
  const suffix=current.map(t=>`(${t})`).join('');
  const key=`8 U.S.C. ${section.section}${suffix}`;
  const occurrence={ina:mapping?`INA ${mapping.inaSection}${suffix}`:null,locator,heading:node.heading||'',text:node.text||'',childLabels:(node.children||[]).map(n=>n.label),footnoteReferences:[...(node.headingFootnoteReferences||[]),...(node.textFootnoteReferences||[])],url:section.url};
  add(statutes,key,occurrence);add(runIns,key,{...occurrence,kind:'structural'});structuralUnits++;
  for(const marker of statuteRunInPathMarkers(section,node,current)){
   inlineMarkers++;add(runIns,`8 U.S.C. ${section.section}${marker.path.map(t=>`(${t})`).join('')}`,{kind:'inline',locator,start:marker.start,parent:current,text:node.text.slice(marker.start,marker.start+250)});
  }
  visit(node.children,current,locator+'.children');
 }};visit(section.body);
}
for(const section of corpus.cfr.sections){
 const visit=(blocks,location='blocks')=>{for(const[index,block]of(blocks||[]).entries()){
  const locator=`${location}[${index}]`;
  if(block.t==='p'&&block.a)add(regulations,`${section.title} CFR ${section.section}${block.a}`,{locator,text:block.x||'',url:section.url,unitMarkers:block.u||[]});
  if(block.t==='note'&&(!block.noteType||block.noteType==='ordinary'))visit(block.blocks,locator+'.blocks');
 }};visit(section.blocks);
}
const output={artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),statutorySections:corpus.title8.sections.length,structuralUnits,inlineMarkers,cfrSections:corpus.cfr.sections.length,statutoryDuplicates:duplicates(statutes),additionalInlineCandidates:duplicates(runIns).filter(d=>d.occurrences.some(o=>o.kind==='inline')),cfrAddressDuplicates:duplicates(regulations),houseNotes:corpus.title8.sections.filter(s=>['1154','1182','1228'].includes(s.section)).map(s=>({section:s.section,notes:s.houseEditorialFootnotes.filter(n=>/Two subsecs|Probably should be “\(II\)”/.test(n.text))}))};
fs.writeFileSync(path.join(__dirname,'findings.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({statutorySections:output.statutorySections,structuralUnits,inlineMarkers,cfrSections:output.cfrSections,statutoryDuplicates:output.statutoryDuplicates.length,additionalInlineCandidates:output.additionalInlineCandidates.length,cfrAddressDuplicates:output.cfrAddressDuplicates.length}));
