// Pure logic for the 🧾 .env converter (no DOM): parse .env / shell exports / JSON / docker -e flags /
// docker-compose environment / Kubernetes env, analyse the result and write any of the output formats.

export const INPUT_FORMATS = [
  ['auto', 'Auto-detect'], ['dotenv', '.env'], ['shell', 'export lines'], ['json', 'JSON'],
  ['docker', 'docker -e flags'], ['compose', 'docker-compose'], ['k8s', 'Kubernetes env'],
];
export const OUTPUT_FORMATS = [
  ['dotenv', '.env'], ['shell', 'export'], ['json', 'JSON'], ['docker', 'docker -e'],
  ['compose', 'compose'], ['k8s', 'k8s env'], ['github', 'GitHub Actions'],
];

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_RE = /PASSWORD|PASSWD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL/i;
export const isSecretKey = (k) => SECRET_RE.test(k);
export const isValidKey = (k) => KEY_RE.test(k);

/* ------------------------------------------------------------------ detection */
export function detectFormat(text) {
  const t = String(text || '').trim();
  if (!t) return 'dotenv';
  if (/^[{[]/.test(t)) return 'json';
  if (/(^|\s)(docker|podman)\s+(run|create|exec)\b/.test(t) || /(^|\s)(-e|--env)(\s+|=)['"]?[A-Za-z_]/.test(t) || /(^|\s)--env-file[\s=]/.test(t)) return 'docker';
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.some((l) => /^-\s*name\s*:/.test(l))) return 'k8s';
  if (lines.some((l) => /^environment\s*:\s*$/.test(l))) return 'compose';
  if (lines.length && lines.every((l) => /^-\s+/.test(l) || /^[\w.-]+\s*:\s*$/.test(l))) return 'compose';
  const exports = lines.filter((l) => /^export\s+/.test(l)).length;
  if (exports && exports >= lines.length / 2) return 'shell';
  const yamlish = lines.filter((l) => /^[A-Za-z_][\w.-]*\s*:(\s|$)/.test(l) && !/^[A-Za-z_][\w.]*\s*=/.test(l)).length;
  const envish = lines.filter((l) => /^(export\s+)?[^=\s]+\s*=/.test(l)).length;
  if (yamlish > envish) return 'compose';
  return 'dotenv';
}

/* ------------------------------------------------------------------ parsers */
// each parser returns {entries: [{key, value, line}], issues: [{line, kind, message, key?}]}

const DQ_ESC = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$', '`': '`', "'": "'" };

/** .env: KEY=VALUE, # comments, export prefix, '…' literal, "…" with escapes and multiple lines. */
export function parseDotenv(text) {
  const entries = [], issues = [];
  const src = String(text).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i].replace(/^\uFEFF/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    line = line.replace(/^\s*export\s+/, '');
    const eq = line.indexOf('=');
    if (eq < 0) {
      const name = line.trim().split(/\s/)[0];
      issues.push({ line: lineNo, kind: 'err', message: `Line ${lineNo}: no "=" — ${KEY_RE.test(name) ? `"${name}" has no value` : 'not a KEY=VALUE line'}; skipped.` });
      continue;
    }
    const key = line.slice(0, eq).trim();
    let rest = line.slice(eq + 1).replace(/^[ \t]+/, '');
    let value;
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let buf = '', j = 1, closed = false, startLine = i;
      for (;;) {
        if (j >= rest.length) {
          if (i + 1 >= lines.length) break;
          buf += '\n'; i++; rest = lines[i]; j = 0; continue;
        }
        const c = rest[j];
        if (c === q) { closed = true; j++; break; }
        if (q === '"' && c === '\\' && j + 1 < rest.length) { const n = rest[j + 1]; buf += n in DQ_ESC ? DQ_ESC[n] : `\\${n}`; j += 2; continue; }
        buf += c; j++;
      }
      if (!closed) {
        issues.push({ line: startLine + 1, kind: 'err', key, message: `Line ${startLine + 1}: ${key} has an unclosed ${q} quote; read to the end of the input.` });
      } else {
        const tail = rest.slice(j).trim();
        if (tail && !tail.startsWith('#')) issues.push({ line: i + 1, kind: 'warn', key, message: `Line ${i + 1}: text after the closing quote of ${key} ignored ("${tail.slice(0, 20)}").` });
      }
      value = buf;
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
      if (/\s/.test(value)) issues.push({ line: lineNo, kind: 'warn', key, message: `Line ${lineNo}: ${key} has spaces in an unquoted value — quote it ("…") so every tool reads it the same.` });
    }
    entries.push({ key, value, line: lineNo });
  }
  return { entries, issues };
}

/** Split shell words (handles '…', "…" with \ escapes, \x, line continuations). Returns [{word, line}]. */
export function shellWords(text) {
  const words = [];
  const s = String(text).replace(/\r\n?/g, '\n');
  let i = 0, line = 1;
  while (i < s.length) {
    while (i < s.length && /[ \t]/.test(s[i])) i++;
    if (s[i] === '\\' && s[i + 1] === '\n') { i += 2; line++; continue; }
    if (s[i] === '\n') { words.push({ word: '\n', line, sep: true }); i++; line++; continue; }
    if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (i >= s.length) break;
    let w = '', startLine = line, quotedAny = false;
    while (i < s.length && !/[ \t\n]/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new Error(`Line ${line}: unclosed ' quote`);
        w += s.slice(i + 1, end); line += (s.slice(i + 1, end).match(/\n/g) || []).length; i = end + 1; quotedAny = true;
      } else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1])) { if (s[i + 1] !== '\n') w += s[i + 1]; else line++; i += 2; } else { if (s[i] === '\n') line++; w += s[i++]; }
        }
        if (i >= s.length) throw new Error(`Line ${startLine}: unclosed " quote`);
        i++; quotedAny = true;
      } else if (c === '\\') {
        if (s[i + 1] === '\n') { i += 2; line++; continue; }
        w += s[i + 1] ?? ''; i += 2;
      } else { w += c; i++; }
    }
    words.push({ word: w, line: startLine, quoted: quotedAny });
  }
  return words;
}

