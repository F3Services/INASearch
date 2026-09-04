# Frozen baseline inline-reference audit

Audit target: the frozen pre-display-change artifact and its three task-supplied JSONL inventories. No application, parser, corpus, or generated-HTML file was modified by this audit.

Artifact SHA-256: `931491856a869e0ad1d62d761e6bc7b682a7a4e392dfa48a122218764aa8179b` (tmp/ina-display-baseline/INASearch-Uncompressed.html).
Inventory SHA-256: usc-operative `b956f15ec195569d91bbde6134489fa8b8b49be5910d7ba9795c39bafcf3390e`; usc-notes `971ca8e71aeb58921da1a9c227b7ae2210106b208ee5c9beca99f15b03cfb18e`; cfr `b8bb09afd3cb764ddd99f05968c4dac24e7a7977e848a0e7733ca42d23f6f1a2`.

## Coverage

The independent walk regenerated the JSONL inventories byte-for-byte (0 mismatches). It covered every displayed heading, preamble, body text, note, source-credit, editorial-footnote, CFR authority/source/heading, section, appendix, and nested CFR block represented in the artifact.

| scope | generated references | parenthetical candidates | linked | structural | unlinked |
| --- | ---: | ---: | ---: | ---: | ---: |
| usc-operative | 5645 | 5007 | 4690 | 288 | 29 |
| usc-notes | 19875 | 18662 | 8880 | 0 | 9782 |
| cfr | 27493 | 48098 | 13382 | 30165 | 4551 |
| **total** | **53013** | **71767** |  |  |  |

Field walk counts (including fields with no references):

| scope | field | fields | generated references | candidates |
| --- | --- | ---: | ---: | ---: |
| usc-operative | heading | 3137 | 192 | 97 |
| usc-operative | preamble | 81 | 66 | 52 |
| usc-operative | text | 6155 | 5387 | 4858 |
| usc-notes | heading | 2167 | 15 | 9 |
| usc-notes | text | 2573 | 16959 | 17290 |
| usc-notes | sourceCredit | 286 | 2901 | 1363 |
| cfr | heading | 3222 | 76 | 62 |
| cfr | authority | 166 | 1444 | 107 |
| cfr | source | 116 | 131 | 0 |
| cfr | x | 39760 | 25842 | 47929 |

Generated-reference span round-trip mismatches: **0**; overlaps: **0**; empty spans: **0**; unknown families: **0**; finding-span mismatches: **0**.

## Findings

The occurrence-level log contains **5** findings that remain present in this baseline: 2 missing-link, 1 incorrect-resolution, 2 incorrect-target. The complete machine-readable log is [baseline-flags.json](baseline-flags.json).

Findings are retained only when the exact source ID, source path, UTF-16 offset, and text still match the baseline state. A missing-link finding is discarded if the baseline already emits any overlapping reference. A target finding is discarded if the baseline target/resolution no longer matches the historical finding. This prevents stale prior-cycle findings from being reported as current defects.

Every generated reference also receives deterministic contextual checks: field-span round-trip, target-family metadata, local target-section presence in the frozen USC/CFR indexes, and nearby historical wording cues. Aggregate results are stored under `contextAudit` in the JSON log; cue hits are review leads, not automatic errors, because legal notes often discuss both current and former provisions in one passage.

Context checks covered **53013** references: 28681 local targets were found in the frozen section indexes, 0 local target labels were not directly indexed (mostly abbreviated or cross-reference forms), 165 had nearby historical wording cues, and 0 lacked basic family metadata.

### Explicit dispositions

The following prior flags were explicitly rejected after rereading the frozen House text/context:
- `cfr` cfr-20:416.1165 @ 180 (e)(3): Stale prior-cycle row: this text span is not present in the frozen block, so it fails the exact field/text guard.
- `usc-notes` 8-801 to 810-note-7 @ 181 section 1487 of this title: The House corpus supplies a combined local repealed record for sections 1484 to 1487; the prior official-only rationale was false.
- `usc-notes` 8-801 to 810-note-9 @ 321 section 1487 of this title: The House corpus supplies a combined local repealed record for sections 1484 to 1487; the prior official-only rationale was false.
- `usc-notes` 8-1229a-note-11 @ 2513 8 U.S.C. 1101: This occurrence is the parenthetical locator '(8 U.S.C. 1101 note)' for IIRIRA section 309, not the preceding historical whole-INA citation; the local resolution is appropriate.
- `usc-operative` 8-1324a-a-1-B-i @ 119 (ii): Run-in marker introducing clause text ('if the person ...'), not a cross-reference mention.
- `usc-operative` 8-1441 @ 448 (i): Run-in marker introducing clause text ('which is registered ...'), not a cross-reference mention.
- `usc-operative` 8-1441 @ 512 (ii): Run-in marker introducing clause text ('the full ... title ...'), not a cross-reference mention.

CFR target identity and nested address paths were checked against the captured eCFR-backed corpus indexes; the two surviving CFR findings are explicit statutory references in source text and remain unlinked in the frozen baseline. Historical House/INA amendment citations are reported as official-source-only target findings where their text is expressly historical; they are not judged against current Title 8 text. Apparent date/chapter citations with no Congress/law number in old repeal headings are retained as source-authored official-only references, not marked malformed.

## Limits

This is exhaustive occurrence enumeration and contextual review of every generated reference and parenthetical candidate, with targeted source-context adjudication of suspicious groups. It is not a manual legal reading of every sentence or a claim that the House/eCFR source text itself is substantively error-free. The frozen artifact is a historical snapshot; rerun this script after any resolver or corpus change.

Prior audit TSV evidence used for occurrence-level adjudication: 2 files (sources/legal/luna-audit-cfr-cycle11-flags.tsv, sources/legal/luna-audit-usc-notes-cycle11-flags.tsv).
