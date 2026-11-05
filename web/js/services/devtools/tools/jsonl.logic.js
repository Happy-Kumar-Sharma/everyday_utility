// Pure logic for the JSONL inspector (no DOM): line splitting for streamed chunks, per-line parsing, key paths,
// path lookup, a tiny filter language and the running statistics. Exercised from tests/test_devtools_pipeline.py.

/** parseLine(text) → { blank: true } | { value } | { error } */
export function parseLine(line) {
  const t = String(line ?? '').replace(/^﻿/, '').trim();
  if (!t) return { blank: true };
  try { return { value: JSON.parse(t) }; } catch (e) { return { error: e.message.replace(/^JSON\.parse: /, '') }; }
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/**
 * Dot paths of an object's keys up to `depth` key levels → [[path, type]], de-duplicated.
 * Array elements are written as `[]` (e.g. predictions[].score) and merged across elements.
 */
export function keyPaths(obj, depth = 3) {
  const out = new Map();
  const add = (p, v) => { const t = typeOf(v); const s = out.get(p) || new Set(); s.add(t); out.set(p, s); };
  function walk(v, prefix, level) {
    if (Array.isArray(v)) {
      for (const el of v) {
        if (el && typeof el === 'object') walk(el, `${prefix}[]`, level);
      }
      return;
    }
    if (!v || typeof v !== 'object' || level >= depth) return;
    for (const [k, child] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      add(p, child);
      if (child && typeof child === 'object') walk(child, p, level + 1);
    }
  }
  walk(obj, '', 0);
  return [...out].map(([p, types]) => [p, [...types].sort().join('|')]);
}

/** 'a.b[0].c' / 'a.b.0.c' / 'a.b[].c' / 'a.*.c' → ['a','b','0','c'] ('*' for wildcards). */
export function splitPath(path) {
  return String(path ?? '').trim()
    .replace(/\[(\d+)\]/g, '.$1').replace(/\[\]/g, '.*').replace(/\["([^"]+)"\]/g, '.$1')
    .split('.').filter((p) => p !== '');
}

const MISSING = undefined;
/**
 * getPath(obj, 'a.b.0.c') → value or undefined. A wildcard segment (`[]` or `*`) maps over array elements /
 * object values and returns an array of the values found (missing ones dropped).
 */
export function getPath(obj, path) {
  const parts = Array.isArray(path) ? path : splitPath(path);
  if (!parts.length) return obj;
  function step(v, i) {
    if (i === parts.length) return v;
    if (v === null || typeof v !== 'object') return MISSING;
    const p = parts[i];
    if (p === '*') {
      const items = Array.isArray(v) ? v : Object.values(v);
      const res = [];
      for (const it of items) {
        const r = step(it, i + 1);
        if (r === MISSING) continue;
        if (parts.slice(i + 1).includes('*') && Array.isArray(r)) res.push(...r); else res.push(r);
      }
      return res;
    }
    if (!Object.prototype.hasOwnProperty.call(v, p)) return MISSING;
    return step(v[p], i + 1);
  }
  return step(obj, 0);
}
export const hasWildcard = (path) => splitPath(path).includes('*');

/** Values at `path` as a flat list (wildcards expand; missing → []). */
export function valuesAt(obj, path) {
  const v = getPath(obj, path);
  if (v === MISSING) return [];
  return hasWildcard(path) ? v : [v];
}

const OPS = ['==', '!=', '>=', '<=', '>', '<', '!contains', 'contains', '!exists', 'exists', 'not exists', 'not contains'];
/**
 * parseFilter('score > 0.5') → { path, op, value } or { error }.
 * Ops: == != > < >= <= contains (!contains / not contains) exists (!exists / not exists).
 * The value is JSON when it parses (numbers, true, null, "quoted"), otherwise the raw text.
 */
export function parseFilter(expr) {
  const s = String(expr ?? '').trim();
  if (!s) return { error: 'Empty filter' };
  const m = s.match(/^(\S+)\s+(==|!=|>=|<=|>|<|!?contains|not\s+contains|!?exists|not\s+exists)\b\s*(.*)$/i)
    || s.match(/^(\S+?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/);
  if (!m) return { error: `Use: <key path> <op> <value>, op is one of ${['==', '!=', '>', '<', '>=', '<=', 'contains', 'exists'].join(' ')}` };
  let op = m[2].toLowerCase().replace(/^not\s+/, '!');
  const raw = m[3].trim();
  if (!OPS.includes(op)) return { error: `Unknown operator ${m[2]}` };
  if (/exists$/.test(op)) { if (raw) return { error: `${op} takes no value` }; return { path: m[1], op, value: null }; }
  if (!raw) return { error: `${op} needs a value` };
  let value;
  try { value = JSON.parse(raw); } catch { value = raw.replace(/^'(.*)'$/, '$1'); }
  return { path: m[1], op, value };
}

const asNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
function equal(a, b) {
  if (a === b) return true;
  if (a && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const na = asNum(a), nb = asNum(b);
  if (na != null && nb != null) return na === nb;
  return String(a) === String(b);
}
function compare(a, b) {
  const na = asNum(a), nb = asNum(b);
  if (na != null && nb != null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (a == null || typeof a === 'object') return null;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function contains(v, needle) {
  if (Array.isArray(v)) return v.some((x) => equal(x, needle));
  if (v && typeof v === 'object') return Object.prototype.hasOwnProperty.call(v, String(needle));
  if (v == null) return false;
  return String(v).toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * matchFilter(obj, 'score > 0.5' | parsedFilter) → boolean. With a wildcard path (predictions[].score > 0.5)
 * the row matches when ANY value matches (for != / !contains / !exists: when none does). Throws on a bad filter.
 */
export function matchFilter(obj, expr) {
  const f = typeof expr === 'string' ? parseFilter(expr) : expr;
  if (f.error) throw new Error(f.error);
  const vals = valuesAt(obj, f.path);
  switch (f.op) {
    case 'exists': return vals.length > 0;
    case '!exists': return vals.length === 0;
    case '==': return vals.some((v) => equal(v, f.value));
    case '!=': return !vals.some((v) => equal(v, f.value));
    case 'contains': return vals.some((v) => contains(v, f.value));
    case '!contains': return !vals.some((v) => contains(v, f.value));
    default: return vals.some((v) => {
      const c = compare(v, f.value);
      if (c == null) return false;
      return f.op === '>' ? c > 0 : f.op === '<' ? c < 0 : f.op === '>=' ? c >= 0 : c <= 0;
    });
  }
}

/**
 * Incremental line splitter for streamed text: push(chunk) returns the complete lines so far;
 * end() returns the last line (if any). Handles \n and \r\n split across chunks.
 */
export function lineSplitter() {
  let rest = '';
  return {
    push(chunk) {
      const text = rest + chunk;
      const parts = text.split('\n');
      rest = parts.pop();
      return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    },
    end() {
      const r = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
      rest = '';
      return r === '' ? [] : [r];
    },
  };
}

/**
 * Running statistics over lines. createStats({ preview: 20, maxInvalid: 50, maxPaths: 500, depth: 3 })
 * → { add(line), result() }. Line numbers are counted by add() calls (1-based).
 */
export function createStats({ preview = 20, maxInvalid = 50, maxPaths = 500, depth = 3 } = {}) {
  const s = { total: 0, valid: 0, invalid: 0, blank: 0, objects: 0, invalidLines: [], previewRows: [], chars: 0, minLen: Infinity, maxLen: 0, maxLine: 0, rootTypes: {} };
  const paths = new Map();  // path → { count, types: Map(type → count) }
  let pathsTruncated = false;
  return {
    add(line) {
      const n = ++s.total;
      const len = line.length;
      const r = parseLine(line);
      if (r.blank) { s.blank++; return r; }
      s.chars += len;
      if (len < s.minLen) s.minLen = len;
      if (len > s.maxLen) { s.maxLen = len; s.maxLine = n; }
      if (r.error) {
        s.invalid++;
        if (s.invalidLines.length < maxInvalid) s.invalidLines.push({ line: n, error: r.error, text: line.length > 200 ? `${line.slice(0, 200)}…` : line });
        return r;
      }
      s.valid++;
      const rt = typeOf(r.value);
      s.rootTypes[rt] = (s.rootTypes[rt] || 0) + 1;
      if (s.previewRows.length < preview) s.previewRows.push({ line: n, value: r.value });
      if (rt === 'object') {
        s.objects++;
        for (const [p, types] of keyPaths(r.value, depth)) {
          let e = paths.get(p);
          if (!e) {
            if (paths.size >= maxPaths) { pathsTruncated = true; continue; }
            e = { count: 0, types: new Map() };
            paths.set(p, e);
          }
          e.count++;
          for (const t of types.split('|')) e.types.set(t, (e.types.get(t) || 0) + 1);
        }
      }
      return r;
    },
    result() {
      const nonBlank = s.valid + s.invalid;
      const keys = [...paths].map(([path, e]) => ({
        path, count: e.count, pct: s.objects ? (100 * e.count) / s.objects : 0,
        types: [...e.types].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
      return {
        total: s.total, valid: s.valid, invalid: s.invalid, blank: s.blank, objects: s.objects, rootTypes: s.rootTypes,
        invalidLines: s.invalidLines, preview: s.previewRows, keys, pathsTruncated,
        chars: s.chars, minLen: nonBlank ? s.minLen : 0, maxLen: s.maxLen, maxLine: s.maxLine, avgLen: nonBlank ? s.chars / nonBlank : 0,
      };
    },
  };
}

/** One value → a CSV cell (strings raw, everything else as JSON), quoted when needed. */
export function csvCell(v) {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsvColumn = (header, values) => [csvCell(header), ...values.map(csvCell)].join('\n') + '\n';

/** Short text for a table cell. */
export function cellText(v, max = 120) {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
