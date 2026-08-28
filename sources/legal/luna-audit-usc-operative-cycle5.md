# Cycle 5 audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the current `INASearch-Uncompressed.html` artifact (build signature `dd5781b0ad88deceb1031e84`, corpus version `2026.08.21-audit.2`). USC notes, House editorial-footnote records, source-credit fields, and CFR records were excluded. No parser, resolver, or corpus files were modified.

## Frozen enumeration and coverage proof

I independently loaded the current artifact and froze one enumeration before semantic review. I did not use the cycle 1–4 reports, the INA 101 manifest, or tests as proof of coverage. The exact reproducible walk was:

```text
for each entry S in title8.sections:
  collect S.heading and S.preamble
  recursively visit every node N in S.body:
    collect N.heading and N.text
for each collected field F:
  read headingReferences, preambleReferences, or references as appropriate
  retain every reference whose family is not cfr
```

The walk visited 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,275 raw generated references, excluded exactly one CFR reference, and audited 5,274 generated USC/INA/statutory-source references. Every audited span matched `fieldText.slice(start, end)`; span mismatches were zero. Offsets are JavaScript UTF-16 offsets into the rebuilt field text after footnote reconstruction. Source paths identify the Title 8 section, nested body labels, and field kind.

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

By authority family, the audited set contains 5,042 USC references, 121 public-law references, 96 Statutes-at-Large references, and 15 named-Act/other official-source-only references. Resolution is 4,543 local and 731 official-source-only. The frozen run-in enumeration contains 262 unique paths across 51 sections; all 262 were reviewed against their surrounding sentence and sibling/child hierarchy.

## Bounded semantic review

I reviewed the frozen Title 8 set for exact source span, authority family, title or instrument, section, nested parenthetical path, named-unit construction, section lists, anaphoric continuation, and run-in projection. The current artifact’s operative candidate review remains 184 issues: 108 ordinary anaphoric non-link spans and 76 structurally ambiguous candidates. These are not suspects where the surrounding statutory context supplies no unique resolvable link; no target-validation failure or named-authority continuation failure was found in the operative set.

The 22 cycle-3 missing-link findings were checked directly in the frozen references. They still resolve as follows: Social Security Act §§1902(a)(10), 1916(a)(2)(B), and 1903(v)(3) to 42 U.S.C. §§1396a(a)(10), 1396o(a)(2)(B), and 1396b(v)(3); INA historical §§243(h), 241(b)(3), 212(d)(5), 203(a)(7), 204(a)(1)(A)/(B), and 240A(b)(2) to 8 U.S.C. §§1253(h), 1231(b)(3), 1182(d)(5), 1153(a)(7), 1154(a)(1)(A)/(B), and 1229b(b)(2); and INA §405(b) to §405(b) of the June 27, 1952 Act, 66 Stat. 280. The exact nested paths were preserved in every case.

The six cycle-2 semantic families were also spot-checked in the frozen set: the hospital “(d)” reference resolves to 42 U.S.C. §1395ww(d); the “clause (iii) of such section” continuations resolve to INA §212(e)(iii); paragraph lists in §§1409 and 1452 resolve to §1401(c), (d), (e), and (g); §1424(a)(6) “subparagraph (5)” resolves within §1424(a); and §§1448(a)(5)(B)/(C) resolve to their corresponding clauses. No new Title 8 reference or wrong/missing target was introduced.

The only reported code change since the prior clean audit confines following-parallel projection and Title-8 codification evidence away from CFR. The frozen current counts and reference content are identical for the audited Title 8 set, and the single CFR reference remains excluded. Thus the bounded delta review found no new operative suspect.

## Findings

Audited generated references: **5,274**. Operative candidate issues reviewed: **184**. Run-in paths reviewed: **262** across **51** sections. Suspects: **0**. The flags TSV contains only its required header.
