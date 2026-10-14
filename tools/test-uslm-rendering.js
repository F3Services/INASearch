#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { runtime } = require("./audit-ina-display");
const template = fs.readFileSync("src/INASearch.template.html", "utf8");
const api = runtime(template, { title8: { sections: [] }, inaCrosswalk: [] });
api.profile.preferences.statutoryLinkCitationSystem = "usc";
api.houseFootnoteReferenceId = reference => reference.id;
// The publisher places an editorial marker inside wording that our linkifier
// recognizes as one citation. Read its actual position instead of duplicating
// the original sentence or trusting generated overlay offsets.
const original = JSON.parse(execFileSync("python3", ["-c", `
import json, re, xml.etree.ElementTree as E
r=E.parse('sources/legal/raw/usc08@119-102.xml').getroot()
n=next(n for n in r.iter() if n.get('identifier')=='/us/usc/t8/s1158/c/3')
p=next(n for n in n.iter() if n.tag.endswith('}p'))
text=''; marker=None
def walk(n):
 global text,marker
 text+=n.text or ''
 for c in n:
  tag=c.tag.rsplit('}',1)[-1]
  if tag=='ref' and c.get('class')=='footnoteRef':marker={'id':c.get('idref'),'number':''.join(c.itertext()),'offset':len(re.sub(r'\\s+',' ',text).strip())}
  elif tag!='note':walk(c)
  text+=c.tail or ''
walk(p)
print(json.dumps({'text':re.sub(r'\\s+',' ',text).strip(),'marker':marker}))
`], { encoding: "utf8" }));
const start = original.text.indexOf("section 1182(a)");
const reference = { start, end: start + "section 1182(a)".length, text: "section 1182(a)", family: "usc", targetTitle: "8", targetSection: "1182", targetPath: ["a"], resolution: "official-source-only" };
const html = api.linkifyStatutoryText(original.text, [reference], 0, undefined, null, [original.marker]);
assert.equal((html.match(/class="house-footnote-reference"/g) || []).length, 1, "Original §1158(c)(3) marker must survive an overlapping citation");
assert(html.indexOf('class="house-footnote-reference"') > html.indexOf("section"));
assert(html.indexOf('class="house-footnote-reference"') < html.lastIndexOf("1182(a)"), "Marker must remain after section, before its number");
let anchorDepth = 0;
for (const match of html.matchAll(/<\/?a\b[^>]*>/g)) {
  anchorDepth += match[0].startsWith("</") ? -1 : 1;
  assert(anchorDepth >= 0 && anchorDepth <= 1, "Footnotes must not create nested links");
}
assert.equal(anchorDepth, 0);
console.log("PASS USLM rendering: original editorial marker survives citation overlap");
