#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { readHistoricalIna, parseHistoricalUnits } = require("./historical-ina");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");
const { hydratePackedCorpus, packCorpusForDelivery } = require("../src/INASearch-Corpus-Packing");
const occurrence = require("../src/INASearch-Occurrence");
const annotations = require("../src/INASearch-Annotations");
const functionSource = require("./test-function-source");
const data = readHistoricalIna();
const html = fs.readFileSync(require.resolve("../INASearch.html"), "utf8");
const packed = JSON.parse(zlib.gunzipSync(Buffer.from(html.match(/<script id="inaSearchCorpusData"[^>]*>([\s\S]*?)<\/script>/)[1], "base64")));
const corpus = unpackLegalReferences(hydratePackedCorpus(packed));
const sections = new Map(corpus.title8.sections.map(s => [s.section,s]));
const nodeAt = (s, path) => path.reduce((parent, label) => parent.children?.find(n => n.label === label), { children: sections.get(s).body });
assert.equal(corpus.historicalIna.sections.length, 14);
assert.equal(corpus.corpusVersion, "2026.09.19-historical.4");
for (const record of data.sections) {
  const section = sections.get(record.uscSection);
  assert.equal(section.status, record.status || "repealed");
  assert.equal(section.heading, record.originalTitle);
  assert.equal(section.historical.unitsSha256, record.unitsSha256);
  assert(section.houseHeading.startsWith(record.status === "transferred" ? "Transferred" : "Repealed"));
  const parsed = parseHistoricalUnits(record.units);
  assert.equal(section.preamble || "", parsed.preamble || "");
  for (const unit of record.units.filter(u => u.path.length)) {
    const matches = [];
    const visit = nodes => { for (const n of nodes || []) { if (JSON.stringify(n.path) === JSON.stringify(unit.path)) matches.push(n); visit(n.children); } };
    visit(section.body);
    const node = unit.duplicateDesignation ? matches.at(-1) : matches[0];
    assert(node, `${record.inaSection}(${unit.path.join(")(")})`);
    for (const key of ["text", "heading", "continuation"]) assert.equal(node[key] || "", unit[key] || "");
  }
  const headingRefs = section.headingReferences || [];
  assert(!headingRefs.some(r => r.family === "public-law"), "Old repeal-heading offsets leaked into original INA title");
}
assert.deepEqual(["352","353","354","355","401"].map(ina => corpus.inaCrosswalk.find(r=>r.inaSection===ina).localSection), ["1484","1485","1486","1487","1106"]);
assert(sections.has("1484 to 1487"));
assert.equal(corpus.inaCrosswalk.find(r=>r.inaSection==="401").originalCrosswalk.hasEquivalent,false);
assert.match(nodeAt("1252b",["d","1"]).text,/an immigration judge/);
assert.match(nodeAt("1161",["e","1"]).text,/paragraphs \(5\) and \(7\)\(A\)/);
assert.deepEqual(nodeAt("1161",["e","2","B"]).children.map(n=>n.label),["i","ii","iii"]);
assert.match(nodeAt("1161",["e","2","B","iii"]).text,/Paragraph \(3\) \(relating to security and related grounds\)/);
assert.match(nodeAt("1161",["d","5","A"]).text,/1251\(a\)\(1\)\(F\)/);
assert.deepEqual(sections.get("1459").body.map(n=>n.label),["a","b"]);
assert.match(nodeAt("1485",["7"]).text,/son or daughter/);
assert.match(nodeAt("1486",["1"]).text,/Korean hostilities/);
assert.match(nodeAt("1486",["4"]).text,/spouse or child/);
assert.match(nodeAt("1486",["5"]).text,/fifteen years/);
for (const [s,path,phrase] of [["1161",["a","2"],"divided by"],["1161",["a","6","A","ii"],"factor under"],["1161",["f","4"],"person or entity"],["1252b",["a","2"],"not in detention"],["1252b",["c","3"],"stay the deportation"],["1252b",["d"],"Nothing in this subsection"],["1252b",["e","4","A"],"5 years"]]) assert(nodeAt(s,path).continuation.includes(phrase));
const refs = [];
function collect(node) { for(const field of ["preamble","text","continuation"]){const property=field==="text"?"references":`${field}References`; for(const r of node[property]||[]){assert.equal(node[field].slice(r.start,r.end),r.text);refs.push(r);}}for(const child of node.children||[])collect(child); }
for(const section of sections.values())if(section.historical){collect(section);for(const node of section.body)collect(node);}
for (const s of ["1252","1105a","1450","1251"]) {
  const selected=refs.filter(r=>r.targetTitle==="8"&&r.targetSection===s);
  assert(selected.length);
  for(const ref of selected){const target=corpus.historicalReferenceTargets[ref.historicalTargetId];assert(target);assert.equal(ref.resolution,"official-source-only");assert(target.message.includes("Historical target text")||target.message.includes("historical target text"));}
}
assert.equal(corpus.historicalReferenceTargets[refs.find(r=>r.targetSection==="1251").historicalTargetId].status,"transferred");
assert.equal(corpus.historicalReferenceTargets[refs.find(r=>r.targetSection==="1105a").historicalTargetId].status,"repealed");
const range=nodeAt("1485",["7"]).references.filter(r=>["(1)","(5)","(6)"].includes(r.text));
assert.deepEqual(range.map(r=>[r.targetSection,r.targetPath]),[["1485",["1"]],["1485",["5"]],["1485",["6"]]]);
assert(nodeAt("1485",["10"]).references.some(r=>r.text.includes("Nationality Act of 1940")&&r.historicalTargetId));
const projected=occurrence.buildProjection(corpus,{authorities:["ina"]});
assert(projected.fragments.some(f=>f.recordId==="8-1252b"&&f.source?.subfield==="continuation"&&f.text.includes("stay the deportation")));
const template=fs.readFileSync(require.resolve("../src/INASearch.template.html"),"utf8");
const ctx={Set,String,textWithHouseFootnoteMarkers:t=>t||""};vm.createContext(ctx);
vm.runInContext(functionSource(template,"statuteNodePlainText"),ctx);
const copied=ctx.statuteNodePlainText(nodeAt("1252b",["c","3"]));
assert(copied.indexOf("pending disposition")>copied.indexOf("Federal or State custody"));
const a=annotations.quoteAnchor(nodeAt("1432",["a","3"]).text,0,30,{sourceHostKey:"usc:8:1432:a/3"});
assert.equal(annotations.resolveQuoteAnchor(nodeAt("1432",["a","3"]).text,a).status,"active");
const roundtrip=unpackLegalReferences(hydratePackedCorpus(packCorpusForDelivery(packLegalReferences(structuredClone(corpus)))));
assert.deepEqual(roundtrip.historicalReferenceTargets,corpus.historicalReferenceTargets);
assert.deepEqual(roundtrip.title8.sections.find(s=>s.section==="1252b").body,sections.get("1252b").body);

