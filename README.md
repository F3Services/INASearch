# INASearch

INASearch is a browser-based reference and study tool for ISOBASIC. Entering an INA, U.S.C., or CFR citation opens the included provision immediately, with its hierarchy, related citations, and official-source link.

## Core features

- **Quick citation lookup:** Recognizes common INA, U.S.C., and CFR formats, including compact citations and deep paragraph paths. INA/U.S.C. crosswalks can be switched in the search field.
- **Offline legal reader:** Displays the selected statutory or regulatory unit and its descendants. Units can be copied, printed, or opened at the official House or eCFR page.
- **Definitions:** Keeps USCIS policy definitions and statutory or regulatory definitions as separate, source-scoped records.
- **Notes:** Provides searchable day, module, classification, and uncategorized notes.
- **Cards and quizzes:** Supports immigrant and nonimmigrant classification study, approved-resource identification, and optional practice questions.

## Deployment and cybersecurity design

INASearch is a self-contained HTML document, not an installed application. It opens from a local folder in current Microsoft Edge or Chrome and runs within the browser's security model.

- No installation, administrator access, background service, or local web server.
- No account, telemetry, third-party runtime code, or automatic network requests.
- Statutes, regulations, application logic, and study data are embedded in the HTML file.
- External official sources open only when the user selects an outbound link.
- Saving back to the HTML file requires an explicit browser permission; a JSON backup is available when direct saving is unavailable.
- The embedded corpus is checked against recorded byte counts and SHA-256 hashes before use.

This design limits the review surface to a static document interpreted by the approved browser. The uncompressed edition also makes the complete embedded corpus directly inspectable as JSON.

## Editions

- **`INASearch.html`** — standard edition with the complete embedded corpus.
- **`INASearch-AU.html`** — same corpus with card-resource fields already unlocked.
- **`INASearch-Uncompressed.html`** — standard edition with plain embedded JSON instead of gzip.

Each file is complete by itself.

## Legal sources

The offline corpus is built from captured official sources:

- Title 8 U.S.C. text and structure from House USLM XML.
- Complete Title 8 CFR and included cross-title parts from eCFR and GovInfo records.
- Definitions from the USCIS Glossary, INA 101, and 8 CFR 1.2.
- Immigration classifications from the tables in 22 CFR 41.12 and 22 CFR 42.11.

Build tools preserve exact source text and generate navigation metadata separately. They do not generate, summarize, clarify, or paraphrase statutory or regulatory language. House editorial footnotes and CFR editorial material remain clearly separated from operative text. **Sources & About** records snapshot dates, coverage, provenance, and hashes.

## How cards are constructed

Nonimmigrant cards begin with the 84 symbols in 22 CFR 41.12; immigrant cards begin with the 158 symbols in 22 CFR 42.11. Individual fields are attached only when an approved source supports them, including the INA, CFR classification tables, USCIS Policy Manual resources, official form pages, and the Pocket Field Guide. Unsupported fields are omitted rather than inferred.

Resource-identification questions reveal the fields supported by each source. A wrong answer pauses only that question for one minute while leaving its source link available. The all-unlocked edition reveals the same sourced fields without requiring those questions.

## Using INASearch

1. Download one edition.
2. Open it in current Microsoft Edge or Chrome.
3. Enter a citation, term, or phrase in the search field.

To open directly to a search, add a URL-encoded `q` parameter, for example:

```text
INASearch.html?q=8%20CFR%20214.2%28h%29
```

To retain notes and progress, open **Saving & progress** and either enable autosaving or download a JSON backup. Earlier INASearch and legacy profile files can be imported from the same menu. Work-environment copies containing controlled notes or course information should not be uploaded to the repository.

## Repository and verification

- Root `INASearch*.html` files are the distributable editions.
- `src/` contains the interface template, reviewed source data, and generated legal-data records.
- `tools/` contains source generators, integrity checks, and the standalone builder.

Build and verify the editions with:

```bash
node tools/build-standalone.js
node tools/test-standalone.js
```

The test suite checks corpus integrity, deterministic payloads, citation targets, structured House footnotes, CFR coverage, profile migration, search performance, and the size limits for all three editions.

## Scope

INASearch is a study reference, not legal advice. It uses dated offline snapshots and does not update itself at runtime. Users should use the included official-source actions when current law or exact source currency must be confirmed.
