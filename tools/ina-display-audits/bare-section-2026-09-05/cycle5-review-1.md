# Bare-section cycle 5 — Luna review shard 1

Reviewed all 109 rows in `tmp/ina-bare-section-cycle5/review/shard-1.json`. Every reassigned ID is present in `cycle5-review-1.json`, and every row includes the literal occurrence-level `afterContext` used for the grammar decision.

102 rows pass. 7 rows flag mixed rendered authority/list grammar: IDs 16, 22, 25, 43, 124, 190, and 232. These after contexts retain an 8 U.S.C. bracket list with only part of the list converted to INA, or leave an INA citation followed by an authority tail such as “of this title.” The flags are based on the actual afterContext, not merely crosswalk existence. The three apparent removals at IDs 46, 73, and 76 are paired with wider source-field replacements or are non-USC authority text and therefore pass.

Apparent removed spans were checked against the full source-field changes for wider replacement links and were not flagged as losses when paired replacements existed.

Input bindings:

- `shard-1.json` SHA-256: `84897771fe21bffee69fa18921bd543b5e8c51f6afcbe73e173cce582ad5a4f9`
- `changes.json` SHA-256: `072ece2fe2dacaf615a0830c2664026dd9f45f01814ec9720e607a3adef598a4`
- `summary.json` SHA-256: `1fac59682f06b4f5b95c69e52c5abe8b03fed17326f943f556a7260155468b84`

Verdict counts: **102 pass, 7 flag**.
