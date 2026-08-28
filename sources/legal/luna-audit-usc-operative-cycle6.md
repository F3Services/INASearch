# Cycle 6 confirmation audit of generated operative USC/INA references

Audit date: 2026-08-23. Scope is the operative Title 8/INA text in the current `INASearch-Uncompressed.html` artifact (build signature `add0bc621f6bac45f3cf8f5c`, corpus version `2026.08.21-audit.2`). USC notes, House editorial-footnote records, source-credit fields, and CFR records were excluded. No parser, resolver, or corpus files were modified.

## Frozen inventory and coverage

I independently loaded the current artifact and froze one inventory before review. The reproducible walk was:

```text
for each section S in title8.sections:
  collect S.heading and S.preamble
  recursively collect every body node's heading and text
for each collected field F:
  read its packed/hydrated reference array
  retain every generated reference whose family is not cfr
```

The walk covered 9,373 operative fields: 3,137 headings, 81 preambles, and 6,155 body-text fields. It found 5,275 raw generated references, excluded exactly one CFR reference, and audited 5,274 operative references. All audited spans matched the field text at their recorded offsets; span mismatches were zero. The frozen run-in inventory contains 262 paths across 51 sections, and all 262 were reviewed in their surrounding statutory context.

Audited rule counts were: `house-uslm-ref` 1,808; `embedded-inferred-unit` 2,405; `embedded-named-act-section` 136; `embedded-explicit-container` 535; `embedded-numbered-section-list` 289; `embedded-such-container` 31; `embedded-this-container` 33; `context-path-this-section` 23; `house-editorial-correction` 7; `embedded-named-instrument-section` 3; `explicit-statutes-at-large` 3; and `explicit-usc` 1.

By authority family, the current hydrated references contain 5,039 USC, 124 public-law/Act, 96 Statutes-at-Large, and 15 other named-authority/unknown official-source-only references. Resolution is 4,538 local and 736 official-source-only. Act-form House links are counted with public-law authority.

## Semantic confirmation and bounded delta review

Every generated reference was checked for exact span, authority family, title or instrument, section, nested parenthetical chain, named-unit construction, section list, anaphoric continuation, and run-in projection. The current operative candidate inventory contains 188 items: 109 ordinary anaphoric non-link spans, 20 no-unique-subsection candidates, 21 no-unique-paragraph candidates, 3 no-unique-clause candidates, 15 no-unique-section candidates, 1 missing-paragraph antecedent, 16 no-unique-subparagraph candidates, and 3 missing-section antecedents. The four additional candidates relative to Cycle 5 were likewise non-link or structurally non-unique in context; none identified a missing generated target.

The 22 Cycle-3 fixes remain correct. The current targets include Social Security Act §§1902(a)(10), 1916(a)(2)(B), and 1903(v)(3) at 42 U.S.C. §§1396a(a)(10), 1396o(a)(2)(B), and 1396b(v)(3); INA historical §§243(h), 241(b)(3), 212(d)(5), 203(a)(7), 204(a)(1)(A)/(B), and 240A(b)(2) at 8 U.S.C. §§1253(h), 1231(b)(3), 1182(d)(5), 1153(a)(7), 1154(a)(1)(A)/(B), and 1229b(b)(2); and INA §405(b) at §405(b) of the June 27, 1952 Act, 66 Stat. 280. Nested paths and official-source-only status were preserved appropriately.

Compared with the clean Cycle-5 inventory, 34 serialized target deltas were found after normalizing source paths and empty packing fields. Seven are compact statutory-path spellings (for example, `s301` versus the expanded “section-301” form) with the same authority and path meaning. Three related Public Law 104–208 references incorrectly drop the material Division C nesting, and one citation incorrectly lowercases a statutory path token; all four are recorded in the flags TSV. The remaining 23 substantive historical named-instrument/codification mappings are semantically correct in context, including the current mappings for the Torture Victim Protection Act, FISA §106, Refugee Education Assistance Act, Social Security Act, historical INA §244(a)(3), and the Intelligence Authorization Act.

## Findings

Audited generated references: **5,274**. Parenthetical/nested candidates reviewed: **188**. Run-in paths reviewed: **262** across **51** sections. Suspects: **4**. The four suspect spans are documented in `luna-audit-usc-operative-cycle6-flags.tsv`.
