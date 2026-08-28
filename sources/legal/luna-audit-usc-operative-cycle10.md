# Cycle 10 independent audit of operative USC/INA inline references

Audit date: 2026-08-25. Scope is every generated reference and parenthetical candidate in the operative Title 8/INA fields of the current standalone artifact. USC notes, CFR records outside the operative Title 8 walk, and product/parser/corpus changes were out of scope. No parser, corpus, product code, or generated HTML was modified.

## Artifact and reproducibility

Artifact: `INASearch-Uncompressed.html`; bytes: 35122847; SHA-256: `21684f061e7d99baa88bf7258adc4401857c4330bef19845590d89895675d9df`; schema: 5; corpus version: `2026.08.21-audit.2`.

The frozen inventory supplied for this audit was `/tmp/inasearch-inline-audit-cycle10.Y4fWyF/usc-operative.jsonl`. I independently loaded the embedded manifest/payload, hydrated the packed references, recursively walked every Title 8 section heading, preamble, and body heading/text field, round-tripped every generated span against its field text, and independently classified every parenthetical sequence. The exact independent inventory was then compared line-for-line with the frozen JSONL; all 10290 rows matched in order and content.

The reproducible command was:

```text
node tools/audit-inline-references.js INASearch-Uncompressed.html /tmp/inasearch-inline-audit-cycle10-independent
```

Coverage was 376 Title 8 sections and 9373 operative fields (3137 headings, 81 preambles, and 6155 body-text fields). The inventory contains 5,283 `kind=reference` rows and 5,007 parser-independent parenthetical candidates: 4,471 linked, 0 partial, 263 structural, and 273 unlinked. Every reference and candidate row was examined in its exact source field and surrounding statutory context.

The artifact contains 262 run-in paths across 51 sections; each was checked to distinguish a structural run-in label from an operative cross-reference.

Reference families were {"cfr":1,"public-law":135,"statutes-at-large":97,"unknown":1,"usc":5049}; resolution was {"local":4548,"official-source-only":735}. The one CFR-family row is retained in the inventory because it occurs inside an operative Title 8 field; it is recorded as an external official-source-only finding where appropriate. Run-in markers were checked as structural context rather than silently treated as citations.

## Findings

I found 16 incorrect/invalid generated targets and 219 high-confidence missing links, for 235 flags. The existing generated target is preserved verbatim in the TSV; proposed targets identify the authority, section, nested path, and whether the path is local or official-source-only. The missing-link pass follows the supplied heuristic: adjacent parentheticals that form valid citation units are findings, while run-in labels, ordinary prose (including “fiancé(e)”), self-references, and non-unique source fragments are not.

The unlinked candidates not flagged (54) were classified as structural run-in labels, ordinary prose/word fragments, current-unit self-references, or ambiguous source text whose authority cannot be determined without inventing a target. No partial candidate occurred. The flags TSV is the complete finding list and has the required header.

Notable target errors include inherited-container misresolution in §§1157(c)(3), 1160(c)(2)(B)(ii), 1225(c), 1254a(c), and 1255a(d); two §1612(a)(2) references incorrectly resolved to §1101(A); the nonexistent current §1153(a)(2)(A)(iii) node; and the lowercase statutory `(u)` path in the §1367(d) parallel citation. Historical Act/Public Law headings and nested continuation citations are recorded as missing links rather than dismissed as formatting.

## Deliverables

- `/Users/dave/Documents/HD QuickLookup/sources/legal/luna-audit-usc-operative-cycle10-flags.tsv` — 235 TSV findings.
- This report — method, independent coverage proof, totals, and classification boundaries.
