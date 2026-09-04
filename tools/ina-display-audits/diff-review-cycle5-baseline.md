# INA display diff audit — cycle 5 versus frozen baseline

Audit date: 2026-09-04. This is an independent rerun against the frozen baseline after the generic historical-context fixes. No case-specific resolver rule was added by this review.

Inputs: baseline `tmp/ina-display-baseline/display.jsonl` (SHA-256 `a3219dde0e81565cec5165c086fd6d4954b8bce4168dd8e3e19c8f60b4634dc3`) and cycle 5 `tmp/ina-display-cycle5/display.jsonl` (SHA-256 `d739608e3941dbb553d7be826267867660d128e1e4e088d6375e113f8dbeb78f`). Reproduce with:

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-baseline/display.jsonl \
  tmp/ina-display-cycle5/display.jsonl \
  tools/ina-display-audits cycle5-baseline
```

All 57,663 field keys and all 53,013 reference occurrences remain present. The only source-reference change is one historical note field containing three occurrences at `title8.sections[1101].notes[16]` (`8-1101-note-17`):

| span | baseline | cycle 5 | adjudication |
| --- | --- | --- | --- |
| 4391–4394 `(b)` | 8 U.S.C. 1105a(b), local | 8 U.S.C. 1105a(b), official-source-only | valid resolution correction |
| 4513–4516 `(a)` | 8 U.S.C. 1101(a), local | 8 U.S.C. 1105a(a), official-source-only | valid historical target and resolution correction |
| 4521–4524 `(c)` | 8 U.S.C. 1101(c), local | 8 U.S.C. 1105a(c), official-source-only | valid historical target and resolution correction |

The source passage immediately precedes these locators with `section 106 of the Immigration and Nationality Act [former 8 U.S.C. 1105a] (as in effect ... )`; both “such section” and “such [section]” therefore refer to the former 1105a. Because that section was repealed, all three links must remain official-source-only. The corrected `(a)`, `(b)`, and `(c)` targets are confirmed by the dedicated display test and the captured House wording.

The comparator reports two target-key additions and two drops because `(a)` and `(c)` changed section identity; this is the expected replacement pair, not a lost detection. There are 131 baseline-suppressed relative-list restorations (130 local, one official-only), zero rendered-link drops, zero false-positive links, zero lost detections, and zero link-order or membership errors. Two rendered targets changed, exactly the `(a)` and `(c)` corrections above; the `(b)` change is resolution-only.

Cycle 5 has 616 changed fields and 710 changed groups relative to baseline. It has 1,348 presentation changes (1,346 text and 335 citation metadata changes), all target-preserving aside from the two adjudicated historical corrections. The cycle 5 artifact/template hashes are `6206d1acb4cb4626023949555fafa6c20d9c0f2c51204756041ec839f5bbe8e1` and `1e46bcd1133f86a3f6f59fe13620eaa00ac3d43ce1edc1bdb36b2fe0e1258820`.

The complete machine-readable occurrence evidence is `tools/ina-display-audits/diff-flags-cycle5-baseline.json`; it contains all three changed source occurrences, their before/after metadata, exact contexts, the 131 restorations, and presentation accounting.
