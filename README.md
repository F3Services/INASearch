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

## Appearance

INASearch follows your device's light or dark setting by default. In the top bar or **Settings → Appearance**, the sun/moon button switches to the theme shown on its face; the laptop button returns to System mode, and its small sun or moon shows the device's current theme. The choice is saved with your profile and applies to both standalone editions.

Appearance also provides independent, off-by-default options to hide the Updates display, save-status display, or top-bar theme buttons. Hiding the top-bar theme buttons does not remove the controls from Settings.

The typography uses offline system font stacks inspired by the USCIS Policy Manual. INASearch does not download webfonts or require an internet connection to display either theme.

## Saving notes and settings

INASearch works without an account and does not save anything to a server. Notes, preferences, and tutorial progress save automatically in browser-owned IndexedDB storage.

Browser data can be cleared, evicted, or separated when the standalone HTML file is moved or renamed. For stronger protection, open **Saving & data** and connect an `INASearch_Data.json` file or download periodic JSON backups. A connected file is authoritative and updates automatically alongside the browser copy.

The data file is not encrypted, so protect it like any other document containing work information.

## CFR updates and internet access

Automatic CFR updates are **off by default**. With updates off, INASearch uses its built-in legal corpus and makes no network requests.

You can turn updates on in **Settings**. When enabled, INASearch checks the CFR material already included in the tool directly against eCFR. Changed parts are accepted only when dated XML text and the same-date enhanced renderer agree on complete record, hierarchy, and paragraph-boundary inventories. This setting does not update the U.S. Code, INA crosswalk, USCIS resources, or other non-CFR material.

## Where the legal text comes from

- Title 8 U.S.C. comes from the [House Office of the Law Revision Counsel](https://uscode.house.gov/).
- The INA crosswalk comes from [USCIS](https://www.uscis.gov/laws-and-policy/legislation/immigration-and-nationality-act) and is checked against [GovInfo](https://www.govinfo.gov/app/details/COMPS-1376) and House records.
- Regulations come from [eCFR](https://www.ecfr.gov/current/title-8). The release pairs the official XML text with same-date eCFR enhanced-renderer paragraph IDs and independently audits the resulting hierarchy. Cross-title CFR coverage is selected using GovInfo's [Parallel Table of Authorities and Rules](https://www.govinfo.gov/content/pkg/GPO-CFR-INDEX-2025/html/GPO-CFR-INDEX-2025-4.htm).
- Definitions come from the [USCIS Glossary](https://www.uscis.gov/tools/glossary), [INA 101](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title8-section1101&num=0&edition=prelim), and [8 CFR 1.2](https://www.ecfr.gov/current/title-8/part-1/section-1.2).

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
