# AuthoritySearch

AuthoritySearch is a portable, local-first ISOBASIC study reference. It provides flexible INA/U.S.C./CFR citation handling, a source-scoped definitions catalog, approved-resource catalogs, nonimmigrant and immigrant classification cards, resource-identification unlock questions, optional practice quizzes, and searchable course notes.

The distributed application is one HTML file. It runs directly from a local folder in current Microsoft Edge or Chrome with no installation, server, framework, telemetry, automatic network request, or companion JavaScript file.

The primary navigation opens on **Definitions**, which is the leftmost page. The classic optional quiz is opened from **Sources & About** instead of occupying a primary-navigation tab.

## Choose one version

- `AuthoritySearch.html` is the standard version. It includes the complete locally captured Title 8 text and notes, so U.S.C. citations can be displayed and highlighted inside AuthoritySearch. An official House source link remains available.
- `AuthoritySearch-no-USC.html` is the lightweight version. It retains 376 Title 8 citation and hierarchy records, INA/U.S.C. crosswalks, the focused INA 101/8 CFR 1.2 definitions catalog, both classification tables, resource checks, practice quizzes, catalogs, and notes, but omits the general cached Title 8 section bodies. Ordinary U.S.C. citations open on `uscode.house.gov`.

## Immigration type cards and resource checks

The **Nonimmigrant Types** page is built from the 84 symbols in Table 1 to 22 CFR 41.12. Its first three open-resource checks unlock the classification table, the INA 101(a)(15) definition field, and the USCIS Policy Manual Volume 2 EOS/COS appendix field for all matching cards. The EOS/COS check remains one combined question and unlocks both eligibility and the form type reported by that appendix. Fifteen additional approved-resource questions unlock sourced initial application or petition forms for the applicable classifications. Maximum admission and maximum continuous-stay fields direct the student to the Pocket Field Guide once the classification table is unlocked.

The **Immigrant Types** page is built from the 158 symbols in Table 1 to 22 CFR 42.11. One resource check unlocks the table, followed by eight definition questions grouped by each distinct combination of source instruments (INA-only, INA plus a named appropriations act, and so on) and 22 approved-resource form questions. Large question scopes use compact root-prefix notation, with parenthesized ranges when only part of a root is included. Citation-choice questions link their answer text directly to the official resource; form questions link the specifically named source and form, then require the exact matching set of statuses. A sourced derivative card displays the principal's form type with an asterisk and a focusable or hoverable `*derivative classification` explanation. Cards do not display an initial form when the approved resources do not justify one. The older status and fact question bank is available from **Sources & About** as optional practice and does not control card content. Both Types pages and the optional Quiz remain unavailable during scheduled testing hours.

Each version is complete by itself. Most users should receive `AuthoritySearch.html`; use `AuthoritySearch-no-USC.html` when file size matters more than local U.S.C. text.

## Local statutory citation links

In the standard build, citations embedded in cached operative Title 8 text are clickable when the official House USLM XML identifies a target inside Title 8. Selecting one runs the target citation through AuthoritySearch, opens the locally cached section, and highlights the exact structural target or its nearest cached parent. It does not send the user to `uscode.house.gov`.

While a cached statute is open, a sticky hierarchy navigator appears directly below the top bar. It follows the statutory line at one quarter of the statute-reading viewport and lists Title, chapter, subchapter, part when present, section, and the currently visible nested paragraph levels. Each segment opens a dropdown populated only with siblings that share the same parent. Citation jumps align the selected statutory line—or the top of the section for a section-level citation—with that same quarter-view reading line.

The current build contains 3,587 verified local reference links: 1,289 in operative statutory nodes, 33 in section preambles, and 2,265 in statutory or editorial notes. Link text, source record, target section, and target hierarchy are generated from the official House Title 8 XML and checked against the displayed corpus during every build. References to other U.S.C. titles, public laws, Statutes at Large, repealed or omitted Title 8 sections that are not cached, or other unavailable authorities remain plain text rather than pretending that a local target exists.

## Definitions

Open **Definitions** from the navigation bar or search for `definitions`. Typing `define:` in the main search bar opens the page immediately and filters terms by case-insensitive substring as you type—for example, `define: child`.

The initial catalog contains 61 explicit definition clauses from INA 101 and 32 entries from 8 CFR 1.2. Each definition keeps its exact locator, official link, capture date, governing scope language, and any separately recorded definition-specific applicability language. A term defined more than once remains multiple source records; AuthoritySearch does not merge the texts into a synthesized meaning. Use **Defined in** to filter by source location and **Applicable in** to filter by the scope stated in the authority.

## Enabling autosaving

The HTML contains its own profile data. Browser security still requires one user action before a local page may update itself:

1. Open the chosen AuthoritySearch HTML file in Edge.
2. Click the **Autosaving off** status at the upper right to open **Saving & progress**.
3. Choose **Enable autosaving**.
4. When the file picker appears, select the same AuthoritySearch HTML file that is currently open and grant write access if Edge asks.

