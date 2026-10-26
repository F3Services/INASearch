# INASearch FAQ

This FAQ explains how INASearch works behind the scenes. For a short introduction and usage guide, see [README.md](README.md).

## General

### Does it work offline?

Yes, when you use a local copy. Download `INASearch.html` while you have an internet connection, then open that file in your browser. The file contains the legal text needed for searching and reading, and you can use your notes and highlights without an internet connection. To rely on INASearch offline, use the downloaded file rather than the hosted website.

Automatic CFR updates and official-source buttons require an internet connection. Updates are off by default. Official-source buttons open the [House U.S. Code](https://uscode.house.gov/), [eCFR](https://www.ecfr.gov/), [USCIS](https://www.uscis.gov/), or [GovInfo](https://www.govinfo.gov/) website.

## Notes, settings, and privacy

### How are my notes saved?

INASearch automatically saves notes, highlights, preferences, and daily-tip progress in browser-owned IndexedDB storage. “Saved in browser” means the current browser profile contains the latest verified copy; it does not mean the data is a durable filesystem document.

Create a note from an exact INA, U.S.C., or CFR citation's actions menu, or from selected text. Notes use neutral full-width banners above their associated citations. They stay visible while you read the associated text and can be shared with several exact citations. Click a note to edit it in place. The optional handwritten-font setting uses an installed system font when available and otherwise keeps the normal rule-text font.

Browser storage can disappear if you clear site data, use a private window, change browser profiles, run short of storage, or open the standalone HTML from a location the browser treats as a different storage context. INASearch requests persistent storage when supported, but the browser may decline and users can always clear browser data.

For stronger protection, open **Saving & data** and select or create `INASearch_Data.json`. INASearch then saves to that file and mirrors the verified file copy into browser storage. You can also download a portable JSON backup. Weekly reminders are on by default when no data file is connected and can be disabled in Settings.

The browser grants access only to the file you selected. INASearch does not receive permission to browse the surrounding folder. It checks the file before writing and reads it back afterward to confirm that the save succeeded.

### What does Reset everything remove?

**Reset everything** removes notes, highlights, inserted references, daily-tip progress, and settings, plus downloaded corpus updates, recovery copies, saved source artifacts, search caches, and update history. After saving the reset, INASearch reloads the corpus built into the HTML file. Automatic updates return to their default off setting. New search caches may be built as you use the restored corpus.

A connected data file stays connected and receives the reset. **Reset settings** changes preferences while keeping saved content and downloaded corpus updates.

### How does the live navigation bar work?

The main reader’s navigation dropdowns follow the citation at **Page view offset**, which defaults to 3% below the top of the readable area. The same setting controls where citation jumps land. Use the arrow to the left of the INASearch logo to expand or collapse the dropdown row. Your choice is saved. The search field keeps the entered or explicitly selected citation in either mode.

Scrolling changes neither navigation history nor the blue selection highlight. Selecting a citation, opening its menu, copying its citation or text, sharing it, adding a note, printing it, or opening its official source logs that citation. The action column stays fixed in the left gutter. Its actions use the blue-highlighted citation. Hovering or focusing a button keeps your reading position when that citation’s start is visible. When its start is out of view, the preview temporarily brings it to Page view offset and restores your position when you leave the buttons. Click a citation in the text to select a broader unit when needed.

The sidebar offers T for text only and a combined § : / T icon for citation + text. Citation-only copy controls are beside the search field. Hover or focus a sidebar control to preview the target citation. The INA/U.S.C. switch in the same column controls the copied statute format and the navigation hierarchy. **Copied text format** in Settings controls the combined copy button and defaults to `[citation] - [text]`. Those tokens insert the citation and complete legal text; `[space]` inserts one space and `[tab]` inserts one tab. Tokens work regardless of capitalization. You can put them in any order and include your own punctuation and line breaks; no separator is added automatically. Settings warns you if `[citation]` or `[text]` is missing.

Spaces or tabs before `[citation]` at the start of a template line also become the base indentation for every line of `[text]`. Existing nested indentation is preserved. For example, `[tab][citation]:` followed by a newline and `[text]` indents both the citation and its text by one tab. Indented or multiline copies include a rich-text version with paragraph indentation, using four-space tab stops, and an exact plain-text version with real spaces and tabs. Use **Paste and Retain Style** in Apple Notes or **Keep Source Formatting** in Word to retain paragraph indentation on wrapped lines. The destination app controls how much formatting it preserves; plain-text paste preserves indentation on explicit lines but does not indent automatically wrapped continuations.

The search field’s copy controls target its displayed citation. Share stays beside the search field and uses the live navigation citation in the main reader. Hover or keyboard-focus Share to light the window edges and temporarily show the shared destination, including both panes in a split view. Moving away or pressing Escape restores your reading position; previewing does not add history. Clicking copies the previewed link. A recipient’s saved display preferences can affect the layout.

Downloaded files and localhost copies use `https://inasearch.pages.dev/` for share links by default, including citation-specific links. Copies hosted at another public address keep that address. Turn off **Settings → Sharing → Use inasearch.pages.dev for local share links** to copy the local address instead. The local-link warning appears only when the copied link still points to a local copy.

If you jump to `INA 237(a)(3)` and scroll to `(a)(2)(D)`, Back first returns to `(a)(3)`. Pressing Back again visits the previous logged destination. History jumps align the citation at Page view offset. Side-by-side panes retain their own navigation history and copy targets.

### Will the browser remember the data file?

There are two separate things to remember: which file you selected, and whether INASearch still has permission to write to it. INASearch stores the file handle in the browser's IndexedDB storage. Edge or Chrome may separately remember the permission if you choose **Allow on every visit**. [File handles can be stored even when their permissions do not persist](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access/#stored-file-or-directory-handles-and-permissions).

The file will not reconnect automatically when:

- you granted access for the current visit only or later revoked the permission—in that case the handle may still be remembered, but the browser asks you to reconnect;
- you use a private or Incognito window, a different browser, or a different browser profile;
- browser or organizational policy blocks file access or persistent site storage;
- you clear the browser's site data, which removes INASearch's remembered handle;
- the browser treats another copy or location of the HTML file as a different storage context; or
- the JSON file was moved, renamed, deleted, or replaced and the saved handle no longer works.

None of those events deletes the JSON file. If the file still exists, choose **Reconnect data file** and select it again.

### Does INASearch collect telemetry?

No. It has no analytics, user account, or project-operated server. With automatic CFR updates off, it makes no network requests. When updates are enabled, its content-security policy permits connections only to `www.ecfr.gov`.

## Statutes and the INA

### What is the source for the statutes?

The statutory text and structure come from the [official Title 8 USLM release](https://uscode.house.gov/download/releasepoints/us/pl/119/124/xml_usc08@119-124.zip) published by the [House Office of the Law Revision Counsel](https://uscode.house.gov/). INASearch retains the complete captured Title 8 release, including current provisions and House material identified as repealed, transferred, omitted, or set out as a note.

The source ZIP and extracted XML are stored under `sources/legal/raw/`. Their URLs, byte counts, release point, and SHA-256 hashes are recorded in `sources/legal/source-manifest.json`.

### Is every section of Title 8 part of the INA?

No. Title 8 contains the INA, but it also contains other laws. INASearch therefore keeps two related structures:

- the complete captured Title 8 U.S.C. corpus; and
- an INA view based on the [section inventory published by USCIS](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act).

The INA view does not decide membership by guessing from a U.S.C. number or chapter. A provision appears in that view because it is represented in the reviewed INA crosswalk.

### What is the source for the INA crosswalk?

USCIS is the primary source. Its [Immigration and Nationality Act page](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act) supplies the 183 INA rows, their U.S.C. labels, titles, and special entries such as notes or sections with no U.S.C. equivalent.

The project independently checks those rows against the [GovInfo `COMPS-1376` INA compilation](https://www.govinfo.gov/app/details/COMPS-1376). [House U.S. Code records](https://uscode.house.gov/browse/prelim@title8&edition=prelim) provide additional evidence for former sections and repealed entries that do not have an ordinary current GovInfo body mapping.

The result of that review is recorded in `sources/legal/ina-crosswalk-audit.json`. Each embedded row also records the captured USCIS artifact and hash that produced it.

### Why do some crosswalk targets, such as INA 329A, look different from the printed U.S.C. citation?

On the [USCIS crosswalk](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act), INA 329A is printed as `8 U.S.C. 1440-1`. The [House record for that section](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8-section1440-1&num=0&edition=prelim) uses an en dash in the section number: `1440–1`. The audit normalizes that punctuation difference, confirms the section against GovInfo, and records `1440–1` as the local target because that is the identifier present in the captured House corpus.

This is one example of a broader distinction. Each crosswalk row keeps both:

- the U.S.C. section printed by USCIS; and
- `localSection`, the actual House corpus record used for offline navigation.

Other discrepancies are structural rather than typographical. For example, INA 352 through 355 have their own printed U.S.C. citations, but the House represents those repealed provisions in one combined `1484 to 1487` record. In every case, INASearch preserves the familiar printed citation while using the House record that actually exists for offline navigation.

## Regulations

### Which CFR material is included?

The corpus includes:

1. all current [Title 8 CFR](https://www.ecfr.gov/current/title-8); and
2. reviewed parts from other CFR titles whose GovInfo Parallel Table authority entry points to a Title 8 U.S.C. record retained in the statutory corpus.

The Parallel Table of Authorities and Rules (PTAR) is a GovInfo index that shows which statutory authorities agencies cite for CFR provisions. INASearch uses the [2025 PTAR](https://www.govinfo.gov/content/pkg/GPO-CFR-INDEX-2025/html/GPO-CFR-INDEX-2025-4.htm) for the reviewed cross-title selection. The exact rule, reviewed PTAR year, expected part list, removed parts, and limitations are in `sources/legal/cfr-scope-policy.json`. The generator stops if the PTAR year or expected inventory changes before the policy is reviewed.

### Does that include every regulation relevant to immigration practice?

Not necessarily. [GovInfo's PTAR](https://www.govinfo.gov/content/pkg/GPO-CFR-INDEX-2025/html/GPO-CFR-INDEX-2025-4.htm) warns that the table is based on agency-supplied authority citations and is not all-inclusive. A regulation can matter to immigration practice without being selected by that rule.

The cross-title corpus should therefore be understood as a consistent, reviewable inclusion policy—not a claim that no other CFR material could be relevant. Adding another part requires an explicit policy revision.

### How do automatic CFR updates work?

They are off by default. If a user turns them on, INASearch checks the covered material against [eCFR](https://www.ecfr.gov/):

1. asks eCFR whether any of the already covered titles or parts may have changed;
2. downloads dated official XML for covered parts reported as changed;
3. preserves the XML text, tables, notes, and formatting; derives paragraph structure from visible markers, formatting, and verified prior-text anchors; and validates parent relationships and complete source consumption;
4. regenerates definitions and inline citations affected by the change;
5. stages and verifies the new corpus; and
6. activates it for use after a reload while retaining the previous corpus for rollback.

Searches and viewed provisions do not affect which network requests are made. Multiple tabs coordinate so they do not run the same update at once.

The XML source and its hash are retained locally. Browser updates do not require the enhanced-renderer endpoint, which does not provide browser cross-origin access. Reviewed build repairs also run in the browser through the shared hierarchy module. Genuine repeated source designations retain distinct occurrences, with structural diagnostics saved alongside source metadata.

If the source cannot be fully parsed or its hierarchy remains ambiguous, the update is rejected and the previous corpus and currency dates remain active. A red error status always appears, including when **Show Detailed Status** is off. Select it to inspect the error, see the failing source URL when available, and retry. **Settings → Updates** also provides check and reload controls. The search index is rebuilt for a changed corpus and can then be reused from browser storage.

### Do CFR updates expand the corpus automatically?

No. Runtime updates maintain the fixed coverage already reviewed for the release. They do not discover or add newly relevant CFR parts. Expanding coverage is a release-maintenance decision because the PTAR selection and its limitations need review.

### What does not update automatically?

The standalone browser cannot fetch the [House Title 8 release](https://uscode.house.gov/download/releasepoints/us/pl/119/124/xml_usc08@119-124.zip) or [USCIS INA source page](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act) directly because those sites do not provide the required browser cross-origin access. Automatic maintenance therefore does not update:

- [Title 8 U.S.C.](https://uscode.house.gov/browse/prelim@title8&edition=prelim);
- the [INA crosswalk](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act);
- [USCIS Policy Manual](https://www.uscis.gov/policy-manual) or [form metadata](https://www.uscis.gov/forms/all-forms);
- the [USCIS Glossary](https://www.uscis.gov/tools/glossary); or
- other non-CFR source material.

The **About** page gives the U.S. Code source date and lists the included law. Dates for the covered CFR parts appear in the reader. Automatic CFR updates do not change the statutory text; use a newer copy of INASearch to get updated statutes.

## Inline links and citations

### How do we know the link in `8 U.S.C. 1101(a)(15)(H)` to `1184(i)(1)` is interpreted correctly?

In [8 U.S.C. 1101(a)(15)(H)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8-section1101&num=0&edition=prelim), the reader displays “section 1184(i)(1) of this title.” The captured House XML wraps those exact words in this publisher-authored element:

```xml
<ref href="/us/usc/t8/s1184/i/1">section 1184(i)(1) of this title</ref>
```

That gives INASearch several independent checks:

1. `/us/usc/t8` identifies the U.S. Code, Title 8.
2. `/s1184/i/1` identifies section 1184, subsection (i), paragraph (1).
3. The target [8 U.S.C. 1184(i)(1)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8-section1184&num=0&edition=prelim) and that exact structural path both exist in the captured corpus.
4. The stored start and end offsets must reproduce the visible words exactly.
5. INASearch marks the link as local only because section 1184 and path (i)(1) exist. A House link whose target is outside the corpus is retained as an official-source link instead of being forced to a guessed local destination.

Generation fails if a reference cannot be attached to its source field, its offsets do not reproduce the House text, or any displayed House reference is skipped.

Other House references use the same grammar. The generator translates publisher targets for U.S.C. provisions, public laws, Statutes at Large, and Act records, then applies the same existence and exact-text checks.

House range identifiers use `...` where the normalized corpus uses ` to `. That single identifier difference is normalized before matching. This recovered 1,281 source-authored links that were previously skipped; the audited release accepts all 16,080 displayed House references with zero skips.

### How does “Convert citations to INA format” work?

**Follow View Setting** is the default for new and reset settings. **Always** converts supported links to INA format. **Follow View Setting** converts them when the INA/U.S.C. swap button is set to INA. **Never** preserves the source wording. Existing saved on/off choices become Always/Never. Swapping in Follow View Setting keeps the citation at Page view offset in place and updates the links without rebuilding the reader.

The setting uses the INA crosswalk and keeps abbreviated references short. For example, `section 1227(a)(2)(A)(ii), (A)(iii), (B), (C), or (D) of this title` reads `INA 237(a)(2)(A)(ii), (A)(iii), (B), (C), or (D)`.

The original order, connecting words, and punctuation remain intact. A trailing section stays at the end: `paragraph (6)(A), (6)(C), or (7) of section 1182(a) of this title` reads `paragraph (6)(A), (6)(C), or (7) of INA 212(a)`. Repeated complete citations in a list can share their common section and subsection. The same approach applies to supported INA citations within CFR text.

Each abbreviated link retains its complete target and original source wording in the reference preview. **Highlight converted INA citations in yellow** applies only to converted links; citations already written in INA format remain blue.

The defined-term **Warning** explains a text-matching limitation: “national” in “national or international acclaim” is an adjective, while the legal definition describes a person. A highlight alone does not establish that the definition fits the sentence.

### How are citations without a House link recognized?

INASearch uses a deterministic parser for citations written as ordinary text. Recognized patterns include:

- `8 U.S.C. 1154(a)(1)(A)` and variants such as `8 USC § 1154(a)(1)(A)`;
- `8 CFR 214.2(h)(13)(iii)(A)` and `8 C.F.R. § 214.2(h)`;
- `INA 204(b)` and `INA § 204(b)`;
- `Pub. L. 104-208` and `Public Law 104–208`;
- `110 Stat. 3009`; and
- `87 Fed. Reg. 70715` and `87 FR 70715`.

In CFR text it also recognizes constructions such as `section 101(a)(15)(H) of the Immigration and Nationality Act`, plus reviewed uses of `section ... of the Act` where the surrounding CFR scope defines “the Act” as the INA. Relative wording such as `paragraphs (1) and (2) of this subsection` is handled by the structural rules described below.

All of these are converted into the same reference structure used by House links.

The parser stores the exact source span, citation family, normalized target, structural path, resolution status, official URL, rule identifier, and provenance. A target becomes local only if the corresponding section and requested path exist in the indexed corpus.

### How are relative references handled?

Phrases such as “paragraphs (1) and (2) of this subsection” are resolved from the current structural path. Each written item receives its own target. A phrase such as “such paragraph,” where the antecedent is not certain, is marked unresolved rather than assigned a guessed destination.

Links back to the current provision or one of its ancestors are suppressed because they do not provide useful navigation.

### How is “the Act” interpreted in CFR text?

A bare “the Act” is intentionally left as ordinary text; it is too repetitive to be a useful link. A citation such as “section 101(a)(15)(H) of the Act” is interpreted as an INA citation only in a reviewed CFR scope whose definitions support that meaning. `src/INASearch-Legal-Reference-Policy.js` records each scope, its controlling CFR citation, an exact source excerpt, and the official URL. For example, the Title 8 policy is grounded in [8 CFR 1.2](https://www.ecfr.gov/current/title-8/part-1/section-1.2).

The build verifies that every excerpt still appears in the captured CFR source. Named historical laws such as “the Act of February 5, 1917” are not treated as references to the INA. An explicit phrase such as “the Immigration and Nationality Act” can be recognized outside those scoped uses. Candidate inline references that cannot be resolved are retained only as plain text, not underlined or linked.

### Are build-time and runtime citations handled differently?

No. The builder and browser use the same parser. When the optional updater changes a CFR part, every reference-bearing field in that part is reparsed after the new text is inserted and before the staged corpus can be activated.

Golden fixtures run the same examples through both Node and a browser-like environment. Tests also cover false positives, crosswalk aliases, relative paths, packing and hydration, policy tampering, and changed-CFR regeneration.

## Source evidence and integrity

### What is pinned for an audited release?

`sources/legal/source-manifest.json` records the requested and final URLs, publisher identifiers, byte counts, and SHA-256 hashes for:

- the [House Title 8 ZIP](https://uscode.house.gov/download/releasepoints/us/pl/119/124/xml_usc08@119-124.zip) and extracted USLM XML;
- the [USCIS INA page](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act); and
- the [GovInfo INA compilation](https://www.govinfo.gov/app/details/COMPS-1376).

The raw bytes are committed under `sources/legal/raw/`. A later change at a live URL cannot silently alter the evidence for an existing release.

### What do the hashes prove?

They detect corruption and make byte changes visible during review. They do not provide a digital signature from the publisher. Users still need to obtain INASearch from a trusted source and use the official-site links when authoritative currency matters.

### How do I verify the legal sources?

```bash
python3 tools/capture-legal-sources.py verify
python3 tools/generate-ina-crosswalk.py
```

The first command verifies all committed source bytes and confirms that the extracted House XML matches the ZIP member. The second rebuilds the expected crosswalk and audit in memory and fails if the committed versions have drifted.

### How is a new reviewed source set captured?

```bash
python3 tools/capture-legal-sources.py capture --capture-date YYYY-MM-DD --refresh
```

Refreshing is deliberately explicit. After capture, the crosswalk, hierarchy, statute references, footnotes, CFR corpus, and distributable files must be regenerated and reviewed as one release change.

For CFR structure, the capture includes both the eCFR XML text and the same-date enhanced renderer for every included part. XML supplies the regulatory text and formatting; renderer IDs provide additional structural evidence. Some publisher IDs are incorrect. Reviewed repairs use visible markers, compound headings, formatting and neighboring structure while preserving the text and genuine repeated designations. `tools/audit-cfr-structure.py` checks inventories, complete XML text preservation and reviewed marker expectations. `tools/audit-cfr-hierarchy.py` separately classifies visible numbering findings; the shared runtime index preserves individual occurrences for navigation, highlighting, copying and excerpts.

## Builds and project structure

### What is the difference between the two HTML editions?

Both contain the same expanded corpus at runtime. `INASearch.html` packs repeated data and compresses the corpus with Brotli. Its decoder is embedded in the file. After first use, subsequent opens use verified uncompressed corpus chunks and the saved search index from browser storage; a missing or obsolete cache is rebuilt. Detailed citation-resolution audit records remain build-time evidence and are omitted from both distributed editions. `INASearch-Uncompressed.html` embeds plain JSON so the complete release corpus is easier to inspect. Neither edition depends on an external script or corpus server.

### How do I build and test the project?

Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those supported major versions. Build and test commands enforce these security baselines.

```bash
npm ci
node tools/build-standalone.js
node tools/test-standalone.js
node tools/test-ina-display.js
```

The build uses pinned development dependencies to minify JavaScript, including the embedded worker. The minifier is not shipped with the app; the Brotli WebAssembly decoder is embedded for offline use. The decoder has a fixed output limit, rejects malformed/trailing data, and runs in a temporary background worker when available. The checked-in decoder avoids requiring Rust for ordinary builds; see [decoder maintenance](tools/brotli-decoder/README.md) for reproducible rebuilding and Rust dependency checks. Third-party licensing is included in the HTML source and `THIRD-PARTY-NOTICES.txt`. Readable builds in `tmp/debug/` support source-level tests; loading and browser tests exercise the minified releases. Both editions still work as single offline files.

The test suite checks source hashes, the INA crosswalk, CFR coverage, legal-reference spans and targets, policy excerpts, browser loading, current JSON profile round trips, deterministic output, search performance, and size limits.

Saved-data import accepts current JSON profiles and `INASearch_Data.json` vaults with profile schema 5. The old HTML and profile JavaScript import formats and course-note migrations have been removed. The progress-tracked Quick Start tutorial has also been removed; all daily tips remain available in About without completing a tutorial.

### Where are the main project files?

- Root `INASearch*.html` files are the distributable editions.
- `src/` contains the interface, default profile, policies, and generated corpus files.
- `sources/legal/` contains pinned source evidence and audit policies.
- `tools/` contains generators, parsers, fixtures, and tests.

## Limitations

### Is INASearch a complete statement of current immigration law?

No. It is a reference tool built from dated source snapshots. It does not include case law, and its cross-title regulatory corpus follows a defined but not all-inclusive selection rule. Optional eCFR maintenance improves the currency of covered regulations only.

Use the included official-source links when current law, source currency, or an authoritative citation matters. INASearch is not legal advice.
