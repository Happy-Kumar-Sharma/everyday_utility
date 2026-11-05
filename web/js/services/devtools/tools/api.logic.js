// Pure logic for the 📡 API tester (no DOM): URL ⇄ query rows, {{variables}}, request building, curl export,
// saved-request (Library) format and secret checks. Unit-tested from tests/test_devtools_netimg.py via node.

import { fillTemplate, placeholders } from '../../../core/highlight.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_TYPES = ['none', 'json', 'form', 'raw'];
export const SECRET_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const PH = /\{\{\s*[A-Za-z_]\w*\s*(?::[^}]*)?\}\}/g;

const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
/** encodeURIComponent, but {{placeholders}} stay readable (they are filled in before sending). */
export function encodePart(s) {
  let out = '', last = 0;
  for (const m of String(s).matchAll(PH)) {
    out += encodeURIComponent(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + encodeURIComponent(String(s).slice(last));
}

/** 'https://x/a?b=1&c#f' -> {base: 'https://x/a', query: 'b=1&c', hash: '#f'} (no URL(): keeps {{vars}} intact) */
export function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = rest.indexOf('?');
  return q >= 0 ? { base: rest.slice(0, q), query: rest.slice(q + 1), hash } : { base: rest, query: '', hash };
}

/** Query string of a URL as editable rows [{key, value, on}] (decoded). */
export function parseQuery(url) {
  const { query } = splitUrl(url);
  if (!query) return [];
  return query.split('&').filter((p) => p !== '').map((p) => {
    const eq = p.indexOf('=');
    return eq >= 0 ? { key: safeDecode(p.slice(0, eq)), value: safeDecode(p.slice(eq + 1)), on: true }
      : { key: safeDecode(p), value: '', on: true, bare: true };
  });
}

/** URL with its query string rebuilt from rows (disabled and empty-key rows are left out). */
export function withQuery(url, rows) {
  const { base, hash } = splitUrl(url);
  const qs = rows.filter((r) => r.on !== false && r.key !== '')
    .map((r) => (r.bare && r.value === '' ? encodePart(r.key) : `${encodePart(r.key)}=${encodePart(r.value)}`)).join('&');
  return base + (qs ? `?${qs}` : '') + hash;
}

/** Variable names used anywhere in the request (url, headers, body, form rows, auth), in order. */
export function requestVariables(state) {
  const texts = [state.url || '', ...(state.headers || []).flatMap((r) => [r.key, r.value]),
    state.body || '', ...(state.form || []).flatMap((r) => [r.key, r.value]),
    ...Object.values(state.auth || {}).filter((v) => typeof v === 'string')];
  const seen = new Set();
  for (const t of texts) for (const p of placeholders(t)) seen.add(p.name);
  return [...seen];
}

export const fill = (text, values) => fillTemplate(String(text ?? ''), values || {});
export const unfilled = (text) => [...String(text ?? '').matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)].map((m) => m[1]);

