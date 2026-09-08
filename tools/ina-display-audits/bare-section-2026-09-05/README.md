# Bare section citations: INA display audit

This change converts supported bare `section N` citations using the existing Title 8–INA crosswalk in statutory text, notes, and regulations. The motivating reference in INA 212(d)(3)(B)(i), `section 1252(a)(2)(D)`, now displays as `INA 242(a)(2)(D)`. The underlying target and original wording remain available; disabling conversion restores the source wording.

## Final review scope

The frozen before/after comparison covers all 57,663 corpus fields. It contains 1,387 changed reference records across 533 affected fields. A supplemental review covers eight additional CFR fields whose only changes are authority-container prose outside link spans, including all 30 references in those fields. Together the reviews cover all 529 fields with changed visible text, plus 12 fields with reference-metadata changes only. Changes include new or removed spans, target and rule changes, and differently rendered links. A wider replacement span produces a removal/addition pair; these are records, not 1,387 unique new citations. Unchanged reference IDs and shifted display offsets are excluded from semantic differences.

Three Luna agents individually reviewed disjoint final shards of 463, 462, and 462 records. All main-shard records and all 30 supplemental references pass. `cycle12-review-{1,2,3}.json` contains the per-record verdicts and rationales. `cycle12-evidence.json.gz` retains the complete original/before/after text of affected fields plus the reference metadata and context for each change. `cycle12-summary.json` records corpus counts and hashes. `verify-review.js` checks unique complete coverage, source identity, literal context, passing verdicts, and current artifact/template identity. It verifies review bookkeeping; it does not replace human/agent semantic judgment.

## Findings and fixes

- Bare `section N` links can convert outside INA-mapped host sections, including notes and CFR text, when their actual target is mapped Title 8 material.
- Explicit foreign-title containers take precedence over coincident Title 8 section numbers. This fixes Title 28 `1361 or 1651 of such title`, former Title 22 section 1501, and Title 42 section 220. Executive-order section numbers are excluded from the Title 8 fallback.
- Shared lists convert as complete groups. A member without an INA equivalent retains an explicit U.S.C. label; switching authorities restores the full prefix. Unparsed list tails and explicit parallel U.S.C. citations retain coherent source notation.
- Redundant trailing authority containers are removed after conversion, including where parenthetical qualifications or relative ranges separate them from the source link. Quoted material, temporal qualifications, substantive prose, and link order are preserved.
- The list-prefix scanner uses linear token removal; a rejected nested-regex implementation exhibited excessive backtracking. The regression suite includes a long-input check.
- One existing INA 101 golden-review span expands from `1546(a)` to `section 1546(a)` while retaining its Title 18 target. This is a general parser outcome, not a manual corpus override.

No manual one-off source replacements were needed.

## Root adjudication and review rounds

Earlier review files are retained as history, not final approval. Earlier rounds found dangling authority phrases, incomplete list conversion, mixed INA/U.S.C. notation, and incorrect foreign-title assumptions. Those findings drove the general fixes above. Reviews with stale IDs, inadequate inspection, or flags that confused a widened span with a lost link were rejected or corrected. The backtracking implementation was abandoned before final review.

The final two flags (IDs 1120 and 1123) were reconsidered with the reviewer. `INA 236(c) and 241(a)` and `INA 238 or INA 235(b)(2)(A) or 240` use the app's established shared-prefix notation with no intervening authority change. All members map to INA; these are grammatical lists, so no code change was warranted. The reviewer updated both to pass. Final coverage checks match all 1,387 records to the actual diff. The supplemental prose-only evidence prevents changes outside link spans from falling through that diff. Root inspected all eight before/after fields: only redundant `of the Act` containers disappear, while qualifications, ranges, and temporal context remain. The final verifier proves coverage of all 529 changed display fields.

## Validation

Passed:

- `node tools/test-standalone.js`: full standalone, navigation/targets, formatting, definitions, CFR, profile, and build checks.
- `node tools/test-ina-display.js`: original example, preference off, cross-host conversion, foreign-title exclusions, qualified and mixed lists, ranges, and all 53,695 source links in exact order.
- `node tools/test-reference-authorities.js`: authority regressions, browser/Node parity, and 242 visa rows.
- `node tools/ina-display-audits/check-prose-preservation.js`: all 57,663 fields and 53,695 references, zero findings after allowing citation authority-container removal. Independent per-record review checks the grammatical scope of those removals.
- `node tools/ina-display-audits/bare-section-2026-09-05/verify-review.js`.
- `git diff --check`.

Real Chromium inspection of the LAN preview verified the original example's INA label and target, click navigation updating the search bar to `242a2d`, source wording restored with conversion off, and the converted 8 CFR 215.8 reference. The INA 101 historical note remains expandable and its explicit former-U.S.C. reference is retained. Screenshots were inspected; no browser errors were recorded. Local browser artifacts are in `tmp/ina-bare-section-browser/`.

The full test suite rebuilds the artifact with a new `generatedAt` timestamp. After that rebuild, the entire final `display.jsonl` was byte-for-byte identical to the reviewed cycle 12 output. The summary retains both build hashes and records this verification.

## Reproduction

From the repository root:

```sh
node tools/audit-ina-display.js INASearch-Uncompressed.html src/INASearch.template.html tmp/ina-display-current
node tools/ina-display-audits/bare-section-2026-09-05/verify-review.js
```

For a new change, freeze a baseline artifact/template and audit output, generate the new audit, then run `changes.js BASELINE_DIRECTORY CURRENT_DIRECTORY OUTPUT_DIRECTORY` in this folder. Re-review every resulting changed record. Do not update stored hashes to bypass a changed display comparison.

These files are prepared in the repository for GitHub review. This work has not been committed or pushed.
