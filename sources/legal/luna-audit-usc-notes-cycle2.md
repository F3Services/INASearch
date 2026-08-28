# Luna cycle-2 audit: generated USC/INA note and editorial references

Audit date: 2026-08-23. Audited artifact: `INASearch-Uncompressed.html`, final rebuilt corpus (`corpusVersion` `2026.08.21-audit.2`, `verifiedAt` `2026-08-21`, build signature `b6228e0fe848a886e96c8e1d`; extracted HTML SHA-256 `861434d7ec6e9dbe2e9f537bd515424a74b0f34d33fb4c57130cb83005956af5`). Product code and corpus inputs were not modified.

## Scope and frozen enumeration

The audit covers the current Title 8 non-operative legal-source material: 2,455 note objects, 118 House editorial-footnote objects, 81 preamble objects, 286 source-credit objects, section heading references, and note heading references. The collector visited 376 Title 8 sections and counted these generated reference arrays only; it did not visit operative USC body text or CFR operative trees.

The latest-artifact inventory was enumerated once, after the rebuild, and then frozen before targeted semantic review. It contains exactly **16,918 references**. The frozen field counts were:

| containing field | references |
|---|---:|
| notes.references | 14,216 |
| section.headingReferences | 109 |
| notes.headingReferences | 15 |
| section.sourceCreditReferences | 2,527 |
| section.preambleReferences | 47 |
| editorial-footnote.references | 4 |

The frozen resolution totals are 12,868 official-source-only and 4,050 local. Family totals were: notes—941 official USC, 6,693 Public Law, 2,289 Statutes at Large, 220 Federal Register, 77 unknown, and 4,010 local USC; heading references—56 Statutes at Large and 53 Public Law; source credits—1,282 Public Law, 1,241 Statutes at Large, and 4 Federal Register; preambles—37 local USC, 3 Statutes at Large, and 7 official USC; editorial footnotes—2 local USC and 2 Public Law; and one note CFR reference, local.

The exact reproducible enumeration procedure was:

1. Read `INASearch-Uncompressed.html` and extract the JSON in the `script` element whose id is `inaSearchCorpusData`.
2. Parse that JSON and call `unpackLegalReferences()` from `tools/pack-legal-references.js`.
3. For each of the 376 `title8.sections`, visit every object in `notes`, `houseEditorialFootnotes`, `preamble`, and `sourceCredit`; count its `references`, `headingReferences`, `preambleReferences`, and `sourceCreditReferences` arrays. Also count those three named reference arrays directly on each section. A reference is counted once, by its containing object and array field.
4. Record family, resolution, rule, target title/section/path, and source span for every counted reference. After the 16,918-reference inventory was saved, all subsequent checks were targeted checks of the frozen spans and surrounding text; the inventory was not re-enumerated.

The frozen rule totals were: `house-uslm-ref` 14,413; `embedded-numbered-section-list` 271; `explicit-statutes-at-large` 72; `explicit-federal-register` 224; `explicit-public-law` 11; `embedded-inferred-unit` 587; `embedded-explicit-container` 317; `embedded-named-act-section` 768; `embedded-named-instrument-section` 3; `context-path-this-section` 190; `embedded-such-container` 47; `embedded-this-container` 11; `explicit-usc` 3; and `explicit-cfr` 1. These counts sum to the frozen total.

The frozen structural checks found zero Public Law references missing congress/law metadata. Eighty-seven USC-family targets pointed to section numbers absent from the current Title 8 section set; manual context review separated expected former/repealed or historical official-only citations from the 22 defects listed below.

## Findings

I found **22 suspect references**, all recorded at exact source offsets in `luna-audit-usc-notes-cycle2-flags.tsv`.

The systematic defect is historical-section context loss in `embedded-explicit-container`: when a note says “section … of such Act,” “section … of this Act,” or otherwise gives a historical INA section, the resolver carries the historical number into a current Title 8 USC target. The affected families are:

- Public Law 101-649 / Immigration Act of 1990 section 203(b) and 603(a) (5 references).
- Public Law 96-212 section 203 (3 references).
- Public Law 94-484 title VI section 601 (2 references).
- Historical INA section 101 where the same note explicitly supplies the codification 8 U.S.C. 1101 (4 references).
- Historical INA section 212(a)(3)(B)(iv), whose current codification is 8 U.S.C. 1182(a)(3)(B)(iv) (8 references).

The remaining 16,896 references were checked against their source spans and surrounding authority context by family/rule. In particular, former or repealed USC sections that are expressly identified as former or cited “of this title” remain official-source-only; named-Act references with no available Public Law identity use an official search target rather than a fabricated current-USC target; explicit Public Law, Statutes at Large, Federal Register, House USLM, cross-title USC, preamble, source-credit, and editorial-footnote targets matched their stated authorities. The single local CFR note reference is the explicit `8 CFR 204.6(e)` citation in the Immigration Benefits note and is correctly classified as CFR rather than USC.

No parser, resolver, generated corpus, or product source was changed. The flags file is intentionally TSV with one row per suspect span, including repeated occurrences of the same historical parenthetical pattern.
