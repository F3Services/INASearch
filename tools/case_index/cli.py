"""Command-line entry point for the published-case index."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .audit import audit_case_root
from .database import build_database, status_report
from .documents import analysis_fingerprint, analyze_headnotes, download_pdfs, extract_records, import_ocr, load_jsonl, select_records
from .sources import Fetcher, discover_eoir, discover_uscis, write_discovery
from .supporting import build_supporting_indexes


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CASE_ROOT = REPO_ROOT / "sources" / "cases"


def records_for(args: argparse.Namespace) -> list[dict]:
    records = load_jsonl(args.case_root / "manifest.jsonl")
    if args.collection:
        records = [record for record in records if record["sourceCollection"] == args.collection]
    return select_records(records, args.id, args.limit)


def documents_for(records: list[dict], case_root: Path) -> list[dict]:
    output = []
    for record in records:
        path = case_root / "derived" / f"{record['corpusKey']}.json"
        if not path.exists():
            raise RuntimeError(f"No extracted document for {record['corpusKey']}; run extract first")
        output.append(json.loads(path.read_text(encoding="utf-8")))
    return output


def available_documents_for(records: list[dict], case_root: Path) -> list[dict]:
    output = []
    for record in records:
        path = case_root / "derived" / f"{record['corpusKey']}.json"
        if path.exists():
            output.append(json.loads(path.read_text(encoding="utf-8")))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the authoritative published BIA/AG/AAO case index")
    parser.add_argument("--case-root", type=Path, default=DEFAULT_CASE_ROOT)
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover", help="Build a reviewed manifest from EOIR and USCIS publisher pages")
    discover.add_argument("--delay", type=float, default=10.0, help="Seconds between requests to each host (default follows DOJ robots guidance)")

    for name in ["download", "extract", "index", "pipeline"]:
        command = subparsers.add_parser(name)
        command.add_argument("--id", action="append", help="Corpus key or EOIR numeric ID; repeatable")
        command.add_argument("--limit", type=int)
        command.add_argument("--collection", choices=["eoir-precedent-volumes", "uscis-adopted-aao"])
        command.add_argument("--refresh", action="store_true")
        if name in {"extract", "pipeline"}:
            command.add_argument("--available", action="store_true", help="Extract only PDFs already present in the resumable capture ledger")
        if name in {"download", "pipeline"}:
            command.add_argument("--delay", type=float, default=10.0)

    ocr = subparsers.add_parser("import-ocr", help="Attach page-level OCR/VLM JSONL without overwriting native PDF text")
    ocr.add_argument("case_id")
    ocr.add_argument("input", type=Path)

    status = subparsers.add_parser("status", help="Show explicit incoming treatment for one indexed case")
    status.add_argument("citation", help="Official citation or corpus key")

    audit = subparsers.add_parser("audit", help="Verify manifest, PDFs, extracted spans, and SQLite integrity")
    audit.add_argument("--strict", action="store_true", help="Require every manifest case in every pipeline layer")

    watch = subparsers.add_parser("watch", help="Extract newly captured PDFs until the authoritative manifest is complete")
    watch.add_argument("--poll", type=float, default=30.0, help="Seconds between capture-ledger checks (maximum 60)")
    watch.add_argument("--idle-timeout", type=float, default=1800.0, help="Fail after this many seconds without a new capture or extraction")

    subparsers.add_parser("supporting", help="Parse checksummed first-party supporting indexes and charts")

    args = parser.parse_args()
    args.case_root = args.case_root.resolve()
    if args.command == "discover":
        fetcher = Fetcher(args.delay)
        eoir, eoir_pages = discover_eoir(fetcher)
        uscis, uscis_page = discover_uscis(fetcher)
        records = sorted([*eoir, *uscis], key=lambda item: (item["sourceCollection"], item.get("volume", 999), item.get("reporterPage", 99999), item["corpusKey"]))
        write_discovery(args.case_root, records, [*eoir_pages, uscis_page])
        print(json.dumps({"records": len(records), "eoir": len(eoir), "uscisAdopted": len(uscis)}, indent=2))
        return
    if args.command == "import-ocr":
        document = import_ocr(REPO_ROOT, args.case_root, args.case_id, args.input)
        print(json.dumps({"caseId": args.case_id, "pages": len(document["pages"])}, indent=2))
        return
    if args.command == "status":
        print(json.dumps(status_report(args.case_root / "index" / "published-cases.sqlite3", args.citation), indent=2, ensure_ascii=False))
        return
    if args.command == "audit":
        report = audit_case_root(REPO_ROOT, args.case_root, args.strict)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        if not report["ok"]:
            raise SystemExit(1)
        return
    if args.command == "supporting":
        records = load_jsonl(args.case_root / "manifest.jsonl")
        print(json.dumps(build_supporting_indexes(REPO_ROOT, args.case_root, records), indent=2, ensure_ascii=False))
        return
    if args.command == "watch":
        records = load_jsonl(args.case_root / "manifest.jsonl")
        record_by_id = {record["corpusKey"]: record for record in records}
        required_ids = {
            record["corpusKey"] for record in records if record.get("captureRequired") is not False
        }
        fingerprint = analysis_fingerprint(REPO_ROOT)
        poll = max(1.0, min(60.0, args.poll))
        last_progress = time.monotonic()
        prior_captures = -1
        while True:
            captures = {item["corpusKey"]: item for item in load_jsonl(args.case_root / "capture.jsonl")}
            pending = []
            for corpus_key in sorted(set(captures) & set(record_by_id)):
                record = record_by_id[corpus_key]
                path = args.case_root / "derived" / f"{corpus_key}.json"
                if path.exists():
                    document = json.loads(path.read_text(encoding="utf-8"))
                    if (
                        document.get("case") == record
                        and document.get("sourceArtifact", {}).get("sha256") == captures[corpus_key]["sha256"]
                        and document.get("extraction", {}).get("analysisFingerprint") == fingerprint
                    ):
                        continue
                pending.append(record)
            if pending:
                extract_records(REPO_ROOT, args.case_root, pending)
                last_progress = time.monotonic()
            if len(captures) != prior_captures:
                prior_captures = len(captures)
                last_progress = time.monotonic()
                print(
                    f"capture progress: {len(set(captures) & required_ids)}/{len(required_ids)} publisher-available; "
                    f"pending extraction: {len(pending)}",
                    flush=True,
                )
            if required_ids <= set(captures):
                documents = available_documents_for(records, args.case_root)
                if len(documents) != len(required_ids):
                    raise RuntimeError(
                        f"Capture complete but only {len(documents)} of {len(required_ids)} publisher-available cases were extracted"
                    )
                headnotes = analyze_headnotes(REPO_ROOT, args.case_root, records)
                print(json.dumps(build_database(args.case_root, documents, records, headnotes), indent=2))
                return
            if time.monotonic() - last_progress >= args.idle_timeout:
                raise RuntimeError(
                    f"No capture or extraction progress for {args.idle_timeout:g} seconds; restart the downloader and then this watcher"
                )
            time.sleep(poll)
    records = records_for(args)
    if args.command in {"download", "pipeline"}:
        download_pdfs(args.case_root, records, Fetcher(args.delay), args.refresh)
        if args.command == "download":
            return
    if args.command in {"extract", "pipeline"}:
        extraction_records = records
        if args.available or args.command == "pipeline":
            capture_ids = {item["corpusKey"] for item in load_jsonl(args.case_root / "capture.jsonl")}
            extraction_records = [record for record in records if record["corpusKey"] in capture_ids]
        documents = extract_records(REPO_ROOT, args.case_root, extraction_records, args.refresh)
        if args.command == "extract":
            return
    else:
        # A full index is useful before the deliberately throttled PDF crawl
        # finishes. Explicit subsets remain strict so typos do not silently
        # produce metadata-only results.
        documents = documents_for(records, args.case_root) if args.id or args.limit else available_documents_for(records, args.case_root)
    headnotes = analyze_headnotes(REPO_ROOT, args.case_root, records, args.refresh)
    print(json.dumps(build_database(args.case_root, documents, records, headnotes), indent=2))


if __name__ == "__main__":
    main()
