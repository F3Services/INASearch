# INASearch FAQ

This FAQ explains how INASearch works behind the scenes. For a short introduction and usage guide, see [README.md](README.md).

## General

### Does INASearch require installation or an account?

No. Each edition is a standalone HTML file. Open it in a current version of Microsoft Edge or Chrome. There is no account, local server, browser extension, or background service.

### Does it work offline?

Yes. The HTML file contains the legal corpus needed for searching and reading. Automatic CFR updates are off by default, so a new copy makes no network requests during ordinary use.

Official-source buttons still require an internet connection because they open the House, eCFR, USCIS, or GovInfo website.

### Why Edge or Chrome?

The search and reader are ordinary browser features, but direct autosaving to `INASearch_Data.json` uses the browser's file-access APIs. Current Chromium browsers provide the most consistent support for selecting one file and writing back to it safely.

## Notes, settings, and privacy

### How are my notes saved?

Open **Saving & data** and select or create `INASearch_Data.json`. INASearch can then save notes, preferences, and tutorial progress to that file.

The browser grants access only to the file you selected. INASearch does not receive permission to browse the surrounding folder. It checks the file before writing and reads it back afterward to confirm that the save succeeded.

### What happens if I open INASearch in two windows?

Each save carries a revision. If another window has already written a newer revision, INASearch will not silently overwrite it. You will be asked to reconnect or resolve the conflict.

### Will the browser remember the data file?

Usually. INASearch stores the file handle in browser storage when supported. The browser may still ask you to restore permission after all INASearch windows have been closed. Clearing browser data removes the remembered handle, but it does not delete the JSON file; you can select the same file again.

### Is the data file encrypted?

No. It is normal JSON. Anyone with access to the file can read it. Store it in an appropriate location and use your organization's normal protections for work information.

### Does INASearch collect telemetry?

No. It has no analytics, user account, or project-operated server. With automatic CFR updates off, it makes no network requests. When updates are enabled, its content-security policy permits connections only to `www.ecfr.gov`.

## Statutes and the INA

### What is the source for the statutes?

The statutory text and structure come from the official Title 8 USLM release published by the House Office of the Law Revision Counsel. INASearch retains the complete captured Title 8 release, including current provisions and House material identified as repealed, transferred, omitted, or set out as a note.

The source ZIP and extracted XML are stored under `sources/legal/raw/`. Their URLs, byte counts, release point, and SHA-256 hashes are recorded in `sources/legal/source-manifest.json`.

### Is every section of Title 8 part of the INA?

No. Title 8 contains the INA, but it also contains other laws. INASearch therefore keeps two related structures:

- the complete captured Title 8 U.S.C. corpus; and
- an INA view based on the section inventory published by USCIS.

The INA view does not decide membership by guessing from a U.S.C. number or chapter. A provision appears in that view because it is represented in the reviewed INA crosswalk.

### What is the source for the INA crosswalk?

USCIS is the primary source. Its Immigration and Nationality Act page supplies the 183 INA rows, their U.S.C. labels, titles, and special entries such as notes or sections with no U.S.C. equivalent.

The project independently checks those rows against the GovInfo `COMPS-1376` INA compilation. House records provide additional evidence for former sections and repealed entries that do not have an ordinary current GovInfo body mapping.

The result of that review is recorded in `sources/legal/ina-crosswalk-audit.json`. Each embedded row also records the captured USCIS artifact and hash that produced it.

### Why do some crosswalk targets look different from the printed U.S.C. citation?

The House sometimes represents several printed section numbers as one corpus record, or uses different dash characters in its identifiers. Each crosswalk row therefore has both:

- the U.S.C. section printed by USCIS; and
- `localSection`, the actual House corpus record used for offline navigation.

For example, INA 329A maps to the House record `1440–1`, and INA 352 through 355 point into the combined `1484 to 1487` record. The displayed citation remains the familiar one while navigation uses the record that actually exists.

## Regulations

### Which CFR material is included?

The corpus includes:

