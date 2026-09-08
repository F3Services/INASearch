# Bare-section Cycle 1 Luna review — shard 2

Reviewed all 82 changed references in tmp/ina-bare-section-cycle1/review/shard-2.json against the full original/before/after fields and the current INASearch-Uncompressed.html corpus through tools/audit-inline-references.readArtifact.

Result: **42 pass, 40 flags**.

Flags cover three categories:

- The converted citation is followed by a leftover “of this title,” “of such Act,” “of the Immigration and Nationality Act,” or “of this act” container, creating redundancy or bad grammar in the INA display.
- **ID 29** converts `section 1101(4) of Ex. Ord. No. 12656` as INA 101(4), a misleading Executive Order destination.
- **ID 215** leaves the second member `1182(a)(3) ... of this title` unconverted after INA 212(a)(2), producing a mixed USC/INA list.
- **ID 224** leaves `paragraph (2) of INA 308, of this title`, with a dangling comma and title qualifier.

All flagged rows retain their corpus-confirmed destination metadata; the flags concern semantic authority or rendered grammatical flow. The remaining rows have matching built-corpus target section/path and resolution metadata and read coherently in their full field context. Historical references with official-source-only resolution were accepted where their surrounding text does not introduce a container problem.
