"use strict";

// Render the Markdown forms used by FAQ.md at build time; no renderer ships in the app.
const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function faqLink(value) {
  if (/^https:\/\//i.test(value)) return value;
  if (/^[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_-]+)?$/.test(value) && !value.split("/").includes("..")) {
    return `https://github.com/F3Services/INASearch/blob/main/${value}`;
  }
  throw new Error(`Unsupported FAQ link: ${value}`);
}

function inlineMarkdown(value) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*/g;
  let html = "", cursor = 0;
  for (const match of value.matchAll(pattern)) {
    html += escapeHtml(value.slice(cursor, match.index));
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) html += `<a href="${escapeHtml(faqLink(match[3]))}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(match[2])}</a>`;
    else html += `<strong>${inlineMarkdown(match[4])}</strong>`;
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(cursor));
}

function answerMarkup(lines) {
  let html = "", paragraph = [], list = [], listType = "", code = null;
  const flush = () => {
    if (paragraph.length) html += `<p>${inlineMarkdown(paragraph.join(" "))}</p>`;
    if (list.length) html += `<${listType}>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`;
    paragraph = []; list = []; listType = "";
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (code) { html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`; code = null; }
      else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (item) {
      const type = item[1] ? "ul" : "ol";
      if (paragraph.length || listType && listType !== type) flush();
      listType = type; list.push(item[2]);
    } else if (list.length) list[list.length - 1] += ` ${line.trim()}`;
    else paragraph.push(line.trim());
  }
  if (code) throw new Error("Unclosed FAQ code fence.");
  flush();
  return html;
}

function buildFaqMarkup(markdown) {
  const groups = [];
  let group = null, question = null, fenced = false;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      group = { title: line.slice(3), questions: [] }; groups.push(group); question = null;
    } else if (!fenced && /^### /.test(line)) {
      if (!group) throw new Error("FAQ question has no category.");
      question = { title: line.slice(4), lines: [] }; group.questions.push(question);
    } else if (question) question.lines.push(line);
  }
  if (fenced) throw new Error("Unclosed FAQ code fence.");
  if (!groups.length || groups.some(item => !item.questions.length)) throw new Error("FAQ categories must contain questions.");
  return groups.map(item => `<section class="about-faq-group"><h3>${inlineMarkdown(item.title)}</h3>${item.questions.map(entry => `<details class="about-faq"><summary>${inlineMarkdown(entry.title)}</summary><div class="about-faq-answer">${answerMarkup(entry.lines)}</div></details>`).join("")}</section>`).join("");
}

module.exports = { buildFaqMarkup };
