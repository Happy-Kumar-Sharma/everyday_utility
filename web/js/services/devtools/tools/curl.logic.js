// curl command parser + converters (fetch, requests, httpx, axios, HTTPie, curl) and fetch(...) → curl. Pure — no DOM.

/* ------------------------------------------------------------------ shell tokenizer */
const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** True when the text looks like a Windows cmd "Copy as cURL (cmd)" command (^ escapes / ^ line continuations). */
export function isCmdStyle(text) {
  return /\^"/.test(text) || /\s\^\r?\n/.test(text) || /\^\s*$/.test(text.trim().split('\n')[0] || '');
}

/** Windows cmd: drop ^-newline continuations, resolve ^x escapes, then "..." quoting with \" inside (as Chrome/Firefox emit). */
function tokenizeCmd(text) {
  const src = text.replace(/\^\r?\n/g, '').replace(/\r?\n/g, ' ').replace(/\^(.)/g, '$1');
  const out = [];
  let cur = '', inTok = false, inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '"') { cur += '"'; i++; inTok = true; continue; }
    if (c === '"') { inQ = !inQ; inTok = true; continue; }
    if (!inQ && /\s/.test(c)) { if (inTok) out.push(cur); cur = ''; inTok = false; continue; }
    cur += c; inTok = true;
  }
  if (inQ) throw new Error('Unterminated double quote.');
  if (inTok) out.push(cur);
  return out;
}

/** POSIX-ish shell word splitting: '…', "…", $'…', backslash escapes and line continuations. */
export function tokenize(text) {
  text = String(text).replace(/\r\n/g, '\n');
  if (isCmdStyle(text)) return tokenizeCmd(text);
  const out = [];
  let cur = '', inTok = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') { i++; continue; }  // continuation
      if (i + 1 < text.length) { cur += text[++i]; inTok = true; }
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote.');
      cur += text.slice(i + 1, end); i = end; inTok = true; continue;
    }
    if (c === '$' && text[i + 1] === "'") {
      i += 2; inTok = true;
      for (;; i++) {
        if (i >= text.length) throw new Error("Unterminated $'…' string.");
        const d = text[i];
        if (d === "'") break;
        if (d !== '\\') { cur += d; continue; }
        const e = text[++i];
        if (e in ANSI) cur += ANSI[e];
        else if (e === 'x') { const m = text.slice(i + 1).match(/^[0-9a-fA-F]{1,2}/); cur += String.fromCharCode(parseInt(m ? m[0] : '0', 16)); i += m ? m[0].length : 0; }
        else if (e === 'u' || e === 'U') { const m = text.slice(i + 1).match(e === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/); if (m) { cur += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; } else cur += '\\' + e; }
        else if (/[0-7]/.test(e)) { const m = text.slice(i).match(/^[0-7]{1,3}/); cur += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length - 1; }
        else if (e === 'c') { cur += String.fromCharCode(text[++i].charCodeAt(0) & 31); }
        else cur += '\\' + (e ?? '');
      }
      continue;
    }
    if (c === '"') {
      i++; inTok = true;
      for (;; i++) {
        if (i >= text.length) throw new Error('Unterminated double quote.');
        const d = text[i];
        if (d === '"') break;
        if (d === '\\' && '"\\$`\n'.includes(text[i + 1])) { if (text[i + 1] !== '\n') cur += text[i + 1]; i++; continue; }
        cur += d;
      }
      continue;
    }
    if (/\s/.test(c)) { if (inTok) out.push(cur); cur = ''; inTok = false; continue; }
    if ((c === '#' && !inTok)) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }  // comment
    cur += c; inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ curl parser */
