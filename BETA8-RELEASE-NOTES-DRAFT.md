# INASearch Beta8

Beta8 makes finding, comparing, and copying the law easier, and adds historical text for repealed and transferred INA sections.

## What’s new

- **Historical INA text:** Read and search 14 former INA sections, including INA 242B and 321. Each shows its historical version, official sources, and repeal or transfer warning.
- **More precise searches:** Combine `in:` and `cites:` in the same search field. Search within a citation or range, find provisions that cite another provision, and narrow the results with words. Use `in:notes` for personal notes or `in:annotations` for source annotations.
- **Search your highlights:** Use `in:highlights` to search provisions containing a saved highlight, or `in:highlights-exact` to search only the highlighted words. Your saved colors appear in search results.
- **Easier browsing:** Home shows the INA or Title 8 index above the CFR index, with separate Expand All and Collapse All controls. Clearer headings, CFR topic groups, and status labels make the lists easier to follow.
- **Better copying:** Copy controls are always visible in a fixed column beside the reader, offering citation, text, or both with a customizable preface. Previously, the citation-unit menu was hidden until you clicked a citation unit. The INA/U.S.C. switch chooses the copied wording. Hover over a text-copy button to preview its target; moving away restores your reading position.
- **Preview shared links:** Hover over Share to see the destination before copying its link, including both panes in a split view. Moving away or pressing Escape returns you to where you were reading.
- **Simpler help:** All tips are available by category in About. The progress-tracked Quick Start tutorial has been removed.

## What’s fixed

- Fixed citation jumps that could stop at the wrong position when a new citation was entered during scrolling, especially when the direction changed.
- Corrected statutory section highlighting so selecting a parent unit includes its child units. Also corrected clause addresses in INA 210.
- Fixed an edge case when looking up citations in lettered sections. Mixed notation such as `274(a)2b` now correctly resolves to INA 274(a)(2)(B).
- Corrected CFR paragraph structure and selection outlines so navigation, copying, highlights, and inserted excerpts target the right unit.
- Corrected more citation links, including CFR subpart references and references in historical INA text that could open the wrong modern provision.
- Improved citation display in search results and when switching views, preserving search marks, saved highlights, and reading positions. With Follow View Setting, converted INA references appear in INA view; U.S.C. view retains the original source wording in searches. Yellow highlighting now applies only to converted INA citations.
- Made the navigation bar easier to collapse, combined scrolling and citation-jump offsets in one setting, and clarified history and copy controls in side-by-side readers.
- Improved Back and Forward after scrolling, and kept temporary copy and share previews out of navigation history.
- Fixed copy labels that wrapped or extended past their backgrounds, including in Firefox, and stopped the share-preview frame from shifting the page.
- Made backup reminders appear at startup when existing work needs protection, including customized settings, instead of interrupting a fresh session after its first edits.
- Strengthened automatic CFR update checks so an invalid update leaves the previous text in place.
- Reduced download sizes and sped up text searches.
- Clarified the defined-term warning so a highlighted word is not mistaken for a definition that applies in that context.

## Search example

Type `in:237 cites:212` to find references to INA 212 within INA 237. Add words to narrow the results, or use Common to choose how broadly terms can match within a provision.

## When updating

Older saved highlight queries and shared links are converted to the new syntax. For new searches, use `in:notes` to list notes and `in:highlights-exact` for exact highlighted text; the old `is:` syntax has been removed.

Saved-data import now accepts current JSON backups and `INASearch_Data.json`. Older HTML and profile JavaScript imports are no longer supported.

Existing citation-display preferences switch to Follow View Setting once after updating. You can choose Always or Never in Settings, and that choice is retained.

## Changes in action

**Historical INA text:** INA 321 now includes the former statutory text, its official source, and a prominent repeal warning.

![Historical INA 321 with its repeal warning and source](https://github.com/F3Services/INASearch/releases/download/Beta8/beta8-historical-ina.png)

**Home index — before and after:** The CFR index appears below the INA, with its own Expand All and Collapse All controls.

![Beta7 and Beta8 Home index comparison](https://github.com/F3Services/INASearch/releases/download/Beta8/beta8-home-before-after.png)

**Copy controls — before and after, close-up:** The two side-by-side Beta7 views show the menu hidden by default, then revealed by clicking the citation unit. In Beta8, the copy controls are always available on the side of the reader.

![Two Beta7 close-ups show the hidden menu and the menu opened by clicking a citation unit; Beta8 shows always-visible copy controls beside the reader](https://github.com/F3Services/INASearch/releases/download/Beta8/beta8-copy-before-after.png?v=03116e5d9848)

**Search citations — before and after, close-up:** These are the same two matches in INA 212(j) for “this title.” With Follow View Setting, Beta8 displays the converted INA references when the view mode is INA, preserving the search marks. Switch to U.S.C. view to see the original wording in search results, as the final close-up shows.

![Beta7 search results compared with Beta8 in INA view, followed by Beta8 in U.S.C. view showing the original wording](https://github.com/F3Services/INASearch/releases/download/Beta8/beta8-search-citations-before-after.png?v=cab79832ae18)

## Downloads

- **INASearch.html** — download this file for everyday use.
- **INASearch-Uncompressed.html** — the same app with its included data stored in a more inspectable format.

Download either file and open it in Chrome or Edge. Both include the legal text for offline use.

### SHA-256 checksums

- `INASearch.html`: `6ca7ddcccfaa1175115524924adc68b45ef14d32609f510afb347bba38961c2e`
- `INASearch-Uncompressed.html`: `5149eb3e82d79c39cfe44956da0bb9c9963f696c0a11bc4e9447135d9aa24f79`
