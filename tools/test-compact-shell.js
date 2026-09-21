"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { compactShell } = require("./compact-shell");

async function main() {
  const text = "/* literal comment */\n// literal line\n  preserve indentation\n<!-- literal markup -->\n</script>\u2028";
  const code = `globalThis.result = ${JSON.stringify(text).replace(/<\/script/gi, "<\\/script")};`;
  const template = `<!-- remove --><script>${code}</script><script type="text/plain">${code}</script><script type="application/json">{"keep":"/* literal */"}</script>`;
  const compacted = await compactShell(template);
  assert(!compacted.startsWith("<!-- remove -->"));
  const scripts = [...compacted.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3, "A script string terminated its containing script.");
  for (const script of scripts.slice(0, 2)) {
    const context = vm.createContext({});
    new vm.Script(script[1]).runInContext(context);
    assert.equal(context.result, text, "Compaction changed a JavaScript string.");
  }
  assert.deepEqual(JSON.parse(scripts[2][1]), { keep: "/* literal */" });
  assert.equal(compacted, await compactShell(template), "Shell compaction is not deterministic.");
  console.log("PASS shell compaction: parsed scripts, inert worker, literal text, JSON and deterministic output");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
