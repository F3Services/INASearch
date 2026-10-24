# Embedded Brotli decoder

Ordinary `npm run build` uses the checked-in `src/brotli/decoder_bg.wasm` and JavaScript binding. It checks their SHA-256 hashes and the pinned source hashes before embedding them. No decoder is fetched at runtime.

The wrapper uses `brotli-decompressor` **5.0.3**, with its default safe `std` implementation. It disables the optional unsafe and FFI features. The low-level streaming API writes into a fixed buffer sized to the verified corpus manifest; extra output, incomplete streams, invalid padding and trailing input are rejected. The output ceiling is 64 MiB and the WebAssembly linear-memory maximum is 256 MiB. The browser checks the compressed size and SHA-256 before decoding and the resulting size and SHA-256 afterward.

Decoding normally runs in a temporary offline Blob worker, with a 30-second deadline and termination after its outstanding requests finish. Browsers that cannot construct workers use the same bounded decoder on the main thread. Cached openings and the uncompressed edition do not require Brotli decoding.

## Rebuild

Install Rust **1.90.0** with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` **0.2.105**. Then run:

```sh
node tools/build-brotli-decoder.js
node --test tools/test-brotli-security.js tools/test-corpus-security.js
npm run build
npm test
```

The script builds with `Cargo.lock`, rejects unsafe features, remaps machine paths, and refreshes `src/brotli/manifest.json`. `CARGO_TARGET_DIR` may select a build cache; otherwise the operating system temporary directory is used. Retain the generated bindings, WASM and manifest together. Review the binary/source hash changes and rerun browser loading and performance checks before publishing them.

## Dependency checks

The npm dependency graph does not describe crates compiled into WebAssembly. `Cargo.lock` records exact crate versions and registry checksums, and `src/brotli/manifest.json` lists them separately for advisory scanners. Audit the Rust lockfile as well as npm dependencies (for example with `cargo audit --file tools/brotli-decoder/Cargo.lock` and the RustSec/OSV advisory databases). Review new upstream decoder releases and Node security releases before shipping; update the Node floors in `tools/check-node.js`, package engines and CI when adopting another supported major.

The regression tests cover the Node CVE-2026-111497 input, the upstream PADDING_2 bug, truncation, trailing data, output expansion, manifest integrity, worker concurrency/failure/cleanup and the bounded fallback. These tests supplement dependency advisory checks; they do not establish the absence of unknown vulnerabilities.
