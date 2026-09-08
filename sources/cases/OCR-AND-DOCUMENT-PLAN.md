# OCR and document-representation plan

Research snapshot: 2026-08-29. Model revisions and container digests must be pinned when the GPU worker is built; model names alone are not reproducible.

## Representation contract

The authoritative PDF is always retained with its SHA-256. Each derived case has:

- page-aligned native text and quality diagnostics;
- zero or more immutable page-aligned `ocrLayers[]`, with engine/model revision, container digest, source/image hashes, preprocessing transforms, prompt/schema hashes, coordinates, stop/truncation/error/runtime, and confidence evidence;
- one explicitly selected text layer, without deleting alternatives;
- exact citations with source spans, written text, canonical target, repairs, alternatives, and evidence;
- explicit case-treatment edges with the sentence that states the treatment; and
- publisher metadata/headnotes kept distinct from decision text.

Canonical JSON is the lossless interchange. Markdown with frontmatter and `<!-- page: N -->` markers is the LLM-readable form. SQLite FTS5 is the interactive index. Page/chunk JSONL is the RAG/export form. Plain, unpaginated `.txt` is not a canonical artifact because it destroys provenance and makes OCR correction difficult to audit.

## Recommended RTX 5090 stack

The RTX 5090 has 32 GB VRAM and is Blackwell/SM 12.0. Use Linux plus current NVIDIA Container Toolkit and model-publisher containers or a current CUDA 13 PyTorch/vLLM stack. Early CUDA 12.x and generic vLLM wheels had Blackwell kernel gaps; pin and test the exact environment rather than treating “supports CUDA” as sufficient.

Run a staged ensemble:

1. Extract native PDF text first. Good born-digital pages should bypass generative OCR.
2. Render only weak pages at 300 DPI, preserving the page number and PDF checksum.
3. Use **ATH-MaaS/OvisOCR2** as the first benchmark candidate. As of this snapshot it is a trending 0.9B Apache-2.0 page parser, emits natural-reading-order Markdown, and has official vLLM 0.22.1 instructions. Its small size makes batched 5090 inference practical.
4. Use **zai-org/GLM-OCR** as an independent verifier for low-confidence or citation-disagreement pages. It is a 0.9B MIT model with an official layout-analysis SDK and claimed 1.86 PDF pages/second in the publisher's benchmark.
5. Keep **PaddlePaddle/PaddleOCR-VL** as a mature structured-output baseline. Its official pipeline emits both JSON and Markdown, although its plain Transformers path is element-level rather than the complete page parser.
6. Use **nvidia/nemotron-ocr-v2** as a non-generative text/layout cross-check on citation-heavy regions. Its detector/recognizer/relational architecture provides a useful independent failure mode.
7. Evaluate **baidu/Unlimited-OCR** experimentally for multi-page context. It is a 3B MIT long-horizon parser with PDF/multi-page support and a publisher vLLM container, but cross-page generation should not become authoritative until omission and hallucination rates are measured on this corpus.

Primary model cards:

- https://huggingface.co/ATH-MaaS/OvisOCR2
- https://huggingface.co/zai-org/GLM-OCR
- https://huggingface.co/PaddlePaddle/PaddleOCR-VL
- https://huggingface.co/nvidia/nemotron-ocr-v2
- https://huggingface.co/baidu/Unlimited-OCR

General-purpose vision-language models should be reserved for semantic extraction after transcription. They are not the source-of-truth OCR layer.

EOIR's two supporting cumulative topical indexes for volumes 1-15 are a separate all-page OCR job: they have no native text layer, so all 74 pages must be rendered. Use a transcription prompt that preserves indentation, topic headings, cross-references, and reporter citations. The later indexes for volumes 16-27 already have native text and serve as the parser/format baseline. Store supporting extraction beside `supporting/manifest.json`, then parse each historical `volume-page` token (for example `12—369`) or later interim-decision token (for example `#3767`) and deduplicate repeated topical entries by case identity. Index-derived topics remain supporting evidence and must never be represented as language from an opinion.

## Benchmark before bulk OCR

Create a 200-page stratified gold set: born-digital pages, early faint scans, skewed pages, stamps, footnotes, multi-column pages, and pages dense with INA/USC/CFR or I&N citations. Double-key the legal citations and treatment phrases.

