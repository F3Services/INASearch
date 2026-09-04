# New display citation audit: cycle 1

This is an occurrence-level audit of the frozen cycle 1 display inventory. It
compares each generated reference with the original source span and nearby
source prose, using the hash-verified House Title 8 XML and the captured eCFR
corpus in `sources/legal`. The full inventories stay in ignored `tmp/` files;
the companion JSON records only confirmed findings.

The source evidence manifest records House XML SHA-256
`69aaee9cc14dfd006daf6127ac0ffa5753af35f2e99cac56b4c84d7916e16fca`, GPO
INA compilation SHA-256
`b9ec47d7fa2897ceba296501aff7f33bb8d8c7f228488984e9df9d8e95e35c54`, and
USCIS crosswalk SHA-256
`e41d92a7d3d886ff22ece29ef8d5fa1c6156f89e617161738118faf82d30a005`.

The cycle 1 inventory contains 57,663 fields, 53,013 source references, and
53,013 generated links. Its SHA-256 is
`b5fe9f13023738c3aa2f2eb26a242f0837c9f73e639f617770848c2440cd8836`.

The reproducible runner is [review-new-display.js](review-new-display.js).
For example:

```sh
node tools/ina-display-audits/review-new-display.js \
  tmp/ina-display-cycle1-frozen/display.jsonl \
  INASearch-Uncompressed.html \
  tmp/ina-display-baseline/display.jsonl \
  tools/ina-display-audits/new-flags-cycle1.json
```

It checks source-span round trips, one-to-one reference/link cardinality,
source text, family, section and path identity, group boundaries, and the
cycle 1 to baseline reference set. All of those checks were zero failures.
The script also applies the contextual adjudication rules in its source and
writes exact offsets, source paths, snippets, targets, and reasoning.

## Confirmed cycle 1 findings

There are 13 confirmed occurrences, all preserved in
[new-flags-cycle1.json](new-flags-cycle1.json).

* `title8.sections[1101].notes[16]`, offsets 4391, 4513, and 4521: `(b)`,
  `(a)`, and `(c)` occur under the quoted former `8 U.S.C. 1105a` and the
  continuation “such section.” They were resolved to current `8 U.S.C. 1101`
  for the latter two and local resolution for the first. Each should resolve
  to former `8 U.S.C. 1105a` with official-source-only resolution.
* `title8.sections[1612].body[0/1/2/2]` and `[1/1/2/2]`, offsets 77, 84,
  162, and 169 in each field: the four `(i)`/`(ii)` occurrences are internal
  references to the preceding Title 8 clauses. The trailing “section 1304 of
  title 38” citation applies only to that section. All eight were incorrectly
  inherited as Title 38 section 1304 paths.
* `cfr.records[8:240.66].blocks[2]` and
  `cfr.records[8:1240.66].blocks[2]`, offset 51: `(a)(2)` is part of the
  explicit `section 212(a)(2) of the Act` citation and was left unlinked. The
  following `section 237` list is a separate authority.

## Later cycle verification

The same source-reference audit was rerun as renderer fixes were made. The
cycle 4 inventory retained the 13 findings. Cycle 5 changed the three former
`1105a` continuations to official-source-only. Cycle 7 corrected the eight
8 U.S.C. 1612(a)(2)(C)(iii) and (b)(2)(C)(iii) captures, corrected three
additional shared-container captures in 8 U.S.C. 1157(c)(2)(A)(1) and
1227(c)(1), and added the two section 212 links. Cycle 8 added five valid
members to clear CFR `and/or` lists. The final frozen cycle 8 inventory
contains 57,663 fields, 53,038 references, and 53,038 links; its SHA-256 is
`c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8`.
The current artifact hash is
`53a10b50e2a073ea66932d5f97c4396bd0ca7bfbd1489d96c7ef5c0f75640b46`; a fresh
run produces that same cycle 8 inventory byte-for-byte.
The cycle 8 rerun has zero confirmed findings and zero failures in the
structural checks. Twenty-five fields differ in their reference records versus
cycle 1; those differences are the documented fixes and additions above,
rather than silent source changes.

This review does not claim that a person manually read 53,038 links. It uses
exhaustive machine checks for every occurrence and contextual inspection of
the candidate set, with raw-source evidence for the confirmed cases.
