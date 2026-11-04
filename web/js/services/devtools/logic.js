// Pure helpers behind the Dev Tools tab: no DOM, so they can be exercised from node as well.

/* ------------------------------------------------------------------ JSON */
/**
 * Parse JSON → {value, unsafeInts}; on failure {error, line, col} (1-based, null when the engine gives no position).
 * unsafeInts lists integer literals beyond 2^53, which JSON.parse silently rounds.
 */
export function parseJson(text) {
  try {
    return { value: JSON.parse(text), unsafeInts: unsafeIntegers(text) };
  } catch (e) {
    const msg = e.message;
    let line = null, col = null;
    const lc = msg.match(/line (\d+) column (\d+)/);
    const pos = msg.match(/at position (\d+)/);
    if (lc) [line, col] = [Number(lc[1]), Number(lc[2])];
    else if (pos) ({ line, col } = lineCol(text, Number(pos[1])));
    else ({ line, col } = lineCol(text, jsonErrorOffset(text)));
    return { error: msg, line, col };
  }
}

/** Integer literals (outside strings) that a double cannot hold exactly; call only on valid JSON. */
export function unsafeIntegers(text) {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (bare.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || [])
    .filter((lit) => /^-?\d+$/.test(lit) && !Number.isSafeInteger(Number(lit)));
}

/** Offset of the first syntax error, for engines whose message carries no position (newer V8). */
export function jsonErrorOffset(text) {
  let i = 0;
  const ws = () => { while (/[ \t\n\r]/.test(text[i] || '')) i++; };
  const fail = () => { throw i; };
  const lit = (word) => { if (text.startsWith(word, i)) i += word.length; else fail(); };
  function value() {
    ws();
    const c = text[i];
    if (c === '{') return container('}', true);
    if (c === '[') return container(']', false);
    if (c === '"') return string();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m || !m[0]) fail();
    i += m[0].length;
  }
  function string() {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] < ' ') fail();
      if (text[i] === '\\') { i++; if (!/["\\/bfnrtu]/.test(text[i] || '')) fail(); }
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
  }
  function container(close, isObject) {
    i++; ws();
    if (text[i] === close) { i++; return; }
    for (;;) {
      if (isObject) { ws(); if (text[i] !== '"') fail(); string(); ws(); if (text[i] !== ':') fail(); i++; }
      value(); ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === close) { i++; return; }
      fail();
    }
  }
  try { value(); ws(); return i < text.length ? i : text.length; } catch (at) { return at; }
}

export function lineCol(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const childPath = (path, key) => (typeof key === 'number' ? `${path}[${key}]`
  : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/** Structural diff: [{op: 'added'|'removed'|'changed', path, from?, to?}] */
export function jsonDiff(a, b, path = '$', out = []) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ op: 'added', path: childPath(path, i), to: b[i] });
      else if (i >= b.length) out.push({ op: 'removed', path: childPath(path, i), from: a[i] });
      else jsonDiff(a[i], b[i], childPath(path, i), out);
    }
  } else if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!Object.hasOwn(b, k)) out.push({ op: 'removed', path: childPath(path, k), from: a[k] });
      else jsonDiff(a[k], b[k], childPath(path, k), out);
    }
    for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) out.push({ op: 'added', path: childPath(path, k), to: b[k] });
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ op: 'changed', path, from: a, to: b });
  }
  return out;
}

/* ------------------------------------------------------------------ line diff (LCS) */
export const DIFF_MAX_CELLS = 25e6;

/**
 * Line diff: [{type: 'eq'|'del'|'add', text, a?, b?}] with 1-based line numbers.
 * Common prefix/suffix are stripped before the O(n·m) LCS table; throws when the rest is too large.
 */
export function lineDiff(oldText, newText) {
  const A = splitLines(oldText), B = splitLines(newText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > DIFF_MAX_CELLS) throw new Error(`Too many differing lines to diff (${n} × ${m}).`);

  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened
  const w = m + 1, lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ type: 'eq', text: A[k], a: k + 1, b: k + 1 });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ type: 'eq', text: a[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
    else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { ops.push({ type: 'del', text: a[i], a: pre + i + 1 }); i++; }
    else { ops.push({ type: 'add', text: b[j], b: pre + j + 1 }); j++; }
  }
  for (let k = 0; k < suf; k++) ops.push({ type: 'eq', text: A[A.length - suf + k], a: A.length - suf + k + 1, b: B.length - suf + k + 1 });
  return ops;
}

function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}

export function diffCounts(ops) {
  const c = { add: 0, del: 0, eq: 0 };
  for (const o of ops) c[o.type]++;
  return c;
}

/** Pairs deletions with the additions that follow them: [{left: op|null, right: op|null}] */
export function sideBySide(ops) {
  const rows = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].type === 'eq') { rows.push({ left: ops[k], right: ops[k] }); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].type === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].type === 'add') adds.push(ops[k++]);
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) rows.push({ left: dels[r] || null, right: adds[r] || null });
  }
  return rows;
}

export function unifiedText(ops) {
  return ops.map((o) => `${o.type === 'add' ? '+' : o.type === 'del' ? '-' : ' '} ${o.text}`).join('\n');
}

/* ------------------------------------------------------------------ Base64 */
export function bytesToBase64(bytes, urlSafe = false) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

export function base64ToBytes(text) {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*=*$/.test(clean)) throw new Error('Not valid Base64.');
  const padded = clean.replace(/=+$/, '');
  if (padded.length % 4 === 1) throw new Error('Not valid Base64 (bad length).');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const encodeBase64 = (text, urlSafe) => bytesToBase64(new TextEncoder().encode(text), urlSafe);
