# Published immigration-decision source corpus

This subsystem builds an auditable, local case-law index without changing the INASearch application. It includes only decisions that an authoritative publisher makes precedential or binding:

- the EOIR electronic *Administrative Decisions Under Immigration and Nationality Laws* volumes 8 through the current volume, cross-checked and gap-filled from EOIR's official alphabetical listings (published BIA, Attorney General, AAO, Commissioner, and related deciding bodies); and
- USCIS's current and prior **adopted** AAO decisions.

Ordinary AAO non-precedent decisions and unpublished BIA decisions are intentionally excluded. EOIR's current first-party electronic case index starts at volume 8. Volumes 1–7 are therefore recorded as a source gap rather than silently filled from an unofficial mirror. EOIR's cumulative topical indexes through volume 27 are retained under `supporting/`; volumes 1–15 require OCR and volumes 16–27 have native text. They help validate historical citations and subject associations but are not case opinions.

Three cases that EOIR still lists have broken first-party PDF links on every applicable live/archive catalog checked: *Pizarro*, 12 I&N Dec. 537 (ID 1817); *Reyes*, 13 I&N Dec. 406 (ID 2009); and *Lee*, 16 I&N Dec. 305 (ID 2606). They remain explicit metadata-only records with `sourceAvailability: publisher-pdf-link-404`; strict completeness requires all 3,317 publisher-available PDFs and does not silently replace these three with an unofficial text.

See `FEASIBILITY-STUDY.md` for the source/status conclusions, `supporting/manifest.json` for the checksummed EOIR cumulative indexes and formal affected-decisions notice, and `archival-source-candidates.json` for the separately labeled public-domain GPO scan routes being evaluated for volumes 1–7 and the volume 15 historical treatment table.

## Reproducible layers

1. `manifest.jsonl` and `discovery.json` capture case-level metadata, publisher headnotes/status statements, publisher-page checksums, and authoritative PDF URLs.
2. `raw/` contains immutable downloaded PDFs. `capture.jsonl` records final URLs, byte counts, response metadata, and SHA-256 checksums.
3. `derived/` contains a lossless source-aware JSON record and an LLM-friendly Markdown document per case. Every page has an explicit marker; native text and imported OCR remain separate layers.
4. `index/published-cases.sqlite3` contains normalized cases, pages, legal citations, explicit case-treatment edges, and full-text search. A metadata-first build includes every manifest case and analyzes its official publisher headnotes even while PDF capture is still underway; records gain page text as it becomes available. `legal-citations.jsonl` is the portable RAG/export form.

Large reproducible layers are ignored by Git. The source manifest and these instructions are versioned.

## Commands

Use the workspace Python runtime when the system Python does not have `pypdf`:

```sh
python3 tools/case-index.py discover
python3 tools/case-index.py download --id 4233
python3 tools/case-index.py download --collection uscis-adopted-aao
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py extract --id 4233
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py extract --available
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py watch
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py index --id 4233
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py index
python3 tools/case-index.py status "25 I&N Dec. 771"
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py supporting
python3 tools/case-index.py audit
```

`discover` and `download` default to a 10-second per-host delay to follow the Justice Department's published crawl guidance. All capture steps are resumable and verify existing files before skipping them.

Running `index` without case IDs builds the all-case catalog immediately. Cases whose PDFs have not yet been extracted are explicitly stored as metadata-only (`page_count = 0` and an empty source checksum); they are not mistaken for complete full-text records. `index/build-summary.json` reports both full-text and metadata-only counts.

While a complete download is still running, `extract --available` processes the current atomic capture ledger and skips PDFs that have not arrived yet. Re-running it is safe: unchanged derived documents are checksum-validated and reused.

Derived documents also record a fingerprint of the citation parser and the exact INASearch INA/USC/CFR hierarchy inputs. A parser or hierarchy change automatically reanalyzes stale documents while preserving their native and imported OCR text layers.

For an unattended local run, launch `watch` alongside `download`. It polls no more often than every 30 seconds, extracts only new or stale captures, and builds the complete SQLite index once every manifest PDF is present. It exits with an actionable error after 30 minutes without progress, rather than waiting forever after a failed downloader.

For a complete run:

```sh
python3 tools/case-index.py discover
/Users/dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 tools/case-index.py pipeline
```

The complete PDF capture is intentionally slow. Do not reduce the delay for `justice.gov` without reviewing its current robots policy.

`audit` verifies uniqueness and source domains, raw-PDF checksums, supporting-artifact checksums, derived-source checksums, citation offsets, printed reporter-page checks, and SQLite integrity. Add `--strict` to require complete capture and extraction of every publisher-available PDF, metadata indexing of every manifest record, full-text indexing of all publisher-available cases, and the versioned supporting artifacts. Verified broken publisher links remain named warnings, not concealed missing files.

`supporting` parses three deliberately separate evidence sources. The checksummed BIA Precedent Chart snapshot becomes occurrence-level topic, headnote, authority, and treatment evidence with the publisher disclaimer and secondary evidence tier intact. The formal volume 25 affected-decisions notice becomes coded, pinpoint-level official reporter editorial evidence. The native-text cumulative topical indexes for volumes 16-27 become official subject/detail links resolved by interim-decision ID; the image-only volumes 1-15 remain queued for OCR. All outputs retain printed text, anomalies, and repairs. The versioned `chart-summary.json`, `affected-decisions-summary.json`, and `topical-index-summary.json` describe the reproducible ignored JSONL outputs.

## Citation and status semantics

The parser resolves written INA, U.S. Code, and CFR addresses against the canonical unit hierarchy already shipped with INASearch. OCR-confusable characters are changed only inside a candidate citation, and only when the result names a real canonical unit. The stored record includes original text, normalized target, every repair, competing alternatives, confidence, page, offsets, and evidence.

Explicit treatment phrases such as *overruled*, *modified*, *clarified*, *distinguished*, and *superseded* become directed case-to-case edges. They do **not** produce an undifferentiated “bad law” flag: later treatment can be limited to one issue, effective date, or jurisdiction. Publisher-supplied USCIS status statements are stored separately from treatment inferred from later cases.

EOIR reporter treatment codes remain in a third, separate evidence table. Their status signal says that a negative official-reporter treatment was found and requires scope review. The captured table stops at volume 25, points to the volume 15 cumulative table for older history, and—according to USCIS adjudicator guidance—does not update itself when a statute or regulation renders older case law moot.

The applicability score is a triage aid. Publisher headnotes and sentences with holding-language are `holding-candidate`; other occurrences are `discussed`. A human or later legal-analysis model must review the evidence before INASearch displays a claim that a case controls a specific rule.
