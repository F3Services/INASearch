#!/usr/bin/env node
'use strict';
// Root supplemental check; this does not replace the requested independent Luna grammar audit.
const fs = require('fs');
const {readArtifact, collectFields} = require('../audit-inline-references');
const {runtime, plain, contextFor} = require('../audit-ina-display');
const corpus = readArtifact('INASearch-Uncompressed.html');
const api = runtime(fs.readFileSync('src/INASearch.template.html','utf8'), corpus);
const findings = [];
let fields = 0, references = 0, groups = 0;
for (const field of collectFields(corpus)) {
  const context = contextFor(field, corpus);
  const grouped = api.coordinatedStatutoryInaLists(field.text, field.references, 0, undefined, context);
  const html = api.linkifyStatutoryText(field.text, field.references, 0, undefined, null, [], context);
  let linkIndex = 0;
  const actual = plain(html.replace(/<a\b[^>]*data-legal-reference[^>]*>[\s\S]*?<\/a>/g, () => `⟦${linkIndex++}⟧`));
  function mask(start, end) {
    let result = '', cursor = start;
    field.references.forEach((ref, index) => {
      if (ref.start < start || ref.end > end) return;
      result += field.text.slice(cursor, ref.start) + `⟦${index}⟧`;
      cursor = ref.end;
    });
    return result + field.text.slice(cursor, end);
  }
  let expected = '', cursor = 0;
  for (const group of grouped) {
    expected += mask(cursor, group.start);
    // Only citation designators inside a proven group may disappear.
    expected += mask(group.start, group.end)
      .replace(/^sections?\s+/i, '')
      .replace(/\s+of\s+(?:(?:this|such)\s+title|title\s+8)\s*$/i, '')
      .replace(/sections?\s+(?=⟦)/gi, '');
    cursor = group.end;
  }
  expected += mask(cursor, field.text.length);
  if (actual !== expected || linkIndex !== field.references.length) findings.push({sourceId:field.sourceId,sourcePath:field.sourcePath,field:field.field,original:field.text,actual,expected});
  fields++; references += field.references.length; groups += grouped.length;
}
const output = {fields,references,groups,findings};
fs.mkdirSync('tmp/ina-display-prose-check',{recursive:true});
fs.writeFileSync('tmp/ina-display-prose-check/result.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({fields,references,groups,findings:findings.length}));
