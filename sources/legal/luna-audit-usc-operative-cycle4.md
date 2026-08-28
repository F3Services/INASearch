# Cycle 4 audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the current `INASearch-Uncompressed.html` artifact (build signature `9229484027e14cf01d80cfe1`, corpus version `2026.08.21-audit.2`). USC note records, House editorial-footnote records, source-credit fields, and CFR records were excluded.

## Frozen enumeration and coverage proof

I independently loaded the current artifact and froze one enumeration before semantic review. I did not use prior audit reports, the INA 101 manifest, or tests as proof of coverage or correctness.

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

The walk visited 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,275 generated references, excluded exactly one CFR reference, and audited 5,274 generated USC/INA/statutory-source references. Every audited span matched `fieldText.slice(start, end)`; span mismatches were zero. TSV offsets, if needed for reproduction, are JavaScript UTF-16 offsets into rebuilt field text after footnote reconstruction. Source paths use `title8/<section>/<body labels>:<field>`.

Audited generated-rule counts:

| rule | count |
| --- | ---: |
| `house-uslm-ref` | 1,808 |
| `embedded-inferred-unit` | 2,405 |
| `embedded-named-act-section` | 136 |
| `embedded-explicit-container` | 535 |
| `embedded-numbered-section-list` | 289 |
| `embedded-such-container` | 31 |
| `embedded-this-container` | 33 |
| `context-path-this-section` | 23 |
| `house-editorial-correction` | 7 |
| `embedded-named-instrument-section` | 3 |
| `explicit-statutes-at-large` | 3 |
| `explicit-usc` | 1 |
| **audited total** | **5,274** |

By authority family, the audited set contains 5,042 USC references, 121 public-law references, 96 Statutes-at-Large references, and 15 named-Act/other official-source-only references. Resolution is 4,543 local and 731 official-source-only. The frozen run-in enumeration contains 262 unique paths across 51 sections; each path was checked against its surrounding statutory sentence and sibling/child hierarchy.

## Candidate coverage and semantic review

The artifact contains 184 operative candidate issues after the current resolver’s successful following-parallel and Act-to-USC resolutions: 108 ordinary anaphoric non-link spans and 76 structurally ambiguous candidates. I inspected all of them in context. Ordinary “such subsection/paragraph/clause” wording either had no standalone link-span meaning or lacked a unique authority; structural candidates whose surrounding explicit citation or generated unit links already supplied the target were accepted. No candidate was an unambiguous missing link.

I reviewed every generated reference for exact source span, authority family, title/Act, section, nested path, named-unit construction, section list, anaphoric continuation, and run-in path. Newly resolved mappings were checked individually, including:

- Social Security Act §1902(a)(10) → 42 U.S.C. §1396a(a)(10);
- Social Security Act §1916(a)(2)(B) → 42 U.S.C. §1396o(a)(2)(B);
- Social Security Act §1903(v)(3) → 42 U.S.C. §1396b(v)(3);
- INA historical sections 203(a)(7), 204(a)(1)(A)/(B), 212(d)(5), 240A(b)(2), 241(b)(3), and 243(h) to their codified Title 8 sections; and
- INA §405(b) of the June 27, 1952 Act → 66 Stat. 280, §405(b).

The 22 cycle-3 missing-link findings now all resolve to the correct generated targets, including the Social Security Act, INA historical sections, and the References-in-Text §405(b) mapping. The exact-following-parallel fixes also preserve the correct nested paths. No incorrect or missing generated operative reference remains.

## Findings

Audited generated references: **5,274**. Operative candidate issues reviewed: **184**. Run-in paths reviewed: **262**. Suspects: **0**. The flags TSV therefore contains only its required header.
