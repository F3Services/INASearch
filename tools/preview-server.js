#!/usr/bin/env node
"use strict";

// Development-only LAN preview. Never serves directory contents or user data.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const file = path.resolve(__dirname, "../INASearch.html");
const port = Number(process.env.INASEARCH_PREVIEW_PORT || 8765);
// HTTP LAN origins lack SubtleCrypto. Keep hashing local to the browser.
const compatibility = `<script>
if (!globalThis.crypto.subtle) {
  const primes = [], constants = [];
  for (let n = 2; primes.length < 64; n++) {
    if (primes.every(p => n % p)) { primes.push(n); constants.push((Math.cbrt(n) % 1 * 4294967296) >>> 0); }
  }
  const initial = primes.slice(0,8).map(n => (Math.sqrt(n) % 1 * 4294967296) >>> 0);
  const rotate = (x,n) => (x >>> n) | (x << (32-n));
  Object.defineProperty(globalThis.crypto, 'subtle', {value: {async digest(algorithm, input) {
    if (String(algorithm.name || algorithm).toUpperCase() !== 'SHA-256') throw Error('Unsupported preview digest');
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer,input.byteOffset,input.byteLength) : new Uint8Array(input);
    const padded = new Uint8Array(Math.ceil((bytes.length+9)/64)*64);
    padded.set(bytes); padded[bytes.length]=128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length-8,Math.floor(bytes.length/536870912));
    view.setUint32(padded.length-4,(bytes.length*8)>>>0);
    const h=initial.slice(), w=new Uint32Array(64);
    for(let offset=0;offset<padded.length;offset+=64) {
      for(let i=0;i<16;i++) w[i]=view.getUint32(offset+i*4);
      for(let i=16;i<64;i++) {
        const x=w[i-15],y=w[i-2];
        w[i]=(w[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;
      }
      let [a,b,c,d,e,f,g,j]=h;
      for(let i=0;i<64;i++) {
        const t1=(j+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+w[i])>>>0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
        j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      [a,b,c,d,e,f,g,j].forEach((value,i)=>h[i]=(h[i]+value)>>>0);
    }
    const result=new DataView(new ArrayBuffer(32)); h.forEach((value,i)=>result.setUint32(i*4,value)); return result.buffer;
  }}});
}
</script>`;
let html, version;
function refresh() {
  const next = fs.readFileSync(file, "utf8");
  if (!next.trimEnd().endsWith("</html>")) return;
  html = next;
  version = crypto.createHash("sha256").update(next).digest("hex");
}
refresh();
let pending;
fs.watchFile(file, { interval: 500 }, () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    try { refresh(); } catch (error) { console.error(error.message); }
  }, 750);
});

http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end(); return;
  }
  if (pathname === "/__preview_version") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ version })); return;
  }
  if (pathname !== "/" && pathname !== "/INASearch.html") {
    res.writeHead(404); res.end("Not found"); return;
  }
  const reload = `<script data-inasearch-preview>
    (() => {
      const version = ${JSON.stringify(version)};
      setInterval(async () => {
        try {
          const response = await fetch('/__preview_version', {cache: 'no-store'});
          if (response.ok && (await response.json()).version !== version) location.reload();
        } catch (_) { /* Retry when the MacBook is reachable again. */ }
      }, 2000);
    })();
  </script>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.method === "HEAD" ? undefined : html.replace("connect-src https://www.ecfr.gov", "connect-src 'self' https://www.ecfr.gov").replace(/<head>/i, `<head>${compatibility}`).replace(/<\/body>\s*<\/html>\s*$/, `${reload}</body></html>`));
}).listen(port, "0.0.0.0", () => console.log(`INASearch preview listening on port ${port}`));
