# Ovis runtime capture: critical parser/latching fixes

Resume the current dirty tree. Preserve all FileStore changes. Do not run the capture, GPU smoke, acceptance, or 16 jobs until these independently confirmed blockers are fixed and tested.

## 1. Parse this host's actual `ss` format

`bin/ovis_runtime_capture.py` calls `ss -H -tunap`. On this host those rows are:

`netid state recvq sendq local peer process`

For example: `tcp LISTEN 0 4096 127.0.0.1:12345 0.0.0.0:* users:((...pid=...))`.

The current `split(maxsplit=5)` assigns `state="tcp"` and `local="4096"`; endpoint parsing throws, the caller silently skips the row, and the run can incorrectly report no unsafe sockets. Fix it to parse six fixed fields plus the optional process field (typically `split(maxsplit=6)`), retain/validate `netid`, and add fixture tests using exact real `tcp LISTEN`, IPv4-mapped `tcp ESTAB`, `udp UNCONN`, wildcard LISTEN, LAN/Tailscale, malformed, and missing-process rows.

Do not silently drop an owned descendant row. Fail the capture on nonzero `ss`, on parse errors for rows that contain a current descendant PID, or on an unknown connection state for an owned row. Require at least one successfully parsed, PID-owned literal-loopback LISTEN/UNCONN row from the EngineCore lifecycle; an empty socket set must never pass.

For LISTEN/UNCONN classify only the local endpoint; its remote placeholder may be wildcard. For ESTAB classify both real endpoints. Reject wildcard or non-loopback local listeners and any established non-loopback endpoint. Normalize IPv4-mapped loopback with `ipaddress`.

## 2. Latch concurrent EngineCore/FileStore proof

The current loop re-runs `inspect_audit(path, descendants)` and overwrites earlier valid evidence. After EngineCore exits, a final sample can replace a correct live PID/cgroup identity with `exited/invalid`. Preserve first/last observations and latch `everValid` plus the first valid process identity.

`storeObservedLive` is not enough by itself: require a sample in which the audit's exact PID is concurrently a member of the service cgroup, that PID is named EngineCore, and the exact sibling `.store` exists as a private regular file. Latch that joint fact with timestamp/sample number. Validate the audit against `all_descendants` only for historical membership, while the authoritative proof requires concurrent membership/store presence. Never let a later process exit erase a prior valid joint observation.

Require the correlated audit URI, PID, sibling store name, private modes/owner, executor qualified name, and pinned upstream hash. Require at least one such correlation and zero invalid fresh audits.

## 3. Test before GPU

Add unit/fixture tests proving:

- actual `ss -H -tunap` rows parse into the correct fields;
- literal-loopback LISTEN with wildcard peer placeholder is safe;
- wildcard local LISTEN and LAN/Tailscale listeners are unsafe;
- IPv4-mapped loopback ESTAB is safe and a non-loopback ESTAB peer is unsafe;
- empty/fully skipped/malformed owned evidence cannot pass;
- an early valid concurrent audit/store/cgroup observation remains valid after simulated EngineCore exit, while a non-concurrent store/audit never passes.

Then re-run full tests/runtime verification and let the read-only review inspect the final capture helper. Only after that may Hermes run the real synthetic Ovis smoke, commit, and run a new service-owned acceptance. The acceptance must use this corrected authoritative capture and fully exit with complete evidence before the 16-page PP/Paddle/Ovis batch begins. Leave Qwen stopped and do not run the severe 50.
