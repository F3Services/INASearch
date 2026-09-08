# INASearch OCR worker: mandatory vLLM config/telemetry correction

Resume `/home/dave/inasearch-ocr-worker` from the uncommitted cache-isolation work left by the interrupted Hermes turn on top of `6585085`. The turn was intentionally interrupted before tests or another GPU run because read-only inspection found two material omissions. Preserve and finish the existing work; do not discard it. Continue following the full cache/acceptance/16-page instructions from the preceding brief.

Before committing or starting any model, add and provenance-lock all of the following, in addition to the nine cache variables already present:

- `VLLM_CONFIG_ROOT=/home/dave/inasearch-ocr-worker/cache/ovisocr2/vllm-config`
- `XDG_CONFIG_HOME=/home/dave/inasearch-ocr-worker/cache/ovisocr2/xdg-config`
- `VLLM_NO_USAGE_STATS=1`
- `DO_NOT_TRACK=1`

The actual failed systemd attempt wrote `/home/dave/.config/vllm/usage_stats.json`, and installed vLLM attempts telemetry unless it is explicitly disabled. Treat the two boolean settings as behavior-relevant provenance, not path variables. Set all four before importing vLLM so spawned processes inherit them. Record them consistently in the Ovis backend config, engine lock, environment manifest, adapter/runtime verification, README, and regression tests. Extend tests so path variables must be absolute private worker-cache descendants, while the two flags must equal `1`. Do not weaken `ProtectHome=read-only` and do not permit outbound telemetry.

Inspect the installed vLLM usage code to confirm these names are honored. Also verify that no other active home-derived configuration path remains.

The interrupted old job `accept-ovis-unit-fixed-6585085` remains in `queue/running` with only immutable attempts 1 and 2 present. Reconcile it using the worker's supported deterministic recovery semantics without deleting or overwriting evidence. Do not count it as the new acceptance proof. Use a new unique Ovis-only job after a clean cache-isolation commit for the genuine service acceptance.

Before that acceptance, require a clean Git tree, passing full tests/static/runtime verification, and a byte-identical installed unit. During/after it, specifically prove:

- `VLLM_CONFIG_ROOT`, `XDG_CONFIG_HOME`, and both opt-out flags are in the adapter process environment;
- no new or modified runtime/config/telemetry files under `/home/dave/.cache`, `/home/dave/.config/vllm`, or `/home/dave/.triton`;
- no attempted connection to `stats.vllm.ai` or any other non-loopback Ovis/vLLM socket;
- all new vLLM/Torch/Triton/FlashInfer/CUDA/config files stay under the worker cache;
- the service owns the singleton lock, the manual probe is rejected, the canonical result is complete and validates against the exact clean commit, and the service is stopped afterward.

Only after that proof, validate/enqueue/run exactly the 16 already-transferred `ocr-smoke-*` jobs through the committed service in the requested warm engine-pass order. Require all 16 canonical envelopes with all three engines and no errors before handoff. Do not process the 50-page severe batch. Leave Qwen stopped and report `/home/dave/.local/bin/start-qwen` without running it.
