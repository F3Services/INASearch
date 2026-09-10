/* Shared source reconciliation and occurrence-aware CFR structure. No audit data is loaded at runtime. */
(function (root) {
  "use strict";
  const revision = 1;
  const cache = new WeakMap();
  const tokens = value => [...String(value || "").matchAll(/\(([^()]+)\)/g)].map(match => match[1]);
  const address = path => path.map(token => `(${token})`).join("");
  const contains = (parent, child) => child === parent || child.startsWith(parent + "(");
  const units = block => [...new Set([...(block.u || []).map(unit => unit.a), block.a].filter(Boolean))];
  function flatten(blocks, prefix = [], output = [], excluded = false) {
    (blocks || []).forEach((block, i) => {
      const blockPath = [...prefix, i];
      if (block.t === "note") flatten(block.blocks, blockPath, output, excluded || !["", "ordinary"].includes(block.noteType || ""));
      else output.push({ block, blockPath, excluded });
    });
    return output;
  }
  function index(record) {
    if (cache.has(record)) return cache.get(record);
    const rows = flatten(record.blocks), events = [], nodes = [], byPath = new Map(), stack = [];
    const close = at => { const node = stack.pop(); node.end = at; };
    for (const row of rows) {
      const block = row.block, text = String(block.x || ""), markers = block.u || [];
      const shared = markers.length > 1 && !contains(markers[0].a, markers[markers.length - 1].a) && /\[Reserved\]/i.test(text);
      let pieces = shared ? [{ a: markers[0].a, aliases: markers.slice(1).map(unit => unit.a), s: 0 }] : markers.map(unit => ({ a: unit.a, s: unit.s }));
      if (!pieces.length) pieces = [{ a: block.a || "", s: 0 }];
      if (pieces[0].s > 0) pieces.unshift({ a: "", s: 0 });
      pieces.forEach((piece, i) => {
        const at = events.length;
        if (row.excluded || block.k === "citation" || /^\[(?:\d+ FR |[A-Z][^\]]* FR )/.test(text)) while (stack.length) close(at);
        if (piece.a) {
          while (stack.length && (!contains(stack[stack.length - 1].path, piece.a) || stack[stack.length - 1].path === piece.a)) close(at);
          const parent = stack[stack.length - 1] || null;
          const node = { path: piece.a, aliases: piece.aliases || [], start: at, end: null, parent, row, occurrence: (byPath.get(piece.a) || []).length };
          nodes.push(node);
          for (const path of [node.path, ...node.aliases]) {
            if (!byPath.has(path)) byPath.set(path, []);
            byPath.get(path).push(node);
          }
          stack.push(node);
        } else if (block.c && byPath.has(block.c)) {
          while (stack.length && !contains(stack[stack.length - 1].path, block.c)) close(at);
        }
        events.push({ ...row, start: piece.s, end: pieces[i + 1]?.s ?? text.length, node: stack[stack.length - 1] || null });
      });
    }
    while (stack.length) close(events.length);
    const byCompact = new Map();
    for (const path of byPath.keys()) {
      const parts = tokens(path), key = parts.join("").toLowerCase();
      if (!byCompact.has(key)) byCompact.set(key, []);
      byCompact.get(key).push({ path: parts, inputParts: parts, unitTypes: parts.map((token, i) => /^[ivxlcdm]+$/.test(token) && i > 0 ? 3 : /^[IVXLCDM]+$/.test(token) ? 4 : 0) });
    }
    const result = { rows, events, nodes, byPath, byCompact, paths: [...byPath.keys()] };
    cache.set(record, result);
    return result;
  }
  function scope(record, path, locator = null) {
    const structure = index(record), candidates = structure.byPath.get(Array.isArray(path) ? address(path) : path) || [];
    const node = (locator && candidates.find(item => item.row.blockPath.join(".") === locator.join("."))) || candidates[0];
    if (!node) return [];
    const ranges = [];
    for (const event of structure.events.slice(node.start, node.end)) {
      if (event.excluded) continue;
      const previous = ranges[ranges.length - 1];
      if (previous?.block === event.block && previous.end === event.start) previous.end = event.end;
      else ranges.push({ block: event.block, blockPath: event.blockPath, start: event.start, end: event.end });
    }
    return ranges;
  }
  // Two independent 32-bit streams guard exact normalized source evidence. The
  // repository audit additionally records SHA-256 fingerprints of every input.
  function fingerprint(value) {
    const text = JSON.stringify(value); let a = 2166136261, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }
  function evidence(block) {
    return [block.t, block.x || "", block.a || "", block.c || "", block.u || [], block.r || [], block.rows || []];
  }
  function guardEvidence(block) {
    const value = evidence(block);
    // Named example wrappers are not paragraph ancestry. Browser HTML recovery
    // can close these malformed publisher wrappers differently from XML capture.
    if ((!block.a && /^\s*\([A-Za-z0-9-]+\)/.test(block.x || "")) || !/^(?:\((?:[A-Za-z]|[ivxlcdmIVXLCDM]+|\d+|[a-z]-\d+|[A-Za-z0-9]+\.)\))*$/.test(value[3])) value[3] = "";
    return value;
  }
  // Compiled guarded repair instructions; detailed findings live only in sources/legal.
  const repairs = {"8:214.1":[["admission-compound-headings","892c30070fe94def",25,"78e0cc75a268a1f1",[[0,[["(a)(3)",0,3],["(a)(3)(i)",26,29]]],[1,[["(a)(3)(ii)",0,4]]],[2,[["(a)(3)(iii)",0,5]]],[3,[["(b)",0,3],["(b)(1)",157,160]]],[4,[["(b)(1)(i)",0,3]]],[5,[["(b)(1)(ii)",0,4]]],[6,[["(b)(1)(iii)",0,5]]],[7,[["(b)(1)(iv)",0,4]]],[8,[["(b)(1)(iv)(A)",0,3]]],[9,[["(b)(1)(iv)(B)",0,3]]],[10,[["(b)(2)",0,3]]],[11,[["(b)(2)(i)",0,3]]],[12,[["(b)(2)(ii)",0,4]]],[13,[["(b)(2)(iii)",0,5]]],[14,[["(b)(2)(iv)",0,4]]],[15,[["(b)(3)",0,3]]],[16,[["(b)(3)(i)",0,3]]],[17,[["(b)(3)(ii)",0,4]]],[18,[["(b)(3)(iii)",0,5]]],[19,[["(b)(3)(iv)",0,4]]],[20,[["(b)(4)",0,3]]],[21,[["(b)(4)(i)",0,3]]],[22,[["(b)(4)(ii)",0,4]]],[23,[["(b)(4)(iii)",0,5]]],[24,[["(b)(4)(iv)",0,4]]]]]],"8:274a.2":[["verification-document-levels","75cb6bc942536be5",83,"d8f111dc1f158ce4",[[4,[["(b)(1)(v)(B)(1)(vi)",0,4]]],[5,[["(b)(1)(v)(B)(1)(v)",0,3]]],[6,[["(b)(1)(v)(B)(1)(vi)",0,4]]],[7,[["(b)(1)(v)(B)(1)(vii)",0,5]]],[8,[["(b)(1)(v)(B)(1)(viii)",0,6]]],[9,[["(b)(1)(v)(B)(1)(ix)",0,4]]],[10,[["(b)(1)(v)(B)(2)",0,3]]],[11,[["(b)(1)(v)(B)(2)(i)",0,3]]],[12,[["(b)(1)(v)(B)(2)(ii)",0,4]]],[13,[["(b)(1)(v)(B)(2)(iii)",0,5]]],[14,[["(b)(1)(v)(B)(3)",0,3]]],[15,[["(b)(1)(v)(B)(3)(i)",0,3]]],[16,[["(b)(1)(v)(B)(3)(ii)",0,4]]],[17,[["(b)(1)(v)(B)(3)(iii)",0,5]]],[18,[["(b)(1)(v)(B)(4)",0,3]]],[19,[["(b)(1)(v)(B)(4)(i)",0,3]]],[20,[["(b)(1)(v)(B)(4)(ii)",0,4]]],[21,[["(b)(1)(v)(B)(4)(iii)",0,5]]],[22,[["(b)(1)(v)(C)",0,3]]],[23,[["(b)(1)(v)(C)(1)",0,3]]],[24,[["(b)(1)(v)(C)(2)",0,3]]],[25,[["(b)(1)(v)(C)(3)",0,3]]],[26,[["(b)(1)(v)(C)(4)",0,3]]],[27,[["(b)(1)(v)(C)(5)",0,3]]],[28,[["(b)(1)(v)(C)(6)",0,3]]],[29,[["(b)(1)(v)(C)(7)",0,3]]],[30,[["(b)(1)(v)(D)",0,3]]],[31,[["(b)(1)(v)(D)(1)",0,3]]],[32,[["(b)(1)(v)(D)(1)(i)",0,3]]],[33,[["(b)(1)(v)(D)(1)(ii)",0,4]]],[34,[["(b)(1)(v)(D)(1)(iii)",0,5]]],[35,[["(b)(1)(v)(D)(2)",0,3]]],[36,[["(b)(1)(vi)",0,4]]],[37,[["(b)(1)(vi)(A)",0,3]]],[38,[["(b)(1)(vi)(A)(1)",0,3]]],[39,[["(b)(1)(vi)(A)(2)",0,3]]],[40,[["(b)(1)(vi)(A)(3)",0,3]]],[41,[["(b)(1)(vi)(B)",0,3]]],[42,[["(b)(1)(vi)(B)(1)",0,3]]],[43,[["(b)(1)(vi)(B)(2)",0,3]]],[44,[["(b)(1)(vi)(C)",0,3]]],[45,[["(b)(1)(vi)(C)(1)",0,3]]],[46,[["(b)(1)(vi)(C)(2)",0,3]]],[47,[["(b)(1)(vii)",0,5]]],[48,[["(b)(1)(viii)",0,6]]],[49,[["(b)(1)(viii)(A)",0,3]]],[50,[["(b)(1)(viii)(A)(1)",0,3]]],[51,[["(b)(1)(viii)(A)(2)",0,3]]],[52,[["(b)(1)(viii)(A)(3)",0,3]]],[53,[["(b)(1)(viii)(A)(4)",0,3]]],[54,[["(b)(1)(viii)(A)(5)",0,3]]],[55,[["(b)(1)(viii)(A)(6)",0,3]]],[56,[["(b)(1)(viii)(A)(7)",0,3]]],[57,[["(b)(1)(viii)(A)(7)(i)",0,3]]],[58,[["(b)(1)(viii)(A)(7)(ii)",0,4]]],[59,[["(b)(1)(viii)(A)(7)(iii)",0,5]]],[60,[["(b)(1)(viii)(A)(8)",0,3]]],[61,[["(b)(1)(viii)(B)",0,3]]],[62,[["(b)(1)(viii)(B)(1)",0,3]]],[63,[["(b)(1)(viii)(B)(2)",0,3]]],[64,[["(b)(1)(viii)(B)(3)",0,3]]],[65,[["(b)(1)(viii)(B)(4)",0,3]]],[66,[["(b)(1)(viii)(B)(5)",0,3]]],[67,[["(b)(1)(viii)(B)(6)",0,3]]],[68,[["(b)(1)(viii)(B)(7)",0,3]]],[69,[["(b)(1)(ix)",0,4]]],[70,[["(b)(1)(ix)(A)",0,3]]],[71,[["(b)(1)(ix)(B)",0,3]]],[72,[["(b)(1)(ix)(C)",0,3]]],[73,[["(b)(2)",0,3],["(b)(2)(i)",42,45]]],[74,[["(b)(2)(i)(A)",0,3]]],[75,[["(b)(2)(i)(B)",0,3]]],[76,[["(b)(2)(ii)",0,4]]],[77,[["(b)(2)(iii)",0,5]]],[78,[["(b)(2)(iii)(A)",0,3]]],[79,[["(b)(2)(iii)(B)",0,3]]],[80,[["(b)(2)(iv)",0,4]]],[81,[["(b)(3)",0,3]]]]]],"8:212.4":[["waiver-compound-heading","e28e364fd4042c2f",8,"78a5616d613ee541",[[0,[["(a)",0,3],["(a)(1)",44,47]]],[1,[["(a)(1)(i)",0,3]]],[2,[["(a)(1)(ii)",0,4]]],[3,[["(a)(1)(iii)",0,5]]],[4,[["(a)(1)(iv)",0,4]]],[5,[["(a)(1)(v)",0,3]]],[6,[["(a)(1)(vi)",0,4]]],[7,"(a)(1)"]]]],"8:1212.4":[["waiver-compound-heading","e28e364fd4042c2f",8,"78a5616d613ee541",[[0,[["(a)",0,3],["(a)(1)",44,47]]],[1,[["(a)(1)(i)",0,3]]],[2,[["(a)(1)(ii)",0,4]]],[3,[["(a)(1)(iii)",0,5]]],[4,[["(a)(1)(iv)",0,4]]],[5,[["(a)(1)(v)",0,3]]],[6,[["(a)(1)(vi)",0,4]]],[7,"(a)(1)"]]]],"8:287.5":[["arrest-compound-heading","910e180c9f24f0bc",5,"8ffed904693db8e4",[[0,[["(c)(4)",0,3],["(c)(4)(i)",77,80]]],[1,[["(c)(4)(i)(A)",0,3]]],[2,[["(c)(4)(i)(B)",0,3]]],[3,[["(c)(4)(i)(C)",0,3]]],[4,[["(c)(4)(i)(D)",0,3]]]]]],"8:292.3":[["discipline-lettered-children","cd115e81e01613b5",11,"54ffbe38f62c72b4",[[1,[["(h)(1)(i)(A)",0,3]]],[2,[["(h)(1)(i)(B)",0,3]]],[3,[["(h)(1)(i)(C)",0,3]]],[4,[["(h)(1)(i)(D)",0,3]]],[6,[["(h)(1)(ii)(A)",0,3]]],[7,[["(h)(1)(ii)(B)",0,3]]],[8,[["(h)(1)(ii)(C)",0,3]]],[9,[["(h)(1)(ii)(D)",0,3]]],[10,[["(h)(1)(ii)(E)",0,3]]]]]],"20:655.73":[["debarment-missing-opening-parenthesis","7eb9bad95a5b0625",4,"2bc9770d41e9dfad",[[0,[["(a)",0,2]]],[1,[["(a)(1)",0,3]]],[2,[["(a)(2)",0,3]]],[3,[["(a)(3)",0,3]]]]]],"20:416.1337":[["payment-category-list","2603c8ab6036895b",8,"6e8ec7990b51ff89",[[2,[["(b)(4)(i)",0,3]]],[3,"(b)(4)(i)"],[4,[["(b)(4)(ii)",0,4]]],[5,"(b)(4)(ii)"],[6,[["(b)(4)(iii)",0,5]]],[7,"(b)(4)(iii)"]]]],"20:416.994":[["disability-lettered-children","10c914facf0f3a66",46,"036cc331922c66e5",[[1,[["(b)(1)(iv)(A)",0,3]]],[2,[["(b)(1)(iv)(B)",0,3]]],[3,[["(b)(1)(iv)(C)",0,3]]],[12,[["(b)(2)(iv)(A)",0,3]]],[13,[["(b)(2)(iv)(B)",0,3]]],[14,[["(b)(2)(iv)(C)",0,3]]],[17,[["(b)(2)(iv)(D)",0,3]]],[18,[["(b)(2)(iv)(E)",0,3]]],[27,[["(b)(3)(iii)(A)",0,3]]],[28,[["(b)(3)(iii)(B)",0,3]]],[29,[["(b)(3)(iii)(B)(1)",0,3]]],[30,[["(b)(3)(iii)(B)(2)",0,3]]],[34,[["(b)(3)(iv)(A)",0,3]]],[39,[["(b)(3)(iv)(B)",0,3]]],[42,[["(b)(3)(iv)(C)",0,3]]],[45,[["(b)(3)(iv)(D)",0,3]]]]]],"19:4.98":[["navigation-fee-extra-designation","dc3a62978db4f843",1,"9f1917e1dc096485",[[0,[["(e-1)",0,5]]]]],["fee-schedule-local-list","92ecc9c4d3b98a6c",14,"14f5b9f113a23291",[]]],"19:4.94":[["cruising-license-form-list","8667e5b19fad127d",6,"a82d7291044e02a9",[]]],"8:245a.1":[["quoted-developmental-definition","a8c6589700bf231f",6,"d70bab63d2ad2c33",[]]],"22:89.1":[["country-local-lists","b86f64e1774d5e91",607,"af6960307f8fa1bc",[]]],"20:656.3":[["svp-term-context","74a34d1ca0acc6e0",1,"e17f1794dc152ec4",[[0,""]]]],"20:655.15":[["seafood-repeated-source-numbering","49ed3c0953ef9675",6,"ec7099fa39238a6e",[]]],"20:655.19":[["joint-employment-repeated-designations","4036e79b45bf568b",16,"02d61d7587f5ca5d",[]]]};
  function reconcile(record, report = null) {
    const rows = flatten(record.blocks), classified = new Set();
    for (const rule of repairs[record.id] || []) {
      const [name, first, count, guard, edits] = rule;
      const starts = rows.flatMap((row, i) => fingerprint(guardEvidence(row.block)) === first ? [i] : []);
      const start = starts.find(i => fingerprint(rows.slice(i, i + count).map(row => guardEvidence(row.block))) === guard);
      if (start === undefined) continue;
      for (let i = start; i < start + count; i++) classified.add(rows[i].block);
      for (const [offset, paths] of edits) {
        const row = rows[start + offset], block = row.block, before = evidence(block);
        const markers = Array.isArray(paths) ? paths.map(([path, s, e]) => ({ a: path, s, e })) : [];
        if (markers.length) { block.u = markers; block.a = markers[markers.length - 1].a; delete block.c; delete block.d; }
        else { delete block.a; delete block.u; delete block.c; if (paths) block.c = paths; }
        if (report) report({ record: record.id, blockPath: row.blockPath, rule: name, before, after: evidence(block), sourceFingerprint: fingerprint(before) });
      }
    }
    cache.delete(record);
    const structure = index(record);
    for (const node of structure.nodes) {
      const parent = address(tokens(node.path).slice(0, -1));
      if (parent && node.parent?.path !== parent && !node.parent?.aliases.includes(parent)) throw new Error(`${record.id}: paragraph ${node.path} resumes outside its parent occurrence`);
    }
    for (const [path, occurrences] of structure.byPath) {
      if (occurrences.length > 1 && record.section && !occurrences.every(node => classified.has(node.row.block))) throw new Error(`${record.id}: unreviewed repeated designation ${path}`);
    }
    for (const row of rows) {
      const block = row.block;
      const italic = block.r?.[0]?.x === "(" && block.r?.[1]?.s === "i" ? block.r[1].x : "";
      const styledDepth = /^\d+$/.test(italic) ? 5 : /^[ivxlcdm]+$/.test(italic) ? 6 : 0;
      if (styledDepth && block.u?.[0]?.s === 0 && tokens(block.u[0].a).length !== styledDepth) throw new Error(`${record.id}: XML italic marker contradicts the paragraph depth at ${row.blockPath.join(".")}`);
      for (const path of units(block)) {
        if (address(tokens(path)) !== path) throw new Error(`${record.id}: malformed paragraph address ${path}`);
        const parent = tokens(path).slice(0, -1);
        if (parent.length && !structure.byPath.has(address(parent))) throw new Error(`${record.id}: missing parent ${address(parent)}`);
      }
      if (block.c && address(tokens(block.c)) !== block.c) throw new Error(`${record.id}: malformed paragraph context ${block.c}`);
      if (!block.a && /^\s*\([A-Za-z0-9-]+\)/.test(block.x || "") && !row.excluded && !block.q && !classified.has(block)) throw new Error(`${record.id}: unclassified visible paragraph marker at ${row.blockPath.join(".")}`);
      delete block.q;
    }
    return record;
  }
  function rebindAnchor(record, anchor) {
    const exact = String(anchor?.exact || "");
    if (!exact) return null;
    const matches = [];
    for (const row of index(record).rows) {
      const text = row.block.x || "";
      for (let start = text.indexOf(exact); start >= 0; start = text.indexOf(exact, start + 1)) {
        const event = index(record).events.find(item => item.block === row.block && item.start <= start && item.end >= start + exact.length);
        matches.push({ row, start, path: event?.node ? tokens(event.node.path) : [], context: (!anchor.prefix || text.slice(0, start).endsWith(anchor.prefix)) && (!anchor.suffix || text.slice(start + exact.length).startsWith(anchor.suffix)) });
      }
    }
    const contextual = matches.filter(match => match.context);
    return contextual.length === 1 ? contextual[0] : matches.length === 1 ? matches[0] : null;
  }
  const api = { revision, tokens, address, units, flatten, index, scope, fingerprint, evidence, guardEvidence, reconcile, rebindAnchor, hasRepairs: id => (repairs[id] || []).some(rule => rule[4].length > 0) };
  root.INASearchCfrHierarchy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
