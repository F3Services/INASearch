# INASearch OCR worker: reject the user-unit network acceptance and contain Ovis

Resume the existing `/home/dave/inasearch-ocr-worker` work. Qwen must remain stopped; the whole RTX 5090 is available. Do not enqueue or run any of the 16 `ocr-smoke-*` jobs until the replacement acceptance below is fully complete.

## Why the last acceptance is invalid

The disposable acceptance `accept-ovis-service-owned-e9b4ce0-20260831t025100z` completed its OCR result and wrote a summary, but it is **not** a network-isolation acceptance. Preserve it as evidence and mark it invalid/quarantined; do not count or reuse it.

Its controller classified every `*`, `0.0.0.0`, or `::` listener as `wildcard-cgroup-loopback-only` merely because the user unit reported `IPAddressDeny=any` and `IPAddressAllow=localhost`. That premise is false on this machine:

- Ovis/vLLM's `VLLM::EngineCore` opened a wildcard TCP listener (observed as `*:37739`) and only its established peer was IPv4-mapped loopback (`::ffff:127.0.0.1`).
- This is PyTorch c10d `TCPStore`, created by vLLM's single-process executor. `VLLM_HOST_IP=127.0.0.1` controls the advertised/client endpoint, but Torch's rank-zero store calls a port-only passive listen and binds every local interface.
- `GLOO_SOCKET_IFNAME=lo`, `NCCL_SOCKET_IFNAME=lo`, and `MASTER_ADDR` do not change this TCPStore bind.
- The user manager journal says that the unit configures an IP firewall but is not running as root. User-manager `IPAddressAllow`/`IPAddressDeny` therefore have no effect here. The current wildcard store can be exposed on LAN/Tailscale interfaces unless a separate host rule happens to block it.

First independently reproduce/record the warning and inspect the installed systemd/kernel support. Do not accept a wildcard listener based on declarative properties alone.

## Required containment fix

Implement the smallest robust, repository-tracked containment. The preferred design is a root/system-manager service that runs the worker as `User=dave`/`Group=dave`, retains the existing filesystem/process hardening and exact writable paths, and enforces:

- `IPAddressDeny=any`
- `IPAddressAllow=localhost`
- only the address families actually needed (`AF_UNIX`, `AF_INET`, `AF_INET6`) if compatible with every engine

Stop and disable the user-manager copy so two workers can never contend. Do not delete historical evidence. Do not change or restart Qwen. Use `sudo -n` and stop with a concrete report if noninteractive root authority is unavailable.

Track the canonical system unit in the repository, install it byte-identically under `/etc/systemd/system`, run `systemd-analyze verify`, reload the system manager, and update all controller/docs/tests that incorrectly use `systemctl --user`. Preserve singleton semantics, strict home/cache isolation, pinned engines, telemetry disablement, exact software provenance, and result schema behavior. Run the full committed test suite and runtime verification, commit the fix, and require a clean tree. Report the new exact commit and unit SHA.

If the system manager on this host cannot actually attach an effective IP filter, do not fall back to a declarative-only pass. Stop and report. A more invasive alternative (private network namespace or a tightly scoped root firewall rule) requires proof that Paddle's localhost service still works and must not affect unrelated desktop services.

## New unique Ovis acceptance

Use a new unique Ovis-only job at the new clean commit. The **system** service must own the singleton lock before the negative manual probe. Require all prior acceptance evidence plus:

1. MainPID, adapter, resource tracker, and EngineCore are descendants/members of the root-managed service cgroup.
2. No journal warning that IP firewall settings are ineffective.
3. Record the wildcard TCPStore listener and normalize IPv4-mapped loopback correctly. A wildcard socket is allowed only if actual enforcement is proven.
4. While that wildcard listener is alive, actively test it from outside the service cgroup:
   - connection to the desktop's Tailscale address and that port must fail;
   - connection to the desktop's LAN address and that port must fail;
   - connection to `127.0.0.1` and that port must succeed.
   Record commands, return codes, addresses, port, and timestamps. If feasible, also record the cgroup BPF attachments from the root manager.
5. Retain the existing exact checks: service owns lock; manual `run-batch --limit 1` is rejected with `WorkerBusyError` and lock unchanged; exact telemetry flags; no writes to `/home/dave/.cache`, `/home/dave/.config/vllm`, or `/home/dave/.triton`; private worker-cache writes; exact final-commit provenance; complete non-truncated Ovis result; strict validation; clean service stop; complete evidence directory and `summary.json` written only after the controller exits successfully.

The invalid 02:51 result cannot satisfy this gate.

## Then—and only then—the 16-page batch

Validate and enqueue exactly the 16 untouched `ocr-smoke-*` transfer jobs. Ignore unrelated or historical acceptance inputs. Engine-list order in manifests is immaterial; the set must be exactly PP-OCRv6, PaddleOCR-VL 1.6, and OvisOCR2. Run warm passes in order PP-OCRv6, PaddleOCR-VL 1.6, then OvisOCR2. Require 16 canonical envelopes, 48 successful layers, no errors, strict validation, and the new exact commit provenance.

Do not auto-select/adjudicate results. Do not run the 50-page severe batch. Stop the OCR service at handoff, leave Qwen stopped, retain all evidence/results for Mac download, and report the restore command `/home/dave/.local/bin/start-qwen` without running it.
