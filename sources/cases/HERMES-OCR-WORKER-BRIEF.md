# INASearch OCR worker brief for Hermes

## Objective

Prepare the Linux desktop with the RTX 5090 to act as a private, reproducible OCR worker for the INASearch BIA/AAO corpus. You are authorized to inspect the desktop and perform the setup yourself. The coordinating Mac will prepare and send page images and will validate and import results; do not modify the INASearch application or its source corpus on the Mac.

## Safety and access boundaries

- Keep all document processing and model inference local to the desktop. Do not upload documents, page images, OCR text, or metadata to third-party APIs.
- Do not expose a service to the public internet. Any service must bind only to loopback or the desktop's Tailscale interface and require authentication. Prefer SSH/Tailscale file transfer plus a queue directory if that is simpler and safer than an HTTP service.
- Do not print credentials, authentication tokens, private keys, or unrelated configuration in logs or the final report.
- Do not weaken the firewall, alter Tailscale ACLs, enable router/exit-node behavior, or open public ports.
- Do not reboot, replace the NVIDIA driver, or make destructive system changes without stopping and reporting why they are necessary. Prefer an isolated container or virtual environment.
- Originals are immutable. The worker may read inputs and create new outputs/cache files, but must never overwrite an input PDF or page image.

## First inspect, then install

Record a redacted preflight report covering:

- Linux distribution and kernel;
- RTX 5090 identity, VRAM, driver version, and `nvidia-smi` health;
- CUDA/container-toolkit availability and GPU passthrough into containers, if containers are used;
- available RAM and free space on the proposed model/cache/output volume;
- Docker/Podman and Python environment availability;
- the exact Tailscale hostname/IP to which any service would bind.

Use a CUDA 12.8-or-newer Blackwell-compatible stack. Do not require CUDA 13 merely for the RTX 5090. If the current driver/runtime cannot safely run the models, stop before changing the driver and report the minimum required change.

## Engines to prepare

Prepare a pinned, reproducible benchmark environment for these three paths:

1. PaddleOCR-VL 1.6 full document pipeline as the primary page transcription/layout candidate.
2. OvisOCR2 as an independent page-to-Markdown candidate.
3. PP-OCRv6 medium detection and recognition as the structured word/line box and confidence layer.

Use official publisher packages/model repositories. Pin package versions, model repository commit hashes, prompt/template versions, and container image digests. Cache models locally. Do not treat model-card benchmark claims as validation; the coordinator will supply a legal-document gold set.

If one engine is not compatible with the installed stack, get the other engines working and report the precise blocker. Do not substitute a cloud OCR API.

## Worker directories and interface

Create a self-contained worker area in a sensible location owned by user `dave`, with at least:

- an immutable input/inbox area;
- a pending/running/completed/failed queue layout;
- a model/cache area;
- result JSON/JSONL and logs;
- scripts or a small service for health, enqueue, status, and result retrieval;
- a versioned README and machine-readable environment manifest.

Choose either:

- a Tailscale-only authenticated service, or
- an SSH-driven queue interface reachable as `dave@desktop.taileba32d.ts.net`.

The SSH queue is preferred if it avoids an unnecessary long-running network service. The coordinator must be able to submit a job without executing setup commands, poll it, and retrieve outputs. Provide exact non-secret commands for those operations.

## Input contract

Each job will contain one rendered page image and a JSON manifest with these required fields:

```json
{
  "schemaVersion": "inasearch-ocr-job/v1",
  "jobId": "stable-unique-id",
  "caseId": "manifest case id",
  "pageNumber": 1,
  "sourcePdfSha256": "hex sha256",
  "imageSha256": "hex sha256",
  "imageFilename": "page.png",
  "renderDpi": 300,
  "preprocessing": {
    "sourceToImageTransform": [1, 0, 0, 1, 0, 0],
    "operations": []
  },
  "requestedEngines": ["paddleocr-vl-1.6", "ovisocr2", "pp-ocrv6"]
}
```

Validate schema and hashes before inference. Reject malformed or mismatched jobs without processing them.

## Output contract

Return one result envelope per input page. Preserve every engine as a separate layer; never choose or overwrite a canonical transcription on the worker:

```json
{
  "schemaVersion": "inasearch-ocr-result/v1",
  "job": {},
  "worker": {
    "workerVersion": "git commit or content hash",
    "hostClass": "rtx-5090",
    "cudaVersion": "...",
    "containerDigest": "sha256:..."
  },
  "layers": [
    {
      "engine": "...",
      "engineVersion": "...",
      "model": "...",
      "modelRevision": "repository commit",
      "promptOrTemplateSha256": "...",
      "text": "...",
      "markdown": "...",
      "blocks": [],
      "lines": [],
      "words": [],
      "coordinateSpace": {"width": 0, "height": 0, "units": "pixels"},
      "confidence": null,
      "stopReason": "complete",
      "truncated": false,
      "runtimeMs": 0,
      "warnings": [],
      "error": null
    }
  ],
  "startedAt": "RFC3339 UTC",
  "completedAt": "RFC3339 UTC"
}
```

For PP-OCRv6, include polygon/box coordinates and native recognition scores at word or line level. For generative engines, use `null` rather than inventing confidence. Record preprocessing operations and the inverse coordinate transform needed to map boxes to the original rendered page. Record stop/truncation explicitly and retain partial output only as a failed/partial layer.

Result files should be written atomically, should contain the input hashes, and should be deterministic in naming. A failed engine must not erase successful layers from the same job.

## Validation before declaring ready

Perform local synthetic/smoke tests that prove:

- the GPU is visible in the selected isolated environment;
- each installed model loads and processes a harmless locally generated sample page;
- output conforms to the result schema and includes provenance;
- a deliberately wrong image hash is rejected;
- two retries cannot overwrite a prior result silently;
- the interface is reachable only through the agreed loopback/Tailscale/SSH path.

Do not claim OCR accuracy from the synthetic page. The coordinator will send representative case pages for a real benchmark after the interface is ready.

## Final response to the coordinator

Return a concise setup report with:

1. preflight findings;
2. everything installed, including exact pins/digests/commits;
3. which engines passed or failed smoke tests and why;
4. the worker root path;
5. exact submit/status/fetch commands that the Mac should use;
6. health-check output with secrets redacted;
7. disk used and disk remaining;
8. any action that still requires the user.