// option → [canonical, takesValue]
const LONG = {
  '--request': ['X', 1], '--header': ['H', 1], '--data': ['d', 1], '--data-ascii': ['d', 1], '--data-raw': ['data-raw', 1],
  '--data-binary': ['data-binary', 1], '--data-urlencode': ['data-urlencode', 1], '--json': ['json', 1], '--form': ['F', 1],
  '--form-string': ['form-string', 1], '--user': ['u', 1], '--cookie': ['b', 1], '--user-agent': ['A', 1], '--referer': ['e', 1],
  '--location': ['L', 0], '--location-trusted': ['L', 0], '--insecure': ['k', 0], '--compressed': ['compressed', 0], '--get': ['G', 0],
  '--url': ['url', 1], '--head': ['I', 0],
};
const SHORT = { X: 1, H: 1, d: 1, F: 1, u: 1, b: 1, A: 1, e: 1, L: 0, k: 0, G: 0, I: 0 };
// recognised but irrelevant to the request itself → noted, not converted
const IGNORED_LONG = {
  '--silent': 0, '--show-error': 0, '--verbose': 0, '--include': 0, '--progress-bar': 0, '--no-progress-meter': 0, '--fail': 0,
  '--fail-with-body': 0, '--http1.1': 0, '--http2': 0, '--http2-prior-knowledge': 0, '--http3': 0, '--globoff': 0, '--no-buffer': 0,
  '--output': 1, '--write-out': 1, '--max-time': 1, '--connect-timeout': 1, '--retry': 1, '--remote-name': 0, '--path-as-is': 0,
  '--tlsv1.2': 0, '--tlsv1.3': 0, '--ipv4': 0, '--ipv6': 0, '--trace-ascii': 1, '--dump-header': 1, '--cookie-jar': 1,
};
const IGNORED_SHORT = { s: 0, S: 0, v: 0, i: 0, f: 0, '#': 0, g: 0, N: 0, o: 1, w: 1, m: 1, O: 0, '4': 0, '6': 0, D: 1, c: 1 };

/**
 * Parse a curl command → request object:
 * {url, method, headers:[[k,v]], body:null|string, bodyKind:'none'|'raw'|'json'|'urlencoded'|'form', form:[{name,value,file,type?}],
 *  auth:null|{user,pass}, cookies:string|null, insecure, follow, compressed, warnings:[], notes:[], files:[]}
 */
