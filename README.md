# INASearch

INASearch is a fast, self-contained navigator for federal immigration statutes and regulations. Enter an INA, U.S.C., or CFR citation to open the exact provision with its hierarchy, cross-references, and current official-source link—without installing software or relying on a live connection.

That speed and context are especially useful during ISOBASIC, where users often need to move quickly among citations, definitions, related provisions, and official sources.

## Core features

- **Quick citation lookup:** Recognizes common INA, U.S.C., and CFR formats, including compact citations and deep paragraph paths. A bare numeric stem also exposes separately numbered letter-suffixed sections or parts—for example, `8 CFR 274` includes Parts 274 and 274A—while `274A` and `274(a)` remain distinct. INA/U.S.C. crosswalks can be switched in the search field. Use `in:` to search within a citation or range, and `cites:` to find indexed statutes and regulations whose outgoing links reference a citation or range.
- **Authority browsing:** Entering `INA`, an INA title such as `INA 200`, a CFR title such as `22 CFR`, or a CFR part such as `22 CFR 42` opens an authoritative, clickable hierarchy drawn from the embedded corpus.
- **Offline legal reader:** Displays the selected statutory or regulatory unit and its descendants. Units can be copied, printed, or opened at the official House or eCFR page. A display setting can relabel crosswalked Title 8 links with their full INA citations without changing their destinations. CFR references that name the INA—or use “the Act” within an INA-defined regulatory scope—are crosswalked to the statute and use the same offline hover previews; abbreviated alternatives are linked only when the inherited path matches an indexed statutory unit.
- **Disposition-aware statute search:** Repealed, transferred, and omitted Title 8 records remain searchable and are visibly marked. A sticky reader warning distinguishes retained historical House material from current law. Clicking a transferred result follows its reviewed destination—within the local Title 8 corpus when available, or to the official House page for another title. Material set out as a note and former or “see” destinations retain those qualifications.
- **Automatic CFR updates:** Checks the CFR material included in INASearch directly against eCFR and downloads changes in the background. This can be turned off in Settings for a local-only experience with no network activity.
- **Definitions:** Keeps USCIS policy definitions and statutory or regulatory definitions as separate, source-scoped records.
- **Definitions in context:** Can mark explicitly defined legal terms where their recorded statute or regulation scope applies. This experimental setting is off by default because matching a defined word cannot determine whether every use has the same grammatical or contextual meaning. Hovering a highlight previews the controlling definition without adding the Definitions page to legal-reader history.
- **Citation-associated notes:** Adds searchable notes to exact U.S.C./INA or CFR units at any indexed depth. Notes can cover multiple citations or ranges, use free-form tags, and retain related forms or agency resources.
- **Supporting references:** Includes named-Act references, USCIS Glossary definitions, Policy Manual hierarchy and links, form links, and official-source shortcuts alongside the statute and regulation corpus.
- **Guided tutorials:** New users see a dismissible Quick Start prompt. Until that basic lesson is completed, the Tutorials button starts or resumes it directly; afterward, the button opens the focused tutorial catalog. Nothing starts automatically at startup.

## Deployment, storage, and cybersecurity design

INASearch remains a self-contained HTML document rather than an installed application. It opens from a local folder in current Microsoft Edge or Chrome and runs within the browser's security model. It does not need administrator access, an account, a background service, or a local web server.

The HTML contains a complete release corpus so search is available immediately and offline. The standard edition stores that embedded payload in a compact delivery representation: repeated values and derivable defaults are omitted or interned, then restored once before search indexes are built. Current statutory status is implied; only exceptional top-level sections store a disposition, compact transferred-destination tuples live only on those top-level records, and subordinate search records inherit the status at runtime. The canonical source, the inspectable uncompressed edition, and the replaceable working corpus in IndexedDB remain expanded. Browser-owned corpus storage can be cleared without risking notes; the release corpus can hydrate it again.

Durable user data follows a different path:

- **Saving & data** opens the browser's save-file picker with `INASearch_Data.json` as the suggested name. The user can accept that name or select an existing valid vault.
- The permission applies to that one selected file. INASearch never requests a directory handle and cannot enumerate or edit the parent folder.
- Notes, preferences, and tutorial state autosave to the connected JSON file after setup. Every write checks the vault identity and revision first, uses the browser's safe-writable path, and reads the file back for verification before reporting success.
- A second INASearch window cannot silently overwrite a newer vault revision. The user must reconnect after a conflict.
- The file handle is remembered in IndexedDB when the browser permits it. On Chrome 122+ (and compatible Chromium builds), a later reconnect may offer **Allow on every visit**; choosing it makes the grant persistent until the user revokes it. If that choice is unavailable or disallowed by enterprise policy, reconnecting the remembered handle can still require one click after all INASearch tabs have closed. Clearing browser data removes the remembered handle and its permission, but it does not delete `INASearch_Data.json`; the user can select the existing file again.
- When durable saving is enabled, INASearch also asks the browser to mark its browser-owned storage persistent. Chromium may grant or silently deny that request. This reduces storage-pressure eviction risk for the replaceable IndexedDB corpus and remembered handle, but it never changes the durability rule: the JSON vault, not IndexedDB, is the source of truth for notes.
- **Download JSON backup** remains available. A OneDrive or other versioned documents location is strongly recommended because one-file permission deliberately prevents INASearch from creating undeclared sibling backup files.

