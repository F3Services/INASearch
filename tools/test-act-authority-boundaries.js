#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { applyGeneratedLegalReferences } = require("./legal-references");
const { packLegalReferences, unpackLegalReferences } = require("./pack-legal-references");

const note = {
  id: "8-1227-note-2", topic: "referencesInText", heading: "References in Text",
  text: "This chapter was in the original this Act, meaning act June 27, 1952, ch. 477, 66 Stat. 163, known as the Immigration and Nationality Act. " +
    "The Alien Registration Act, 1940, referred to in subsec. (a)(3)(B)(i), is act June 28, 1940, ch. 439, 54 Stat. 670. " +
    "Section 36(a) of that act was classified to section 457(c) of this title and was repealed by section 403(a)(39) of act June 27, 1952. " +
    "The Foreign Agents Registration Act of 1938, referred to in subsec. (a)(3)(B)(ii), is act June 8, 1938, ch. 327, 52 Stat. 631, " +
    "which is classified generally to subchapter II (§ 611 et seq.) of chapter 11 of Title 22."
};
const body = "(i) under section 36(c) of the Alien Registration Act, 1940,\n\n" +
  "(ii) of a violation of, or an attempt or a conspiracy to violate, any provision of the Foreign Agents Registration Act of 1938 (22 U.S.C. 611 et seq.). " +
  "Another section 403(a)(39) of act January 1, 1950, has no verified authority in this corpus.";
const source = { title: 8, section: "1227", heading: "Deportable aliens", body: [{ label: "a", text: body }], notes: [note] };
const alienActAuthority = { title: 8, section: "1302", heading: "Registration of aliens", notes: [{ id: "alien-act-identity",
  text: "The Alien Registration Act, 1940, is act June 28, 1940, ch. 439, 54 Stat. 670." }] };
const reusedNumber = { title: 8, section: "403", status: "repealed", heading: "Former provision", body: [{ label: "a", children: [{ label: "39", text: "Unrelated Code section." }] }],
  historical: { versionLabel: "1940 U.S. Code, Title 8" } };
const corpus = { title8: { sections: [source, alienActAuthority, reusedNumber] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(corpus);

function selectedReferences() {
  const alien = note.references.find(reference => reference.text === "36(a)");
  const repeal = note.references.find(reference => reference.text === "section 403(a)(39)");
  return { alien, repeal };
}
function verify() {
  const { alien, repeal } = selectedReferences();
  assert.deepEqual([alien?.family, alien?.targetVolume, alien?.targetPage, alien?.targetPath],
    ["statutes-at-large", "54", "670", ["section-36", "a"]],
    "section 36(a) must remain part of the Alien Registration Act, not the following Foreign Agents Act");
  assert.deepEqual([repeal?.family, repeal?.targetCongress, repeal?.targetLaw, repeal?.targetPath],
    ["public-law", "82", "414", ["s403", "a", "39"]],
    "section 403(a)(39) of the June 27, 1952 Act must identify INA's source Act, not former 8 U.S.C. 403");
  assert.equal(repeal?.resolution, "official-source-only");
  assert(!source.body[0].references.some(reference => reference.text === "section 403(a)(39)"),
    "an unidentified dated Act must not fall back to the unrelated local Code number");
}
verify();
packLegalReferences(corpus);
unpackLegalReferences(corpus);
verify();

const sourceLawNote = (id, law, sourceSection, text) => {
  const prefix = `Pub. L. ${law}`;
  return { id, topic: "effectiveDate", text: `${prefix}, § ${sourceSection}, provided that: “${text}”`, references: [{
    id: `${id}-authority`, start: 0, end: prefix.length, text: prefix,
    family: "public-law", targetKind: "public-law", targetCongress: law.split("-")[0], targetLaw: law.split("-")[1],
    targetPath: [`s${sourceSection}`], resolution: "official-source-only", provenance: "house-uslm-ref", ruleId: "house-uslm-ref",
    houseHref: `/us/pl/${law.replace("-", "/")}/s${sourceSection}`
  }] };
};
const note1990 = sourceLawNote("1990", "101-649", "161", "The amendments made by paragraphs (5) and (13) of section 603(a) shall apply to applications made on or after June 1, 1991.");
const note1977 = sourceLawNote("1977", "94-484", "602", "The amendments made by subsections (b)(4) and (d) of section 601 shall apply on and after January 10, 1978.");
const sourceActCorpus = { title8: { sections: [
  { title: 8, section: "1101", heading: "Definitions", notes: [note1990, note1977], body: [] },
  { title: 8, section: "603", status: "repealed", historical: { versionLabel: "1940 U.S. Code, Title 8" }, body: [{ label: "a", children: [{ label: "5" }, { label: "13" }] }] },
  { title: 8, section: "601", status: "repealed", historical: { versionLabel: "1940 U.S. Code, Title 8" }, body: [{ label: "b", children: [{ label: "4" }] }, { label: "d" }] }
] }, inaCrosswalk: [], namedActs: [], sources: {}, cfr: { sections: [], parts: [] } };
applyGeneratedLegalReferences(sourceActCorpus);
const assertSourceAct = () => {
  const n1990 = note1990.references.filter(reference => ["(5)", "(13)"].includes(reference.text));
  assert.deepEqual(n1990.map(reference => [reference.family, reference.targetCongress, reference.targetLaw, reference.targetPath]), [
    ["public-law", "101", "649", ["s603", "a", "5"]], ["public-law", "101", "649", ["s603", "a", "13"]]
  ], "1990 source-Act paragraphs must retain Public Law 101-649 despite former USC 603");
  const n1977 = note1977.references.filter(reference => ["(b)(4)", "(d)"].includes(reference.text));
  assert.deepEqual(n1977.map(reference => [reference.family, reference.targetCongress, reference.targetLaw, reference.targetPath]), [
    ["public-law", "94", "484", ["s601", "b", "4"]], ["public-law", "94", "484", ["s601", "d"]]
  ], "1977 source-Act subsections must retain Public Law 94-484 despite former USC 601");
};
assertSourceAct();
packLegalReferences(sourceActCorpus);
unpackLegalReferences(sourceActCorpus);
assertSourceAct();
console.log("PASS Act authority boundaries: historical alien registration and 1952 INA repeal citations");
