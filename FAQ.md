# INASearch FAQ

This FAQ explains how INASearch works behind the scenes. For a short introduction and usage guide, see [README.md](README.md).

## General

### Does INASearch require installation or an account?

No. Each edition is a standalone HTML file. Open it in a current version of Microsoft Edge or Chrome. There is no account, local server, browser extension, or background service.

### Does it work offline?

Yes. The HTML file contains the legal corpus needed for searching and reading. Automatic CFR updates are off by default, so a new copy makes no network requests during ordinary use.

Official-source buttons still require an internet connection because they open the [House U.S. Code](https://uscode.house.gov/), [eCFR](https://www.ecfr.gov/), [USCIS](https://www.uscis.gov/), or [GovInfo](https://www.govinfo.gov/) website.

### Why Edge or Chrome?

The search and reader use ordinary browser features. The limiting feature is durable autosaving: INASearch uses `showSaveFilePicker()` and a writable file handle so it can save changes directly to the `INASearch_Data.json` file you selected. [That API is not available in every major browser](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker).

- Firefox does not provide the required local-file picker and writable-handle workflow.
- Safari supports an origin-private file system, but [that storage belongs to the website](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/); it does not provide the picker INASearch needs to keep writing to a user-selected JSON file. Chrome and Edge on iOS use the same WebKit engine and have the same limitation.
- Other desktop Chromium browsers, such as Brave, Opera, and Vivaldi, may expose the required API, but they are not in the project's test matrix and their privacy or security settings may block it.

Firefox and Safari may still run the reader, and INASearch can still download a JSON backup there, but they cannot provide the connected-file autosave workflow. Current desktop Edge and Chrome are therefore the fully supported browsers.

## Notes, settings, and privacy

### How are my notes saved?

Open **Saving & data** and select or create `INASearch_Data.json`. INASearch can then save notes, preferences, and tutorial progress to that file.

The browser grants access only to the file you selected. INASearch does not receive permission to browse the surrounding folder. It checks the file before writing and reads it back afterward to confirm that the save succeeded.

### What happens if I open INASearch in two windows?

You usually do not need a second window to view multiple provisions. Enter two or more citations in the search box, separated by commas:

```text
INA 212(a)(6)(C)(i), INA 212(i), 8 CFR 212.7
```

INASearch opens each citation in its own reader pane. The panes remain visible together and scroll independently. Remove the commas to return to the ordinary single-provision reader.

### What if I want to anyways?

You can open multiple windows, but INASearch does not create a separate save file for each one. Saving is built around one user-selected file, normally `INASearch_Data.json`. Each window has its own working copy in memory, and multiple windows can be connected to the same file.

The windows do not live-sync. Suppose window A and window B both opened revision 10. If A saves, the file becomes revision 11. B keeps showing the copy it already loaded. When B next tries to save, it sees revision 11, refuses to overwrite it, turns autosaving off in B, and shows the error in B only. A does not require any action.

To continue in B, use **Reconnect data file** there and select the same file. If B has unsaved work, B asks whether to merge those notes and settings into the newer file. You do not need to repeat that action in A.

You can deliberately connect different files in different windows, but those files are independent and do not sync. The most recently connected file is the one that browser profile will try to remember for the next session.

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

The statutory text and structure come from the [official Title 8 USLM release](https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip) published by the [House Office of the Law Revision Counsel](https://uscode.house.gov/). INASearch retains the complete captured Title 8 release, including current provisions and House material identified as repealed, transferred, omitted, or set out as a note.

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
2. downloads XML only for covered parts reported as changed;
3. normalizes the new text and stores the source artifact with its hash;
4. regenerates definitions and inline citations affected by the change;
5. stages and verifies the new corpus; and
6. activates it for use after a reload while retaining the previous corpus for rollback.

Searches and viewed provisions do not affect which network requests are made. Multiple tabs coordinate so they do not run the same update at once.

### Do CFR updates expand the corpus automatically?

No. Runtime updates maintain the fixed coverage already reviewed for the release. They do not discover or add newly relevant CFR parts. Expanding coverage is a release-maintenance decision because the PTAR selection and its limitations need review.

### What does not update automatically?

The standalone browser cannot fetch the [House Title 8 release](https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip) or [USCIS INA source page](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act) directly because those sites do not provide the required browser cross-origin access. Automatic maintenance therefore does not update:

- [Title 8 U.S.C.](https://uscode.house.gov/browse/prelim@title8&edition=prelim);
- the [INA crosswalk](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act);
- [USCIS Policy Manual](https://www.uscis.gov/policy-manual) or [form metadata](https://www.uscis.gov/forms/all-forms);
- the [USCIS Glossary](https://www.uscis.gov/tools/glossary); or
- other non-CFR source material.

Their capture dates remain visible on the **About** page.

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

A bare “the Act” is treated as the INA only in a reviewed CFR scope whose definitions support that meaning. `src/INASearch-Legal-Reference-Policy.js` records each scope, its controlling CFR citation, an exact source excerpt, and the official URL. For example, the Title 8 policy is grounded in [8 CFR 1.2](https://www.ecfr.gov/current/title-8/part-1/section-1.2).

The build verifies that every excerpt still appears in the captured CFR source. Named historical laws such as “the Act of February 5, 1917” are not treated as bare references to the INA. An explicit phrase such as “the Immigration and Nationality Act” can be recognized outside those bare-Act scopes.

### Are build-time and runtime citations handled differently?

No. The builder and browser use the same parser. When the optional updater changes a CFR part, every reference-bearing field in that part is reparsed after the new text is inserted and before the staged corpus can be activated.

Golden fixtures run the same examples through both Node and a browser-like environment. Tests also cover false positives, crosswalk aliases, relative paths, packing and hydration, policy tampering, and changed-CFR regeneration.

## Source evidence and integrity

### What is pinned for an audited release?

`sources/legal/source-manifest.json` records the requested and final URLs, publisher identifiers, byte counts, and SHA-256 hashes for:

- the [House Title 8 ZIP](https://uscode.house.gov/download/releasepoints/us/pl/119/102/xml_usc08@119-102.zip) and extracted USLM XML;
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

## Builds and project structure

### What is the difference between the two HTML editions?

Both contain the same expanded corpus at runtime. `INASearch.html` compresses and packs repeated corpus data to reduce its file size. `INASearch-Uncompressed.html` embeds plain JSON so the complete release corpus is easier to inspect. Neither edition depends on an external script or corpus server.

### How do I build and test the project?

```bash
node tools/build-standalone.js
node tools/test-standalone.js
```

The test suite checks source hashes, the INA crosswalk, CFR coverage, legal-reference spans and targets, policy excerpts, browser loading, profile migration, deterministic output, search performance, and size limits.

### Where are the main project files?

- Root `INASearch*.html` files are the distributable editions.
- `src/` contains the interface, default profile, policies, and generated corpus files.
- `sources/legal/` contains pinned source evidence and audit policies.
- `tools/` contains generators, parsers, fixtures, and tests.

## Limitations

### Is INASearch a complete statement of current immigration law?

No. It is a reference tool built from dated source snapshots. It does not include case law, and its cross-title regulatory corpus follows a defined but not all-inclusive selection rule. Optional eCFR maintenance improves the currency of covered regulations only.

Use the included official-source links when current law, source currency, or an authoritative citation matters. INASearch is not legal advice.