export const decodeBase64 = (text) => new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(text));

/* ------------------------------------------------------------------ JWT */
export function decodeJwt(token) {
  const parts = token.trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length < 2) throw new Error('A JWT has three dot-separated parts: header.payload.signature');
  const part = (p, name) => {
    let v;
    try { v = JSON.parse(decodeBase64(p)); } catch { throw new Error(`The ${name} is not Base64url-encoded JSON.`); }
    if (!isObj(v)) throw new Error(`The ${name} is not a JSON object.`);
    return v;
  };
  return { header: part(parts[0], 'header'), payload: part(parts[1], 'payload'), signature: parts[2] || '' };
}

/** exp / nbf status at `now` (seconds): {state: 'expired'|'not-yet'|'valid'|'no-exp', seconds} */
export function jwtStatus(payload, now = Date.now() / 1000) {
  if (typeof payload.nbf === 'number' && now < payload.nbf) return { state: 'not-yet', seconds: payload.nbf - now };
  if (typeof payload.exp !== 'number') return { state: 'no-exp' };
  return payload.exp <= now ? { state: 'expired', seconds: now - payload.exp } : { state: 'valid', seconds: payload.exp - now };
}

/* ------------------------------------------------------------------ time */
/**
 * Epoch number (unit picked by magnitude) or any date string → {date, unit}.
 * Below 1e11 is seconds (year 5138), below 1e14 milliseconds, below 1e17 microseconds, else nanoseconds.
 */
export function parseTimeInput(input) {
  const s = String(input).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s), abs = Math.abs(n);
    const [unit, ms] = abs < 1e11 ? ['seconds', n * 1000] : abs < 1e14 ? ['milliseconds', n]
      : abs < 1e17 ? ['microseconds', n / 1e3] : ['nanoseconds', n / 1e6];
    return { date: new Date(ms), unit };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { date: new Date(t), unit: 'date' };
}

export function humanDuration(seconds) {
  const s = Math.abs(seconds);
  const units = [['y', 31536000], ['d', 86400], ['h', 3600], ['min', 60], ['s', 1]];
  const parts = [];
  let rest = Math.floor(s);
  for (const [u, n] of units) {
    if (rest >= n && parts.length < 2) { parts.push(`${Math.floor(rest / n)} ${u}`); rest %= n; }
  }
  return parts.join(' ') || '0 s';
}

export function relativeTime(date, now = Date.now()) {
  const diff = (date.getTime() - now) / 1000;
  if (Math.abs(diff) < 1) return 'now';
  return diff < 0 ? `${humanDuration(diff)} ago` : `in ${humanDuration(diff)}`;
}

export function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone, dateStyle: 'full', timeStyle: 'long',
  }).format(date);
}

/* ------------------------------------------------------------------ UUID */
export function formatUuid(uuid, { upper = false, hyphens = true } = {}) {
  const s = hyphens ? uuid : uuid.replace(/-/g, '');
  return upper ? s.toUpperCase() : s.toLowerCase();
}

/* ------------------------------------------------------------------ URL */
/** decodeURIComponent that keeps the raw text when it holds a malformed %-escape. */
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function parseUrl(text) {
  const u = new URL(text.trim());
  return {
    protocol: u.protocol, username: u.username, host: u.hostname, port: u.port, path: safeDecode(u.pathname),
    hash: safeDecode(u.hash.slice(1)), origin: u.origin,
    params: [...u.searchParams.entries()],
  };
}

/** Same URL with its query string replaced by `params` ([[key, value]], empty keys dropped). */
export function rebuildUrl(text, params) {
  const u = new URL(text.trim());
  u.search = new URLSearchParams(params.filter(([k]) => k !== '')).toString();
  return u.toString();
}

/* ------------------------------------------------------------------ text */
/** Splits identifiers and prose into words: "parseHTTPResponse_v2" → [parse, HTTP, Response, v2]. */
export function splitWords(text) {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export const CASES = {
  camel: { label: 'camelCase', fn: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join('') },
  pascal: { label: 'PascalCase', fn: (w) => w.map(cap).join('') },
  snake: { label: 'snake_case', fn: (w) => w.map((x) => x.toLowerCase()).join('_') },
  constant: { label: 'CONSTANT_CASE', fn: (w) => w.map((x) => x.toUpperCase()).join('_') },
  kebab: { label: 'kebab-case', fn: (w) => w.map((x) => x.toLowerCase()).join('-') },
  title: { label: 'Title Case', fn: (w) => w.map(cap).join(' ') },
};

/** Identifier cases apply per line so a pasted list stays a list; lower/UPPER keep the text as is. */
export function convertCase(text, kind) {
  if (kind === 'lower') return text.toLowerCase();
  if (kind === 'upper') return text.toUpperCase();
  return text.split('\n').map((line) => CASES[kind].fn(splitWords(line))).join('\n');
}

export function textCounts(text) {
  return {
    chars: [...text].length,
    words: (text.match(/\S+/g) || []).length,
    lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
    bytes: new TextEncoder().encode(text).length,
  };
}

export const LINE_OPS = {
  trim: { label: 'Trim lines', fn: (l) => l.map((x) => x.trim()) },
  noBlank: { label: 'Remove blank lines', fn: (l) => l.filter((x) => x.trim() !== '') },
  sort: { label: 'Sort', fn: (l) => [...l].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) },
  unique: { label: 'Unique', fn: (l) => [...new Set(l)] },
  reverse: { label: 'Reverse', fn: (l) => [...l].reverse() },
};

export const applyLineOp = (text, op) => LINE_OPS[op].fn(text.split(/\r?\n/)).join('\n');

/* ------------------------------------------------------------------ hash */
export const HASHES = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
