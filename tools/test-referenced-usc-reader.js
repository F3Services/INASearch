"use strict";
const assert = require("node:assert/strict");
const { createParser } = require("./test-mixed-citations");

// A cross-title citation must open its own complete section, never the same
// section number in Title 8 or an INA mapping with a coincident number.
const section = { id: "18-16", title: 18, section: "16", heading: "Crime of violence defined",
  preamble: "The term crime of violence means—", notes: [],
  body: [{ label: "a", text: "an offense that has as an element the use of physical force", children: [] },
    { label: "b", text: "any other offense that is a felony", children: [] }], url: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title18-section16" };
const { api } = createParser({ referencedUsc: { titles: [{ number: 18, name: "Crimes and Criminal Procedure", sections: [section] }] } });
const result = api.parseCitation("18 USC 16(a)");
assert(result?.valid, "A cited section from another USC title must resolve locally");
assert.equal(result.section.id, "18-16");
assert.equal(result.label, "18 U.S.C. 16(a)");
assert.equal(result.section.body.length, 2, "Opening a subsection retains its sibling and whole section");
assert(!result.mapping, "An external USC section must never acquire an INA mapping");
assert.equal(api.parseCitation("8 USC 1101").section.id, "8-1101");
assert(!api.parseCitation("18 USC 16(c)").valid, "Missing subsection must not silently open a broader unit");
const external = api.parseCitation("18 USC 99999");
assert(external?.external && /title18-section99999/.test(external.url), "Absent sections retain an official source link");
console.log("PASS cross-title USC citation reader and Title 8 isolation");
const fs = require('node:fs'), vm = require('node:vm');
const functionSource = require('./test-function-source');
const template = fs.readFileSync(require.resolve('../src/INASearch.template.html'), 'utf8');
assert(api.parseSearchScope('18 USC 16(a)–18 USC 16(b)').valid, 'Fully qualified cross-title range endpoints must resolve');
const format = vm.runInNewContext(`(${functionSource(template, 'formatNavigationCitationLike')})`, {
  parseCitation: api.parseCitation,
  citationTextParts: vm.runInNewContext(`(${functionSource(template, 'citationTextParts')})`),
  componentTokens: value => Array.from(value.matchAll(/\(([^)]+)\)/g), match => match[1]),
  canonicalPath: path => path.map(token => `(${token})`).join(''),
  lazyNavigationStatutePath: (_, path) => path
});
assert.equal(format('USC 1101', '18 U.S.C. 16(a)'), '18 USC 16a', 'Implied Title8 navigation must add the destination title');
const annotations = require('../src/INASearch-Annotations');
const notes = annotations.detectReferences('Compare 18 U.S.C. 16(a) and 8 U.S.C. 1101(a).', api.parseCitation);
assert.equal(notes.spans.length, 2, 'Notes must detect citations from other titles');

for (const scope of ["USC", "U.S.C.", "statute", "statutes", "statutory"]) assert(api.parseSearchScope(scope).sectionIds.has(section.id), `${scope} scope must include other titles`);

const referencedUsc = structuredClone(require('../sources/legal/referenced-usc/corpus.json'));
require('./statute-run-ins').indexStatuteRunIns({ title8: { sections: referencedUsc.titles.flatMap(title => title.sections) } });
const complete = createParser({ referencedUsc }).api;
let canonicalPaths = 0;
for (const title of referencedUsc.titles) for (const record of title.sections) {
  for (const path of [[], ...complete.collectStructuralCitationPaths(record.body), ...(record.runInPaths || [])]) {
    assert(path.every(token => String(token)), 'Unnumbered prose must not create empty citation units');
    const citation = `${title.number} USC ${record.section}${path.map(token => `(${token})`).join('')}`;
    const resolved = complete.parseCitation(citation);
    assert(resolved?.valid, `${citation}: every generated citable path must resolve`);
    assert.equal(resolved.section.id, record.id, `${citation}: a canonical citation must retain its source section`);
    assert.equal(JSON.stringify(resolved.path), JSON.stringify(path), `${citation}: explicit source units must outrank compact numeral aliases`);
    assert(!resolved.mapping, `${citation}: cross-title sections must not acquire an INA mapping`);
    canonicalPaths++;
  }
}
console.log(`PASS referenced USC canonical paths: ${canonicalPaths} exact section and subsection targets`);
