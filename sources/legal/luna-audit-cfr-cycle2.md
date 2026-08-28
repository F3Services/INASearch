# Luna CFR inline-reference audit — cycle 2

## Scope and exact enumeration

This independent audit covers every generated inline legal-reference object in the final CFR corpus embedded in `INASearch-Uncompressed.html` (build signature `b6228e0fe848a886e96c8e1d`, corpus version `2026.08.21-audit.2`). USC operative text and USC notes were excluded. No parser, product code, or corpus source was changed.

Method: extract and parse the `inaSearchCorpusData` JSON, unpack its legal-reference arrays, then walk `cfr.sections`, `cfr.appendices`, and `cfr.parts` exactly once. For every reference in `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences`, I saved its source ID/path, exact offset/span, surrounding field text, and target to `/tmp/cfr-cycle2-enum-final.jsonl`. The walk covered 3,039 sections, 10 appendices, and 174 parts:

- 21,529 block-text references (`xReferences`)
- 86 heading references
- 622 authority references
- 131 source references
- **22,368 total references reviewed**

After that checkpoint was written, all validation and suspect selection used only the saved enumeration; the corpus was not re-enumerated. Existing tests were not used as audit proof. I checked exact source-span extraction, authority family, title/section or Public Law/Statutes metadata, official URL shape, local-vs-official resolution, and nested paths. I manually reviewed each context-sensitive rule family, including explicit CFR/USC citations, INA “the Act” and section references, parenthetical containers, `this`-section/container references, named Acts and instruments, Public Law and Statutes-at-Large targets, cross-title USC citations, ranges, appendices, and numbered section lists.

## Coverage and findings

Generated target families reviewed: INA 8,399; CFR 5,805; Federal Register 5,394; USC 1,571; Public Law 760; Statutes at Large 309; and named-act `unknown` 130. The 130 `unknown` named-act targets are intentional official GovInfo search targets, not malformed Public Law targets. All 5,394 Federal Register, 309 Statutes-at-Large, and 760 Public Law targets had complete citation metadata and official GovInfo URLs. All explicit cross-title USC/CFR titles matched their printed citations, including legitimate hyphenated sections such as `2000cc-5`, `609c-1`, and `301.6039E-1`.

No generated link used bare or uninterpretable `this`, `such`, `preceding`, or `following` text. INA section references and explicit parenthetical chains resolved to the correct INA/USC section and path; generic “the Act” links remained official-source-only. The 22 numbered-section-list references were checked individually, including the eight Title 45 CFR citations and their decimal sections.

The audit found **2 suspect references**, both in one systematic family: external Title 45 CFR parenthetical continuations. In `§ 233.20(a)(3) through (2)` and `§ 233.20(a)(1) and (2)`, the generated `(2)` target retains section 233.20 but emits path `['2']`; semantically it is paragraph `(a)(2)`, so the proposed path is `['a','2']`. These are the only flags in the accompanying TSV.

## Files

- `sources/legal/luna-audit-cfr-cycle2.md`
- `sources/legal/luna-audit-cfr-cycle2-flags.tsv`
