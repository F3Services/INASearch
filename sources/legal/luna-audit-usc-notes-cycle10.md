# Luna USC/INA notes audit — cycle 10

Status: **findings recorded; not clean**. This audit records 13 suspect reference occurrences in 12 defect clusters. No parser, corpus, product source, or generated HTML file was changed.

## Scope and reproducibility

- Artifact audited: `/Users/dave/Documents/HD QuickLookup/INASearch-Uncompressed.html`
- Artifact SHA-256: `21684f061e7d99baa88bf7258adc4401857c4330bef19845590d89895675d9df`
- Embedded corpus: version `2026.08.21-audit.2`, captured `2026-07-30`, verified `2026-08-21`; embedded corpus SHA-256 `3f1a31f67e8bd4907bc5ffd219b76efe8a56020f25e82a15cce86616bf10fe8a`.
- Frozen inventory: `/tmp/inasearch-inline-audit-cycle10.Y4fWyF/usc-notes.jsonl`

I parsed the artifact directly, walked all 376 Title 8 sections and their note/source-credit/editorial-footnote fields, and ran a separate count/target-validation pass over those fields. I also recomputed the inventory into `/tmp/cycle10-recomputed` and compared it byte-for-byte with the frozen inventory:

```text
cmp -s /tmp/cycle10-recomputed/usc-notes.jsonl \
  /tmp/inasearch-inline-audit-cycle10.Y4fWyF/usc-notes.jsonl
  # exit 0
```

The recomputed inventory has exactly 17,111 `kind=reference` rows and 18,662 `kind=parenthetical-candidate` rows, with the frozen coverage counts below. Reference text spans round-trip to the source strings. All local targets exist, reference spans do not overlap, House hrefs match their expected path grammar, and official URL shapes are valid for every emitted authority family. I decoded all 7,137 indexed legal-reference evidence records and matched their source span, rule, authority, and target (normalizing the indexed path representation).

## Coverage proof

| USC/INA notes field | references | parenthetical candidates | linked | unlinked |
| --- | ---: | ---: | ---: | ---: |
| text | 14,567 | 17,290 | 6,899 | 10,391 |
| sourceCredit | 2,529 | 1,363 | 631 | 732 |
| heading | 15 | 9 | 9 | 0 |
| **total** | **17,111** | **18,662** | **7,539** | **11,123** |

Reference families are Public Law 8,224; USC 5,126; Statutes at Large 3,533; Federal Register 224; unknown historical named-act 3; and CFR 1. Resolution is local for 4,200 and official-source-only for 12,911.

The 2,920 unlinked multi-unit candidates (2,616 in note text and 304 in source credits) were examined as citation-unit sequences. The unlinked source-credit candidates are nested amendment-section labels inside bibliographic credit strings, not independent authorities; their base Public Law/statute citations are represented separately. In note text, the remaining unlinked candidates are amendment-history labels, subsection/paragraph labels, dates/annotations, quoted statutory labels, or otherwise lack a unique authority/container. Ten high-confidence continuation failures have an unambiguous authority and are flagged below.

House editorial-footnote coverage is 4 references and 25 parenthetical candidates. All four references resolve correctly (two local USC targets and two official Public Law targets). Of the candidates, 24 are editorial labels/annotation prose and one is covered by the valid `8:1182/a/3/B` target; none is an additional missing citation.

The three `family=unknown` references are legitimate historical named-act section references with official search targets: Federal Aviation Act of 1958 §101(3), Immigration Act §19(c), and International Security and Development Assistance Act of 1980 §405(c)(2). They are not malformed generic links.

## Findings

The complete occurrence-level log is in [`luna-audit-usc-notes-cycle10-flags.tsv`](luna-audit-usc-notes-cycle10-flags.tsv).

### Incorrect targets (three emitted occurrences, two clusters)

1. `8-1182-note-78`, offset 9100, `1185(a)`: the text says `8 U.S.C. 1182(f) and 1185(a)`, but the emitted target is `usc:3:1185/a`. The following `section 301 of title 3` citation was incorrectly carried backward. The target should be `usc:8:1185/a` (local).
2. `8-1184-note-33`, offsets 965 and 985: `section 204(b) of such Act` and the source's `(3 U.S.C. 1154(b))` both emit `usc:3:1154/b`. The sentence is INA §204(b), codified at 8 U.S.C. §1154(b); the immediately following `[8 U.S.C. 1154(b)]` is the source's correction. Both occurrences should target `usc:8:1154/b` (local). The two rows are logged separately because both are reference occurrences.

### Missing links (ten continuation-failure spans)

These are all unlinked in the artifact despite an explicit authority/container and adjacent citation units:

- `8-801 to 810-note-5` offset 198: `section 1485(1), (2) of this title` has §1485(1) linked, but the `(2)` continuation is missing → USC 8 §1485(2), official-source-only.
- `8-1101-note-17` offset 20954: `section 2(2), (3) to section 309 of Pub. L. 104–208` has §2(2) and §309 linked, but the `(3)` continuation is missing → Public Law 104–208 §2(3), official-source-only.
- `8-1443a-note-4` offset 170: `section 319(e) or 322(d) of such Act` → INA §§319(e), 322(d), locally codified at USC 8 §§1430(e), 1433(d).
- `8-1482-note-1` offset 488: `section 1485(1), (2), (4), (5), (6), (7), or (8) of this title` has §1485(1) linked, but `(2), (4), (5), (6), (7), and (8)` are missing → those USC 8 §1485 units, official-source-only.
- `8-1482-note-1` offset 554: `section 1486(1) or (2) of this title` has §1486(1) linked, but the `(2)` continuation is missing → USC 8 §1486(2), official-source-only.
- `8-1622-note-3` offsets 147 and 384, and `8-1641-note-3` offsets 603 and 840: four occurrences of `section 243(h) of such Act` → INA §243(h), historical USC 8 §1253(h), official-source-only.
- `8-1641-note-3` offset 2701: `section 244(a)(3) of such Act` → INA §244(a)(3), historical USC 8 §1254a(a)(3), official-source-only.

No additional suspect incorrect target or missing link was found in the enumerated 17,111 reference rows or 18,662 parenthetical-candidate rows after these checks. The flags are intentionally not fixed in this audit; they should be resolved in the parser/rules and then re-audited against a fresh artifact.
