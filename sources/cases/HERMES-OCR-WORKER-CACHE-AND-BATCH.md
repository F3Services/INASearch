# INASearch OCR worker: finish cache isolation, prove service, run benchmark

Continue `/home/dave/inasearch-ocr-worker` from clean commit `6585085` (or the
exact current descendant if another commit exists). The preceding turn was
stopped only after it committed the FlashInfer cache fix and before launching a
new acceptance job. Preserve all commits, smoke evidence, queue states, and the
16 untouched transferred jobs. Do not restart Qwen or touch the unrelated
interactive Hermes/gateway processes.

## Complete cache isolation before another model run

The full systemd debug conclusively found the first failure:

`OSError: [Errno 30] Read-only file system: /home/dave/.cache/flashinfer/.../flashinfer_jit.log`

Commit `6585085` correctly routes `FLASHINFER_WORKSPACE_BASE` into the worker
cache and preserves fuller stderr evidence. However, independent read-only
filesystem inspection found additional fresh writes made by the successful
direct Ovis run:

- dozens of files under `/home/dave/.cache/vllm/.../inductor_cache/`, including
  `*.best_config`, at approximately 22:05:35–36;
- Triton sources/artifacts/cubins under `/home/dave/.triton/cache/` at
  approximately 22:05:38–50.

The earlier service failed before reaching these writes, so the same-image
acceptance could appear to work only because its direct run prewarmed the home
cache. Do not accept that risk for different legal pages.

Route every behavior-relevant runtime cache into separate writable subtrees of
`/home/dave/inasearch-ocr-worker/cache`, at minimum:

- `FLASHINFER_WORKSPACE_BASE`
- `VLLM_CACHE_ROOT`
- `TORCHINDUCTOR_CACHE_DIR`
- `TRITON_CACHE_DIR`
- `XDG_CACHE_HOME`
- `CUDA_CACHE_PATH`

Also inspect the installed vLLM/Torch/Triton/FlashInfer versions for any other
HOME-derived cache variable materially used by this adapter. Do not make HOME
writable and do not weaken `ProtectHome=read-only`. Create/cache directories
with private permissions. Record all settings in `env/backend-configs/ovisocr2.json`,
the engine lock, environment manifest, documentation, runtime verification,
and tests so the hashes describe actual behavior. Ensure multiprocessing child
processes inherit them. Retain `VLLM_HOST_IP=127.0.0.1` separately.

Add a regression test that the Ovis worker environment defines absolute paths
under the worker cache for all listed variables and no listed path resolves
under `/home/dave/.cache` or `/home/dave/.triton`. Re-run all 24+ tests and
static checks. Commit the cache isolation before model acceptance and require a
clean tree.

## Repeat genuine hardened-service acceptance

Use a new unique disposable Ovis-only job because prior immutable evidence must
not be overwritten. Run it through the actual installed user service—not a
manual runner—and avoid the earlier singleton-probe race:

1. Confirm the deployed unit is byte-identical to the committed source and
   daemon-reload it.
2. Enqueue the unique hash-validated job normally; do not manually steal the
   worker lock.
3. Start the service and wait until its MainPID owns the singleton lock and the
   Ovis adapter has actually begun before invoking the manual negative probe.
4. Require the manual probe to return `WorkerBusyError` while the service stays
   active.
5. Sample processes, environment, listeners, and established sockets throughout
   the model load/generation. Require the Ovis rendezvous to be loopback and no
   non-loopback Ovis/vLLM socket.
6. Snapshot mtimes/counts for the old home cache trees before and after. Require
   no new/modified Ovis runtime artifacts under `/home/dave/.cache` or
   `/home/dave/.triton`; require new/written artifacts to remain under the worker
   cache or private tmp.
7. Require one successful, schema-valid immutable result identifying the exact
   clean commit, with `stop`/token/truncation/raw-output/cleanup evidence.
8. Stop the service cleanly after the disposable acceptance and save timings,
   hashes, socket/cache evidence, and journal output under `artifacts/acceptance/`.

Do not mistake the earlier direct result `accept-ovis-sandbox-c1e1e89` for
systemd acceptance. The later `accept-ovis-unit-c1e1e89` correctly preserved
three failed attempts and retry exhaustion; retain them as reliability evidence.

## Then run exactly the 16 transferred benchmark jobs

Only after the new acceptance passes:

1. Re-run complete tests/static/runtime verification. Confirm clean tree, exact
   HEAD provenance, byte-identical installed unit, no Qwen process, and no other
   worker/GPU owner.
2. Identify the transferred jobs by their validated manifests/job IDs, not by
   assuming every incidental directory under `inbox/drop` is a benchmark job.
   There must be exactly 16 intended transferred jobs, each with exactly
   `manifest.json` plus one regular image, no symlink, matching hashes, and all
   three requested engines.
3. Enqueue exactly those 16. Run the committed service in warm engine-pass
   order: PP-OCRv6, PaddleOCR-VL 1.6, OvisOCR2. Do not start another manual
   worker concurrently.
4. Continue through bounded retry semantics if a genuinely transient failure
   occurs. Never overwrite attempt/result evidence or hide partial/error layers.
5. Require 16 successful immutable canonical envelopes, each with exactly the
   three requested layers, matching embedded input/runtime/model/adapter hashes,
   schema-valid geometry/audit, and clean-commit provenance. If any page fails,
   diagnose and fix in scope with a regression test and a new commit, then
   retry safely; do not declare success early.
6. Stop the service at handoff. Leave Qwen stopped. Leave all benchmark results
   available for the Mac coordinator. Do not select/adjudicate any OCR layer.

Do not process the separate 50-page severe batch; it has not been transferred
and remains gated on Mac-side schema and quality review of these 16 pages.

## Final report

Return all new commit IDs, clean status, tests/static checks, unit identity,
cache-isolation proof, true service-acceptance result/hash/timing, singleton and
network evidence, 16-job queue/result counts, per-engine cold/pass/warm timings,
all retries/errors/truncations/cleanup warnings, schema/result hashes, final
GPU/process/service state, and `/home/dave/.local/bin/start-qwen` as the later
restore command without running it.

Continue until the 16-page benchmark finishes or a concrete evidenced blocker
cannot be safely resolved. If a tool ceiling interrupts you, commit completed
fixes and report the precise remaining work without weakening gates.
