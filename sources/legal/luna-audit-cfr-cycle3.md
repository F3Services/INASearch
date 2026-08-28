# Luna CFR inline-reference audit — cycle 3

## Scope and bounded enumeration

This independent audit covers every generated inline legal-reference object in the final CFR corpus embedded in `INASearch-Uncompressed.html` (build signature `b9c74153f07222aca045df81`, corpus version `2026.08.21-audit.2`). USC operative text and USC notes were excluded. No parser, product code, or corpus source was changed.

Exact method: parse the `inaSearchCorpusData` JSON, unpack its legal-reference arrays, and walk `cfr.sections`, `cfr.appendices`, and `cfr.parts` once. For each reference in `headingReferences`, `xReferences`, `authorityReferences`, and `sourceReferences`, save the source ID/path, exact offset/span, surrounding field text, and target to `/tmp/cfr-cycle3-enum-final.jsonl`. The walk covered 3,039 sections, 10 appendices, and 174 parts:

- 21,530 block-text references (`xReferences`)
- 86 heading references
- 622 authority references
- 131 source references
- **22,369 total generated references reviewed**

Candidate coverage was counted from that same frozen file: every saved reference with a non-empty nested target path, an `embedded-*` rule, or the `context-path-this-section` rule was reviewed as a semantically resolvable parenthetical/nested-path candidate (**9,488 candidates**). This includes all 1,298 embedded-rule references and the new inferred-unit candidate. After the checkpoint was written, all checks and findings used only the saved enumeration; there was no re-enumeration. Existing tests and prior reports were not used as proof.

## Coverage and findings

Target families reviewed: INA 8,399; CFR 5,805; Federal Register 5,394; USC 1,572; Public Law 760; Statutes at Large 309; and named-act `unknown` 130. I checked exact source spans, family and title/section metadata, Public Law/Statutes metadata, official URL shape, local-vs-official resolution, and nested paths.

Specific semantic passes verified the two prior Title 45 continuation cases now resolve `(2)` to `§ 233.20(a)(2)`; decimal, range, and legitimate hyphenated sections including `2000cc-5`, `609c-1`, and `301.6039E-1`; Act bases and cross-title USC citations; named Act/instrument and Public Law targets; appendices; and parenthetical chains. The new reference `(d)` in “subsection (d) hospital” correctly targets 42 U.S.C. § 1395ww(d). No linked bare or uninterpretable `this`, `such`, `preceding`, or `following` span was found, and no CFR/USC target had an incomplete trailing-hyphen section.

**Suspect count: 0.** No systematic target-family, span, URL, range, Act-base, or nested-path defect remains in this bounded pass. The flags TSV is therefore header-only.

## Files

- `sources/legal/luna-audit-cfr-cycle3.md`
- `sources/legal/luna-audit-cfr-cycle3-flags.tsv`
