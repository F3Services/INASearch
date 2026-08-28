# Cycle 6 audit of generated Title 8 note references

Audit date: 2026-08-23
Artifact: `INASearch-Uncompressed.html`
Build signature: `add0bc621f6bac45f3cf8f5c`
Artifact SHA-256: `36f3eadf289a202ec3847e1f855bdcd0155ebb0059093865d4abbb3252d7ca03`
Corpus version: `2026.08.21-audit.2`

## Result

I reviewed 17,266 generated references in the current Title 8 notes, headings, source credits, preambles, and House editorial footnotes. I also reviewed all 2,542 parenthetical or anaphoric candidates identified by the candidate rules. Twelve references remain suspect; they are recorded in [luna-audit-usc-notes-cycle6-flags.tsv](luna-audit-usc-notes-cycle6-flags.tsv). No parser, product code, or corpus files were changed.

The 12 suspects consist of three carried forward from Cycle 5 and nine newly identified in the current build. The three carried findings are two historical INA section 244 citations and one historical INA section 309 citation that resolve to current/local USC targets without preserving the historical version. The nine new findings are generated named-Act searches where the surrounding text supplies a more precise USC, Public Law, or Statutes at Large authority, or where an INA section has an explicit codified counterpart.

## Frozen enumeration and coverage proof

The enumeration was frozen once before semantic review. I read the JSON in the `inaSearchCorpusData` script of the named artifact, parsed it, and called `unpackLegalReferences()` from `tools/pack-legal-references.js`. I then walked all 376 `title8.sections` exactly once. Within each section I visited every note object and every House editorial-footnote object, plus section-level `headingReferences`, `preambleReferences`, and `sourceCreditReferences`. Each generated reference was counted once by its containing object and array field. Operative USC body content and all CFR trees were excluded.

The inventory covered 2,455 note objects, 118 House editorial-footnote objects, 81 populated preamble fields, and 286 populated source-credit fields. The field totals are:

| containing field | references |
| --- | ---: |
| `notes[*].references` | 14,560 |
| `notes[*].headingReferences` | 15 |
| `section.headingReferences` | 109 |
| `section.sourceCreditReferences` | 2,529 |
| `section.preambleReferences` | 49 |
| `houseEditorialFootnotes[*].references` | 4 |
| **total** | **17,266** |

The generated target resolution was local for 4,248 references and official-source-only for 13,018. The family counts below sum to the same 17,266 total and provide an independent coverage check:

| field / target family | count |
| --- | ---: |
| notes / official USC | 906 |
| notes / official Public Law | 6,927 |
| notes / official Statutes at Large | 2,292 |
| notes / local USC | 4,200 |
| notes / official Federal Register | 220 |
| notes / official unknown | 14 |
| notes / local CFR | 1 |
| notes / heading local USC | 7 |
| notes / heading official Public Law | 5 |
| notes / heading official USC | 3 |
| section / heading official Statutes at Large | 56 |
| section / heading official Public Law | 53 |
| section / source credit official Public Law | 1,284 |
| section / source credit official Statutes at Large | 1,241 |
| section / source credit official Federal Register | 4 |
| section / preamble local USC | 38 |
| section / preamble official Statutes at Large | 3 |
| section / preamble official USC | 7 |
| section / preamble official unknown | 1 |
| editorial / local USC | 2 |
| editorial / official Public Law | 2 |

The parenthetical/anaphoric candidate inventory was also frozen before review. Its 2,542 candidates break down as follows:

| candidate rule | count |
| --- | ---: |
| embedded numbered-section list | 271 |
| embedded inferred unit | 588 |
| embedded explicit container | 245 |
| embedded named-Act section | 1,185 |
| embedded named-instrument section | 3 |
| `this section` context path | 190 |
| `such` container | 48 |
| `this` container | 12 |
| **total candidates** | **2,542** |

## Cycle 5 recheck and current findings

All 78 Cycle 5 flag spans were re-adjudicated against the current targets. Seventy-five are no longer suspect: the current build corrected their authority family or nested path, or the surrounding evidence supports the generated official-source-only target. This includes the two Nationality Act of 1940 §325(a) references, correctly targeting original 54 Stat. 1137, and the International Security and Development Assistance Act of 1980 §405(c)(2) reference, correctly retained as a clean official historical named-Act search because no precise corpus authority is available.

Three Cycle 5 findings remain in the TSV:

| source and offset | generated span | issue |
| --- | --- | --- |
| `8-1101-note-17:7332` | `244(a)` | Former INA §244(a) is expressly identified as former 8 U.S.C. §1254(a), not current §1254a. |
| `8-1101-note-17:10241` | `244(a)(3)` | Former INA §244(a)(3) is expressly identified as former 8 U.S.C. §1254(a)(3), not current §1254a. |
| `8-1409-note-7:1170` | `309(a)` | “Old section 309(a)” and “new section 309(a)” are distinguished; the old citation must preserve historical-version context rather than use the current local link. |

The current-build delta added 143 references, principally named-Act-section candidates. The bounded review found nine additional suspects among those changed/new contexts:

| source and offset | generated span | proposed authority |
| --- | --- | --- |
| `8-1101-note-64:2461` | `404(b)(2)` | Immigration and Nationality Act §404(b)(2), official historical-act source |
| `8-1153-note-18:1140` | `203(b)(5)(E)` | local 8 U.S.C. §1153(b)(5)(E) path |
| `8-1157-note-12:22258` | `4(1)` | former 41 U.S.C. §403(1), now 41 U.S.C. §133, official-source-only |
| `8-1182-note-3:366` | `3(a)` | Public Law 102-256 §3(a) |
| `8-1182-note-14:2128` | `212(a)(3)(B)(vi)(II)` | local 8 U.S.C. §1182(a)(3)(B)(vi)(II) path |
| `8-1186b-note-10:5038` | `610(c)` | 8 U.S.C. §1153 note, official-source-only |
| `8-1189-note-2:26` | `1(a)` | Public Law 96-456 §1(a) |
| `8-1227-note-2:1667` | `36(a)` | 54 Stat. 670 §36(a), official historical source |
| `8-1364-note-8:1360` | `402(3)(A)` | Public Law 99-603 §402(3)(A) |

The remaining five current unknown named-Act candidates—Irish Peace Process Cultural and Training Program Act of 1998, Federal Aviation Act of 1958, Immigration Act, the 1986/1996 IIRIRA correction context, and the International Security and Development Assistance Act of 1980—remain official-source-only because the local text does not establish a more precise corpus authority. Uninterpretable anaphora without an antecedent was not converted into a link or treated as a defect.

The TSV is limited to the 12 suspect spans and contains the exact source path, offset, text, current target, verdict, proposed target, and rationale for each.
