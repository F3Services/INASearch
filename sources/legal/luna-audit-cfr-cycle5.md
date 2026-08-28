# Luna CFR inline-reference audit — cycle 5

## Scope and frozen enumeration

This independent audit covers the current `INASearch-Uncompressed.html` artifact, build signature `dd5781b0ad88deceb1031e84` and corpus version `2026.08.21-audit.2`. USC operative text and USC notes were excluded. No product code, parser, or corpus source was edited.

Exact enumeration method: parse the `inaSearchCorpusData` JSON, unpack legal-reference arrays, and walk `cfr.sections`, `cfr.appendices`, and `cfr.parts` once. Every reference in `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences` was saved with source ID/path, exact offset/span, surrounding field text, and target in `/tmp/cfr-cycle5-enum-final.jsonl`. Coverage was 3,039 sections, 10 appendices, and 174 parts:

- 21,530 block-text references (`xReferences`)
- 86 heading references
- 622 authority references
- 131 source references
- **22,369 generated CFR references audited**

The same frozen rows provided **9,488 parenthetical/nested candidates**: every saved reference with a non-empty target path, an `embedded-*` rule, or `context-path-this-section`. No later corpus enumeration was performed. Existing tests and prior reports were not treated as proof.

## Semantic review and coverage proof

Target families were INA 8,399; CFR 5,805; Federal Register 5,394; USC 1,572; Public Law 760; Statutes at Large 309; and named-act `unknown` 130. I checked exact source spans, target family, title/section or Public Law/Statutes metadata, official URL shape, local-vs-official resolution, and nested paths. Explicit cross-title USC/CFR citations, Act bases, appendices, ranges, decimal and legitimate hyphenated sections, and bare/anaphoric candidates were reviewed.

The two Title 45 continuation cases resolve to `§ 233.20(a)(2)`. The inferred `(d)` in “subsection (d) hospital” correctly targets 42 U.S.C. § 1395ww(d). Named-Act and codification families remain stable: 242 named-act-section references (130 official named-act searches, 7 Statutes-at-Large, 38 USC, 67 Public Law) and 113 explicit-Act-container INA references. There are no incomplete trailing-hyphen targets or malformed official URLs.

To verify the Title-8 following-parallel/codification work stayed outside this CFR scope, I compared every frozen cycle-5 source/field/span key and target against the saved cycle-3 clean inventory: **0 added, 0 removed, and 0 semantic target deltas**. Thus no CFR target regression was introduced.

**Suspect count: 0.** The flags TSV is header-only.

## Files

- `sources/legal/luna-audit-cfr-cycle5.md`
- `sources/legal/luna-audit-cfr-cycle5-flags.tsv`
