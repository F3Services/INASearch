#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const functionSource = require("./test-function-source");
const { readArtifact } = require("./audit-inline-references");
const { runtime } = require("./audit-ina-display");
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const corpus = readArtifact("INASearch-Uncompressed.html");
const api = runtime(template, corpus);
for (const name of ["superscriptNumber", "textWithHouseFootnoteMarkers", "statuteTextRangeWithHouseFootnotes", "statuteNodePlainText", "legalUnitCitationRows", "legalUnitPrintHtml"]) {
  vm.runInContext(functionSource(template, name), api);
}
const plain = html => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const paragraphs = html => [...html.matchAll(/<p class="legal-print-paragraph" style="padding-inline-start:([\d.]+)em">([\s\S]*?)<\/p>/g)].map(match => ({ indent: Number(match[1]), html: match[2], text: plain(match[2]) }));
const print = text => api.legalUnitPrintHtml({ text, citation: "INA 101(a)(27)(K)", heading: "Definitions" });
const rows = paragraphs(print("(a) Parent\n  (1) Child < & >\nParent continuation\n  (2)(A) Second child\n    (i) Grandchild\n  Child continuation\n\nNotes"));
assert.equal(rows.length, 8, "Each source line needs its own printable paragraph, including blank lines");
assert.deepEqual(rows.map(row => row.indent), [0, 1.5, 0, 1.5, 3, 1.5, 0, 0], "Indent the whole paragraph so every wrapped line stays at its source depth");
assert.equal(rows[1].html, "<strong>(1)</strong> Child &lt; &amp; &gt;");
assert.equal(rows[3].html, "<strong>(2)(A)</strong> Second child");
assert.equal(rows[5].html, "Child continuation", "Continuations have no invented citation marker");

// Compare the print paragraphs to the publisher's hierarchy and continuation,
// independently of our flattened text and its child-offset overlay.
const source = JSON.parse(execFileSync("python3", ["-c", `
import json, re, xml.etree.ElementTree as E
ns={'u':'http://xml.house.gov/schemas/uslm/1.0'}
r=E.parse('sources/legal/raw/usc08@119-102.xml').getroot()
n=next(n for n in r.iter() if n.get('identifier')=='/us/usc/t8/s1101/a/27/K')
rows=[]
def text(n):return re.sub(r'\\s+', ' ', ''.join(n.itertext())).strip()
def walk(n, depth):
 parts=[]
 for c in n:
  tag=c.tag.rsplit('}',1)[-1]
  if tag in ('num','content','chapeau'):parts.append(text(c))
  elif tag=='clause':
   if parts:rows.append({'depth':depth,'text':' '.join(parts)});parts=[]
   walk(c,depth+1)
  elif tag=='continuation':
   if parts:rows.append({'depth':depth,'text':' '.join(parts)});parts=[]
   rows.append({'depth':depth,'text':text(c)})
 if parts:rows.append({'depth':depth,'text':' '.join(parts)})
walk(n,0)
print(json.dumps(rows))
`], { encoding: "utf8" }));
const section = corpus.title8.sections.find(section => section.section === "1101");
let node = { children: section.body };
for (const label of ["a", "27", "K"]) node = node.children.find(child => child.label === label);
const printed = paragraphs(print(api.statuteNodePlainText(node)));
assert.deepEqual(printed.map(row => ({ depth: row.indent / 1.5, text: row.text.replace(/\s+/g, " ").trim() })), source,
  "INA 101(a)(27)(K) print order and paragraph depths must match the original USLM");
assert(printed.slice(0, 3).every(row => row.html.startsWith("<strong>(")), "Every source citation unit is bold");
assert(printed[3].text.startsWith("and the spouse or child"));
console.log("PASS legal printing: paragraph indentation, bold units, escaping, and original USLM continuation");
