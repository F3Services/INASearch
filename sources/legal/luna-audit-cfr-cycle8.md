# CFR inline-reference audit — Cycle 8

## Scope and result

This final confirmation audit uses the current rebuilt `INASearch-Uncompressed.html`, build signature `1c0a8d07e6574b27e30122e3`. USC operative text and USC notes were excluded. No parser, product code, or corpus data was changed.

The frozen enumeration contains **22,879 generated CFR references** and **9,890 parenthetical/nested candidates**. **Two references are suspect**; they are recorded in [luna-audit-cfr-cycle8-flags.tsv](luna-audit-cfr-cycle8-flags.tsv). The other 22,877 references were accepted as semantically correct or appropriately official-source-only.

## Exact enumeration method and coverage proof

I read the current artifact's `inaSearchCorpusData`, unpacked its generated legal-reference records with `tools/pack-legal-references.js`, and made one bounded recursive walk of every CFR container. The walk covered all 3,039 section records, 10 appendices, and 174 part records. It traversed nested block objects and collected every generated `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences` array, while excluding the reference arrays themselves from recursive descent. Each frozen row retains its source path, exact offset/end span, text, surrounding source text, and target.

The frozen record contains 21,873 section references, 244 appendix references, and 762 part references (total 22,879). By field: `xReferences` 22,040; `headingReferences` 86; `authorityReferences` 622; `sourceReferences` 131. There are 9,872 records with nonempty generated target paths plus 18 embedded/context candidates, for 9,890 nested/path-sensitive candidates. All 22,879 spans match their saved surrounding text, all have official URLs, and no bare `this`, `such`, `preceding`, or `following` token was linked as a standalone generated reference.

For the required comparison, I compared the frozen Cycle 8 rows to the saved Cycle 7 inventory using `(source_id, field, offset, end)`. The delta is 0 added records, 29 changed targets, and 0 removed records. All six Cycle 7 flagged spans were explicitly rechecked and now have their proposed Public Law targets. The 29 changed targets were reviewed once from the frozen comparison; they include valid Act-to-Public-Law mappings, valid Statutes-at-Large mappings, the 42 U.S.C. §1396a Medicaid codification, and the six Cycle 7 corrections.

## Findings

### IIRIRA Division C omitted — 2 references

In 8 CFR 1003.43, the generated targets for section 309(g) and its parenthetical continuation (h) correctly identify Public Law 104-208 and section 309, but omit Division C. The surrounding text identifies the provisions as sections of the Illegal Immigration Reform and Immigrant Responsibility Act (IIRIRA), which was enacted as Division C of Public Law 104-208. Both rows are flagged with the Division C path restored.

### Accepted changed-target families

The remaining 27 changed targets were accepted. The current artifact correctly maps named Act provisions to their identified Public Law sections, including AC21, Adult Education and Family Literacy, Developmental Disabilities, LIFE, Intercountry Adoption, Panama Canal, and Seneca Nation provisions. Social Security Act title XVI provisions appropriately remain official-source-only Statutes-at-Large targets where no local corpus target is established, and the Medicaid §1902(a)(10)(C) change to 42 U.S.C. §1396a(a)(10)(C) is correct. All six Cycle 7 regressions were fixed without a new regression in those spans.