1. all current Title 8 CFR; and
2. reviewed parts from other CFR titles whose GovInfo Parallel Table authority entry points to a Title 8 U.S.C. record retained in the statutory corpus.

The exact rule, reviewed PTAR year, expected part list, removed parts, and limitations are in `sources/legal/cfr-scope-policy.json`. The generator stops if the PTAR year or expected inventory changes before the policy is reviewed.

### Does that include every regulation relevant to immigration practice?

Not necessarily. GovInfo warns that the Parallel Table is based on agency-supplied authority citations and is not all-inclusive. A regulation can matter to immigration practice without being selected by that rule.

The cross-title corpus should therefore be understood as a consistent, reviewable inclusion policy—not a claim that no other CFR material could be relevant. Adding another part requires an explicit policy revision.

### How do automatic CFR updates work?

They are off by default. If a user turns them on, INASearch:

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

The standalone browser cannot fetch the House Title 8 release or USCIS source pages directly because those sites do not provide the required browser cross-origin access. Automatic maintenance therefore does not update:

- Title 8 U.S.C.;
- the INA crosswalk;
- USCIS Policy Manual or form metadata;
- the USCIS Glossary; or
- other non-CFR source material.

Their capture dates remain visible on the **About** page.

## Inline links and citations

### How do we know House inline links are being interpreted correctly?

The House USLM XML contains structured `<ref>` elements with publisher-authored targets. INASearch treats those targets as the primary interpretation instead of trying to infer a destination from the visible words alone.

The generator translates the House target grammar into U.S.C., public-law, Statutes-at-Large, or Act records. It also verifies that every stored start and end offset reproduces the exact words shown in the reader. Generation fails if a House reference points to a missing source record, has a text mismatch, or would otherwise be skipped.

House range identifiers use `...` where the normalized corpus uses ` to `. That single identifier difference is normalized before matching. This recovered 1,281 source-authored links that were previously skipped; the audited release accepts all 16,080 displayed House references with zero skips.

### How are citations without a House link recognized?

INASearch uses a deterministic parser for citations written as ordinary text. It recognizes explicit INA, U.S.C., CFR, public-law, Statutes-at-Large, and Federal Register forms and converts them into the same reference structure used by House links.

The parser stores the exact source span, citation family, normalized target, structural path, resolution status, official URL, rule identifier, and provenance. A target becomes local only if the corresponding section and requested path exist in the indexed corpus.

### How are relative references handled?

Phrases such as “paragraphs (1) and (2) of this subsection” are resolved from the current structural path. Each written item receives its own target. A phrase such as “such paragraph,” where the antecedent is not certain, is marked unresolved rather than assigned a guessed destination.

Links back to the current provision or one of its ancestors are suppressed because they do not provide useful navigation.

### How is “the Act” interpreted in CFR text?

A bare “the Act” is treated as the INA only in a reviewed CFR scope whose definitions support that meaning. `src/INASearch-Legal-Reference-Policy.js` records each scope, its controlling CFR citation, an exact source excerpt, and the official URL.

The build verifies that every excerpt still appears in the captured CFR source. Named historical laws such as “the Act of February 5, 1917” are not treated as bare references to the INA. An explicit phrase such as “the Immigration and Nationality Act” can be recognized outside those bare-Act scopes.

### Are build-time and runtime citations handled differently?

No. The builder and browser use the same parser. When the optional updater changes a CFR part, every reference-bearing field in that part is reparsed after the new text is inserted and before the staged corpus can be activated.

Golden fixtures run the same examples through both Node and a browser-like environment. Tests also cover false positives, crosswalk aliases, relative paths, packing and hydration, policy tampering, and changed-CFR regeneration.

## Source evidence and integrity

### What is pinned for an audited release?

`sources/legal/source-manifest.json` records the requested and final URLs, publisher identifiers, byte counts, and SHA-256 hashes for:

- the House Title 8 ZIP and extracted USLM XML;
- the USCIS INA page; and
- the GovInfo INA compilation.

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
