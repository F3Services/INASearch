# Preserve run 1, repair polygon support, diagnose Ovis repetition, and rerun the 16-page benchmark

The first real batch correctly stopped and must remain preserved/non-counting as a complete run:

`tmp/batch/ocr-smoke-16x3-0ada88f-20260831T035103Z`

Do not delete or overwrite any run-1 evidence. Qwen must remain stopped, the severe 50 must remain untouched, and OCR must stop again on an infrastructure/provenance/runtime-capture failure.

The purpose of this run is a comparative benchmark. A truthfully represented engine truncation is a benchmark observation, not a reason to falsify completion. Distinguish `processingComplete` (all 16 envelopes / 48 engine layers structurally returned and pinned) from `allLayersSuccessful` (no engine errors/truncations). Aim for 48 clean layers if the controlled diagnostic supports a safe correction, but do not hide genuine model failure just to make that number.

## 1. Diagnose Ovis on the three repeated-tail pages before changing tracked Ovis behavior

Using the current clean commit and the preserved accepted inputs, run a uniquely named, non-canonical direct Ovis diagnostic for these three pages plus one clean control:

- `ocr-smoke-2c70de2299b0b50f7d2792384dfa3f53` (eoir-2822 p.4)
- `ocr-smoke-56f321a556a574b46797df95fee63881` (eoir-3147 p.1)
- `ocr-smoke-5b06e18c28ce481c41ec29637d440ea2` (eoir-3044 p.5)
- one prior clean Ovis page as a control

Invoke the existing adapter with `--chunk-size 1`, keep the 16,384-token limit and all other pinned settings unchanged, and attach capture-v2 to the transient unit. Do not publish these diagnostics into the canonical result namespace or alter queue state. Preserve raw and cleaned text, finish/stop reasons, token counts, cleanup metadata, hashes, and runtime evidence.

- If all three problematic pages now end with a genuine `stop`/EOS and no truncation, make tracked Ovis `batchChunkSize`/adapter default 1 and test/lock that behavior.
- If any still loops, do not merely increase the token limit and do not reclassify `finishReason:length` as complete. Preserve the cleaned repeated-tail recovery text but keep the raw truncation/error truthful. A future repetition-aware early-stop status may be added only if it explicitly remains a detected/recovered model failure rather than pretending the model emitted EOS.

## 2. Fix the actual Paddle/schema defect

PaddleOCR-VL emitted native layout polygons with 5–10 vertices. The current `$defs.polygon` schema incorrectly requires exactly four. Preserve the native polygon exactly; do not coerce it into a rectangle or discard points. Change the common result contract to accept a valid polygon with at least 3 `[x,y]` points (retain finite-number and in-bounds semantic validation). Use a defensible high maximum only if needed for resource safety; it must comfortably preserve publisher-native contours and must not truncate them.

Add focused tests proving:

- 3-, 5-, and 10-vertex native polygons validate and remain byte/point-order faithful;
- 0/1/2-point polygons fail;
- malformed, non-finite, reversed point shapes, and out-of-bounds coordinates still fail;
- the exact failed `eoir-2493` Paddle layer now passes strict schema/semantic/provenance validation without changing its native polygon data;
- local downstream semantics remain compatible with arbitrary >=3-point polygons (the Mac bridge already accepts this shape; report that compatibility rather than inventing a quadrilateral).

## 3. Finalize and re-accept a new clean worker commit

After the diagnostic-informed Ovis choice and polygon fix, update all affected locks/config/tests, regenerate `env/environment-manifest.json` last, run the full suite/runtime verification/compile/diff/schema/provenance/unit checks, install an exact byte-identical user unit, commit all intended changes, and require a clean tree. Report the full new commit and executor SHA-256. Run a fresh uniquely named service-owned acceptance at that exact commit with singleton, capture-v2, provenance, cache, and telemetry gates. Do not continue if that acceptance fails.

## 4. Preserve live run-1 state and rerun all 16 uniformly

Before modifying live queue/result state, create a checksummed, read-only preservation area inside the run-1 evidence directory and move/copy every conflicting run-1 canonical result, queue record (completed/failed/running), attempt artifact, and relevant ledger into it so nothing is lost and every original SHA-256 remains auditable. Use recoverable moves/copies; do not overwrite files. Keep the original 16 accepted input directories intact and hash-verify them again against the original transfer manifest.

Then safely reconstruct/re-enqueue all 16 original jobs under their canonical job IDs from preserved accepted inputs, and rerun all 16—not merely the missing six—so the final benchmark has one uniform worker commit and engine configuration. Run the observed order PP-OCRv6 -> PaddleOCR-VL 1.6 -> OvisOCR2, attach capture-v2 to the Ovis pass, and preserve all raw audit evidence. Do not auto-adjudicate or select a winner.

The completion report must separately state:

- exactly 16 canonical envelopes / 48 distinct engine layers returned;
- number of clean layers, known-truncated layers, error layers, and unknown-truncation layers;
- exact worker commit on all 48 and exact Ovis executor hash/audit evidence on all 16 Ovis layers;
- whether the single-page Ovis diagnostic eliminated the three repetition loops and whether tracked chunk size changed;
- the `eoir-2493` native polygon vertex counts and proof no points were discarded;
- input preservation, queue settlement, service/model/GPU/Qwen state, and severe-queue untouched proof;
- complete file list and SHA-256 ledger for both preserved run 1 and final run 2.

Stop the OCR service/models at the end and leave Qwen stopped. Report `/home/dave/.local/bin/start-qwen` but do not run it.
