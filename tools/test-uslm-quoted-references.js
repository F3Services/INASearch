#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");
const root = path.resolve(__dirname, "..");

// Independent oracle: read the original XML, retaining every element and source
// anchor. Do not derive either citation expectations or quote scope from the
// production layout extractor or the already generated reference records.
const oracle = String.raw`
import json, re, sys, xml.etree.ElementTree as ET
ns = {'u': 'http://xml.house.gov/schemas/uslm/1.0'}
root = ET.parse(sys.argv[1]).getroot()
def local(e): return e.tag.rsplit('}', 1)[-1]
def normalized(s): return re.sub(r'\s+', ' ', s).strip()
def extract(note):
    chunks, elements = [], []
    length = 0
    def walk(e):
        nonlocal length
        start = length
        chunks.append(e.text or ''); length += len(e.text or '')
        children = []
        for child in e:
            children.append(walk(child))
            chunks.append(child.tail or ''); length += len(child.tail or '')
        node = {'tag': local(e), 'start': start, 'end': length, **e.attrib}
        if children: node['children'] = children
        elements.append(node)
        return node
    tree = walk(note)
    raw = ''.join(chunks)
    # Offset at a whitespace boundary precedes the pending normalized space.
    offsets = {n: len(normalized(raw[:n]).encode('utf-16-le')) // 2
               for e in elements for n in (e['start'], e['end'])}
    for e in elements:
        e['start'], e['end'] = offsets[e['start']], offsets[e['end']]
    return {'text': normalized(raw), 'layout': tree.get('children', [])}
notes = []
for section in root.findall('.//u:section', ns):
    number = section.find('u:num', ns)
    if number is None or not section.get('identifier', '').startswith('/us/usc/t8/s'): continue
    for index, note in enumerate(section.findall('u:notes/u:note', ns)):
        if note.find('.//u:quotedContent', ns) is None: continue
        record = extract(note)
        record.update(id='8-' + number.get('value') + '-note-' + str(index + 1),
                      section=number.get('value'), topic=note.get('topic', ''),
                      heading=normalized(''.join(note.find('u:heading', ns).itertext())) if note.find('u:heading', ns) is not None else '')
        notes.append(record)
chapter = root.find(".//u:chapter[@identifier='/us/usc/t8/ch7']", ns)
division = {'identifier': chapter.get('identifier'), 'kind': 'chapter', 'number': '7', 'notes': []}
for index, note in enumerate(chapter.findall('u:notes/u:note', ns)):
    record = extract(note)
    record.update(id='8-division-ch7-note-' + str(index + 1), topic=note.get('topic'),
                  heading=normalized(''.join(note.find('u:heading', ns).itertext())))
    division['notes'].append(record)
print(json.dumps({'notes': notes, 'division': division}))
`;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "sources/legal/source-manifest.json"), "utf8"));
const house = manifest.sources.find(source => source.id === "house-title-8-uslm");
const sourceXml = house.artifacts.find(artifact => artifact.id === "house-title-8-xml").path;
const sourceData = JSON.parse(execFileSync("python3", ["-c", oracle, path.join(root, sourceXml)], { maxBuffer: 32 * 1024 * 1024 }));
const sourceNotes = sourceData.notes;
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
function sourceAnchors(note) {
  return flatten(note.layout).filter(node => node.tag === "ref").flatMap((node, index) => {
    const href = node.href || "";
    const usc = href.match(/^\/us\/usc\/t(\d+)\/s([^/]+)(.*)$/);
    const law = href.match(/^\/us\/pl\/(\d+)\/(\d+)(.*)$/);
    const stat = href.match(/^\/us\/stat\/(\d+)\/([^/]+)(.*)$/);
    const match = usc || law || stat;
    if (!match) return [];
    const family = usc ? "usc" : law ? "public-law" : "statutes-at-large";
    const text = note.text.slice(node.start, node.end);
    const leading = text.length - text.trimStart().length;
    return [{ id: `${note.id}-xml-${index}`, start: node.start + leading, end: node.end,
      text: text.trimStart(), family, targetKind: family,
      ...(usc ? { targetTitle: match[1], targetSection: match[2] } : law ? { targetCongress: match[1], targetLaw: match[2] } : { targetVolume: match[1], targetPage: match[2] }),
      targetPath: match[3].split("/").filter(Boolean), houseHref: href,
      resolution: "official-source-only", provenance: "house-uslm-ref", ruleId: "house-uslm-ref" }];
  });
}
const assigned = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "src/INASearch-Corpus.js"), "utf8"), assigned);
const corpus = JSON.parse(JSON.stringify(assigned.window.INA_SEARCH_CORPUS));
for (const section of corpus.title8.sections) section.notes = sourceNotes.filter(note => note.section === section.section).map(note => ({ ...note, references: sourceAnchors(note) }));
for (const note of sourceData.division.notes) note.uslmReferences = flatten(note.layout).filter(node => node.tag === "ref").map(node => ({
  start: node.start + note.text.slice(node.start, node.end).length - note.text.slice(node.start, node.end).trimStart().length,
  end: node.end, text: note.text.slice(node.start, node.end).trimStart(), houseHref: node.href,
  provenance: "house-uslm-ref", ruleId: "house-uslm-ref"
}));
corpus.title8.divisionNotes = { [sourceData.division.identifier]: sourceData.division };
// Former Code numbers can coexist with identical quoted Act section numbers.
for (const number of ["103", "201", "301", "401", "501"]) if (!corpus.title8.sections.some(section => section.section === number)) corpus.title8.sections.push({ title: 8, section: number, body: [] });
applyGeneratedLegalReferences(corpus);
const refugee = corpus.title8.sections.find(section => section.section === "1522").notes.find(note => note.heading === "Refugee Education Assistance Act of 1980");
function verifyRefugee() {
  const citations = [...refugee.text.matchAll(/\bsection 103\b/g)];
  assert.equal(citations.length, 7, "The source regression covers all seven occurrences");
  for (const match of citations) {
    const reference = refugee.references.find(ref => ref.start <= match.index + 8 && ref.end >= match.index + match[0].length);
    assert.deepEqual([reference?.family, reference?.targetCongress, reference?.targetLaw, reference?.targetPath],
      ["public-law", "96", "422", ["s103"]], `Quoted section 103 at ${match.index} belongs to the Refugee Education Assistance Act`);
  }
  for (const anchor of sourceAnchors(refugee).filter(reference => reference.family === "usc")) {
    const reference = refugee.references.find(ref => ref.start === anchor.start);
    assert.deepEqual([reference?.family, reference?.targetTitle, reference?.targetSection, reference?.targetPath],
      [anchor.family, anchor.targetTitle, anchor.targetSection, anchor.targetPath], `Explicit source anchor ${anchor.text} must survive quote scoping`);
  }
  for (const [phrase, member, targetPath] of [
    ["subject to allocation in accordance with subsection (b)", "(b)", ["s102", "b"]],
    ["allocations have been made under paragraph (1) of this subsection", "(1)", ["s102", "b", "1"]],
    ["Secretary pursuant to paragraph (1) to be so needed", "(1)", ["s103", "b", "1"]]
  ]) {
    const start = refugee.text.indexOf(phrase);
    assert(start >= 0, `Original source phrase is available: ${phrase}`);
    const offset = start + phrase.indexOf(member);
    const reference = refugee.references.find(item => item.start === offset && item.text === member);
    assert.deepEqual([reference?.family, reference?.targetCongress, reference?.targetLaw, reference?.targetPath],
      ["public-law", "96", "422", targetPath], `Quoted section hierarchy owns ${phrase}`);
  }
}
verifyRefugee();
const investorBenefits = corpus.title8.sections.find(section => section.section === "1186b").notes.find(note => note.heading === "Immigration Benefits");
assert(investorBenefits, "The original multi-section investor-benefits quotation is present");
const internalClauses = investorBenefits.text.indexOf("clause (i), (ii), or (iii) of subparagraph (A)");
assert(internalClauses >= 0);
for (const label of ['i', 'ii', 'iii']) {
  const offset = investorBenefits.text.indexOf(`(${label})`, internalClauses);
  const reference = investorBenefits.references.find(item => item.start === offset);
  assert.deepEqual([reference?.family, reference?.targetCongress, reference?.targetLaw, reference?.targetPath],
    ['public-law','107','273',['dC','tI','s11031','c','1','A',label]], 'A quoted law retains ownership of its own subparagraph despite neighboring INA citations');
}
const addedProvision = corpus.title8.sections.find(section => section.section === "1101").notes.find(note => note.text.includes("as added by") && note.text.includes("subsections (b)(4) and (d) of section 601"));
assert(addedProvision, "Original added-provision example must be available");
for (const reference of addedProvision.references.filter(item => ["(b)(4)", "(d)", "section 601"].includes(item.text))) {
  assert.deepEqual([reference.family, reference.targetCongress, reference.targetLaw], ["public-law", "94", "484"], "A later adding Act is provenance; the quotation belongs to the original Act");
}
const parallelProvision = corpus.title8.sections.flatMap(section => section.notes || []).find(note => note.text.includes("motion to reopen pursuant to section 240(c)(6)(C)(iv)"));
assert(parallelProvision, "Original explicit recodification example must be available");
const parallelReference = parallelProvision.references.find(reference => reference.text === "section 240(c)(6)(C)(iv)");
assert.deepEqual([parallelReference?.family, parallelReference?.targetTitle, parallelReference?.targetSection, parallelReference?.targetPath],
  ["usc", "8", "1229a", ["c", "7", "C", "iv"]], "An explicit adjacent Code recodification outranks inferred quotation ownership");
