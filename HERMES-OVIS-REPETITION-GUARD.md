# Ovis repeated-tail guard before the 200-page gold run

Qwen remains intentionally stopped and the RTX 5090 may be used exclusively for this work. Do not run `/home/dave/.local/bin/start-qwen`. Do not enqueue or process the 200-page gold set yet. Preserve every existing source, result, queue record, accepted input, commit, and evidence artifact.

The completed recovery benchmark at commit `3e3e03237d401439e992ddbbc76b76bffb68aacc` found four Ovis pages that produced all visible page content and then repeated the exact `\n\n1` unit until the 16,384-token cap. A chunk-size-1 diagnostic reproduced the same behavior, so production chunk size correctly remains 4. The four immutable raw outputs and capture evidence are in:

`/home/dave/inasearch-ocr-worker/tmp/batch/ocr-recovery-16x3-3e3e032-20260831T041925Z`

Implement and validate a conservative generation-time repetition guard before the gold benchmark. The purpose is to avoid wasting thousands of tokens after a deterministic loop begins. It must never turn guarded output into a successful/selectable layer.

## Required behavior

1. First inspect the existing Ovis adapter and vLLM sampling/result APIs. Prefer a native, pinned sampling stop string if it exposes the exact matched stop reason. If that cannot be made auditable, implement a bounded streaming/abort guard only if the actual EngineCore request can be stopped cleanly. Do not rely solely on post-generation cleanup because that saves no inference time.
2. The guard must require a long consecutive run of the observed unit (at least 16 exact `\n\n1` units) so an isolated printed page number or a short legitimate sequence cannot trigger it. Put the exact unit, threshold, stop string/hash, and include/exclude-stop-string choice in tracked backend configuration and per-layer decoding/audit provenance.
3. When the guard triggers, preserve the generated prefix plus a bounded diagnostic tail and the exact matched-stop evidence. Record the model's real finish/stop reason. Set `truncationKnown:true`, `truncated:true`, keep the layer non-selectable, and retain a truthful error such as `TruncatedGeneration` with guard-specific audit metadata. Never claim EOS, natural completion, or that the page is substantively complete.
4. Preserve or hash-address any pre-cleanup/raw output the adapter actually receives. Cleanup may make a review candidate, but it must not alter the raw evidence or convert the layer to success.
5. Do not increase the 16,384-token cap, change batch chunk size 4, change prompt text, or change model revision as part of this fix.
6. The visual review also found three normal-stop Ovis pages ending in a single isolated extra `1`. Add a conservative, evidence-only warning/detector for the exact terminal artifact if the current schema supports it without deleting text or marking an otherwise natural-stop layer truncated. Do not guess that every terminal `1` is spurious. If a safe detector cannot distinguish it, document that and leave the raw text unchanged.

## Tests and diagnostic

Add focused tests proving:

- one, two, and threshold-minus-one consecutive units do not trigger;
- the threshold and larger runs do trigger;
- an ordinary page ending in printed page number `1` does not trigger;
- unrelated repeated text does not trigger;
- a guard-triggered layer is known-truncated, error-bearing, non-selectable, and preserves audit/provenance;
- a natural EOS/stop layer remains known non-truncated;
- backend config, adapter, and result provenance hashes change deterministically and validate;
- existing FileStore, polygon, schema, singleton, retry, capture, cache, telemetry, and service-ownership tests still pass.

Using unique noncanonical diagnostic IDs and preserved inputs, run the guarded Ovis adapter on all four loop pages plus at least two clean controls. Keep max tokens 16,384 and chunk size 4. Require:

- all four guards trigger far below 16,384 tokens;
- each guarded prefix matches its immutable old raw output up to the guard point;
- the retained cleaned candidate/legal-token inventory before the repeated tail is not shortened relative to the old result;
- both controls reach genuine natural stop/EOS without guard activation;
- capture-v2 passes every current FileStore/network/process gate;
- no canonical queue/result identity is reused or overwritten.

If those conditions do not hold, do not commit or proceed; preserve the diagnostic and report the blocker.

## Commit and acceptance

If the diagnostic passes, update locks/config/tests, regenerate `env/environment-manifest.json` last, run the full worker test/runtime/compile/diff/schema/provenance suite, install a byte-identical user unit, create a new clean commit, and run a fresh uniquely named service-owned Ovis acceptance with capture-v2 and the singleton negative probe. Report the full commit, executor SHA-256, result schema SHA-256, guard config/hash, token/runtime comparison for each loop page, controls, test totals, and evidence paths.

Stop OCR/model services afterward, leave Qwen stopped, verify the exact `ninfer-serve` executable/comm and port 8084 are absent, verify no GPU compute process remains, and report `/home/dave/.local/bin/start-qwen` as not executed. Do not stage or run the gold bundle in this turn.
