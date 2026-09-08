# Ovis FileStore final pre-launch review

Resume the current dirty FileStore worktree; preserve all changes and the newly installed byte-identical user unit. Do not launch GPU acceptance or the 16-page batch until these last points pass.

1. In `_distributed_args_for_directory`, `hasattr(parallel, "data_parallel_size")` is not fail-closed. Require `getattr(parallel, "data_parallel_size", None) == 1`; absence, `None`, or any other value must reject. Keep the separate exact checks for `world_size` and `world_size_across_dp`.

2. Strengthen the private temp probe to assert the created rendezvous directory is exactly 0700; audit files are regular, owned by the effective user, and exactly 0600; and each audit JSON parses and matches the returned `file://` URI, current child PID, executor qualified name, and pinned upstream-method hash. Tests must leave the production rendezvous directory unchanged.

3. The generic spawned import/pickle probe is useful but not sufficient. The real direct Ovis smoke and later service acceptance must explicitly prove the qualified executor imported in the actual EngineCore. Correlate the fresh `.audit.json` PID to that EngineCore cgroup descendant, observe the sibling `.store` while it is live, and record the file URI beneath the exact private directory.

4. Socket parsing nuance: an `ss` LISTEN row's peer column is normally the unconnected placeholder `0.0.0.0:*` or `*:*`, even for a valid `127.0.0.1:<port>` local bind. For LISTEN/UNCONN, classify only the **local** endpoint. For ESTAB, classify both actual local and peer endpoints. Use `ipaddress.ip_address(...).is_loopback`, including IPv4-mapped loopback. Reject any wildcard (`*`, `0.0.0.0`, `::`) or non-loopback **local listener**, and reject any established non-loopback endpoint. The six Gloo listeners may be accepted only when their local binds are literal loopback.

5. Do not assert that static layer fields `distributedInitMethod=file` or the directory prove runtime behavior. They are descriptive only. The child-correlated audit/store/socket evidence is authoritative.

Re-run the full tests and runtime verification, verify refreshed manifests/hashes and the installed unit, then run the real synthetic Ovis smoke with continuous FileStore/socket/cgroup capture. Commit only after it passes and the tree is clean. Run a fresh service-owned acceptance at that commit, with the same evidence rules. Only after its controller exits successfully may the untouched 16 jobs run in PP/Paddle/Ovis order. Require 16 envelopes/48 successful layers at the new exact commit. Do not run the severe 50; stop OCR at handoff, leave Qwen stopped, and retain all evidence/results.
