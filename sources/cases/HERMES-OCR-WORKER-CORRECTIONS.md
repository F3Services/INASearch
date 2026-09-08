# INASearch OCR worker production corrections

Continue the existing `/home/dave/inasearch-ocr-worker` setup. Inspect the current git tree, engine lock, smoke results, and running processes before changing anything. Preserve all useful work and make new commits. The user's Qwen/SGLang service is intentionally stopped so this worker may use the full RTX 5090; do not restart Qwen while OCR work is active.

## Coordinate with the older bootstrap turn first

At handoff time an older Hermes one-shot bootstrap turn was still present as PID `3537973` and had launched queue job `smoke-all-engines-v1`. Its supposed CPU fallback did not propagate `executionDevice` into `INASEARCH_OCR_DEVICE`, so `bin/engine_paddleocr_vl.py` defaulted to `gpu:0` and began repeating the same obsolete native decode. Before editing:

1. Re-identify these processes and verify they are still exactly the INASearch bootstrap/synthetic smoke, rather than trusting stale PIDs.
2. Stop only the obsolete `smoke-all-engines-v1` child cleanly. Repair/recover its queue state without overwriting any prior result.
3. Give the older bootstrap turn a short opportunity to observe the stopped child, commit/report, and exit.
4. If the older bootstrap turn remains active and would conflict with this correction task, stop that verified older INASearch one-shot cleanly after preserving its committed worker tree. Do not touch the user's separate long-running interactive Hermes REPL or Hermes gateway.
5. Confirm no worker/editor process is still modifying the tree before continuing.

The initial direct PaddleOCR-VL 1.6 smoke exposed a production blocker: the model loaded successfully on CUDA 12.9/SM120 but the native dynamic autoregressive path spent about ten minutes CPU-bound/GPU-idle on the synthetic page. This was inference, not download or compilation. Do not use or repeat that native path for the corpus.

## PaddleOCR-VL production backend

Use Paddle's official RTX-50/SM120 Blackwell vLLM-server architecture and pin the image by immutable manifest digest. Re-resolve/verify the digest yourself from the official source before use; the coordinating audit observed these official manifests on 2026-08-30:

- online image: `ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddleocr-genai-vllm-server@sha256:073bd0cf36400d1f7fcb0bd028289a1ccbf2820772ecb023a4cc13219104399c`
- offline image: same repository at `sha256:bffd525308facf5dba2f8eca44ab476704a0ae3bfdcba25f77655973e4c0a7ca`

Mount the pinned local model directory read-only and bind only to loopback. Use the official server flags:

- `--model_name PaddleOCR-VL-1.6-0.9B`
- `--model_dir /mounted/PaddleOCR-VL-1.6`
- loopback `127.0.0.1:8118`

Configure the client with:

- `vl_rec_backend="vllm-server"`
- `vl_rec_server_url="http://127.0.0.1:8118/v1"`
- `vl_rec_api_model_name="PaddleOCR-VL-1.6-0.9B"`
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`

Keep Hugging Face/Transformers/Paddle offline variables active and use the cached revision `c5630abae1d940eafe0697512a0325494b02ab42` rather than downloading at job time. Verify and record the actual model-weight hashes and the pulled image repo digest.

Paddle's packaged vLLM client may discard `finish_reason` and token usage. Do not claim `stopReason="complete"` or `truncated=false` unless you instrument the response collector to retain a finish reason and output/max-token counts for every crop. Otherwise represent completion/truncation as unknown explicitly in a schema-valid, reviewable way. Preserve raw per-crop responses or hashes/evidence needed to audit this.

## Warm, batched engine scheduling

The current worker starts a fresh subprocess/model for each page. Replace that production behavior with persistent local engine services or engine-pass batching. Model load may happen once per worker/pass, not once per page. The queue may still preserve one atomic result envelope per page.

Recommended pass order:

1. PP-OCRv6 on all selected pages for structured lines/token-glyph boxes and native recognition confidence.
2. PaddleOCR-VL 1.6 for document/layout transcription.
3. OvisOCR2 as the independent benchmark/adjudication layer until measured accuracy justifies a broader pass.

All local services must bind only to loopback. No document data may leave the desktop.

## OvisOCR2 corrections

- Keep the official vLLM 0.22.1 runtime and pinned model revision.
- The GPU is exclusive now, so use the model-card `gpu_memory_utilization=0.8` unless measured evidence requires a lower value.
- Keep the engine warm or batch multiple jobs per load.
- Retain `finish_reason`, output token count, and the configured maximum token count.
- Implement the publisher's repeated-tail detection/cleanup in an auditable manner: retain raw output, record whether cleanup was applied, and never hide truncation.
- Ovis visual-region coordinates are useful, but do not invent word coordinates or confidence.
- Record the official vLLM wheel release URL and checksum, not a machine-specific package path.

## PP-OCRv6 corrections

- Preserve line polygons, boxes, text, and native recognition scores.
- Describe `text_word` output as native token/glyph boxes, because it is not consistently linguistic words.
- Do not invent token-level confidence; link tokens to the containing line's native confidence separately.
- Keep the detector/recognizer warm or batch page processing.

## Provenance/schema corrections

Do not rely on one worker-level `containerDigest` to describe mixed runtimes. Record per layer:

- backend/runtime type and version;
- container repo digest, or a deterministic virtual-environment lock digest when no container is used;
- engine/model revision and model-weight hash;
- backend-config hash and prompt/template hash;
- input image hash and embedded source PDF hash;
- CUDA runtime, cuDNN/Paddle/Torch/vLLM versions, NVIDIA driver, and worker git commit;
- runtime, stop/finish reason, output/max-token counts where applicable, truncation-known state, warnings, and error.

Extend the schema compatibly if necessary and add rejection tests for missing or falsely asserted provenance. The Mac-side converter will be updated to accept the corrected envelope; never drop an engine layer and never select canonical OCR on the worker.

Populate `env/engine-lock.json` with exact ready/blocked status and immutable pins. Add environment and schema tests, bad-hash rejection, duplicate/no-overwrite tests, service health, and one true model-level smoke result per ready engine.

## Run the transferred benchmark only when ready

Sixteen two-file job directories are already present under:

`/home/dave/inasearch-ocr-worker/inbox/drop`

Validate and enqueue them only after the corrected services and engine lock are ready. Run all three requested layers. Return exact commands, job counts, per-engine cold/warm timing, failures, output paths, result/schema hashes, and redacted health output. Do not process the 50-page severe batch until the 16-page smoke results pass schema validation and a basic output-quality review.

Also provide the exact command to restore the prior Qwen/SGLang workload later, but do not restore it while this OCR benchmark/batch is active.
