# Cycle 9 delta confirmation audit of generated operative USC/INA references

Audit date: 2026-08-23. Audited artifact: `INASearch-Uncompressed.html`, current build signature `172f5bebc4bf400a69b8e71f`, generated at `2026-08-23T16:35:28.066Z`. Corpus version is `2026.08.21-audit.2` (embedded corpus SHA-256 `d723ef7c2440d53e42dd30c1de740ff6e9e82639721794c8c1309d2640125abb`). Scope is operative Title 8/INA text only; USC notes, House editorial-footnote records, source-credit fields, and CFR records were excluded. No parser, resolver, product-code, or corpus files were modified.

## Frozen enumeration and coverage proof

I loaded the current artifact once and froze the occurrence inventory before semantic review. The reproducible walk was:

```text
for each section S in title8.sections:
  collect S.heading and S.preamble
  recursively collect every body node's heading and text
  retain attached House/editorial footnote text only for candidate review
for each collected operative field F:
  hydrate/read its packed legal-reference array
  retain every generated reference whose family is not cfr
```

The operative walk covered 9,373 fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,275 raw generated references, excluded exactly one CFR reference, and audited **5,274 operative references**. Every audited span equaled `fieldText.slice(start, end)`; span mismatches were zero. Current authority-family counts are 5,041 USC, 135 public-law/Act, 97 Statutes-at-Large, and 1 named-Act/other unknown official-source-only reference. Resolution is 4,540 local and 735 official-source-only.

The current candidate inventory was independently filtered to operative source IDs plus the attached Title 8 editorial-footnote candidates. It contains **188** candidates: 109 `anaphor-is-not-a-link-span`, 20 `no-unique-subsection`, 21 `no-unique-paragraph`, 3 `no-unique-clause`, 15 `no-unique-section`, 1 `missing-paragraph-antecedent`, 16 `no-unique-subparagraph`, and 3 `missing-section-antecedent`. These are non-link wording or structurally non-unique in context, not unambiguous missing links.

I ran the current Title 8 body through the run-in index once: 103 source nodes, 266 marker occurrences, and **262 unique run-in paths across 51 sections**. Each path was checked against its surrounding statutory sentence and sibling/child hierarchy.

## Bounded delta and semantic review

The serialized operative inventory, rule totals, candidate totals/categories, and run-in totals are unchanged from the clean Cycle 7/Cycle 8 inventory. The bounded target comparison found no changed operative authority, section, nested path, resolution, or source span that is semantically wrong or missing. The current `7 U.S.C 7501` occurrence is correctly classified as an official-source-only USC 7:7501 target despite the source's missing period; the lone unknown family is the identifiable Food Stamp Act of 1977 section 3(l), appropriately official-source-only. Neither is a suspect.

The four earlier Cycle 6 findings remain repaired: INA §101(a)(15)(U) targets 8 U.S.C. §1101(a)(15)(U); IIRIRA §309(c)(5)(C)(i) targets Public Law 104–208, Division C, §309(c)(5)(C)(i); and both IIRIRA §551(a) references target Public Law 104–208, Division C, §551(a).

The prior 22 semantic repairs remain correct. Social Security Act §§1902(a)(10), 1916(a)(2)(B), and 1903(v)(3) target 42 U.S.C. §§1396a(a)(10), 1396o(a)(2)(B), and 1396b(v)(3); historical INA §§243(h), 241(b)(3), 212(d)(5), 203(a)(7), 204(a)(1)(A)/(B), and 240A(b)(2) target 8 U.S.C. §§1253(h), 1231(b)(3), 1182(d)(5), 1153(a)(7), 1154(a)(1)(A)/(B), and 1229b(b)(2); and INA §405(b) targets §405(b) of the June 27, 1952 Act, 66 Stat. 280. Nested paths, named authorities, and official-source-only status remain appropriate.

All 5,274 references, 188 candidates, and 262 run-in paths were covered by this single frozen inventory and bounded semantic pass. No suspect or new regression was found.

## Findings

Audited generated references: **5,274**. Parenthetical/nested candidates reviewed: **188**. Run-in paths reviewed: **262** across **51** sections. Suspects: **0**. The flags TSV contains only its required header.
