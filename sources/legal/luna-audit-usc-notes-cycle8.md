# Cycle 8 audit of generated Title 8 note and annotation references

Audit date: 2026-08-23
Artifact: `INASearch-Uncompressed.html`
Build signature: `1c0a8d07e6574b27e30122e3`
Artifact SHA-256: `717c9ce12892b4f8b1b9e94ef69754bd04065702e258570b102a082ca16dc39a`
Corpus version: `2026.08.21-audit.2`

## Result

I reviewed 17,267 generated references in the current Title 8 notes and annotations, including note references, note headings, section headings, preambles, source credits, and House editorial-footnote references. I also reviewed all 2,543 parenthetical or anaphoric candidates identified by the candidate rules. No suspect references remain, so [luna-audit-usc-notes-cycle8-flags.tsv](luna-audit-usc-notes-cycle8-flags.tsv) contains only the required header.

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
| USC / official-source-only | 933 |
| Public Law / official-source-only | 8,277 |
| Statutes at Large / official-source-only | 3,592 |
| USC / local | 4,237 |
| Federal Register / official-source-only | 224 |
| unknown / official-source-only | 3 |
| CFR / local | 1 |
| **total** | **17,267** |

The parenthetical/anaphoric candidate inventory was frozen from the same unpacked records:

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

## Cycle 7 recheck and changed targets

The single Cycle 7 flag was rechecked against the current target. The preamble citation `322(d)` at `title8.sections[258].preambleReferences`, offset 434, now correctly targets local 8 U.S.C. §1433(d), matching the explicit bracketed codification immediately following the INA citation. It is therefore removed from the flags file.

The current build has the same total reference and candidate counts as Cycle 7. Its one relevant target-family change is the corrected §322(d) target: official-source-only USC increased by one and unknown official-source-only decreased by one. The three remaining unknown named-Act searches—Federal Aviation Act of 1958 §101(3), Immigration Act §19(c), and International Security and Development Assistance Act of 1980 §405(c)(2)—remain proper official-source-only historical searches because their surrounding text does not establish a more precise corpus authority. The prior adjudications remain accepted: Nationality Act of 1940 §325(a) targets original 54 Stat. 1137; International Security and Development Assistance Act of 1980 §405(c)(2) remains a clean named-Act search; and INA §404(b)(2) follows the crosswalk-supported 8 U.S.C. §1101 note with an empty path and official-source-only resolution.

Uninterpretable anaphora without an antecedent was not converted into a link or treated as a defect.
