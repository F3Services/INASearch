# Embedded statutory-reference audit report

Audit date: 2026-08-25. Corpus version: `2026.08.21-audit.2`.

## Outcome

The embedded-reference generator separates syntax recognition from target
resolution and preserves the authority, section, and complete parenthetical
path supported by the source text. Confirmed cycle-11 findings were corrected
with general parser, resolver, source-evidence, and validation rules. There are
no provision-specific rules for INA 212(h), and
`embedded-reference-exceptions.json` remains empty.

Uninterpretable anaphora and current-unit self-references remain plain text.
Identifiable references outside the local corpus use an official-source link;
historical citations are not silently projected into a current local unit.

## INA 101 baseline and result

Every parenthetical sequence in INA 101 was classified manually before the
general rules were finalized. The review manifest contains 245 sequences: 203
citations, 41 structural run-in labels, and one non-citation annotation,
`(NATO)`.

| INA 101 citation result | Old corpus | Final corpus |
| --- | ---: | ---: |
| Correct | 124 | 203 |
| Missing | 51 | 0 |
| Wrong target or path | 28 | 0 |
| Total citation sequences | 203 | 203 |

The old corpus therefore had 79 defective INA 101 citation sequences. The
specific collapsed-boundary defect originally reported occurred four times in
three source provisions:

- INA 101(a)(15)(H): `(i)(a)` and `(ii)(a)`;
- INA 212(j)(1)(B): `(ii)(I)`; and
- INA 337(a): `(5)(A)`.

The final corpus has no collapsed boundary in those provisions.

## Independent audit cycles

Independent auditors enumerated references separately in operative Title 8
text, non-operative Title 8 notes and annotations, and CFR material. Each
auditor froze an occurrence-level JSONL inventory, regenerated it independently,
and reviewed exact source spans, surrounding text, target families, and nested
paths. The `luna-audit-*.md` and matching TSV files preserve the findings from
each frozen build; they are historical audit inputs rather than claims about
the later corrected artifact.

Earlier cycles corrected compound paths, named-Act and Public Law authority,
historical versions, U.S.-Code-note locators, shared containers, Code edition
years, and material division/title nesting. Cycle 11 performed a final full
occurrence review of the then-frozen build:

| Cycle-11 scope | Frozen references | Parenthetical candidates | Findings |
| --- | ---: | ---: | ---: |
| USC/INA operative text | 5,543 | 5,007 | 34 |
| USC notes and annotations | 18,572 | 18,662 | 41 |
| CFR | 30,668 | 47,896 | 114 |

Root adjudication reviewed all 189 flags. It confirmed and resolved 186 with
general rules. Three proposals were rejected against stronger source evidence:

- the operative source expressly cites absent current clause
  8 U.S.C. 1153(a)(2)(A)(iii), so it remains identifiable through an official
  source rather than being rewritten as a valid local unit or erased; and
- two references to former section 1487 continue to use the local combined
  repealed-section record `1484 to 1487`, which is the available exact local
  historical destination.

The four Title 38 captures in sections 1613 and 1622 were also checked against
their House editorial footnotes. Because the publisher states that “clause
(i) or (ii)” should be “subparagraph (A) or (B),” those erroneous source spans
are not exposed as invented citation links. Analogous section 1612 references
resolve to the actual sibling clauses supported by its hierarchy.

Per the project-owner direction, cycle 11 is the closing cycle; no cycle 12 was
started. The final rebuilt occurrence inventory is:

| Final scope | References | Candidates | Linked | Structural | Unlinked |
| --- | ---: | ---: | ---: | ---: | ---: |
| USC/INA operative text | 5,538 | 5,007 | 4,693 | 282 | 32 |
| USC notes and annotations | 18,578 | 18,662 | 8,880 | 0 | 9,782 |
| CFR | 27,481 | 48,098 | 13,382 | 30,165 | 4,551 |

The remaining unlinked candidates are retained as the audit surface: they
include structural labels, amendment labels, dates, ordinary prose, genuine
ambiguity, current-unit self-references, and publisher errors. No confirmed
cycle-11 finding remains unapplied.

## General repairs

The generator now handles:

- compound parenthetical paths without collapsing adjacent hierarchy levels;
- lists, continuations, ranges, decimal CFR sections, and legitimately
  hyphenated USC/CFR section identifiers;
- shared trailing containers across nested exceptions and repeated same-level
  citation phrases;
- exact written containers, named Acts and acronyms, Public Laws, historical
  INA sections, and `this Act`/`such Act` antecedents;
- cross-title parallel citations and reviewed CFR Act scopes, including Social
  Security Act sections in 20 CFR part 416 mapped to Title 42;
- historical-version qualifiers, U.S.-Code-note locators, and explicit
  `former`/`now` recodifications;
- same-citation Public Law evidence with material division and title paths;
- U.S. Code edition years without inventing a nested statutory unit;
- source-footnote corrections, source typos, and sentence/run-in boundaries;
  and
- official-source fallbacks for identifiable authorities without inventing an
  incomplete Public Law URL.

## Verification and artifact identity

The complete standalone suite passes, including source-span round trips,
target and evidence validation, browser/build packer equivalence, profile and
storage migration, statutory formatting and hierarchy checks, CFR checks,
deterministic builds, and all auxiliary command, workspace, insertion,
occurrence-search, and viewer tests.

| Artifact | Bytes | Delivery payload | SHA-256 |
| --- | ---: | ---: | --- |
| `INASearch.html` | 8,120,338 | 5,160,389 gzip bytes | `e05fcd44c3086243a38c1f39201f3506db14bf23756fa7e70371eb1fa145600e` |
| `INASearch-Uncompressed.html` | 35,099,560 | 33,859,983 plain JSON bytes | `ff8f230d6686137cc55e2b154aa64c1340f22dd0e0e4ccd3560fb14b249fafc0` |

The final inventory SHA-256 values are
`ff1283019f991589dba12c697455b847423798a9bf6c3bb30c070686b329803d`
(operative),
`a1f10c7d11de902f321296c2873da438bb801d20667fe16ce97e547d7120e168`
(notes), and
`187256161c3a0b0ac4e5b0b07f5a1233d1eae1962ed34b562c8edb3d13467b6d`
(CFR).

The rendered statutory audit reports 6,973 nodes, 267 run-in lines, 263
generated virtual paths, 5,287 operative citation links, and 23,909 links
across displayed cached statutory material. The artifact contains no malformed
`PLAW-publ` or `section-undefined` target, and the INA 101 review manifest
passes its independent replay check.
