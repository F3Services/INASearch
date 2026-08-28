# Cycle 2 audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the final `INASearch-Uncompressed.html` rebuild (build signature `b6228e0fe848a886e96c8e1d`, corpus version `2026.08.21-audit.2`). USC note records, House editorial-footnote records, source-credit fields, and CFR records were excluded.

## Enumeration and coverage proof

I independently enumerated the rebuilt artifact, then manually reviewed the saved enumeration and its surrounding statutory text. I did not use the INA 101 manifest, existing tests, or the prior audit as proof of coverage or correctness. The enumeration was frozen before finalizing the findings.

The exact reproducible walk was:

```text
for each entry S in title8.sections:
  collect S.heading and S.preamble
  recursively visit every node N in S.body:
    collect N.heading and N.text
for each collected field F:
  read headingReferences, preambleReferences, or references as appropriate
  retain every reference whose family is not cfr
```

The walk visited 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,235 generated references, excluded exactly one CFR reference, and audited 5,234 USC/INA/statutory-source references. Every audited span matched `fieldText.slice(start, end)` (0 span mismatches). Offsets in the TSV are JavaScript UTF-16 offsets into the rebuilt field text after footnote reconstruction. Source paths use `title8/<section>/<body labels>:<field>`.

Audited generated-rule counts:

| rule | count |
| --- | ---: |
| `house-uslm-ref` | 1,808 |
| `embedded-inferred-unit` | 2,405 |
| `embedded-explicit-container` | 536 |
| `embedded-numbered-section-list` | 289 |
| `embedded-named-act-section` | 100 |
| `embedded-this-container` | 30 |
| `embedded-such-container` | 29 |
| `context-path-this-section` | 23 |
| `house-editorial-correction` | 7 |
| `embedded-named-instrument-section` | 3 |
| `explicit-statutes-at-large` | 3 |
| `explicit-usc` | 1 |
| **audited total** | **5,234** |

By authority family, the audited set contains 4,998 USC references, 121 public-law references, 95 Statutes-at-Large references, and 20 named-Act/other official-source-only references. Resolution is 4,516 local and 718 official-source-only. The saved run-in enumeration contains 262 generated paths in 51 sections; each was checked against its surrounding run-in sentence and statutory sibling/child path.

## Semantic review and findings

I reviewed every generated reference for exact source span, authority family, title or instrument, section, parenthetical chain, named-unit construction, section list, anaphoric continuation, and run-in path. Explicit House/USLM targets were treated as authoritative only after checking that the surrounding prose described the same authority. Named Acts and external-title citations were accepted as official-source-only when the citation was interpretable and outside the local corpus. House editorial corrections were checked against the correction note and accepted where the generated target reflects the expressly corrected citation.

The rebuilt links have one incorrect generated target: `(d) hospital` in §1182(m)(6) was inferred as local §1182(d), although the phrase is the Social Security Act §1886(d) hospital category and the sentence supplies its 42 U.S.C. parallel. Six additional spans are semantically unambiguous references for which the rebuilt resolver emitted no link: two “clause (iii) of such section” continuations of §1182(e), two explicit lists of paragraphs of §1401, §1424(a)(5), and §1448(a)(5)(B)/(C). These seven findings are the only rows in the TSV.

The artifact’s operative audit metadata contained 190 candidate issues (108 ordinary anaphoric non-link spans, 76 ambiguous structural candidates, and 6 target-validation failures). I inspected those candidates in context. Ordinary “such subsection/paragraph/clause” wording had a resolvable statutory antecedent or was intentionally not a link span; no fabricated unresolved generated link was accepted. The six target-validation failures are the six missing-link rows above. No systematic incorrect generated-link family remains after the rebuilt resolver’s corrections; the only incorrect generated link is the single inferred-unit authority-family error in §1182(m)(6). All other 5,227 audited generated references, including all 262 run-in paths, were accepted.