const editorialProvision = corpus.title8.sections.find(section => section.section === "1153").notes.find(note => note.heading === "Entitlement to Preferential Status");
const editorialAt = editorialProvision.text.indexOf("section 203(a) [subsec. (a) of this section]");
assert(editorialAt >= 0);
const editorialReference = editorialProvision.references.find(reference => reference.start === editorialAt);
assert.deepEqual([editorialReference?.family, editorialReference?.targetTitle, editorialReference?.targetSection, editorialReference?.targetPath],
  ["usc", "8", "1153", ["a"]], "A publisher's adjacent subsection-of-this-section bracket refers to the host Code");
const bracketAt = editorialProvision.text.indexOf("(a)", editorialAt + "section 203(a)".length);
const bracketReference = editorialProvision.references.find(reference => reference.start === bracketAt);
assert.deepEqual([bracketReference?.family, bracketReference?.targetTitle, bracketReference?.targetSection, bracketReference?.targetPath],
  ["usc", "8", "1153", ["a"]], "The editorial bracket's own relative locator also retains the host Code context");
function verifyDivision() {
  const codification = corpus.title8.divisionNotes["/us/usc/t8/ch7"].notes.find(note => note.topic === "codification");
  assert.equal(codification.uslmReferences.length, 6);
  for (const source of codification.uslmReferences) {
    const reference = codification.references?.find(item => item.start === source.start && item.end === source.end);
    const address=source.houseHref.match(/^\/us\/stat\/([^/]+)\/([^/]+)/);
    if(address) {
      assert.equal(reference?.targetVolume,address[1]);
      assert.equal(reference?.targetPage,address[2]);
      assert.equal(reference?.resolution,"official-source-only",`Division source reference ${source.text} must be navigable`);
    } else assert.equal(reference?.houseHref,source.houseHref);
    assert.equal(reference?.text, source.text);
    assert(reference.officialUrl.startsWith("https://www.govinfo.gov/"));
  }
}
verifyDivision();
packLegalReferences(corpus);
unpackLegalReferences(corpus);
verifyRefugee();
verifyDivision();
const quotedScopes = sourceNotes.flatMap(note => flatten(note.layout).filter(node => node.tag === "quotedContent"));
assert.equal(quotedScopes.length, 648, "Every source quotation must participate in the regression");
const leakedCodeReferences = corpus.title8.sections.flatMap(section => section.notes || []).flatMap(note => {
  const quotes = flatten(note.layout || []).filter(node => node.tag === "quotedContent");
  return (note.references || []).filter(reference => ["context-bare-usc-section", "context-bare-usc-address"].includes(reference.ruleId) && quotes.some(quote => quote.start <= reference.start && quote.end >= reference.end));
});
assert.deepEqual(leakedCodeReferences, [], "Bare references in source quotations cannot infer the host Code from coinciding numbers");

