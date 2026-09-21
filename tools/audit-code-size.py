#!/usr/bin/env python3
"""Measure delivered shell separately from embedded corpus; never modify builds.

Run: python3 tools/audit-code-size.py [--history] [--compare path/to/experiment.html]
Sizes are UTF-8 bytes. Gzip figures are local estimates, not network measurements.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zlib

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = re.compile(r"<script\b([^>]*)>([\s\S]*?)</script>", re.I)


def measure(data):
    html = data.decode("utf-8")
    blocks = list(SCRIPTS.finditer(html))
    corpus = next((m for m in blocks if re.search(
        r'id="(?:ina|authority)SearchCorpusData"', m[1])), None)
    payload = corpus[2].encode() if corpus else b""
    shell = (html[:corpus.start(2)] + html[corpus.end(2):]).encode() if corpus else data
    code = [m for m in blocks if not re.search(r'type="application/(?:json|gzip)"', m[1])]
    # Remove scripts first: the reader's print template itself contains <style>.
    markup = SCRIPTS.sub("", html)
    css_bytes = sum(len(m.encode()) for m in re.findall(r"<style[^>]*>([\s\S]*?)</style>", markup))
    js_bytes = sum(len(m[2].encode()) for m in code)
    manifest_block = next((m for m in blocks if re.search(
        r'id="(?:ina|authority)SearchCorpusManifest"', m[1])), None)
    manifest = json.loads(manifest_block[2]) if manifest_block else {}
    return {
        "file_bytes": len(data), "file_sha256": hashlib.sha256(data).hexdigest(),
        "corpus_payload_bytes": len(payload),
        "corpus_payload_sha256": hashlib.sha256(payload).hexdigest() if corpus else None,
        "corpus_gzip_bytes": manifest.get("compressedBytes"),
        "shell_bytes": len(shell), "javascript_bytes": js_bytes, "css_bytes": css_bytes,
        "markup_and_metadata_bytes": len(shell) - js_bytes - css_bytes,
        "gzip_shell_bytes": len(gzip.compress(shell, compresslevel=9, mtime=0)),
        "gzip_file_bytes": len(gzip.compress(data, compresslevel=9, mtime=0)),
        "runtime_blocks": [{
            "id": (re.search(r'id="([^"]+)"', m[1]).group(1)
                   if re.search(r'id="([^"]+)"', m[1]) else f"inline-{i + 1}"),
            "bytes": len(m[2].encode()),
        } for i, m in enumerate(code)],
    }


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--compare", type=Path)
    args = parser.parse_args()
    current = measure((ROOT / "INASearch.html").read_bytes())
    result = {"revision": git("rev-parse", "HEAD"), "units": "UTF-8 bytes",
              "gzip": {"level": 9, "zlib_version": zlib.ZLIB_RUNTIME_VERSION}, "current": current}
    if args.compare:
        comparison = measure(args.compare.read_bytes())
        result["comparison"] = {"path": str(args.compare), **comparison,
                                "same_corpus_payload": comparison["corpus_payload_sha256"] == current["corpus_payload_sha256"],
                                "shell_bytes_saved": current["shell_bytes"] - comparison["shell_bytes"]}
    if args.history:
        result["history"] = []
        for revision in ["06c29da", "ca6e288", "6390e79", "8805300", "7ce2539", "981dc6c", "5dc8857", "d8d7ddb", "HEAD"]:
            names = git("ls-tree", "--name-only", revision).splitlines()
            name = next(n for n in ["INASearch.html", "AuthoritySearch.html"] if n in names)
            data = subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=ROOT)
            sizes = measure(data)
            result["history"].append({"revision": revision,
                "description": git("show", "-s", "--format=%cs %s", revision),
                "external_corpus": not bool(sizes["corpus_payload_bytes"]),
                **{k: sizes[k] for k in ["file_bytes", "corpus_payload_bytes", "shell_bytes"]}})
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
