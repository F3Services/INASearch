#!/usr/bin/env python3
"""Render case pages and collect provenance-complete OCR alternatives.

The worker never edits canonical derived documents and never selects its own
output. It appends content-addressed JSONL result records; ``import-ocr``
validates those records, and a separate adjudication command selects a layer.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from case_index.documents import atomic_write
from case_index.ocr import (
    CONTAINER_DIGEST_RE,
    OCR_PROMPT,
    OCR_PROMPT_SHA256,
    OCR_RESULT_SCHEMA_SHA256,
    OCR_RESULT_SCHEMA_VERSION,
    canonical_json,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASE_ROOT = ROOT / "sources" / "cases"
def atomic_jsonl(path: Path, records: list[dict]) -> None:
    ordered = sorted(
        records,
        key=lambda item: (
            str(item.get("caseId", "")),
            int(item.get("pageNumber", 0)),
            str(item.get("jobFingerprint", "")),
            str(item.get("resultId", "")),
        ),
    )
    value = "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in ordered)
    atomic_write(path, value.encode("utf-8"))


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def source_pdf(repo_root: Path, case_root: Path, case_id: str) -> tuple[Path, dict]:
    captures = {record["corpusKey"]: record for record in load_jsonl(case_root / "capture.jsonl")}
    if case_id not in captures:
        raise RuntimeError(f"No captured PDF for {case_id}")
    path = Path(captures[case_id]["path"])
    path = path if path.is_absolute() else repo_root / path
    value_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    if value_hash != captures[case_id]["sha256"]:
        raise RuntimeError(f"Captured PDF checksum mismatch for {case_id}")
    return path, captures[case_id]


def render_page(pdftoppm: str, pdf_path: Path, output_path: Path, page_number: int, dpi: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="inasearch-case-render-") as temporary:
        prefix = Path(temporary) / "page"
        completed = subprocess.run(
            [pdftoppm, "-f", str(page_number), "-l", str(page_number), "-r", str(dpi), "-png", "-singlefile", str(pdf_path), str(prefix)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode:
            raise RuntimeError(f"pdftoppm failed for page {page_number}: {completed.stderr.strip()}")
        rendered = prefix.with_suffix(".png")
        if not rendered.exists():
            raise RuntimeError(f"pdftoppm did not create page {page_number}")
        output_path.write_bytes(rendered.read_bytes())


def png_dimensions(path: Path) -> tuple[int, int]:
    value = path.read_bytes()[:24]
    if len(value) < 24 or value[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"Rendered page is not a PNG: {path}")
    return struct.unpack(">II", value[16:24])


def render_provenance(dpi: int, width: int, height: int) -> tuple[dict, dict]:
    scale = dpi / 72
    # Coordinates are normalized to top-left after applying the PDF page's own
    # CropBox/Rotate settings. Later crop/deskew stages append their own forward
    # and inverse matrices instead of silently changing this coordinate frame.
    transform = {
        "operation": "pdf-render",
        "sourceSpace": "pdf-page-normalized-top-left-points-after-page-rotation",
        "targetSpace": "rendered-page-pixels",
        "parameters": {"dpi": dpi, "format": "png", "renderer": "pdftoppm"},
        "forwardMatrix": [scale, 0, 0, 0, scale, 0, 0, 0, 1],
        "inverseMatrix": [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1],
    }
    return (
        {"transforms": [transform]},
        {
            "coordinateSpace": {
                "name": "rendered-page", "unit": "pixel", "origin": "top-left",
                "width": width, "height": height,
            },
            "blocks": [],
            "words": [],
        },
    )


def response_text(payload: dict) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError(f"Unexpected VLM response shape ({type(payload).__name__})") from error
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text", "")) for item in content if isinstance(item, dict) and item.get("type") == "text")
    raise RuntimeError("VLM response content was not text")


def transcribe(
    endpoint: str,
    model: str,
    image_path: Path,
    timeout: int,
    max_tokens: int,
    bearer_token_file: Path | None,
) -> dict:
    request_body = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image_path.read_bytes()).decode("ascii")}},
            ],
        }],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {"Content-Type": "application/json"}
    if bearer_token_file:
        token = bearer_token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise RuntimeError(f"Bearer token file is empty: {bearer_token_file}")
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(request_body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    choice = payload.get("choices", [{}])[0] if isinstance(payload.get("choices"), list) else {}
    stop_reason = choice.get("finish_reason") or "completed-unspecified"
    return {
        "text": response_text(payload),
        "usage": payload.get("usage", {}),
        "stopReason": stop_reason,
        "truncated": stop_reason in {"length", "max_tokens", "max_output_tokens"},
        "responseMetadata": {
            "id": payload.get("id"), "model": payload.get("model"),
            "created": payload.get("created"), "systemFingerprint": payload.get("system_fingerprint"),
        },
    }


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="OCR published-case pages using a local or approved tailnet endpoint")
    parser.add_argument("case_id")
    parser.add_argument("--case-root", type=Path, default=DEFAULT_CASE_ROOT)
    parser.add_argument("--page", action="append", type=int, help="Specific 1-based page; repeatable")
    parser.add_argument("--engine", default="openai-compatible")
    parser.add_argument("--engine-version", help="Pinned server/engine version (required for OCR)")
    parser.add_argument("--model", default="ATH-MaaS/OvisOCR2")
    parser.add_argument("--model-revision", help="Pinned model commit/revision (required for OCR)")
    parser.add_argument("--container-digest", help="Pinned sha256 container image digest (required for OCR)")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8000/v1/chat/completions")
    parser.add_argument("--bearer-token-file", type=Path, help="Read bearer token from a file; never place it on the command line")
    parser.add_argument("--allow-remote", action="store_true", help="Permit a non-loopback endpoint, such as a Tailscale-only worker")
    parser.add_argument("--all-pages", action="store_true", help="OCR every page instead of only weak native pages")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--max-tokens", type=int, default=16384)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--pdftoppm", default=shutil.which("pdftoppm"))
    parser.add_argument("--refresh", action="store_true", help="Run another attempt even when this exact job succeeded")
    parser.add_argument("--render-only", action="store_true", help="Create page PNGs without calling OCR")
    args = parser.parse_args()
    if not args.pdftoppm:
        raise RuntimeError("pdftoppm is not on PATH; pass --pdftoppm /path/to/pdftoppm")
    if args.dpi <= 0 or args.max_tokens <= 0:
        raise RuntimeError("--dpi and --max-tokens must be positive")
    if not args.render_only:
        if not args.engine_version or not args.model_revision or not args.container_digest:
            raise RuntimeError("OCR requires --engine-version, --model-revision, and --container-digest; render-only does not")
        if not CONTAINER_DIGEST_RE.fullmatch(args.container_digest):
            raise RuntimeError("--container-digest must be a sha256 image digest")
    endpoint_host = (urllib.parse.urlparse(args.endpoint).hostname or "").lower()
    if endpoint_host not in {"127.0.0.1", "localhost", "::1"} and not args.allow_remote:
        raise RuntimeError("Refusing to send page images to a remote endpoint without --allow-remote")

    case_root = args.case_root.resolve()
    document = json.loads((case_root / "derived" / f"{args.case_id}.json").read_text(encoding="utf-8"))
    pdf_path, capture = source_pdf(ROOT, case_root, args.case_id)
    available_pages = {int(page["pageNumber"]): page for page in document["pages"]}
    if args.page:
        missing = sorted(set(args.page) - set(available_pages))
        if missing:
            raise RuntimeError(f"Case {args.case_id} has no page(s): {', '.join(map(str, missing))}")
        page_numbers = sorted(set(args.page))
    else:
        page_numbers = [page["pageNumber"] for page in document["pages"] if args.all_pages or page["quality"]["needsOcr"]]
    output_path = case_root / "ocr-output" / f"{args.case_id}.jsonl"
    output = load_jsonl(output_path)
    render_root = case_root / "renders" / args.case_id
    prompt_hash = OCR_PROMPT_SHA256

    for position, page_number in enumerate(page_numbers, start=1):
        image_path = render_root / f"page-{page_number:04d}.png"
        if not image_path.exists() or args.refresh:
            render_page(args.pdftoppm, pdf_path, image_path, page_number, args.dpi)
        if args.render_only:
            print(f"[{position}/{len(page_numbers)}] rendered page {page_number}", flush=True)
            continue
        image_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
        width, height = png_dimensions(image_path)
        preprocessing, layout = render_provenance(args.dpi, width, height)
        job = {
            "caseId": args.case_id, "pageNumber": page_number,
            "sourcePdfSha256": capture["sha256"], "imageSha256": image_hash,
            "engine": {"name": args.engine, "version": args.engine_version},
            "model": {"name": args.model, "revision": args.model_revision},
            "containerDigest": args.container_digest.lower(),
            "promptSha256": prompt_hash, "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
            "decoding": {"temperature": 0, "maxTokens": args.max_tokens},
        }
        job_fingerprint = hashlib.sha256(canonical_json(job)).hexdigest()
        cached = any(item.get("jobFingerprint") == job_fingerprint and item.get("status") == "succeeded" for item in output)
        if cached and not args.refresh:
            print(f"[{position}/{len(page_numbers)}] cached page {page_number}", flush=True)
            continue

        started_at = utc_now()
        started = time.monotonic()
        errors: list[dict] = []
        result = {"text": "", "usage": {}, "stopReason": "error", "truncated": False, "responseMetadata": {}}
        try:
            result = transcribe(args.endpoint, args.model, image_path, args.timeout, args.max_tokens, args.bearer_token_file)
            if not result["text"].strip():
                raise RuntimeError("OCR endpoint returned empty text")
            status = "succeeded"
        except Exception as error:
            status = "failed"
            errors.append({"type": type(error).__name__, "message": str(error)[:2000]})
        finished_at = utc_now()
        record = {
            "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
            "caseId": args.case_id, "pageNumber": page_number, "status": status, "text": result["text"],
            "engine": job["engine"], "model": job["model"], "containerDigest": job["containerDigest"],
            "sourcePdfSha256": job["sourcePdfSha256"], "imageSha256": job["imageSha256"],
            "render": {"dpi": args.dpi, "format": "png", "width": width, "height": height},
            "preprocessing": preprocessing, "promptSha256": prompt_hash,
            "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256, "layout": layout, "confidence": None,
            "termination": {"stopReason": result["stopReason"], "truncated": result["truncated"]},
            "runtime": {"milliseconds": round((time.monotonic() - started) * 1000, 3), "startedAt": started_at, "finishedAt": finished_at},
            "decoding": job["decoding"], "usage": result["usage"],
            "responseMetadata": result["responseMetadata"], "errors": errors,
            "jobFingerprint": job_fingerprint,
        }
        record["resultId"] = "ocr-result-" + hashlib.sha256(canonical_json(record)).hexdigest()[:32]
        output.append(record)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_jsonl(output_path, output)
        print(f"[{position}/{len(page_numbers)}] {status} page {page_number}", flush=True)
    print(render_root if args.render_only else output_path)


if __name__ == "__main__":
    main()
