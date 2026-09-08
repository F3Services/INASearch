"""Plan and verify a ledger-bound Hermes OCR result download.

The remote batch controller records the canonical result filename, byte count,
and SHA-256 for every returned envelope.  This module binds that ledger to the
locally retained outbound transfer map before retrieval, then verifies the
downloaded byte set without selecting or importing any OCR text.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from .documents import atomic_write
from .ocr import OCR_SAFE_JOB_ID_RE, SHA256_RE, canonical_json


WORKER_COMMIT_RE = re.compile(r"^[0-9a-f]{40,64}$")
EXPECTED_ENGINES = ("pp-ocrv6", "paddleocr-vl-1.6", "ovisocr2")
ALLOWED_RELEASE_CATEGORIES = {
    "clean", "knownTruncated", "knownArtifactTruncated",
}
HERMES_JOB_SCHEMA = "inasearch-ocr-job/v1"
HERMES_RESULT_SCHEMA = "inasearch-ocr-result/v1"
SMOKE_LEDGER_CONTRACT = "smoke-result-files-v1"
GOLD_LEDGER_CONTRACT = "gold-result-files-v1"
TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT = "truthful-supplement-result-files-v1"
OVIS_GUARD_CONFIG_SHA256 = (
    "b70144fe572019d94bdd9a7174f2955cd8d5f44baf85b15bf0b0351dd580c89f"
)
OVIS_GUARD_STOP_STRING_SHA256 = (
    "75d774240429f9f7d37827bc51e5e017b98b82db3c0e2b592f7f1dc9fa55e2b3"
)
OVIS_GUARD_UNIT = "\n\n1"
OVIS_GUARD_CONSECUTIVE_UNIT_THRESHOLD = 16
TRUTHFUL_ARTIFACT_JOBS = {
    "ocr-job-c318d65e7828ad179a1c31499ec130d3": {
        "imageSha256": "bb5731c082f3fe3efb970b39f485b019b3015a8780a8d0c8bec8f4b2f5afe773",
        "caseId": "eoir-3139",
        "pageNumber": 3,
        "decision": "3139",
        "pageEnding": "225",
        "requiredFootnote": (
            "The regulation at 8 C.F.R. § 3.14(a) (1990) incorrectly cites "
            "8 C.F.R. § 242.2(b)."
        ),
    },
    "ocr-job-ebc08bc08922bbca00450ab3f3c7d4fb": {
        "imageSha256": "b88fa70b1a25ca5366000132df821598e7ff51f97356537faddc202de9bd3a1a",
        "caseId": "eoir-3105",
        "pageNumber": 7,
        "decision": "3105",
        "pageEnding": "31",
        "requiredFootnote": None,
    },
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _digest(value: Any, field: str) -> str:
    normalized = str(value or "").lower()
    if not SHA256_RE.fullmatch(normalized):
        raise RuntimeError(f"{field} is not a lowercase SHA-256 digest")
    return normalized


def _worker_commit(value: Any, field: str) -> str:
    normalized = str(value or "").lower()
    if not WORKER_COMMIT_RE.fullmatch(normalized):
        raise RuntimeError(f"{field} is not a 40-64 character lowercase commit")
    return normalized


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise RuntimeError(f"JSON object contains duplicate key {key!r}")
        value[key] = item
    return value


def _load_json_bytes(value: bytes, field: str) -> Any:
    try:
        return json.loads(value, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{field} is not valid UTF-8 JSON") from error


def _load_json_file(path: Path, field: str) -> Any:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"{field} must be a regular, non-symlink file")
    return _load_json_bytes(path.read_bytes(), field)


def _safe_result_path(value: Any, job_id: str, image_sha256: str) -> PurePosixPath:
    raw = str(value or "")
    path = PurePosixPath(raw)
    expected = PurePosixPath("results") / f"{job_id}--{image_sha256}.json"
    if (
        not raw
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in raw
        or path != expected
    ):
        raise RuntimeError(
            f"Result ledger path for {job_id} is not the canonical safe path {expected}"
        )
    return path


def _load_transfer_map(path: Path) -> tuple[list[dict], dict[str, dict]]:
    path = path.resolve(strict=True)
    rows: list[Any] = []
    for position, line in enumerate(path.read_bytes().splitlines(), start=1):
        if not line.strip():
            continue
        rows.append(_load_json_bytes(line, f"Outbound transfer-map row {position}"))
    if not rows:
        raise RuntimeError("Outbound transfer map is empty")
    by_id: dict[str, dict] = {}
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise RuntimeError(f"Transfer-map row {position} is not an object")
        job_id = row.get("jobId")
        if (
            not isinstance(job_id, str)
            or not OCR_SAFE_JOB_ID_RE.fullmatch(job_id)
            or job_id in by_id
        ):
            raise RuntimeError(f"Transfer-map row {position} has an unsafe or duplicate jobId")
        image_sha256 = _digest(row.get("imageSha256"), f"Transfer-map image for {job_id}")
        expected_directory = f"jobs/{job_id}"
        if row.get("hermesDirectory") != expected_directory:
            raise RuntimeError(
                f"Transfer-map Hermes directory for {job_id} is not {expected_directory}"
            )
        _digest(row.get("manifestSha256"), f"Transfer-map manifest for {job_id}")
        normalized = dict(row)
        normalized["imageSha256"] = image_sha256
        by_id[job_id] = normalized
    return rows, by_id


def _load_result_ledger(path: Path) -> list[dict]:
    value = _load_json_file(path, "Hermes result ledger")
    if isinstance(value, dict):
        value = value.get("results")
    if not isinstance(value, list) or not value:
        raise RuntimeError("Hermes result ledger must be a nonempty array or an object with results[]")
    if not all(isinstance(row, dict) for row in value):
        raise RuntimeError("Hermes result ledger contains a non-object row")
    return value


def _ledger_contract(rows: list[dict]) -> str:
    truthful_markers = [
        isinstance(row.get("resultFilename"), str)
        and isinstance(row.get("imageSha256"), str)
        and "path" not in row
        and "workerVersion" not in row
        and isinstance(row.get("layers"), list)
        and all(
            isinstance(layer, dict)
            and isinstance(layer.get("classification"), str)
            and isinstance(layer.get("selectable"), bool)
            for layer in row.get("layers", [])
        )
        for row in rows
    ]
    gold_markers = [
        isinstance(row.get("resultFilename"), str)
        and isinstance(row.get("imageSha256"), str)
        and isinstance(row.get("path"), str)
        and isinstance(row.get("workerVersion"), str)
        for row in rows
    ]
    smoke_markers = [
        row.get("strictSchemaSemanticProvenanceValid") is True for row in rows
    ]
    if all(truthful_markers):
        return TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT
    if all(gold_markers):
        return GOLD_LEDGER_CONTRACT
    if all(smoke_markers):
        return SMOKE_LEDGER_CONTRACT
    raise RuntimeError(
        "Hermes result ledger is not a supported smoke, gold, or truthful-supplement contract"
    )


def _truthful_layer_claim(
    layer: dict, engine: str, job_id: str, image_sha256: str, field: str
) -> tuple[str, dict]:
    required = {
        "classification", "selectable", "stopReason", "finishReason",
        "truncationKnown", "truncated", "errorType",
    }
    if not required.issubset(layer):
        raise RuntimeError(f"{field} omits supplement state fields: {sorted(required - set(layer))}")
    classification = str(layer.get("classification") or "")
    selectable = layer.get("selectable")
    stop_reason = layer.get("stopReason")
    finish_reason = layer.get("finishReason")
    known = layer.get("truncationKnown")
    truncated = layer.get("truncated")
    error_type = layer.get("errorType")
    if classification == "clean":
        expected_finish = None if engine == "pp-ocrv6" else "stop"
        if (
            selectable is not True
            or known is not True
            or truncated is not False
            or error_type is not None
            or stop_reason != "complete"
            or finish_reason != expected_finish
        ):
            raise RuntimeError(f"{field} has an inconsistent clean classification")
        return classification, dict(layer)
    if classification == "knownTruncated":
        if (
            engine != "ovisocr2"
            or selectable is not False
            or known is not True
            or truncated is not True
            or error_type != "TruncatedGeneration"
            or stop_reason != "truncated"
            or finish_reason != "stop"
            or _digest(layer.get("guardConfigSha256"), f"{field} guard config")
            != OVIS_GUARD_CONFIG_SHA256
            or _digest(layer.get("matchedStopStringSha256"), f"{field} guard stop")
            != OVIS_GUARD_STOP_STRING_SHA256
        ):
            raise RuntimeError(f"{field} is not the exact known Ovis guard classification")
        _digest(layer.get("rawOutputSha256"), f"{field} raw Ovis output")
        return classification, dict(layer)
    if classification == "knownArtifactTruncated":
        spec = TRUTHFUL_ARTIFACT_JOBS.get(job_id)
        if (
            engine != "paddleocr-vl-1.6"
            or spec is None
            or image_sha256 != spec["imageSha256"]
            or selectable is not False
            or known is not True
            or truncated is not True
            or error_type is not None
            or stop_reason != "truncated"
            or finish_reason != "mixed:length,stop,stop,stop,stop,stop,stop"
            or layer.get("artifactCropCharacters") != 8191
            or layer.get("artifactMiddleDots") != 4096
            or layer.get("cleanPageEnding") != spec["pageEnding"]
        ):
            raise RuntimeError(f"{field} is not one of the exact known Paddle artifact truncations")
        reasons = layer.get("rawCropFinishReasons")
        tokens = layer.get("rawCropCompletionTokens")
        content_hashes = layer.get("rawCropContentSha256")
        if (
            reasons != ["length"] + ["stop"] * 6
            or not isinstance(tokens, list)
            or len(tokens) != 7
            or tokens[0] != 4096
            or any(
                isinstance(token, bool) or not isinstance(token, int) or token < 0 or token >= 4096
                for token in tokens[1:]
            )
            or not isinstance(content_hashes, list)
            or len(content_hashes) != 7
        ):
            raise RuntimeError(f"{field} has inconsistent Paddle crop evidence")
        for name in (
            "rawCropResponsesSha256", "rawPipelineResultSha256", "mergedTextSha256",
        ):
            _digest(layer.get(name), f"{field} {name}")
        for position, value in enumerate(content_hashes):
            _digest(value, f"{field} raw crop content {position}")
        return classification, dict(layer)
    raise RuntimeError(f"{field} has unsupported classification {classification!r}")


def _known_truncation_error(
    value: Any, *, require_guard_evidence: bool = False
) -> bool:
    valid = (
        isinstance(value, dict)
        and value.get("type") in {"TruncatedGeneration", "TruncatedOutput"}
        and value.get("retryable") is not True
    )
    if not valid or not require_guard_evidence:
        return valid
    if value.get("type") != "TruncatedGeneration":
        return False
    evidence = value.get("evidence")
    if not isinstance(evidence, dict):
        return False
    try:
        _digest(evidence.get("guardConfigSha256"), "Ovis guard config")
        _digest(evidence.get("matchedStopStringSha256"), "Ovis guard stop string")
    except RuntimeError:
        return False
    return (
        evidence.get("matchedStopPresentInRawOutput") is True
        and evidence.get("evidenceMismatch") is False
    )


def _normalize_layer_category(layer: dict, engine: str, field: str) -> str:
    """Normalize both controller ledgers to the release policy vocabulary.

    The smoke controller called these categories ``clean`` and
    ``knownTruncated``.  The gold controller records the same states as
    ``complete`` and ``truncated`` and carries the state facts alongside the
    category.  Do not make the gold-only fields optional: that would turn an
    omitted fact into an accepted assertion.
    """
    category = str(layer.get("category") or "")
    if category in {"clean", "knownTruncated"}:
        if category == "knownTruncated" and engine != "ovisocr2":
            raise RuntimeError(f"{field} marks a non-Ovis layer known-truncated")
        return category
    if category not in {"complete", "truncated", "error"}:
        return category
    required = {"stopReason", "truncationKnown", "truncated", "error"}
    if not required.issubset(layer):
        missing = sorted(required - set(layer))
        raise RuntimeError(f"{field} omits gold-controller state fields: {missing}")
    stop_reason = layer.get("stopReason")
    known = layer.get("truncationKnown")
    truncated = layer.get("truncated")
    error = layer.get("error")
    if category == "complete":
        if known is not True or truncated is not False or error is not None:
            raise RuntimeError(f"{field} has an inconsistent complete category")
        if stop_reason not in {"complete", "finished"}:
            raise RuntimeError(f"{field} has an inconsistent complete stopReason")
        return "clean"
    if category == "truncated":
        if (
            engine != "ovisocr2"
            or known is not True
            or truncated is not True
            or stop_reason not in {"truncated", "known-truncated"}
            or not _known_truncation_error(error, require_guard_evidence=True)
        ):
            raise RuntimeError(f"{field} is not an accepted known Ovis truncation")
        return "knownTruncated"
    return "error"


def _envelope_layer_category(
    layer: dict, engine: str, field: str, *, require_guard_evidence: bool
) -> str:
    required = {"stopReason", "truncationKnown", "truncated", "error"}
    if not required.issubset(layer):
        missing = sorted(required - set(layer))
        raise RuntimeError(f"{field} omits result state fields: {missing}")
    stop_reason = layer.get("stopReason")
    known = layer.get("truncationKnown")
    truncated = layer.get("truncated")
    error = layer.get("error")
    if (
        engine == "ovisocr2"
        and known is True
        and truncated is True
        and stop_reason in {"truncated", "known-truncated"}
        and _known_truncation_error(
            error, require_guard_evidence=require_guard_evidence
        )
    ):
        return "knownTruncated"
    if (
        known is True
        and truncated is False
        and error is None
        and stop_reason in {"complete", "finished"}
    ):
        return "clean"
    if stop_reason == "error" or error is not None:
        return "error"
    return "unknownTruncation"


def _truthful_ovis_envelope_category(layer: dict, claim: dict, field: str) -> str:
    if (
        layer.get("stopReason") != "truncated"
        or layer.get("finishReason") != "stop"
        or layer.get("truncationKnown") is not True
        or layer.get("truncated") is not True
    ):
        raise RuntimeError(f"{field} does not preserve truthful Ovis truncation state")
    error = layer.get("error")
    if (
        not isinstance(error, dict)
        or error.get("type") != "TruncatedGeneration"
        or error.get("retryable") is not False
    ):
        raise RuntimeError(f"{field} does not preserve the nonretryable Ovis guard error")
    audit = layer.get("audit")
    if not isinstance(audit, dict) or not isinstance(audit.get("rawOutput"), str):
        raise RuntimeError(f"{field} lacks retained raw Ovis output")
    raw = audit["rawOutput"]
    raw_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if raw_hash != claim.get("rawOutputSha256") or raw_hash != audit.get("rawOutputSha256"):
        raise RuntimeError(f"{field} raw Ovis output hash mismatch")
    guard = audit.get("generationRepetitionGuard")
    if not isinstance(guard, dict):
        raise RuntimeError(f"{field} lacks repetition-guard audit evidence")
    exact = {
        "unit": OVIS_GUARD_UNIT,
        "consecutiveUnitThreshold": OVIS_GUARD_CONSECUTIVE_UNIT_THRESHOLD,
        "configSha256": OVIS_GUARD_CONFIG_SHA256,
        "stopStringSha256": OVIS_GUARD_STOP_STRING_SHA256,
        "matchedStopStringSha256": OVIS_GUARD_STOP_STRING_SHA256,
        "nativeStopReasonSha256": OVIS_GUARD_STOP_STRING_SHA256,
        "includeStopStringInOutput": True,
        "triggered": True,
        "evidenceMismatch": False,
        "matchedStopPresentInRawOutput": True,
        "nativeFinishReason": "stop",
        "matchedTailCleanupApplied": True,
        "retainedDiagnosticTailUnits": 1,
    }
    if any(guard.get(name) != value for name, value in exact.items()):
        raise RuntimeError(f"{field} repetition-guard audit mismatch")
    matched = guard.get("matchedStopString")
    start = guard.get("matchedStopStartCharacter")
    end = guard.get("matchedStopEndCharacter")
    if (
        not isinstance(matched, str)
        or hashlib.sha256(matched.encode("utf-8")).hexdigest()
        != OVIS_GUARD_STOP_STRING_SHA256
        or not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or raw[start:end] != matched
        or not raw.endswith(matched)
        or guard.get("nativeStopReason") != matched
    ):
        raise RuntimeError(f"{field} raw Ovis guard span mismatch")
    finish = audit.get("finishSemantics")
    finish_exact = {
        "classification": "configured-repetition-guard",
        "errorType": "TruncatedGeneration",
        "guardTriggered": True,
        "retryable": False,
        "selectable": False,
        "stopReason": "truncated",
        "truncated": True,
        "truncationKnown": True,
    }
    if not isinstance(finish, dict) or any(
        finish.get(name) != value for name, value in finish_exact.items()
    ):
        raise RuntimeError(f"{field} Ovis finish-semantics mismatch")
    evidence = error.get("evidence")
    if (
        not isinstance(evidence, dict)
        or evidence.get("guardConfigSha256") != OVIS_GUARD_CONFIG_SHA256
        or evidence.get("matchedStopStringSha256") != OVIS_GUARD_STOP_STRING_SHA256
        or evidence.get("matchedStopPresentInRawOutput") is not True
        or evidence.get("evidenceMismatch") is not False
    ):
        raise RuntimeError(f"{field} Ovis error evidence mismatch")
    return "knownTruncated"


def _truthful_paddle_envelope_category(
    layer: dict, claim: dict, job: dict, job_id: str, field: str
) -> str:
    spec = TRUTHFUL_ARTIFACT_JOBS[job_id]
    if (
        layer.get("stopReason") != "truncated"
        or layer.get("finishReason") != "mixed:length,stop,stop,stop,stop,stop,stop"
        or layer.get("truncationKnown") is not True
        or layer.get("truncated") is not True
        or layer.get("error") is not None
        or layer.get("maxOutputTokens") != 8192
        or job.get("caseId") != spec["caseId"]
        or job.get("pageNumber") != spec["pageNumber"]
    ):
        raise RuntimeError(f"{field} does not preserve exact Paddle artifact state")
    audit = layer.get("audit")
    raw = audit.get("rawCropResponses") if isinstance(audit, dict) else None
    if (
        not isinstance(raw, list)
        or len(raw) != 7
        or audit.get("cropResponseCount") != 7
        or hashlib.sha256(canonical_json(raw)).hexdigest()
        != claim.get("rawCropResponsesSha256")
        or audit.get("rawCropResponsesSha256") != claim.get("rawCropResponsesSha256")
        or audit.get("rawPipelineResultSha256") != claim.get("rawPipelineResultSha256")
    ):
        raise RuntimeError(f"{field} Paddle raw crop retention/hash mismatch")
    reasons: list[Any] = []
    tokens: list[Any] = []
    content_hashes: list[str] = []
    for position, response in enumerate(raw):
        if not isinstance(response, dict) or len(response.get("choices", [])) != 1:
            raise RuntimeError(f"{field} Paddle crop {position} choice mismatch")
        choice = response["choices"][0]
        if not isinstance(choice, dict):
            raise RuntimeError(f"{field} Paddle crop {position} choice is not an object")
        content = (choice.get("message") or {}).get("content")
        usage = response.get("usage")
        token = usage.get("completion_tokens") if isinstance(usage, dict) else None
        reason = choice.get("finish_reason")
        if not isinstance(content, str) or isinstance(token, bool) or not isinstance(token, int):
            raise RuntimeError(f"{field} Paddle crop {position} content/token mismatch")
        reasons.append(reason)
        tokens.append(token)
        content_hashes.append(hashlib.sha256(content.encode("utf-8")).hexdigest())
        if position == 0:
            if (
                reason != "length"
                or token != 4096
                or len(content) != 8191
                or content.count("·") != 4096
                or re.fullmatch(r"[·\s]+", content) is None
            ):
                raise RuntimeError(f"{field} first Paddle crop is not the exact dot artifact")
        elif (
            reason != "stop"
            or choice.get("stop_reason") is not None
            or token >= 4096
        ):
            raise RuntimeError(f"{field} Paddle crop {position} did not stop naturally")
    if (
        reasons != claim.get("rawCropFinishReasons")
        or tokens != claim.get("rawCropCompletionTokens")
        or content_hashes != claim.get("rawCropContentSha256")
        or layer.get("outputTokenCount") != sum(tokens)
    ):
        raise RuntimeError(f"{field} Paddle crop evidence differs from supplement ledger")
    text = layer.get("text")
    if (
        not isinstance(text, str)
        or hashlib.sha256(text.encode("utf-8")).hexdigest() != claim.get("mergedTextSha256")
        or not text.rstrip().endswith(spec["pageEnding"])
        or f"Interim Decision #{spec['decision']}" not in text
        or (
            spec["requiredFootnote"] is not None
            and spec["requiredFootnote"] not in text
        )
    ):
        raise RuntimeError(f"{field} Paddle merged text/page-ending evidence mismatch")
    return "knownArtifactTruncated"


def _truthful_envelope_layer_category(
    layer: dict, claim: dict, job: dict, job_id: str, field: str
) -> str:
    if layer.get("engine") != claim.get("engine"):
        raise RuntimeError(f"{field} engine differs from supplement claim")
    classification = claim.get("classification")
    if classification == "clean":
        actual = _envelope_layer_category(
            layer, str(layer.get("engine")), field, require_guard_evidence=True
        )
        if actual != "clean":
            raise RuntimeError(f"{field} is not clean as claimed")
        expected_finish = None if layer.get("engine") == "pp-ocrv6" else "stop"
        if layer.get("finishReason") != expected_finish:
            raise RuntimeError(f"{field} has an unexpected clean finishReason")
        return actual
    if classification == "knownTruncated":
        return _truthful_ovis_envelope_category(layer, claim, field)
    if classification == "knownArtifactTruncated":
        return _truthful_paddle_envelope_category(layer, claim, job, job_id, field)
    raise RuntimeError(f"{field} has unsupported supplement classification")


def validate_download_plan(
    transfer_map_path: Path,
    ledger_path: Path,
    *,
    expected_transfer_map_sha256: str | None = None,
    expected_job_count: int | None = None,
    expected_ledger_sha256: str | None = None,
    expected_worker_commit: str | None = None,
    reject_unknown_or_error_categories: bool = False,
) -> dict:
    """Bind one remote result-ledger row to every outbound job."""
    if transfer_map_path.is_symlink() or not transfer_map_path.is_file():
        raise RuntimeError("Outbound transfer map must be a regular, non-symlink file")
    transfer_map_path = transfer_map_path.resolve(strict=True)
    actual_transfer_map_sha256 = _sha256(transfer_map_path)
    if expected_transfer_map_sha256 is not None:
        expected_hash = _digest(
            expected_transfer_map_sha256, "Expected transfer-map hash"
        )
        if actual_transfer_map_sha256 != expected_hash:
            raise RuntimeError(
                "Outbound transfer map does not match its externally pinned SHA-256"
            )
    transfer_rows, transfer_by_id = _load_transfer_map(transfer_map_path)
    if expected_job_count is not None:
        if (
            isinstance(expected_job_count, bool)
            or not isinstance(expected_job_count, int)
            or expected_job_count <= 0
        ):
            raise RuntimeError("Expected job count must be a positive integer")
        if len(transfer_rows) != expected_job_count:
            raise RuntimeError(
                f"Outbound transfer map has {len(transfer_rows)} jobs, expected {expected_job_count}"
            )
    if ledger_path.is_symlink() or not ledger_path.is_file():
        raise RuntimeError("Hermes result ledger must be a regular, non-symlink file")
    ledger_path = ledger_path.resolve(strict=True)
    actual_ledger_sha256 = _sha256(ledger_path)
    if expected_ledger_sha256 is not None:
        expected_hash = _digest(expected_ledger_sha256, "Expected result-ledger hash")
        if actual_ledger_sha256 != expected_hash:
            raise RuntimeError("Hermes result ledger does not match its externally pinned SHA-256")
    worker_pin = (
        _worker_commit(expected_worker_commit, "Expected worker commit")
        if expected_worker_commit is not None else None
    )
    ledger_rows = _load_result_ledger(ledger_path)
    contract = _ledger_contract(ledger_rows)
    if contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT and worker_pin is None:
        raise RuntimeError(
            "Truthful supplement ledger requires an external expected worker commit"
        )
    ledger_by_id: dict[str, dict] = {}
    truthful_artifact_ids: set[str] = set()
    for position, row in enumerate(ledger_rows, start=1):
        job_id = row.get("jobId")
        if not isinstance(job_id, str) or job_id not in transfer_by_id:
            raise RuntimeError(f"Result-ledger row {position} has unknown jobId {job_id!r}")
        if job_id in ledger_by_id:
            raise RuntimeError(f"Hermes result ledger duplicates {job_id}")
        transfer = transfer_by_id[job_id]
        if contract in {GOLD_LEDGER_CONTRACT, TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT}:
            ledger_image = _digest(
                row.get("imageSha256"), f"Result-ledger image for {job_id}"
            )
            if ledger_image != transfer["imageSha256"]:
                raise RuntimeError(f"Result-ledger image for {job_id} differs from transfer map")
            expected_filename = f"{job_id}--{transfer['imageSha256']}.json"
            if row.get("resultFilename") != expected_filename:
                raise RuntimeError(
                    f"Result-ledger filename for {job_id} is not {expected_filename}"
                )
        if contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT:
            result_path = _safe_result_path(
                f"results/{expected_filename}", job_id, transfer["imageSha256"]
            )
        else:
            result_path = _safe_result_path(
                row.get("path"), job_id, transfer["imageSha256"]
            )
        result_sha256 = _digest(row.get("sha256"), f"Result file for {job_id}")
        size = row.get("bytes")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise RuntimeError(f"Result-ledger byte count for {job_id} must be a positive integer")
        if (
            contract == SMOKE_LEDGER_CONTRACT
            and row.get("strictSchemaSemanticProvenanceValid") is not True
        ):
            raise RuntimeError(f"Hermes did not mark {job_id} strict semantic/provenance validation valid")
        row_worker = (
            worker_pin
            if contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT
            else _worker_commit(
                row.get("workerVersion"), f"Result-ledger worker for {job_id}"
            )
        )
        assert row_worker is not None
        if worker_pin is not None and row_worker != worker_pin:
            raise RuntimeError(f"Result-ledger worker for {job_id} does not match the accepted release")
        layers = row.get("layers")
        if not isinstance(layers, list) or len(layers) != len(EXPECTED_ENGINES):
            raise RuntimeError(f"Result-ledger layers for {job_id} are not the complete engine set")
        engines = [layer.get("engine") if isinstance(layer, dict) else None for layer in layers]
        if engines != list(EXPECTED_ENGINES):
            raise RuntimeError(f"Result-ledger engine order for {job_id} is not the accepted order")
        categories: list[str] = []
        layer_claims: list[dict] = []
        for layer in layers:
            assert isinstance(layer, dict)
            engine = str(layer.get("engine") or "")
            if contract == SMOKE_LEDGER_CONTRACT:
                layer_worker = _worker_commit(
                    layer.get("workerGitCommit"),
                    f"Result-ledger layer worker for {job_id}/{engine}",
                )
                if layer_worker != row_worker:
                    raise RuntimeError(f"Result-ledger worker/layer commit mismatch for {job_id}")
            elif "workerGitCommit" in layer:
                layer_worker = _worker_commit(
                    layer.get("workerGitCommit"),
                    f"Result-ledger layer worker for {job_id}/{engine}",
                )
                if layer_worker != row_worker:
                    raise RuntimeError(f"Result-ledger worker/layer commit mismatch for {job_id}")
            if contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT:
                category, claim = _truthful_layer_claim(
                    layer,
                    engine,
                    job_id,
                    transfer["imageSha256"],
                    f"Result-ledger layer {job_id}/{engine}",
                )
                layer_claims.append(claim)
                if category == "knownArtifactTruncated":
                    truthful_artifact_ids.add(job_id)
            else:
                category = _normalize_layer_category(
                    layer, engine, f"Result-ledger layer {job_id}/{engine}"
                )
            categories.append(category)
            if reject_unknown_or_error_categories and category not in ALLOWED_RELEASE_CATEGORIES:
                raise RuntimeError(
                    f"Result-ledger layer {job_id}/{engine} has unacceptable category {category!r}"
                )
        ledger_by_id[job_id] = {
            "jobId": job_id,
            "imageSha256": transfer["imageSha256"],
            "path": result_path.as_posix(),
            "bytes": size,
            "sha256": result_sha256,
            "workerVersion": row_worker,
            "categories": categories,
            "layerClaims": layer_claims,
        }
    missing = [row["jobId"] for row in transfer_rows if row["jobId"] not in ledger_by_id]
    if missing:
        raise RuntimeError(
            f"Hermes result ledger is missing {len(missing)} outbound job(s): {', '.join(missing[:10])}"
        )
    if (
        contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT
        and truthful_artifact_ids != set(TRUTHFUL_ARTIFACT_JOBS)
    ):
        raise RuntimeError(
            "Truthful supplement ledger does not contain exactly the two approved Paddle artifact jobs"
        )
    ordered = [ledger_by_id[row["jobId"]] for row in transfer_rows]
    return {
        "valid": True,
        "jobCount": len(ordered),
        "ledgerContract": contract,
        "transferMapSha256": actual_transfer_map_sha256,
        "resultLedgerSha256": actual_ledger_sha256,
        "expectedWorkerCommit": worker_pin,
        "rejectUnknownOrErrorCategories": reject_unknown_or_error_categories,
        "releasePolicyEvidenceStatus": (
            "pending-downloaded-envelope-verification"
            if contract == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT
            else "ledger-claims-bound; envelope verification still required"
        ),
        "retrievalPaths": [row["path"] for row in ordered],
        "results": ordered,
        "selection": "none; this verifies transport bytes only",
    }


def write_files_from(plan: dict, output_path: Path) -> str:
    """Write the validated, newline-delimited rsync path allowlist."""
    value = "".join(f"{path}\n" for path in plan["retrievalPaths"]).encode("utf-8")
    atomic_write(output_path.resolve(), value)
    return hashlib.sha256(value).hexdigest()


def verify_downloaded_results(plan: dict, download_root: Path) -> dict:
    """Verify exact downloaded files against the already-validated ledger."""
    if download_root.is_symlink():
        raise RuntimeError("Download root must be a regular, non-symlink directory")
    download_root = download_root.resolve(strict=True)
    if not download_root.is_dir() or download_root.is_symlink():
        raise RuntimeError("Download root must be a regular, non-symlink directory")
    expected_paths = {row["path"] for row in plan["results"]}
    actual_paths: set[str] = set()
    for candidate in download_root.rglob("*"):
        if candidate.is_symlink():
            raise RuntimeError(f"Downloaded result tree contains a symlink: {candidate}")
        if candidate.is_file():
            actual_paths.add(candidate.relative_to(download_root).as_posix())
        elif not candidate.is_dir():
            raise RuntimeError(
                f"Downloaded result tree contains a non-regular entry: {candidate}"
            )
    missing = sorted(expected_paths - actual_paths)
    extra = sorted(actual_paths - expected_paths)
    if missing or extra:
        raise RuntimeError(
            f"Downloaded result byte set differs from the ledger; missing={missing[:10]}, extra={extra[:10]}"
        )
    total_bytes = 0
    for row in plan["results"]:
        path = download_root / row["path"]
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Downloaded result is not a regular file for {row['jobId']}")
        stat = path.stat()
        if stat.st_size != row["bytes"]:
            raise RuntimeError(f"Downloaded byte count mismatch for {row['jobId']}")
        if _sha256(path) != row["sha256"]:
            raise RuntimeError(f"Downloaded SHA-256 mismatch for {row['jobId']}")
        envelope = _load_json_file(path, f"Downloaded result for {row['jobId']}")
        if not isinstance(envelope, dict) or envelope.get("schemaVersion") != HERMES_RESULT_SCHEMA:
            raise RuntimeError(f"Downloaded result for {row['jobId']} is not one envelope object")
        job = envelope.get("job")
        worker = envelope.get("worker")
        if (
            not isinstance(job, dict)
            or job.get("schemaVersion") != HERMES_JOB_SCHEMA
            or job.get("jobId") != row["jobId"]
        ):
            raise RuntimeError(f"Downloaded envelope identity mismatch for {row['jobId']}")
        if _digest(job.get("imageSha256"), f"Envelope image for {row['jobId']}") != row["imageSha256"]:
            raise RuntimeError(f"Downloaded envelope image mismatch for {row['jobId']}")
        if (
            not isinstance(worker, dict)
            or worker.get("hostClass") != "rtx-5090"
            or str(worker.get("workerVersion") or "").lower() != row["workerVersion"]
        ):
            raise RuntimeError(f"Downloaded envelope worker mismatch for {row['jobId']}")
        requested = job.get("requestedEngines")
        if (
            not isinstance(requested, list)
            or len(requested) != len(EXPECTED_ENGINES)
            or not all(isinstance(engine, str) for engine in requested)
            or set(requested) != set(EXPECTED_ENGINES)
        ):
            raise RuntimeError(f"Downloaded envelope engine request mismatch for {row['jobId']}")
        layers = envelope.get("layers")
        if not isinstance(layers, list) or len(layers) != len(EXPECTED_ENGINES):
            raise RuntimeError(f"Downloaded envelope layers mismatch for {row['jobId']}")
        engines = [layer.get("engine") if isinstance(layer, dict) else None for layer in layers]
        if engines != list(EXPECTED_ENGINES):
            raise RuntimeError(f"Downloaded envelope engine order mismatch for {row['jobId']}")
        envelope_categories: list[str] = []
        layer_claims = row.get("layerClaims", [])
        if (
            plan.get("ledgerContract") == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT
            and len(layer_claims) != len(layers)
        ):
            raise RuntimeError(f"Supplement layer claims are incomplete for {row['jobId']}")
        for layer_index, layer in enumerate(layers):
            assert isinstance(layer, dict)
            engine = str(layer["engine"])
            provenance = layer.get("provenance")
            if (
                not isinstance(provenance, dict)
                or str(provenance.get("workerGitCommit") or "").lower()
                != row["workerVersion"]
            ):
                raise RuntimeError(
                    f"Downloaded envelope layer worker mismatch for {row['jobId']}/{engine}"
                )
            field = f"Downloaded envelope layer {row['jobId']}/{engine}"
            if plan.get("ledgerContract") == TRUTHFUL_SUPPLEMENT_LEDGER_CONTRACT:
                envelope_categories.append(
                    _truthful_envelope_layer_category(
                        layer,
                        layer_claims[layer_index],
                        job,
                        row["jobId"],
                        field,
                    )
                )
            else:
                envelope_categories.append(
                    _envelope_layer_category(
                        layer,
                        engine,
                        field,
                        require_guard_evidence=(
                            plan.get("ledgerContract") == GOLD_LEDGER_CONTRACT
                        ),
                    )
                )
        if envelope_categories != row["categories"]:
            raise RuntimeError(
                f"Downloaded envelope category mismatch for {row['jobId']}"
            )
        if plan.get("rejectUnknownOrErrorCategories") and any(
            category not in ALLOWED_RELEASE_CATEGORIES
            for category in envelope_categories
        ):
            raise RuntimeError(f"Downloaded envelope has an unacceptable layer for {row['jobId']}")
        if (
            "knownArtifactTruncated" in envelope_categories
            and envelope_categories[0] != "clean"
        ):
            raise RuntimeError(
                f"Downloaded Paddle artifact lacks a clean PP companion for {row['jobId']}"
            )
        total_bytes += stat.st_size
    return {
        "valid": True,
        "verifiedFiles": len(plan["results"]),
        "verifiedBytes": total_bytes,
        "resultLedgerSha256": plan["resultLedgerSha256"],
        "releasePolicyEvidenceStatus": "verified-from-downloaded-envelopes",
        "selection": "none; raw envelopes remain immutable evidence",
    }
