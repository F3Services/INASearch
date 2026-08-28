# Luna cycle-3 audit: generated USC/INA note and editorial references

Audit date: 2026-08-23. Audited artifact: `INASearch-Uncompressed.html`, final build signature `b9c74153f07222aca045df81` (`corpusVersion` `2026.08.21-audit.2`, `verifiedAt` `2026-08-21`; extracted HTML SHA-256 `ffa2fdda9a8165ac2162df69ed5909ba8219945fc513ab86f5460971ba032c86`). No product code or corpus input was modified.

## Scope, enumeration, and candidate coverage

The audit covers all generated legal references in the current Title 8 non-operative material: 2,455 note objects, 118 House editorial-footnote objects, 81 preamble objects, 286 source-credit objects, section heading references, and note heading references. The collector visited all 376 Title 8 sections and excluded operative USC body text and CFR operative trees.

The final-artifact inventory was enumerated once and frozen before semantic review. It contains exactly **17,117 generated references**:

| containing field | references |
|---|---:|
| notes.references | 14,413 |
| section.headingReferences | 109 |
| notes.headingReferences | 15 |
| section.sourceCreditReferences | 2,527 |
| section.preambleReferences | 49 |
| editorial-footnote.references | 4 |

The frozen resolution totals are 12,868 official-source-only and 4,249 local. The note material contains 902 official USC, 6,732 Public Law, 2,289 Statutes at Large, 220 Federal Register, 77 unknown named-Act searches, 4,207 local USC, 1 local CFR, and 15 note-heading references included in those note totals. Section-level arrays contain 1,300 Statutes at Large, 1,335 Public Law, 4 Federal Register, 7 official USC, and 39 local USC references. Editorial footnotes contain 2 local USC and 2 Public Law references.

For reproducibility, the exact enumeration procedure was:

1. Read `INASearch-Uncompressed.html`; extract and parse the JSON in the `script` element with id `inaSearchCorpusData`.
2. Call `unpackLegalReferences()` from `tools/pack-legal-references.js`.
3. For each `title8.sections[i]`, visit every object in `notes`, `houseEditorialFootnotes`, `preamble`, and `sourceCredit`; count each of its `references`, `headingReferences`, `preambleReferences`, and `sourceCreditReferences` arrays. Count the three named reference arrays directly on the section as well. A reference is counted once by containing object and array field.
4. Freeze the resulting reference records with source id/path, offset/end, text, family, resolution, rule, target title/section/path, and official URL. All later work was targeted semantic review of those frozen records and their surrounding source text; the corpus was not re-enumerated.

Candidate coverage was separately grouped by the parser’s semantically resolvable parenthetical/context rules rather than by ordinary prose parentheses. The frozen inventory contains **2,393 such generated citation candidates**: `embedded-numbered-section-list` 271, `embedded-inferred-unit` 588, `embedded-explicit-container` 245, `embedded-named-act-section` 1,036, `embedded-named-instrument-section` 3, `context-path-this-section` 190, `embedded-such-container` 48, and `embedded-this-container` 12. All 2,393 candidates had generated spans and were reviewed by authority family, enclosing Act/Public Law, title, section, and nested path. The remaining generated references were reviewed by their explicit or House-USLM target families and source spans.

## Findings

I found **74 suspect references**, recorded one per exact span in `luna-audit-usc-notes-cycle3-flags.tsv`.

The 22 cycle-2 flags were independently rechecked. The explicit INA §203(b) parentheticals now resolve to the local codified 8 U.S.C. §1153(b) path, and the historical INA §101 and §212 chains resolve correctly in their dedicated contexts. However, the newly added general Act-anaphor fallback misresolves several other historical Act spans to the enclosing current USC section; those final-artifact targets are included below. Cross-title §1351/§2131 references retain titles 18 and 22.

The cycle-3 defects fall into three systematic groups:

- Six historical Act sections were defaulted to Title 8: Public Law 102-232 §305(j)(1), and Foreign Intelligence Surveillance Act §106(c), (e), (f), (g), and (h). The latter should use 50 U.S.C. §1806 subdivisions.
- Eight INA references with adjacent codifications were misresolved as generic Act searches or unrelated enclosing USC paths: INA §§101(a)(44)(A), 209(b), 237(a)(4)(B), 101(a)(15)(H)(i)(a), 274A(a)(2), 286(q)(1)(A) (twice), and historical §309(a). Their proposed current USC crosswalks are in the TSV.
- Sixty named-Act references had an explicit Public Law identity or an explicit cross-title codification in the surrounding text, but were misresolved as imprecise `unknown` searches or unrelated enclosing USC paths. These include Public Laws 96-422, 99-603, 100-459, 100-525, 101-238, 101-513, 102-232, 103-236, 103-416, 104-208, 105-33, 105-277, 109-163, 110-181, 111-8, and 114-53, plus Social Security Act §§1614(a)(1), (2), and (3), which map to 42 U.S.C. §1382c, and Migration and Refugee Assistance Act §2(b), which maps to 22 U.S.C. §2601(b).

Named Acts for which the current text supplies no reliable Public Law or codified counterpart remain official-source-only search targets and were not flagged merely for being historical. No malformed Public Law metadata was found. The flags file contains only suspect rows and preserves exact current target strings, source paths, offsets, text spans, verdicts, proposed targets, and rationales.
