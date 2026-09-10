# CFR hierarchy repair audit — September 10, 2026

The repair changes hierarchy metadata in **161 blocks across 11 sections**, restores
65 unit markers, and preserves all captured regulatory text, source dates and
coverage: 174 parts, 3,039 sections, 10 appendices and 15 graphics in 11 titles.
The reader fix applies throughout the corpus, including 5,664 parent paths.

## Source findings and corrections

The audit inspects all section renderer elements and separately checks the complete
XML body text for every section and appendix. Visible marker findings are classified
before repair: **547** publisher-disabled or definition-list entries and **486**
reviewed local-list/form entries retain their source organization; **58** other
visible-marker entries become addressable. Compound headings and the missing opening
parenthesis in 20 CFR 655.73 account for the remaining restored units.
All **942** isolated italic numeric/Roman markers agree with their corrected levels.

| Section | Corrected blocks | Evidence |
| --- | ---: | --- |
| 8 CFR 212.4 and 1212.4 | 8 each | Compound (a)/(1) heading, Roman children and following (2) |
| 8 CFR 214.1 | 25 | General requirements (a)(3)/(i), Readmission (b)/(1), neighboring admission categories |
| 8 CFR 274a.2 | 78 | Italic fifth/sixth-level markers, document-category headings, internal references and later plain headings |
| 8 CFR 287.5 | 5 | Embedded (i), A–D conditions and following (ii) |
| 8 CFR 292.3 | 9 | Two disclosure provisions introducing lettered lists |
| 19 CFR 4.98 | 1 | Printed (e-1) between (e) and (f) |
| 20 CFR 416.994 | 16 | Lettered considerations and exceptions interrupted by example wrappers |
| 20 CFR 416.1337 | 6 | Roman payment categories and their continuation explanations |
| 20 CFR 655.73 | 4 | Printed a), following (1)–(3), and then (b); no text rewritten |
| 20 CFR 656.3 | 1 | Named SVP table context is not a formal paragraph address |

Some source designations really repeat. The two printed (vi) entries in the identity
document list of 8 CFR 274a.2 remain separate. The numbering in 20 CFR 655.15 and
repeated (e)/(1) in 655.19 also remain as printed; the source evidence does not
justify inventing replacement numbering. Appendix F to 22 CFR Part 62 retains its
restarted question outlines. Country schedules, quoted definitions and form lists
are not promoted into fictitious global paragraph addresses.

[Reviewed expectations](reviewed-expectations.json) contain the source-based decisions
and original block evidence. [Corrections](corrections.json) record original/corrected
addresses and offsets, applied rules, block and record SHA-256 fingerprints, and
captured XML/renderer provenance. [Source findings](source-findings.json) contain
all classified marker findings and repeated occurrences. These files and the replay
fixtures are **repository-only**: neither edition embeds or downloads them.

## Shared implementation and update behavior

`src/INASearch-CFR-Hierarchy.js` reconciles normalized XML/renderer evidence for both
`tools/generate-cfr-corpus.py` and the browser updater. Its 17 compiled rules occupy
6,143 bytes; the detailed evidence stays in this directory. The compiler reads
already reviewed guards and never recalculates them from a new download.

Guards bind the affected source span's text, formatting and markers. Non-addressable
publisher contexts are not trusted to supply a missing visible marker's ancestry.
This also accommodates browser recovery of malformed example wrappers, which can
differ from Python HTML parsing. Repairs retain original block text and offsets;
compound headings gain additional marker offsets instead of rewritten prose.

Validation rejects malformed addresses/contexts, missing or discontinuous parents,
isolated-italic depth conflicts, unclassified visible markers and unreviewed repeated
designations. Changed defective text that does not match a guard remains rejected.
Unfamiliar defects, including edits within guarded defective spans, can therefore
require a reviewed repair in a subsequent application release.

Downloads finish normalization, reconciliation and reference regeneration before
atomic activation. Rejection preserves the previous verified corpus and currency
and reports the structural failure. Structure revision 1 gates startup, updater
cache selection and background search projections. Search cache identities also
include the revision and corpus digest.

The cached hierarchy index keeps each occurrence, all stored shared-range endpoints,
and continuation/table content. Navigation, enclosing selection, copying and inserted
excerpts use its boundaries. Click selection preserves the reading position; copying
a repeated designation uses the clicked occurrence. Local citation resolution uses
indexed paths with official case and the existing statutory ambiguity ranking/menu.
Section-family matching recognizes the longest applicable indexed identifier and
preserves numeric section boundaries.

Saved highlights rebind only when their quote/context identifies an occurrence
uniquely. Missing or ambiguous evidence stays available for review. Older plain
notes in corrected sections lack a source quote: their original associations are
preserved and flagged for review rather than reassigned by address alone.

## Verification