The JSON vault is durable storage, not encryption. Anyone or any program with access to the file can read it. A maliciously modified INASearch file that the browser authorizes could also read or change the connected vault; file-only permission limits the filesystem scope but cannot make compromised application code trustworthy.

### Direct-authority CFR maintenance

Automatic CFR updates are on by default and can be turned off in **Settings**. When they are off, INASearch uses only its local data and makes no network requests. When they are on, INASearch does not download a corpus bundle from this repository or from an INASearch-operated service; its runtime updater talks directly to `https://www.ecfr.gov`:

1. It checks the eCFR title metadata for the complete fixed CFR coverage.
2. It requests title-level version deltas and correction records only where the dated local snapshot may be behind.
3. It downloads XML only for changed covered parts, normalizes it locally, stores the exact source artifacts with SHA-256 hashes, stages the resulting corpus, reads and hashes the staged record, and only then activates it.
4. It retains the previous active corpus record for rollback and uses the updated corpus after reload.

The request set is derived from fixed corpus coverage and snapshot dates, never from searches or laws a user views. When enabled, checks run after startup and at most every 12 hours while a copy remains open. Multiple tabs coordinate through a browser lock. Local search never waits for the network or update processing.

The content-security policy permits runtime connections only to `www.ecfr.gov`; there is no telemetry or third-party runtime code. The embedded release payload and IndexedDB corpus records have byte counts and SHA-256 integrity checks. These checks detect corruption, but because eCFR XML is not digitally signed, they are not a substitute for authenticating the INASearch HTML itself before use.

There is an unavoidable standalone-browser boundary: the Office of the Law Revision Counsel and USCIS official sites do not currently grant browser CORS access to the U.S. Code downloads and USCIS resources used by this corpus. INASearch therefore does **not** claim automatic runtime currency for Title 8 U.S.C., the INA crosswalk, Policy Manual metadata, forms, or glossary data. Their dated release snapshots and official links remain visible in **About**. Adding a proxy would remove that limitation but would also create the centralized middleman this design intentionally rejects.

The uncompressed edition makes the complete embedded release corpus directly inspectable as JSON.

## Editions

- **`INASearch.html`** — standard edition with the complete embedded corpus.
- **`INASearch-Uncompressed.html`** — standard edition with plain embedded JSON instead of gzip.

Each file is complete by itself.

## Legal sources

Statutes and regulations are both primary sources of law. INASearch names them directly because its corpus does not include case law. The offline legal corpus is built from captured official sources:

- Title 8 U.S.C. text and structure from House USLM XML.
- The INA section inventory and INA-to-U.S.C. labels from USCIS, independently checked against the GovInfo `COMPS-1376` INA compilation and House codification records.
- Complete Title 8 CFR and reviewed cross-title parts from eCFR and the GovInfo Parallel Table of Authorities and Rules.
- Definitions from the USCIS Glossary, INA 101, and 8 CFR 1.2.

Build tools preserve exact source text and generate navigation metadata separately. They do not generate, summarize, clarify, or paraphrase statutory or regulatory language. House editorial footnotes and CFR editorial material remain clearly separated from operative text. **About** records snapshot dates, coverage, provenance, and hashes.

### Corpus provenance and audit rules

The statutory corpus and the INA view answer different questions. The corpus contains the complete captured House Title 8 release; it does not assume that every Title 8 section is part of the INA. The INA view is the 183-row section inventory published by USCIS. `tools/generate-ina-crosswalk.py` parses that inventory and validates each row against the independently captured GovInfo INA compilation. Repealed table-of-contents entries, former sections, note mappings, and entries with no U.S.C. equivalent have explicit audit outcomes backed by GovInfo or House evidence. `localSection` records the actual House corpus record when House consolidation differs from the printed U.S.C. label, including `1440–1` and the combined `1484 to 1487` record.

