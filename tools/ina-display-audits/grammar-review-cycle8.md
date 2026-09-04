# Cycle 8 grammar and source-order audit

Inputs: `tmp/ina-display-verified-final/display.jsonl` (c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8), baseline `tmp/ina-display-baseline/display.jsonl` (a3219dde0e81565cec5165c086fd6d4954b8bce4168dd8e3e19c8f60b4634dc3), artifact `431adb1fda8a8365e9b1f63214bc1b6dab6c195d73317169dbfa9cd3987aeaa7`, template `d2cf4ddab75c92daab14eb60c3eb576adcb7ec4ea01d7aa8bcdb1389198aa8b6`.

The audit examined 57,663 fields, 53,038 references, and 53,038 generated links; the baseline has 57,663 fields and 53,013 references. The source occurrence comparison found 25 additions and 0 removals. It rendered the current template to recover anchor positions, then checked exact source spans, link source/target metadata, source order, and all non-citation prose and punctuation after masking only citation spans and known group envelopes.

It checked 206 numbered groups, 8 repeated complete-citation groups, and 565 CFR Act-list groups (2,123 members). Every group's source envelope and each inter-member connector were compared character-for-character.

The parser also exposed 281 relative-unit constructions that are intentionally left in native trailing-container order (279 standalone and 2 nested under a rendered group). All 747 relative members were covered and their connectors/order were checked.

Footnote-aware rendering covered 143 fields and 151 markers. Run-in segmented rendering covered 112 fields and 399 segments.

Machine-assisted flags: 0. The flag file is `tools/ina-display-audits/grammar-flags-cycle8.json`. With zero flags, there were no new occurrence-level grammar or flow candidates requiring contextual adjudication; the report does not claim manual legal reading of every reference. Source-authored wording and typos remain source text and were not treated as display defects.

All checks are reproducible with:

`node tools/ina-display-audits/grammar-audit-cycle8.js tmp/ina-display-verified-final/display.jsonl tmp/ina-display-baseline/display.jsonl INASearch-Uncompressed.html src/INASearch.template.html tools/ina-display-audits/grammar-flags-cycle8.json tools/ina-display-audits/grammar-review-cycle8.md`

