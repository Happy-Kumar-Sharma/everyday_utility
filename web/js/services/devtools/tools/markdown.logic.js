// Markdown → tree renderer for the Markdown preview tool. Pure logic, no DOM.
//
// parseMarkdown(text) returns block nodes: { tag, attrs?, children? } where children are nodes or plain strings.
// Tags and attribute names come only from this file (never from the input), every string is plain text, and
// raw HTML in the input stays literal text. Link targets are limited to http(s), mailto, relative paths and
// #anchors; images to http(s) and data:image/*. Anything else is rendered as the literal source text.
// toHtml(nodes) turns the same tree into an escaped HTML string; markdown.js builds the live DOM with h().

/* ------------------------------------------------------------------ helpers */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const VOID = new Set(['br', 'hr', 'img', 'input']);
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead',
  'tbody', 'tr', 'hr']);
const ASCII_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isWS = (c) => c === undefined || /\s/u.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/** Code-fence languages the app's highlighter knows (web/js/core/highlight.js types). */
export const HIGHLIGHT_LANGS = {
  sql: 'sql', psql: 'sql', postgres: 'sql', postgresql: 'sql',
  js: 'mongo', javascript: 'mongo', mongo: 'mongo', mongodb: 'mongo', ts: 'mongo', typescript: 'mongo',
  sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', python: 'python', py: 'python',
};

/* ------------------------------------------------------------------ URL safety */
// strip what browsers ignore/strip in URLs before deciding the scheme, so "java\tscript:" is caught too
const schemeOf = (url) => {
  const m = url.replace(/[\u0000- \u007f-\u009f]/g, '').match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
};

/** href if it's an allowed link target, else null. */
export function safeHref(url) {
  const s = String(url ?? '').trim();
  const scheme = schemeOf(s);
  if (scheme === null) return s;  // relative path, ?query or #anchor
  return ['http', 'https', 'mailto'].includes(scheme) ? s : null;
}

/** src if it's an allowed image source (http/https or a data:image of a raster/svg type), else null. */
export function safeImageSrc(url) {
  const s = String(url ?? '').trim();
  const scheme = schemeOf(s);
  if (scheme === 'http' || scheme === 'https') return s;
  if (scheme === 'data' && /^data:image\/(png|gif|jpe?g|webp|avif|bmp|svg\+xml)[;,]/i.test(s)) return s;
  return null;
}

