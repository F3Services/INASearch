# Cycle 3 audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the final `INASearch-Uncompressed.html` artifact (build signature `b9c74153f07222aca045df81`, corpus version `2026.08.21-audit.2`). USC note records, House editorial-footnote records, source-credit fields, and CFR records were excluded.

## Frozen enumeration and coverage proof

I independently loaded the final artifact and froze one enumeration before reviewing findings. I did not use cycle 1 or cycle 2, the INA 101 manifest, or tests as proof of coverage or correctness.

The exact walk was:

```text
for each entry S in title8.sections:
  collect S.heading and S.preamble
  recursively visit every node N in S.body:
    collect N.heading and N.text
for each collected field F:
  read headingReferences, preambleReferences, or references as appropriate
  retain every reference whose family is not cfr
```

The walk visited 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,253 generated references, excluded one CFR reference, and audited 5,252 generated USC/INA/statutory-source references. Every audited span matched `fieldText.slice(start, end)` (zero span mismatches). TSV offsets are JavaScript UTF-16 offsets into rebuilt field text after footnote reconstruction. Paths use `title8/<section>/<body labels>:<field>`.

Audited generated-rule counts:

| rule | count |
| --- | ---: |
| `house-uslm-ref` | 1,808 |
| `embedded-inferred-unit` | 2,405 |
| `embedded-named-act-section` | 114 |
| `embedded-explicit-container` | 535 |
| `embedded-numbered-section-list` | 289 |
| `embedded-such-container` | 31 |
| `embedded-this-container` | 33 |
| `context-path-this-section` | 23 |
| `house-editorial-correction` | 7 |
| `embedded-named-instrument-section` | 3 |
| `explicit-statutes-at-large` | 3 |
| `explicit-usc` | 1 |
| **audited total** | **5,252** |

By family: 5,016 USC, 121 public-law, 95 Statutes-at-Large, and 20 named-Act/other official-source-only references. Resolution is 4,530 local and 722 official-source-only. The frozen run-in enumeration contains 262 paths across 51 sections; all were checked against their surrounding sentence and statutory hierarchy.

## Candidate coverage and findings

In addition to generated references, I reviewed all 206 operative candidate issues emitted for parenthetical/anaphoric resolution: 108 ordinary anaphoric non-link spans, 76 structurally ambiguous candidates, and 22 named-authority continuation candidates. Ordinary “such subsection/paragraph/clause” phrases were not promoted to links where the phrase was merely an anaphor or lacked a unique authority; structural candidates whose unit links already covered the citation were accepted. The 22 named-authority candidates are semantically resolvable from their named Act or immediately bracketed parallel citation and are the only suspect rows in the TSV.

The current generated links were checked for exact span, authority family, title/Act, section, nested path, named-unit construction, lists, parenthetical continuations, and run-in paths. Newly recognized continuation links include the Social Security Act §1902/§1916/§1903 references, INA historical-section continuations, and the §1443a/§1452 historical mappings; their generated targets were semantically correct. No incorrect generated target remains.

All seven cycle-2 findings were independently rechecked and are fixed in this artifact: the §1182(m)(6) “(d) hospital” target now resolves to 42 U.S.C. §1395ww(d); §1184(l), §§1409 and 1452 lists, §1424(a)(5), and §1448(a)(5)(B)/(C) now have the correct generated targets. They are not repeated as flags.

The 22 cycle-3 flags are missing links on source spans such as “section 243(h) of such Act” where the surrounding bracketed parallel citation makes the historical Act section unambiguous. The TSV contains no suspect generated target; it contains only these semantically resolvable missing-link candidates.
