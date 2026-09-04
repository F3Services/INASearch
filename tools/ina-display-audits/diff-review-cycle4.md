# INA display diff audit — cycle 4

Audit date: 2026-09-04. This is the final rerun of the baseline comparison after the cycle 4 presentation refinement. The source corpus and generated reference inventory remain unchanged; this audit made no application, parser, resolver, or corpus edits.

Inputs are the frozen baseline `tmp/ina-display-baseline/display.jsonl` (SHA-256 `a3219dde0e81565cec5165c086fd6d4954b8bce4168dd8e3e19c8f60b4634dc3`) and cycle 4 `tmp/ina-display-cycle4/display.jsonl` (SHA-256 `c79a095a39b80edaabbf4cf5fafe4e9c82d9d7e1219fadac0bf7b3a7194baea8`). The cycle 4 occurrence log is `tools/ina-display-audits/diff-flags-cycle4.json`; the reproducible comparator is `tools/ina-display-audits/compare-display-inventories.js`.

```text
node tools/ina-display-audits/compare-display-inventories.js \
  tmp/ina-display-baseline/display.jsonl \
  tmp/ina-display-cycle4/display.jsonl \
  tools/ina-display-audits cycle4
```

Both inventories have 57,663 identical field keys and 53,013 identical source-reference records. Source-reference additions, drops, and metadata changes are all zero. Cycle 4 renders all 53,013 references; the baseline rendered 52,882. Every one of the 131 added links is a USC reference covered by a baseline `relative-unit-list` group, with an exact source span and unchanged family, resolution, section, and nested path. The additions are valid restorations (130 local and one official-source-only).

The exhaustive adjudication is zero false-positive links, zero lost detections, zero dropped rendered links, zero changed targets, and zero link-order or membership mismatches. Cycle 4 links are an exact ordered one-to-one match to its source references. The full 131 occurrence records and source excerpts are in `diff-flags-cycle4.json`.

Cycle 4 has 615 changed fields and 710 changed group records relative to baseline. There are 1,346 link presentation changes (1,346 text and 333 citation metadata changes; a link may change both), split across 233 operative USC, 185 USC-note, and 928 CFR occurrences. The cycle 4 group totals are 206 `numbered-section-list`, 8 `repeated-section-list`, and 555 `cfr-act-list`. These presentation changes preserve target identity and source spans. The cycle 4 artifact/template hashes are `0563704ea5c18044603d33db3d86d85a89428db709db1f202f2a961fb54a933f` and `6158accdeb34396e381fdc86765def40e33ae7f6a21821a92a682f76fb36f483`.

| check | result |
| --- | ---: |
| detected-reference additions/drops | 0 / 0 |
| rendered-link additions/drops | 131 / 0 |
| valid restorations | 131 |
| false-positive links | 0 |
| lost detections | 0 |
| changed targets | 0 |
| order/membership mismatches | 0 |

The cycle 4 refinement only changes how some grouped labels are shortened. It does not change any detected occurrence or destination, and the baseline-to-cycle-4 comparison remains closed with no suspect or regression.
