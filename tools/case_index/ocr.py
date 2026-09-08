"""Provenance and validation contract for page-level OCR alternatives.

OCR is evidence, not an automatic replacement for text extracted from the
publisher PDF.  This module normalizes both the original worker's flat JSONL
records and the richer v2 contract into immutable, content-addressed layers.
Selection is deliberately handled separately by ``documents.py``.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


OCR_RESULT_SCHEMA_VERSION = 2
OCR_LAYER_SCHEMA_VERSION = 2
SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
CONTAINER_DIGEST_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$", re.IGNORECASE)
OCR_SAFE_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
OCR_WORKER_COMMIT_RE = re.compile(r"^[0-9a-f]{40,64}$")
OCR_RECOVERY_PROVENANCE_SCHEMA = "inasearch-ocr-recovery-job/v1"
OCR_RECOVERY_PROVENANCE_FIELDS = frozenset({
    "schemaVersion", "originalJobId", "recoveryJobId",
    "originalManifestSha256", "originalImageSha256", "workerCommit",
})
OCR_PROMPT = """Extract every readable character from this legal-decision page in natural human reading order.
Return one Markdown document only. Preserve spelling, punctuation, section symbols, legal citations,
parenthetical unit labels, footnote markers, headings, and page numbers exactly as written. Do not
translate, summarize, correct, complete, or paraphrase the source. Use Markdown footnotes where the
page has footnotes and HTML tables for tables. If a character is unreadable, write ⟦unclear⟧ instead
of guessing. Do not add commentary."""

# This compact contract is hashed into every v2 worker result.  Keeping the
# contract as data makes drift detectable without requiring a JSON Schema
# package on either the Mac or the GPU worker.
OCR_RESULT_CONTRACT: dict[str, Any] = {
    "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
    "required": [
        "caseId", "pageNumber", "status", "engine", "model",
        "containerDigest", "sourcePdfSha256", "imageSha256", "render",
        "preprocessing", "promptSha256", "outputSchemaSha256", "text",
        "layout", "termination", "runtime", "errors",
    ],
    "engine": {"required": ["name", "version"]},
    "model": {"required": ["name", "revision"]},
    "layout": {
        "coordinateSpace": "rendered-page-pixels-top-left",
        "itemCoordinates": "bbox:[x0,y0,x1,y1]",
    },
    "selection": "never implicit; a separate human/model adjudication selects a layer",
}


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


OCR_RESULT_SCHEMA_SHA256 = hashlib.sha256(canonical_json(OCR_RESULT_CONTRACT)).hexdigest()
OCR_PROMPT_SHA256 = hashlib.sha256(OCR_PROMPT.encode("utf-8")).hexdigest()


def _sha256_or_none(value: Any, field: str, *, required: bool = False) -> str | None:
    if value in (None, ""):
        if required:
            raise RuntimeError(f"OCR record is missing {field}")
        return None
    normalized = str(value).lower()
    if not SHA256_RE.fullmatch(normalized):
        raise RuntimeError(f"OCR {field} is not a SHA-256 hex digest")
    return normalized


def normalize_ocr_recovery_provenance(
    value: Any,
    *,
    recovery_job_id: Any,
    image_sha256: Any,
    worker_commit: Any | None = None,
) -> dict | None:
    """Validate the explicit mapping for an immutable-ID OCR recovery job.

    The locally trusted manifest may authorize exactly one exception to the
    normal Hermes image-filename rule: the envelope keeps the original input
    filename while its embedded jobId uses a new immutable recovery ID.  This
    compact record makes that mapping content-addressed and auditable.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise RuntimeError("OCR recoveryProvenance must be an object")
    fields = set(value)
    missing = sorted(OCR_RECOVERY_PROVENANCE_FIELDS - fields)
    unexpected = sorted(fields - OCR_RECOVERY_PROVENANCE_FIELDS)
    if missing or unexpected:
        raise RuntimeError(
            "OCR recoveryProvenance fields do not match the v1 contract; "
            f"missing={missing}, unexpected={unexpected}"
        )
    if value.get("schemaVersion") != OCR_RECOVERY_PROVENANCE_SCHEMA:
        raise RuntimeError("OCR recoveryProvenance has an unsupported schemaVersion")

    original_job_id = value.get("originalJobId")
    mapped_recovery_job_id = value.get("recoveryJobId")
    if not isinstance(original_job_id, str) or not OCR_SAFE_JOB_ID_RE.fullmatch(original_job_id):
        raise RuntimeError("OCR recoveryProvenance originalJobId is not a safe job ID")
    if (
        not isinstance(mapped_recovery_job_id, str)
        or not OCR_SAFE_JOB_ID_RE.fullmatch(mapped_recovery_job_id)
    ):
        raise RuntimeError("OCR recoveryProvenance recoveryJobId is not a safe job ID")
    if original_job_id == mapped_recovery_job_id:
        raise RuntimeError("OCR recoveryProvenance must map two distinct job IDs")
    if mapped_recovery_job_id != recovery_job_id:
        raise RuntimeError("OCR recoveryProvenance recoveryJobId does not match the OCR jobId")

    original_manifest_sha256 = _sha256_or_none(
        value.get("originalManifestSha256"),
        "recoveryProvenance.originalManifestSha256",
        required=True,
    )
    original_image_sha256 = _sha256_or_none(
        value.get("originalImageSha256"),
        "recoveryProvenance.originalImageSha256",
        required=True,
    )
    normalized_image_sha256 = _sha256_or_none(
        image_sha256, "imageSha256", required=True,
    )
    if original_image_sha256 != normalized_image_sha256:
        raise RuntimeError(
            "OCR recoveryProvenance originalImageSha256 does not match the OCR imageSha256"
        )

    recovery_worker_commit = str(value.get("workerCommit") or "").lower()
    if not OCR_WORKER_COMMIT_RE.fullmatch(recovery_worker_commit):
        raise RuntimeError("OCR recoveryProvenance workerCommit is not a pinned worker commit")
    if worker_commit is not None:
        normalized_worker_commit = str(worker_commit or "").lower()
        if recovery_worker_commit != normalized_worker_commit:
            raise RuntimeError(
                "OCR recoveryProvenance workerCommit does not match the OCR worker"
            )

    return {
        "schemaVersion": OCR_RECOVERY_PROVENANCE_SCHEMA,
        "originalJobId": original_job_id,
        "recoveryJobId": mapped_recovery_job_id,
        "originalManifestSha256": original_manifest_sha256,
        "originalImageSha256": original_image_sha256,
        "workerCommit": recovery_worker_commit,
    }


