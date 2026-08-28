# CFR inline-reference audit — Cycle 7

## Scope and result

This final confirmation audit uses the current rebuilt `INASearch-Uncompressed.html`, build signature `34f3380a3b7c84205c58a479`. USC operative text and USC notes were excluded. No parser, product code, or corpus data was changed.

The frozen enumeration contains **22,879 generated CFR references** and **9,890 parenthetical/nested candidates**. **Six references are suspect**; they are recorded in [luna-audit-cfr-cycle7-flags.tsv](luna-audit-cfr-cycle7-flags.tsv). The other 22,873 references were accepted as semantically correct or appropriately official-source-only.

## Exact enumeration method and coverage proof

I read the current artifact's `inaSearchCorpusData`, unpacked its generated legal-reference records with `tools/pack-legal-references.js`, and made one bounded recursive walk of every CFR container. The walk covered all 3,039 section records, 10 appendices, and 174 part records. It traversed nested block objects and collected every generated `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences` array, while excluding the reference arrays themselves from recursive descent. Each frozen row retains its source path, exact offset/end span, text, surrounding source text, and target.

The frozen record contains 21,873 section references, 244 appendix references, and 762 part references (total 22,879). By field: `xReferences` 22,040; `headingReferences` 86; `authorityReferences` 622; `sourceReferences` 131. There are 9,868 records with nonempty generated target paths plus 22 embedded/context candidates, for 9,890 nested/path-sensitive candidates. All 22,879 spans match their saved surrounding text, all have official URLs, and no bare `this`, `such`, `preceding`, or `following` token was linked as a standalone generated reference.

For the required semantic delta check, I compared the frozen Cycle 7 rows to the saved Cycle 6 inventory using `(source_id, field, offset, end)`. The delta is 127 added records, 43 changed targets, and 0 removed records (170 additions/target changes). The 11 Cycle 6 flagged spans were explicitly rechecked: all 11 now have the intended targets, including the Higher Education Act, State Department Authorities Act, FLSA, Economic Opportunity Act, edition-year, and IIRIRA Division C fixes. Semantic review then covered the added/changed set once; it was not re-enumerated.

## Findings

### Continuing Appropriations authority lost — 4 references

Four short references in 8 CFR 214.2 cite sections 101(6) and 106 of Division A, Title I of the Continuing Appropriations and Extensions Act, 2025, Public Law 118-83. The current target drops both the year and the explicit Public Law authority, leaving only an incomplete official-only act title. The flags propose Public Law 118-83 with Division A/Title I/section nesting.

### Act sections incorrectly collapsed to operative USC sections — 2 references

- 22 CFR 51.51's section 7209(b) citation is to the Intelligence Reform and Terrorism Prevention Act, Public Law 108-458, with the adjacent parenthetical expressly saying “8 U.S.C. 1185 note.” The current target is operative 8 U.S.C. §1185; the act provision should target Public Law 108-458 §7209(b).
- 31 CFR 501.603's section 201(a) citation is to the Terrorism Risk Insurance Act, Pub. L. 107-297, with the adjacent citation “28 U.S.C. 1610 note.” The current target is operative 28 U.S.C. §1610; the act provision should target Public Law 107-297 §201(a).

### Accepted systematic changes

The remaining changed targets were accepted. In particular, Social Security Act and Public Health Service Act references now point to their historical Statutes at Large sources with section paths, which is an appropriate official-source-only representation when no local corpus target is established. The 127 added references are explicit CFR/USC/INA/Public Law/Federal Register records or contextually resolvable nested references; their authority families, titles/sections, paths, and source spans were accepted. The corrected Cycle 6 mappings did not regress.