/** Shell export lines: export KEY='a'"b"; uses real shell word splitting. */
export function parseShell(text) {
  const entries = [], issues = [];
  let words;
  try { words = shellWords(text); } catch (e) { return { entries, issues: [{ line: 0, kind: 'err', message: e.message }] }; }
  for (const { word, line, sep } of words) {
    if (sep || word === 'export' || word === 'declare' || word === '-x') continue;
    const eq = word.indexOf('=');
    if (eq <= 0) { issues.push({ line, kind: 'warn', message: `Line ${line}: "${word.slice(0, 30)}" is not NAME=value; skipped.` }); continue; }
    entries.push({ key: word.slice(0, eq), value: word.slice(eq + 1), line });
  }
  return { entries, issues };
}

/** docker run -e K=V / --env K=V / --env=K=V / -eK=V; -e K (host value) and --env-file are reported. */
export function parseDocker(text) {
  const entries = [], issues = [];
  let words;
  try { words = shellWords(text).filter((w) => !w.sep); } catch (e) { return { entries, issues: [{ line: 0, kind: 'err', message: e.message }] }; }
  const take = (spec, line) => {
    const eq = spec.indexOf('=');
    if (eq < 0) {
      issues.push({ line, kind: 'warn', key: spec, message: `Line ${line}: -e ${spec} copies the value from the host environment; recorded as empty.` });
      entries.push({ key: spec, value: '', line, fromHost: true });
    } else entries.push({ key: spec.slice(0, eq), value: spec.slice(eq + 1), line });
  };
  for (let i = 0; i < words.length; i++) {
    const { word: w, line } = words[i];
    if (w === '-e' || w === '--env') { if (words[i + 1]) take(words[++i].word, line); else issues.push({ line, kind: 'err', message: `Line ${line}: ${w} without a value.` }); }
    else if (w.startsWith('--env=')) take(w.slice(6), line);
    else if (/^-e[^-]/.test(w)) take(w.slice(2), line);
    else if (w === '--env-file' || w.startsWith('--env-file=')) {
      const f = w === '--env-file' ? words[++i]?.word : w.slice(11);
      issues.push({ line, kind: 'warn', message: `Line ${line}: --env-file ${f || ''} — the file is not read here; paste its contents to include them.` });
    }
  }
  if (!entries.length && !issues.length) issues.push({ line: 0, kind: 'warn', message: 'No -e / --env flags found.' });
  return { entries, issues };
}

