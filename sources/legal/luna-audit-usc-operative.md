# Independent audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA corpus in the generated corpus used by `INASearch-Uncompressed.html`. USC notes, House editorial-footnote records, source-credit fields, and CFR records were excluded. A CFR citation embedded in an otherwise operative field was also excluded from the audited reference total; it belongs to the separate CFR review.

## Enumeration and coverage proof

I independently loaded the source corpus and generated reference artifacts with a JavaScript VM, then applied, in this order: statute-footnote reconstruction, House/USLM references, statute run-in indexing, and the generated legal-reference resolver. I did not use the INA 101 manifest or existing tests as an audit result.

The exact field walk was:

```text
for each title8.sections entry S:
  collect S.heading and S.preamble
  recursively visit every S.body node N:
    collect N.heading and N.text
```

For each collected field I read `headingReferences`, `preambleReferences`, or `references` (the latter is the generated property for a text field). I retained every reference whose source field was in that walk, verified that `field.slice(start,end) === reference.text`, and excluded only `family === "cfr"`. Offsets in the flags file are JavaScript UTF-16 offsets into the post-footnote-reconstruction field. The reproducible source path notation in the flags file is `title8/<section>/<body labels>:<field>`.

The walk visited 9,373 operative heading/preamble/body fields and found 5,239 generated references before the one CFR exclusion. Thus 5,238 references were audited:

| generated rule | count |
| --- | ---: |
| `house-uslm-ref` | 1,811 |
| `embedded-inferred-unit` | 2,405 |
| `embedded-explicit-container` | 540 |
| `embedded-numbered-section-list` | 297 |
| `embedded-named-act-section` | 96 |
| `embedded-this-container` | 30 |
| `embedded-such-container` | 29 |
| `context-path-this-section` | 23 |
| `explicit-statutes-at-large` | 3 |
| `embedded-named-instrument-section` | 3 |
| `explicit-usc` | 1 |
| CFR excluded from this audit (`explicit-cfr`) | 1 |
| **audited total** | **5,238** |

The audited references resolve as 4,502 local and 736 official-source-only. By family they are 4,994 USC, 117 public-law, 95 statutes-at-large, and 32 named-Act/other official-source-only references. The independent House/USLM manifest scan found 1,667 operative references in 1,233 operative source groups; the runtime walk adds 144 preamble House references, reconciling exactly to the 1,811 `house-uslm-ref` occurrences above. This is the coverage cross-check, not an assertion that a manifest is semantically correct.

I separately walked every `title8` body node through `indexStatuteRunIns` and `statuteRunInPathMarkers`: 103 source nodes, 266 marker occurrences, 262 unique generated run-in paths, across 51 sections. Every run-in path was checked against its surrounding structural sentence and sibling/child hierarchy. No run-in path was flagged.

## Findings

There are 39 suspect or incorrect generated links in [luna-audit-usc-operative-flags.tsv](luna-audit-usc-operative-flags.tsv). Thirty-five are semantic target/unit errors and four are false links on House editorial-footnote marker numerals. The flags cover:

- parenthetical chains whose named external title or Act was lost and incorrectly defaulted to Title 8;
- named-Act and public-law references whose INA/USC or Act-section mapping is explicit in the surrounding text or bracketed parallel citation;
- continuation chains such as `(H)(i)(b) or (c)` and `(15)(A), (E), or (G)` where the generated path dropped an ancestor;
- “such title” antecedents resolving to titles 18 or 28;
- two generated run-in-like `this paragraph` chains in §1375a where the `A` subparagraph was dropped;
- four numerals that are editorial-footnote markers, not sections; and
- seven source editorial citation errata whose generated links preserve the printed but expressly corrected citation (including 1229c, 1225(b)(1), 1255(i)(3)(B), 1534(e)(3), the two public laws, and 7 U.S.C. 2012(j)).

Named Acts and external-title references that were interpretable and already targeted an official source were accepted, even when their content is outside the local Title 8 corpus. Bare anaphoric wording such as “such subsection” and “such paragraph” was inspected in context; the resolver emitted no unresolved target for those phrases, so there is no fabricated unresolved link to put in the TSV. They were not counted as generated references merely because the prose contains an anaphor.

The TSV contains only the 39 suspect/incorrect cases; all other 5,199 audited USC/INA references, including all 262 run-in paths, were accepted after contextual review. This final count reflects the resolver’s current mappings: correctly mapped external-title references, INA section 101/204 references, Social Security Act references, and Nationality Act of 1940 references are accepted as official-source-only or local targets where appropriate.
