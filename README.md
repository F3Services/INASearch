# INASearch

INASearch is a browser-based reference and study tool for ISOBASIC. Entering an INA, U.S.C., or CFR citation opens the included provision immediately, with its hierarchy, related citations, and official-source link.

## Core features

- **Quick citation lookup:** Recognizes common INA, U.S.C., and CFR formats, including compact citations and deep paragraph paths. INA/U.S.C. crosswalks can be switched in the search field. Use `in:` to search within a citation or range, and `cites:` to find indexed statutes and regulations whose outgoing links reference a citation or range.
- **Authority browsing:** Entering `INA`, an INA title such as `INA 200`, a CFR title such as `22 CFR`, or a CFR part such as `22 CFR 42` opens an authoritative, clickable hierarchy drawn from the embedded corpus.
- **Offline legal reader:** Displays the selected statutory or regulatory unit and its descendants. Units can be copied, printed, or opened at the official House or eCFR page. A display setting can relabel crosswalked Title 8 links with their full INA citations without changing their destinations. CFR references that name the INA—or use “the Act” within an INA-defined regulatory scope—are crosswalked to the statute and use the same offline hover previews; abbreviated alternatives are linked only when the inherited path matches an indexed statutory unit.
- **Definitions:** Keeps USCIS policy definitions and statutory or regulatory definitions as separate, source-scoped records.
- **Definitions in context:** Marks explicitly defined legal terms only where their recorded statute or regulation scope applies. Hovering previews the controlling definition without adding the Definitions page to legal-reader history.
- **Citation-associated notes:** Adds searchable notes to exact U.S.C./INA or CFR units at any indexed depth. Notes can cover multiple citations or ranges, use free-form tags, and retain related visa, form, or resource links.
- **Cards and quizzes:** Supports immigrant and nonimmigrant classification study, approved-resource identification, and optional practice questions.
- **Optional tutorials:** A nonintrusive tutorial hub provides Quick Start and focused modules without opening anything automatically at startup.

## Deployment and cybersecurity design

INASearch is a self-contained HTML document, not an installed application. It opens from a local folder in current Microsoft Edge or Chrome and runs within the browser's security model.

- No installation, administrator access, background service, or local web server.
- No account, telemetry, third-party runtime code, or automatic network requests.
- Statutes, regulations, application logic, and study data are embedded in the HTML file.
- External official sources open only when the user selects an outbound link.
- If the browser cannot be granted permission to update the HTML file directly, the user can explicitly download a portable JSON file containing their notes and progress.
- The embedded corpus is checked against recorded byte counts and SHA-256 hashes before use.

This design limits the review surface to a static document interpreted by the approved browser. The uncompressed edition also makes the complete embedded corpus directly inspectable as JSON.

## Editions

- **`INASearch.html`** — standard edition with the complete embedded corpus.
- **`INASearch-Uncompressed.html`** — standard edition with plain embedded JSON instead of gzip.

Each file is complete by itself.

## Legal sources

The offline corpus is built from captured official sources:

- Title 8 U.S.C. text and structure from House USLM XML.
- Complete Title 8 CFR and included cross-title parts from eCFR and GovInfo records.
- Definitions from the USCIS Glossary, INA 101, and 8 CFR 1.2.
- Immigration classifications from the tables in 22 CFR 41.12 and 22 CFR 42.11.

Build tools preserve exact source text and generate navigation metadata separately. They do not generate, summarize, clarify, or paraphrase statutory or regulatory language. House editorial footnotes and CFR editorial material remain clearly separated from operative text. **About** records snapshot dates, coverage, provenance, and hashes.

## How cards are constructed

Nonimmigrant cards begin with the 84 symbols in 22 CFR 41.12; immigrant cards begin with the 158 symbols in 22 CFR 42.11. Individual fields are attached only when an approved source supports them, including the INA, CFR classification tables, USCIS Policy Manual resources, official form pages, and the Pocket Field Guide. Unsupported fields are omitted rather than inferred.

Resource-identification questions reveal the fields supported by each source. A wrong answer pauses only that question for one minute while leaving its source link available.

## Using INASearch

1. Download one edition.
2. Open it in current Microsoft Edge or Chrome.
3. Enter a citation, term, or phrase in the search field.

To open directly to a search, add a URL-encoded `q` parameter, for example:

```text
INASearch.html?q=8%20CFR%20214.2%28h%29
```

Open **Settings** from the gear button to choose U.S. Code or INA labels for crosswalked statutory links and set or clear the default startup citation used when no `q` parameter is present. To retain notes, settings, and progress, use the same menu to enable autosaving or download a JSON backup. Earlier INASearch and legacy profile files can also be imported there. Work-environment copies containing controlled notes or training information should not be uploaded to the repository.

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

The test suite checks corpus integrity, deterministic payloads, citation targets, structured House footnotes, CFR coverage, profile migration, search performance, and the size limits for both editions.

## Scope

INASearch is a study reference, not legal advice. It uses dated offline snapshots and does not update itself at runtime. Users should use the included official-source actions when current law or exact source currency must be confirmed.