def _confidence_or_none(value: Any, field: str = "confidence") -> float | None:
    if value in (None, ""):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"OCR {field} is not numeric") from error
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise RuntimeError(f"OCR {field} must be between 0 and 1")
    return result


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise RuntimeError(f"OCR {field} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"OCR {field} must be numeric") from error
    if not math.isfinite(result):
        raise RuntimeError(f"OCR {field} must be finite")
    return result


def _integer_or_none(value: Any, field: str, *, minimum: int = 0) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise RuntimeError(f"OCR {field} must be an integer or null")
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"OCR {field} must be an integer or null") from error
    if isinstance(value, float) and not value.is_integer():
        raise RuntimeError(f"OCR {field} must be an integer or null")
    if result < minimum:
        raise RuntimeError(f"OCR {field} must be at least {minimum}")
    return result


def _normalize_layout(item: dict) -> dict:
    layout = item.get("layout") if isinstance(item.get("layout"), dict) else {}
    coordinate_space = layout.get("coordinateSpace") or item.get("coordinateSpace") or {}
    if not isinstance(coordinate_space, dict):
        raise RuntimeError("OCR layout.coordinateSpace must be an object")
    width = coordinate_space.get("width")
    height = coordinate_space.get("height")
    if width is not None:
        width = _number(width, "coordinateSpace.width")
        if width <= 0:
            raise RuntimeError("OCR coordinateSpace.width must be positive")
    if height is not None:
        height = _number(height, "coordinateSpace.height")
        if height <= 0:
            raise RuntimeError("OCR coordinateSpace.height must be positive")
    normalized_space = {
        "name": str(coordinate_space.get("name") or "rendered-page"),
        "unit": str(coordinate_space.get("unit") or "pixel"),
        "origin": str(coordinate_space.get("origin") or "top-left"),
        "width": width,
        "height": height,
    }
    if normalized_space["unit"] != "pixel" or normalized_space["origin"] != "top-left":
        raise RuntimeError("OCR coordinates must use top-left rendered-page pixels")

    def normalize_items(values: Any, kind: str) -> list[dict]:
        if values in (None, []):
            return []
        if not isinstance(values, list):
            raise RuntimeError(f"OCR layout.{kind} must be an array")
        output: list[dict] = []
        for position, raw in enumerate(values):
            if not isinstance(raw, dict):
                raise RuntimeError(f"OCR {kind}[{position}] must be an object")
            bbox = raw.get("bbox")
            if not isinstance(bbox, list) or len(bbox) != 4:
                raise RuntimeError(f"OCR {kind}[{position}].bbox must be [x0,y0,x1,y1]")
            x0, y0, x1, y1 = [_number(value, f"{kind}[{position}].bbox") for value in bbox]
            if x0 < 0 or y0 < 0 or x1 < x0 or y1 < y0:
                raise RuntimeError(f"OCR {kind}[{position}] has an invalid bbox")
            if width is not None and x1 > width + 0.01:
                raise RuntimeError(f"OCR {kind}[{position}] exceeds coordinate-space width")
            if height is not None and y1 > height + 0.01:
                raise RuntimeError(f"OCR {kind}[{position}] exceeds coordinate-space height")
            text = raw.get("text", "")
            if not isinstance(text, str):
                raise RuntimeError(f"OCR {kind}[{position}].text must be a string")
            normalized = {
                "id": str(raw.get("id") or f"{kind[:-1]}-{position + 1}"),
                "text": text,
                "bbox": [x0, y0, x1, y1],
                "confidence": _confidence_or_none(raw.get("confidence"), f"{kind}[{position}].confidence"),
            }
            polygon = raw.get("polygon")
            if polygon is not None:
                if not isinstance(polygon, list) or len(polygon) < 3:
                    raise RuntimeError(f"OCR {kind}[{position}].polygon must contain at least three points")
                normalized_polygon: list[list[float]] = []
                for point_index, point in enumerate(polygon):
                    if not isinstance(point, list) or len(point) != 2:
                        raise RuntimeError(
                            f"OCR {kind}[{position}].polygon[{point_index}] must be [x,y]"
                        )
                    px, py = [_number(value, f"{kind}[{position}].polygon") for value in point]
                    if px < 0 or py < 0:
                        raise RuntimeError(f"OCR {kind}[{position}].polygon has a negative coordinate")
                    if width is not None and px > width + 0.01:
                        raise RuntimeError(f"OCR {kind}[{position}].polygon exceeds coordinate-space width")
                    if height is not None and py > height + 0.01:
                        raise RuntimeError(f"OCR {kind}[{position}].polygon exceeds coordinate-space height")
                    normalized_polygon.append([px, py])
                normalized["polygon"] = normalized_polygon
            # Reading-order and parent identifiers are useful, but remain
            # optional because not every deterministic OCR engine emits them.
            for name in (
                "parentId", "role", "readingOrder", "language", "label",
                "blockId", "lineId", "wordIds", "lineIds", "semanticUnit",
                "index", "lineIndex", "tokenIndex",
            ):
                if name in raw:
                    normalized[name] = raw[name]
            for confidence_name in ("layoutConfidence", "containingLineConfidence"):
                if confidence_name in raw:
                    normalized[confidence_name] = _confidence_or_none(
                        raw[confidence_name], f"{kind}[{position}].{confidence_name}"
                    )
            if "modelCoordinates1000" in raw:
                coordinates = raw["modelCoordinates1000"]
                if not isinstance(coordinates, list) or len(coordinates) != 4:
                    raise RuntimeError(
                        f"OCR {kind}[{position}].modelCoordinates1000 must be [x0,y0,x1,y1]"
                    )
                normalized["modelCoordinates1000"] = [
                    _number(value, f"{kind}[{position}].modelCoordinates1000")
                    for value in coordinates
                ]
            output.append(normalized)
        return output

    return {
        "coordinateSpace": normalized_space,
        "blocks": normalize_items(layout.get("blocks", item.get("blocks", [])), "blocks"),
        "lines": normalize_items(layout.get("lines", item.get("lines", [])), "lines"),
        "words": normalize_items(layout.get("words", item.get("words", [])), "words"),
    }


