# Bare-section cycle 2 Luna review — shard 3

Reviewed all 91 reassigned rows from tmp/ina-bare-section-cycle2/review/shard-3.json against each full original/before/after field and the built corpus via tools/audit-inline-references.readArtifact. Additions, removals, target corrections, historical references, and display conversions were checked from source wording.

Result: **89 pass; 2 flagged.**

## Flags

- ID 24: Wrong historical target: the source says “former section 1501 et seq. of title 22,” so this is a Title 22 reference and must remain official-source-only; converting it to INA 358/Title 8 is misleading.
- ID 249: Grammar/authority-tail issue: after converting the first reference, the field reads “INA 301, and of paragraph (2) of INA 308, of this title,” leaving a redundant trailing “of this title” container attached to the INA label/list.

The Title 28 correction at ID 195 and non-INA additions/removals (IDs 33, 51, 57, 60, 192, 231, and 246) were verified against their explicit title references.
