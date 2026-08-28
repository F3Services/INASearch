# Luna cycle-5 audit: generated Title 8 note and editorial references

Audit date: 2026-08-23. Audited artifact: `INASearch-Uncompressed.html`, current rebuilt corpus (`corpusVersion` `2026.08.21-audit.2`, `verifiedAt` `2026-08-21`, build signature `dd5781b0ad88deceb1031e84`). Extracted HTML SHA-256: `f63cb6c1194f7687a4c33e9df51cefa34a43c9d3e223752a8196319c02801814`. Product code and corpus inputs were not modified.

## Scope and frozen enumeration

The audit covers all non-operative Title 8 material in the artifact: 376 Title 8 sections, 2,455 note objects, 118 House editorial-footnote objects, 81 populated preamble fields, and 286 populated source-credit fields. Operative USC body text and CFR operative trees were excluded.

I froze one enumeration before semantic review. The collector extracted and parsed the JSON in the `script` element whose id is `inaSearchCorpusData`, called `unpackLegalReferences()` from `tools/pack-legal-references.js`, and traversed every Title 8 section. It counted each reference once by its containing object and array:

| containing field | references |
|---|---:|
| notes.references | 14,419 |
| section.headingReferences | 109 |
| notes.headingReferences | 15 |
| section.sourceCreditReferences | 2,527 |
| section.preambleReferences | 49 |
| editorial-footnote.references | 4 |
| **total** | **17,123** |

The frozen inventory contains 12,846 official-source-only references and 4,277 local references. Its family totals are:

| material/family | count |
|---|---:|
| note references: local USC | 4,228 |
| note references: local CFR | 1 |
| note references: official USC | 933 |
| note references: Public Law | 6,725 |
| note references: Statutes at Large | 2,290 |
| note references: Federal Register | 220 |
| note references: unknown named Act | 22 |
| note heading references: local USC | 7 |
| note heading references: official USC | 3 |
| note heading references: Public Law | 5 |
| section heading references: Public Law | 53 |
| section heading references: Statutes at Large | 56 |
| section source-credit references: Public Law | 1,282 |
| section source-credit references: Statutes at Large | 1,241 |
| section source-credit references: Federal Register | 4 |
| section preamble references: local USC | 39 |
| section preamble references: official USC | 7 |
| section preamble references: Statutes at Large | 3 |
| editorial-footnote references: local USC | 2 |
| editorial-footnote references: Public Law | 2 |

Parenthetical/anaphoric candidate coverage was counted by generated semantic rule, not by every ordinary parenthesis. The frozen candidate total is **2,399**:

- `embedded-numbered-section-list`: 271
- `embedded-inferred-unit`: 588
- `embedded-explicit-container`: 245
- `embedded-named-act-section`: 1,042
- `embedded-named-instrument-section`: 3
- `context-path-this-section`: 190
- `embedded-such-container`: 48
- `embedded-this-container`: 12

All 2,399 generated candidate spans were reviewed against the enclosing authority, title/section, nested path, and surrounding anaphora. The remaining 14,724 generated references were checked from their explicit or House-USLM authority family and frozen source span.

## Findings

I found **78 suspect references**, recorded one row per exact span in [luna-audit-usc-notes-cycle5-flags.tsv](luna-audit-usc-notes-cycle5-flags.tsv). The flags are limited to incorrect or materially misleading generated targets; no row is included merely because a historical Act lacks a codified counterpart.

Relative to the preceding provisional pass, **72 findings were pre-existing and rechecked**. Six rows are newly added to this independent cycle-5 adjudication: two INA §244 references that were assigned to the distinct §244A/8 U.S.C. §1255a path, two historical Nationality Act §325(a) references, Refugee Education Assistance Act §101(3), and International Security and Development Assistance Act §405(c)(2). These six are newly identified findings, not a claim that the current build introduced six new spans. Two prior provisional rows were omitted because their current targets were already semantically correct. By proposed authority, the 78 rows comprise 58 Public Law targets, 8 cross-title USC targets, 11 Title 8 historical/INA targets, and 1 named historical-Act target.

The recurring defects are:

- Public Law sections in effective-date and amendment notes were assigned to an enclosing/current Title 8 section or an imprecise named-Act search instead of the stated Public Law and section.
- Historical Act references were assigned to current Title 8 sections despite explicit different authority: Foreign Intelligence Surveillance Act sections 106(c), (e), (f), (g), and (h) should be Title 50 §1806 subdivisions, and Social Security Act §1614 subdivisions should be 42 U.S.C. §1382c.
- INA parentheticals with adjacent codification evidence were checked for the correct INA-to-USC path, including the distinction between INA §244/former 8 U.S.C. §1254 and INA §244A/8 U.S.C. §1255a.
- Act-anaphora in the Refugee Education Assistance material was checked against the named Act and its surrounding Public Law evidence. INA-like fallback targets for Refugee Education Assistance Act §§101(3) and 501 subdivisions, and for International Security and Development Assistance Act §405(c)(2), were rejected.
- Historical Nationality Act §325(a) references were retained as official historical-version targets rather than links that imply the current text of 8 U.S.C. §1427(a).

Named Acts with no reliable exact Public Law or cross-title codification in their local context remain official-source-only searches and are not flagged solely for being historical. Uninterpretable anaphora without an antecedent was not treated as a link. No product code or corpus data was changed after the frozen enumeration.