def _normalize_preprocessing(item: dict) -> dict:
    raw = item.get("preprocessing") or {}
    if not isinstance(raw, dict):
        raise RuntimeError("OCR preprocessing must be an object")
    transforms = raw.get("transforms", [])
    if not isinstance(transforms, list):
        raise RuntimeError("OCR preprocessing.transforms must be an array")
    normalized: list[dict] = []

    def multiply(left: list[float], right: list[float]) -> list[float]:
        return [
            sum(left[row * 3 + offset] * right[offset * 3 + column] for offset in range(3))
            for row in range(3) for column in range(3)
        ]

    for position, transform in enumerate(transforms):
        if not isinstance(transform, dict) or not transform.get("operation"):
            raise RuntimeError(f"OCR preprocessing transform {position} needs an operation")
        value = dict(transform)
        for matrix_name in ("forwardMatrix", "inverseMatrix"):
            matrix = value.get(matrix_name)
            if matrix is not None:
                if not isinstance(matrix, list) or len(matrix) != 9:
                    raise RuntimeError(f"OCR preprocessing {matrix_name} must have nine values")
                value[matrix_name] = [_number(cell, f"preprocessing.{matrix_name}") for cell in matrix]
        if value.get("forwardMatrix") is None or value.get("inverseMatrix") is None:
            raise RuntimeError(f"OCR preprocessing transform {position} requires forward and inverse matrices")
        product = multiply(value["forwardMatrix"], value["inverseMatrix"])
        identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        if any(abs(actual - expected) > 1e-4 for actual, expected in zip(product, identity)):
            raise RuntimeError(f"OCR preprocessing transform {position} matrices are not inverses")
        normalized.append(value)
    return {"transforms": normalized}