export function parseCurl(text) {
  const src = String(text).trim();
  if (!src) throw new Error('Paste a curl command.');
  const argv = tokenize(src);
  if (!argv.length || !/^curl(\.exe)?$/i.test(argv[0].replace(/^.*[\\/]/, ''))) throw new Error('The command must start with curl.');
  const r = { url: null, method: null, headers: [], data: [], form: [], auth: null, cookies: null, insecure: false, follow: false,
    compressed: false, get: false, head: false, json: false, warnings: [], notes: [], files: [], urls: [] };
  const addData = (kind, v) => {
    if (kind === 'json') r.json = true;
    let value = v, file = null;
    if (kind === 'data-urlencode') {
      const m = v.match(/^([^=@]*)([=@])(.*)$/s);
      if (!m) value = encodeURIComponent(v);
      else if (m[2] === '=') value = (m[1] ? `${m[1]}=` : '') + encodeURIComponent(m[3]);
      else { file = m[3]; value = (m[1] ? `${m[1]}=` : '') + `<urlencoded contents of ${m[3]}>`; }
    } else if (kind !== 'data-raw' && v.startsWith('@')) {
      file = v.slice(1); value = `<contents of ${file}>`;
    }
    if (file) { r.files.push(file); r.notes.push(`Body is read from the file "${file}" — a placeholder is used in the converted code.`); }
    r.data.push({ value, file, kind });
  };
  const apply = (opt, val) => {
    switch (opt) {
      case 'X': r.method = val.toUpperCase(); break;
      case 'H': {
        const i = val.indexOf(':');
        if (i < 0) {
          if (val.endsWith(';')) r.headers.push([val.slice(0, -1).trim(), '']);
          else r.warnings.push(`Header "${val}" has no colon — skipped.`);
        } else if (val.slice(i + 1).trim() === '' && !val.endsWith(';')) {
          r.notes.push(`-H "${val}" removes the default "${val.slice(0, i).trim()}" header in curl — ignored.`);
        } else r.headers.push([val.slice(0, i).trim(), val.slice(i + 1).trim()]);
        break;
      }
      case 'd': case 'data-raw': case 'data-binary': case 'data-urlencode': case 'json': addData(opt, val); break;
      case 'F': case 'form-string': {
        const eq = val.indexOf('=');
        if (eq < 0) { r.warnings.push(`Form field "${val}" has no "=" — skipped.`); break; }
        const name = val.slice(0, eq); let v = val.slice(eq + 1);
        const field = { name, value: v, file: null, type: null };
        if (opt === 'F' && (v.startsWith('@') || v.startsWith('<'))) {
          const parts = v.slice(1).split(';');
          field.file = parts[0]; field.value = null; field.asText = v.startsWith('<');
          for (const p of parts.slice(1)) { const [k, x] = p.split('='); if (k.trim() === 'type') field.type = x; if (k.trim() === 'filename') field.filename = x; }
          r.files.push(field.file);
        } else if (opt === 'F') {
          const m = v.match(/^(.*?);type=(.+)$/); if (m) { field.value = m[1]; field.type = m[2]; }
        }
        r.form.push(field); break;
      }
      case 'u': { const i = val.indexOf(':'); r.auth = i < 0 ? { user: val, pass: '' } : { user: val.slice(0, i), pass: val.slice(i + 1) }; if (i < 0) r.notes.push('-u without a password: curl would prompt for it; an empty password is used.'); break; }
      case 'b':
        if (val.includes('=')) r.cookies = r.cookies ? `${r.cookies}; ${val}` : val;
        else r.warnings.push(`-b "${val}" reads cookies from a file — not converted.`);
        break;
      case 'A': r.headers.push(['User-Agent', val]); break;
      case 'e': r.headers.push(['Referer', val.replace(/;auto$/, '')]); break;
      case 'L': r.follow = true; break;
      case 'k': r.insecure = true; break;
      case 'compressed': r.compressed = true; break;
      case 'G': r.get = true; break;
      case 'I': r.head = true; break;
      case 'url': r.urls.push(val); break;
      default: break;
    }
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value.`); return argv[++i]; };
    if (a === '--') { r.urls.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [flag, inline] = a.includes('=') && !(a in LONG) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      if (flag in LONG) { const [canon, takes] = LONG[flag]; apply(canon, takes ? (inline ?? need(flag)) : ''); continue; }
      if (flag.startsWith('--no-') && (`--${flag.slice(5)}` in LONG)) { r.notes.push(`${flag} ignored.`); continue; }
      if (flag in IGNORED_LONG) { if (IGNORED_LONG[flag] && inline === undefined) need(flag); r.notes.push(`${flag} does not affect the request — not converted.`); continue; }
      r.warnings.push(`Unknown option ${a} — not converted.`);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // combined short flags: -sSL, -XPOST, -HFoo:bar
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f in SHORT) {
          if (SHORT[f]) { const rest = a.slice(j + 1); apply(f, rest || need(`-${f}`)); break; }
          apply(f, ''); continue;
        }
        if (f in IGNORED_SHORT) {
          if (IGNORED_SHORT[f]) { if (!a.slice(j + 1)) need(`-${f}`); r.notes.push(`-${f} does not affect the request — not converted.`); break; }
          r.notes.push(`-${f} does not affect the request — not converted.`); continue;
        }
        r.warnings.push(`Unknown option -${f}${a.length > 2 ? ` (in ${a})` : ''} — not converted.`);
        if (j === 1 && a.length > 2 && !/^[a-zA-Z#]+$/.test(a.slice(1))) break;
      }
      continue;
    }
    r.urls.push(a);
  }

  if (!r.urls.length) throw new Error('No URL found in the command.');
  if (r.urls.length > 1) r.warnings.push(`Several URLs given (${r.urls.length}) — only the first is converted.`);
  let url = r.urls[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { url = `http://${url}`; r.notes.push('No scheme in the URL — curl assumes http://.'); }

  // body
  let body = null, bodyKind = 'none';
  if (r.form.length && r.data.length) r.warnings.push('Both -F and -d given — curl refuses this; only the form is converted.');
  if (r.form.length) bodyKind = 'form';
  else if (r.data.length) {
    body = r.data.map((d) => d.value).join('&');
    if (r.data.some((d) => d.kind === 'json')) body = r.data.map((d) => d.value).join('');
    bodyKind = 'raw';
  }
  if (r.json) {
    if (!hasHeader(r.headers, 'content-type')) r.headers.push(['Content-Type', 'application/json']);
    if (!hasHeader(r.headers, 'accept')) r.headers.push(['Accept', 'application/json']);
  }
  let method = r.method;
  if (r.get && body !== null) {
    url += (url.includes('?') ? '&' : '?') + body; body = null; bodyKind = 'none';
  }
  if (!method) method = r.head ? 'HEAD' : r.get ? 'GET' : (body !== null || bodyKind === 'form') ? 'POST' : 'GET';
  if (body !== null && bodyKind === 'raw') {
    const ct = headerValue(r.headers, 'content-type');
    if (/json/i.test(ct || '') || r.json) {
      try { JSON.parse(body); bodyKind = 'json'; } catch { r.notes.push('Content-Type is JSON but the body is not valid JSON — sent as a raw string.'); }
    } else if (!ct && r.data.every((d) => d.kind !== 'data-binary')) {
      bodyKind = 'urlencoded';
      r.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
      r.notes.push('-d without a Content-Type: curl sends application/x-www-form-urlencoded, made explicit here.');
    } else if (/x-www-form-urlencoded/i.test(ct || '')) bodyKind = 'urlencoded';
  }
  if (r.compressed && !hasHeader(r.headers, 'accept-encoding')) r.notes.push('--compressed: curl asks for gzip/deflate/br and decompresses; the converted clients do that by default (except fetch outside browsers may vary).');
  if (r.head && method !== 'HEAD') r.warnings.push('-I with another method: curl only fetches headers.');

  return {
    url, method, headers: r.headers, body, bodyKind, form: r.form, auth: r.auth, cookies: r.cookies, insecure: r.insecure,
    follow: r.follow, compressed: r.compressed, warnings: r.warnings, notes: [...new Set(r.notes)], files: r.files,
  };
}

const hasHeader = (hs, n) => hs.some(([k]) => k.toLowerCase() === n);
const headerValue = (hs, n) => (hs.find(([k]) => k.toLowerCase() === n) || [])[1];

/* ------------------------------------------------------------------ secrets */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$|token|secret|api[-_]?key|session/i;
export const isSecretHeader = (name) => SECRET_HEADER.test(name);

/** Names of the secret-looking parts of a request (for the warning). */
export function secretsIn(req) {
  const s = req.headers.filter(([k]) => isSecretHeader(k)).map(([k]) => k);
  if (req.cookies) s.push('Cookie (-b)');
  if (req.auth) s.push('user:password (-u)');
  if (/[?&](access_token|token|api_key|apikey|key|sig|signature|password)=/i.test(req.url)) s.push('token in URL query');
  return [...new Set(s)];
}

const redactCookie = (v) => v.split(';').map((p) => { const i = p.indexOf('='); return i < 0 ? p : `${p.slice(0, i)}=<REDACTED>`; }).join(';');

/** Copy of req with secret header/cookie/auth values replaced by placeholders. */
export function redact(req) {
  const headers = req.headers.map(([k, v]) => {
    if (!isSecretHeader(k)) return [k, v];
    if (/cookie/i.test(k)) return [k, redactCookie(v)];
    const m = v.match(/^(Bearer|Basic|Token|Digest|AWS4-HMAC-SHA256|Bot|ApiKey)\s+/i);
    return [k, m ? `${m[1]} <REDACTED>` : '<REDACTED>'];
  });
  const url = req.url.replace(/([?&](?:access_token|token|api_key|apikey|key|sig|signature|password)=)[^&#]*/gi, '$1<REDACTED>');
  return { ...req, url, headers, cookies: req.cookies ? redactCookie(req.cookies) : null, auth: req.auth ? { user: req.auth.user, pass: '<PASSWORD>' } : null };
}

/* ------------------------------------------------------------------ literals */
const js = (s) => JSON.stringify(s);
const py = (s) => JSON.stringify(s);  // JSON string literals are valid Python string literals (\uXXXX escapes included)

/** JSON value → Python literal (True/False/None), pretty-printed. */
export function pyLiteral(v, ind = 0) {
  const pad = '    '.repeat(ind + 1), end = '    '.repeat(ind);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return py(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + pyLiteral(x, ind + 1)).join(',\n')},\n${end}]` : '[]';
  const ks = Object.keys(v);
  return ks.length ? `{\n${ks.map((k) => `${pad}${py(k)}: ${pyLiteral(v[k], ind + 1)}`).join(',\n')},\n${end}}` : '{}';
}

const indentJson = (v, ind) => JSON.stringify(v, null, 2).replace(/\n/g, `\n${' '.repeat(ind)}`);

/** Shell single-quoting (leaves safe words bare). */
export function shq(s) {
  s = String(s);
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const parseUrlencoded = (body) => body.split('&').filter(Boolean).map((p) => {
  const i = p.indexOf('=');
  const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
  return i < 0 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))];
});

/** Cookie string → [[name, value]] */
const parseCookies = (s) => s.split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; });

/* ------------------------------------------------------------------ generators */
export function toFetch(req) {
  const headers = req.headers.map(([k, v]) => [k, v]);
  if (req.auth) headers.push(['Authorization', req.auth.pass === '<PASSWORD>' ? 'Basic <REDACTED>' : `Basic ${utf8Base64(`${req.auth.user}:${req.auth.pass}`)}`]);
  if (req.cookies) headers.push(['Cookie', req.cookies]);
  const lines = [];
  let pre = '';
  if (req.bodyKind === 'form') {
    pre = 'const form = new FormData();\n' + req.form.map((f) => f.file
      ? `form.append(${js(f.name)}, fileInput.files[0]); // file: ${f.file}\n`
      : `form.append(${js(f.name)}, ${js(f.value)});\n`).join('') + '\n';
  }
  lines.push(`  method: ${js(req.method)},`);
  const hs = headers.filter(([k]) => !(req.bodyKind === 'form' && k.toLowerCase() === 'content-type'));
  if (hs.length) lines.push(`  headers: {\n${hs.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },`);
  if (req.bodyKind === 'json') lines.push(`  body: JSON.stringify(${indentJson(JSON.parse(req.body), 2)}),`);
  else if (req.bodyKind === 'form') lines.push('  body: form,');
  else if (req.body !== null) lines.push(`  body: ${js(req.body)},`);
  const notes = [];
  if (req.cookies || hs.some(([k]) => /^cookie$/i.test(k))) notes.push('// Note: browsers do not let fetch() set Cookie; use credentials: "include" there.');
  if (req.insecure) notes.push('// Note: -k (skip TLS verification) has no fetch() equivalent; in Node set NODE_TLS_REJECT_UNAUTHORIZED=0 for testing only.');
  if (!req.follow) notes.push('// Note: fetch follows redirects by default; curl without -L does not (redirect: "manual" to match).');
  return `${notes.length ? notes.join('\n') + '\n' : ''}${pre}const response = await fetch(${js(req.url)}, {\n${lines.join('\n')}\n});\nconsole.log(response.status, await response.text());\n`;
}

