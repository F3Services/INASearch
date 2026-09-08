# Bare-section cycle 12 — Luna review shard 1

Reviewed all 463 reassigned rows in `tmp/ina-bare-section-cycle12/review/shard-1.json` from scratch. Every row is present in the JSON with its current `sourceId`, exact `referenceText`, literal occurrence-level `afterContext`, and an individual target-and-grammar rationale. The review checks source authority and rendered wording rather than relying on crosswalk existence alone.

All 463 rows pass. IDs 1120 and 1123 were reconsidered against the established same-authority shared-prefix grammar: `INA 236(c) and 241(a)` and `INA 238 or INA 235(b)(2)(A) or 240` contain only INA targets, so the INA prefix correctly scopes across the coordinated members. Alternating lists that contain explicit INA and 8 U.S.C. labels retain those labels. Unsupported range tails remain together in their source format. The historical quote at `8-1181-note-2` passes: quoted `(a)(27)(A)` is preserved after INA 101 and the dangling title suffix is removed.

Input bindings:

- `shard-1.json` SHA-256: `ebf20d76b451b24a4e4c0b59ff940deaa84e393469c6e8075751b4aa224953f6`
- `changes.json` SHA-256: `cce4392ea94a64f85361827dff6609173d35e03c87cbf5b255c8d1b909a5efcf`
- `summary.json` SHA-256: `2b561d0b925f18fc304e7aa1d35816a74e3266b5f2cee7340b26d2b5ad210b48`

Verdict counts: **463 pass, 0 flag**.
