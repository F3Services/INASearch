"use strict";

const { minify } = require("terser");

// Script bodies are parsed as JavaScript, including the inert Blob worker.
// Never run HTML/comment whitespace substitutions across JavaScript strings.
function compactMarkup(markup) {
  return markup
    .replace(/<style>([\s\S]*?)<\/style>/g, (_, css) => `<style>${css.replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1")}</style>`)
    .replace(/<!--(?! INA_SEARCH_)[\s\S]*?-->/g, "")
    .replace(/^[\t ]+/gm, "")
    .replace(/\n{2,}/g, "\n");
}

async function compactShell(template, { debug = false } = {}) {
  let output = "", cursor = 0;
  for (const match of template.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi)) {
    output += compactMarkup(template.slice(cursor, match.index));
    let source = match[2];
    if (!debug && !/type="application\//i.test(match[1]) && source.trim()) {
      const result = await minify(source, {
        ecma: 2022,
        compress: { passes: 2, global_defs: { INASEARCH_BROWSER: true } },
        mangle: true,
        format: { comments: false, inline_script: true }
      });
      source = result.code;
    }
    output += match[1] + source + match[3];
    cursor = match.index + match[0].length;
  }
  return output + compactMarkup(template.slice(cursor));
}

module.exports = { compactShell };
