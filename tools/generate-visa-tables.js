#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [, , part41Path, part42Path] = process.argv;
const reuseExistingRows = part41Path === "--existing";
if ((!part41Path || !part42Path) && !reuseExistingRows) {
  throw new Error("Usage: node tools/generate-visa-tables.js <official-part-41.xml> <official-part-42.xml>\n       node tools/generate-visa-tables.js --existing");
}

const root = path.resolve(__dirname, "..");
const outputPath = path.join(root, "src", "INASearch-Visa-Tables.js");

function decodeXml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionXml(filePath, section) {
  const xml = fs.readFileSync(filePath, "utf8");
  const start = xml.indexOf(`<DIV8 N="${section}"`);
  const end = xml.indexOf("</DIV8>", start);
  if (start < 0 || end < 0) throw new Error(`${filePath} does not contain 22 CFR ${section}.`);
  return xml.slice(start, end + 7);
}

function rootForSymbol(symbol) {
  const match = String(symbol).match(/^[A-Z]+(?=\d)/);
  return match ? match[0] : String(symbol);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseTable(filePath, section, kind) {
  const sectionSource = sectionXml(filePath, section);
  let category = kind === "immigrant" ? "Other Categories" : "Nonimmigrant Classifications";
  let subcategory = "";
  const records = [];
  for (const rowMatch of sectionSource.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const row = rowMatch[1];
    const cells = [...row.matchAll(/<TD([^>]*)>([\s\S]*?)<\/TD>/g)].map(match => ({ attributes: match[1], html: match[2], text: decodeXml(match[2]) }));
    if (cells.length === 1 && /colspan="3"/.test(cells[0].attributes)) {
      if (/<strong[^>]*minor-caps/.test(cells[0].html)) {
        category = cells[0].text;
        subcategory = "";
      } else {
        subcategory = cells[0].text;
      }
      continue;
    }
    if (cells.length !== 3 || cells[0].text === "Symbol") continue;
    const [symbolCell, classCell, lawCell] = cells;
    const symbol = symbolCell.text;
    records.push({
      id: `${kind}-${slug(symbol)}`,
      kind,
      root: rootForSymbol(symbol),
      symbol,
      className: classCell.text,
      sectionOfLaw: lawCell.text.replace(/\.$/, ""),
      category,
      subcategory,
      tableSection: `22 CFR ${section}`,
      tableUrl: `https://www.ecfr.gov/current/title-22/chapter-I/subchapter-E/part-${section.split(".")[0]}/subpart-B/section-${section}`
    });
  }
  if (!records.length) throw new Error(`No classification rows were parsed from 22 CFR ${section}.`);
  return records;
}

function groupId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sourceInstrumentCombination(sectionOfLaw) {
  const value = String(sectionOfLaw || "");
  const instruments = [];
  if (/\bINA\b/i.test(value)) instruments.push("Immigration and Nationality Act (INA)");
  if (/Virgin Islands Nonimmigrant Alien Adjustment Act/i.test(value)) instruments.push("Virgin Islands Nonimmigrant Alien Adjustment Act");
  if (/Foreign Operations, Export Financing, and Related Programs Appropriations Act, 1988/i.test(value)) instruments.push("Foreign Operations, Export Financing, and Related Programs Appropriations Act, 1988");
  if (/Public Law 109-163/i.test(value)) instruments.push("Public Law 109-163");
  if (/Omnibus Appropriations Act of 2009/i.test(value)) instruments.push("Omnibus Appropriations Act of 2009 (Pub. L. 111-8)");
  if (/Public Law 110-181/i.test(value)) instruments.push("Public Law 110-181");
  if (/Public Law 107-56/i.test(value)) instruments.push("Public Law 107-56");
  if (/Departments of Commerce, Justice, and State, the Judiciary and Related Agencies Appropriations Act, 1993/i.test(value)) instruments.push("Departments of Commerce, Justice, and State, the Judiciary and Related Agencies Appropriations Act, 1993");
  if (/Consolidated Appropriations Act, 2022/i.test(value)) instruments.push("Consolidated Appropriations Act, 2022");
  if (!instruments.length) throw new Error(`Unrecognized immigrant authority combination: ${value}`);
  return instruments.join(" + ");
}

function compactNumberRanges(values) {
  const numbers = [...new Set(values.map(Number))].sort((a, b) => a - b);
  const ranges = [];
  for (let index = 0; index < numbers.length;) {
    const start = numbers[index];
    let end = start;
    while (index + 1 < numbers.length && numbers[index + 1] === end + 1) end = numbers[++index];
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return ranges.join(", ");
}

function compactScopeLabel(members, allRecords) {
  const membersByRoot = new Map();
  for (const record of members) {
    if (!membersByRoot.has(record.root)) membersByRoot.set(record.root, []);
    membersByRoot.get(record.root).push(record);
  }
  const allByRoot = new Map();
  for (const record of allRecords) {
    if (!allByRoot.has(record.root)) allByRoot.set(record.root, []);
    allByRoot.get(record.root).push(record);
  }
  return [...membersByRoot].map(([root, selected]) => {
    const all = allByRoot.get(root) || [];
    if (selected.length === all.length) return root;
    const suffixes = selected.map(record => record.symbol.slice(root.length));
    return suffixes.every(suffix => /^\d+$/.test(suffix))
      ? `${root}(${compactNumberRanges(suffixes)})`
      : `${root}(${suffixes.join(", ")})`;
  }).join(", ");
}

function buildImmigrantDefinitionGroups(records) {
  const grouped = new Map();
  for (const record of records) {
    const authority = sourceInstrumentCombination(record.sectionOfLaw);
    if (!grouped.has(authority)) grouped.set(authority, []);
    grouped.get(authority).push(record);
  }
  const groups = [];
  for (const [authority, members] of grouped) {
    groups.push({
      id: `immigrant-definition-combination-${groupId(authority)}`,
      revision: "2026-08-02-2",
      authority,
      symbols: members.map(record => record.symbol),
      scopeLabel: compactScopeLabel(members, records),
      basis: "shared source-instrument combination",
      sourceUrl: members[0].tableUrl
    });
  }
  return groups;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function existingTableRows() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(outputPath, "utf8"), sandbox, { filename: outputPath });
  return sandbox.window.INA_SEARCH_VISA_TABLES;
}

const existing = reuseExistingRows ? existingTableRows() : null;
const nonimmigrantTypes = reuseExistingRows ? existing.nonimmigrantTypes : parseTable(part41Path, "41.12", "nonimmigrant");
const immigrantTypes = reuseExistingRows ? existing.immigrantTypes : parseTable(part42Path, "42.11", "immigrant");
const immigrantDefinitionGroups = buildImmigrantDefinitionGroups(immigrantTypes);
const output = `/* Generated from the official eCFR Title 22 XML snapshot dated 2026-07-30.\n * Regenerate with tools/generate-visa-tables.js; do not hand-edit table rows. */\nwindow.INA_SEARCH_VISA_TABLES = ${safeJson({
  schemaVersion: 1,
  capturedAt: "2026-07-30",
  sources: {
    nonimmigrant: nonimmigrantTypes[0].tableUrl,
    immigrant: immigrantTypes[0].tableUrl
  },
  nonimmigrantTypes,
  immigrantTypes,
  immigrantDefinitionGroups
})};\n`;

fs.writeFileSync(outputPath, output);
console.log(`${path.relative(root, outputPath)}\t${nonimmigrantTypes.length} nonimmigrant rows\t${immigrantTypes.length} immigrant rows\t${immigrantDefinitionGroups.length} definition groups`);