- 30,088 canonical section paths and 59,904 supported compact spelling checks pass. The 136 excluded boundary cases intentionally require separators/parentheses because compact input denotes a different section.
- 30,363 occurrence scopes agree with an independent forward boundary scan; every parent's descendants and following sibling boundary are checked.
- All 54 letter-suffixed sections, all 50 stored markers in the 25 shared reserved-range blocks, and seven-level paths pass. All stored shared endpoints appear in paragraph menus.
- Browser progressive typing selects 697 blocks for `214.2h`, 42 for `214.2h2`, 37 for `214.2h2i`, and one leaf for `214.2h2ia`, with one blue enclosing outline and sibling exclusion.
- Browser checks cover default `214.2h2ii`, switching only its suffix to `214.2h2iI`, lettered sections and explicit parentheses, seven levels, tables, repaired ancestry, repeated-occurrence copying, click selection, and Settings.
- Captured sections from 12 parts (16 sections) replay identically through generation and the browser's native XML parser. Deliberately altered defective source is rejected; failed activation preserves the active corpus and dates; matching sources update successfully. Obsolete corpus and search-index caches are rejected.
- Standalone/native loader/hash/storage/profile checks, viewer, insertion, annotation, workspace, occurrence search, search worker and INA display suites pass. One timing-only occurrence-search failure under concurrent test load passed when rerun alone; no threshold was relaxed.

Machine-readable results: [lookup/scope checks](verification.json), [browser checks](browser-verification.json),
[download replay](download-verification.json), [XML/renderer audit](../cfr-structure-audit.json).

## Measured delivery size

Baseline commit: `10b67e93a143f36878a60e50bdfe016e11f292f8`. Sizes are bytes, not rounded file-manager units.

| Edition | Before | After | Net increase |
| --- | ---: | ---: | ---: |
| `INASearch.html` | 8,346,800 | 8,374,203 | +27,403 (0.328%) |
| `INASearch-Uncompressed.html` | 35,505,889 | 35,535,141 | +29,252 (0.082%) |

Net additional runtime code: **26,034 bytes**, including deferred worker source,
below the 50,000-byte planning target. CSS adds 259 bytes. The compressed corpus
adds **725 bytes** (5,232,793 → 5,233,518); plain corpus JSON adds **2,813 bytes**.
HTML growth also includes base64 expansion and shell metadata. The audit JSON,
source evidence and fixtures contribute zero bytes to the shipped editions.
[Detailed sizes and artifact hashes](sizes.json).

## Navigation performance follow-up

Progressively typing `214.2h2ia` exposed a reader performance gap: every character
rebuilt all of §214.2, including reference links and annotation hosts. The enclosing
selection also narrowed the text and forced it to wrap again. Smooth scrolling could
still be travelling toward an earlier input when the next character arrived.

The reader now keeps source fragments in the DOM when changing the selected scope
within the same section. Only compound heading boundaries that actually change are
rendered again. Notes, inserted excerpts and repeated source occurrences retain their
hosts. A changed corpus or profile revision requires a fresh render. The blue outline
no longer changes the text width. Valid CFR input reuses the existing classification,
bypasses the text-search debounce, and scrolls immediately to the latest provision.

[Performance results](navigation-performance.json) compare the repaired release at
`18a91f9` with this follow-up in isolated Chromium at 1× and 4× CPU slowdown. The
measurement runs from the input event through two animation frames after the matching
selection, including debounce and layout. It excludes completion of the baseline's
optional scroll animation; a separate rapid-typing assertion verifies that the new
selection is on screen immediately. Initial section loading still renders the section
once and is reported separately.

| CPU slowdown | Suffix typing before | Suffix typing after | Initial section load before → after |
| --- | ---: | ---: | ---: |
| 1× | 222–231 ms | 28–54 ms | 231 → 167 ms |
| 4× | 674–763 ms | 113–219 ms | 748 → 699 ms |

The browser regression also checks preservation of every source paragraph DOM node
and the entire section text, compound heading split/merge, inserted excerpts, saved
notes, repeated selection, backspacing, and the final visible target after a burst
of actual keystrokes. Both rebuilt editions retain the repository-only audit policy.
This follow-up adds 4,277 runtime bytes (4,357 HTML bytes) relative to `18a91f9`;
the combined hierarchy repair remains below the 50 KB runtime target.

Reproduce the comparison after building:

```sh
git show 18a91f9:INASearch.html > tmp/cfr-navigation-before.html
node tools/test-cfr-navigation.mjs --baseline tmp/cfr-navigation-before.html
```

## Reproduction and delivery

With the pinned `tmp/cfr-cache` capture available:

```sh
node tools/compile-cfr-repairs.js
python3 tools/generate-cfr-corpus.py --from-cache tmp/cfr-cache
python3 tools/audit-cfr-hierarchy.py
python3 tools/audit-cfr-structure.py --cache tmp/cfr-cache --corpus src/INASearch-CFR.js --baseline tmp/INASearch-CFR-pre-structure-fix.js --report sources/legal/cfr-structure-audit.json
node tools/build-standalone.js
node tools/test-cfr-hierarchy.js
node tools/test-cfr-downloads.mjs
node tools/test-cfr-reader.mjs
node tools/test-standalone.js
node tools/measure-cfr-repair.js 10b67e93a143f36878a60e50bdfe016e11f292f8
```

Browser tests use the existing Playwright installation; set
`INASEARCH_BROWSER_RUNTIME` if it lives outside the documented local runtime.
`tools/capture-cfr-hierarchy-fixtures.py` re-extracts replay fixtures from verified
capture files. Updating guards requires a new source review; compiling or rebuilding
alone cannot approve a changed source exception.

Both rebuilt editions are available locally. The preview at
`http://Daves-MacBook-Air.local:8765/` serves the rebuilt normal edition and reloads
when it changes. Publication awaits Dave's independent Linux inspection and explicit
push authorization.
