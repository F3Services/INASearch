# Corrected recovery: immutable run-1 identities, recovery-suffixed run 2

Resume after the interrupted recovery prompt. No action from that prompt was taken; the tree remains clean, OCR is inactive, GPU is empty, and Qwen is stopped.

Important correction: **do not reuse the 16 original job IDs and do not move old evidence aside merely to evade queue collision checks.** The worker deliberately treats a job ID/input pair as immutable across results, accepted inputs, queue states, and attempts. Preserve that invariant.

Keep the first run and all its canonical IDs/results/attempts/accepted inputs immutable and non-counting as a complete 16-page run:

`tmp/batch/ocr-smoke-16x3-0ada88f-20260831T035103Z`

Qwen stays stopped; the severe 50 stays untouched. Stop on an infrastructure, provenance, service-ownership, or capture failure.

## 1. Controlled Ovis diagnostic on preserved inputs

Using current commit `0ada88f0ccdad67c0c10a9ad0517e8369154555d`, run a uniquely named, non-queue, non-canonical direct Ovis diagnostic on the three repeated-tail pages plus one clean control:

- `ocr-smoke-2c70de2299b0b50f7d2792384dfa3f53` (eoir-2822 p.4)
- `ocr-smoke-56f321a556a574b46797df95fee63881` (eoir-3147 p.1)
- `ocr-smoke-5b06e18c28ce481c41ec29637d440ea2` (eoir-3044 p.5)
- one prior clean page

Invoke the existing Ovis adapter with `--chunk-size 1`, while leaving max tokens 16,384 and every other pinned setting unchanged. Run in a fresh transient unit with capture-v2. Do not publish into `results/` or alter queue state. Preserve raw and cleaned text, finish/stop reasons, token counts, cleanup metadata, hashes, OCR comparisons, and capture evidence.

- If all three prior loops now genuinely finish with `stop`/EOS and are non-truncated, change and lock tracked Ovis `batchChunkSize` plus adapter default to 1.
- If any still loops, do not increase the cap, invent EOS, or mark it complete. Retain truthful `finishReason:length`, truncation/error, raw evidence, and cleaned recovery text as a benchmark outcome.

Any effective chunk-size override included in run 2 must be explicit in tracked backend configuration, adapter behavior, hashes, tests, and per-layer audit/provenance; a diagnostic override alone is not production provenance.

## 2. Remote polygon contract fix

PaddleOCR-VL faithfully returned native block contours with 5, 7, and 10 vertices for eoir-2493. Preserve every point and its order; do not reduce to a rectangle.

Refactor the result schema so block `polygon` uses a bounded native-polygon definition accepting 3..4096 `[x,y]` points, while line geometry may continue to use a separate exact-four-point quadrilateral definition. Retain numeric/finite/in-bounds semantic validation. Clockwise and counter-clockwise order are both valid; only the existing `[x0,y0,x1,y1]` box has a reversed-order concept.

Add tests for 3/5/10-point block preservation, too few and over-cap points, malformed arity/types, non-finite and out-of-bounds points, and non-four-point line rejection. Add a regression fixture containing the exact failed eoir-2493 native polygons and prove strict geometry/schema validation accepts them without discarding or reordering points. The Mac corrected bridge is being fixed in parallel; do not claim it was already compatible.

## 3. New clean commit and service-owned acceptance

Apply only diagnostic-supported Ovis changes plus the polygon contract fix. Update locks/config/tests, regenerate `env/environment-manifest.json` last, run the full suite/runtime verification/compile/diff/schema/provenance/unit checks, install a byte-identical user unit, commit, and require a clean tree. Report full commit and executor SHA-256. Run a fresh uniquely named service-owned acceptance at the exact new commit with singleton, capture-v2, provenance, cache, and telemetry gates. Do not proceed if it fails.

## 4. Preserve old queue evidence without reusing identities

Leave the 10 old completed records/results, old failed record/attempt, and all 16 old accepted input directories in place. The five stale run-1 `queue/running` records must not be auto-reconciled into a new pass. Before starting a daemon, copy them and their hashes into a checksummed read-only run-1 preservation/supersession directory, then move only those five live running records out of the active queue into that evidence area with an explicit ledger saying they were stranded by run 1 and superseded by recovery IDs. Do not reuse their old IDs.

## 5. Recovery-suffixed run 2 for all 16

Create a new deterministic job-ID mapping and manifest for all 16, using IDs such as:

`<original-job-id>-r2-<short-new-worker-commit>`

Keep case ID, page number, source PDF hash, image hash, image bytes, preprocessing, and requested engine set identical to the original. Preserve `job-id-map.json`, a recovery manifest, transfer/identity checksums, and input construction audit. Copy from the immutable accepted inputs; do not modify them.

Enqueue and run all 16 recovery IDs uniformly at the new commit in PP-OCRv6 -> PaddleOCR-VL 1.6 -> OvisOCR2 order, with capture-v2 attached to Ovis. Do not auto-adjudicate/select a winner.

This is a comparative benchmark, so report two separate gates:

- `processingComplete`: exactly 16 recovery envelopes / 48 distinct engine layers structurally returned, pinned, and auditable;
- `allLayersSuccessful`: whether all 48 are non-error, known non-truncated layers.

Known, truthfully represented Ovis repetition/truncation may make the second gate false without making the first false. Unknown truncation, missing layers/envelopes, identity mismatch, invalid schema, capture failure, or wrong provenance must make `processingComplete` false.

The completion report must include clean/truncated/error/unknown counts; exact commit on all 48; executor hash/audit evidence on all 16 Ovis layers; chunk-size diagnostic result and tracked choice; eoir-2493 vertex counts with no-point-loss proof; complete new result filename/SHA ledger; old-run preservation ledger; settled recovery queue; unchanged original accepted inputs; service/model/GPU/Qwen state; severe untouched proof. Stop OCR/models and leave Qwen stopped. Report `/home/dave/.local/bin/start-qwen` but do not execute it.
