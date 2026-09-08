"""Validate Hermes OCR envelopes and flatten their engine layers for import.

Hermes deliberately returns one multi-engine envelope per page, while the
local OCR store addresses one immutable engine/model/page attempt per JSONL
row.  This adapter is the only bridge between those contracts.  It verifies
the embedded job against the locally exported rich manifest and page image,
then emits provenance-complete schema-v2 rows without selecting any text.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

from .documents import atomic_write, load_jsonl
from .ocr import (
    CONTAINER_DIGEST_RE,
    OCR_RESULT_SCHEMA_SHA256,
    OCR_RESULT_SCHEMA_VERSION,
    OCR_SAFE_JOB_ID_RE,
    SHA256_RE,
    canonical_json,
    normalize_ocr_recovery_provenance,
    normalize_ocr_result,
)


HERMES_JOB_SCHEMA = "inasearch-ocr-job/v1"
HERMES_RESULT_SCHEMA = "inasearch-ocr-result/v1"
HERMES_ENGINES = {"paddleocr-vl-1.6", "ovisocr2", "pp-ocrv6"}
WORKER_COMMIT_RE = re.compile(r"^[0-9a-f]{40,64}$")
HERMES_CANONICAL_RESULT_NAME_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}--[0-9a-f]{64}\.json$"
)
CORRECTED_STOP_REASONS = {"complete", "finished", "truncated", "error", None}
SAFE_WORKER_FIELDS = (
    "workerVersion", "hostClass", "cudaVersion", "containerDigest",
    "driverVersion", "pytorchVersion", "paddleVersion", "pythonVersion",
    "environmentManifestSha256",
)
CORRECTED_PROVENANCE_COMPLETENESS = "complete-per-layer"
LEGACY_PROVENANCE_COMPLETENESS = "legacy-worker-level-runtime"
SOFTWARE_PROVENANCE_FIELDS = (
    "cudaRuntime", "cudnn", "paddle", "torch", "vllm", "nvidiaDriver",
)
OVIS_EXECUTOR_SHA256_FIELD = "ovisFileStoreExecutorSha256"
CORRECTED_LAYER_REQUIRED_FIELDS = (
    "engine", "engineVersion", "model", "modelRevision", "promptOrTemplateSha256",
    "provenance", "text", "markdown", "blocks", "lines", "words",
    "coordinateSpace", "confidence", "stopReason", "finishReason",
    "outputTokenCount", "maxOutputTokens", "truncationKnown", "truncated",
    "runtimeMs", "warnings", "error", "audit",
)
NON_GEOMETRIC_OPERATIONS = {
    "contrast", "contrast-adjustment", "binarization", "denoise", "sharpen",
    "color-conversion", "grayscale", "normalization",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _digest(value: Any, field: str, *, container: bool = False) -> str:
    normalized = str(value or "").lower()
    pattern = CONTAINER_DIGEST_RE if container else SHA256_RE
    if not pattern.fullmatch(normalized):
        kind = "container digest" if container else "SHA-256 digest"
        raise RuntimeError(f"Hermes {field} is not a valid {kind}")
    return normalized


def normalize_worker_commit_pin(value: str | None) -> str | None:
    """Normalize an optional exact worker-commit acceptance pin."""
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not WORKER_COMMIT_RE.fullmatch(normalized):
        raise RuntimeError("Expected Hermes worker commit must be 40-64 lowercase hex digits")
    return normalized


def normalize_ovis_executor_pin(value: str | None) -> str | None:
    """Normalize an optional exact Ovis FileStore executor source hash pin."""
    if value is None:
        return None
    return _digest(value, f"expected {OVIS_EXECUTOR_SHA256_FIELD}")


def validate_flat_result_provenance_pins(
    result: dict,
    *,
    expected_worker_commit: str | None = None,
    expected_ovis_file_store_executor_sha256: str | None = None,
    context: str = "Hermes OCR result",
) -> None:
    """Apply opt-in release pins to one converted Hermes engine layer.

    Internal envelope/layer agreement is necessary but does not establish that
    the result came from the worker release accepted for a particular batch.
    These caller-supplied pins provide that second, external gate while their
    omission keeps historical converted evidence readable.
    """
    worker_pin = normalize_worker_commit_pin(expected_worker_commit)
    executor_pin = normalize_ovis_executor_pin(
        expected_ovis_file_store_executor_sha256
    )
    worker = result.get("worker")
    layer = result.get("layerProvenance")
    if worker_pin is not None:
        if (
            not isinstance(worker, dict)
            or str(worker.get("workerVersion") or "").lower() != worker_pin
        ):
            raise RuntimeError(f"{context} does not match expected worker commit {worker_pin}")
        if (
            not isinstance(layer, dict)
            or str(layer.get("workerGitCommit") or "").lower() != worker_pin
        ):
            raise RuntimeError(
                f"{context} layer provenance does not match expected worker commit {worker_pin}"
            )

    engine = result.get("engine")
    engine_name = str(engine.get("name") if isinstance(engine, dict) else engine or "")
    if engine_name != "ovisocr2":
        return
    software = layer.get("software") if isinstance(layer, dict) else None
    if isinstance(software, dict) and OVIS_EXECUTOR_SHA256_FIELD in software:
        actual_executor = _digest(
            software[OVIS_EXECUTOR_SHA256_FIELD],
            f"{context} Ovis {OVIS_EXECUTOR_SHA256_FIELD}",
        )
    else:
        actual_executor = None
    if executor_pin is not None and actual_executor != executor_pin:
        raise RuntimeError(
            f"{context} does not match expected Ovis FileStore executor SHA-256 "
            f"{executor_pin}"
        )


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise RuntimeError(f"Hermes {field} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"Hermes {field} must be numeric") from error
    if not math.isfinite(result):
        raise RuntimeError(f"Hermes {field} must be finite")
    return result


def _integer_or_none(value: Any, field: str, *, minimum: int = 0) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise RuntimeError(f"Hermes {field} must be an integer or null")
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"Hermes {field} must be an integer or null") from error
    if isinstance(value, float) and not value.is_integer():
        raise RuntimeError(f"Hermes {field} must be an integer or null")
    if result < minimum:
        raise RuntimeError(f"Hermes {field} must be at least {minimum}")
    return result


def _confidence_or_none(value: Any, field: str) -> float | None:
    if value in (None, ""):
        return None
    result = _number(value, field)
    if not 0 <= result <= 1:
        raise RuntimeError(f"Hermes {field} must be between 0 and 1")
    return result


def _matrix9(value: Any, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) not in {6, 9}:
        raise RuntimeError(f"Hermes {field} must be a six-value affine or 3x3 matrix")
    cells = [_number(cell, field) for cell in value]
    if len(cells) == 6:
        # Hermes/CSS order: [a,b,c,d,e,f], with
        # x'=a*x+c*y+e and y'=b*x+d*y+f.
        a, b, c, d, e, f = cells
        return [a, c, e, b, d, f, 0.0, 0.0, 1.0]
    if any(abs(actual - expected) > 1e-9 for actual, expected in zip(cells[6:], [0, 0, 1])):
        raise RuntimeError(f"Hermes {field} must be affine")
    return cells


def _inverse(matrix: list[float], field: str) -> list[float]:
    a, c, e, b, d, f, _x, _y, _one = matrix
    determinant = a * d - b * c
    if abs(determinant) < 1e-12:
        raise RuntimeError(f"Hermes {field} is not invertible")
    return [
        d / determinant, -c / determinant, (c * f - d * e) / determinant,
        -b / determinant, a / determinant, (b * e - a * f) / determinant,
        0.0, 0.0, 1.0,
    ]


def _matrices_close(left: list[float], right: list[float], tolerance: float = 1e-6) -> bool:
    return len(left) == len(right) and all(abs(a - b) <= tolerance for a, b in zip(left, right))


def _normalize_operation(raw: Any, position: int) -> dict:
    if not isinstance(raw, dict):
        raise RuntimeError(f"Hermes preprocessing operation {position} must be an object")
    operation = str(raw.get("operation") or raw.get("name") or "").strip()
    if not operation:
        raise RuntimeError(f"Hermes preprocessing operation {position} needs a name")
    forward_raw = raw.get("forwardMatrix", raw.get("transform", raw.get("matrix")))
    inverse_raw = raw.get("inverseMatrix", raw.get("inverseTransform"))
    if forward_raw is None:
        if operation.lower() not in NON_GEOMETRIC_OPERATIONS:
            raise RuntimeError(
                f"Hermes geometric preprocessing operation {operation!r} lacks a forward transform"
            )
        forward = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    else:
        forward = _matrix9(forward_raw, f"preprocessing.operations[{position}].forwardMatrix")
    calculated_inverse = _inverse(forward, f"preprocessing.operations[{position}].forwardMatrix")
    if inverse_raw is None and forward_raw is not None:
        raise RuntimeError(
            f"Hermes preprocessing operation {position} lacks the required inverse transform"
        )
    inverse = (
        _matrix9(inverse_raw, f"preprocessing.operations[{position}].inverseMatrix")
        if inverse_raw is not None else calculated_inverse
    )
    if not _matrices_close(inverse, calculated_inverse, 1e-5):
        raise RuntimeError(f"Hermes preprocessing operation {position} matrices are not inverses")
    normalized = {
        "operation": operation,
        "forwardMatrix": forward,
        "inverseMatrix": inverse,
    }
    for name in ("sourceSpace", "targetSpace", "parameters", "reason"):
        if name in raw:
            normalized[name] = raw[name]
    return normalized


def _polygon(value: Any, field: str) -> list[list[float]] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise RuntimeError(f"Hermes {field} must be an array")
    if value and all(not isinstance(cell, list) for cell in value):
        if len(value) < 6 or len(value) % 2:
            raise RuntimeError(f"Hermes {field} flat polygon must contain x/y pairs")
        value = [value[index:index + 2] for index in range(0, len(value), 2)]
    if len(value) < 3:
        raise RuntimeError(f"Hermes {field} must contain at least three points")
    points: list[list[float]] = []
    for point_index, point in enumerate(value):
        if not isinstance(point, list) or len(point) != 2:
            raise RuntimeError(f"Hermes {field}[{point_index}] must be [x,y]")
        points.append([_number(point[0], field), _number(point[1], field)])
    return points


def _layout_items(values: Any, kind: str) -> list[dict]:
    if values in (None, []):
        return []
    if not isinstance(values, list):
        raise RuntimeError(f"Hermes {kind} must be an array")
    output = []
    for position, raw in enumerate(values):
        if not isinstance(raw, dict):
            raise RuntimeError(f"Hermes {kind}[{position}] must be an object")
        polygon = _polygon(raw.get("polygon", raw.get("points")), f"{kind}[{position}].polygon")
        bbox_raw = raw.get("bbox", raw.get("box"))
        if bbox_raw is None and polygon:
            xs = [point[0] for point in polygon]
            ys = [point[1] for point in polygon]
            bbox = [min(xs), min(ys), max(xs), max(ys)]
        elif isinstance(bbox_raw, list) and len(bbox_raw) == 4:
            bbox = [_number(cell, f"{kind}[{position}].bbox") for cell in bbox_raw]
        else:
            raise RuntimeError(f"Hermes {kind}[{position}] needs bbox or polygon coordinates")
        text = raw.get("text", raw.get("content", raw.get("value", "")))
        if not isinstance(text, str):
            raise RuntimeError(f"Hermes {kind}[{position}].text must be a string")
        confidence = _confidence_or_none(
            raw.get("confidence", raw.get("score", raw.get("recognitionScore"))),
            f"{kind}[{position}].confidence",
        )
        raw_id = raw.get("id")
        normalized = {
            "id": str(raw_id if raw_id is not None else f"{kind[:-1]}-{position + 1}"),
            "text": text,
            "bbox": bbox,
            "confidence": confidence,
        }
        if polygon:
            normalized["polygon"] = polygon
        aliases = {
            "parentId": ("parentId", "parent_id"),
            "role": ("role", "type"),
            "readingOrder": ("readingOrder", "reading_order", "order"),
            "language": ("language",),
            "label": ("label",),
            "blockId": ("blockId", "block_id"),
            "lineId": ("lineId", "line_id"),
            "wordIds": ("wordIds", "word_ids"),
            "lineIds": ("lineIds", "line_ids"),
            "semanticUnit": ("semanticUnit", "semantic_unit"),
            "index": ("index",),
            "lineIndex": ("lineIndex", "line_index"),
            "tokenIndex": ("tokenIndex", "token_index"),
        }
        for target, names in aliases.items():
            for name in names:
                if name in raw:
                    normalized[target] = raw[name]
                    break
        for confidence_name in ("layoutConfidence", "containingLineConfidence"):
            if confidence_name in raw:
                normalized[confidence_name] = _confidence_or_none(
                    raw[confidence_name], f"{kind}[{position}].{confidence_name}"
                )
        if "modelCoordinates1000" in raw:
            coordinates = raw["modelCoordinates1000"]
            if not isinstance(coordinates, list) or len(coordinates) != 4:
                raise RuntimeError(
                    f"Hermes {kind}[{position}].modelCoordinates1000 must be [x0,y0,x1,y1]"
                )
            normalized["modelCoordinates1000"] = [
                _number(cell, f"{kind}[{position}].modelCoordinates1000")
                for cell in coordinates
            ]
        output.append(normalized)
    return output


def _layout(layer: dict, rich: dict) -> dict:
    nested = layer.get("layout") if isinstance(layer.get("layout"), dict) else {}
    space = layer.get("coordinateSpace", nested.get("coordinateSpace"))
    if not isinstance(space, dict):
        raise RuntimeError("Hermes layer coordinateSpace must be an object")
    width = _number(space.get("width"), "coordinateSpace.width")
    height = _number(space.get("height"), "coordinateSpace.height")
    units = str(space.get("units", space.get("unit", ""))).lower()
    origin = str(space.get("origin", "top-left")).lower()
    if units not in {"pixel", "pixels", "px"} or origin != "top-left":
        raise RuntimeError("Hermes layer coordinates must be top-left pixels")
    if abs(width - float(rich["image"]["width"])) > 0.01 or abs(height - float(rich["image"]["height"])) > 0.01:
        raise RuntimeError("Hermes layer coordinateSpace does not match the exported image")
    return {
        "coordinateSpace": {
            "name": "rendered-page", "unit": "pixel", "origin": "top-left",
            "width": width, "height": height,
        },
        "blocks": _layout_items(layer.get("blocks", nested.get("blocks", [])), "blocks"),
        "lines": _layout_items(layer.get("lines", nested.get("lines", [])), "lines"),
        "words": _layout_items(layer.get("words", nested.get("words", [])), "words"),
    }


def _box_within(value: Any, width: float, height: float, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise RuntimeError(f"Hermes {field} must be [x0,y0,x1,y1]")
    if any(isinstance(cell, bool) or not isinstance(cell, (int, float)) for cell in value):
        raise RuntimeError(f"Hermes {field} coordinates must be numbers")
    x0, y0, x1, y1 = [_number(cell, field) for cell in value]
    if x0 > x1 or y0 > y1:
        raise RuntimeError(f"Hermes {field} is reversed")
    if not (0 <= x0 <= width and 0 <= x1 <= width and 0 <= y0 <= height and 0 <= y1 <= height):
        raise RuntimeError(f"Hermes {field} is outside its coordinate space")
    return [x0, y0, x1, y1]


CORRECTED_BLOCK_POLYGON_MAX_POINTS = 4096


def _corrected_polygon(value: Any, width: float, height: float, field: str) -> list[list[float]]:
    if not isinstance(value, list) or any(
        not isinstance(point, list)
        or len(point) != 2
        or any(isinstance(cell, bool) or not isinstance(cell, (int, float)) for cell in point)
        for point in value
    ):
        raise RuntimeError(f"Hermes {field} points must contain numbers")
    points = _polygon(value, field)
    if points is None or len(points) > CORRECTED_BLOCK_POLYGON_MAX_POINTS:
        raise RuntimeError(
            f"Hermes {field} must contain between 3 and "
            f"{CORRECTED_BLOCK_POLYGON_MAX_POINTS} points"
        )
    if any(not (0 <= x <= width and 0 <= y <= height) for x, y in points):
        raise RuntimeError(f"Hermes {field} is outside its coordinate space")
    return points


def _corrected_quadrilateral(
    value: Any, width: float, height: float, field: str
) -> list[list[float]]:
    points = _corrected_polygon(value, width, height, field)
    if len(points) != 4:
        raise RuntimeError(f"Hermes {field} must contain exactly four points")
    return points


def _corrected_confidence(value: Any, field: str) -> float | None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
        raise RuntimeError(f"Hermes {field} must be a number or null")
    return _confidence_or_none(value, field)


def _validate_corrected_layout(layer: dict, rich: dict, engine: str) -> None:
    space = layer.get("coordinateSpace")
    if not isinstance(space, dict):
        raise RuntimeError(f"Corrected Hermes layer {engine} lacks coordinateSpace")
    width_value = space.get("width")
    height_value = space.get("height")
    if (
        isinstance(width_value, bool) or not isinstance(width_value, int)
        or isinstance(height_value, bool) or not isinstance(height_value, int)
    ):
        raise RuntimeError(f"Corrected Hermes layer {engine} coordinate dimensions must be integers")
    width = float(width_value)
    height = float(height_value)
    if width <= 0 or height <= 0 or space.get("units") != "pixels":
        raise RuntimeError(f"Corrected Hermes layer {engine} has invalid coordinateSpace")
    if width != float(rich["image"]["width"]) or height != float(rich["image"]["height"]):
        raise RuntimeError(f"Corrected Hermes layer {engine} coordinateSpace differs from image")

    blocks = layer.get("blocks")
    lines = layer.get("lines")
    words = layer.get("words")
    if not all(isinstance(values, list) for values in (blocks, lines, words)):
        raise RuntimeError(f"Corrected Hermes layer {engine} layout collections must be arrays")

    for position, block in enumerate(blocks):
        field = f"layer {engine} blocks[{position}]"
        if not isinstance(block, dict):
            raise RuntimeError(f"Hermes {field} must be an object")
        missing = [name for name in ("id", "type", "text", "box") if name not in block]
        if missing:
            raise RuntimeError(f"Hermes {field} lacks {', '.join(missing)}")
        block_id = block["id"]
        if block_id is not None and (
            isinstance(block_id, bool) or not isinstance(block_id, (int, str))
        ):
            raise RuntimeError(f"Hermes {field}.id must be an integer, string, or null")
        if not isinstance(block["type"], str) or not isinstance(block["text"], str):
            raise RuntimeError(f"Hermes {field} type/text must be strings")
        order = block.get("order")
        if order is not None and (isinstance(order, bool) or not isinstance(order, int)):
            raise RuntimeError(f"Hermes {field}.order must be an integer or null")
        _box_within(block["box"], width, height, f"{field}.box")
        if "polygon" in block:
            _corrected_polygon(block["polygon"], width, height, f"{field}.polygon")
        if "layoutConfidence" in block:
            _corrected_confidence(block["layoutConfidence"], f"{field}.layoutConfidence")
        if "modelCoordinates1000" in block:
            _box_within(block["modelCoordinates1000"], 1000, 1000, f"{field}.modelCoordinates1000")

    for position, line in enumerate(lines):
        field = f"layer {engine} lines[{position}]"
        if not isinstance(line, dict):
            raise RuntimeError(f"Hermes {field} must be an object")
        missing = [name for name in ("index", "text", "confidence", "polygon", "box") if name not in line]
        if missing:
            raise RuntimeError(f"Hermes {field} lacks {', '.join(missing)}")
        if isinstance(line["index"], bool) or not isinstance(line["index"], int) or line["index"] < 0:
            raise RuntimeError(f"Hermes {field}.index must be a non-negative integer")
        if not isinstance(line["text"], str):
            raise RuntimeError(f"Hermes {field}.text must be a string")
        _corrected_confidence(line["confidence"], f"{field}.confidence")
        _box_within(line["box"], width, height, f"{field}.box")
        _corrected_quadrilateral(line["polygon"], width, height, f"{field}.polygon")

    for position, word in enumerate(words):
        field = f"layer {engine} words[{position}]"
        if not isinstance(word, dict):
            raise RuntimeError(f"Hermes {field} must be an object")
        required = (
            "lineIndex", "tokenIndex", "text", "box", "confidence",
            "containingLineConfidence", "semanticUnit",
        )
        missing = [name for name in required if name not in word]
        if missing:
            raise RuntimeError(f"Hermes {field} lacks {', '.join(missing)}")
        for name in ("lineIndex", "tokenIndex"):
            value = word[name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise RuntimeError(f"Hermes {field}.{name} must be a non-negative integer")
        if word["lineIndex"] >= len(lines):
            raise RuntimeError(f"Hermes {field} references a missing line")
        if not isinstance(word["text"], str):
            raise RuntimeError(f"Hermes {field}.text must be a string")
        if word["semanticUnit"] != "native-token-or-glyph":
            raise RuntimeError(f"Hermes {field}.semanticUnit is unsupported")
        _corrected_confidence(word["confidence"], f"{field}.confidence")
        _corrected_confidence(
            word["containingLineConfidence"], f"{field}.containingLineConfidence"
        )
        _box_within(word["box"], width, height, f"{field}.box")


def _validate_audit(audit: dict, engine: str) -> None:
    if "rawOutputSha256" in audit:
        expected = _digest(audit["rawOutputSha256"], f"layer {engine} audit raw output")
        if "rawOutput" in audit:
            raw_output = audit["rawOutput"]
            if not isinstance(raw_output, str):
                raise RuntimeError(f"Hermes layer {engine} audit.rawOutput must be a string")
            actual = hashlib.sha256(raw_output.encode("utf-8")).hexdigest()
            if actual != expected:
                raise RuntimeError(f"Hermes layer {engine} audit rawOutput hash mismatch")
    if "rawCropResponsesSha256" in audit:
        expected = _digest(
            audit["rawCropResponsesSha256"], f"layer {engine} audit raw crop responses"
        )
        if "rawCropResponses" in audit:
            actual = hashlib.sha256(canonical_json(audit["rawCropResponses"])).hexdigest()
            if actual != expected:
                raise RuntimeError(f"Hermes layer {engine} audit rawCropResponses hash mismatch")


def _validate_corrected_error(raw: Any, stop_reason: str | None, engine: str) -> None:
    if raw is None:
        if stop_reason == "error":
            raise RuntimeError(f"Hermes layer {engine} error stopReason lacks error evidence")
        return
    if not isinstance(raw, dict):
        raise RuntimeError(f"Hermes layer {engine} error must be an object or null")
    missing = [name for name in ("type", "message", "retryable") if name not in raw]
    if missing:
        raise RuntimeError(f"Hermes layer {engine} error lacks {', '.join(missing)}")
    if (
        not isinstance(raw["type"], str) or not raw["type"].strip()
        or not isinstance(raw["message"], str) or not raw["message"].strip()
    ):
        raise RuntimeError(f"Hermes layer {engine} error type/message must be non-empty")
    if not isinstance(raw["retryable"], bool):
        raise RuntimeError(f"Hermes layer {engine} error.retryable must be boolean")
    if "evidence" in raw and not isinstance(raw["evidence"], dict):
        raise RuntimeError(f"Hermes layer {engine} error.evidence must be an object")


def _load_envelopes(path: Path) -> list[dict]:
    path = path.resolve()
    files: list[Path]
    if path.is_dir():
        canonical_results = {
            candidate
            for candidate in path.rglob("*.json")
            if HERMES_CANONICAL_RESULT_NAME_RE.fullmatch(candidate.name)
        }
        files = sorted({
            *path.rglob("result.json"), *path.rglob("*.result.json"), *path.rglob("*.jsonl"),
            *canonical_results,
        })
        if not files:
            raise RuntimeError(f"No Hermes result files found below {path}")
    else:
        files = [path]
    output: list[dict] = []
    for file_path in files:
        if not file_path.is_file() or file_path.is_symlink():
            raise RuntimeError(f"Hermes result input must be a regular non-symlink file: {file_path}")
        if file_path.suffix == ".jsonl":
            rows = load_jsonl(file_path)
        else:
            value = json.loads(file_path.read_text(encoding="utf-8"))
            rows = value if isinstance(value, list) else [value]
        if not all(isinstance(row, dict) for row in rows):
            raise RuntimeError(f"Hermes result file contains a non-object: {file_path}")
        output.extend(rows)
    if not output:
        raise RuntimeError("Hermes result input contains no envelopes")
    return output


def _load_rich_jobs(manifest_path: Path) -> tuple[list[dict], dict[str, dict]]:
    manifest_path = manifest_path.resolve()
    manifest_root = manifest_path.parent
    jobs = load_jsonl(manifest_path)
    if not jobs:
        raise RuntimeError("Local rich OCR manifest is empty")
    by_id: dict[str, dict] = {}
    recovery_original_ids: set[str] = set()
    for position, job in enumerate(jobs, start=1):
        job_id = job.get("jobId")
        if not isinstance(job_id, str) or not job_id or job_id in by_id:
            raise RuntimeError(f"Local rich OCR manifest has a missing/duplicate jobId at row {position}")
        if not OCR_SAFE_JOB_ID_RE.fullmatch(job_id):
            raise RuntimeError(f"Local rich OCR manifest has an unsafe jobId at row {position}")
        relative = Path(str(job.get("image", {}).get("path", "")))
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"Local rich image path is not safely relative for {job_id}")
        image_path = manifest_root / relative
        try:
            resolved_image = image_path.resolve(strict=True)
            resolved_image.relative_to(manifest_root)
        except (FileNotFoundError, ValueError) as error:
            raise RuntimeError(f"Local rich image escapes or is missing below the manifest root: {image_path}") from error
        if resolved_image != image_path.absolute() or not image_path.is_file() or image_path.is_symlink():
            raise RuntimeError(f"Local rich job image must be a regular non-symlink file: {image_path}")
        expected = _digest(job.get("image", {}).get("sha256"), f"manifest image hash for {job_id}")
        if _sha256(image_path) != expected:
            raise RuntimeError(f"Local rich image checksum mismatch for {job_id}")
        recovery = normalize_ocr_recovery_provenance(
            job.get("recovery"),
            recovery_job_id=job_id,
            image_sha256=expected,
        )
        if recovery is not None:
            expected_result = job.get("expectedResult")
            if (
                not isinstance(expected_result, dict)
                or expected_result.get("jobId") != job_id
            ):
                raise RuntimeError(
                    f"Local rich recovery job {job_id} expectedResult.jobId does not match its recoveryJobId"
                )
            expected_schema = _digest(
                expected_result.get("outputSchemaSha256"),
                f"expected result schema for recovery job {job_id}",
            )
            if expected_schema != OCR_RESULT_SCHEMA_SHA256:
                raise RuntimeError(
                    f"Local rich recovery job {job_id} expectedResult.outputSchemaSha256 "
                    "does not match the supported OCR result schema"
                )
            original_job_id = recovery["originalJobId"]
            if original_job_id in recovery_original_ids:
                raise RuntimeError(
                    f"Local rich OCR manifest duplicates recovery originalJobId {original_job_id}"
                )
            recovery_original_ids.add(original_job_id)
        job["_validatedImagePath"] = image_path.as_posix()
        job["_validatedRecovery"] = recovery
        by_id[job_id] = job
    return jobs, by_id


def _validate_embedded_job(remote: Any, rich: dict) -> tuple[dict, list[str]]:
    if not isinstance(remote, dict) or remote.get("schemaVersion") != HERMES_JOB_SCHEMA:
        raise RuntimeError("Hermes envelope has an invalid embedded job schema")
    job_id = rich["jobId"]
    comparisons = {
        "jobId": job_id,
        "caseId": rich["caseId"],
        "pageNumber": int(rich["pageNumber"]),
        "sourcePdfSha256": _digest(rich["source"]["pdfSha256"], f"source PDF for {job_id}"),
        "imageSha256": _digest(rich["image"]["sha256"], f"image for {job_id}"),
        "renderDpi": int(rich["image"]["dpi"]),
    }
    for field, expected in comparisons.items():
        actual = remote.get(field)
        if field in {"pageNumber", "renderDpi"}:
            try:
                actual = int(actual)
            except (TypeError, ValueError) as error:
                raise RuntimeError(f"Hermes embedded job {job_id} has invalid {field}") from error
        elif field.endswith("Sha256"):
            actual = _digest(actual, f"embedded job {field}")
        if actual != expected:
            raise RuntimeError(f"Hermes embedded job {job_id} does not match local {field}")
    filename = str(remote.get("imageFilename") or "")
    if not filename or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise RuntimeError(f"Hermes embedded job {job_id} has an unsafe imageFilename")
    recovery = rich.get("_validatedRecovery")
    filename_job_id = recovery["originalJobId"] if recovery is not None else job_id
    expected_filename = f"{filename_job_id}{Path(str(rich['image']['path'])).suffix.lower()}"
    if filename != expected_filename:
        raise RuntimeError(f"Hermes embedded job {job_id} has an unexpected imageFilename")
    requested = remote.get("requestedEngines")
    if not isinstance(requested, list) or not requested or not all(isinstance(value, str) and value for value in requested):
        raise RuntimeError(f"Hermes embedded job {job_id} needs requestedEngines")
    if len(requested) != len(set(requested)):
        raise RuntimeError(f"Hermes embedded job {job_id} has duplicate requested engines")
    unknown_engines = sorted(set(requested) - HERMES_ENGINES)
    if unknown_engines:
        raise RuntimeError(
            f"Hermes embedded job {job_id} requests unsupported engines: {', '.join(unknown_engines)}"
        )
    preprocessing = remote.get("preprocessing")
    if not isinstance(preprocessing, dict):
        raise RuntimeError(f"Hermes embedded job {job_id} lacks preprocessing provenance")
    remote_matrix = _matrix9(preprocessing.get("sourceToImageTransform"), "sourceToImageTransform")
    initial = rich.get("preprocessing", {}).get("initialTransforms", [])
    if not initial:
        raise RuntimeError(f"Local rich job {job_id} lacks its initial render transform")
    local_matrix = _matrix9(initial[0].get("forwardMatrix"), "local initial forwardMatrix")
    if not _matrices_close(remote_matrix, local_matrix):
        raise RuntimeError(f"Hermes embedded job {job_id} source transform does not match the local export")
    operations = preprocessing.get("operations", [])
    if not isinstance(operations, list):
        raise RuntimeError(f"Hermes embedded job {job_id} preprocessing.operations must be an array")
    return remote, requested


def _worker(raw: Any, *, require_legacy_runtime: bool) -> dict:
    if not isinstance(raw, dict):
        raise RuntimeError("Hermes envelope worker must be an object")
    required = ["workerVersion", "hostClass"]
    if require_legacy_runtime:
        required.extend(["cudaVersion", "containerDigest"])
    for field in required:
        if not str(raw.get(field, "")).strip():
            raise RuntimeError(f"Hermes worker is missing {field}")
    if not require_legacy_runtime:
        if not isinstance(raw["workerVersion"], str):
            raise RuntimeError("Corrected Hermes workerVersion must be a string")
        worker_version = str(raw["workerVersion"]).lower()
        if not WORKER_COMMIT_RE.fullmatch(worker_version):
            raise RuntimeError("Corrected Hermes workerVersion must be a 40-64 digit git/content hash")
        if raw.get("hostClass") != "rtx-5090":
            raise RuntimeError("Corrected Hermes worker hostClass must be rtx-5090")
    output = {field: raw[field] for field in SAFE_WORKER_FIELDS if field in raw}
    if not require_legacy_runtime:
        output["workerVersion"] = worker_version
    if "containerDigest" in output:
        output["containerDigest"] = _digest(
            raw["containerDigest"], "worker.containerDigest", container=True
        )
    if "environmentManifestSha256" in output:
        output["environmentManifestSha256"] = _digest(
            output["environmentManifestSha256"], "worker.environmentManifestSha256"
        )
    return output


def _coordinate_mapping(
    raw: Any,
    remote_job: dict,
    rich: dict,
    *,
    required: bool,
) -> dict | None:
    """Validate the corrected envelope's reversible page-space mapping.

    The embedded job remains the signed transfer request.  The result mapping
    is accepted only when it describes the same transform and operation list,
    so a worker cannot silently change page geometry while returning boxes.
    """
    if raw is None:
        if required:
            raise RuntimeError("Corrected Hermes envelope lacks coordinateMapping")
        return None
    if not isinstance(raw, dict):
        raise RuntimeError("Hermes coordinateMapping must be an object")
    source = _matrix9(raw.get("sourceToImageTransform"), "coordinateMapping.sourceToImageTransform")
    inverse = _matrix9(raw.get("imageToSourceTransform"), "coordinateMapping.imageToSourceTransform")
    calculated_inverse = _inverse(source, "coordinateMapping.sourceToImageTransform")
    if not _matrices_close(inverse, calculated_inverse, 1e-5):
        raise RuntimeError("Hermes coordinateMapping matrices are not inverses")
    requested_source = _matrix9(
        remote_job.get("preprocessing", {}).get("sourceToImageTransform"),
        "embedded job sourceToImageTransform",
    )
    local_initial = rich.get("preprocessing", {}).get("initialTransforms", [])
    if not local_initial:
        raise RuntimeError(f"Local rich job {rich['jobId']} lacks its initial render transform")
    local_source = _matrix9(
        local_initial[0].get("forwardMatrix"), "local initial forwardMatrix"
    )
    if not _matrices_close(source, requested_source) or not _matrices_close(source, local_source):
        raise RuntimeError("Hermes coordinateMapping does not match the exported source transform")
    operations = raw.get("operations")
    if not isinstance(operations, list):
        raise RuntimeError("Hermes coordinateMapping.operations must be an array")
    requested_operations = remote_job.get("preprocessing", {}).get("operations", [])
    if canonical_json(operations) != canonical_json(requested_operations):
        raise RuntimeError("Hermes coordinateMapping operations differ from the embedded job")
    return {
        "sourceToImageTransform": source,
        "imageToSourceTransform": inverse,
        "operations": operations,
    }


def _corrected_layer_provenance(
    raw: Any,
    layer: dict,
    remote_job: dict,
    worker: dict,
    engine: str,
) -> dict:
    """Validate and normalize the semantics of per-layer runtime evidence.

    We intentionally do not mirror the remote JSON Schema's
    ``additionalProperties`` policy.  Additive audit fields may evolve, while
    every identity, artifact, model, input, and software assertion below is
    still required and cross-checked.
    """
    if not isinstance(raw, dict):
        raise RuntimeError(f"Hermes layer {engine} provenance must be an object")

    backend = raw.get("backend")
    if not isinstance(backend, dict):
        raise RuntimeError(f"Hermes layer {engine} provenance.backend must be an object")
    for name in ("type", "version"):
        if not isinstance(backend.get(name), str) or not backend[name].strip():
            raise RuntimeError(f"Hermes layer {engine} provenance.backend lacks {name}")

    runtime = raw.get("runtimeArtifact")
    if not isinstance(runtime, dict) or not str(runtime.get("type") or "").strip():
        raise RuntimeError(f"Hermes layer {engine} provenance.runtimeArtifact is incomplete")
    if runtime.get("type") not in {"container-repo-digest", "venv-lock-sha256"}:
        raise RuntimeError(f"Hermes layer {engine} runtime artifact type is unsupported")
    if runtime.get("source") is not None and not isinstance(runtime.get("source"), str):
        raise RuntimeError(f"Hermes layer {engine} runtime artifact source must be a string or null")
    runtime_digest = _digest(
        runtime.get("digest"), f"layer {engine} runtimeArtifact.digest", container=True
    )

    model = raw.get("model")
    if not isinstance(model, dict):
        raise RuntimeError(f"Hermes layer {engine} provenance.model must be an object")
    for name in ("name", "revision"):
        if not isinstance(model.get(name), str) or not model[name].strip():
            raise RuntimeError(f"Hermes layer {engine} provenance.model lacks string {name}")
    model_name = str(model.get("name") or "").strip()
    model_revision = str(model.get("revision") or "").strip()
    if model_name != str(layer.get("model") or "").strip():
        raise RuntimeError(f"Hermes layer {engine} provenance model name disagrees with layer")
    if model_revision != str(layer.get("modelRevision") or "").strip():
        raise RuntimeError(f"Hermes layer {engine} provenance model revision disagrees with layer")
    weight_files = model.get("weightFiles")
    if not isinstance(weight_files, list) or not weight_files:
        raise RuntimeError(f"Hermes layer {engine} provenance.model.weightFiles must be non-empty")
    normalized_weight_files: list[dict] = []
    seen_paths: set[str] = set()
    for position, weight in enumerate(weight_files):
        if (
            not isinstance(weight, dict)
            or not isinstance(weight.get("path"), str)
            or not weight["path"].strip()
        ):
            raise RuntimeError(
                f"Hermes layer {engine} model weight file {position} lacks a path"
            )
        path = str(weight["path"])
        if path in seen_paths:
            raise RuntimeError(f"Hermes layer {engine} has duplicate model weight path {path!r}")
        seen_paths.add(path)
        normalized_weight_files.append({
            **weight,
            "path": path,
            "sha256": _digest(
                weight.get("sha256"), f"layer {engine} model weight file {position}"
            ),
        })
    weight_set_hash = _digest(
        model.get("weightSetSha256"), f"layer {engine} model weight set"
    )
    # The committed worker's canonical evidence format is newline-terminated.
    calculated_weight_set_hash = hashlib.sha256(
        canonical_json(normalized_weight_files) + b"\n"
    ).hexdigest()
    if weight_set_hash != calculated_weight_set_hash:
        raise RuntimeError(f"Hermes layer {engine} model weight-set hash is falsely asserted")

    backend_config_hash = _digest(
        raw.get("backendConfigSha256"), f"layer {engine} backend config"
    )
    adapter_hash = _digest(raw.get("adapterSha256"), f"layer {engine} adapter")
    template_hash = _digest(
        raw.get("promptOrTemplateSha256"), f"layer {engine} provenance prompt/template"
    )
    flat_template_hash = _digest(
        layer.get("promptOrTemplateSha256"), f"layer {engine} prompt/template hash"
    )
    if template_hash != flat_template_hash:
        raise RuntimeError(f"Hermes layer {engine} prompt/template hashes disagree")

    input_provenance = raw.get("input")
    if not isinstance(input_provenance, dict):
        raise RuntimeError(f"Hermes layer {engine} provenance.input must be an object")
    image_hash = _digest(
        input_provenance.get("imageSha256"), f"layer {engine} provenance input image"
    )
    source_hash = _digest(
        input_provenance.get("sourcePdfSha256"), f"layer {engine} provenance input PDF"
    )
    if image_hash != _digest(remote_job.get("imageSha256"), "embedded job imageSha256"):
        raise RuntimeError(f"Hermes layer {engine} provenance image hash differs from embedded job")
    if source_hash != _digest(remote_job.get("sourcePdfSha256"), "embedded job sourcePdfSha256"):
        raise RuntimeError(f"Hermes layer {engine} provenance PDF hash differs from embedded job")

    software = raw.get("software")
    if not isinstance(software, dict):
        raise RuntimeError(f"Hermes layer {engine} provenance.software must be an object")
    for name in SOFTWARE_PROVENANCE_FIELDS:
        if name not in software:
            raise RuntimeError(f"Hermes layer {engine} provenance.software lacks {name}")
        value = software[name]
        if value is not None and not isinstance(value, str):
            raise RuntimeError(f"Hermes layer {engine} software {name} must be a string or null")
    if not str(software.get("nvidiaDriver") or "").strip():
        raise RuntimeError(f"Hermes layer {engine} provenance.software lacks nvidiaDriver")
    normalized_software = dict(software)
    if engine == "ovisocr2" and OVIS_EXECUTOR_SHA256_FIELD in software:
        normalized_software[OVIS_EXECUTOR_SHA256_FIELD] = _digest(
            software[OVIS_EXECUTOR_SHA256_FIELD],
            f"layer {engine} software {OVIS_EXECUTOR_SHA256_FIELD}",
        )

    worker_commit = str(raw.get("workerGitCommit") or "").strip()
    if (
        not WORKER_COMMIT_RE.fullmatch(worker_commit)
        or worker_commit != str(worker.get("workerVersion") or "")
    ):
        raise RuntimeError(f"Hermes layer {engine} worker commit differs from worker envelope")

    return {
        **raw,
        "backend": {**backend, "type": str(backend["type"]), "version": str(backend["version"])},
        "runtimeArtifact": {**runtime, "type": str(runtime["type"]), "digest": runtime_digest},
        "model": {
            **model,
            "name": model_name,
            "revision": model_revision,
            "weightSetSha256": weight_set_hash,
            "weightFiles": normalized_weight_files,
        },
        "backendConfigSha256": backend_config_hash,
        "promptOrTemplateSha256": template_hash,
        "adapterSha256": adapter_hash,
        "input": {**input_provenance, "imageSha256": image_hash, "sourcePdfSha256": source_hash},
        "software": normalized_software,
        "workerGitCommit": worker_commit,
    }


def _errors(layer: dict, truncated: bool, text: str) -> list[dict]:
    output: list[dict] = []
    raw = layer.get("error")
    if raw not in (None, "", False):
        output.append(dict(raw) if isinstance(raw, dict) else {"type": "HermesEngineError", "message": str(raw)})
    status = str(layer.get("status", "")).lower()
    if truncated and not any(item.get("type") == "TruncatedOutput" for item in output):
        output.append({"type": "TruncatedOutput", "message": "Hermes engine reported a truncated partial result"})
    if status in {"failed", "error", "partial"} and not output:
        output.append({"type": "HermesEngineStatus", "message": f"Hermes engine status was {status}"})
    if not text.strip() and not output:
        output.append({"type": "EmptyOutput", "message": "Hermes engine returned no transcription"})
    return output


def _layer_row(
    envelope: dict,
    envelope_hash: str,
    remote_job: dict,
    rich: dict,
    worker: dict,
    layer: dict,
    layer_index: int,
    *,
    corrected_provenance: bool,
    coordinate_mapping: dict | None,
) -> dict:
    if corrected_provenance:
        missing_fields = [name for name in CORRECTED_LAYER_REQUIRED_FIELDS if name not in layer]
        if missing_fields:
            raise RuntimeError(
                f"Corrected Hermes layer {layer_index} lacks required semantic fields: "
                + ", ".join(missing_fields)
            )
        for name in ("engine", "engineVersion", "model", "modelRevision"):
            if not isinstance(layer[name], str) or not layer[name].strip():
                raise RuntimeError(f"Corrected Hermes layer {layer_index} {name} must be a string")
    engine = str(layer.get("engine") or "").strip()
    engine_version = str(layer.get("engineVersion") or "").strip()
    model_value = layer.get("model")
    model = str(model_value.get("name") if isinstance(model_value, dict) else model_value or "").strip()
    revision_value = layer.get("modelRevision")
    if isinstance(model_value, dict) and revision_value is None:
        revision_value = model_value.get("revision")
    model_revision = str(revision_value or "").strip()
    if not engine or not engine_version or not model or not model_revision:
        raise RuntimeError(f"Hermes layer {layer_index} lacks pinned engine/model provenance")
    if corrected_provenance and engine not in HERMES_ENGINES:
        raise RuntimeError(f"Corrected Hermes layer {layer_index} uses unsupported engine {engine!r}")
    prompt_hash = _digest(layer.get("promptOrTemplateSha256"), f"layer {engine} prompt/template hash")
    stop_value = layer.get("stopReason")
    if stop_value is not None and not isinstance(stop_value, str):
        raise RuntimeError(f"Hermes layer {engine} stopReason must be a string or null")
    stop_reason = stop_value.strip() if isinstance(stop_value, str) else None
    if corrected_provenance and stop_reason not in CORRECTED_STOP_REASONS:
        raise RuntimeError(f"Hermes layer {engine} has unsupported stopReason {stop_reason!r}")
    finish_value = layer.get("finishReason")
    if finish_value is not None and not isinstance(finish_value, str):
        raise RuntimeError(f"Hermes layer {engine} finishReason must be a string or null")
    finish_reason = finish_value.strip() if isinstance(finish_value, str) else None
    if corrected_provenance:
        truncation_known = layer.get("truncationKnown")
        if truncation_known not in {True, False}:
            raise RuntimeError(f"Hermes layer {engine} truncationKnown must be boolean")
    else:
        # Original result-v1 predated the explicit unknown state.  A legacy
        # boolean was therefore an assertion that truncation was known.
        truncation_known = True
    truncated = layer.get("truncated")
    if truncation_known:
        if truncated not in {True, False}:
            raise RuntimeError(f"Hermes layer {engine} known truncation must be boolean")
        if not corrected_provenance and not stop_reason:
            raise RuntimeError(f"Hermes layer {engine} lacks stopReason for known termination")
    elif truncated is not None:
        raise RuntimeError(f"Hermes layer {engine} unknown truncation must be null")
    if stop_reason == "complete" and (not truncation_known or truncated is not False):
        raise RuntimeError(
            f"Hermes layer {engine} cannot report complete without known non-truncated output"
        )
    output_token_count = _integer_or_none(
        layer.get("outputTokenCount"), f"layer {engine} outputTokenCount"
    )
    max_output_tokens = _integer_or_none(
        layer.get("maxOutputTokens"), f"layer {engine} maxOutputTokens", minimum=1
    )
    if corrected_provenance:
        for field, value in (
            ("outputTokenCount", layer.get("outputTokenCount")),
            ("maxOutputTokens", layer.get("maxOutputTokens")),
        ):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
                raise RuntimeError(f"Corrected Hermes layer {engine} {field} must be an integer or null")
    if finish_reason and engine in {"ovisocr2", "paddleocr-vl-1.6"}:
        if output_token_count is None or max_output_tokens is None:
            raise RuntimeError(
                f"Hermes generative layer {engine} finishReason requires output/max-token counts"
            )
    runtime_ms = _number(layer.get("runtimeMs"), f"layer {engine} runtimeMs")
    if runtime_ms < 0:
        raise RuntimeError(f"Hermes layer {engine} runtimeMs must not be negative")
    if corrected_provenance and (
        isinstance(layer.get("runtimeMs"), bool) or not isinstance(layer.get("runtimeMs"), int)
    ):
        raise RuntimeError(f"Corrected Hermes layer {engine} runtimeMs must be an integer")
    raw_text = layer.get("text", "")
    markdown = layer.get("markdown", "")
    if not isinstance(raw_text, str) or not isinstance(markdown, str):
        raise RuntimeError(f"Hermes layer {engine} text/markdown must be strings")
    text = raw_text if raw_text.strip() else markdown
    errors = _errors(layer, truncated is True, text)
    status = "failed" if errors or truncated is True else "succeeded"
    warnings = layer.get("warnings", [])
    if not isinstance(warnings, list):
        raise RuntimeError(f"Hermes layer {engine} warnings must be an array")
    if corrected_provenance and not all(isinstance(warning, str) for warning in warnings):
        raise RuntimeError(f"Corrected Hermes layer {engine} warnings must contain strings")

    rich_initial = rich["preprocessing"]["initialTransforms"]
    transforms = []
    for position, transform in enumerate(rich_initial):
        normalized = _normalize_operation(transform, position)
        transforms.append(normalized)
    operations = list(remote_job.get("preprocessing", {}).get("operations", []))
    layer_preprocessing = layer.get("preprocessing")
    if layer_preprocessing is not None:
        if not isinstance(layer_preprocessing, dict):
            raise RuntimeError(f"Hermes layer {engine} preprocessing must be an object")
        layer_operations = layer_preprocessing.get("operations", layer_preprocessing.get("transforms", []))
        if not isinstance(layer_operations, list):
            raise RuntimeError(f"Hermes layer {engine} preprocessing operations must be an array")
        operations.extend(layer_operations)
    for position, operation in enumerate(operations, start=len(transforms)):
        transforms.append(_normalize_operation(operation, position))

    if corrected_provenance:
        layer_provenance = _corrected_layer_provenance(
            layer.get("provenance"), layer, remote_job, worker, engine
        )
        container_digest = layer_provenance["runtimeArtifact"]["digest"]
        if layer.get("containerDigest") is not None:
            duplicated_digest = _digest(
                layer.get("containerDigest"), f"layer {engine} containerDigest", container=True
            )
            if duplicated_digest != container_digest:
                raise RuntimeError(
                    f"Hermes layer {engine} containerDigest disagrees with runtimeArtifact"
                )
        provenance_completeness = CORRECTED_PROVENANCE_COMPLETENESS
    else:
        layer_provenance = None
        container_digest = _digest(
            layer.get("containerDigest", worker.get("containerDigest")),
            f"layer {engine} containerDigest", container=True,
        )
        provenance_completeness = LEGACY_PROVENANCE_COMPLETENESS
    if corrected_provenance:
        _corrected_confidence(layer.get("confidence"), f"layer {engine} confidence")
        _validate_corrected_error(layer.get("error"), stop_reason, engine)
        _validate_corrected_layout(layer, rich, engine)
    layout = _layout(layer, rich)
    audit = layer.get("audit", {})
    if not isinstance(audit, dict):
        raise RuntimeError(f"Hermes layer {engine} audit must be an object")
    if corrected_provenance:
        _validate_audit(audit, engine)
    usage = layer.get("usage") or {}
    if not isinstance(usage, dict):
        raise RuntimeError(f"Hermes layer {engine} usage must be an object")
    row = {
        "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
        "jobId": rich["jobId"],
        "caseId": rich["caseId"],
        "pageNumber": int(rich["pageNumber"]),
        "status": status,
        "text": text,
        "markdown": markdown,
        "engine": {"name": engine, "version": engine_version},
        "model": {"name": model, "revision": model_revision},
        "containerDigest": container_digest,
        "sourcePdfSha256": _digest(remote_job["sourcePdfSha256"], "sourcePdfSha256"),
        "imageSha256": _digest(remote_job["imageSha256"], "imageSha256"),
        "render": {
            "dpi": int(remote_job["renderDpi"]),
            "format": rich["image"].get("format", "png"),
            "width": rich["image"]["width"],
            "height": rich["image"]["height"],
        },
        "preprocessing": {"transforms": transforms},
        "promptSha256": prompt_hash,
        "outputSchemaSha256": OCR_RESULT_SCHEMA_SHA256,
        "layout": layout,
        "confidence": layer.get("confidence"),
        "termination": {
            "stopReason": stop_reason,
            "finishReason": finish_reason,
            "truncationKnown": truncation_known,
            "truncated": truncated,
        },
        "runtime": {
            "milliseconds": runtime_ms,
            "startedAt": envelope.get("startedAt"),
            "finishedAt": envelope.get("completedAt"),
        },
        "usage": usage,
        "outputTokenCount": output_token_count,
        "maxOutputTokens": max_output_tokens,
        "errors": errors,
        "warnings": warnings,
        "audit": audit,
        "worker": worker,
        "remoteJob": remote_job,
        "remoteEnvelopeSha256": envelope_hash,
        "remoteLayerIndex": layer_index,
        "workerResultSchemaVersion": HERMES_RESULT_SCHEMA,
        "decoding": layer.get("decoding") or {},
        "provenanceCompleteness": provenance_completeness,
    }
    recovery_provenance = rich.get("_validatedRecovery")
    if recovery_provenance is not None:
        row["recoveryProvenance"] = recovery_provenance
    if layer_provenance is not None:
        row["layerProvenance"] = layer_provenance
    if coordinate_mapping is not None:
        row["remoteCoordinateMapping"] = coordinate_mapping
    fingerprint = {
        "jobId": rich["jobId"], "engine": row["engine"], "model": row["model"],
        "containerDigest": container_digest, "sourcePdfSha256": row["sourcePdfSha256"],
        "imageSha256": row["imageSha256"], "promptSha256": prompt_hash,
        "provenanceCompleteness": provenance_completeness,
        "layerProvenance": layer_provenance,
        "recoveryProvenance": recovery_provenance,
    }
    row["jobFingerprint"] = hashlib.sha256(canonical_json(fingerprint)).hexdigest()
    row["resultId"] = "ocr-hermes-result-" + hashlib.sha256(
        canonical_json({"envelopeSha256": envelope_hash, "layerIndex": layer_index, "layer": layer})
    ).hexdigest()[:32]
    # Run the same strict validator used by import before writing anything.
    normalize_ocr_result(
        row, rich["caseId"], int(rich["pageNumber"]), row["sourcePdfSha256"]
    )
    return row


def convert_hermes_results(
    manifest_path: Path,
    results_path: Path,
    output_path: Path,
    *,
    require_all_jobs: bool = False,
    expected_worker_commit: str | None = None,
    expected_ovis_file_store_executor_sha256: str | None = None,
) -> dict:
    """Convert validated Hermes envelopes to local schema-v2 result JSONL."""
    worker_pin = normalize_worker_commit_pin(expected_worker_commit)
    executor_pin = normalize_ovis_executor_pin(
        expected_ovis_file_store_executor_sha256
    )
    ordered_jobs, rich_by_id = _load_rich_jobs(manifest_path)
    envelopes = _load_envelopes(results_path)
    envelope_by_job: dict[str, dict] = {}
    for position, envelope in enumerate(envelopes, start=1):
        if envelope.get("schemaVersion") != HERMES_RESULT_SCHEMA:
            raise RuntimeError(f"Hermes envelope {position} has unsupported schemaVersion")
        if not str(envelope.get("startedAt") or "").strip() or not str(envelope.get("completedAt") or "").strip():
            raise RuntimeError(f"Hermes envelope {position} lacks start/completion timestamps")
        remote_job = envelope.get("job")
        job_id = str(remote_job.get("jobId") if isinstance(remote_job, dict) else "")
        if job_id not in rich_by_id:
            raise RuntimeError(f"Hermes envelope {position} has unknown jobId {job_id!r}")
        if job_id in envelope_by_job:
            raise RuntimeError(f"Hermes results contain duplicate envelope for {job_id}")
        envelope_by_job[job_id] = envelope

    missing = [job["jobId"] for job in ordered_jobs if job["jobId"] not in envelope_by_job]
    if require_all_jobs and missing:
        raise RuntimeError(f"Hermes results are missing {len(missing)} job(s): {', '.join(missing[:10])}")

    rows: list[dict] = []
    for rich in ordered_jobs:
        envelope = envelope_by_job.get(rich["jobId"])
        if not envelope:
            continue
        remote_job, requested = _validate_embedded_job(envelope.get("job"), rich)
        layers = envelope.get("layers")
        if not isinstance(layers, list) or not layers:
            raise RuntimeError(f"Hermes envelope {rich['jobId']} has no engine layers")
        provenance_presence = [isinstance(layer, dict) and "provenance" in layer for layer in layers]
        if any(provenance_presence) and not all(provenance_presence):
            raise RuntimeError(
                f"Hermes envelope {rich['jobId']} mixes corrected and legacy layer provenance"
            )
        corrected_provenance = all(provenance_presence)
        worker = _worker(
            envelope.get("worker"), require_legacy_runtime=not corrected_provenance
        )
        recovery_provenance = rich.get("_validatedRecovery")
        if (
            recovery_provenance is not None
            and worker.get("workerVersion") != recovery_provenance["workerCommit"]
        ):
            raise RuntimeError(
                f"Hermes recovery job {rich['jobId']} worker commit does not match its recovery mapping"
            )
        coordinate_mapping = _coordinate_mapping(
            envelope.get("coordinateMapping"), remote_job, rich,
            required=corrected_provenance,
        )
        by_engine: dict[str, tuple[int, dict]] = {}
        for layer_index, layer in enumerate(layers):
            if not isinstance(layer, dict):
                raise RuntimeError(f"Hermes envelope {rich['jobId']} has a non-object layer")
            engine = str(layer.get("engine") or "")
            if engine in by_engine:
                raise RuntimeError(f"Hermes envelope {rich['jobId']} duplicates engine {engine!r}")
            by_engine[engine] = (layer_index, layer)
        if set(by_engine) != set(requested):
            missing_engines = sorted(set(requested) - set(by_engine))
            unexpected = sorted(set(by_engine) - set(requested))
            raise RuntimeError(
                f"Hermes envelope {rich['jobId']} layer/request mismatch; "
                f"missing={missing_engines}, unexpected={unexpected}"
            )
        envelope_hash = hashlib.sha256(canonical_json(envelope)).hexdigest()
        for engine in requested:
            layer_index, layer = by_engine[engine]
            row = _layer_row(
                envelope, envelope_hash, remote_job, rich, worker, layer, layer_index,
                corrected_provenance=corrected_provenance,
                coordinate_mapping=coordinate_mapping,
            )
            validate_flat_result_provenance_pins(
                row,
                expected_worker_commit=worker_pin,
                expected_ovis_file_store_executor_sha256=executor_pin,
                context=f"Hermes result {rich['jobId']} layer {engine}",
            )
            rows.append(row)

    output_value = b"".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n"
        for row in rows
    )
    atomic_write(output_path.resolve(), output_value)
    status_counts = Counter(row["status"] for row in rows)
    return {
        "schemaVersion": 1,
        "valid": True,
        "jobsInManifest": len(ordered_jobs),
        "envelopesConverted": len(envelope_by_job),
        "layersWritten": len(rows),
        "layerStatuses": dict(sorted(status_counts.items())),
        "provenanceCompleteness": dict(sorted(Counter(
            row["provenanceCompleteness"] for row in rows
        ).items())),
        "missingJobIds": missing,
        **({
            "provenancePins": {
                "expectedWorkerCommit": worker_pin,
                "expectedOvisFileStoreExecutorSha256": executor_pin,
            },
        } if worker_pin is not None or executor_pin is not None else {}),
        "output": output_path.resolve().as_posix(),
        "outputSha256": hashlib.sha256(output_value).hexdigest(),
        "selection": "none; converted layers remain unreviewed OCR evidence",
    }
