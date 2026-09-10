#!/usr/bin/env node
"use strict";
// Compile reviewed evidence, never recalculate its guards from a new download.
const fs=require('fs');
const reviews=JSON.parse(fs.readFileSync('sources/legal/cfr-hierarchy/reviewed-expectations.json','utf8')).reviews;
const rules={};
for(const review of reviews){
 if(!/^[a-f0-9]{16}$/.test(review.firstGuard) || !/^[a-f0-9]{16}$/.test(review.sourceGuard))throw Error(`Missing reviewed source guard: ${review.rule}`);
 const edits=review.expectations.map(item=>[item.blockPath[0]-review.firstBlock,item.correctedMarkers]);
 (rules[review.id]??=[]).push([review.rule,review.firstGuard,review.lastBlock-review.firstBlock+1,review.sourceGuard,edits]);
}
const file='src/INASearch-CFR-Hierarchy.js',source=fs.readFileSync(file,'utf8');
fs.writeFileSync(file,source.replace(/^  const repairs = .*;$/m,'  const repairs = '+JSON.stringify(rules)+';'));
console.log(`Compiled ${reviews.length} reviewed CFR rules (${Buffer.byteLength(JSON.stringify(rules))} bytes).`);
