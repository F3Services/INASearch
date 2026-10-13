"use strict";
const fs = require("node:fs");
const acorn = require("acorn");

// Turn the pinned decoder's ESM glue into a classic inline script. Initialize
// synchronously from embedded bytes: no URL, import, fetch, or CDN is needed.
function buildBrotliRuntime() {
  const source = fs.readFileSync(require.resolve("brotli-dec-wasm/web"), "utf8");
  const program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const exports = program.body.filter(node => node.type === "ExportNamedDeclaration").flatMap(node => node.specifiers);
  const init = exports.find(item => item.exported.name === "initSync")?.local.name;
  const asyncInit = exports.find(item => item.exported.name === "default")?.local.name;
  if (!init || !asyncInit) throw new Error("Unsupported Brotli decoder exports.");
  const glue = program.body.map(node => {
    if (node.type === "ExportNamedDeclaration") return node.declaration ? source.slice(node.declaration.start, node.declaration.end) : "";
    if (node.type === "FunctionDeclaration" && node.id.name === asyncInit) return "";
    return source.slice(node.start, node.end);
  }).join("\n");
  acorn.parse(glue, { ecmaVersion: "latest", sourceType: "script" });
  const wasm = fs.readFileSync(require.resolve("brotli-dec-wasm/web/bg.wasm")).toString("base64");
  return `(() => {
    ${glue}
    let initialized = false;
    globalThis.INASearchBrotli = Object.freeze({ decode(bytes) {
      if (!initialized) {
        if (typeof WebAssembly !== "object") throw new Error("This browser does not support WebAssembly required to open the compressed corpus. Use the uncompressed edition.");
        const binary = atob("${wasm}");
        const module = Uint8Array.from(binary, char => char.charCodeAt(0));
        ${init}({ module });
        initialized = true;
        globalThis.INA_SEARCH_MARK_PERFORMANCE?.("brotli-decoder-ready");
      }
      return decompress(bytes);
    } });
  })();`;
}
module.exports = { buildBrotliRuntime };
