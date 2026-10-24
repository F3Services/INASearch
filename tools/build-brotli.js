"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const acorn = require("acorn");
const root = path.join(__dirname, "..");
function buildBrotliRuntime() {
  const directory = path.join(root, "src/brotli");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  for (const name of ["decoder.js", "decoder_bg.wasm"]) {
    const expected = manifest.files?.[name];
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex");
    if (actual !== expected) throw new Error(`Pinned Brotli decoder checksum mismatch: ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.sources)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
    if (actual !== expected) throw new Error(`Rebuild the Brotli decoder after changing its source: ${name}`);
  }
  const source = fs.readFileSync(path.join(directory, "decoder.js"), "utf8");
  const program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const glue = program.body.map(node => {
    if (node.type === "ExportDefaultDeclaration") return "";
    if (node.type === "ExportNamedDeclaration") return node.declaration ? source.slice(node.declaration.start, node.declaration.end) : "";
    if (node.type === "FunctionDeclaration" && ["__wbg_init", "__wbg_load"].includes(node.id.name)) return "";
    return source.slice(node.start, node.end);
  }).join("\n").replace(/\s*__wbg_init\.__wbindgen_wasm_module = module;/, "");
  const factory = `function createDecoder(encoded) {
    ${glue}
    let ready = false;
    return (bytes, limit) => {
      if (!ready) {
        if (typeof WebAssembly !== "object") throw new Error("This browser does not support WebAssembly. Use the uncompressed edition.");
        initSync({ module: Uint8Array.from(atob(encoded), char => char.charCodeAt(0)) });
        ready = true;
      }
      return decompress(bytes, limit);
    };
  }`;
  const binary = fs.readFileSync(path.join(directory, "decoder_bg.wasm")).toString("base64");
  const runtime = fs.readFileSync(path.join(root, "src/INASearch-Brotli.js"), "utf8")
    .replace("/* INA_SEARCH_DECODER_FACTORY */", () => factory)
    .replace("/* INA_SEARCH_DECODER_BINARY */", () => JSON.stringify(binary));
  acorn.parse(runtime, { ecmaVersion: "latest", sourceType: "script" });
  return runtime;
}
module.exports = { buildBrotliRuntime };
