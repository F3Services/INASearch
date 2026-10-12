#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { applyHistoricalReferences } = require("./historical-ina");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");

const historical = (year, page) => ({
  versionLabel: `${year} U.S. Code, Title 8`,
  sourceArtifact: `sources/legal/raw/historical-usc/loc/${year}/chapter-09.pdf`,
  sourceUrl: `https://tile.loc.gov/example-${year}.pdf#page=${page}`
});
const old = {
  title: 8, section: "500", heading: "See 8 U.S.C. 243", preamble: "Compare 8 U.S.C. 244.",
  body: [{ label: "", text: "Under 8 U.S.C. 243(a), section 243 of this Act applies; see 8 U.S.C. 245 and section 243 of Public Law 70-100." }],
  historical: historical(1934, 9)
};
const sameEdition = { title: 8, section: "243", status: "repealed", heading: "Former provision", body: [{ label: "a", text: "Earlier rule." }], historical: historical(1934, 4) };
const changedEdition = { title: 8, section: "244", status: "repealed", heading: "Later provision", body: [], historical: historical(1946, 5) };
const current = { title: 8, section: "245", heading: "Current provision", body: [{ label: "a", text: "Current rule." }] };
const modernSource = { title: 8, section: "501", heading: "See 8 U.S.C. 245", body: [] };
const enactedSource = { title: 8, section: "502", heading: "See 8 U.S.C. 245", body: [], historical: {
  versionLabel: "Historical enacted text of Public Law 89-236",
  sourceArtifact: "sources/legal/raw/historical-usc/statutes/STATUTE-79-Pg911.pdf",
  sourceUrl: "https://www.govinfo.gov/content/pkg/STATUTE-79/pdf/STATUTE-79-Pg911.pdf"
} };
const former1254 = { title: 8, section: "1254", status: "repealed", heading: "Suspension of deportation", historical: historical(1995, 1),
  body: [{ label: "a", text: "The 1995 introductory rule.", children: [{ label: "3", text: "The former remedy." }] }] };
const datedSource = { title: 8, section: "1229a", heading: "Removal proceedings", body: [{ label: "c",
  text: "See section 1254(a)(3) of this title (as in effect on March 31, 1997)." }] };
const houseDatedText = "section 1254(a)(3) of this title (as in effect on March 31, 1997).";
const houseDatedSource = { title: 8, section: "1229b", heading: "Cancellation of removal", body: [{ label: "b", text: houseDatedText,
  references: [{ id: "house-date", start: 0, end: houseDatedText.indexOf(" of this title"),
    text: houseDatedText.slice(0, houseDatedText.indexOf(" of this title")), family: "usc", targetKind: "usc", targetTitle: "8",
    targetSection: "1254", targetPath: ["a", "3"], resolution: "local", houseHref: "/us/usc/t8/s1254/a/3",
    provenance: "house-uslm-ref", ruleId: "house-uslm-ref" }] }] };
const bracketedSource = { title: 8, section: "503", heading: "Amendment note", notes: [{ id: "n",
  text: "See section 244(a)(3) of this Act [former 8 U.S.C. 1254(a)(3)] (as in effect before April 1, 1997)." }] };