export function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const formEncode = (rows) => rows.filter((r) => r.on !== false && r.key !== '')
  .map((r) => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value)}`.replace(/%20/g, '+')).join('&');

/** JSON check of a body (after variables are filled): {ok} or {error, line, col}. */
export function checkJson(text) {
  if (!text.trim()) return { ok: true, empty: true };
  try { JSON.parse(text); return { ok: true }; } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    if (m) {
      const before = text.slice(0, Number(m[1]));
      const line = before.split('\n').length;
      return { error: e.message, line, col: Number(m[1]) - before.lastIndexOf('\n') };
    }
    return { error: e.message };
  }
}

const hasHeader = (headers, name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

/**
 * Editor state -> what the server sends: {method, url, headers: [[k, v]], body, problems: [..]}.
 * state: {method, url, headers: [{key, value, on}], bodyType, body, form: [{key, value, on}], auth: {type, token, user, password}}
 */
export function buildRequest(state, values = {}) {
  const problems = [];
  const method = (state.method || 'GET').trim().toUpperCase();
  const url = fill(state.url, values).trim();
  const headers = (state.headers || []).filter((r) => r.on !== false && r.key.trim() !== '')
    .map((r) => [fill(r.key, values).trim(), fill(r.value, values)]);
  const auth = state.auth || { type: 'none' };
  if (auth.type === 'bearer' && auth.token && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Bearer ${fill(auth.token, values).trim()}`]);
  } else if (auth.type === 'basic' && (auth.user || auth.password) && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Basic ${utf8Base64(`${fill(auth.user, values)}:${fill(auth.password, values)}`)}`]);
  }
  let body = null;
  const type = state.bodyType || 'none';
  if (type === 'json' || type === 'raw') {
    body = fill(state.body, values);
    if (type === 'json') {
      const r = checkJson(body);
      if (r.error) problems.push(`Body is not valid JSON${r.line ? ` (line ${r.line}, column ${r.col})` : ''}: ${r.error}`);
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
    }
  } else if (type === 'form') {
    body = formEncode((state.form || []).map((r) => ({ ...r, key: fill(r.key, values), value: fill(r.value, values) })));
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }
  if (!url) problems.push('Enter a URL.');
  else if (!/^https?:\/\//i.test(url)) problems.push('The URL must start with http:// or https://');
  const missing = [...new Set([url, ...headers.flat(), body || ''].flatMap(unfilled))];
  if (missing.length) problems.push(`No value for ${missing.map((n) => `{{${n}}}`).join(', ')} — fill it in under Variables.`);
  return { method, url, headers, body, problems };
}

/** POSIX-shell single-quote. */
export const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function toCurl(req, { insecure = false, follow = true } = {}) {
  const hasBody = req.body != null && req.body !== '';
  const segs = ['curl'];
  if (req.method === 'HEAD') segs.push('-I');
  else if (req.method !== 'GET' || hasBody) segs.push(`-X ${shq(req.method)}`);
  if (follow) segs.push('-L');
  if (insecure) segs.push('-k');
  segs.push(shq(req.url));
  for (const [k, v] of req.headers) segs.push(`-H ${shq(`${k}: ${v}`)}`);
  if (hasBody) segs.push(`--data-raw ${shq(req.body)}`);
  return segs.join(segs.length > 4 ? ' \\\n  ' : ' ');
}

/** 'ok' | 'warn' | 'err' for a status pill. */
export const statusKind = (code) => (code >= 200 && code < 300 ? 'ok' : code >= 300 && code < 400 ? 'warn' : 'err');

/** True when a header value is made only of {{placeholders}} (and an optional scheme like "Bearer "). */
export function isPlaceholderOnly(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  const rest = v.replace(/^(Bearer|Basic|Token|Digest)\s+/i, '').replace(PH, '').trim();
  return rest === '' && v.includes('{{');
}

/** Names of secrets typed literally (not as {{variables}}) — warned about before saving to the Library. */
export function literalSecrets(state) {
  const found = [];
  for (const r of state.headers || []) {
    if (r.key && SECRET_HEADERS.includes(r.key.trim().toLowerCase()) && r.value.trim() && !isPlaceholderOnly(r.value)) found.push(`${r.key.trim()} header`);
  }
  const a = state.auth || {};
  if (a.type === 'bearer' && a.token && !isPlaceholderOnly(a.token)) found.push('Bearer token');
  if (a.type === 'basic' && a.password && !isPlaceholderOnly(a.password)) found.push('Basic auth password');
  return found;
}

const rowsOut = (rows) => (rows || []).filter((r) => r.key !== '' || r.value !== '').map((r) => (r.on === false ? [r.key, r.value, false] : [r.key, r.value]));
const rowsIn = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r.length >= 2)
  .map(([key, value, on]) => ({ key: String(key), value: String(value ?? ''), on: on !== false }));

/** Editor state -> Library item content (placeholders kept, never filled). */
export function toSaved(state) {
  const out = { method: (state.method || 'GET').toUpperCase(), url: state.url || '', headers: rowsOut(state.headers),
    body: state.bodyType === 'form' ? formEncode(state.form || []) : (state.bodyType === 'none' ? null : state.body ?? '') };
  out.bodyType = state.bodyType || 'none';
  if (state.bodyType === 'form') out.form = rowsOut(state.form);
  const a = state.auth || {};
  if (a.type === 'bearer') out.auth = { type: 'bearer', token: a.token || '' };
  if (a.type === 'basic') out.auth = { type: 'basic', user: a.user || '', password: a.password || '' };
  return JSON.stringify(out, null, 2);
}

/** Library item content -> editor state. Throws Error with a friendly message on bad input. */
export function fromSaved(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('This item is not valid JSON.'); }
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.url !== 'string') throw new Error('This item is not a saved API request (no "url").');
  let headers = d.headers;
  if (headers && !Array.isArray(headers) && typeof headers === 'object') headers = Object.entries(headers);
  const body = d.body == null ? '' : typeof d.body === 'string' ? d.body : JSON.stringify(d.body, null, 2);
  let bodyType = BODY_TYPES.includes(d.bodyType) ? d.bodyType : (d.body == null || d.body === '' ? 'none' : checkJson(body).error ? 'raw' : 'json');
  let form = rowsIn(d.form);
  if (bodyType === 'form' && !form.length && body) form = parseQuery(`?${body}`);
  const a = d.auth && typeof d.auth === 'object' ? d.auth : {};
  const auth = a.type === 'bearer' ? { type: 'bearer', token: String(a.token ?? '') }
    : a.type === 'basic' ? { type: 'basic', user: String(a.user ?? ''), password: String(a.password ?? '') } : { type: 'none' };
  if (bodyType === 'form' && !form.length) bodyType = 'none';
  return { method: String(d.method || 'GET').toUpperCase(), url: d.url, headers: rowsIn(headers), bodyType, body: bodyType === 'form' ? '' : body, form, auth };
}

/** Body viewer kind for a response: 'json' | 'image' | 'text' | 'binary'. */
export function bodyKind(res) {
  const ct = (headerValue(res.headers, 'content-type') || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (res.body_text == null) return 'binary';
  if (/json/.test(ct) || /^\s*[[{]/.test(res.body_text)) {
    try { JSON.parse(res.body_text); return 'json'; } catch { /* not JSON after all */ }
  }
  return 'text';
}

export const headerValue = (headers, name) => (headers || []).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Filename for "download body": last path segment, else response.<ext from content type>. */
export function bodyFilename(url, contentType = '') {
  const ext = { 'application/json': 'json', 'text/html': 'html', 'text/plain': 'txt', 'text/csv': 'csv', 'application/xml': 'xml',
    'text/xml': 'xml', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf' }[contentType.split(';')[0].trim().toLowerCase()] || 'bin';
  const path = splitUrl(url).base.replace(/^[a-z]+:\/\/[^/]*/i, '');
  const last = safeDecode(path.split('/').pop() || '').replace(/[^\w.-]+/g, '_');
  return last && /\.\w{1,8}$/.test(last) ? last : `response.${ext}`;
}
