# INASearch OCR worker: exact software provenance gate, final acceptance, 16-page batch

Continue `/home/dave/inasearch-ocr-worker` from clean commit `3bdb1fe`. The fresh Ovis-only service acceptance `accept-ovis-telemetry-3bdb1fe-20260831t023418z` completed successfully; preserve it and its evidence. The OCR service and GPU are stopped. Do not restart Qwen.

Before releasing the 16-page batch, fix one strictness gap found by independent review:

- `schemas/result-v1.json` globally permits optional `triton` and `flashinfer` fields so Ovis can publish them.
- `validation.py` currently iterates only `cfg["software"]`, so a PP-OCRv6 or Paddle layer carrying false extra `triton`/`flashinfer` assertions can pass semantic validation.

Require the provenance software key set to equal exactly:

`set(cfg["software"]) | {"nvidiaDriver"}`

Reject both missing and unexpected keys before comparing values, with a clear error. Continue comparing every locked value and require a nonempty driver. Add regression coverage that:

- valid PP, Paddle, and Ovis software maps pass;
- PP and Paddle reject injected `triton` or `flashinfer` keys;
- Ovis rejects a missing expected runtime key and a wrong locked value.

Also add an environment test tying the environment manifest's embedded engine-lock snapshot to the actual relevant engine-lock data/schema hash so future generated snapshots cannot drift. Refresh `generatedAt` if it represents generation time rather than a stable source timestamp. Do not add a detached-manifest scheme or broaden scope.

Run the full test suite, static checks, and runtime verification. Update dependent hashes/manifests, commit the correction, and require a completely clean tree. The successful `3bdb1fe` acceptance remains valid evidence for cache isolation, but because the worker commit will change, run one new unique Ovis-only acceptance through the actual hardened service at the final clean commit. Require the same proof: exact commit result, singleton rejection, loopback-only sockets, all three reporting opt-outs in the adapter environment, no new/modified files under `/home/dave/.cache`, `/home/dave/.config/vllm`, or `/home/dave/.triton`, worker-cache-only runtime writes, complete `stop` result, and stopped service afterward.

Leave these historical ambiguous jobs quarantined in `queue/recovery-needed`; do not requeue them and do not let stale `RecoveryAmbiguity` fields enter a completed state:

- `accept-ovis-unit-fixed-6585085`
- `accept-ovis-telemetry-787dfa5-20260831t022439z`

Then validate and run exactly the 16 already-transferred `ocr-smoke-*` jobs. Identify them from the transfer manifests/hashes and require the requested-engine **set** to be exactly `{pp-ocrv6, paddleocr-vl-1.6, ovisocr2}`; do not assume the list order in each incoming manifest. The worker must still execute warm passes in PP-OCRv6, PaddleOCR-VL 1.6, OvisOCR2 order. Require two regular files per transferred job, no symlinks, all hashes consistent, no extra jobs enqueued, and all 16 immutable canonical envelopes with all three successful layers, strict schema/semantic validation, and final clean-commit provenance.

If any engine/page fails, preserve attempts and fix with a regression before retrying. Do not auto-select or adjudicate OCR layers. Do not run the 50-page severe batch. Stop the OCR service at handoff, leave Qwen stopped, retain all results/evidence for the Mac coordinator, and report `/home/dave/.local/bin/start-qwen` without running it.