const corpus = { title8: { sections: [old, sameEdition, changedEdition, current, modernSource, enactedSource, former1254, datedSource, houseDatedSource, bracketedSource] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(corpus);

const allOldReferences = [old.headingReferences, old.preambleReferences, ...old.body.map(node => node.references)].flat();
const at = (references, phrase) => references.find(reference => reference.text === phrase);
for (const reference of [at(old.headingReferences, "8 U.S.C. 243"), at(old.body[0].references, "8 U.S.C. 243(a)")]) {
  assert(reference, "same-edition citation should be identified");
  assert.equal(reference.resolution, "official-source-only");
  assert.equal(reference.targetEdition, "1934");
  assert.equal(reference.officialUrl, sameEdition.historical.sourceUrl);
}
for (const target of ["244", "245"]) {
  const reference = allOldReferences.find(item => item.family === "usc" && item.targetSection === target);
  assert(!reference || reference.resolution === "unresolved", `1934 source must not link to non-1934 section ${target}`);
}
const actStart = old.body[0].text.indexOf("section 243 of this Act");
const actEnd = actStart + "section 243 of this Act".length;
assert(!old.body[0].references.some(reference => ["usc", "ina"].includes(reference.family) && reference.resolution !== "unresolved" && reference.start < actEnd && reference.end > actStart), `this Act must not become a Code link: ${JSON.stringify(old.body[0].references)}`);
assert(old.body[0].references.some(reference => reference.family === "public-law" && reference.targetCongress === "70" && reference.targetLaw === "100"), "printed Public Law citation must retain its original authority");
assert.equal(at(modernSource.headingReferences, "8 U.S.C. 245")?.resolution, "local", "modern source keeps ordinary local resolution");
assert.equal(at(enactedSource.headingReferences, "8 U.S.C. 245")?.resolution, "unresolved", "historical source without a Code edition must not inherit the present Code");
assert(corpus.legalReferenceAudit.historicalEdition?.unresolved >= 3, "audit should count blocked later or reused numbers");
assert(corpus.legalReferenceAudit.historicalEdition.issues.some(issue => issue.reason === "source-edition-unknown"));
const datedReference = datedSource.body[0].references.find(reference => reference.targetSection === "1254" && reference.targetPath.join("/") === "a/3");
assert(datedReference, "explicit as-of citation should retain its former Code target");
assert.equal(datedReference.targetSection, "1254");
assert.deepEqual(datedReference.targetPath, ["a", "3"]);
assert.equal(datedReference.resolution, "official-source-only", "a 1995 body must not stand in for the law as of March 31, 1997");
assert.equal(datedReference.historicalEditionGuard, true);
assert.match(datedReference.officialUrl, /uscode\.house\.gov/);
const houseDatedReference = houseDatedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(houseDatedReference?.resolution, "official-source-only");
assert.equal(houseDatedReference.provenance, "house-uslm-ref");
assert.equal(houseDatedReference.ruleId, "house-uslm-ref");
const bracketedReferences = bracketedSource.notes[0].references.filter(reference => reference.targetSection === "1254");
assert.equal(bracketedReferences.length, 2, "both the Act citation and bracketed Code parallel should be retained");
assert(bracketedReferences.every(reference => reference.forceOfficial && reference.resolution === "official-source-only"), "the printed former-version context should mark both citations official-only");

const verified1254 = { ...structuredClone(former1254), historical: {
  ...historical(1995, 1), versionLabel: "Final former text as amended April 24, 1996",
  reviewStatus: "visually-reviewed", validFromDate: "1996-04-24", validThroughDate: "1997-03-31"
} };
const coveredDate = { title: 8, section: "1229a", heading: "Removal proceedings", body: [{ label: "c",
  text: "See section 1254(a)(3) of this title (as in effect on March 31, 1997)." }] };
const outsideDate = { title: 8, section: "1229b", heading: "Cancellation of removal", body: [{ label: "a",
  text: "See section 1254(a)(3) of this title (as in effect on April 1, 1997)." }] };
const verifiedCorpus = { title8: { sections: [verified1254, coveredDate, outsideDate] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(verifiedCorpus);
assert.equal(coveredDate.body[0].references.find(reference => reference.targetSection === "1254")?.resolution, "local", "a verified final text may serve a date inside its effective interval");
assert.equal(outsideDate.body[0].references.find(reference => reference.targetSection === "1254")?.resolution, "official-source-only", "a date beyond the verified interval cannot use local text");

applyHistoricalReferences(corpus);
for (const target of ["244", "245"]) {
  const reference = allOldReferences.find(item => item.family === "usc" && item.targetSection === target);
  assert(!reference || (reference.resolution === "unresolved" && !reference.historicalTargetId),
    `final historical postpass must not restore a link to non-1934 section ${target}`);
}
assert.equal(at(old.body[0].references, "8 U.S.C. 243(a)")?.resolution, "official-source-only", "same-edition source stays official-only");
assert.equal(at(modernSource.headingReferences, "8 U.S.C. 245")?.resolution, "local", "modern source remains local after the historical postpass");
assert.equal(datedReference.resolution, "official-source-only", "historical postpass must not restore a wrong-date local link");
assert(bracketedReferences.every(reference => reference.resolution === "official-source-only"), "historical postpass must honor the parser's former-version decision");

packLegalReferences(corpus);
unpackLegalReferences(corpus);
const unpackedDate = datedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(unpackedDate?.resolution, "official-source-only", "packed standalone data must retain the date guard");
assert.match(unpackedDate?.citationNote || "", /not verified for that date/);
assert.match(unpackedDate?.officialUrl || "", /uscode\.house\.gov/);
const unpackedHouseDate = houseDatedSource.body[0].references.find(reference => reference.targetSection === "1254");
assert.equal(unpackedHouseDate?.resolution, "official-source-only");
assert.equal(unpackedHouseDate?.ruleId, "house-uslm-ref", "guarded House citation must keep its rule through packing");
assert.equal(unpackedHouseDate?.provenance, "house-uslm-ref", "guarded House citation must keep its source provenance through packing");
assert.match(unpackedHouseDate?.citationNote || "", /not verified for that date/);

console.log("PASS historical edition reference safeguard: exact edition, reused numbers, Act authority, and current-source isolation.");