After setup, changes wait five seconds and then AuthoritySearch rewrites only its embedded profile block. The header changes through **Autosave queued**, **Saving…**, and **Saved**. The compressed corpus and its manifest remain byte-for-byte unchanged.

AuthoritySearch does not show the large unsaved-changes warning merely because autosaving is off. The warning appears only after something that belongs in the profile changes—for example, a quiz answer, note, imported profile, or block/module structure. Searching, changing a result filter, and ordinary navigation do not trigger it.

If managed Edge policy prevents filesystem writing, AuthoritySearch cannot silently bypass that restriction. **Download progress backup** saves the current profile as JSON.

## Moving progress to a newer file

Application updates arrive as a new HTML file, so progress in an older copy is not automatically present in the replacement. In the new file:

1. Click the saving-status control at the upper right.
2. Select **Import an older AuthoritySearch profile**.
3. Choose an older standalone AuthoritySearch HTML, the `AuthoritySearch-Profile.js` from an older three-file version, or an AuthoritySearch JSON progress backup.
4. Confirm the import and enable autosaving for the new HTML file.

Do not upload a work-environment copy containing controlled notes or course titles back to the public repository.

## Defining blocks and modules

Open **Notes**, expand **Define Block/Module categories**, and enter the object below in the built-in editor. Do not include a `courseStructure` property around it; the editor expects the object beginning with `{` and ending with `}`. This example is only a hypothetical 5-block, 5-module-per-block shape—not a proposed course structure—and all titles are placeholders.

```json
{
  "blocks": [
    {
      "id": "block-1",
      "number": 1,
      "title": "Block 1 Placeholder",
      "modules": [
        {
          "id": "block-1-module-1",
          "number": 1,
          "title": "Module 1 Placeholder"
        },
        {
          "id": "block-1-module-2",
          "number": 2,
          "title": "Module 2 Placeholder"
        },
        {
          "id": "block-1-module-3",
          "number": 3,
          "title": "Module 3 Placeholder"
        },
        {
          "id": "block-1-module-4",
          "number": 4,
          "title": "Module 4 Placeholder"
        },
        {
          "id": "block-1-module-5",
          "number": 5,
          "title": "Module 5 Placeholder"
        }
      ]
    },
    {
      "id": "block-2",
      "number": 2,
      "title": "Block 2 Placeholder",
      "modules": [
        {
          "id": "block-2-module-1",
          "number": 1,
          "title": "Module 1 Placeholder"
        },
        {
          "id": "block-2-module-2",
          "number": 2,
          "title": "Module 2 Placeholder"
        },
        {
          "id": "block-2-module-3",
          "number": 3,
          "title": "Module 3 Placeholder"
        },
        {
          "id": "block-2-module-4",
          "number": 4,
          "title": "Module 4 Placeholder"
        },
        {
          "id": "block-2-module-5",
          "number": 5,
          "title": "Module 5 Placeholder"
        }
      ]
    },
    {
      "id": "block-3",
      "number": 3,
      "title": "Block 3 Placeholder",
      "modules": [
        {
          "id": "block-3-module-1",
          "number": 1,
          "title": "Module 1 Placeholder"
        },
        {
          "id": "block-3-module-2",
          "number": 2,
          "title": "Module 2 Placeholder"
        },
        {
          "id": "block-3-module-3",
          "number": 3,
          "title": "Module 3 Placeholder"
        },
        {
          "id": "block-3-module-4",
          "number": 4,
          "title": "Module 4 Placeholder"
        },
        {
          "id": "block-3-module-5",
          "number": 5,
          "title": "Module 5 Placeholder"
        }
      ]
    },
    {
      "id": "block-4",
      "number": 4,
      "title": "Block 4 Placeholder",
      "modules": [
        {
          "id": "block-4-module-1",
          "number": 1,
          "title": "Module 1 Placeholder"
        },
        {
          "id": "block-4-module-2",
          "number": 2,
          "title": "Module 2 Placeholder"
        },
        {
          "id": "block-4-module-3",
          "number": 3,
          "title": "Module 3 Placeholder"
        },
        {
          "id": "block-4-module-4",
          "number": 4,
          "title": "Module 4 Placeholder"
        },
        {
          "id": "block-4-module-5",
          "number": 5,
          "title": "Module 5 Placeholder"
        }
      ]
    },
    {
      "id": "block-5",
      "number": 5,
      "title": "Block 5 Placeholder",
      "modules": [
        {
          "id": "block-5-module-1",
          "number": 1,
          "title": "Module 1 Placeholder"
        },
        {
          "id": "block-5-module-2",
          "number": 2,
          "title": "Module 2 Placeholder"
        },
        {
          "id": "block-5-module-3",
          "number": 3,
          "title": "Module 3 Placeholder"
        },
        {
          "id": "block-5-module-4",
          "number": 4,
          "title": "Module 4 Placeholder"
        },
        {
          "id": "block-5-module-5",
          "number": 5,
          "title": "Module 5 Placeholder"
        }
      ]
    }
  ]
}
```

Structure rules:

