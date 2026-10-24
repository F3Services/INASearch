#!/usr/bin/env node
"use strict";
require("./check-node");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const rust = "1.90.0", bindings = "0.2.105";
const target = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), "inasearch-brotli-build");
const flags = ["-C", "link-arg=--max-memory=268435456", `--remap-path-prefix=${root}=/source`, `--remap-path-prefix=${process.env.CARGO_HOME || path.join(os.homedir(), ".cargo")}=/cargo`, `--remap-path-prefix=${process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup")}=/rustup`];
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
const manifestPath = "tools/brotli-decoder/Cargo.toml";
function cargo(args, capture = false) {
  return execFileSync("cargo", [`+${rust}`, ...args, "--manifest-path", manifestPath], { cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
}
const tree = cargo(["tree", "--locked", "--edges", "features"], true);
if (/feature "(?:unsafe|ffi-api|seccomp|no-stdlib-ffi-binding)"/.test(tree)) throw new Error("Unsafe Brotli features must remain disabled.");
if (execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim() !== `wasm-bindgen ${bindings}`) throw new Error(`Install wasm-bindgen-cli ${bindings}.`);
cargo(["build", "--locked", "--target", "wasm32-unknown-unknown", "--release"]);
execFileSync("wasm-bindgen", [path.join(target, "wasm32-unknown-unknown/release/inasearch_brotli_decoder.wasm"), "--target", "web", "--out-dir", "src/brotli", "--out-name", "decoder", "--no-typescript"], { cwd: root, stdio: "inherit" });
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
const lock = fs.readFileSync(path.join(root, "tools/brotli-decoder/Cargo.lock"), "utf8");
const rustCrates = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)"\nchecksum = "([^"]+)")?/g)]
  .filter(match => match[3]).map(match => ({ name: match[1], version: match[2], checksum: match[4] }));
const manifest = { schemaVersion: 1, decoder: "brotli-decompressor", version: "5.0.3", wasmBindgen: bindings, rust, features: ["std"], unsafeFeatures: false, outputLimitBytes: 67108864, memoryLimitBytes: 268435456,
  files: Object.fromEntries(["decoder.js", "decoder_bg.wasm"].map(name => [name, digest(`src/brotli/${name}`)])),
  sources: Object.fromEntries(["tools/brotli-decoder/Cargo.toml", "tools/brotli-decoder/Cargo.lock", "tools/brotli-decoder/src/lib.rs", "tools/build-brotli-decoder.js"].map(name => [name, digest(name)])), rustCrates };
fs.writeFileSync(path.join(root, "src/brotli/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Built pinned, bounded Brotli decoder and dependency manifest.");
