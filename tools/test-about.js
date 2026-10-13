#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/INASearch.template.html"), "utf8");
const start = source.indexOf("    function renderCorpusAudit() {");
const end = source.indexOf("    function localCalendarDate", start);

function audit(manifest) {
  const els = { corpusManifestDetails: {}, corpusAuditPowerShell: {}, corpusPackagingDescription: {} };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderCorpusAudit();`, {
    corpusManifest: manifest, els, build: { fileName: "Fixture.html" }, escapeHtml: String
  });
  return { details: els.corpusManifestDetails.innerHTML, description: els.corpusPackagingDescription.textContent };
}

// Changing edition or payload format must change the explanation and measured sizes.
const packed = audit({ compression: "gzip", encoding: "base64", deliveryPacking: "compact-v1", compressedBytes: 1234567, uncompressedBytes: 9876543 });
assert.match(packed.description || "", /one.*gzip/i, "A single-payload build must not be described as separate metadata and content chunks.");
assert.match(packed.details, /1\.23 MB/);
assert.match(packed.details, /1,234,567 bytes/);
assert.match(packed.details, /Packed JSON/);
assert.match(packed.details, /9,876,543 bytes/);
const plain = audit({ compression: "none", encoding: "utf-8", uncompressedBytes: 2468135 });
assert.match(plain.description, /expanded.*JSON/i);
assert.match(plain.details, /Expanded JSON/);
assert.match(plain.details, /2\.47 MB/);
assert(!plain.details.includes("gzip bytes"));
const sharded = audit({ compression: "gzip", compressedBytes: 20, uncompressedBytes: 40, shards: [{ compressedBytes: 30, uncompressedBytes: 60 }] });
assert.match(sharded.description, /1 content chunk/);
assert.match(sharded.details, /50 bytes/);
assert.match(sharded.details, /100 bytes/);
console.log("PASS About corpus details: edition-specific packaging and manifest-derived byte totals");

// FAQ compilation must retain answers, lists, code, and usable links in an offline file.
const compilerPath = path.join(root, "tools/build-about.js");
assert(fs.existsSync(compilerPath), "The standalone build needs a FAQ compiler so it can embed the documentation instead of linking to a missing local file.");
const { buildFaqMarkup } = require(compilerPath);
const fixture = "# FAQ\n\nIntro.\n\n## General\n\n### Can I work offline?\n\n**Yes.** See [the guide](README.md). A literal `<tag>` remains code.\n\n- Search locally.\n- Keep notes.\n\n## Verification\n\n### Can I inspect it?\n\n```xml\n<ref href=\"/usc\">Text & evidence</ref>\n```\n\n1. Decode it.\n2. Verify it.\n\n<script>alert('unsafe')</script>\n";
const faq = buildFaqMarkup(fixture);
assert.equal((faq.match(/<details\b/g) || []).length, 2);
assert(faq.includes('<h3>General</h3>'));
assert(faq.includes('<strong>Yes.</strong>'));
assert(faq.includes('href="https://github.com/F3Services/INASearch/blob/main/README.md"'));
assert(faq.includes('<code>&lt;tag&gt;</code>'));
assert(faq.includes('<ul><li>Search locally.</li><li>Keep notes.</li></ul>'));
assert(faq.includes('<pre><code>&lt;ref href=&quot;/usc&quot;&gt;Text &amp; evidence&lt;/ref&gt;</code></pre>'));
assert(faq.includes('<ol><li>Decode it.</li><li>Verify it.</li></ol>'));
assert(!faq.includes('<script>'));
assert.throws(() => buildFaqMarkup('## General\n### Bad link?\n[open](javascript:alert)'), /link/i);
assert.throws(() => buildFaqMarkup('## General\n### Broken code?\n```\nunfinished'), /fence/i);
console.log("PASS FAQ compilation: grouped answers, escaped examples, portable links, and malformed-input rejection");
