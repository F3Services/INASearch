/* Publisher presentation ranges. Text and citation offsets remain unchanged. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.INA_SEARCH_USLM = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const units = new Set(["title", "subtitle", "chapter", "subchapter", "part", "subpart", "section", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem", "level"]);
  const tables = new Set(["table", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td"]);
  const blocks = new Set([...units, "p", "chapeau", "continuation", "quotedContent", "signature"]);
  const inlineTags = new Set(["i", "b", "inline", "span", "name", "sup", "sub", "ref", "date"]);
  const escape = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const em = value => `${Math.round(value * 14) / 10}em`;
  function attributes(block, options = {}) {
    const p = block.presentation || {}, style = {};
    if (p.italic || block.tag === "i") style["font-style"] = "italic";
    if (p.bold || block.tag === "b") style["font-weight"] = "bold";
    if (p.smallCaps) style["font-variant"] = "small-caps";
    if (p.centered) { style["text-align"] = "center"; style.display = "block"; }
    if (p.fontSize === 8) style["font-size"] = "8pt";
    if (p.inline) style.display = "inline";
    const indent = p.indent ?? block.indent;
    if (Number.isFinite(indent)) style["margin-left"] = em(indent - (options.parentIndent || 0));
    if (Number.isFinite(p.firstIndent)) style["text-indent"] = em(p.firstIndent);
    const lengths = /^(?:-?\d+(?:\.\d+)?(?:em|rem|pt|px|%)?|auto)$/;
    const lengthProperties = new Set(["width", "height", "min-width", "max-width", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding-left", "padding-right", "padding-top", "padding-bottom", "text-indent", "font-size", "line-height", "border-spacing"]);
    const enums = { border: /^0$/, "text-align": /^(left|right|center|justify|start|end)$/, "vertical-align": /^(top|middle|bottom|baseline)$/, "font-style": /^(normal|italic)$/, "font-weight": /^(normal|bold|[1-9]00)$/, "font-variant": /^(normal|small-caps)$/, "border-collapse": /^(collapse|separate)$/, "display": /^(none|inline|block|table-cell)$/ };
    for (const [key, value] of Object.entries(block.style || {})) {
      if (lengthProperties.has(key) ? lengths.test(String(value)) : enums[key]?.test(String(value))) style[key] = value;
    }
    if (block.width && lengths.test(String(block.width))) style.width = block.width;
    if (options.typographyOnly) {
      for (const key of Object.keys(style)) if (!["font-style", "font-weight", "font-variant", "font-size"].includes(key)) delete style[key];
    }
    const css = Object.entries(style).map(([key, value]) => `${key}:${value}`).join(";");
    const spans = ["colspan", "rowspan", "span"].filter(key => Number.isInteger(block[key]) && block[key] > 0 && block[key] <= 100).map(key => ` ${key}="${block[key]}"`).join("");
    return `${css ? ` style="${escape(css)}"` : ""}${spans}`;
  }
  function format(layout, start, end, renderText, options = {}) {
    if (!layout?.length) return renderText(start, end);
    const plain = options.plainText, mode = options.mode || "note";
    function range(from, to, records, parentIndent = 0, depth = 0) {
      let cursor = from, output = "";
      for (const block of records || []) {
        if (options.structuralOnly && inlineTags.has(block.tag)) continue;
        if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.end < from || block.start > to || block.end < block.start) continue;
        if (block.start === block.end ? block.start < from || block.start > to : block.end <= from || block.start >= to) continue;
        const first = Math.max(from, block.start), last = Math.min(to, block.end);
        if (first < cursor) continue;
        if (first > cursor) output += renderText(cursor, first);
        const indent = block.presentation?.indent ?? block.indent ?? parentIndent;
        let content = range(first, last, block.children, indent, depth + 1);
        if (plain) {
          if (["td", "th"].includes(block.tag)) content = `${content.trim()}\t`;
          else if (blocks.has(block.tag) || block.tag === "tr") content = `${content.trim()}\n\n`;
          else if (["num", "heading"].includes(block.tag)) content = `${content.trim()} `;
          output += content;
        } else if (mode === "inline" && !["i", "b", "inline", "span", "name", "sup", "sub"].includes(block.tag)) {
          // Block boundaries are handled by the outer renderer; inline styles
          // can still intersect a citation or search-highlight range.
          const typography = attributes(block, { typographyOnly: true });
          output += typography ? `<span${typography}>${content}</span>` : content;
        } else {
          const tag = tables.has(block.tag) ? block.tag : ["i", "b", "sup", "sub"].includes(block.tag) ? block.tag
            : mode === "field" || ["num", "heading", "content", "chapeau", "inline", "span", "name"].includes(block.tag) ? "span" : "div";
          const cls = units.has(block.tag) ? "note-unit" : ({ p: "note-paragraph", quotedContent: "note-quote" })[block.tag] || `note-${block.tag}`;
          const fieldBlock = mode === "field" && depth === 0 && cursor > from && blocks.has(block.tag) ? " uslm-field-block" : "";
          const leaders = block.presentation?.leaders ? " uslm-leaders" : "";
          // The reader positions the opening text after its citation/heading.
          // Publisher hanging margins require a block, not this inline span.
          const inlineField = mode === "field" && depth === 0 && !fieldBlock && ["chapeau", "content"].includes(block.tag);
          const attrs = attributes(mode === "field" && block.tag === "continuation" ? { ...block, style: { ...block.style, display: "block" } } : block, { parentIndent, typographyOnly: inlineField });
          const html = `<${tag} class="${escape(cls)}${fieldBlock}${leaders}" data-uslm-tag="${escape(block.tag)}"${attrs}>${tag === "col" ? "" : `${content}</${tag}>`}`;
          output += block.tag === "table" ? `<div class="note-table-wrap">${html}</div>` : html;
        }
        cursor = last;
      }
      return output + (to > cursor ? renderText(cursor, to) : "");
    }
    // Structural fields begin at the publisher's first line, including the
    // hanging offset; their reader container does not apply that offset itself.
    const parentIndent = (options.parentIndent || 0) + (mode === "field" ? options.parentFirstIndent || 0 : 0);
    const result = range(start, end, layout, parentIndent);
    return plain ? result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : result;
  }
  function fieldParts(layout, start, end, text = null) {
    const cuts = (layout || []).filter(block => ["content", "chapeau", "continuation", "p"].includes(block.tag) && block.start > start && block.start < end && (text === null || text.slice(start, block.start).trim())).map(block => block.start);
    const boundaries = [...new Set([start, ...cuts, end])].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((value, index) => ({ start: value, end: boundaries[index + 1] }));
  }
  return Object.freeze({ attributes, format, fieldParts });
});
