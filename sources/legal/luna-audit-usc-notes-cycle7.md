# Cycle 7 audit of generated Title 8 note and annotation references

Audit date: 2026-08-23
Artifact: `INASearch-Uncompressed.html`
Build signature: `34f3380a3b7c84205c58a479`
Artifact SHA-256: `194635ccfb22f3f55d2cc4de007774eb1d6ddaf0f92688bda8d228825fa3dbec`
Corpus version: `2026.08.21-audit.2`

## Result

I reviewed 17,267 generated references in the current Title 8 notes and annotations, including note references, note headings, section headings, preambles, source credits, and House editorial-footnote references. I also reviewed all 2,543 parenthetical or anaphoric candidates identified by the candidate rules. One suspect remains, recorded in [luna-audit-usc-notes-cycle7-flags.tsv](luna-audit-usc-notes-cycle7-flags.tsv).

The one suspect is a preamble citation for INA §322(d) whose surrounding text immediately supplies the codification 8 U.S.C. §1433(d). The generated generic named-Act search should follow that explicit USC authority.

No parser, product code, or corpus files were changed.

## Frozen enumeration and coverage proof

I froze one enumeration before semantic review. I extracted and parsed the JSON in the `inaSearchCorpusData` script of the named artifact, called `unpackLegalReferences()` from `tools/pack-legal-references.js`, and walked all 376 `title8.sections` exactly once. The walk visited every `notes[*]` and `houseEditorialFootnotes[*]` object and every section-level `headingReferences`, `preambleReferences`, and `sourceCreditReferences` array. Each generated reference was counted once by its containing object and array field. Operative USC body content and CFR trees were excluded.

The field totals are:

| containing field | references |
| --- | ---: |
| `notes[*].references` | 14,561 |
| `notes[*].headingReferences` | 15 |
| `section.headingReferences` | 109 |
| `section.sourceCreditReferences` | 2,529 |
| `section.preambleReferences` | 49 |
| `houseEditorialFootnotes[*].references` | 4 |
| **total** | **17,267** |

The family and resolution totals independently sum to the same inventory:

| target family / resolution | count |
| --- | ---: |
| USC / official-source-only | 932 |
| Public Law / official-source-only | 8,277 |
| Statutes at Large / official-source-only | 3,592 |
| USC / local | 4,237 |
| Federal Register / official-source-only | 224 |
| unknown / official-source-only | 4 |
| CFR / local | 1 |
| **total** | **17,267** |

The parenthetical/anaphoric candidate inventory was frozen from the same unpacked records. Its rule counts are:

| candidate rule | count |
| --- | ---: |
| embedded numbered-section list | 271 |
| embedded inferred unit | 588 |
| embedded explicit container | 245 |
| embedded named-Act section | 1,186 |
| embedded named-instrument section | 3 |
| `this section` context path | 190 |
| `such` container | 48 |
| `this` container | 12 |
| **total candidates** | **2,543** |

## Cycle 6 recheck

All 12 Cycle 6 flags were explicitly rechecked against the current targets. None remains a defect:

- The two former INA §244 references now target official-source-only 8 U.S.C. §1254(a) and §1254(a)(3), preserving the historical codification.
- The old INA §309(a) reference now targets official-source-only 8 U.S.C. §1409(a), preserving the historical-version distinction from the new section.
- INA §404(b)(2) now targets 8 U.S.C. §1101 with an empty path and official-source-only resolution. This is accepted under the crosswalk evidence locating that Act section at the §1101 note.
- INA §203(b)(5)(E), §212(a)(3)(B)(vi)(II), former OFPP Act §4(1), the appropriations Act §610(c), CIPA §1(a), the Alien Registration Act §36(a), and Reform Act §402(3)(A) now follow the explicit USC, Public Law, or Statutes at Large evidence in their surrounding text.
- The two Nationality Act of 1940 §325(a) references remain correctly targeted to original 54 Stat. 1137, official-source-only.
- International Security and Development Assistance Act of 1980 §405(c)(2) remains a clean official historical named-Act search because no precise corpus authority is established.

The current build added one reference to the frozen inventory and increased the named-Act candidate count by one. The changed/new targets were checked once; the only additional suspect is the §322(d) preamble reference in the TSV. The remaining generic named-Act searches for the Federal Aviation Act of 1958 §101(3), Immigration Act §19(c), and International Security and Development Assistance Act of 1980 §405(c)(2) remain official-source-only: each is a historical named-Act citation, and the local text does not establish a more precise corpus authority for that cited historical source. Uninterpretable anaphora without an antecedent was not converted into a link or treated as a defect.
