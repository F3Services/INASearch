# INA display diff audit — cycle 8 versus cycle 7

Audit date: 2026-09-04. This comparison isolates the cycle 8 generic connector/list parser change.

Inputs: cycle 7 `tmp/ina-display-cycle7/display.jsonl` (SHA-256 `00778c3a8f16e4db94c4a6e855f476076263fb791844c8cc6cbd3cc633039138`) and cycle 8 `tmp/ina-display-cycle8/display.jsonl` (SHA-256 `c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8`). Reproduce with:

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-cycle7/display.jsonl \
  tmp/ina-display-cycle8/display.jsonl \
  tools/ina-display-audits cycle8-cycle7
```

Cycle 7 has 53,031 references/links and cycle 8 has 53,038. Exactly seven references and seven rendered links were added, all in CFR fields and all classified as `restored-cfr-act-continuation-reference`. They are `(L) of the Act` or `(H) of the Act` continuations in 8 CFR 214.2 blocks, targeting local INA 101(a)(15)(L) or INA 101(a)(15)(H). Each surrounding sentence explicitly names the corresponding section 101(a)(15) alternative and uses “and/or”; the added link therefore has an unambiguous source span and target. No reference or link was dropped, and no target, resolution, false-positive, or ordering/membership change occurred.

The only presentation delta is one text-only grouped-list change caused by exposing the newly added continuation within its list. The occurrence log is `tools/ina-display-audits/diff-flags-cycle8-cycle7.json`; it contains all seven additions and source contexts. No case-specific rule was used.
