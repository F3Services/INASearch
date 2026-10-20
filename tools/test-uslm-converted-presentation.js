#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { runtime } = require("./audit-ina-display");

// Read the publisher's italic address letter directly. This regression catches
// citation conversion replacing the styled source contents with an unstyled label.
const original = JSON.parse(execFileSync("python3", ["-B", "-c", `
import json,re,xml.etree.ElementTree as E
manifest=json.load(open('sources/legal/source-manifest.json'))
house=next(source for source in manifest['sources'] if source['id']=='house-title-8-uslm')
artifact=next(a for a in house['artifacts'] if a['id']=='house-title-8-xml')
root=E.parse(artifact['path']).getroot()
unit=next(n for n in root.iter() if n.get('identifier')=='/us/usc/t8/s1101/a/15/F/i')
paragraph=next(n for n in unit.iter() if n.tag.endswith('}content'))
text='';styles=[]
def normalized(value):return re.sub(r'\\s+',' ',value).strip()
def walk(node):
 global text
 start=len(normalized(text))
 text+=node.text or ''
 for child in node:
  if child.get('class')!='footnoteRef' and child.get('type')!='footnote':walk(child)
  text+=child.tail or ''
 if node.tag.endswith('}i'):styles.append({'tag':'i','start':start,'end':len(normalized(text))})
walk(paragraph)
print(json.dumps({'text':normalized(text),'layout':styles}))
`], { encoding: "utf8" }));
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const api = runtime(template, { title8: { sections: [] }, inaCrosswalk: [
  { inaSection: "214", uscSection: "1184" }, { inaSection: "212", uscSection: "1182" }
] });
const start = original.text.indexOf("section 1184(l)");
assert(start >= 0);
assert(original.layout.some(block => original.text.slice(block.start, block.end) === "l"), "Original source must identify its italic address letter");
const reference = { start, end: start + 15, text: "section 1184(l)", family: "usc", targetTitle: "8", targetSection: "1184", targetPath: ["l"], resolution: "official-source-only" };
const context = { kind: "usc", uscSection: "1101", citationDisplaySystem: "ina", sourceLayout: original.layout };
const contents = html => [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(match => match[1]);
const plain = html => html.replace(/<[^>]*>/g, "");
const italicLetter = html => /<(?:i|span)\b[^>]*style="[^"]*font-style:italic[^>]*>l<\//.test(html);
const sourceHtml = api.linkifyStatutoryText(original.text, [reference], 0, undefined, null, [], { ...context, citationDisplaySystem: "usc" });
assert(italicLetter(contents(sourceHtml)[0]), "USC citation retains original letter style");
const convertedHtml = api.linkifyStatutoryText(original.text, [reference], 0, undefined, null, [], context);
assert.equal(plain(contents(convertedHtml)[0]), "INA 214(l)");
assert(italicLetter(contents(convertedHtml)[0]), "INA conversion must retain the original italic address letter");

// Exercise the separate coordinated-list path with the same printed suffix.
const list = "sections 1184(l) and 1182(l) of this title";
const references = ["1184", "1182"].map(section => {
  const start = list.indexOf(`${section}(l)`);
  return { ...reference, start, end: start + 7, text: `${section}(l)`, targetSection: section };
});
const layout = references.map(ref => ({ tag: "i", start: ref.end - 2, end: ref.end - 1 }));
const listHtml = api.linkifyStatutoryText(list, references, 0, undefined, null, [], { ...context, sourceLayout: layout });
assert.deepEqual(contents(listHtml).map(plain), ["INA 214(l)", "212(l)"]);
assert(contents(listHtml).every(italicLetter), "Coordinated INA links retain each original italic suffix");
const emphasizedHtml = api.linkifyStatutoryText(original.text, [reference], 0, undefined, null, [], {
  ...context, sourceLayout: [{ tag: "inline", start: reference.start, end: reference.end, presentation: { smallCaps: true }, children: original.layout }]
});
assert(/style="font-variant:small-caps"/.test(contents(emphasizedHtml)[0]), "Whole-citation emphasis also covers the converted authority");
assert(italicLetter(contents(emphasizedHtml)[0]), "Nested source emphasis survives whole-citation conversion");
const plainList = api.linkifyStatutoryText(list, references, 0, undefined, null, [], { ...context, sourceLayout: layout, plainText: true });
assert.equal(plainList, "INA 214(l) and 212(l)", "Copy must retain converted wording without presentation markup");
console.log("PASS converted USLM presentation: original italic address letters survive individual and coordinated INA links");
