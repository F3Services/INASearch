# New display citation audit: final cycle 8

The final frozen inventory is
`tmp/ina-display-cycle8-frozen/display.jsonl`, SHA-256
`c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8`.
It contains 57,663 fields, 53,038 source references, and 53,038 generated
links, including 565 CFR Act-list groups.

The current `INASearch-Uncompressed.html` hash is
`53a10b50e2a073ea66932d5f97c4396bd0ca7bfbd1489d96c7ef5c0f75640b46`; a fresh
inventory from that artifact is byte-for-byte identical to the frozen cycle 8
inventory above. The template hash is
`d2cf4ddab75c92daab14eb60c3eb576adcb7ec4ea01d7aa8bcdb1389198aa8b6`.

The exhaustive runner is [review-new-display.js](review-new-display.js). It
validated every source span, link count, source text, family, section, target
path, and group boundary. Each structural check was zero. The cycle 1 to
cycle 8 comparison found 25 fields with reference-record differences, all
within the documented
fix set: three historical `1105a` continuations, eight erroneous captures in
8 U.S.C. 1612(a)(2)(C)(iii) and (b)(2)(C)(iii), three additional shared
container captures in 8 U.S.C. 1157(c)(2)(A)(1) and 1227(c)(1), two CFR
section 212(a)(2) links, and the later valid CFR list members.

The final cycle has zero confirmed occurrence-level findings. The prior cycle
1 findings and their exact contexts remain in
[new-flags-cycle1.json](new-flags-cycle1.json); the final empty result is in
[new-flags-cycle8.json](new-flags-cycle8.json). This is an exhaustive machine
audit plus contextual review of its candidate set, rather than a claim of
manual reading of every link.