// Boundary and ambiguity cases augment the real-source regression. Origin is
// deliberately a different law: it identifies provenance, not quoted authority.
const text = "Pub. L. 96-422, § 101, provided: “(a) Outer section 103. section 103 of title 8. section 201 of the Immigration and Nationality Act. subsection (b) of this section. " +
  "Pub. L. 100-1, § 2, provided: ‘Nested section 103.’ " +
  "Inserted text: ‘Unidentified section 103.’ Outer again section 103.” Outside section 103.";
const span = (tag, value, children = [], extra = {}) => {
  const start = text.indexOf(value);
  assert(start >= 0);
  return { tag, start, end: start + value.length, children, ...extra };
};
const nestedText = "‘Nested section 103.’";
const unknownText = "‘Unidentified section 103.’";
const quoteText = text.slice(text.indexOf("“"), text.indexOf("”") + 1);
const synthetic = { id: "quoted-boundaries", text, layout: [{ tag: "p", start: 0, end: text.length, children: [
  span("ref", "Pub. L. 96-422, § 101", [], { href: "/us/pl/96/422/s101" }),
  span("quotedContent", quoteText, [span("subsection", quoteText.slice(1), [
    span("num", "(a)", [], { value: "a" }),
    span("p", `Pub. L. 100-1, § 2, provided: ${nestedText}`, [span("ref", "Pub. L. 100-1, § 2", [], { href: "/us/pl/100/1/s2" }), span("quotedContent", nestedText)]),
    span("p", `Inserted text: ${unknownText}`, [span("quotedContent", unknownText)])
  ])], { origin: "/us/pl/114/95/s9215" })
] }] };
synthetic.references = sourceAnchors(synthetic);
const boundaryCorpus = { title8: { sections: [{ title: 8, section: "9000", body: [], notes: [synthetic] }, { title: 8, section: "103", body: [] }, { title: 8, section: "1151", body: [] }], },
  inaCrosswalk: [{ inaSection: "201", uscSection: "1151" }], namedActs: [], cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(boundaryCorpus);
const referenceAt = phrase => {
  const at = text.indexOf(phrase) + phrase.indexOf("103");
  return synthetic.references.find(reference => reference.start <= at && reference.end >= at + 3);
};
for (const phrase of ["Outer section 103", "Outer again section 103"]) {
  const reference = referenceAt(phrase);
  assert.deepEqual([reference?.family, reference?.targetCongress, reference?.targetLaw, reference?.targetPath], ["public-law", "96", "422", ["s103"]]);
}
const nested = referenceAt("Nested section 103");
assert.deepEqual([nested?.family, nested?.targetCongress, nested?.targetLaw, nested?.targetPath], ["public-law", "100", "1", ["s103"]], "A nested quote uses its own introducing authority");
assert.equal(referenceAt("Unidentified section 103"), undefined, "A nested quote cannot silently inherit the outer Act or Code");
for (const phrase of ["section 103 of title 8", "Outside section 103"]) {
  const reference = referenceAt(phrase);
  assert.deepEqual([reference?.family, reference?.targetTitle, reference?.targetSection], ["usc", "8", "103"], "Explicit Code scope and text outside quotations retain their own authority");
}
const relative = synthetic.references.find(reference => reference.text === "(b)");
assert.deepEqual([relative?.family, relative?.targetCongress, relative?.targetLaw, relative?.targetPath], ["public-law", "96", "422", ["s101", "b"]], "This section refers to the quoted source section, not the host Code section");
const external = synthetic.references.find(reference => reference.text === "201");
assert.equal(external?.targetSection, "1151", "An expressly named external Act keeps its own citation context");
console.log(`PASS original USLM references: ${sourceNotes.length} quoted notes, 648 quote scopes, seven Refugee Act citations, nested scope boundaries, and six division source anchors`);
