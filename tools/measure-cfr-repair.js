#!/usr/bin/env node
"use strict";
const fs=require('fs'),crypto=require('crypto'),assert=require('assert'),{execFileSync}=require('child_process');
const base=process.argv[2];if(!/^[a-f0-9]{40}$/.test(base||''))throw Error('Usage: node tools/measure-cfr-repair.js <baseline commit SHA>');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function sizes(bytes){
 const html=bytes.toString('utf8');
 const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(match=>!/application\/(?:json|gzip)/.test(match[1]));
 const data=html.match(/<script id="inaSearchCorpusData"([^>]*)>([\s\S]*?)<\/script>/);
 const compressed=data[1].includes('application/gzip');
 return {artifactBytes:bytes.length,sha256:hash(bytes),runtimeCodeBytes:scripts.reduce((sum,match)=>sum+Buffer.byteLength(match[2]),0),cssBytes:[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].reduce((sum,match)=>sum+Buffer.byteLength(match[1]),0),corpusBytes:compressed?Buffer.from(data[2].replace(/\s/g,''),'base64').length:Buffer.byteLength(data[2].trim()),corpusEncoding:compressed?'gzip':'plain JSON'};
}
const report={baseCommit:base,artifacts:{}};
for(const file of ['INASearch.html','INASearch-Uncompressed.html']){
 const before=sizes(execFileSync('git',['show',`${base}:${file}`],{maxBuffer:50_000_000})),bytes=fs.readFileSync(file),after=sizes(bytes);
 const html=bytes.toString('utf8');
 for(const forbidden of ['cfr-hierarchy/corrections.json','reviewed-expectations.json','download-fixtures.json','"corrections":['])assert(!html.includes(forbidden),`${file} embeds or loads repository audit data: ${forbidden}`);
 const delta=Object.fromEntries(['artifactBytes','runtimeCodeBytes','cssBytes','corpusBytes'].map(key=>[key,after[key]-before[key]]));
 assert(delta.runtimeCodeBytes<=50_000,`${file}: runtime growth exceeds the 50 KB planning target`);
 report.artifacts[file]={before,after,delta,artifactGrowthPercent:100*delta.artifactBytes/before.artifactBytes};
}
report.correctionLogsExcluded=true;
fs.writeFileSync('sources/legal/cfr-hierarchy/sizes.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.artifacts).map(([file,result])=>[file,{bytes:result.after.artifactBytes,delta:result.delta,growthPercent:result.artifactGrowthPercent}])),null,2));
