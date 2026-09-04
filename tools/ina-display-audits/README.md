# INA citation display and reference audit

This audit accompanies the September 4, 2026 overhaul of the INA citation display setting. Reports and scripts are development evidence and are not embedded in the standalone HTML files.

## Scope and final behavior

Citation conversion preserves source order, connecting prose, and punctuation. A list with a trailing section container keeps that container at the end. Numbered lists and repeated complete citations abbreviate their shared ancestors; already abbreviated members never expand. Every visible link retains its exact original wording and complete target metadata.

Examples:

- INA 236(c)(1)(B): `INA 237(a)(2)(A)(ii), (A)(iii), (B), (C), or (D)`.
- INA 236(c)(1)(E)(i): `paragraph (6)(A), (6)(C), or (7) of INA 212(a)`.
- Repeated complete citations: `INA 237(a)(1), (2), and (3)` when subsection (a) is shared; `INA 237(a)(1), (a)(2), and (b)(1)` when only the section is shared.
- CFR alternatives: `INA 101(a)(27)(H) or (J)` and `INA 101(a)(15)(H) and/or (L)`.

The objective's second example wrote INA 237 for U.S.C. 1182(a); the reviewed crosswalk establishes INA 212(a).

## Reproduction

Run from the project root:

```sh
node tools/build-standalone.js
node tools/test-standalone.js
node tools/test-ina-display.js
node tools/audit-ina-display.js INASearch-Uncompressed.html src/INASearch.template.html tmp/ina-display-current
```

The original working artifact and template were frozen in `tmp/ina-display-baseline` before any task edits. Each subsequent cycle's full inventories remain in ignored `tmp/ina-display-cycleN`; reports bind their inputs by SHA-256. Large occurrence inventories are deliberately outside the application and source distribution.

## Root adjudication

The Luna auditors enumerated the entire corpus, applied contextual consistency checks to all occurrences, and investigated suspicious source contexts. This is exhaustive machine-assisted coverage with targeted contextual review, not a claim of manual legal reading of all 53,038 references.

The root independently inspected the flagged original text, current targets, and changes:

- Former section 1105a: confirmed three historical-note errors. The general grammar now accepts editorial bracketed unit nouns such as `such [section]`, and historical context propagates through a following `of such section` container. All three references remain official-source-only instead of opening unrelated current text.
- Shared trailing containers: confirmed eight wrong Title 38 targets in 8 U.S.C. 1612. Intervening prose must not attach an earlier clause list to a later section. The same general correction repaired two paragraph references in 1157(c)(2)(A) and one in 1227(c). The root checked every affected target against the local statutory hierarchy and source context.
- Nested exceptions and qualifications: an intermediate stricter grammar lost valid links in 1225 and 1761. Cycle 7 restored these by accepting a nested exception's closing parenthesis and comma-delimited `with respect to` qualifications. No provision-specific parser rules were introduced.
- CFR INA scope: confirmed missed 212(a)(2)/(3) citations in 240.66 and 1240.66. A conjunction introducing later prose does not begin a named-Act designation. The rule correction added 18 supported citations; recognizing the `and/or` connector added seven continuations. The root inspected all 25 additions in context.
- The 131 newly visible trailing-container links were already detected in the baseline. They were hidden by whole-group replacement. Restoring the native relative construction restores those links without changing their targets.
- Rejected stale flags proposing official-only resolution for section 1487: the local combined repealed record is intentional and retains its disposition metadata.
- Rejected a proposed unresolved treatment of source-authored 1153(a)(2)(A)(iii): it already uses an official-source-only link and does not pretend a local provision exists.
- Rejected the historical-version rationale at `8-1229a-note-11`, offset 2513: that occurrence is a `1101 note` locator. The actual preceding historical whole-Act reference at offset 2347 was already official-only.
- Rejected three claimed missing citations in 1324a and 1441: these are structural run-in clause labels introducing operative text, not references to other provisions.
- Discarded old audit rows whose field locations no longer reproduce their exact text, or whose proposed target/resolution already matches the current reference. Raw historical logs are leads, not current defect findings.

## Verification

The final source inventory has 53,038 references across 57,663 fields: 25 additions, no removed source occurrences, and 14 corrected target/resolution records compared with the original 53,013. Visible links increase from 52,882 to 53,038 because 131 previously detected links are restored. The dedicated regression suite checks every source link's membership and order, plus the requested display examples and corrected contexts.

The full standalone suite verifies both generated editions, source integrity, reference resolution, parser/browser parity, nested exceptions, definitions, loaders, and persistence behavior. Browser inspection verified INA 236 and CFR 245.1, an abbreviated reference preview's full target, and switching the setting off and back on. Inspection of 13,366 styled CFR fields found no new formatting-boundary display differences; one pre-existing single-reference styling-boundary limitation in 212.18 remains unchanged.

No manual parser exceptions were needed. The audit records include the [original-reference review](baseline-review.md), [final new-reference review](new-review-cycle8.md), and [final detection-difference review](diff-review-cycle8-baseline.md). Earlier cycle findings remain alongside those reports so that corrected defects and rejected flags can be traced.

**Completion:** The [fourth Luna grammar review](grammar-review-cycle8.md) completed with zero flags on the verified final build. It covered all 57,663 fields, 53,038 references/links, and 779 groups, plus 281 native relative-unit constructions, 151 footnote markers, and 399 rendering segments. No application changes followed that review. The root inspected its report, empty findings file, and reproducible checks; all four requested reviews and adjudications are complete.

The root also ran [check-prose-preservation.js](check-prose-preservation.js) against all 57,663 fields, 53,038 links, and 779 groups. It replaces each source reference and rendered link with the same ordinal marker and checks the remaining text exactly, allowing only citation designators inside recognized groups to disappear. There were zero differences in surrounding prose, punctuation, or link order. This supplements the independent fourth audit.

Verified final inputs:

| File | SHA-256 |
| --- | --- |
| `INASearch.html` | `983c510c4cfad816d082eae1a70a742126bd5bbdaf4023f93835e4be660e7ea8` |
| `INASearch-Uncompressed.html` | `431adb1fda8a8365e9b1f63214bc1b6dab6c195d73317169dbfa9cd3987aeaa7` |
| `src/INASearch.template.html` | `d2cf4ddab75c92daab14eb60c3eb576adcb7ec4ea01d7aa8bcdb1389198aa8b6` |
| Cycle 8 `display.jsonl` | `c8ec1ac2604d5c7aa6ba08b8481cc47e2d44a6f63477fba87710fe8362c853c8` |

The final standalone-suite rerun rebuilt the HTML after the new-reference report was written. A fresh inventory in `tmp/ina-display-verified-final` is byte-for-byte identical to the audited cycle 8 inventory; the template is unchanged. The table above identifies the delivered build.
