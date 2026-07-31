# AuthoritySearch

AuthoritySearch is a portable, local-first study reference designed for ISOBASIC users. It provides fast citation and text lookup across locally indexed approved authorities, flexible INA/U.S.C./CFR citation handling, nonimmigrant-status study cards and quizzes, and searchable course notes.

The application runs directly from a local folder in Microsoft Edge or Chrome. It has no framework, installation, server, telemetry, or automatic network requests.

## Workstation package

Only these three files are required on the workstation:

- `AuthoritySearch.html` — interface, search, quiz, notes, and saving logic
- `AuthoritySearch-Corpus.js` — approved-source corpus, citation mappings, catalogs, visa facts, questions, and provenance
- `AuthoritySearch-Profile.js` — the user's quiz progress, notes, preferences, and locally defined course structure

Keep all three files in the same folder and open `AuthoritySearch.html` in Edge. This README is repository documentation and is not required in the transferred workstation package.

## Profile saving

Loading `AuthoritySearch-Profile.js` allows the page to read the profile, but browser security requires a separate permission before the page may update it.

When the amber saving notification appears, click it and follow the prompt:

- Before making changes, it connects the existing profile for writing.
- If answers or notes already exist only in memory, it saves the current state instead of loading the older profile over it.
- After setup, the header should change through **Saving…** to **Saved** when progress changes.

If managed-browser policy blocks direct file writing, use **Download replacement profile** and manually replace `AuthoritySearch-Profile.js`.

## Defining blocks and modules

Close AuthoritySearch before manually editing the profile. In `AuthoritySearch-Profile.js`, locate the `courseStructure` property inside `window.AUTHORITY_SEARCH_PROFILE` and use this structure:

```js
"courseStructure": {
  "blocks": [
    {
      "id": "block-1",
      "number": 1,
      "title": "First Block Title",
      "modules": [
        {
          "id": "module-1",
          "number": 1,
          "title": "First Module Title"
        },
        {
          "id": "module-2",
          "number": 2,
          "title": "Second Module Title"
        }
      ]
    },
    {
      "id": "block-2",
      "number": 2,
      "title": "Second Block Title",
      "modules": [
        {
          "id": "module-1",
          "number": 1,
          "title": "First Module in Block Two"
        }
      ]
    }
  ]
},
```

Structure rules:

- `blocks` and `modules` must be arrays.
- Every block needs `id`, `number`, `title`, and `modules`.
- Every module needs `id`, `number`, and `title`.
- Block IDs must be unique throughout the profile.
- Module IDs must be unique within their block.
- IDs should be simple, non-sensitive strings such as `block-1` and `module-2`.
- Keep IDs stable after entering notes. Titles and display numbers may be changed without breaking note links, but changing an ID can disconnect its existing note.
- `number` must be a positive whole number and controls display order.
- `title` must be a quoted string and may be empty.
- A block with an empty `modules` array does not produce a visible module-note location.

After saving the profile and reopening AuthoritySearch, every configured module appears automatically as an initially empty note. Week/day notes from W1D1 through W6D5 are always available and require no configuration.

## Updating an installed copy

Preserve the workstation's `AuthoritySearch-Profile.js` when updating the application, because it may contain progress, notes, or controlled block/module titles. Replace only the application or corpus files that actually changed.

Do not upload a work-environment profile containing controlled or sensitive material back to this repository.

## Source boundary

AuthoritySearch is a study aid, not legal advice. Displayed facts are tied to individual approved-source records. Users should consult the current official source when currency or exact legal language matters.
