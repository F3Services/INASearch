# Cycle 7 confirmation audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the current `INASearch-Uncompressed.html` artifact (build signature `34f3380a3b7c84205c58a479`, corpus version `2026.08.21-audit.2`). USC notes, House editorial-footnote records, source-credit fields, and CFR records were excluded. No parser, resolver, or corpus files were modified.

## Frozen inventory and coverage

I independently loaded the current artifact and froze one inventory before semantic review. The reproducible walk was:

```text
for each section S in title8.sections:
  collect S.heading and S.preamble
  recursively collect every body node's heading and text
for each collected field F:
  hydrate/read its packed reference array
  retain every generated reference whose family is not cfr
```

The walk covered 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,275 raw generated references, excluded exactly one CFR reference, and audited 5,274 operative references. All audited spans matched their field text at the recorded offsets; span mismatches were zero. The frozen run-in inventory contains 262 paths across 51 sections, and every path was reviewed in its surrounding statutory context.

Current audited authority-family counts are 5,040 USC, 135 public-law/Act, 97 Statutes-at-Large, and 2 other named-authority/unknown official-source-only references. Resolution is 4,539 local and 735 official-source-only. Rule counts are unchanged in substance from the prior inventory: 1,808 House USLM references, 2,405 inferred-unit references, 136 named-Act-section references, 535 explicit-container references, 289 numbered-section-list references, 31 “such-container” references, 33 “this-container” references, 23 context-path references, 7 House editorial corrections, 3 named-instrument references, 3 explicit Statutes-at-Large references, and 1 explicit USC reference.

## Semantic confirmation

I reviewed every generated reference for exact span, authority family, title or instrument, section, nested parenthetical chain, named-unit construction, section list, anaphoric continuation, and run-in projection. The current operative candidate inventory contains 188 items: 109 ordinary anaphoric non-link spans, 20 no-unique-subsection candidates, 21 no-unique-paragraph candidates, 3 no-unique-clause candidates, 15 no-unique-section candidates, 1 missing-paragraph antecedent, 16 no-unique-subparagraph candidates, and 3 missing-section antecedents. Each remains either non-link wording or structurally non-unique in context; none is an unambiguous missing target.

All four Cycle-6 flags were rechecked and are now resolved correctly. INA §101(a)(15)(U) uses uppercase `U`; IIRIRA §309(c)(5)(C)(i) and both IIRIRA §551(a) references retain the Division C container in their Public Law 104–208 targets. No replacement suspect appeared around those spans.

The 22 prior missing-link repairs were independently rechecked. Social Security Act §§1902(a)(10), 1916(a)(2)(B), and 1903(v)(3) still target 42 U.S.C. §§1396a(a)(10), 1396o(a)(2)(B), and 1396b(v)(3); INA historical §§243(h), 241(b)(3), 212(d)(5), 203(a)(7), 204(a)(1)(A)/(B), and 240A(b)(2) still target 8 U.S.C. §§1253(h), 1231(b)(3), 1182(d)(5), 1153(a)(7), 1154(a)(1)(A)/(B), and 1229b(b)(2); and INA §405(b) still targets §405(b) of the June 27, 1952 Act, 66 Stat. 280. Nested paths and official-source-only status remain appropriate.

The current Title 8 inventory introduces no new wrong or missing link relative to the clean Cycle-6 confirmation. All previously flagged deltas are resolved, and the bounded semantic pass found no additional suspect.

## Findings

Audited generated references: **5,274**. Parenthetical/nested candidates reviewed: **188**. Run-in paths reviewed: **262** across **51** sections. Suspects: **0**. The flags TSV contains only its required header.