- `blocks` and `modules` must be arrays.
- Every block needs `id`, `number`, `title`, and `modules`.
- Every module needs `id`, `number`, and `title`.
- Block IDs must be unique throughout the profile.
- Module IDs must be unique within their block.
- Keep IDs stable after entering notes. Changing an ID can disconnect the existing note assigned to it.
- `number` must be a positive whole number and controls display order.
- `title` must be a quoted string and may be empty.
- A block with an empty `modules` array does not produce a module-note location.

After **Apply structure**, every configured module appears as an initially empty note. Week/day notes from W1D1 through W6D5 are always available without configuration.

## Compressed corpus format

Both generated HTML files carry their corpus as compact UTF-8 JSON compressed with ordinary [gzip (RFC 1952)](https://datatracker.ietf.org/doc/html/rfc1952), then represented with standard [Base64 (RFC 4648)](https://www.rfc-editor.org/info/rfc4648/) inside a marked `application/gzip` script block. Base64 is transport encoding, not encryption or a security measure. Decompression occurs only in browser memory through the standard [DecompressionStream API](https://compression.spec.whatwg.org/) and requires no file, network, installation, or execution permission.

Immediately above the payload, a readable JSON manifest records the schema and corpus versions, encoding, compression, media/content types, compressed and uncompressed byte counts, and SHA-256 hashes. **Sources & About** displays the same data and a copyable extraction command.

To inspect either corpus:

1. Extract the text between the `AUTHORITY_SEARCH_CORPUS_DATA_START` and `AUTHORITY_SEARCH_CORPUS_DATA_END` markers.
2. Base64-decode it to `AuthoritySearch-Corpus.json.gz`.
3. Decompress it with an ordinary gzip tool.
4. Verify the byte counts and SHA-256 hashes against the embedded manifest.
5. Inspect the resulting UTF-8 JSON.

PowerShell example for the standard build:

```powershell
$htmlPath = ".\AuthoritySearch.html"
$outGzip = ".\AuthoritySearch-Corpus.json.gz"
$outJson = ".\AuthoritySearch-Corpus.json"

$html = [IO.File]::ReadAllText($htmlPath)
$pattern = '(?s)<script id="authoritySearchCorpusData" type="application/gzip" data-encoding="base64">\s*(.*?)\s*</script>'
$base64 = ([regex]::Match($html, $pattern).Groups[1].Value -replace '\s', '')
[IO.File]::WriteAllBytes($outGzip, [Convert]::FromBase64String($base64))

$input = [IO.File]::OpenRead($outGzip)
$output = [IO.File]::Create($outJson)
$gzip = [IO.Compression.GZipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
$gzip.CopyTo($output)
$gzip.Dispose()
$output.Dispose()
$input.Dispose()

Get-FileHash $outGzip -Algorithm SHA256
Get-FileHash $outJson -Algorithm SHA256
```

Change `$htmlPath` to `.\AuthoritySearch-no-USC.html` to inspect the lightweight build. No custom or third-party decompressor is used.

## Compatibility behavior

Current Microsoft Edge is the primary target. If `DecompressionStream` is unavailable, or if the compressed bytes, hashes, JSON, or schema cannot be validated, AuthoritySearch shows a compatibility error and disables the visa cards and quiz. Official U.S.C. and CFR citation navigation remains available. It does not request another permission, download a fallback decoder, or modify the file.

## Repository structure

The root HTML files are the user-facing builds. Developer source remains separate and human-readable:

- `src/AuthoritySearch.template.html` contains the editable interface and application logic.
- `src/AuthoritySearch-Corpus.js` contains the reviewed, uncompressed source corpus used during the build.
- `src/AuthoritySearch-Definitions.js` contains the human-readable 8 CFR 1.2 transcription, source metadata, and scope records. INA 101 entries are deterministically derived from the reviewed 8 U.S.C. 1101 hierarchy during the build.
- `src/AuthoritySearch-Visa-Tables.js` contains the generated 22 CFR 41.12 and 42.11 classification rows and the grouped immigrant-definition authorities.
- `src/AuthoritySearch-Form-Questions.js` contains the approved-resource initial-form questions, status mappings, form links, and derivative-classification explanations.
- `src/AuthoritySearch-Statute-References.js` contains the verified local Title 8 reference spans and targets generated from official House USLM XML.
- `src/AuthoritySearch-Profile.js` contains the blank public profile used when generating a new build.
- `tools/definition-catalog.js` builds the definitions catalog without merging duplicate terms or discarding source scope.
- `tools/statute-references.js` validates and attaches local citation spans without changing statutory text or hierarchy.
- `tools/generate-statute-references.js` regenerates the reviewed reference source from an official `usc08.xml` file.
- `tools/generate-visa-tables.js` regenerates the two classification tables from official eCFR Title 22 XML snapshots; `--existing` recomputes derived question groups without rewriting the captured table rows.
- `tools/build-standalone.js` deterministically generates both standalone HTML files using maximum gzip compression and a zero gzip timestamp.

The source JavaScript files are not part of the workstation package.

## Source boundary

AuthoritySearch is a study aid, not legal advice. Displayed facts are tied to individual approved-source records. Users should consult the current official source when currency or exact legal language matters.