The CFR inclusion rule is recorded in `sources/legal/cfr-scope-policy.json`, not hidden in generator code. It includes all of current Title 8 CFR. For other titles, it includes the reviewed 2025 Parallel Table parts whose 8 U.S.C. authority locator intersects the retained Title 8 corpus, except a mapped part confirmed removed from current eCFR. The policy also records the important limitation that the Parallel Table is agency-supplied and not all-inclusive; adding other practice-relevant parts requires an explicit reviewed policy change. The generator fails if the reviewed cross-title inventory drifts.

Inline references use two evidence paths:

- House-authored USLM `<ref>` links are treated as the authoritative interpretation of their exact displayed source span. The generator resolves the House link grammar to U.S.C., public-law, Statutes-at-Large, or Act targets, verifies every offset against displayed text, and now fails if any source record or span is skipped. House range identifiers are normalized only between the publisher's `...` identifier form and the corpus's ` to ` record form.
- Citations written in text but not supplied as House links are recognized by the shared deterministic parser. Explicit U.S.C., INA, CFR, public-law, Statutes-at-Large, and Federal Register patterns are normalized into the same reference structure. Relative phrases are linked only when their inherited path exists; uncertain antecedents remain unresolved; links to the current unit or an ancestor are suppressed. A bare “the Act” is interpreted as the INA only within a scope in `src/INASearch-Legal-Reference-Policy.js`, where an exact CFR definition excerpt and official URL support that interpretation. Named historical Acts are not treated as bare INA references.

The same parser runs during the build and in the browser. When automatic maintenance changes a covered CFR part, all reference-bearing fields in that part are reparsed after the new text is inserted and before the staged corpus can be activated. The runtime maintenance record stores the engine version, changed parts, fields audited, and regenerated-reference count.

The immutable evidence for a release is under `sources/legal/raw/`. `sources/legal/source-manifest.json` pins requested and final URLs, identifiers, byte counts, and SHA-256 hashes for the House, USCIS, and GovInfo artifacts. Network access is used only for an explicit reviewed capture:

```bash
python3 tools/capture-legal-sources.py capture --capture-date YYYY-MM-DD --refresh
python3 tools/capture-legal-sources.py verify
python3 tools/generate-ina-crosswalk.py
```

The final command is a no-write drift check; use `--write` only when intentionally regenerating the reviewed crosswalk and audit report. `tools/test-standalone.js` rechecks the source hashes, crosswalk outcome inventory, CFR policy hash, all House reference spans, semantic-policy excerpts, Node/browser golden citation fixtures, packing round trips, and changed-CFR runtime regeneration.

## Using INASearch

1. Download one edition.
2. Open it in current Microsoft Edge or Chrome.
3. Enter a citation, term, or phrase in the search field.

To open directly to a search, add a URL-encoded `q` parameter, for example:

```text
INASearch.html?q=8%20CFR%20214.2%28h%29
```

Open **Settings** from the gear button to choose U.S. Code or INA labels for crosswalked statutory links, enable the experimental defined-term highlights, turn automatic CFR updates on or off, and set or clear the default startup citation used when no `q` parameter is present. To retain notes, settings, and tutorial state, use **Saving & data**, choose `INASearch_Data.json`, and leave autosaving enabled. If the browser later asks whether to restore that file permission, choose **Allow on every visit** when appropriate. Earlier INASearch and legacy profile files can also be imported there. Work-environment copies containing controlled notes or training information should not be uploaded to the repository.

Use the note symbol beside any displayed statutory or regulatory unit to create an inline note for that exact citation. The **Notes** page also accepts comma-, semicolon-, or line-separated citations and ranges in **Associated with**, including paragraph-level endpoints. Tags remain free-form, so users can organize notes with labels such as `W2D4`, subjects, or training topics.

## Repository and verification

- Root `INASearch*.html` files are the distributable editions.
- `src/` contains the interface template, reviewed source data, and generated legal-data records.
- `tools/` contains source generators, integrity checks, and the standalone builder.

Build and verify the editions with:

```bash
node tools/build-standalone.js
node tools/test-standalone.js
```

The test suite checks corpus integrity, deterministic payloads, citation targets, exceptional statutory dispositions and redirects, structured House footnotes, CFR coverage, profile migration, the file-only vault contract, updater syntax and source boundary, search performance, and the size limits for both editions. The live fixed-coverage request benchmark is:

```bash
node tools/simulate-cfr-currency-check.js --strategy gated-title --concurrency 3
```

## Scope

INASearch is a legal reference, not legal advice. By default it automatically maintains its covered CFR data when eCFR is reachable; users can turn that feature off for local-only operation. All sources retain explicit currency boundaries. Users should use the included official-source actions when current law or exact source currency must be confirmed.