assert.equal(sections.get("1252a").status, "transferred");
assert.equal(corpus.inaCrosswalk.find(r => r.inaSection === "242A").localSection, "1252a");
assert(!corpus.inaCrosswalk.some(r => r.inaSection === "242C" || r.localSection === "1252c"));
assert.match(nodeAt("1252a", ["a", "1"]).text, /without regard to the date/);
assert(!nodeAt("1252a", ["a", "1"]).text.includes("legally enforceable"));
assert.match(nodeAt("1252a", ["a", "2"]).text, /1252\(a\)\(2\)/);
assert.match(nodeAt("1252a", ["b", "3"]).text, /14 calendar days/);
assert.match(nodeAt("1252a", ["b", "3"]).text, /1105a/);
assert.deepEqual(nodeAt("1252a", ["b", "4"]).children.map(n => n.label), ["A", "B", "C", "D", "E", "F"]);
const duplicateC = sections.get("1252a").body.filter(n => n.label === "c");
assert.equal(duplicateC.length, 2);
assert.match(duplicateC[0].text, /conclusively presumed/);
assert.deepEqual(duplicateC[1].children.map(n => n.label), ["1", "2", "3", "4"]);
assert.match(duplicateC[1].children[0].text, /whose criminal conviction/);
assert(!duplicateC[1].children[3].text.includes("without a decision"));
assert.equal(sections.get("1252c").status || "current", "current");

console.log(`PASS historical INA: 14 source-checked bodies, amendments, distinct identities, continuations, historical references, annotations and packing (${refs.length} body references).`);