function pyCommon(req, lib) {
  const out = [`import ${lib}`, ''];
  const args = [];
  out.push(`url = ${py(req.url)}`);
  const headers = req.headers.filter(([k]) => !(req.bodyKind === 'form' && k.toLowerCase() === 'content-type'));
  if (headers.length) { out.push(`headers = {\n${headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`).join('\n')}\n}`); args.push('headers=headers'); }
  if (req.cookies) { out.push(`cookies = {\n${parseCookies(req.cookies).map(([k, v]) => `    ${py(k)}: ${py(v)},`).join('\n')}\n}`); args.push('cookies=cookies'); }
  if (req.bodyKind === 'json') { out.push(`json_data = ${pyLiteral(JSON.parse(req.body))}`); args.push('json=json_data'); }
  else if (req.bodyKind === 'urlencoded' && !req.body.includes('<')) {
    out.push(`data = {\n${parseUrlencoded(req.body).map(([k, v]) => `    ${py(k)}: ${py(v)},`).join('\n')}\n}`); args.push('data=data');
  } else if (req.bodyKind === 'form') {
    const files = req.form.filter((f) => f.file), fields = req.form.filter((f) => !f.file);
    if (files.length) { out.push(`files = {\n${files.map((f) => `    ${py(f.name)}: open(${py(f.file)}, "rb"),`).join('\n')}\n}`); args.push('files=files'); }
    if (fields.length) {
      out.push(`data = {\n${fields.map((f) => `    ${py(f.name)}: ${py(f.value)},`).join('\n')}\n}`); args.push('data=data');
      if (!files.length) {  // force multipart like curl -F
        out.pop(); out.push(`files = {\n${fields.map((f) => `    ${py(f.name)}: (None, ${py(f.value)}),`).join('\n')}\n}`); args.pop(); args.push('files=files');
      }
    }
  } else if (req.body !== null) { out.push(`data = ${py(req.body)}`); args.push(lib === 'httpx' ? 'content=data' : 'data=data'); }
  if (req.auth) args.push(`auth=(${py(req.auth.user)}, ${py(req.auth.pass)})`);
  if (req.insecure) args.push('verify=False');
  return { out, args };
}

export function toRequests(req) {
  const { out, args } = pyCommon(req, 'requests');
  if (!req.follow && req.method !== 'HEAD') args.push('allow_redirects=False');
  const m = req.method.toLowerCase();
  const call = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)
    ? `requests.${m}(url${args.map((a) => `, ${a}`).join('')})` : `requests.request(${py(req.method)}, url${args.map((a) => `, ${a}`).join('')})`;
  return `${out.join('\n')}\n\nresponse = ${call}\nprint(response.status_code)\nprint(response.text)\n`;
}

export function toHttpx(req) {
  const { out, args } = pyCommon(req, 'httpx');
  if (req.follow) args.push('follow_redirects=True');
  return `${out.join('\n')}\n\nresponse = httpx.request(${py(req.method)}, url${args.map((a) => `, ${a}`).join('')})\nprint(response.status_code)\nprint(response.text)\n`;
}

export function toAxios(req) {
  const imports = ['import axios from "axios";'];
  const pre = [];
  const cfg = [`  method: ${js(req.method.toLowerCase())},`, `  url: ${js(req.url)},`];
  const headers = req.headers.filter(([k]) => !(req.bodyKind === 'form' && k.toLowerCase() === 'content-type'));
  if (req.cookies) headers.push(['Cookie', req.cookies]);
  if (headers.length) cfg.push(`  headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },`);
  if (req.bodyKind === 'json') cfg.push(`  data: ${indentJson(JSON.parse(req.body), 2)},`);
  else if (req.bodyKind === 'form') {
    if (req.form.some((f) => f.file)) imports.push('import fs from "node:fs";');
    pre.push('const form = new FormData();');
    for (const f of req.form) pre.push(f.file ? `form.append(${js(f.name)}, new Blob([fs.readFileSync(${js(f.file)})]), ${js(f.filename || f.file.replace(/^.*[\\/]/, ''))});` : `form.append(${js(f.name)}, ${js(f.value)});`);
    cfg.push('  data: form,');
  } else if (req.body !== null) cfg.push(`  data: ${js(req.body)},`);
  if (req.auth) cfg.push(`  auth: { username: ${js(req.auth.user)}, password: ${js(req.auth.pass)} },`);
  if (!req.follow) cfg.push('  maxRedirects: 0,');
  if (req.insecure) { imports.push('import https from "node:https";'); cfg.push('  httpsAgent: new https.Agent({ rejectUnauthorized: false }),'); }
  cfg.push('  validateStatus: () => true,');
  return `${imports.join('\n')}\n\n${pre.length ? pre.join('\n') + '\n\n' : ''}const response = await axios({\n${cfg.join('\n')}\n});\nconsole.log(response.status, response.data);\n`;
}

export function toHttpie(req) {
  const parts = ['http'];
  if (req.insecure) parts.push('--verify=no');
  if (req.follow) parts.push('--follow');
  if (req.auth) parts.push('-a', shq(`${req.auth.user}:${req.auth.pass}`));
  const hdrs = [], items = [];
  let raw = null;
  if (req.bodyKind === 'form') {
    parts.push('--multipart');
    for (const f of req.form) items.push(shq(f.file ? `${f.name}@${f.file}` : `${f.name}=${f.value}`));
  } else if (req.bodyKind === 'urlencoded' && !req.body.includes('<')) {
    parts.push('--form');
    for (const [k, v] of parseUrlencoded(req.body)) items.push(shq(`${k}=${v}`));
  } else if (req.body !== null) raw = req.body;
  if (raw !== null) parts.push('--raw', shq(raw));
  parts.push(req.method, shq(req.url));
  for (const [k, v] of req.headers) {
    if (req.bodyKind === 'form' && k.toLowerCase() === 'content-type') continue;
    hdrs.push(shq(v === '' ? `${k};` : `${k}:${v}`));
  }
  if (req.cookies) hdrs.push(shq(`Cookie:${req.cookies}`));
  const rest = [...hdrs, ...items];
  return `${parts.join(' ')}${rest.length ? ` \\\n  ${rest.join(' \\\n  ')}` : ''}\n`;
}

export function toCurl(req) {
  const parts = [`curl -X ${req.method} ${shq(req.url)}`];
  for (const [k, v] of req.headers) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (req.cookies) parts.push(`-b ${shq(req.cookies)}`);
  if (req.auth) parts.push(`-u ${shq(`${req.auth.user}:${req.auth.pass}`)}`);
  if (req.bodyKind === 'form') for (const f of req.form) parts.push(`-F ${shq(f.file ? `${f.name}=@${f.file}${f.type ? `;type=${f.type}` : ''}` : `${f.name}=${f.value}`)}`);
  else if (req.body !== null) parts.push(`--data-raw ${shq(req.body)}`);
  const flags = [req.follow && '-L', req.insecure && '-k', req.compressed && '--compressed'].filter(Boolean);
  if (flags.length) parts.push(flags.join(' '));
  return `${parts.join(' \\\n  ')}\n`;
}

export const TARGETS = [
  ['fetch', 'JavaScript fetch', toFetch], ['requests', 'Python requests', toRequests], ['httpx', 'Python httpx', toHttpx],
  ['axios', 'Node axios', toAxios], ['httpie', 'HTTPie', toHttpie], ['curl', 'curl (normalized)', toCurl],
];

/** Convert in one go: {req, outputs:{key: code}, secrets, warnings, notes} */
export function convertCurl(text, { redactSecrets = false } = {}) {
  const parsed = parseCurl(text);
  const req = redactSecrets ? redact(parsed) : parsed;
  const outputs = Object.fromEntries(TARGETS.map(([k, , fn]) => [k, fn(req)]));
  return { req: parsed, outputs, secrets: secretsIn(parsed), warnings: parsed.warnings, notes: parsed.notes };
}

/* ------------------------------------------------------------------ fetch(...) → curl */
/** Tiny JS literal parser for fetch() arguments: strings, template strings without ${}, numbers, booleans, null, objects, arrays, JSON.stringify(literal). */
function literalParser(src) {
  let i = 0;
  const ws = () => { for (;;) { while (/\s/.test(src[i] || '')) i++; if (src.startsWith('//', i)) { i = src.indexOf('\n', i); if (i < 0) i = src.length; } else if (src.startsWith('/*', i)) { i = src.indexOf('*/', i) + 2; if (i < 2) i = src.length; } else return; } };
  const fail = (what) => { throw new Error(`${what} at position ${i}: "${src.slice(i, i + 25)}"`); };
  function str() {
    const q = src[i++];
    let s = '';
    for (;;) {
      if (i >= src.length) fail('Unterminated string');
      const c = src[i++];
      if (c === q) return s;
      if (q === '`' && c === '$' && src[i] === '{') fail('Template expressions ${…} are not supported');
      if (c !== '\\') { s += c; continue; }
      const e = src[i++];
      if (e === 'u') { if (src[i] === '{') { const end = src.indexOf('}', i); s += String.fromCodePoint(parseInt(src.slice(i + 1, end), 16)); i = end + 1; } else { s += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; } }
      else if (e === 'x') { s += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; }
      else if (e === '\n') { /* line continuation */ }
      else s += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
    }
  }
  function value() {
    ws();
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') return str();
    if (c === '{') {
      i++; const o = {};
      for (;;) {
        ws(); if (src[i] === '}') { i++; return o; }
        let k;
        if (src[i] === '"' || src[i] === "'" || src[i] === '`') k = str();
        else { const m = src.slice(i).match(/^[A-Za-z_$][\w$]*/); if (!m) fail('Expected a key'); k = m[0]; i += k.length; }
        ws();
        if (src[i] !== ':') { if (src[i] === ',' || src[i] === '}') fail(`Shorthand property "${k}" is not supported`); fail('Expected ":"'); }
        i++; o[k] = value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return o; }
        fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      i++; const a = [];
      for (;;) {
        ws(); if (src[i] === ']') { i++; return a; }
        a.push(value()); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return a; }
        fail('Expected "," or "]"');
      }
    }
    const num = src.slice(i).match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
    if (num) { i += num[0].length; return Number(num[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null], ['undefined', undefined]]) if (src.startsWith(w, i) && !/[\w$]/.test(src[i + w.length] || '')) { i += w.length; return v; }
    if (src.startsWith('JSON.stringify', i)) {
      i += 'JSON.stringify'.length; ws(); if (src[i] !== '(') fail('Expected "("'); i++;
      const v = value(); ws(); if (src[i] !== ')') fail('JSON.stringify with more than one argument is not supported'); i++;
      return { __json: JSON.stringify(v) };
    }
    fail('Only literal values are supported (no variables)');
  }
  return { value, ws, get pos() { return i; }, set pos(v) { i = v; }, src };
}

