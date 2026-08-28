# CFR inline-reference audit — Cycle 9

## Scope and result

This final delta confirmation audit uses the current rebuilt `INASearch-Uncompressed.html`, build signature `172f5bebc4bf400a69b8e71f`. USC operative text and USC notes were excluded. No parser, product code, or corpus data was changed.

The frozen enumeration contains **22,879 generated CFR references** and **9,890 parenthetical/nested candidates**. **No suspect references were found**. The flags file is header-only: [luna-audit-cfr-cycle9-flags.tsv](luna-audit-cfr-cycle9-flags.tsv).

## Exact enumeration method and coverage proof

I read the current artifact's `inaSearchCorpusData`, unpacked its generated legal-reference records with `tools/pack-legal-references.js`, and made one bounded recursive walk of every CFR container. The walk covered all 3,039 section records, 10 appendices, and 174 part records. It traversed nested block objects and collected every generated `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences` array, while excluding the reference arrays themselves from recursive descent. Each frozen row retains its source path, exact offset/end span, text, surrounding source text, and target.

The frozen record contains 21,873 section references, 244 appendix references, and 762 part references (total 22,879). By field: `xReferences` 22,040; `headingReferences` 86; `authorityReferences` 622; `sourceReferences` 131. There are 9,872 records with nonempty generated target paths plus 18 embedded/context candidates, for 9,890 nested/path-sensitive candidates. All spans and official URLs were present, and no bare `this`, `such`, `preceding`, or `following` token was linked as a standalone generated reference.

Using the saved Cycle 8 inventory and the stable key `(source_id, field, offset, end)`, the frozen delta is **0 added, 2 changed, and 0 removed**. Both changes are the two Cycle 8 IIRIRA references in 8 CFR 1003.43; each now correctly includes Division C in the Public Law 104-208 path. I also rechecked all six Cycle 7 flagged spans: their Public Law targets remain correct. No changed target requires a flag.

## Findings

Cycle 9 is clean. The two changed targets corrected the previously flagged omissions for IIRIRA sections 309(g) and 309(h), changing their paths from `s309/g` and `s309/h` to `division-C/s309/g` and `division-C/s309/h`. No new reference family, span, authority, or nested-path regression was identified.
