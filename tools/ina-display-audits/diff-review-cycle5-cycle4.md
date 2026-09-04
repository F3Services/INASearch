# INA display diff audit — cycle 5 versus cycle 4

Audit date: 2026-09-04. This independent comparison isolates the generic historical-context correction from the cycle 4 display refinement.

Inputs: cycle 4 `tmp/ina-display-cycle4/display.jsonl` (SHA-256 `c79a095a39b80edaabbf4cf5fafe4e9c82d9d7e1219fadac0bf7b3a7194baea8`) and cycle 5 `tmp/ina-display-cycle5/display.jsonl` (SHA-256 `d739608e3941dbb553d7be826267867660d128e1e4e088d6375e113f8dbeb78f`). Reproduce with:

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-cycle4/display.jsonl \
  tmp/ina-display-cycle5/display.jsonl \
  tools/ina-display-audits cycle5-cycle4
```

The inventories still contain 57,663 field keys and 53,013 references. Exactly three source occurrences changed, all in `8-1101-note-17`: `(b)` at 4391–4394 changed from local to official-only while retaining former section 1105a; `(a)` at 4513–4516 changed from current 1101/local to former 1105a/official-only; and `(c)` at 4521–4524 received the same target and resolution correction. The preceding quoted text expressly identifies former section 106 as former 8 U.S.C. 1105a, and the following “such section” / “such [section]” locators inherit that historical antecedent. All three corrections are valid improvements; no case-specific rule was used.

There are zero rendered-link additions or drops, zero false positives, zero lost detections, and zero order/membership errors. Two rendered target identities changed (`(a)` and `(c)`), and one link changed resolution only (`(b)`). The comparator’s two source-key additions and drops are the expected replacement of the two former 1101 targets. The only other delta is two citation metadata updates for the corrected `(a)` and `(c)` links.

The complete occurrence evidence is `tools/ina-display-audits/diff-flags-cycle5-cycle4.json`. The cycle 5 artifact/template hashes are `6206d1acb4cb4626023949555fafa6c20d9c0f2c51204756041ec839f5bbe8e1` and `1e46bcd1133f86a3f6f59fe13620eaa00ac3d43ce1edc1bdb36b2fe0e1258820`.
