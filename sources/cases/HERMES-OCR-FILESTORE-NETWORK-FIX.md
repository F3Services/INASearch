# INASearch OCR worker: eliminate Ovis's wildcard store without root

Resume `/home/dave/inasearch-ocr-worker` and implement this correction. Qwen stays stopped and the entire RTX 5090 is available. The 16 `ocr-smoke-*` jobs must remain untouched until a new acceptance passes.

## Invalid evidence to preserve

Preserve but do not count `accept-ovis-service-owned-e9b4ce0-20260831t025100z`. Its OCR completed, but its network assertion was false: the controller treated `*:37739` as protected by user-unit `IPAddressAllow`/`IPAddressDeny`. This host's user-manager journal explicitly says the IP firewall is not running as root, so those settings have no effect. Normalize `::ffff:127.0.0.1` as loopback, but never relabel `*`, `0.0.0.0`, or `::` as loopback.

Noninteractive root authority is unavailable (`sudo -n true` fails), so do not pursue or wait on a root system service. Do not ask the user to type a password for this batch.

## Source-supported no-root fix

Eliminate the socket rather than pretending it is filtered. The wildcard listener is PyTorch c10d `TCPStore`, not a Gloo or NCCL data-plane listener:

- installed vLLM `vllm/v1/executor/uniproc_executor.py` has `UniProcExecutor._distributed_args()` return `tcp://<get_ip()>:<free-port>`;
- that URI flows to `torch.distributed.init_process_group`;
- PyTorch's rank-zero TCPStore listens passively on all addresses even though `VLLM_HOST_IP=127.0.0.1` controls its advertised/client endpoint;
- installed PyTorch's `file://` rendezvous creates a `FileStore`, which does not open this TCP listener;
- vLLM accepts a custom `Executor` subclass or import path through `distributed_executor_backend`.

Implement a small repository-owned subclass of the **installed pinned** `vllm.v1.executor.uniproc_executor.UniProcExecutor`. Override only `_distributed_args()` so the world-size-one Ovis worker returns a unique `file://` rendezvous path, rank 0, and the same local-rank calculation as upstream. Requirements:

- the unique, initially nonexistent path must be under `/home/dave/inasearch-ocr-worker/cache/ovisocr2/rendezvous/` (private directory, service UMask 0077); never use `/tmp` or home-global caches;
- avoid stale-path reuse after crashes (PID plus strong random/UUID component is acceptable); do not precreate the FileStore file;
- pass the subclass or its import path to `LLM(..., distributed_executor_backend=...)` in a way that remains importable by the spawned EngineCore;
- keep `VLLM_HOST_IP=127.0.0.1`; add `NCCL_SOCKET_IFNAME=lo` and `GLOO_SOCKET_IFNAME=lo` only as defense in depth, not as the claimed TCPStore fix;
- fail closed if this pinned vLLM interface changes or the private rendezvous directory cannot be established;
- do not edit site-packages or monkeypatch PyTorch/vLLM globally.

Behavior/provenance-lock this adapter: add focused tests that prove the custom backend is selected, returns a `file://` URI inside the private worker cache, preserves rank/local-rank behavior, creates unique paths, and cannot silently fall back to upstream `tcp://`. Include the repository-owned executor/config hash or an equally exact identifier in the engine lock/environment manifest/result software provenance, updating exact-key semantic validation and its positive/negative tests. Update documentation to explain why FileStore is mandatory for this pinned single-GPU backend. Remove or clearly disclaim the ineffective user-unit IP firewall settings so the unit never claims enforcement it lacks. Preserve all existing filesystem/process hardening that actually works.

Run the full committed suite, pinned-runtime verification, source-versus-installed unit comparison, and a direct synthetic Ovis smoke. Commit all changes and require a clean tree. Report the exact commit and relevant hashes.

## New unique service-owned acceptance

Use a fresh Ovis-only job at the new commit. The user service must own the singleton lock before the manual negative probe. Require all prior cache, telemetry, provenance, cgroup, validation, completion, and clean-stop evidence. In addition:

1. Capture every Ovis adapter/EngineCore TCP and UDP socket throughout initialization and generation.
2. Classify addresses with the standard IP parser so IPv4-mapped loopback is handled correctly.
3. Reject the run if any Ovis/vLLM descendant ever has a listener or connected peer on `*`, `0.0.0.0`, `::`, LAN, Tailscale, or another non-loopback address. There is no cgroup-policy exception.
4. Prove the old TCPStore listener is absent and record evidence that the active distributed initialization method is `file://` beneath the private worker-cache rendezvous directory. If useful, retain a safe audit marker in the layer metadata; do not expose secrets.
5. Confirm all remaining vLLM listeners are literal loopback and the OCR result is complete, non-truncated, strictly valid, and stamped with the new exact commit/provenance.

The controller must fully exit successfully and write its complete summary/evidence before the gate opens.

## Then the 16-page benchmark

Only after that gate passes, validate/enqueue exactly the 16 untouched `ocr-smoke-*` jobs. Run warm passes PP-OCRv6, PaddleOCR-VL 1.6, then OvisOCR2. Require exactly 16 canonical envelopes and 48 successful layers, no errors, strict validation, and the new exact commit. Do not auto-select/adjudicate. Do not run the 50-page severe batch.

At handoff stop the OCR service, leave Qwen stopped, retain all evidence/results for Mac download, and report `/home/dave/.local/bin/start-qwen` without executing it.
