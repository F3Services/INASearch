# INASearch OCR worker: required reliability corrections before benchmark

Continue the existing dirty tree in `/home/dave/inasearch-ocr-worker`. The
preceding finish turn was intentionally stopped before it edited, committed, or
enqueued anything, because an independent read-only review found pre-batch
reliability defects. Preserve all useful prior work and the successful Paddle
smoke. Do not restart Qwen, touch the unrelated interactive Hermes/gateway
processes, expose a service publicly, or enqueue any of the 16 transferred jobs
until every required acceptance check below passes.

First re-identify current processes, GPU/container state, repository status,
queue/result state, and the exact existing smoke artifacts. Do not trust stale
PIDs. Then address the findings below with focused tests and commits.

## Required high-severity corrections

### 1. Deterministic crash recovery

`src/inasearch_worker/worker.py` currently moves pending jobs to running but
subsequent runs scan only pending. A crash can therefore strand running jobs.
There is also an ambiguous window after immutable result creation but before
completed-state creation.

Implement explicit startup/batch reconciliation for every running state:

- If no result exists and accepted input/state/hash validation still passes,
  recover the job safely for processing without changing its identity.
- If a complete schema-valid immutable result already exists and matches the
  embedded job/input hashes, finish the queue-state transition without rerunning
  or overwriting the result.
- If the existing result is missing, malformed, mismatched, or ambiguous, move
  the state to a reviewable failed/recovery state with exact evidence; never
  overwrite or guess.
- Catch per-adapter/per-layer identity errors so one bad adapter row cannot
  terminate the daemon and orphan the whole batch.

Add fault-injection tests for crashes at pending-to-running and
result-to-completed boundaries, including restart behavior.

### 2. Retryable engine failures and truthful status

Timeouts, nonzero adapter exits, and missing page outputs currently become
error layers but the job is still marked completed, after which the job ID is
permanently rejected. Define explicit retry semantics:

- A requested layer with `stopReason: "error"` must not make the job look fully
  successful/completed.
- Preserve immutable partial/error attempt evidence rather than hiding it.
- Permit a controlled retry of the same accepted, hash-validated input without
  overwriting prior attempt evidence or weakening job-ID collision protections.
- Bound retries and make terminal failure explicit. Do not retry deterministic
  schema/hash/model-identity failures as though they were transient.
- Health/status must report successful, partial/error, retryable, exhausted,
  and recovery-needed counts accurately.

Add tests for timeout, adapter nonzero exit, missing marker/output, partial
layers, retry, retry exhaustion, and no-overwrite behavior.

### 3. Singleton GPU-worker lock

Daemon and manual batch entry points can currently run concurrently, and one
can stop Paddle while another uses it. Add a process-wide, nonblocking singleton
lock covering reconciliation and all GPU engine passes. A second daemon/manual
batch invocation must fail clearly without touching jobs or services. Test it.

### 4. Ovis under the real network sandbox

The hardened source unit denies all IP traffic except localhost, while a direct
Ovis smoke selected `tcp://192.168.0.220:52577` for its vLLM/NCCL rendezvous.
The installed vLLM supports `VLLM_HOST_IP`.

- Force `VLLM_HOST_IP=127.0.0.1` for Ovis and record the behavior-affecting
  setting in the hashed backend configuration/engine lock.
- Install the exact committed source unit into the user systemd location,
  daemon-reload it, and verify the installed unit is byte-identical.
- Run a real Ovis smoke through the actual hardened unit sandbox, not only from
  a shell. Verify no non-loopback listener/rendezvous is used.

The currently installed unit is stale (old umask and missing source hardening),
so do not start it until the committed unit and Ovis loopback setting are ready.

### 5. Exact reproducible worker identity

Do not run production jobs from a dirty/untracked tree. Current `<HEAD>-dirty`
provenance is not enough and untracked files were not detected. Commit every
intended launcher, adapter, schema, config, test, service, documentation, and
environment-manifest change before benchmark work. Require a clean porcelain
status at production startup (or record a canonical content-tree digest in
addition to a clean commit). Health and every layer must identify the exact
committed worker.

## Required structural/provenance corrections

1. Strengthen the result schema and semantic validation so embedded jobs and
   coordinate mappings are actually validated, not arbitrary objects.
2. Define compatible structures for blocks, lines, native token/glyph boxes,
   errors, and audit evidence. Require finite numeric coordinates, correct
   polygon/bbox shapes, confidence in `[0,1]`, and coordinates within the page.
3. Reject duplicate adapter keys, engine mismatch, engine-version mismatch,
   malformed/NaN/out-of-bounds geometry, and bad embedded job/input identity.
4. In `engine_ppocrv6.py`, do not let `zip()` silently truncate mismatched
   native arrays. Assert compatible lengths and return a truthful error/warning.
5. Tie provenance assertions to runtime: verify installed package versions,
   adapter/config/template/tokenizer behavior hashes, relevant model files, and
   lock entries. The adapter's reported engine version must match its lock.
6. Preserve the already-correct semantics: PP token/glyph boxes have no invented
   token confidence; Ovis retains raw/repeated-tail cleanup audit; Paddle retains
   per-crop finish reasons/usage and only asserts known truncation when supported.

For the Paddle host-network container, retain verified loopback-only binding.
Also apply safe container hardening that is compatible with the official image
(at minimum capability reduction and no-new-privileges; read-only root/resource
limits where verified). Record clearly whether it is loopback-only versus fully
network-isolated; do not overclaim.

## Engine smokes, commit, and benchmark

After the corrections:

1. Inspect and schema-validate the existing Paddle smoke at
   `tmp/paddle-smoke-output.jsonl`; it contains an `INASEARCH_LAYER_JSON=` record,
   not bare JSONL. Its three crop responses reported `finish_reason=stop` and 74
   completion tokens; verify all downstream claims from the raw audit.
2. Run true PP-OCRv6 and OvisOCR2 model smokes with warm/batch adapters.
3. Exercise the full committed worker against a disposable hash-validated job
   through the hardened unit and verify recovery, retry, singleton, schema,
   atomic publication, and no-overwrite behavior.
4. Run the full test suite/static checks, update documentation/environment lock,
   review the diff, and create focused commits. Require a clean tree and a
   byte-identical deployed unit before any transferred job is enqueued.
5. Revalidate and enqueue exactly the 16 two-file directories already under
   `inbox/drop`. Run all three requested layers in engine-pass order:
   PP-OCRv6, PaddleOCR-VL 1.6, OvisOCR2. Keep each engine warm for its pass.
6. Validate 16 immutable envelopes, each with exactly three distinct requested
   layers and matching embedded hashes/provenance. Do not select/adjudicate any
   layer. Keep all results available for the Mac coordinator.

Do not process the separate 50-page severe batch. It will only be transferred
after coordinator-side review of the 16-page benchmark.

## Final report

Return commit IDs and clean status; complete test counts; deployed-unit identity;
recovery/retry/singleton acceptance evidence; engine readiness and smoke hashes;
16-page queue/result counts; per-engine cold/total/warm timing; all failures,
retries, truncations, and cleanup warnings; immutable result/schema hashes;
loopback health and GPU/process state; and the prior Qwen restore command without
running it.

Continue until the 16-page batch finishes or a concrete evidenced blocker cannot
be safely resolved within scope. If a tool ceiling interrupts you, preserve and
commit completed corrections before reporting the exact remaining steps.
