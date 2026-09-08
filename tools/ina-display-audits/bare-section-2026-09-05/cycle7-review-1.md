# Bare-section cycle 7 — Luna review shard 1

Reviewed all 232 rows in `tmp/ina-bare-section-cycle7/review/shard-1.json` individually. The JSON binds each reassigned ID to its `sourceId`, exact `referenceText`, literal occurrence-level `afterContext`, verdict, and rationale. I checked the source wording and target section/subsection path for each row; crosswalk presence alone was not treated as sufficient.

215 rows pass. 17 rows flag rendered authority or list grammar: IDs 31, 61, 64, 67, 85, 88, 94, 112, 115, 136, 139, 232, 367, 412, 463, 640, and 652. These flags cover INA citations retaining a USC-title tail, mixed shared lists such as “sections 1427, INA 319(b)”, dangling bare numeric members beside INA labels, and the redundant “of This Title” heading. Quoted statutory parentheticals that explicitly contain both INA and 8 U.S.C. forms were retained when the source itself supplies both authorities. Null removed spans were treated as paired wider replacements where the surrounding source field preserves the authority.

Input bindings:

- `shard-1.json` SHA-256: `b4c6563055168953e37f33b5fae4397868e643fd22f9f78ea0fa94bc3bd995a7`
- `changes.json` SHA-256: `2688c3646acaa8ca3696fc57dcced77b693df40033355ec6130350286c8267f4`
- `summary.json` SHA-256: `e17f0d564563a9f20c1d998490d1a9378bf4be073dc79df2df1e7fd0c012ee2b`

Verdict counts: **215 pass, 17 flag**.
