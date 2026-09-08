# INASearch Ovis FileStore patch: adversarial review fixes before GPU work

Resume the uncommitted FileStore worktree exactly as it stands. Do not discard the patch. Do not start Ovis acceptance or the 16-page batch until every blocker below is resolved. Qwen remains stopped.

The architecture is approved: pinned custom `UniProcExecutor` + `file://` FileStore, with Gloo/NCCL confined to `lo`, removes the wildcard TCPStore without root. Apply these corrections:

1. **Reject hidden data parallelism.** Checking only `parallel_config.world_size == 1` is insufficient because that excludes DP. Fail closed unless `world_size_across_dp == 1` as well; check `data_parallel_size == 1` too if exposed by this pinned config. Tests must prove rejection of each unsafe dimension.

2. **Do not permit unsafe inherited environment overrides.** `engine_ovisocr2.py` currently uses `setdefault` for `VLLM_HOST_IP`, `NCCL_SOCKET_IFNAME`, `GLOO_SOCKET_IFNAME`, and the FileStore directory. A direct/alternate launch can inherit unsafe values. Hard-assign the exact locked values before importing vLLM, or reject any mismatch before import. The service worker also verifies its exact config, but the adapter itself must fail closed.

3. **Tighten schema/semantic tests.** `ovisFileStoreExecutorSha256` may be optional globally because non-Ovis engines omit it, but when present it must be a non-null 64-hex string. Existing semantic validation must require it for Ovis and forbid it as an injected extra key for PP/Paddle. Add explicit tests for missing Ovis hash, wrong Ovis hash, and injected non-Ovis hash.

4. **Strengthen executor tests without polluting production cache.** Use a private temporary directory through a safely testable helper/design, not the live production rendezvous directory. Cover local rank 0 and an indexed CUDA device; `world_size`, `world_size_across_dp`, and data-parallel fail-closed behavior; wrong environment path; unsafe mode; wrong owner if safely mockable; directory symlink; and a dangling symlink/collision at the candidate store path. `os.path.lexists` is the clearest collision check. Do not leave production audit markers from unit tests.

5. **Prove child import.** A same-process `Executor.get_class` test is not enough. Add a spawned child-process qualified-import/pickle or equivalent probe. The real Ovis EngineCore smoke and acceptance remain mandatory and are the final proof.

6. **Do not treat static layer audit strings as runtime evidence.** The fresh executor `.audit.json` must be correlated with the actual EngineCore descendant PID, contain a `file://` URI under the exact private directory, and (during initialization) have a corresponding live `.store` file. Capture this while the process is running because normal FileStore destruction removes its store file. Socket sampling must cover the same EngineCore lifetime. The layer may retain a non-secret summary, but it cannot substitute for the runtime correlation.

7. **Finish manifest/unit accuracy.** Refresh `environment-manifest.generatedAt`. Keep the executor hash as a behavior artifact/engine-lock item, not a Python package. Install the modified user unit after removing the ineffective firewall directives and byte-compare it with the tracked unit. Confirm the unit has no false firewall claim and all other hardening remains.

8. **Audit-file lifecycle.** UUID+PID prevents stale store reuse; normal FileStore destruction removes the store, while a crash can leave it. Never reuse/delete a possibly active filename. Document that small audit markers intentionally persist (and a safe retention policy if added). Do not sweep historical evidence during this task.

Then run the full committed tests and runtime verification. Run a real direct synthetic Ovis smoke and capture sockets throughout startup/generation; require no wildcard/non-loopback socket. Commit only after tests and the tracked/installed unit are exact and the tree is clean.

After the commit, run a new unique **service-owned** Ovis acceptance with the original singleton/cache/telemetry/provenance/result checks plus the FileStore PID/store/socket correlation above. The invalid 02:51 acceptance remains preserved but uncounted. Only after the acceptance controller exits successfully with complete evidence may you run exactly the untouched 16-page batch (PP, Paddle, Ovis), require 16 envelopes/48 successful layers at the new commit, stop the service, leave Qwen stopped, and report `/home/dave/.local/bin/start-qwen` without executing it. Do not run the 50-page severe batch.
