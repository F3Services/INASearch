# Bare-section cycle 1 — Luna review shard 1

Reviewed 82 of the 246 changed references (IDs 1–244 as assigned in shard-1.json). Every assigned ID is represented in cycle1-review-1.json.

Each source field and rendered afterField was read around its changed occurrence. 46 rows are flagged because the conversion leaves a USC locator attached to an INA designator (`of this title`, `of the Immigration and Nationality Act`, or `of such Act`); 36 rows pass because their rendered wording is grammatically complete without that locator. Every row retains the same target metadata before and after conversion.

The current crosswalk validates all 32 unique USC sections represented in this shard. This includes historical/former-section mappings such as 8 U.S.C. 1105a → INA 106, 1228 → INA 238, 1252a → INA 242A, 1254a → INA 240A, and 1255a → INA 245A. Historical-note contexts retain their source-authorized wording and punctuation; none require a target correction or unresolved treatment.

Verdict counts: **36 pass, 46 flag**.