Measure:

- character and word error rate;
- exact legal-citation accuracy, including every parenthetical unit;
- exact I&N case-citation and treatment-word accuracy;
- text omission and hallucinated-token rates;
- reading-order and footnote attachment accuracy;
- page throughput, peak VRAM, retries, and truncations.

Choose the production route on legal-token accuracy and omission rate, not a general document benchmark. Send disagreements through deterministic canonical-unit validation. If two canonical repairs remain possible, keep the citation unresolved for review.

## Worker output and review gate

The GPU worker emits JSONL, one immutable object per engine/model/page attempt. Schema v2 requires a pinned model revision and container digest, the exact source-PDF and rendered-image hashes, every preprocessing transform and its inverse, a rendered-page coordinate space with optional block/word boxes, the prompt and output-contract hashes, stop/truncation/error state, and runtime. A compact example is:

```json
{"schemaVersion":2,"caseId":"eoir-939","pageNumber":4,"status":"succeeded","text":"...","engine":{"name":"vllm","version":"<pinned>"},"model":{"name":"ATH-MaaS/OvisOCR2","revision":"<commit>"},"containerDigest":"sha256:<digest>","sourcePdfSha256":"<digest>","imageSha256":"<digest>","render":{"dpi":300,"width":2550,"height":3300},"preprocessing":{"transforms":[{"operation":"pdf-render","forwardMatrix":[1,0,0,0,1,0,0,0,1],"inverseMatrix":[1,0,0,0,1,0,0,0,1]}]},"promptSha256":"<digest>","outputSchemaSha256":"<digest>","layout":{"coordinateSpace":{"name":"rendered-page","unit":"pixel","origin":"top-left","width":2550,"height":3300},"blocks":[],"words":[]},"termination":{"stopReason":"stop","truncated":false},"runtime":{"milliseconds":1234},"errors":[]}
```

Importing validates and stores alternatives but deliberately does **not** select them, even on a page whose native extraction was flagged. Selection is a separate, audited action:

```sh
python3 tools/case-ocr-worker.py eoir-939 --engine-version <version> --model-revision <commit> --container-digest sha256:<digest>
python3 tools/case-index.py import-ocr eoir-939 sources/cases/ocr-output/eoir-939.jsonl
python3 tools/case-ocr-adjudicate.py eoir-939 4 select --layer-id <layer-id> --reviewer <reviewer> --reason <review-notes>
```

By default the endpoint worker only calls loopback. Supplying a remote endpoint requires `--allow-remote`, and bearer credentials are read from a file rather than command-line text. HTTP is optional: `case-ocr-smoke-bundle.py`, the generated severe-first queue, and the schema-v2 result envelopes are transport-neutral filesystem artifacts suitable for an SSH/Tailscale queue. `case-ocr-validate-results.py` validates returned envelopes against exported jobs before import.

Hermes returns one `inasearch-ocr-result/v1` envelope containing a separate
layer for every requested engine. Convert that envelope to the immutable local
row contract before using the ordinary validator/importer:

```sh
python3 tools/case-ocr-convert-hermes.py \
  sources/cases/index/ocr-smoke-bundle/manifest.jsonl \
  /path/to/hermes-results.jsonl \
  /path/to/local-ocr-results.jsonl \
  --require-all-jobs
python3 tools/case-ocr-validate-results.py \
  sources/cases/index/ocr-smoke-bundle/manifest.jsonl \
  /path/to/local-ocr-results.jsonl \
  --require-all-jobs
```

The bridge verifies the embedded job and source/image hashes against the local
manifest, preserves worker/CUDA/container and per-engine provenance, and
retains failed or truncated partial layers as non-selectable evidence. It does
not select or import any text. For an importable single-case result, run
`case-index.py import-ocr CASE_ID LOCAL_RESULTS.jsonl`; multi-case benchmark
output should remain a validation artifact or be split by `caseId` before
case-by-case import. Supporting-index pages are parsed through their separate
supporting-evidence workflow rather than inserted as case-opinion text.

Re-run `index` after import. Citation analysis is regenerated from the selected page layer.
