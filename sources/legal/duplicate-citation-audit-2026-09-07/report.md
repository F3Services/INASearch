# Exact duplicate-citation audit — 7 September 2026

Read-only audit of the built INASearch corpus. No application or corpus fixes were made.

## Scope and method

- Scanned all 376 Title 8 statutory section records and all 6,973 structural provision nodes using exact, case-sensitive section numbers and parenthetical paths.
- Independently checked provision identifiers in the captured House USLM XML (`sources/legal/raw/usc08@119-102.xml`, edition Online@119-102). It confirms the same seven duplicated structural citation identifiers.
- Checked 273 reconstructed inline numbering markers separately; four additional candidate collisions are explained below.
- Scanned paragraph addresses in all 3,039 CFR section records, including ordinary notes but excluding editorial/effective-date note versions. Repeated citation links, repeated quoted references, and different CFR titles sharing a section number do not count.
- Letter-suffixed section/subsection shorthand and case-folding ambiguities are excluded. INA and U.S.C. crosswalk equivalents are counted once.
- This is an audit of the local snapshot, not a certification of the live/current law. Live House/eCFR page retrieval was unavailable; House confirmation uses the captured official XML.

## House-confirmed statutory duplicates

| Exact INA citation | Exact U.S.C. citation | Two competing pieces of text |
|---|---|---|
| INA 204(a)(1)(B)(i)(I) | 8 U.S.C. 1154(a)(1)(B)(i)(I) | LPR family-petition authorization; restriction for petitioners convicted of a specified offense against a minor. |
| INA 212(t) | 8 U.S.C. 1182(t) | Nonimmigrant professionals/labor attestations; foreign residence requirement. |
| INA 212(t)(1) | 8 U.S.C. 1182(t)(1) | Employer labor-attestation requirement; two-year foreign-residence requirement. |
| INA 212(t)(2) | 8 U.S.C. 1182(t)(2) | Labor-attestation administration/enforcement; waiver of the foreign-residence requirement. |
| INA 212(t)(2)(A) | 8 U.S.C. 1182(t)(2)(A) | Public access to attestations; exceptional hardship to spouse or child. |
| INA 212(t)(2)(B) | 8 U.S.C. 1182(t)(2)(B) | Labor-attestation complaint/investigation provisions; public/national-interest waiver criterion. |
| INA 238(c) | 8 U.S.C. 1228(c) | Presumption of deportability; judicial removal. |

Each of these exact paths occurs twice. There are three underlying duplicate-label events; five paths result from the two subsection-(t) trees. No additional shared descendants were found. INA 242(c) was not a duplicated structural path in this snapshot; INA 238(c) may be the remembered example.

## House notes and actual display

- INA 204: footnote 1 on the second `(I)` reads **“So in original. Probably should be ‘(II)’.”** (Quotation marks normalized here.) The note and its source-location metadata are retained.
- INA 212: footnotes 11 and 12 on the two `(t)` headings each state **“So in original. Two subsecs. (t) have been enacted.”** Both are retained separately.
- INA 238: footnote 1 states **“So in original. Two subsecs. (c) have been enacted.”** Both headings point to it.
- Chromium inspection confirmed that all four note entries render in the full-section readers. Both INA 238(c) headings have superscript footnote links; clicking the second link successfully reaches the note.
- **Navigation defect:** both INA 238(c) markers use `house-footnote-reference-usc-1228-fn002044-0`. Their shared Return destination cannot distinguish the first and second occurrence.
- **Citation-resolution concern:** the reader's structural index uses a Map keyed by citation path and overwrites an earlier occurrence with a later one, whereas `statuteNodeAtPath` uses first-match traversal. Thus preserving the notes does not itself provide a two-choice exact-citation resolver. This is a code finding; individual outcomes for every feature were not exhaustively exercised.

## Additional CFR corpus-address collisions

These are repeated stored addresses, **not confirmed duplicate enactments**. Several show obvious loss of paragraph ancestry in the surrounding stored text. They should not be described to users as intentional legal ambiguity without source-level validation.

| Stored citation | Occurrences |
|---|---:|
| 8 CFR 214.1(a)(2) | 2 |
| 8 CFR 214.1(a)(2)(ii) | 3 |
| 8 CFR 214.1(a)(2)(iii) | 3 |
| 8 CFR 214.1(a)(2)(i) | 2 |
| 8 CFR 214.1(a)(2)(iv) | 2 |
| 8 CFR 274a.2(b)(4) | 2 |
| 8 CFR 274a.2(b)(4)(iii)(C) | 2 |
| 8 CFR 274a.2(b)(4)(iii)(C)(1) | 2 |
| 8 CFR 274a.2(b)(4)(iii)(C)(2) | 2 |
| 8 CFR 274a.2(b)(4)(ix)(A) | 3 |
| 8 CFR 274a.2(b)(4)(ix)(B) | 3 |
| 20 CFR 655.15(f)(2)(i)(C)(1) | 2 |
| 20 CFR 655.15(f)(2)(i)(C)(2) | 2 |
| 20 CFR 655.15(f)(2)(i)(C)(3) | 2 |
| 20 CFR 655.19(e)(1) | 2 |

The fifteen paths are concentrated in four sections:

- **8 CFR 214.1:** stored addresses continue under `(a)(2)` after paragraphs beginning `(3)` and `(b)` that lack their own parsed addresses. This points to hierarchy-parsing errors.
- **8 CFR 274a.2:** unrelated employment-verification provisions share paths beginning `(b)(4)`; surrounding parsed ancestry needs repair and official-source comparison.
- **20 CFR 655.15:** worker eligibility criteria and employer attestation duties reuse generated paths under `(f)(2)(i)(C)`; the apparent parent hierarchy differs in the prose.
- **20 CFR 655.19(e)(1):** two actual paragraph blocks repeat the designation with different recruitment cross-references. Source/version validation is still required.

All paragraph text, occurrence counts, block locations, and official source URLs are preserved in `findings.json`.

## Inline-numbering candidates, excluded from the seven confirmed structural duplicates

- **INA 210 / 8 U.S.C. 1160:** the run-in index assigns `(a)(2)(I)` and `(a)(2)(II)` to inline alternatives under both `(A)` and `(B)`. The source contexts are different subparagraphs; these are generated ancestry collisions, not two enacted provisions with the same complete source citation.
- **INA 324 / 8 U.S.C. 1435(a):** introductory prose contains inline `(1)` and `(2)` eligibility categories, followed by formal paragraphs `(a)(1)` and `(a)(2)` containing naturalization exceptions. The renderer explicitly suppresses navigation on the colliding inline markers (`structural-duplicate`). These repeated inline numbers are not additional duplicated House provision identifiers.

## Reproduction and evidence

Run `node sources/legal/duplicate-citation-audit-2026-09-07/audit.cjs` from the project root. This rewrites only the audit JSON. The JSON records the built-artifact SHA-256, all duplicate occurrences, and the relevant House footnotes.
