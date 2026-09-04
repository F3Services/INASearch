# INA display diff audit — cycle 8 versus frozen baseline

Audit date: 2026-09-04. This audit compares the frozen baseline with the cycle 8 inventory after the cycle 5 historical correction, cycle 7 target repairs, and cycle 8 CFR continuation parser change. The comparison is independent of the implementation changes and contains no case-specific rule.

Inputs: baseline `tmp/ina-display-baseline/display.jsonl` (SHA-256 `a3219dde0e81565cec5165c086fd6d4954b8bce4168dd8e3e19c8f60b4634dc3`) and cycle 8 `tmp/ina-display-cycle8/display.jsonl` (SHA-256 `c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8`). Reproduce with:

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-baseline/display.jsonl \
  tmp/ina-display-cycle8/display.jsonl \
  tools/ina-display-audits cycle8-baseline
```

All 57,663 field keys remain present. The baseline has 53,013 source references and cycle 8 has 53,038. The comparator records 21 changed source occurrences, 38 reference-key additions and 13 reference-key drops; the additions/drops include replacement pairs for corrected targets. Every cycle 8 link still matches a source reference in exact order and membership.

Among the 14 source-reference changes affecting target or resolution, all are valid: the historical `8-1101-note-17` locators `(a)` and `(c)` now refer to former 8 U.S.C. 1105a with official-only resolution, while `(b)` keeps its former 1105a target and receives the same official-only resolution; two §1157(c)(2)(A) paragraph `(1)` locators now target §1157(c)(1); one §1227(c) paragraph `(1)` locator now targets §1227(a)(1); and eight §1612(a)/(b)(2)(C)(i)/(ii) locators now target their enclosing Title 8 paths instead of unrelated Title 38 §1304. The source contexts establish each antecedent: the historical passage explicitly says former 8 U.S.C. 1105a; the §1157 and §1227 text names the current paragraph/container; and the §1612 sentence's trailing “section 1304 of title 38” is an explicit separate citation after the local clause lists. The 7 rule-ID-only changes preserve target, resolution, and span identity.

The baseline rendered 52,882 links and cycle 8 renders 53,038. The 156-link increase consists of 131 references previously suppressed by baseline relative-unit groups and 25 valid CFR INA Act-continuation references. The 18 cycle 7 additions cover explicit continuation references across CFR 204.2, 204.5, 214.2, 214.4, 240.66, 245.1, 245a.2, 319.5, 1240.66, and 1245.1, including INA 203(a)(1), 203(b)(2), 101(a)(15)(H)/(L)/(F), 212(a)(2)/(3), 201(b), 203(a)(2), and 319(b). The 7 cycle 8 additions are the remaining repeated `(L) of the Act` and `(H) of the Act` continuations in CFR 214.2; their exact contexts identify local INA 101(a)(15)(L)/(H) targets. All 25 are `context-cfr-ina-act-section` occurrences. There are zero dropped links, false-positive links, lost detections, or order/membership errors. The 13 rendered target changes are exactly the 13 adjudicated source target corrections.

The complete occurrence evidence is `tools/ina-display-audits/diff-flags-cycle8-baseline.json`. It contains all source changes, all 156 additions, target comparisons, exact source contexts, and presentation accounting. Cycle 8 has 624 changed fields and 712 changed groups relative to baseline, with 1,360 presentation-only link changes; these do not introduce additional target defects.
