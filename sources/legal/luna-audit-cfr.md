# Luna CFR inline-reference audit

## Scope and enumeration

This audit covers generated legal-reference objects attached to CFR sections, appendices, and part metadata in `INASearch-Uncompressed.html`. USC operative text and USC notes were excluded. The corpus was unpacked and every CFR reference-bearing field was enumerated by source path and reference offset; no existing tests were treated as proof. The enumeration covered 3,039 CFR sections, 10 appendices, and 174 parts, yielding 22,807 generated references:

- 21,970 block-text references (`xReferences`)
- 85 heading references
- 621 authority references
- 131 source references

The generated-reference families were INA 8,633; CFR 5,942; Federal Register 5,405; USC 1,560; Public Law 965; and Statutes at Large 302. Local targets were checked against the CFR section/path inventory, and INA targets against the INA-to-USC crosswalk. Bare/uninterpretable anaphora were not treated as linkable references.

## Findings

The audit identified 409 affected occurrences, grouped as follows:

- 129 `embedded-explicit-container` references resolve statutory “section … of the Act,” IMMACT 90, or Public Law 96-422 citations as CFR. They require INA/USC crosswalk targets or Public Law 101-649 / 96-422 targets.
- 193 generic named-act references have no Congress/law metadata and were packed with the invalid `PLAW-publ` URL. They require an official named-act search target, or exact public-law metadata where available.
- 75 explicit USC/CFR citations terminate at a hyphen (67 USC and 8 CFR). The generated span/target is incomplete; ranges must at least target the first complete section.
- 4 paragraph-chain references incorrectly prepend the source block path in “paragraph (…) of this paragraph (b)” constructions.
- 8 numbered-section-list references in Title 45 CFR are misclassified as USC title 45 and lose the decimal section prefix. They require Title 45 CFR targets (for example, § 233.20).

The accompanying TSV contains the required columns and representative occurrence-level flags for each defect family, including source ID, source path, offset, text, current target, verdict, proposed target, and rationale. It is intentionally limited to suspect cases; the counts above are the exact affected-occurrence counts from the complete enumeration.

## Files

- `sources/legal/luna-audit-cfr.md`
- `sources/legal/luna-audit-cfr-flags.tsv`
