# INASearch OCR worker: correct acceptance lock ownership, then run the 16-page batch

Continue `/home/dave/inasearch-ocr-worker` from clean commit `e9b4ce0c1f45026001305b0b9c568cf513cd5ce4`. The service and GPU are stopped. Do not restart Qwen.

The just-attempted disposable job `accept-ovis-provenance-e9b4ce0-20260831t024046z` is invalid as service acceptance. A manual `.venv-core/... inasearch_worker run-one` process (PID 3670415) acquired the singleton lock and launched Ovis outside the service cgroup, while the actual systemd daemon repeatedly restarted with `WorkerBusyError`. The coordinator stopped those disposable processes before a result was published. Preserve this job as interrupted evidence, reconcile it into `recovery-needed` or another non-runnable quarantine without deleting/overwriting evidence, and never count or reuse it.

Use a new unique Ovis-only job. The actual hardened service must own the singleton lock before any negative probe:

1. Start from a clean tree, exact HEAD `e9b4ce0c...`, passing tests/runtime verification, and a byte-identical installed unit.
2. Enqueue the unique job normally.
3. Start `inasearch-ocr-worker.service` and wait until all are true: `systemctl` reports active, `MainPID` is nonzero, `tmp/worker.lock` records that exact MainPID, and that service-owned process has begun the Ovis adapter.
4. Only then invoke `bin/ocrctl run-batch --limit 1` as the negative probe. It must return `WorkerBusyError`; it must never run an engine or own the lock.
5. Confirm the Ovis adapter and EngineCore are descendants/cgroup members of the service MainPID, not a login-session manual `run-one` process.

The previously created `/tmp/hermes-accept-ovis.py` implements the correct ordering and service-ownership wait. Reuse its logic with a new job ID and the exact `e9b4ce0...` commit if helpful. Do not use the later ad-hoc sequence that ran `run-one` first.

For the home-cache before/after evidence, do not hash all content under the 73 GB `/home/dave/.cache`; that timed out. Snapshot names, file types, modes, sizes, and nanosecond mtimes there. Content hashing is acceptable for the much smaller `/home/dave/.config/vllm` and `/home/dave/.triton`. Require exact no-change comparisons for all three trees, private writes under `cache/ovisocr2`, exact telemetry flags and loopback host in the adapter environment, no non-loopback Ovis/vLLM socket, valid complete result at `e9b4ce0...`, and clean service stop.

Wait until the acceptance controller itself exits successfully and its evidence directory contains `summary.json`, `result-validation.txt`, `journal.log`, singleton evidence, enqueue evidence, cache snapshots/digests or equivalent, and the result hash. Do not proceed merely because the canonical OCR result appeared.

Only after this true acceptance passes, validate/enqueue/run exactly the 16 untouched `ocr-smoke-*` transfer jobs. Ignore unrelated `inbox/drop/probe` or acceptance inputs; match the exact 16 prefix/manifest/hash contracts. Requested-engine list order is immaterial, but the set must be exactly all three engines. Execute service warm passes PP-OCRv6, PaddleOCR-VL 1.6, then OvisOCR2. Require all 16 canonical envelopes, 48 successful layers, no errors, strict schema/semantic validation, and exact `e9b4ce0...` provenance.

Keep every prior ambiguity/race job quarantined and do not let it enter the batch. Do not auto-select/adjudicate results. Do not run the 50-page severe batch. Stop the service at handoff, leave Qwen stopped, retain all evidence/results for Mac download, and report `/home/dave/.local/bin/start-qwen` without running it.