/** YAML scalar (one line): "double" (JSON-ish escapes), 'single' ('' escape), or plain (strip # comments). */
export function yamlScalar(s) {
  const t = s.trim();
  if (t.startsWith('"')) {
    const m = t.match(/^"((?:[^"\\]|\\.)*)"/);
    if (!m) throw new Error('unclosed " quote');
    return m[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e) => (e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16))
      : { n: '\n', t: '\t', r: '\r', 0: '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' }[e] ?? e));
  }
  if (t.startsWith("'")) {
    const m = t.match(/^'((?:[^']|'')*)'/);
    if (!m) throw new Error("unclosed ' quote");
    return m[1].replace(/''/g, "'");
  }
  const v = t.replace(/(^|\s)#.*$/, '').trim();
  return v === '~' || v === 'null' ? '' : v;
}

/** docker-compose `environment:` as a list (- KEY=value) or a map (KEY: value); other keys are ignored. */
export function parseCompose(text) {
  const entries = [], issues = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const header = lines.findIndex((l) => /^\s*environment\s*:\s*$/.test(l));
  const baseIndent = header >= 0 ? lines[header].match(/^\s*/)[0].length : -1;
  for (let i = header + 1; i < lines.length; i++) {
    const raw = lines[i], lineNo = i + 1;
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (header >= 0 && indent <= baseIndent) break;  // left the environment: block
    const t = raw.trim();
    try {
      if (t.startsWith('-')) {
        const item = yamlScalar(t.slice(1));
        const eq = item.indexOf('=');
        if (eq < 0) { entries.push({ key: item, value: '', line: lineNo, fromHost: true }); issues.push({ line: lineNo, kind: 'warn', key: item, message: `Line ${lineNo}: ${item} has no value (taken from the shell by compose); recorded as empty.` }); } else entries.push({ key: item.slice(0, eq).trim(), value: item.slice(eq + 1), line: lineNo });
      } else {
        const m = t.match(/^(["']?)([^:"']+)\1\s*:(?:\s+(.*))?$/);
        if (!m) { issues.push({ line: lineNo, kind: 'warn', message: `Line ${lineNo}: not "KEY: value" or "- KEY=value"; skipped.` }); continue; }
        const value = m[3] === undefined ? '' : yamlScalar(m[3]);
        if (m[3] === undefined) issues.push({ line: lineNo, kind: 'warn', key: m[2], message: `Line ${lineNo}: ${m[2]} has no value; recorded as empty.` });
        entries.push({ key: m[2].trim(), value, line: lineNo });
      }
    } catch (e) { issues.push({ line: lineNo, kind: 'err', message: `Line ${lineNo}: ${e.message}; skipped.` }); }
  }
  return { entries, issues };
}

/** Kubernetes env: [- name: X / value: "y"] (YAML-ish) — valueFrom refs are reported and skipped. */
export function parseK8s(text) {
  const entries = [], issues = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.name === undefined) issues.push({ line: cur.line, kind: 'warn', message: `Line ${cur.line}: list item without name; skipped.` });
    else if (cur.valueFrom) issues.push({ line: cur.line, kind: 'warn', key: cur.name, message: `Line ${cur.line}: ${cur.name} uses valueFrom (secret/configMap/field ref); skipped.` });
    else entries.push({ key: cur.name, value: cur.value ?? '', line: cur.line });
    cur = null;
  };
  let itemIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], lineNo = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#') || /^env\s*:\s*$/.test(t)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    let body = t;
    let keyIndent = indent;
    if (t.startsWith('- ') || t === '-') {
      if (itemIndent < 0) itemIndent = indent;
      if (indent === itemIndent) {
        flush();
        body = t.slice(1).trim();
        keyIndent = indent + (t.length - body.length);
        cur = { line: lineNo, keyIndent };
      }
    }
    if (!cur || !body || keyIndent !== cur.keyIndent) continue;  // nested keys (valueFrom.secretKeyRef.name…)
    const m = body.match(/^(name|value|valueFrom)\s*:(?:\s+(.*))?$/);
    if (!m) continue;
    try {
      if (m[1] === 'valueFrom') cur.valueFrom = true;
      else cur[m[1]] = m[2] === undefined ? '' : yamlScalar(m[2]);
    } catch (e) { issues.push({ line: lineNo, kind: 'err', message: `Line ${lineNo}: ${e.message}` }); }
  }
  flush();
  return { entries, issues };
}

