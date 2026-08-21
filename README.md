# INASearch

INASearch is a fast reference tool for federal immigration statutes and regulations. It runs as a single HTML file and includes its legal corpus, so you can search and read it without installing software or relying on an internet connection.

Enter an INA, U.S.C., or CFR citation to open the provision, browse its structure, follow cross-references, and jump to the official source when needed.

## What you can do

- Search INA, Title 8 U.S.C., and the included CFR material by citation or text.
- Switch between INA and U.S.C. citations using the built-in crosswalk.
- Open exact subsections and paragraphs in a structured legal reader.
- Preview many cross-referenced provisions without leaving the page.
- Find source-specific definitions and links to USCIS forms and Policy Manual resources.
- Attach searchable notes to legal provisions, citation ranges, forms, and other resources.
- Browse repealed, transferred, omitted, and note-based statutory material with clear labels.

## Get started

1. Download `INASearch.html`.
2. Open it in a current version of Microsoft Edge or Chrome.
3. Enter a citation, term, or phrase in the search box.

Examples:

```text
INA 203
8 U.S.C. 1153(b)(2)
8 CFR 214.2(h)(13)(iii)(A)
in: INA 245 adjustment
cites: 8 U.S.C. 1182(a)(6)
```

You can also add a search to the file URL:

```text
INASearch.html?q=8%20CFR%20214.2%28h%29
```

## Saving notes and settings

INASearch works without an account and does not save anything to a server.

To keep your notes and settings, open **Saving & data** and connect an `INASearch_Data.json` file. You choose where that file lives. INASearch can then save your notes, preferences, and tutorial progress to it automatically.

The data file is not encrypted, so protect it like any other document containing work information.

## CFR updates and internet access

Automatic CFR updates are **off by default**. With updates off, INASearch uses its built-in legal corpus and makes no network requests.

You can turn updates on in **Settings**. When enabled, INASearch checks the CFR material already included in the tool directly against eCFR. This setting does not update the U.S. Code, INA crosswalk, USCIS resources, or other non-CFR material.

## Where the legal text comes from

- Title 8 U.S.C. comes from the House Office of the Law Revision Counsel.
- The INA crosswalk comes from USCIS and is checked against GovInfo and House records.
- Regulations come from eCFR. Cross-title CFR coverage is selected using a reviewed GovInfo authority table.
- Definitions come from the USCIS Glossary, INA 101, and 8 CFR 1.2.

The **About** page shows the capture dates and coverage for the copy you are using. Official-source links are available throughout the reader when you need to confirm current law.

## Editions

- `INASearch.html` is the normal, smaller edition.
- `INASearch-Uncompressed.html` contains the same corpus as readable, uncompressed JSON for inspection.

Both editions are complete standalone files.

## Learn more

See [FAQ.md](FAQ.md) for detailed answers about:

- how the legal corpus is selected and audited;
- how INA and U.S.C. citations are crosswalked;
- how inline citations and links are interpreted;
- how optional CFR updates work;
- how notes, browser storage, privacy, and file permissions work; and
- how to build and verify the project.

## Limits

INASearch is a reference tool, not legal advice, and it does not include case law. Its built-in material is a dated snapshot. Use the official-source links when current law or source currency matters.
