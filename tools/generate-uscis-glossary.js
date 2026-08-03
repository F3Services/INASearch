#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outputPath = path.join(root, "src", "AuthoritySearch-USCIS-Glossary.js");
const sourceUrl = "https://www.uscis.gov/tools/glossary";

function decodeHtml(value) {
  const named = {
    amp: "&", apos: "'", gt: ">", ldquo: "“", lsquo: "‘", lt: "<", mdash: "—",
    nbsp: " ", ndash: "–", quot: '"', rdquo: "”", rsquo: "’", trade: "™"
  };
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => Object.hasOwn(named, name.toLowerCase()) ? named[name.toLowerCase()] : match);
}

function htmlToText(value) {
  return decodeHtml(String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(?:p|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ +([,.;:!?)\]])/g, "$1")
    .replace(/([(\[]) +/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function aliasesForTerm(term) {
  const aliases = [term];
  const match = term.match(/^(.+?)\s*\(([^()]*)\)\s*$/);
  if (match) {
    const base = match[1].trim();
    const parenthetical = match[2].trim();
    if (base) aliases.push(base);
    if (/^[A-Z][A-Z0-9#-]{1,12}$/.test(parenthetical)) aliases.push(parenthetical);
  }
  return [...new Set(aliases)];
}

function fetchSource(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "AuthoritySearch glossary generator" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        resolve(fetchSource(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`USCIS glossary request returned HTTP ${response.statusCode}.`));
        return;
      }
      let html = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { html += chunk; });
      response.on("end", () => resolve({ html, headers: response.headers }));
    }).on("error", reject);
  });
}

function parseGlossary(html) {
  const pattern = /<div class="accordion__header row-data"[^>]*>([\s\S]*?)<\/div>\s*<div class="accordion__panel">([\s\S]*?)<\/div>/g;
  const entries = [...html.matchAll(pattern)].map(match => {
    const term = htmlToText(match[1]);
    return { term, aliases: aliasesForTerm(term), text: htmlToText(match[2]) };
  });
  if (!entries.length) throw new Error("No glossary entries were found in the USCIS page.");
  if (entries.some(entry => !entry.term || !entry.text)) throw new Error("USCIS glossary contains an empty parsed term or definition.");
  const normalizedTerms = entries.map(entry => entry.term.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  if (new Set(normalizedTerms).size !== entries.length) throw new Error("USCIS glossary contains duplicate normalized terms.");
  return entries;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function main() {
  const { html, headers } = await fetchSource(sourceUrl);
  const entries = parseGlossary(html);
  const capturedAt = new Date().toISOString().slice(0, 10);
  const output = {
    schemaVersion: 1,
    capturedAt,
    source: {
      name: "USCIS Glossary",
      publisher: "U.S. Citizenship and Immigration Services",
      locator: "USCIS Tools — Glossary",
      url: sourceUrl,
      capturedAt,
      lastModified: headers["last-modified"] || null
    },
    verification: {
      entries: entries.length,
      sourceSha256: crypto.createHash("sha256").update(html).digest("hex")
    },
    entries
  };
  const source = `/* Generated from ${sourceUrl}. Run tools/generate-uscis-glossary.js to refresh. */\nwindow.AUTHORITY_SEARCH_USCIS_GLOSSARY = ${safeJson(output)};\n`;
  fs.writeFileSync(outputPath, source);
  console.log(`${path.relative(root, outputPath)}\t${entries.length} glossary entries\t${output.verification.sourceSha256}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
