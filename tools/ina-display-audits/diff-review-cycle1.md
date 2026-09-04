# INA display diff audit — cycle 1

Audit date: 2026-09-04. This is an independent comparison of the frozen baseline display inventory and the cycle 1 display inventory. The audit is presentation-only; no parser, resolver, corpus, or application file was changed by this review.

## Inputs and reproducibility

- Baseline inventory: `tmp/ina-display-baseline/display.jsonl` (SHA-256 `a3219dde0e81565cec5165c086fd6d4954b8bce4168dd8e3e19c8f60b4634dc3`)
- Cycle 1 inventory: `tmp/ina-display-current/display.jsonl` (SHA-256 `b5fe9f13023738c3aa2f2eb26a242f0837c9f73e639f617770848c2440cd8836`)
- Comparison script: `tools/ina-display-audits/compare-display-inventories.js`
- Occurrence log: `tools/ina-display-audits/diff-flags-cycle1.json`

Re-run with:

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-baseline/display.jsonl \
  tmp/ina-display-current/display.jsonl \
  tools/ina-display-audits cycle1
```

The source artifacts recorded in the inventories were also checked: the baseline artifact/template hashes are `931491856a869e0ad1d62d761e6bc7b682a7a4e392dfa48a122218764aa8179b` and `705b224e30adc304b8c8bc57ad94a9ca3d909c3aa39cfcb0e1c7fc1ce677e28f` respectively; the cycle 1 artifact/template hashes are `ba5d2e7f5665e5bb70181e3d69d60d105a841c72e94bef2fd082e9df16fbc8da` and `fdbca8568714fa2db073ed02e8d9837de022919f4e9125d36ef78d98400be88a`.

## Exhaustive coverage

Both inventories contain the same 57,663 field keys. Every source reference array is byte-for-byte identical: 53,013 detected references in each inventory, with zero detected-reference additions, drops, or metadata changes. This closes the lost-detection and false-positive source-inventory questions for the requested comparison.

The baseline rendered 52,882 links and cycle 1 rendered 53,013. The 131-link increase is fully accounted for. Every one of the 131 additions is a USC reference whose exact source span, family, resolution, section, and nested path match an existing source reference. Each was covered by a baseline `relative-unit-list` group that had suppressed the individual container reference. They are therefore valid restorations, recorded one occurrence per flag in `diff-flags-cycle1.json` under `restored-reference-previously-suppressed-by-relative-unit-list` (130 local targets and one official-source-only target).

There are zero dropped rendered links, zero lost rendered detections, zero unbacked current links, zero target changes, and zero link-order or membership mismatches. The current 53,013 links form an exact ordered one-to-one sequence with the 53,013 source references. Thus no added or dropped reference is a false positive, and no source occurrence was lost.

## Presentation differences

The renderer changed 726 fields and 710 group records. These are display changes after the source inventory remained fixed:

- 1,468 link presentation changes: 1,468 link-text changes and 333 citation-metadata changes. Some links change both dimensions.
- By source scope, presentation changes are 233 operative USC, 185 USC-note, and 1,050 CFR occurrences.
- Baseline groups were 206 `numbered-section-list` and 131 `relative-unit-list`; cycle 1 groups are 206 `numbered-section-list`, 8 `repeated-section-list`, and 555 `cfr-act-list`.

The occurrence log retains the exact source span, source context, baseline/current link contents, and target metadata for all 131 added links and all 1,468 presentation-only link changes. No presentation-only change altered family, section, nested path, or source span.

## Adjudication

The independent checks are: exact field-key comparison; exact source-reference-array comparison; reverse-order alignment of repeated links; current link-to-source-reference membership and order validation; baseline suppression-group containment; and target identity comparison on every aligned occurrence. The result is:

| check | result |
| --- | ---: |
| detected-reference additions/drops | 0 / 0 |
| rendered-link additions/drops | 131 / 0 |
| valid restorations | 131 |
| false-positive links | 0 |
| lost detections | 0 |
| changed targets | 0 |
| order/membership mismatches | 0 |

Because all added links reuse unchanged source references and their unchanged House/eCFR resolution metadata, the source-context adjudication is unanimous: the cycle 1 change exposes references that the baseline grouped renderer had hidden, while preserving every target and resolution decision.