def _legacy_layer(item: dict, case_id: str, page_number: int, source_pdf_sha256: str) -> dict:
    text = str(item.get("text", ""))
    if not text.strip():
        raise RuntimeError(f"OCR page {page_number} has no text")
    source_hash = _sha256_or_none(item.get("sourcePdfSha256"), "sourcePdfSha256")
    if source_hash and source_hash != source_pdf_sha256:
        raise RuntimeError(f"OCR page {page_number} was rendered from a different source PDF")
    provenance = {
        "resultSchemaVersion": int(item.get("schemaVersion", 1)),
        "completeness": "legacy-partial",
        "engine": {"name": "legacy-openai-compatible-worker", "version": None},
        "model": {"name": str(item.get("model", "unspecified")), "revision": None},
        "containerDigest": None,
        "promptSha256": _sha256_or_none(item.get("promptSha256"), "promptSha256"),
        "outputSchemaSha256": None,
        "decoding": item.get("decoding"),
    }
    content = {
        "schemaVersion": OCR_LAYER_SCHEMA_VERSION,
        "status": "succeeded",
        "caseId": case_id,
        "pageNumber": page_number,
        "text": text,
        "source": {
            "pdfSha256": source_hash or source_pdf_sha256,
            "imageSha256": _sha256_or_none(item.get("imageSha256"), "imageSha256"),
        },
        "render": {"dpi": item.get("renderDpi")},
        "preprocessing": {"transforms": []},
        "layout": {
            "coordinateSpace": {"name": "rendered-page", "unit": "pixel", "origin": "top-left", "width": None, "height": None},
            "blocks": [],
            "words": [],
        },
        "provenance": provenance,
        "quality": {"confidence": _confidence_or_none(item.get("confidence"))},
        "termination": {"stopReason": None, "truncated": None},
        "runtime": {"milliseconds": None},
        "usage": item.get("usage") or {},
        "errors": [],
    }
    content["layerId"] = "ocr-" + hashlib.sha256(canonical_json(content)).hexdigest()[:32]
    return content


