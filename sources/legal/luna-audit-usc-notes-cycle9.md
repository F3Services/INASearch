# Cycle 9 delta confirmation of generated Title 8 note and annotation references

Audit date: 2026-08-23
Artifact: `INASearch-Uncompressed.html`
Build signature: `172f5bebc4bf400a69b8e71f`
Artifact SHA-256: `19b311df645d3d092b3b7f2a153cab2574b025461be3814737944b14241063f5`
Comparison baseline: clean Cycle 8, build `1c0a8d07e6574b27e30122e3`

## Result

The current inventory contains 17,267 generated Title 8 note, annotation, preamble, source-credit, heading, and House editorial-footnote references, and 2,543 parenthetical/anaphoric candidates. The Cycle 9 delta is clean: no added or removed in-scope reference records and no changed note/annotation targets requiring a flag were found. The flags file is header-only: [luna-audit-usc-notes-cycle9-flags.tsv](luna-audit-usc-notes-cycle9-flags.tsv).

## Frozen enumeration and delta method

I extracted and parsed the `inaSearchCorpusData` JSON from the current artifact, called `unpackLegalReferences()` from `tools/pack-legal-references.js`, and made one bounded walk of all 376 `title8.sections`. The walk visited every `notes[*]` and `houseEditorialFootnotes[*]` object and every section-level `headingReferences`, `preambleReferences`, and `sourceCreditReferences` array. Operative USC body content and CFR trees were excluded. Each record was keyed for delta review by source ID, source path/field, offset, end span, and exact text; target-family, resolution, section, nested path, and official-source identity were compared for each key. The enumeration and delta review were frozen before writing this report.

Coverage by containing field:

| containing field | references |
| --- | ---: |
| `notes[*].references` | 14,561 |
| `notes[*].headingReferences` | 15 |
| `section.headingReferences` | 109 |
| `section.sourceCreditReferences` | 2,529 |
| `section.preambleReferences` | 49 |
| `houseEditorialFootnotes[*].references` | 4 |
| **total** | **17,267** |

The current target-family/resolution totals are:

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

Parenthetical/anaphoric candidate coverage:

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

These totals match the clean Cycle 8 inventory. The bounded target comparison found no note/annotation target-family, title/section, nested-path, historical-authority, or official-source-only regression.

## Retained adjudications

The prior clean adjudications remain unchanged: INA §322(d) is now correctly linked to local 8 U.S.C. §1433(d); INA §404(b)(2) follows the crosswalk-supported 8 U.S.C. §1101 note with an empty path and official-source-only resolution; Nationality Act of 1940 §325(a) correctly targets original 54 Stat. 1137; and International Security and Development Assistance Act of 1980 §405(c)(2) remains a clean official historical named-Act search. The remaining generic historical named-Act searches likewise remain appropriately official-source-only. No new suspect span was identified.

No parser, product code, or corpus files were changed.
