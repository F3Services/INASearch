# Ovis runtime capture v2: final two gates

Resume the current dirty worktree and preserve capture v2. Its parser/latching design and 11 current tests are otherwise approved. Do not launch GPU work until these two remaining evidence gaps are fixed and tested.

## 1. Tie socket proof to the correlated EngineCore

Current `socket_capture_success` accepts any safe LISTEN/UNCONN owned by any service descendant. Derive the authoritative EngineCore PID set from the successful `jointObservation.pid` values and require at least one literal-loopback **TCP LISTEN** row whose `ownedPids` contains one of those exact PIDs. Record the PID-to-row mapping in the summary. A worker/adapter/resource-tracker listener cannot satisfy this proof. Keep zero unsafe rows/errors/failures across all service descendants.

## 2. Prove clean FileStore shutdown and persistent audit

Do not stop capture immediately when the result file appears. Enter a bounded completion/finalization phase and continue sampling until the EngineCore PID has exited and every jointly observed `.store` path is absent, while every corresponding `.audit.json` remains present, regular, same-euid, 0600, valid JSON with the same URI/PID/executor/upstream hash, and the rendezvous directory remains same-euid 0700 and not a symlink. Record final sample/timestamps and the removal/persistence checks.

`audit_capture_success` may latch the historical live PID/cgroup/identity and joint store observation, but it must also require final structural audit validity/persistence and final store absence. A once-valid audit later deleted/corrupted must fail. A store still present after clean EngineCore exit must fail. Add fixtures for both successful cleanup and deleted/corrupted audit/stale-store failures.

Then re-run full tests and runtime verification. Let the read-only review inspect the updated capture. Only then run the real synthetic Ovis smoke with the corrected capture, commit the clean tree, and run a fresh service-owned acceptance using the same gates. The acceptance controller must fully exit with complete evidence before the untouched 16-page PP/Paddle/Ovis batch. Leave Qwen stopped; do not run the severe 50.
