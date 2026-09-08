# Review corrections and second guard diagnostic

Resume from the deliberately uncommitted state after `ovis-repeat-guard-diagnostic-20260831T044243Z`. That diagnostic was correctly marked `success:false`; preserve it unchanged as a failed first attempt. Qwen stays stopped, the GPU remains available exclusively, and `/home/dave/.local/bin/start-qwen` must not be executed. Do not stage or run the 200-page gold set in this turn.

The first diagnostic established useful facts: native vLLM stop semantics worked, all four loop pages stopped at 606–1,910 tokens rather than 16,384, both controls naturally stopped, three old candidates and both controls were byte-identical, and the fourth loop page differed only by one internal whitespace sequence. We now authorize a rigorously narrower comparison gate: exact bytes remain preferred and separately reported, but a candidate may pass the no-shortening comparison when its only differences are whitespace if and only if all of these are independently true and recorded:

1. Unicode NFKC plus whitespace-collapse (without case folding or punctuation changes) is byte-identical.
2. The non-whitespace character sequence is byte-identical.
3. The ordered word/token sequence is identical.
4. Exact written legal-token multisets for INA, USC, CFR, I&N, and reporter volume-page references are identical.
5. A character-level diff proves there is no non-whitespace insertion, deletion, substitution, transposition, or punctuation change.
6. Both raw forms, hashes, exact mismatch location(s), comparison method, and `exactByteMatch:false` remain visible. Never relabel whitespace-equivalence as an exact match.

If any page fails both exact bytes and every condition above, stop again without committing.

Before rerunning, correct the following independent review findings.

## 1. Truthful missing-suffix path

When vLLM reports the exact guard stop reason but the configured included stop string is absent from `c.text`, the current draft correctly makes the layer an error, but incorrectly says cleanup was applied and a bounded tail was retained. In this mismatch path:

- preserve raw/candidate text without deletion other than the adapter's preexisting clearly documented outer-whitespace convention;
- record no matched-tail cleanup and no retained diagnostic tail;
- set an explicit evidence-mismatch failure/warning;
- keep the layer non-selectable and known truncated/error;
- make every cleanup length/count field truthful; and
- add a mocked adapter regression for exact `stop_reason` plus missing raw suffix.

## 2. Exhaustive pinned-vLLM finish semantics

The pinned vLLM 0.22.1 external finish reasons include `stop`, `length`, `abort`, `error`, and `repetition`. The prior adapter already mapped some non-null non-success reasons to `finished`, `truncated:false`, and no error. Fix this now and test every reason:

- Only a genuine natural `stop`/EOS that is not the configured guard may be complete and known non-truncated.
- `length` remains known truncated with a truthful error.
- `abort`, `error`, and `repetition` must be error-bearing, non-selectable partial/failure layers; preserve the exact native reason and do not call them complete or `finished`.
- An unknown/missing reason must remain fail-closed with unknown truncation, not be inferred complete.
- Preserve native `finish_reason` and `stop_reason` separately in audit.
- Use schema-valid existing values/types or update the schema and every bridge/test consistently; do not smuggle unsupported values through validation.

Add table-driven helper and mocked-adapter tests for natural stop/EOS, guard stop with included suffix, guard stop with missing suffix, length, abort, error, repetition, unknown string, and missing reason. Prove only genuine natural stop is selectable/complete.

## 3. Terminal isolated-one observation

The evidence-only terminal `\n\n1` detector currently runs on every non-guard result while its warning says “after natural stop.” Gate that wording/observation on a genuine natural completion, or reword it accurately as terminal-output evidence for other states. It must never remove text or change truncation.

## 4. Locks and environment snapshot

Keep the helper in the behavior-file lock and pin adapter/backend/config hashes. Regenerate `env/environment-manifest.json` only after all tracked bytes and modes are final. The current dirty tree still has the old snapshot, so do not treat its present test failure as a blocker until final regeneration.

## 5. Truthful queue-transition reason

The current worker transition path labels every non-retryable layer error as a deterministic identity/schema/provenance validation failure. A genuine non-retryable engine error would therefore produce a false queue-state message. It may remain a non-retryable/deterministic failure class for routing purposes, but the human/machine-readable reason must say that a non-retryable engine layer failed and carry the engine plus error type; reserve identity/schema/provenance wording for actual validation exceptions. Preserve the immutable attempt details and add a transition regression for a non-retryable generation error plus an actual validation error.

## 6. Guard cutoffs are canonical partial evidence, not generic engine errors

The guard itself must use `stopReason:"truncated"`, not `"error"`. It is an intentional content cutoff before EOS, analogous to the existing token-cap truncation. Preserve native `finishReason:"stop"` plus the exact custom native `stop_reason` in audit; set `truncationKnown:true`, `truncated:true`, and retain the non-retryable `TruncatedGeneration` evidence. This allows the structurally complete three-engine envelope to be canonically published with outcome `partial`, while the local bridge still marks the guarded Ovis layer failed/non-selectable and preserves valid PP/Paddle layers.

Do not call a guarded layer “non-publishable.” It is non-selectable OCR evidence inside a publishable canonical result envelope. Add an end-to-end worker test proving a mixed PP/Paddle-complete plus Ovis-guarded/truncated envelope is written to canonical `results/`, completes the queue record with partial outcome, and preserves all three layers. Keep `stopReason:"error"` for genuine abort/error/repetition/validation failures; those use the corrected transition message in section 5.

## Second diagnostic and completion gates

Run focused/unit/full tests after these fixes. Then use new unique noncanonical diagnostic IDs and a new evidence directory to rerun the same four loop pages plus the same two controls with max tokens 16,384 and chunk size 4. Preserve the first failed diagnostic. Require:

- all four native exact guards trigger far below the cap with included suffix evidence;
- every loop candidate is either byte-exact or passes every narrowly defined whitespace-only condition above;
- both controls naturally stop and remain byte-identical, unless a difference is explicitly evaluated under the same strict whitespace-only gate;
- all legal-token inventories are unchanged;
- capture-v2 and protected-state gates pass;
- all mismatch/native-finish regression tests pass.

Bind the second diagnostic to the exact behavior bytes that produced it. Its request/summary must record the base HEAD, dirty-state fact, SHA-256 of a preserved binary diff or equivalent complete candidate-source snapshot, and exact SHA-256 values for `bin/engine_ovisocr2.py`, `bin/ovis_generation_guard.py`, `env/backend-configs/ovisocr2.json`, `env/engine-lock.json`, the guard config, and the pinned vLLM version/package artifact. Include those source files or a complete checksum-addressed snapshot in the immutable evidence directory. After the passing candidate is committed, prove the committed blobs are byte-identical to that diagnostic snapshot and record the final clean commit in a post-commit provenance map. The service-owned acceptance must also pin the final clean commit and those exact adapter/helper/backend/guard hashes.

If the second diagnostic passes, finish the originally requested lock/config/environment-manifest/full-suite/compile/diff/schema/provenance checks, install a byte-identical unit, create a fresh clean commit, and run a fresh service-owned acceptance with capture-v2 and singleton negative probe. Report exact commit, executor/schema/adapter/backend/guard hashes, test totals, first failed and second passing diagnostic paths, per-page byte/whitespace comparison labels, token/runtime savings, acceptance evidence, and final stopped state.

If it does not pass, stop without commit/acceptance. In all cases leave OCR/model services and Qwen stopped, check exact `ninfer-serve` executable/comm, port 8084, and GPU compute processes, and preserve all evidence.
