# INASearch OCR worker: add the still-missing vLLM telemetry opt-outs, then continue

Continue `/home/dave/inasearch-ocr-worker` from clean commit `b1181bc`. No OCR service or GPU process is running. Do not restart Qwen.

`b1181bc` correctly added `VLLM_CONFIG_ROOT`, `XDG_CONFIG_HOME`, and the other home-derived cache roots, but it still omitted explicit telemetry opt-outs. The installed vLLM 0.22.1 code confirms all three names are honored:

- `vllm/usage/usage_lib.py:56-66` checks `VLLM_DO_NOT_TRACK`, `DO_NOT_TRACK`, and `VLLM_NO_USAGE_STATS`;
- `vllm/envs.py:775-779` parses them;
- without an opt-out, the prior service attempt created `usage_stats.json` and attempted reporting.

Before any model or service run, have Hermes add all three settings with value string `"1"`:

- `VLLM_NO_USAGE_STATS=1`
- `VLLM_DO_NOT_TRACK=1`
- `DO_NOT_TRACK=1`

Set them before importing vLLM in the adapter and propagate them through the worker subprocess environment. Record them as behavior-relevant provenance in `env/backend-configs/ovisocr2.json`, `env/engine-lock.json`, and `env/environment-manifest.json`, and document them. Runtime verification and regression tests must require each exact value. They are flags, not filesystem paths, so keep them separate from the cache-path validation set. Confirm the installed code recognizes them. Run the full tests/static/runtime verification, update dependent hashes, commit the correction, and require a clean tree. Do not start a model until this commit exists.

Then resume the full prior instructions: preserve and reconcile the interrupted `accept-ovis-unit-fixed-6585085` evidence without counting it; install the byte-identical unit; run a new unique Ovis-only acceptance through the actual hardened service; prove the three opt-out flags in the adapter environment, no telemetry/non-loopback socket, no changes under the old home cache/config trees, private worker cache writes, singleton exclusion, exact clean-commit provenance, and a valid complete result; stop the service afterward.

Only after that acceptance passes, validate and run exactly the 16 already-transferred `ocr-smoke-*` jobs through the service in PP-OCRv6, PaddleOCR-VL 1.6, OvisOCR2 warm-pass order. Require all 16 immutable canonical envelopes with all three layers and no errors. Do not run the 50-page severe batch. Leave Qwen and the OCR service stopped at handoff, retain all evidence, and report `/home/dave/.local/bin/start-qwen` without running it.
