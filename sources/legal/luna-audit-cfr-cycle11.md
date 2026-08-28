# CFR inline-reference audit — Cycle 11

## Scope and result

This audit covers every `kind=reference` and `kind=parenthetical-candidate` row in the frozen CFR inventory, including part metadata, authorities, source notes, sections, appendices, nested blocks, notes, and tables. It covers 30,668 generated references and 47,896 candidates. The flags file contains 114 occurrence-level findings: 4 incorrect generated targets and 110 missing high-confidence statutory links.

Artifact SHA-256: `b32f5b690ac059222ddc40dc8874ac3dd3db6b7a8aad0215bd25b5291638e8d2` (`INASearch-Uncompressed.html`). Frozen inventory SHA-256: `b81130821d4ffdc06317ae34fbe737a7271e7b4c69560b7fbb39b5ff7e4fd049` (`/tmp/inasearch-inline-final.ZMZVQN/uncompressed/cfr.jsonl`).

## Independent method and coverage

I independently unpacked the artifact corpus with `tools/audit-inline-references.js`, recursively walked every CFR field, and regenerated the CFR JSONL inventory. The regenerated file was byte-for-byte equal to the frozen inventory (`cmp` success) and had the frozen inventory hash. I then inspected each flagged span against its complete source-field text and the Title 8 INA hierarchy / statutory title mappings.

The CFR inventory’s generated-reference fields are: `x` 29,006, `authority` 1,442, `source` 131, and `heading` 89. Reference families are CFR 12,148; INA 9,211; Federal Register 5,405; USC 2,547; Public Law 946; Statutes at Large 343; and unknown 68. CFR references resolve locally 17,818 times and to official-source-only targets 12,850 times. Candidate coverage is 13,059 linked, 30,858 structural, and 3,979 unlinked (no partial rows).

I checked local CFR targets against the section/appendix records and their nested unit paths; no unflagged local CFR target had an invalid section or path. I also checked INA path structure, current-title section-symbol forms, continuation lists, named-act and Public Law paths, and source-authority congress/law identifiers. Historical or incomplete statutory corpus paths were treated as official-source-only rather than as invalid citations. Structural labels, ordinary CFR self-references, forms, dates, variables, tax-code parentheticals, and genuine ambiguity were not flagged.

## Findings

The four incorrect targets are occurrence-specific continuation/path errors:

- Two `(B)` spans in 8 CFR 244.3 and 1244.3 incorrectly target `ina:8:1182/a/B`; in “(5) (A) and (B)” they are `ina:8:1182/a/5/B`.
- Two `(ii)` spans in 8 CFR 101.5 and 1101.5 incorrectly target `ina:8:1101/a/27/I/i/II`; in the list “101(a)(27)(I) (i), (ii), and (iii)” they are `ina:8:1101/a/27/I/ii`.

The 110 missing-link findings are explicit statutory parentheticals with no overlapping generated target. They include the paired 101(a)(27)(I) maintenance lists; INA section-symbol continuations in current and historical Title 8/22 provisions; IIRIRA section 309(f)(1)(A) Public Law citations; and Social Security Act parentheticals in Title 20 (mapped to their Title 42 USC sections). Proposed targets record the family, title, section, path, and whether the target is local or official-source-only.

No additional invalid citation, false-positive link, or structural misclassification was identified after those flags. No parser, corpus, product, or generated-HTML files were edited.
