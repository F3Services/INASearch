# Luna USC/INA notes audit — cycle 11

Status: **findings recorded; not clean**. The occurrence-level log contains 41 suspect reference rows. No parser, corpus, product source, or generated HTML file was changed.

## Scope and reproducibility

- Artifact: `/Users/dave/Documents/HD QuickLookup/INASearch-Uncompressed.html`
- Artifact SHA-256: `b32f5b690ac059222ddc40dc8874ac3dd3db6b7a8aad0215bd25b5291638e8d2`
- Frozen inventory: `/tmp/inasearch-inline-final.ZMZVQN/uncompressed/usc-notes.jsonl`
- Frozen inventory SHA-256: `b6b9de9c2332f05dd544f6e430a6e65ec56c2df528cedef9413fd4c6fc615c93`
- Independent regeneration: `/tmp/usc-notes-cycle11.INxtcQ/usc-notes.jsonl`
- Regenerated inventory SHA-256: `b6b9de9c2332f05dd544f6e430a6e65ec56c2df528cedef9413fd4c6fc615c93` (byte-for-byte equal to frozen inventory)

I parsed the artifact directly with the repository's audit reader, walked every Title 8 section and every USC-notes text, source-credit, and heading field, and independently reran `enumerateInlineReferences`/the target resolver. `cmp` returned exit 0 between the regenerated and frozen JSONL files; the regenerated SHA-256 is exactly the frozen SHA-256. Every logged offset/text pair below was then checked against the source field and its surrounding statutory context.

## Exhaustive inventory counts

| USC-notes field | references | parenthetical candidates | candidates linked | candidates unlinked |
| --- | ---: | ---: | ---: | ---: |
| text | 15,656 | 17,290 | 7,862 | 9,428 |
| sourceCredit | 2,901 | 1,363 | 1,003 | 360 |
| heading | 15 | 9 | 9 | 0 |
| **total** | **18,572** | **18,662** | **8,874** | **9,788** |

Reference resolutions are local USC 4,804; official-only USC 1,044; official-only Public Law 8,929; official-only Statutes at Large 3,567; official-only Federal Register 224; official-only unknown named-act 3; and local CFR 1. The candidate inventory has no partial or structural coverage state: 8,874 are linked and 9,788 are unlinked.

The unlinked candidates were reviewed as candidate sequences against their exact source context. They are principally amendment subsection labels, source-credit labels, dates/statute annotations, quoted statutory labels, or ambiguous parentheticals. The five `8-1252-note-9` amendment-label occurrences logged below are exceptions because the surrounding Public Law section makes their authority unambiguous. No additional high-confidence candidate-only omission was found after accounting for the logged reference rows.

House editorial-footnote fields are included in the counts (4 references and 25 candidates). Their labels and annotation prose were not escalated merely for being unlinked. Likewise, 976 old Act/date/chapter citations are represented with the serializer identity `public-law:undefined-undefined/<date>/ch...`; each has an exact date/chapter/title path but the source supplies no Public Law number. These were classified as anonymous historical-act authorities, not occurrence-level false positives; the representation caveat should be handled separately from citation adjudication.

## Findings

The complete occurrence-level log is [`luna-audit-usc-notes-cycle11-flags.tsv`](luna-audit-usc-notes-cycle11-flags.tsv).

The findings comprise:

- two local resolutions for repealed historical section 1487;
- former INA/USC resolution errors in former 1105a, former 1182(c)/1182(h)/1182(i), former 1254, former 1255, and historical 1254a/1401/1153/1101 versions;
- seven former INA §241 references incorrectly projected to current §1231 instead of former §1251;
- six former §212(a) references incorrectly inferred under current §1101 instead of former §1182;
- four note-locator references to “former section 1255a” incorrectly resolved locally; and
- five quoted Public Law 101–649 §545 subsection labels incorrectly projected into current USC §1252 paths.

For the historical citations, the proposed target preserves the authority identity and marks it `official-source-only`; historical Public Law/Statutes-at-Large and former INA codifications are not projected into current local paths. The two former-§241 clusters are path errors as well as resolution errors. The full text, source path, offset, current target, proposed target, verdict, and rationale are in the TSV.

## Classification rules applied

I accepted current local targets when the source clearly cited the current codification, even if nearby prose mentioned amendments, former provisions, dates, or another authority. I did not flag ordinary prose, abbreviations, dates, source annotations, self-references, ambiguous standalone parentheticals, or valid current-section links in historical notes. I flagged only an occurrence whose bracketed parallel citation, explicit “former”/“as in effect before” qualifier, historical note locator, or unambiguous Public Law container proved that the emitted target identity or local/official resolution was wrong.
