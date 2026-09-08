# INASearch OCR worker: finish, commit, and run the 16-page benchmark

Continue the existing work in `/home/dave/inasearch-ocr-worker`. This is a new
turn because the preceding correction turn reached its tool-call ceiling. Read
the preceding turn's current git tree and artifacts before doing anything.
Preserve all useful changes; do not restart or redo completed setup.

The user's Qwen/SGLang workload is intentionally stopped so this OCR work may
use the full RTX 5090. Do not restore Qwen while OCR is active. Do not touch the
unrelated interactive Hermes REPL or Hermes gateway.

## Starting state and boundaries

- The prior correction turn reported 14 passing tests and left substantial
  intended changes uncommitted.
- The official pinned Paddle vLLM container was healthy on loopback and a real
  synthetic Paddle smoke command had exited successfully, but its output had
  not yet been inspected or schema-validated.
- All 16 transferred jobs under `inbox/drop` validated and remain unqueued.
- The 50-page severe batch is not on this host and must not be started until
  the 16-page results have passed coordinator-side schema and quality review.
- Never overwrite or silently replace any prior job/result. Preserve failed
  synthetic-smoke evidence.
- Do not expose any service outside loopback and do not send document data off
  this desktop.

## Finish the worker first

1. Re-identify current processes, GPU users, container identity, git status,
   queue state, and exact synthetic-smoke artifacts. Confirm they belong to
   this INASearch task rather than trusting stale PIDs.
2. Inspect and schema-validate the completed Paddle model-smoke output. Verify
   that its raw crop-response audit supports every claimed finish/truncation
   field. If the official client returned no reliable finish/usage evidence,
   retain `truncationKnown: false` and `truncated: null`.
3. Run and inspect one true PP-OCRv6 model smoke and one true OvisOCR2 model
   smoke. Use the warm/batched adapters, not per-page model reloads. Ovis may use
   the full-GPU model-card setting (`gpu_memory_utilization=0.8`).
4. Exercise the complete worker against a small disposable, hash-validated
   smoke input and validate the actual result envelope with the checked-in
   schema. Confirm exact requested-layer equality, atomic result publication,
   no overwrite, per-layer provenance, and coordinate contracts.
5. Run the complete test suite and static checks. Review the full diff for
   safety and correctness. Fix any problems found.
6. Update the environment manifest, documentation, and engine lock to record
   exact immutable pins plus truthful ready/blocked and smoke status. Do not
   mark an engine ready solely because imports/load succeeded.
7. Commit all intended worker changes in one or more focused git commits before
   enqueueing the transferred benchmark. Leave no unintended dirty files.

## Then run the transferred 16-page benchmark

Only after all three engines have true reviewed model smokes and the worker is
committed:

1. Revalidate every direct child of `inbox/drop` (exactly `manifest.json` plus
   one regular image, no symlinks; schema and hashes correct).
2. Enqueue exactly those 16 jobs with the existing `ocrctl` interface. Do not
   synthesize new IDs or alter their manifests.
3. Run all three requested layers in engine-pass order:
   PP-OCRv6, PaddleOCR-VL 1.6, then OvisOCR2. Keep each engine warm for its pass.
4. Validate every completed result against `schemas/result-v1.json`, verify
   embedded input/model/runtime hashes, and ensure there are 16 envelopes with
   exactly three distinct layers each. Preserve partial/failed layers rather
   than hiding them.
5. Leave completed results in the worker's immutable result area so the Mac
   coordinator can fetch them. Do not select or adjudicate any OCR layer.

If an engine fails, diagnose and fix in-scope worker/setup defects, add a
regression test, commit the repair, and resume safely without overwriting prior
evidence. If a model/backend remains genuinely unusable, record it as blocked
with exact evidence; do not falsely claim a three-engine success.

## Final report

Return:

- new commit IDs and clean/dirty status;
- full test counts and commands;
- engine readiness and exact immutable runtime/model hashes;
- model-smoke artifact paths and hashes;
- 16-page queue counts (pending/running/completed/failed);
- per-engine cold load, total pass, and per-page warm timing;
- every failure/truncation/cleanup warning;
- immutable result paths and envelope/schema hashes;
- redacted health output proving loopback-only services;
- GPU/process state at handoff;
- the already-captured later Qwen restore command, without running it.

Do not stop just because the run takes time. Continue until the 16-page batch
has completed or there is a concrete, evidenced blocker that cannot be safely
resolved within this scope.
