#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { applyHistoricalUsc, readHistoricalUsc, readReviewedUsc } = require("./historical-usc");
const corpus = {
  title8: { sections: [
    { id: "8-1 to 18", section: "1 to 18", status: "repealed", heading: "Repealed or Omitted", notes: [{ id: "8-1 to 18-note-1", text: "Original grouped evidence" }], transferTargets: [{ source: "13", title: 22, section: "1731" }] },
    { id: "8-351 to 416", section: "351 to 416", status: "repealed", heading: "Repealed or transferred", notes: [] },
    { id: "8-1484 to 1487", section: "1484 to 1487", status: "repealed", heading: "Repealed", notes: [] },
    { id: "8-1484", section: "1484", status: "repealed", heading: "Reviewed heading", body: [{ label: "a", text: "Reviewed text" }], historical: { originalTitle: "Reviewed heading" } },
    { id: "8-52", section: "52", status: "repealed", heading: "Repealed", notes: [{ id: "8-52-note-1", text: "The House explanation" }] }
  ] }
};
const data = { groups: [
  { section: "1 to 18", members: [
    { section: "1", status: "repealed", heading: "Citizenship of persons born in the United States", noteIds: ["8-1 to 18-note-3"], statusReason: { text: "Section 1 was repealed.", sourceNoteIds: ["8-1 to 18-note-3"], sourceUrl: "https://example.org/1" } },
    { section: "13", status: "transferred", heading: "Protection of citizens abroad", noteIds: ["8-1 to 18-note-13"], statusReason: { text: "Sections 13 and 14 were transferred.", sourceNoteIds: ["8-1 to 18-note-13"], sourceUrl: "https://example.org/13" } }
  ] },
  { section: "351 to 416", members: [
    { section: "351", status: "repealed", heading: "Bureau of Naturalization", noteIds: [] },
    { section: "392a", status: "transferred", heading: "Veterans naturalization", noteIds: [] }
  ] },
  { section: "1484 to 1487", members: [{ section: "1484", status: "repealed", heading: "Different heading", noteIds: [] }] }
], singles: [{ section: "52", status: "repealed", heading: "Former fees", headingSource: { sourceUrl: "https://example.org/heading" }, body: [{ label: "", text: "Unreviewed OCR" }], historical: { originalTitle: "Former fees", sourceUrl: "https://example.org/ocr" }, noteIds: ["8-52-note-1"], statusReason: { text: "The House explanation", sourceNoteIds: ["8-52-note-1"] } }] };
applyHistoricalUsc(corpus, data, { sections: [
  { uscSection: "1", originalTitle: "Same; persons born in United States", units: [{ path: [], text: "Reviewed citizenship body" }] },
  { uscSection: "52", originalTitle: "Visually reviewed fees", units: [{ path: [], text: "Reviewed statutory body" }], sourceUrl: "https://example.org/reviewed" }
] });
const sections = new Map(corpus.title8.sections.map(s => [s.section, s]));
for (const group of data.groups) assert(!sections.has(group.section), `Group remained browsable: ${group.section}`);
assert.equal(sections.get("1").status, "repealed");
assert.equal(sections.get("1").heading, "Citizenship of persons born in the United States");
assert.equal(sections.get("1").historical.originalTitle, "Same; persons born in United States");
assert.equal(sections.get("13").status, "transferred");
assert.deepEqual(sections.get("13").transferTargets, [{ source: "13", title: 22, section: "1731" }]);
assert.deepEqual(sections.get("13").statusReason.sourceNoteIds, ["8-1 to 18-note-13"]);
assert.equal(sections.get("392a").status, "transferred");
assert.equal(sections.get("1484").heading, "Reviewed heading");
assert.equal(sections.get("1484").body[0].text, "Reviewed text");
assert.equal(sections.get("52").heading, "Visually reviewed fees");
assert.equal(sections.get("52").preamble, "Reviewed statutory body");
assert.equal(sections.get("52").historical.sourceUrl, "https://example.org/reviewed");
assert.equal(sections.get("52").headingSource.sourceUrl, "https://example.org/heading");
assert.equal(sections.get("52").statusReason.sourceNoteIds[0], "8-52-note-1");
assert.equal(corpus.historicalUsc.groupSources.length, 3);
const captured = readHistoricalUsc();
assert.equal(captured.groups.length, 44);
assert.equal(captured.coverage.sectionCount, 496);
assert.equal(captured.coverage.evidenceMemberCount, 500);
const reviewed = readReviewedUsc();
assert(reviewed.sections.some(section => section.uscSection === "16"));
assert(reviewed.sections.some(section => section.uscSection === "1186"));
const reviewedByNumber = new Map(reviewed.sections.map(section => [section.uscSection, section]));
for (const number of ["144", "148", "155", "156", "204", "206", "210", "388", "456", "457"]) {
  assert(reviewedByNumber.has(number), `Missing later-amended former section ${number}`);
}
assert.equal(reviewedByNumber.get("144").lastAmendmentDate, "1952-03-20");
assert.match(reviewedByNumber.get("144").units[0].text, /No officer or person shall have authority to make any arrest/);
assert.equal(reviewedByNumber.get("148").sourceArtifact, null);
assert.match(reviewedByNumber.get("148").units[0].text, /the facts on which claim to that status is based\.$/);
assert.match(reviewedByNumber.get("155").units[0].text, /resided continuously in the United States for seven years or more/);
assert.match(reviewedByNumber.get("156").units[0].text, /necessary for the detention of aliens\. \(b\) Any alien/);
assert.doesNotMatch(reviewedByNumber.get("156").units[0].text, /PUBLIC LAWS|Places of detention\.|81st  CONG/);
assert.doesNotMatch(reviewedByNumber.get("204").units[0].text, /; - I \(e\)|at 'least/);
assert.match(reviewedByNumber.get("206").units[0].text, /on or after January 1, 1948; and \(B\)/);
assert.equal(reviewedByNumber.get("210").units.length, 7);
assert.equal(reviewedByNumber.get("210").units[6].path[0], "g");
assert.match(reviewedByNumber.get("388").units[0].text, /Naval Auxiliary Service or the Coast Guard/);
assert.match(reviewedByNumber.get("456").units[0].text, /within ten days following such dates/);
assert.match(reviewedByNumber.get("457").units[0].text, /as required by section 35 of this Act/);
const allMembers = [...captured.singles, ...captured.groups.flatMap(group => group.members)];
const byNumber = new Map(allMembers.map(section => [section.section, section]));
const correctedCaptions = {
  "176": "Disposition of moneys received or paid for expenses of detained aliens",
  "229": "Act May 19, 1921, chapter 8, in force for imposition, collection, and enforcement of penalties; deportation of aliens entering in violation thereof",
  "233": "Nonquota immigrant",
  "377a": "Declaration of intention; inhabitants of Virgin Islands",
  "387": "Citizenship training of applicants for naturalization; reimbursement for publishing citizenship textbook",
  "394": "Hearing of certain petitions for naturalization within thirty days of election",
  "453": "Special provisions governing registration",
  "502": "General definitions for purposes of subchapter III",
  "903a": "Protection to naturalized citizens abroad",
};
for (const [number, heading] of Object.entries(correctedCaptions)) {
  assert.equal(byNumber.get(number).heading, heading, `Printed catchline for § ${number}`);
  assert(number === "176" || byNumber.get(number).historical.transcriptionCorrections?.some(c => c.field === "originalTitle"),
    `Missing page-verified title correction provenance for § ${number}`);
}
assert.match(byNumber.get("176").historical.versionLabel, /^1934 U\.S\. Code/);
assert.match(byNumber.get("107").historical.versionLabel, /^1934 U\.S\. Code/);
assert.equal(byNumber.get("107").body[0].text,
  "The commissioners of immigration at the several ports shall be appointed by the President, by and with the advice and consent of the Senate, to hold their offices for the term of four years, unless sooner removed, and until their successors are appointed.");
assert.match(byNumber.get("176").body[0].text, /^Moneys collected by the Immigration and Naturalization Service/);
assert.match(byNumber.get("176").body[0].text, /for the fiscal year in which the expenses were incurred\.$/);
assert.match(byNumber.get("104").body[0].text, /supervision and direction of the Attorney General, of the administration of the Chinese exclusion laws\.$/);
assert.doesNotMatch(byNumber.get("104").body[0].text, /Stat\.|205658/);
assert.match(byNumber.get("231").body[0].text, /^All Spanish subjects who on April 11, 1899/);
assert.match(byNumber.get("242").body[0].text, /^An alien veteran shall for the purposes of subchapter III/);
assert.match(byNumber.get("261").body[0].text, /^The authority, power, and jurisdiction/);
assert.match(byNumber.get("502").body[0].text, /^For the purposes of subchapter III/);
assert.doesNotMatch(byNumber.get("502").body[0].text, /subchapter MI|Puerto Rico,'|adoption-takes|in\., the legal custody/);
for (const section of allMembers) {
  for (const unit of section.body || []) {
    assert.doesNotMatch(unit.text, /^(?:Subject matter of this|Section, acts|Commissioners of immigration at the several ports, for whose appointment this section)/i,
      `Editorial disposition imported as body for ${section.section}`);
  }
}
assert.equal(byNumber.get("233").historical.originalTitle, "Same; nonquota immigrant.");
assert.equal(byNumber.get("903a").historical.originalTitle, "Protection to naturalized citizens abroad.");
const firstSubdivisions = {
  "167": ["Control of alien seamen", "Detention of seamen on board vessel until after inspection; detention or deportation; penalty; clearance to vessels"],
  "202": ["Immigration visas", "Authority to issue; contents"],
  "207": ["Applications for visas", "Duplicate applications; form"],
  "209": ["Visas of nonquota and preferred immigrants", "Authority to issue"],
  "211": ["Immigration quotas; determination of national origin", "Annual quota based on nationality; national origin; minimum quota"],
  "212": ["Determination of nationality; reports", "Country of birth; nationality of married persons; children"],
  "213": ["Compliance with immigration requirements; persons ineligible to citizenship; penalties", "Persons not to be admitted"],
  "220": ["Penalties and offenses", "Documents; forging, counterfeiting, etc., immigration visas or permits"],
  "399b": ["Certificate of citizenship and declaration of intention; loss; mutilation or destruction; new certificate or declaration", "Certificate of citizenship and declaration of intention; loss; mutilation or destruction; new certificate or declaration"],
  "399c": ["Certificate of citizenship; issuance to adult claiming citizenship through naturalized parent or husband; procedure; effect", "Certificate of citizenship; issuance to adult claiming citizenship through naturalized parent or husband; procedure; effect"],
  "459": ["Definitions and effective date", "Definitions"],
  "746": ["Penal provisions", "Offenses against chapter"],
};
for (const [number, [heading, caption]] of Object.entries(firstSubdivisions)) {
  const section = byNumber.get(number);
  assert.equal(section.heading, heading, `Section title for § ${number}`);
  assert(section.historical.originalTitle.includes("(a) " + caption), `Printed original catchline for § ${number}`);
  assert(section.body[0].text.startsWith(`(a) ${caption}.\n\n`), `Restored operative subdivision caption for § ${number}`);
  assert(section.body[0].text.length > caption.length + 80, `Operative text lost from § ${number}`);
}
for (const number of ["399b", "399c"]) {
  assert.equal(byNumber.get(number).historical.headingOrigin, "derived-subdivision-caption");
}
for (const section of allMembers) {
  assert.doesNotMatch(section.heading || "", /^§/, `Another section's heading imported for ${section.section}`);
  for (const unit of section.body || []) {
    assert.doesNotMatch(unit.text, /^(?:\[(?:Executed|Repealed|Omitted)[.\]]|These sections, relating)/i,
      `Editorial disposition imported as body for ${section.section}`);
  }
}
assert.match(reviewedByNumber.get("134").units[0].text, /power to refund head tax/);
assert.match(reviewedByNumber.get("371").units[0].text, /^When any alien/);
assert.equal(byNumber.get("299").heading, "Deportation officer");
const securityReviewed = ["137–4", "137–5", "137–6", "137–7", "137–8"].map(number => reviewedByNumber.get(number));
assert(securityReviewed.every(Boolean), "Individual 1950 Act sections 5–9 must have reviewed text");
assert.equal(new Set(securityReviewed.map(section => section.originalTitle)).size, 5,
  "The House's collective removal description is not five individual historical headings");
assert.deepEqual(securityReviewed.map(section => section.sourcePdfPages), [[22], [22, 23], [23], [23], [23, 24]]);
assert.deepEqual(securityReviewed[1].units.map(unit => unit.path.join("/")), ["a", "b", "c", "c/1", "c/2", "d"]);
assert.deepEqual(securityReviewed[3].units.map(unit => unit.path.join("/")), ["a", "b"]);
assert.match(securityReviewed[1].units[3].text, /section 1 \(1\) and 1 \(3\)/);
assert.match(securityReviewed[4].units[0].text, /any of the provisions of this Act, is hereby expressly declared/);
assert(securityReviewed.every(section => section.headingOrigin === "editorial-description"));
const omitted = allMembers.filter(section => section.status === "omitted");
assert.equal(omitted.length, 52);
assert(omitted.every(section => typeof section.statusReason.reasonKnown === "boolean"));
assert.equal(byNumber.get("2").statusReason.reasonKnown, false);
assert.match(byNumber.get("2").statusReason.text, /does not state a reason/);
assert.equal(byNumber.get("3a").statusReason.reasonKnown, false);
assert.match(byNumber.get("3a").statusReason.evidenceText, /^Section 3a was from act June 19, 1930/);
assert.doesNotMatch(byNumber.get("3a").statusReason.text, /Section 3b was from/);
assert.match(byNumber.get("2").body[0].text, /All persons born in the district of country formerly known as the Territory of Oregon/);
assert.doesNotMatch(byNumber.get("2").body[0].text, /\n/);
assert.equal(byNumber.get("118").statusReason.reasonKnown, true);
assert.match(byNumber.get("118").body[0].text, /^The purchase, exchange, use, maintenance/);
assert.match(byNumber.get("238").body[0].text, /^For the purpose of regulating and preventing/);
assert.match(byNumber.get("239").body[0].text, /before twelve months after the enactment of this Act/);
assert.match(byNumber.get("383").body[0].text, /upon notice to the Bureau of Naturalization\.$/);
assert.equal(byNumber.get("16").heading, "Right of expatriation during time of war");
assert.equal(byNumber.get("703").heading, "Racial eligibility for naturalization");
assert.match(byNumber.get("381").statusReason.text, /^Sections 381 and 382\(c\), relating to oaths/);
assert.match(byNumber.get("382").statusReason.text, /^Sections 381 and 382\(c\), relating to oaths/);
assert.match(byNumber.get("31").statusReason.text, /Title 52, Voting and Elections\.$/);
assert.match(byNumber.get("204a").body[0].text, /^A native of the Virgin Islands/);
assert.match(byNumber.get("504").body[0].text, /^For the purposes of sections 601/);
assert.match(byNumber.get("719").body[0].text, /naturalization of said parent\.$/);
assert.doesNotMatch(byNumber.get("337").body[0].text, /\(R\. S\./);
assert.doesNotMatch(byNumber.get("49").body[0].text, /\(R\. S\./);
assert.doesNotMatch(byNumber.get("212c").body[0].text, /So in original|4506°-47/);
assert.match(byNumber.get("212c").historical.sourceFootnote, /Probably should read/);
const securityAct = captured.groups.find(g => g.section === "132 to 137–10");
assert.match(securityAct.members.find(s => s.section === "137–1").body[0].text, /paragraph \(2\) of section 1/);
assert.match(securityAct.members.find(s => s.section === "137–7").body[0].text, /knowingly aids or assists any alien/);
assert.match(securityAct.members.find(s => s.section === "137–8").body[0].text, /inconsistent with any of the provisions/);
assert.match(securityAct.members.find(s => s.section === "137–9").body[0].text, /membership or affiliation which is or was voluntary/);
assert.match(securityAct.members.find(s => s.section === "137–10").body[0].text, /ninth proviso of section 3/);
// Current publisher annotations belong to their exact fields. Replacing a
// repeal heading with historical text must not retarget those old ranges.
const fs = require("node:fs"), vm = require("node:vm");
const originalData = { window: {} };
for (const name of ["Corpus", "Statute-Footnotes", "Statute-References"])
  vm.runInNewContext(fs.readFileSync(`src/INASearch-${name}.js`, "utf8"), originalData);
const originalCorpus = originalData.window.INA_SEARCH_CORPUS;
require("./statute-footnotes").applyStatuteFootnotes(originalCorpus, originalData.window.INA_SEARCH_STATUTE_FOOTNOTES);
require("./statute-references").applyStatuteReferences(originalCorpus, originalData.window.INA_SEARCH_STATUTE_REFERENCES);
require("./historical-ina").applyHistoricalIna(originalCorpus);
require("./statute-status").applyStatuteStatusMetadata(originalCorpus);
const before = new Map(originalCorpus.title8.sections.map(section => [section.section, structuredClone(section)]));
applyHistoricalUsc(originalCorpus, captured, reviewed);
let replacedHeadings = 0, obsoleteHeadingReferences = 0;
for (const section of originalCorpus.title8.sections) {
  const previous = before.get(section.section);
  if (!previous || previous.heading === section.heading) continue;
  for (const reference of section.headingReferences || [])
    assert(reference.start >= 0 && reference.end <= section.heading.length && section.heading.slice(reference.start, reference.end) === reference.text,
      `Historical §${section.section} heading has a reference outside its replacement source text`);
  for (const suffix of ["References", "FootnoteReferences", "Layout", "Presentation", "Style"])
    assert(!Object.hasOwn(section, `heading${suffix}`), `Historical §${section.section} retains obsolete heading${suffix}`);
  assert.deepEqual(structuredClone(section.source), previous.source, `Historical §${section.section} must retain original publisher provenance`);
  obsoleteHeadingReferences += previous.headingReferences?.length || 0;
  replacedHeadings++;
}
assert(replacedHeadings > 0 && obsoleteHeadingReferences > 0, "Original publisher regression must exercise reference-bearing replaced headings");
const replacedText = { title8: { sections: [{ id: "8-52", section: "52", heading: "Current heading", preamble: "Current text", body: [{}], childTextOffsets: [12],
  preambleReferences: [{ start: 0, end: 12, text: "Current text" }], preambleFootnoteReferences: [{ offset: 12 }],
  preambleLayout: [{ tag: "p", start: 0, end: 12 }], preamblePresentation: { italic: true }, preambleStyle: { "font-style": "italic" } }] } };
applyHistoricalUsc(replacedText, { groups: [], singles: [{ section: "52", heading: "Historical heading" }] },
  { sections: [{ uscSection: "52", originalTitle: "Historical heading", units: [{ path: ["a"], text: "Historical body" }] }] });
const replacement = replacedText.title8.sections[0];
assert(!Object.hasOwn(replacement, "preamble"), "Replacing a body must remove the former source's preamble when the new text has none");
for (const key of ["childTextOffsets", "preambleReferences", "preambleFootnoteReferences", "preambleLayout", "preamblePresentation", "preambleStyle"])
  assert(!Object.hasOwn(replacement, key), `Replacing statutory text must clear obsolete ${key}`);
// The current House explanation accompanying a historical provision keeps its
// current Code scope. Its untagged range comes from the original USLM record.
const oldSection = originalCorpus.title8.sections.find(section => section.section === "724a");
const currentNote = oldSection.notes.find(note => note.sourceNoteId === "8-701 to 724a-note-26");
assert(currentNote.text.endsWith("See section 1440(a)–(c) of this title."));
for (const current of [true, false]) {
  const note = structuredClone(currentNote);
  if (!current) note.source.url = note.source.url.replace("edition=prelim", "edition=1948");
  const fixture = { title8: { sections: [
    { ...structuredClone(oldSection), heading: "", preamble: "", body: [], notes: [note] },
    { ...structuredClone(originalCorpus.title8.sections.find(section => section.section === "1440")), notes: [] }
  ] } };
  require("./legal-references").applyGeneratedLegalReferences(fixture);
  const reference = note.references.find(reference => reference.text === "section 1440(a)");
  if (current) {
    assert(reference, "Current House note must not inherit its historical operative section's source scope");
    assert.equal(reference.targetTitle, "8");
    assert.equal(reference.targetSection, "1440");
    assert.deepEqual(reference.targetPath, ["a"]);
  } else assert(!reference, "A historical note source must retain historical authority restrictions");
}
console.log(`Historical USC transform tests passed; ${replacedHeadings} replacement headings clear ${obsoleteHeadingReferences} obsolete source references.`);