/** Parse fetch("url", {...}) → curl command string (+ notes). */
export function fetchToCurl(text) {
  const src = String(text);
  const at = src.search(/\bfetch\s*\(/);
  if (at < 0) throw new Error('No fetch( … ) call found.');
  const p = literalParser(src);
  p.pos = src.indexOf('(', at) + 1;
  const url = p.value();
  if (typeof url !== 'string') throw new Error('The first fetch() argument must be a URL string.');
  p.ws();
  let opts = {};
  if (src[p.pos] === ',') { p.pos += 1; p.ws(); if (src[p.pos] !== ')') opts = p.value() || {}; }
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new Error('The second fetch() argument must be an object literal.');
  const notes = [];
  const headers = [];
  const hs = opts.headers || {};
  if (Array.isArray(hs)) for (const [k, v] of hs) headers.push([k, String(v)]);
  else for (const [k, v] of Object.entries(hs)) headers.push([k, String(v)]);
  let body = null;
  if (opts.body && typeof opts.body === 'object' && '__json' in opts.body) {
    body = opts.body.__json;
    if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) notes.push('Body is JSON but no Content-Type header is set (fetch sends text/plain).');
  } else if (opts.body !== null && opts.body !== undefined) {
    if (typeof opts.body === 'object') throw new Error('body must be a string or JSON.stringify(…).');
    body = String(opts.body);
  }
  if (opts.referrer && opts.referrer !== 'about:client') headers.push(['Referer', opts.referrer]);
  const method = (opts.method || (body !== null ? 'POST' : 'GET')).toUpperCase();
  for (const k of Object.keys(opts)) {
    if (!['method', 'headers', 'body', 'referrer'].includes(k)) notes.push(`fetch option "${k}: ${JSON.stringify(opts[k])}" has no curl equivalent — ignored.`);
  }
  const req = { url, method, headers, body, bodyKind: body === null ? 'none' : 'raw', form: [], auth: null, cookies: null, insecure: false,
    follow: opts.redirect !== 'manual' && opts.redirect !== 'error', compressed: false };
  return { curl: toCurl(req), notes, req };
}
