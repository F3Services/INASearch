# Historical INA import

This import restores INA §§210A, 242A, 242B, 295, 321, 323, 345, 348,
350, 352–355, and 401. The original INA table-of-contents titles are used,
including the transferred §242A body and its corrected table-of-contents title. The bodies
retain the historical Code's printed, codified references.

`historical-ina.json` is the reviewed transcription and source manifest.
`raw/historical-ina/` retains official House and Library of Congress captures.
Every capture has a URL, capture date, byte count, and SHA-256. Each section
records its source pages, original-title source, amendment review, last
amendment date, repeal authority, effective date, and transcription hash.
These dates describe the historical body, independently of the current House
repeal/editorial record retained by the application.

| INA | Historical Code source | Final amendment | Repeal effective |
| --- | --- | --- | --- |
| 210A | 1988, pp. 48–53; 104 Stat. 5083/5085 and 105 Stat. 1756 amendments applied | 1991-12-12 | 1994-10-25 |
| 242B | 1995 House section; 110 Stat. 3009–645 amendment applied | 1996-09-30 | 1997-04-01, subject to transitions |
| 295 | 1997 House section | 1996-09-30 | 1998-10-21 |
| 321 | 1999 House section | 1988-10-24 | 2001-02-27 |
| 323 | 1958, p. 74 | 1958-08-20 | 1978-10-05 |
| 345 | 1958, p. 89 | 1952-06-27 | 1960-09-01 |
| 348 | 1988, pp. 190–191 | 1988-10-24 | 1990-11-29, with savings |
| 350 | 1958, p. 91 | 1952-06-27 | 1978-10-10 |
| 352 | 1958, p. 92 | 1952-06-27 | 1978-10-10 |
| 353 | 1964, p. 95 | 1959-08-04 | 1978-10-10 |
| 354 | 1964, pp. 95–96 | 1961-09-26 | 1978-10-10 |
| 355 | 1958, p. 94 | 1952-06-27 | 1978-10-10 |
| 401 | 1958, pp. 12–13 | 1952-06-27 | Immediately before noon, 1971-01-03 |

Page numbers above are one-based PDF pages. Later amendment histories were
checked against the House removal descriptions; the older edition is used
only where it contains the final wording. In §348 the 1988 amendment removed
former subsection (a) and redesignated (b)/(c) as (a)/(b). The original INA
title is intentionally retained despite this difference. Section 345's repeal
was effective September 1 even though enacted September 2. Section 350's
printed “displomatic” and its official correction note are retained.

The two reconstructed bodies require these explicit changes:

- §210A: update exclusion grounds in (e), the deportation citation in
  (d)(5)(A), and the single security-grounds clause in (e)(2)(B)(iii), removing
  former (iv). The 1990 amendments' distinct effective dates and the 1991
  retroactive correction are recorded in `amendmentReview`.
- §242B: replace “a special inquiry officer” with “an immigration judge” in
  (d)(1), effective September 30, 1996, before the general repeal date.

## Reproduction and structure

Run `node tools/build-standalone.js`, then
`node tools/test-historical-ina.js` and `npm test`.
The build validates the capture and transcription hashes before importing.
It requires no network access. A changed capture or transcription fails
validation until its reviewed manifest hash is deliberately updated.

Units use explicit paths and separate `heading`, `text`, and `continuation`
fields. The importer rejects duplicate paths or missing parents; the shared
run-in parser handles clauses within text. Continuations render, copy, and
search after their children. Historical bodies pass through the normal
reference generator, occurrence index, definitions catalog, and packing.

Sections 352–355 have separate Code identities 1484–1487. The original grouped
House record remains at `1484 to 1487`, and each individual record links back
to it. Section 401 maps historically to 1106; the unchanged crosswalk mapping
is preserved under `originalCrosswalk`.

## Historical references

The post-generation review in `tools/historical-ina.js` preserves former
1105a, 1251, 1252, and 1450 identities and the named Nationality Act of 1940
and Classification Act of 1949. Per-section `referenceCorrections` record
reviewed coordinated citations. Corrected spans must match the transcription
uniquely. Generated evidence displaced by a correction is removed and the
remaining evidence IDs are remapped before packing.

Red styling expresses a historical disposition; the separate target metadata
distinguishes repeal, transfer, and replacement. A verified modern destination
is informational and never substitutes for unavailable historical text.
Exact locally available historical targets support the normal reader and
popup actions with repeal warnings. Missing historical subsections, including
the printed §210A(a)(8) references to (d)(2)(A)/(B), remain unavailable rather
than being redirected to a guessed correction.

## Transferred INA 242A

The fourteenth body reconstructs 8 U.S.C. 1252a immediately before the
April 1, 1997 transfer to INA 238 / 8 U.S.C. 1228. Its manifest records the
1995 Code (PDF pages 154–156), AEDPA, IIRIRA, and the House's later amendment
history. AEDPA 440(g) and 442 are incorporated with retroactive corrections
from IIRIRA 304(c), 306(d), 374(a)(2), and 671(b)/(c). Changes effective with
the transfer—including removal terminology, renumbered references, the
no-enforceable-right sentence, broader judicial-deportation authority, and
stipulated judicial orders—are excluded. The manifest lists each decision.

The two enacted (c) designations are preserved. Only the explicitly marked
second root (c) may repeat a path in the importer; its children belong to
Judicial deportation. The warning explains the duplicated designation.
The record remains transferred, and opening it does not substitute current
INA 238 for its historical text. Former 1253 references preserve their
historical identity rather than opening today's penalties provision.