def normalize_ocr_result(item: dict, case_id: str, page_number: int, source_pdf_sha256: str) -> dict:
    """Validate and normalize one OCR result into an immutable layer."""
    if not isinstance(item, dict):
        raise RuntimeError("OCR JSONL rows must be objects")
    schema_version = int(item.get("schemaVersion", 1))
    if schema_version < OCR_RESULT_SCHEMA_VERSION:
        return _legacy_layer(item, case_id, page_number, source_pdf_sha256)
    if schema_version != OCR_RESULT_SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported OCR schemaVersion {schema_version}")
    if item.get("caseId") != case_id:
        raise RuntimeError(f"OCR row caseId {item.get('caseId')!r} does not match {case_id}")
    if int(item.get("pageNumber", -1)) != page_number:
        raise RuntimeError(f"OCR row pageNumber does not match page {page_number}")

    source_hash = _sha256_or_none(item.get("sourcePdfSha256"), "sourcePdfSha256", required=True)
    if source_hash != source_pdf_sha256:
        raise RuntimeError(f"OCR page {page_number} was rendered from a different source PDF")
    image_hash = _sha256_or_none(item.get("imageSha256"), "imageSha256", required=True)
    engine = item.get("engine")
    model = item.get("model")
    if not isinstance(engine, dict) or not str(engine.get("name", "")).strip() or not str(engine.get("version", "")).strip():
        raise RuntimeError("OCR v2 engine requires non-empty name and version")
    if not isinstance(model, dict) or not str(model.get("name", "")).strip() or not str(model.get("revision", "")).strip():
        raise RuntimeError("OCR v2 model requires non-empty name and revision")
    container_digest = str(item.get("containerDigest", "")).lower()
    if not CONTAINER_DIGEST_RE.fullmatch(container_digest):
        raise RuntimeError("OCR v2 containerDigest must be a sha256 image digest")
    prompt_hash = _sha256_or_none(item.get("promptSha256"), "promptSha256")
    schema_hash = _sha256_or_none(item.get("outputSchemaSha256"), "outputSchemaSha256", required=True)
    if schema_hash != OCR_RESULT_SCHEMA_SHA256:
        raise RuntimeError("OCR outputSchemaSha256 does not match the supported v2 contract")
    status = str(item.get("status", "succeeded"))
    if status not in {"succeeded", "failed"}:
        raise RuntimeError("OCR status must be succeeded or failed")
    text = item.get("text", "")
    if not isinstance(text, str):
        raise RuntimeError("OCR text must be a string")
    errors = item.get("errors", [])
    if not isinstance(errors, list):
        raise RuntimeError("OCR errors must be an array")
    errors = [dict(error) if isinstance(error, dict) else {"message": str(error)} for error in errors]
    if status == "succeeded" and not text.strip():
        raise RuntimeError(f"Successful OCR page {page_number} has no text")
    if status == "failed" and not errors:
        raise RuntimeError(f"Failed OCR page {page_number} has no error detail")

    render = item.get("render") or {}
    if not isinstance(render, dict):
        raise RuntimeError("OCR render must be an object")
    dpi = int(render.get("dpi", item.get("renderDpi", 0)) or 0)
    if dpi <= 0:
        raise RuntimeError("OCR render.dpi must be positive")
    termination = item.get("termination") or {}
    if not isinstance(termination, dict):
        raise RuntimeError("OCR termination must be an object")
    truncation_known = termination.get("truncationKnown", True)
    if truncation_known not in {True, False}:
        raise RuntimeError("OCR termination.truncationKnown must be boolean")
    truncated = termination.get("truncated")
    if truncation_known:
        if truncated not in {True, False}:
            raise RuntimeError("OCR known termination.truncated must be boolean")
    elif truncated is not None:
        raise RuntimeError("OCR unknown termination.truncated must be null")
    stop_reason = termination.get("stopReason")
    if stop_reason is not None and not isinstance(stop_reason, str):
        raise RuntimeError("OCR termination.stopReason must be a string or null")
    finish_reason = termination.get("finishReason")
    if finish_reason is not None and not isinstance(finish_reason, str):
        raise RuntimeError("OCR termination.finishReason must be a string or null")
    if stop_reason == "complete" and (not truncation_known or truncated is not False):
        raise RuntimeError("OCR complete termination must be known and non-truncated")
    output_token_count = _integer_or_none(item.get("outputTokenCount"), "outputTokenCount")
    max_output_tokens = _integer_or_none(
        item.get("maxOutputTokens"), "maxOutputTokens", minimum=1
    )
    runtime = item.get("runtime") or {}
    if not isinstance(runtime, dict):
        raise RuntimeError("OCR runtime must be an object")
    milliseconds = runtime.get("milliseconds")
    if milliseconds is not None:
        milliseconds = _number(milliseconds, "runtime.milliseconds")
        if milliseconds < 0:
            raise RuntimeError("OCR runtime.milliseconds must not be negative")
    if milliseconds is None:
        raise RuntimeError("OCR v2 runtime.milliseconds is required")

    preprocessing = _normalize_preprocessing(item)
    if not preprocessing["transforms"]:
        raise RuntimeError("OCR v2 must record at least the source-image/render preprocessing transform")
    layout = _normalize_layout(item)
    if layout["coordinateSpace"]["width"] is None or layout["coordinateSpace"]["height"] is None:
        raise RuntimeError("OCR v2 must record coordinate-space width and height")
    usage = item.get("usage") or {}
    if not isinstance(usage, dict):
        raise RuntimeError("OCR usage must be an object")
    audit = item.get("audit") or {}
    if not isinstance(audit, dict):
        raise RuntimeError("OCR audit must be an object")
    provenance_completeness = str(item.get("provenanceCompleteness") or "complete")

    content = {
        "schemaVersion": OCR_LAYER_SCHEMA_VERSION,
        "status": status,
        "caseId": case_id,
        "pageNumber": page_number,
        "text": text,
        "source": {"pdfSha256": source_hash, "imageSha256": image_hash},
        "render": {**render, "dpi": dpi},
        "preprocessing": preprocessing,
        "layout": layout,
        "provenance": {
            "resultSchemaVersion": schema_version,
            "completeness": provenance_completeness,
            "engine": {"name": str(engine["name"]), "version": str(engine["version"])},
            "model": {"name": str(model["name"]), "revision": str(model["revision"])},
            "containerDigest": container_digest,
            "promptSha256": prompt_hash,
            "outputSchemaSha256": schema_hash,
            "jobFingerprint": item.get("jobFingerprint"),
            "remoteResultId": item.get("resultId"),
            "decoding": item.get("decoding") or {},
        },
        "quality": {"confidence": _confidence_or_none(item.get("confidence"))},
        "termination": {
            "stopReason": stop_reason,
            "finishReason": finish_reason,
            "truncationKnown": truncation_known,
            "truncated": truncated,
        },
        "runtime": {
            "milliseconds": milliseconds,
            "startedAt": runtime.get("startedAt"),
            "finishedAt": runtime.get("finishedAt"),
        },
        "usage": {
            **usage,
            "outputTokenCount": output_token_count,
            "maxOutputTokens": max_output_tokens,
        },
        "audit": audit,
        "errors": errors,
    }
    if isinstance(item.get("markdown"), str):
        content["markdown"] = item["markdown"]
    warnings = item.get("warnings", [])
    if warnings not in (None, []):
        if not isinstance(warnings, list):
            raise RuntimeError("OCR warnings must be an array")
        content["warnings"] = [
            dict(warning) if isinstance(warning, dict) else {"message": str(warning)}
            for warning in warnings
        ]
    worker = item.get("worker")
    if worker is not None:
        if not isinstance(worker, dict):
            raise RuntimeError("OCR worker provenance must be an object")
        content["provenance"]["worker"] = worker
    raw_recovery_provenance = item.get("recoveryProvenance")
    if raw_recovery_provenance is not None and (
        not isinstance(worker, dict) or not worker.get("workerVersion")
    ):
        raise RuntimeError("OCR recoveryProvenance requires pinned worker provenance")
    recovery_provenance = normalize_ocr_recovery_provenance(
        raw_recovery_provenance,
        recovery_job_id=item.get("jobId"),
        image_sha256=image_hash,
        worker_commit=(
            worker["workerVersion"]
            if raw_recovery_provenance is not None and isinstance(worker, dict)
            else None
        ),
    )
    if recovery_provenance is not None:
        content["provenance"]["recovery"] = recovery_provenance
    remote_job = item.get("remoteJob")
    if remote_job is not None:
        if not isinstance(remote_job, dict):
            raise RuntimeError("OCR remoteJob provenance must be an object")
        content["provenance"]["remoteJob"] = remote_job
    layer_provenance = item.get("layerProvenance")
    if layer_provenance is not None:
        if not isinstance(layer_provenance, dict):
            raise RuntimeError("OCR layerProvenance must be an object")
        content["provenance"]["layer"] = layer_provenance
    coordinate_mapping = item.get("remoteCoordinateMapping")
    if coordinate_mapping is not None:
        if not isinstance(coordinate_mapping, dict):
            raise RuntimeError("OCR remoteCoordinateMapping must be an object")
        content["provenance"]["remoteCoordinateMapping"] = coordinate_mapping
    for name in ("remoteEnvelopeSha256", "remoteLayerIndex", "workerResultSchemaVersion"):
        if name in item:
            content["provenance"][name] = item[name]
    # importedAt is intentionally excluded: identical evidence imported twice
    # must address the same layer instead of creating duplicates.
    content["layerId"] = "ocr-" + hashlib.sha256(canonical_json(content)).hexdigest()[:32]
    return content


def layer_is_selectable(layer: dict) -> bool:
    return bool(
        layer.get("status") == "succeeded"
        and str(layer.get("text", "")).strip()
        and layer.get("termination", {}).get("truncationKnown") is True
        and layer.get("termination", {}).get("truncated") is False
        and not layer.get("errors")
    )