/** JSON object {"KEY": "value"} or an array of {name, value} (k8s). */
export function parseJsonEnv(text) {
  const entries = [], issues = [];
  let data;
  try { data = JSON.parse(text); } catch (e) { return { entries, issues: [{ line: 0, kind: 'err', message: `Invalid JSON: ${e.message}` }] }; }
  const toStr = (k, v) => {
    if (v === null) return '';
    if (typeof v === 'object') { issues.push({ line: 0, kind: 'warn', key: k, message: `${k} is a nested ${Array.isArray(v) ? 'array' : 'object'}; written as JSON text.` }); return JSON.stringify(v); }
    return String(v);
  };
  if (Array.isArray(data)) {
    data.forEach((it, i) => {
      if (it && typeof it === 'object' && typeof it.name === 'string') {
        if (it.valueFrom) issues.push({ line: 0, kind: 'warn', key: it.name, message: `${it.name} uses valueFrom; skipped.` });
        else entries.push({ key: it.name, value: toStr(it.name, it.value ?? ''), line: 0 });
      } else issues.push({ line: 0, kind: 'warn', message: `Item ${i + 1} is not {name, value}; skipped.` });
    });
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) entries.push({ key: k, value: toStr(k, v), line: 0 });
  } else issues.push({ line: 0, kind: 'err', message: 'Expected a JSON object {"KEY": "value"} or an array of {name, value}.' });
  return { entries, issues };
}

const PARSERS = { dotenv: parseDotenv, shell: parseShell, docker: parseDocker, compose: parseCompose, k8s: parseK8s, json: parseJsonEnv };

/**
 * parseEnv(text, format='auto') → {format, vars: [{key, value, secret, line}] (last wins, first-seen order),
 *   issues: [{line, kind: 'err'|'warn'|'info', key?, message}], flags: {KEY: Set('dup'|'invalid'|'empty'|'spaces'|'secret')}}
 */
export function parseEnv(text, format = 'auto') {
  const fmt = format === 'auto' ? detectFormat(text) : format;
  const parser = PARSERS[fmt];
  if (!parser) throw new Error(`Unknown format "${format}"`);
  const { entries, issues } = parser(String(text ?? ''));
  const map = new Map();
  const flags = {};
  const flag = (k, f) => (flags[k] ||= new Set()).add(f);
  for (const e of entries) {
    if (map.has(e.key)) {
      flag(e.key, 'dup');
      issues.push({ line: e.line, kind: 'warn', key: e.key, message: `${e.key} is defined more than once${e.line ? ` (again on line ${e.line})` : ''}; the last value wins.` });
      map.delete(e.key);  // keep position of the winning (last) definition
    }
    map.set(e.key, e);
  }
  const vars = [...map.values()].map((e) => ({ key: e.key, value: e.value, line: e.line, secret: isSecretKey(e.key) }));
  for (const v of vars) {
    if (!KEY_RE.test(v.key)) { flag(v.key, 'invalid'); issues.push({ line: v.line, kind: 'err', key: v.key, message: `"${v.key}" is not a valid variable name (letters, digits, _; not starting with a digit).` }); }
    if (v.value === '') { flag(v.key, 'empty'); if (!issues.some((i) => i.key === v.key && /empty/.test(i.message))) issues.push({ line: v.line, kind: 'info', key: v.key, message: `${v.key} is empty.` }); }
    if (/\s/.test(v.value)) flag(v.key, 'spaces');
    if (v.secret) flag(v.key, 'secret');
  }
  return { format: fmt, vars, issues, flags };
}