/* ------------------------------------------------------------------ tree utilities */
export function plainText(nodes) {
  let out = '';
  const walk = (n) => {
    if (typeof n === 'string') { out += n; return; }
    if (n.tag === 'img') out += n.attrs?.alt || '';
    if (n.tag === 'br') out += '\n';
    (n.children || []).forEach(walk);
    if (BLOCK.has(n.tag)) out += '\n';
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(walk);
  return out;
}

/** Escaped HTML string for the tree (what "Copy HTML" / download .html use). */
export function toHtml(nodes) {
  const attrs = (a) => Object.entries(a || {}).map(([k, v]) => {
    if (v === false || v === null || v === undefined) return '';
    return v === true ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`;
  }).join('');
  const walk = (n) => {
    if (typeof n === 'string') return escapeHtml(n);
    const open = `<${n.tag}${attrs(n.attrs)}>`;
    if (VOID.has(n.tag)) return open + (BLOCK.has(n.tag) ? '\n' : '');
    const inner = (n.children || []).map(walk).join('');
    const nl = BLOCK.has(n.tag) ? '\n' : '';
    const lead = ['ul', 'ol', 'blockquote', 'table', 'thead', 'tbody', 'tr'].includes(n.tag) ? '\n' : '';
    return `${open}${lead}${inner}</${n.tag}>${nl}`;
  };
  return (Array.isArray(nodes) ? nodes : [nodes]).map(walk).join('');
}

/** Headings in document order: [{level, text, id}]. */
export function headings(nodes) {
  const out = [];
  const walk = (n) => {
    if (typeof n === 'string') return;
    const m = /^h([1-6])$/.exec(n.tag);
    if (m) out.push({ level: Number(m[1]), text: plainText(n.children).trim(), id: n.attrs?.id });
    (n.children || []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Word / character counts of the rendered text (not the markup). */
export function stats(markdown, nodes = parseMarkdown(markdown)) {
  const text = plainText(nodes);
  let words = 0;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (s.isWordLike) words += 1;
  } else words = (text.match(/\S+/g) || []).length;
  const chars = [...text.replace(/\n+$/, '')].length;
  return { words, chars, sourceChars: [...markdown].length, lines: markdown ? markdown.split('\n').length : 0,
    readingMinutes: Math.max(words ? 1 : 0, Math.round(words / 230)) };
}

export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
}

/* ------------------------------------------------------------------ inline parsing */
const normLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function backtickRun(s, i) { let j = i; while (s[j] === '`') j += 1; return j - i; }

/* Per-string lookup tables, built lazily in O(n), so that "[[[[…", "[a](" × 20 000 or "` `` ``` …" stay linear
   instead of rescanning the rest of the text from every candidate position. */
const isBreak = (code) => code <= 32 || code === 127;

const scanners = new Map();  // small cache: link text is parsed recursively, then the outer string continues

function scanner(s) {
  const hit = scanners.get(s);
  if (hit) return hit;
  const n = s.length;
  const esc = new Uint8Array(n + 1);  // 1 = escaped by a backslash
  for (let j = 0; j < n; j += 1) if (s[j] === '\\' && !esc[j]) esc[j + 1] = 1;
  const sc = { s, esc, next: {}, runs: new Map() };
  /** first index >= j holding unescaped `ch` (or n) */
  sc.nextOf = (ch, j) => {
    if (!sc.next[ch]) {
      const arr = new Int32Array(n + 1).fill(n);
      for (let k = n - 1; k >= 0; k -= 1) arr[k] = s[k] === ch && !esc[k] ? k : arr[k + 1];
      sc.next[ch] = arr;
    }
    return sc.next[ch][Math.min(j, n)];
  };
  /** first index >= j that is whitespace / a control character (or n) */
  sc.nextBreak = (j) => {
    if (!sc.breaks) {
      sc.breaks = new Int32Array(n + 1).fill(n);
      for (let k = n - 1; k >= 0; k -= 1) sc.breaks[k] = isBreak(s.charCodeAt(k)) ? k : sc.breaks[k + 1];
    }
    return sc.breaks[Math.min(j, n)];
  };
  /** matching unescaped ")" for every unescaped "(" */
  sc.paren = (j) => {
    if (!sc.parens) {
      sc.parens = new Int32Array(n).fill(-1);
      const st = [];
      for (let k = 0; k < n; k += 1) {
        if (esc[k]) continue;
        if (s[k] === '(') st.push(k);
        else if (s[k] === ')' && st.length) sc.parens[st.pop()] = k;
      }
    }
    return sc.parens[j];
  };
  /** matching "]" for every "[" (code spans bind tighter, so brackets inside them don't count) */
  sc.bracket = (j) => {
    if (!sc.brackets) {
      sc.brackets = new Int32Array(n).fill(-1);
      const st = [];
      for (let k = 0; k < n; k += 1) {
        if (esc[k]) continue;
        const c = s[k];
        if (c === '`') { const e = codeSpanEnd(s, k); k = (e > 0 ? e : k + backtickRun(s, k)) - 1; continue; }
        if (c === '[') st.push(k);
        else if (c === ']' && st.length) sc.brackets[st.pop()] = k;
      }
    }
    return sc.brackets[j];
  };
  if (scanners.size >= 16) scanners.delete(scanners.keys().next().value);
  scanners.set(s, sc);
  return sc;
}

/** End index (exclusive) of a code span starting at i, or -1. */
function codeSpanEnd(s, i) {
  const n = backtickRun(s, i);
  const sc = scanner(s);
  if (sc.runs.has(n) && sc.runs.get(n) <= i) return -1;  // already known: no closing run of this length after here
  let j = i + n;
  while (j < s.length) {
    j = s.indexOf('`', j);
    if (j < 0) break;
    const m = backtickRun(s, j);
    if (m === n) return j + m;
    j += m;
  }
  sc.runs.set(n, i);
  return -1;
}

const unescape = (s) => s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
const skipWs = (s, j) => { while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j += 1; return j; };

/** Parses "(dest "title")" at s[i] === '('. Returns {href, title, end} or null. */
function linkTail(s, i) {
  const sc = scanner(s);
  let j = skipWs(s, i + 1);
  let dest;
  if (s[j] === '<') {
    const e = sc.nextOf('>', j + 1);
    const nl = s.indexOf('\n', j);
    if (e >= s.length || (nl >= 0 && nl < e)) return null;
    dest = s.slice(j + 1, e); j = e + 1;
  } else {
    // the destination ends at whitespace or at the ")" that balances the "(" before it
    const close = sc.paren(i);
    const end = Math.min(sc.nextBreak(j), close < 0 ? s.length : close);
    dest = s.slice(j, end); j = end;
  }
  let title = null;
  const ws = j;
  j = skipWs(s, j);
  if (j > ws && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const k = sc.nextOf(s[j] === '(' ? ')' : s[j], j + 1);
    if (k >= s.length) return null;
    title = unescape(s.slice(j + 1, k));
    j = skipWs(s, k + 1);
  }
  if (s[j] !== ')') return null;
  return { href: unescape(dest), title, end: j + 1 };
}

const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/;
const EMAIL_AUTOLINK = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]*/i;

function trimBareUrl(url) {
  // drop trailing punctuation and unbalanced closing parens, like GFM
  let u = url.replace(/[?!.,:*_~'";]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1).replace(/[?!.,:*_~'";]+$/, '');
  return u;
}

function linkNode(href, title, children) {
  const external = /^(https?:|mailto:|\/\/)/i.test(href);
  return { tag: 'a', attrs: { href, title: title || undefined, rel: external ? 'noopener noreferrer' : undefined }, children };
}

const MAX_INLINE_DEPTH = 8;   // images inside link text inside …: deeper nesting stays literal text
const MAX_BLOCK_DEPTH = 64;   // block quotes / lists nested deeper than this are read as plain paragraphs

export function parseInline(src, ctx = { refs: {} }) {
  const tokens = [];  // strings, nodes, and {delim} objects
  let buf = '';
  const flush = () => { if (buf) { tokens.push(buf); buf = ''; } };
  const push = (node) => { flush(); tokens.push(node); };
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { buf = buf.replace(/[ \t]+$/, ''); push({ tag: 'br' }); i += 2; while (s[i] === ' ' || s[i] === '\t') i += 1; continue; }
      if (s[i + 1] !== undefined && ASCII_PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      buf += c; i += 1; continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(s, i);
      const n = backtickRun(s, i);
      if (end < 0) { buf += s.slice(i, i + n); i += n; continue; }
      let code = s.slice(i + n, end - n).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      push({ tag: 'code', children: [code] });
      i = end; continue;
    }
    if (c === '<') {
      const rest = s.slice(i, i + 2048);
      let m;
      if ((m = EMAIL_AUTOLINK.exec(rest))) { push(linkNode(`mailto:${m[1]}`, null, [m[1]])); i += m[0].length; continue; }
      if ((m = AUTOLINK.exec(rest))) {
        const href = safeHref(m[1]);
        if (href !== null && !ctx.inLink) push(linkNode(href, null, [m[1]]));
        else buf += m[0];
        i += m[0].length; continue;
      }
      buf += c; i += 1; continue;
    }
    if ((c === '[' || (c === '!' && s[i + 1] === '[')) && !(c === '[' && ctx.inLink) && (ctx.depth || 0) < MAX_INLINE_DEPTH) {
      const image = c === '!';
      const open = image ? i + 1 : i;
      const close = scanner(s).bracket(open);
      if (close > 0) {
        const text = s.slice(open + 1, close);
        let target = null;
        let end = close + 1;
        if (s[close + 1] === '(') {
          const t = linkTail(s, close + 1);
          if (t) { target = t; end = t.end; }
        }
        if (!target && s[close + 1] === '[') {
          const lc = s.indexOf(']', close + 2);
          if (lc > 0) {
            const label = s.slice(close + 2, lc) || text;
            const ref = ctx.refs[normLabel(label)];
            if (ref) { target = ref; end = lc + 1; }
          }
        }
        if (!target && s[close + 1] !== '(' && s[close + 1] !== '[') {
          const ref = ctx.refs[normLabel(text)];
          if (ref) target = ref;
        }
        if (target) {
          const original = s.slice(i, end);
          if (image) {
            const srcUrl = safeImageSrc(target.href);
            const alt = plainText(parseInline(text, { ...ctx, inLink: true, depth: (ctx.depth || 0) + 1 })).trim();
            if (srcUrl !== null) push({ tag: 'img', attrs: { src: srcUrl, alt, title: target.title || undefined } });
            else buf += original;
          } else {
            const href = safeHref(target.href);
            if (href !== null) push(linkNode(href, target.title, parseInline(text, { ...ctx, inLink: true, depth: (ctx.depth || 0) + 1 })));
            else buf += original;
          }
          i = end; continue;
        }
      }
      buf += image ? '![' : '['; i += image ? 2 : 1; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i; while (s[j] === c) j += 1;
      const count = j - i;
      if ((c === '~' && count > 2) || count > 64) { buf += s.slice(i, j); i = j; continue; }
      const before = i > 0 ? s[i - 1] : undefined;
      const after = s[j];
      const left = !isWS(after) && (!isPunct(after) || isWS(before) || isPunct(before));
      const right = !isWS(before) && (!isPunct(before) || isWS(after) || isPunct(after));
      let canOpen = left, canClose = right;
      if (c === '_') { canOpen = left && (!right || isPunct(before)); canClose = right && (!left || isPunct(after)); }
      flush();
      tokens.push({ delim: true, ch: c, count, orig: count, canOpen, canClose });
      i = j; continue;
    }
    if (c === '\n') {
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/[ \t]+$/, '');
      if (hard) push({ tag: 'br' }); else buf += '\n';
      i += 1;
      while (s[i] === ' ' || s[i] === '\t') i += 1;
      continue;
    }
    if (!ctx.inLink && (c === 'h' || c === 'H' || c === 'w' || c === 'W') && (i === 0 || /[\s(*_~]/.test(s[i - 1]))) {
      const m = BARE_URL.exec(s.slice(i, i + 4096));
      if (m) {
        const url = trimBareUrl(m[0]);
        if (url.length > (url.toLowerCase().startsWith('www.') ? 4 : 8) && /[.\w]/.test(url.slice(-1))) {
          push(linkNode(url.toLowerCase().startsWith('www.') ? `https://${url}` : url, null, [url]));
          i += url.length; continue;
        }
      }
    }
    buf += c; i += 1;
  }
  flush();
  return mergeText(processEmphasis(tokens));
}

const EM_DEPTH = new WeakMap();
const MAX_EMPHASIS_DEPTH = 32;

function processEmphasis(tokens) {
  const bottom = new Map();  // CommonMark "openers_bottom": where a failed search for this kind of closer stopped
  let c = 0;
  while (c < tokens.length) {
    const closer = tokens[c];
    if (!closer?.delim || !closer.canClose || closer.count === 0) { c += 1; continue; }
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}${closer.ch === '~' ? closer.count : ''}`;
    const floor = bottom.get(key) ?? -1;
    let o = c - 1;
    for (; o > floor; o -= 1) {
      const op = tokens[o];
      if (!op?.delim || op.ch !== closer.ch || !op.canOpen || op.count === 0) continue;
      if (op.ch === '~') { if (op.count === closer.count) break; continue; }
      if ((op.canClose || closer.canOpen) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      break;
    }
    if (o <= floor) { bottom.set(key, c - 1); c += 1; continue; }
    const opener = tokens[o];
    const use = closer.ch === '~' ? closer.count : (opener.count >= 2 && closer.count >= 2 ? 2 : 1);
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const inner = tokens.slice(o + 1, c).map(literalDelim);
    let depth = 1;
    for (const t of inner) if (typeof t === 'object') depth = Math.max(depth, 1 + (EM_DEPTH.get(t) || 0));
    if (depth > MAX_EMPHASIS_DEPTH) { bottom.set(key, c - 1); c += 1; continue; }  // absurd nesting stays literal text
    const node = { tag, children: mergeText(inner) };
    EM_DEPTH.set(node, depth);
    opener.count -= use; closer.count -= use;
    // keep the bottoms pointing at the same tokens (or lower, which is only slower, never wrong)
    const removed = (a, k) => { for (const [kk, v] of bottom) if (v >= a) bottom.set(kk, v >= a + k ? v - k : a - 1); };
    tokens.splice(o + 1, c - o - 1, node);
    removed(o + 1, c - o - 1);
    for (const [kk, v] of bottom) if (v >= o + 1) bottom.set(kk, v + 1);
    c = o + 2;  // closer index after the splice
    if (opener.count === 0) { tokens.splice(o, 1); removed(o, 1); c -= 1; }
    if (closer.count === 0) { tokens.splice(c, 1); removed(c, 1); }
  }
  return tokens.map(literalDelim);
}

const literalDelim = (t) => (t?.delim ? t.ch.repeat(t.count) : t);

function mergeText(list) {
  const out = [];
  for (const t of list) {
    if (t === '' || t === null || t === undefined) continue;
    if (typeof t === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += t;
    else out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ block parsing */
const RE = {
  blank: /^[ \t]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  item: /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  delimRow: /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  refDef: /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/,
};

const indentOf = (l) => l.match(/^ */)[0].length;
const expandTabs = (l) => l.replace(/^[ \t]+/, (ws) => {
  let col = 0;
  for (const ch of ws) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return ' '.repeat(col);
});

function fenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, fence: m[2], lang: unescape(m[3].trim().split(/\s+/)[0] || '') };
}

function itemStart(line) {
  if (RE.hr.test(line)) return null;
  const m = RE.item.exec(line);
  if (!m) return null;
  return { indent: m[1].length, marker: m[2], spacing: m[3] || '', rest: m[4] ?? '' };
}

/** Lines that end a paragraph (and so can't be lazy continuation lines). */
function interrupts(line) {
  if (RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line) || fenceOpen(line)) return true;
  const it = itemStart(line);
  if (!it || !it.rest.trim()) return false;
  return !/\d/.test(it.marker) || parseInt(it.marker, 10) === 1;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (c === '`') { const n = backtickRun(s, i); inCode = inCode === n ? 0 : inCode || n; cur += s.slice(i, i + n); i += n - 1; continue; }
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(lines, ctx, depth = 0) {
  const nest = depth < MAX_BLOCK_DEPTH;
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (RE.blank.test(line)) { i += 1; continue; }

    // indented code
    if (indentOf(line) >= 4) {
      const code = [];
      while (i < n && (RE.blank.test(lines[i]) || indentOf(lines[i]) >= 4)) { code.push(lines[i].slice(4)); i += 1; }
      while (code.length && RE.blank.test(code[code.length - 1])) code.pop();
      out.push(codeBlock(code.join('\n'), ''));
      continue;
    }

    // fenced code
    const f = fenceOpen(line);
    if (f) {
      const code = [];
      i += 1;
      const closeRe = new RegExp(`^ {0,3}${f.fence[0] === '`' ? '`' : '~'}{${f.fence.length},}[ \\t]*$`);
      while (i < n && !closeRe.test(lines[i])) {
        code.push(lines[i].replace(new RegExp(`^ {0,${f.indent}}`), ''));
        i += 1;
      }
      i += 1;  // closing fence (or end of input)
      out.push(codeBlock(code.join('\n'), f.lang));
      continue;
    }

    let m;
    if ((m = RE.atx.exec(line))) {
      out.push({ tag: `h${m[1].length}`, raw: (m[2] || '').replace(/(^|[ \t])#+[ \t]*$/, '').trim() });
      i += 1; continue;
    }
    if (RE.hr.test(line)) { out.push({ tag: 'hr' }); i += 1; continue; }

    if (nest && RE.quote.test(line)) {
      const inner = [];
      while (i < n) {
        if (RE.quote.test(lines[i])) inner.push(lines[i].replace(RE.quote, ''));
        else if (!RE.blank.test(lines[i]) && inner.length && !RE.blank.test(inner[inner.length - 1]) && !interrupts(lines[i])) inner.push(lines[i]);
        else break;
        i += 1;
      }
      out.push({ tag: 'blockquote', children: parseBlocks(inner, ctx, depth + 1) });
      continue;
    }

    if (nest && itemStart(line)) { i = parseList(lines, i, out, ctx, depth); continue; }

    // GFM table: header row + delimiter row with the same number of cells
    if (line.includes('|') && i + 1 < n && RE.delimRow.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const delims = splitRow(lines[i + 1]);
      if (head.length === delims.length && (delims.length > 1 || lines[i + 1].includes('|'))) {
        const align = delims.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null));
        const cell = (tag, raw, k) => ({ tag, attrs: align[k] ? { style: `text-align: ${align[k]}` } : undefined, raw });
        const rows = [];
        i += 2;
        while (i < n && !RE.blank.test(lines[i]) && !interrupts(lines[i])) {
          const cells = splitRow(lines[i]);
          rows.push({ tag: 'tr', children: head.map((_, k) => cell('td', cells[k] ?? '', k)) });
          i += 1;
        }
        out.push({ tag: 'table', children: [
          { tag: 'thead', children: [{ tag: 'tr', children: head.map((h, k) => cell('th', h, k)) }] },
          ...(rows.length ? [{ tag: 'tbody', children: rows }] : []),
        ] });
        continue;
      }
    }

    // link reference definitions
    if ((m = RE.refDef.exec(line))) {
      const label = normLabel(m[1]);
      const href = m[2].startsWith('<') ? m[2].slice(1, -1) : m[2];
      if (!(label in ctx.refs)) ctx.refs[label] = { href: unescape(href), title: m[3] ? unescape(m[3].slice(1, -1)) : null };
      i += 1; continue;
    }

    // paragraph (or setext heading)
    const para = [line];
    i += 1;
    let heading = 0;
    while (i < n) {
      const l = lines[i];
      if (RE.blank.test(l)) break;
      const sm = RE.setext.exec(l);
      if (sm) { heading = sm[1][0] === '=' ? 1 : 2; i += 1; break; }
      if (interrupts(l)) break;
      para.push(l); i += 1;
    }
    const raw = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    out.push({ tag: heading ? `h${heading}` : 'p', raw });
  }
  return out;
}

function codeBlock(text, lang) {
  const attrs = lang ? { class: `language-${lang}` } : undefined;
  return { tag: 'pre', lang: lang || '', children: [{ tag: 'code', attrs, children: text ? [text] : [] }] };
}

function parseList(lines, i, out, ctx, depth) {
  const first = itemStart(lines[i]);
  const ordered = /\d/.test(first.marker);
  const kind = ordered ? first.marker.slice(-1) : first.marker;
  const sameKind = (it) => it && (ordered ? /\d/.test(it.marker) && it.marker.slice(-1) === kind : it.marker === kind);
  const items = [];
  let loose = false;
  const n = lines.length;
  while (i < n) {
    const it = itemStart(lines[i]);
    if (!sameKind(it)) break;
    const markerWidth = it.indent + it.marker.length;
    const spaces = expandTabs(`${it.spacing}x`).length - 1;
    let contentIndent;
    let firstLine = it.rest;
    if (!it.rest.trim()) contentIndent = markerWidth + 1;
    else if (spaces > 4) { contentIndent = markerWidth + 1; firstLine = ' '.repeat(spaces - 1) + it.rest; }
    else contentIndent = markerWidth + spaces;
    const body = [firstLine];
    i += 1;
    while (i < n) {
      const l = lines[i];
      if (RE.blank.test(l)) {
        if (body.length === 1 && !body[0].trim()) break;  // an empty item can't start with a blank line
        body.push(''); i += 1; continue;
      }
      if (indentOf(l) >= contentIndent) { body.push(l.slice(contentIndent)); i += 1; continue; }
      if (!RE.blank.test(body[body.length - 1]) && !interrupts(l) && !itemStart(l) && !fenceOpen(body[0])) { body.push(l); i += 1; continue; }
      break;
    }
    let trailing = 0;
    while (body.length && RE.blank.test(body[body.length - 1])) { body.pop(); trailing += 1; }
    // a blank line between two direct blocks of this item makes the list loose
    if (hasInnerBlankBetweenBlocks(body)) loose = true;
    items.push({ body, ordered: ordered ? parseInt(it.marker, 10) : null });
    if (trailing && i < n && sameKind(itemStart(lines[i]))) loose = true;
    if (trailing && !(i < n && sameKind(itemStart(lines[i])))) break;
  }
  const lis = items.map(({ body }) => {
    let task = null;
    const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(body[0] || '');
    if (tm) { task = tm[1] !== ' '; body[0] = body[0].slice(tm[0].length); }
    const children = parseBlocks(body, ctx, depth + 1);
    const li = { tag: 'li', children, tight: !loose };
    if (task !== null) {
      li.attrs = { class: 'task-list-item' };
      li.task = task;
    }
    return li;
  });
  const attrs = ordered && items[0].ordered !== 1 ? { start: items[0].ordered } : undefined;
  const hasTasks = lis.some((li) => li.task !== undefined);
  out.push({ tag: ordered ? 'ol' : 'ul', attrs: hasTasks ? { ...attrs, class: 'contains-task-list' } : attrs, children: lis });
  return i;
}

function hasInnerBlankBetweenBlocks(body) {
  // blank followed by more content at the item's own indentation (not inside a fenced code block)
  let inFence = null;
  for (let k = 0; k < body.length; k += 1) {
    const f = fenceOpen(body[k]);
    if (inFence) { if (new RegExp(`^ {0,3}${inFence[0]}{${inFence.length},}[ \\t]*$`).test(body[k])) inFence = null; continue; }
    if (f) { inFence = f.fence; continue; }
    if (RE.blank.test(body[k]) && k + 1 < body.length && !RE.blank.test(body[k + 1]) && indentOf(body[k + 1]) < 2) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ finishing */
function finish(nodes, ctx, slugs) {
  return nodes.flatMap((n) => {
    if (typeof n === 'string') return [n];
    const node = { tag: n.tag };
    if (n.attrs) node.attrs = { ...n.attrs };
    if (n.lang !== undefined) node.lang = n.lang;
    if (n.raw !== undefined) node.children = parseInline(n.raw, ctx);
    else if (n.children) node.children = n.tag === 'pre' ? n.children : finish(n.children, ctx, slugs);
    if (n.tag === 'li') {
      if (n.tight) node.children = node.children.flatMap((c) => (typeof c !== 'string' && c.tag === 'p' ? c.children : [c]));
      if (n.task !== undefined) node.children.unshift({ tag: 'input', attrs: { type: 'checkbox', disabled: true, checked: n.task } }, ' ');
    }
    if (/^h[1-6]$/.test(n.tag)) {
      const base = slugify(plainText(node.children));
      let id = base;
      let k = slugs.get(base) || 0;
      while (slugs.has(id)) { k += 1; id = `${base}-${k}`; }
      slugs.set(base, k);
      slugs.set(id, slugs.get(id) || 0);
      node.attrs = { id };
    }
    return [node];
  });
}

/** Markdown text → array of block nodes. */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n').map(expandTabs);
  const ctx = { refs: Object.create(null) };
  const blocks = parseBlocks(lines, ctx);
  return finish(blocks, ctx, new Map());
}

/** Standalone HTML document for "Download .html". */
export function htmlDocument(nodes, title = 'Document') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { max-width: 780px; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1b1f24; }
pre { background: #f3f4f6; padding: .8rem 1rem; border-radius: 6px; overflow: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
:not(pre) > code { background: #f3f4f6; padding: .1em .3em; border-radius: 4px; }
blockquote { margin: 0; padding-left: 1rem; border-left: 4px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: .3rem .6rem; }
img { max-width: 100%; } .task-list-item { list-style: none; } .contains-task-list { padding-left: 1.2rem; }
</style>
</head>
<body>
${toHtml(nodes)}</body>
</html>
`;
}