/* ------------------------------------------------------------------ writers */
const SAFE_BARE = /^[A-Za-z0-9_.\/:@%+,=-]+$/;
export const mask = (v) => (v === '' ? '' : `•••(${[...v].length})`);

/** POSIX shell quoting: bare when safe, else '…' with ' → '\'' */
export const shellQuote = (v) => (v !== '' && SAFE_BARE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** .env value: bare / '…' (literal) / "…" with \\ \" \n escapes when it holds ' or a newline. */
export function dotenvQuote(v) {
  if (v === '') return '';
  if (SAFE_BARE.test(v) && !v.startsWith('#')) return v;
  if (!/['\n\r]/.test(v)) return `'${v}'`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\$/g, '\\$')}"`;
}

const YAML_SPECIAL = /^(true|false|yes|no|on|off|y|n|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i;
/** YAML scalar: plain when unambiguous text, otherwise a JSON (= YAML double-quoted) string. */
export function yamlQuote(v, { always = false } = {}) {
  if (!always && v !== '' && /^[A-Za-z_\/][\w.\/:@%+,=-]*$/.test(v) && !YAML_SPECIAL.test(v)) return v;
  return JSON.stringify(v);
}
const yamlKey = (k) => (/^[A-Za-z_][\w.-]*$/.test(k) ? k : JSON.stringify(k));

/**
 * formatEnv(vars, format, {masked, sort}) → text. masked replaces values by •••(length) placeholders
 * (shown on screen only; copy always uses the real values).
 */
export function formatEnv(vars, format, { masked = false, sort = false } = {}) {
  let list = [...vars];
  if (sort) list.sort((a, b) => a.key.localeCompare(b.key));
  const q = (fn) => (v) => (masked ? mask(v) : fn(v));
  switch (format) {
    case 'dotenv': return list.map((v) => `${v.key}=${q(dotenvQuote)(v.value)}`).join('\n');
    case 'shell': return list.map((v) => `export ${v.key}=${q(shellQuote)(v.value)}`).join('\n');
    case 'json': {
      const obj = {};
      for (const v of list) Object.defineProperty(obj, v.key, { value: masked ? mask(v.value) : v.value, enumerable: true, writable: true, configurable: true });
      return JSON.stringify(obj, null, 2);
    }
    case 'docker': return list.map((v) => `-e ${masked ? `${v.key}=${mask(v.value)}` : shellQuote(`${v.key}=${v.value}`)}`).join(' \\\n');
    case 'compose': return ['environment:', ...list.map((v) => `  ${yamlKey(v.key)}: ${q(yamlQuote)(v.value)}`)].join('\n');
    case 'github': return ['env:', ...list.map((v) => `  ${yamlKey(v.key)}: ${q(yamlQuote)(v.value)}`)].join('\n');
    case 'k8s': return ['env:', ...list.flatMap((v) => [`  - name: ${yamlKey(v.key)}`, `    value: ${masked && v.value ? mask(v.value) : yamlQuote(v.value, { always: true })}`])].join('\n');
    default: throw new Error(`Unknown output format "${format}"`);
  }
}

/** diffEnv(aVars, bVars) → {added: [{key, to}], removed: [{key, from}], changed: [{key, from, to}], same: n} */
export function diffEnv(a, b) {
  const A = new Map(a.map((v) => [v.key, v.value])), B = new Map(b.map((v) => [v.key, v.value]));
  const added = [], removed = [], changed = [];
  let same = 0;
  for (const [k, v] of A) {
    if (!B.has(k)) removed.push({ key: k, from: v });
    else if (B.get(k) !== v) changed.push({ key: k, from: v, to: B.get(k) });
    else same++;
  }
  for (const [k, v] of B) if (!A.has(k)) added.push({ key: k, to: v });
  return { added, removed, changed, same };
}
