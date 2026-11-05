// Pure logic for the "CSV ⇄ JSON / INSERT" dev tool (no DOM; unit-tested from tests/test_devtools_data.py).

export const DELIMITERS = [',', ';', '\t', '|'];

/** Guesses the delimiter from the first lines: the candidate that appears (outside quotes) most consistently. */
export function detectDelimiter(text) {
  const sample = stripBom(text).slice(0, 20000);
  let best = ',', bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = [];
    let n = 0, inQ = false;
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const c = sample[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === d) n++;
      else if (!inQ && c === '\n') { counts.push(n); n = 0; }
    }
    if (n || !counts.length) counts.push(n);
    const lines = counts.filter((x, k) => x || k < counts.length - 1);
    if (!lines.length || !lines[0]) continue;
    const same = lines.filter((x) => x === lines[0]).length;
    const score = (same / lines.length) * 1000 + Math.min(lines[0], 50);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export const stripBom = (t) => String(t ?? '').replace(/^\uFEFF/, '');

/**
 * RFC 4180 parser: quoted fields may hold the delimiter, "" and line breaks; CRLF / LF / CR line ends; BOM dropped.
 * Returns { rows: string[][], delimiter, warnings: [] }.
 */
export function parseCsv(text, { delimiter = 'auto' } = {}) {
  const s = stripBom(text);
  const d = delimiter === 'auto' || !delimiter ? detectDelimiter(s) : delimiter;
  const rows = [];
  const warnings = [];
  let row = [], field = '', i = 0, quoted = false, sawQuote = false;
  const endField = () => { row.push(field); field = ''; sawQuote = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '' && !sawQuote) { quoted = true; sawQuote = true; i++; continue; }
    if (c === '"' && sawQuote) { field += c; i++; continue; }  // text after a closing quote: keep it, lenient
    if (c === d) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) warnings.push('A quoted field is not closed — the rest of the input was read into it.');
  if (field !== '' || row.length || sawQuote) endRow();
  // drop blank lines (a single empty field)
  const kept = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const widths = new Set(kept.map((r) => r.length));
  if (widths.size > 1) {
    const w = Math.max(...widths);
    const ragged = kept.filter((r) => r.length !== w).length;
    warnings.push(`${ragged} row${ragged > 1 ? 's have' : ' has'} a different number of fields; missing cells are treated as empty.`);
  }
  return { rows: kept, delimiter: d, warnings };
}

/** Column names from a header row: blanks become column_N, duplicates get _2, _3 … */
export function headerNames(row, width) {
  const seen = new Map();
  const out = [];
  for (let k = 0; k < width; k++) {
    let name = (row?.[k] ?? '').trim() || `column_${k + 1}`;
    const base = name;
    let n = seen.get(base) || 0;
    while (out.includes(name)) { n++; name = `${base}_${n + 1}`; }
    seen.set(base, n);
    out.push(name);
  }
  return out;
}

/** {columns, records: string[][] (rectangular)} from parsed rows. */
export function toTable(rows, { header = true } = {}) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const columns = header ? headerNames(rows[0], width) : Array.from({ length: width }, (_, k) => `column_${k + 1}`);
  const body = header ? rows.slice(1) : rows;
  const records = body.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? ''));
  return { columns, records };
}

/* ------------------------------------------------------------------ types */
const INT = /^[+-]?\d+$/;
const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOL = /^(?:true|false)$/i;
const isNullText = (v) => v === '' || /^null$/i.test(v);

/** Kind of one cell: 'null' | 'integer' | 'number' | 'boolean' | 'string'. Leading zeros (007) stay strings. */
export function cellType(v) {
  if (isNullText(v)) return 'null';
  if (INT.test(v)) return /^[+-]?0\d/.test(v) ? 'string' : 'integer';
  if (NUM.test(v)) return /^[+-]?0\d/.test(v) ? 'string' : 'number';
  if (BOOL.test(v)) return 'boolean';
  return 'string';
}

/** Column summary: [{name, type, empty, distinct}] — type is the narrowest that fits every non-empty cell. */
export function columnTypes(columns, records) {
  return columns.map((name, k) => {
    const kinds = new Set();
    let empty = 0;
    const distinct = new Set();
    for (const r of records) {
      const v = r[k];
      distinct.add(v);
      const t = cellType(v);
      if (t === 'null') empty++; else kinds.add(t);
    }
    let type = 'string';
    if (!kinds.size) type = 'empty';
    else if (kinds.size === 1) type = [...kinds][0];
    else if ([...kinds].every((t) => t === 'integer' || t === 'number')) type = 'number';
    return { name, type, empty, distinct: distinct.size };
  });
}

/** Typed JSON value for a cell given its column type (big integers stay strings so no digits are lost). */
function typed(v, type, { nullEmpty = true } = {}) {
  if (isNullText(v)) return v === '' && !nullEmpty ? '' : (v === '' ? null : (type === 'string' ? v : null));
  if (type === 'integer') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  if (type === 'number') return Number.isFinite(Number(v)) ? Number(v) : v;
  if (type === 'boolean') return /^true$/i.test(v);
  return v;
}

/* ------------------------------------------------------------------ outputs */
const JSON_LIKE = new Set(['json', 'arrays', 'jsonl']);

/**
 * Renders a table in one of: json, arrays, jsonl, markdown, insert, copy, html.
 * opts: infer (types in JSON), nullEmpty (empty cell → null / NULL / \N), table, batch (rows per INSERT).
 */
export function render(columns, records, format, opts = {}) {
  const { infer = true, nullEmpty = true, table = 'my_table', batch = 500 } = opts;
  const types = columnTypes(columns, records).map((c) => c.type);
  const val = (v, k) => (infer ? typed(v, types[k], { nullEmpty }) : (nullEmpty && v === '' ? null : v));
  if (JSON_LIKE.has(format)) {
    if (format === 'arrays') {
      const rows = [columns, ...records.map((r) => r.map(val))];
      return `[\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]`;
    }
    const objs = records.map((r) => Object.fromEntries(columns.map((c, k) => [c, val(r[k], k)])));
    return format === 'jsonl' ? objs.map((o) => JSON.stringify(o)).join('\n') : JSON.stringify(objs, null, 2);
  }
  if (format === 'markdown') return markdownTable(columns, records);
  if (format === 'insert') return sqlInserts(columns, records, { table, batch, nullEmpty, types: infer ? types : null });
  if (format === 'copy') return pgCopy(columns, records, { table, nullEmpty });
  if (format === 'html') return htmlTable(columns, records);
  throw new Error(`Unknown format: ${format}`);
}

export function markdownTable(columns, records) {
  const cell = (v) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, '<br>');
  const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(columns), `|${columns.map(() => ' --- ').join('|')}|`, ...records.map(line)].join('\n');
}

const PG_RESERVED = new Set(`all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create
current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end
except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not
null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing
true union unique user using variadic when where window with authorization binary collation concurrently cross current_schema freeze full
ilike inner is isnull join left like natural notnull outer overlaps right similar tablesample verbose`.split(/\s+/));

/** Double-quotes an identifier when PostgreSQL would otherwise fold or reject it. */
export function quoteIdent(name) {
  const s = String(name);
  if (/^[a-z_][a-z0-9_$]*$/.test(s) && !PG_RESERVED.has(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** schema.table → each part quoted as needed; parts already in double quotes are kept. */
export function quoteTable(name) {
  const parts = String(name || '').trim().match(/"(?:[^"]|"")*"|[^.]+/g) || ['my_table'];
  return parts.map((p) => (p.startsWith('"') ? p : quoteIdent(p.trim()))).join('.');
}

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;

export function sqlInserts(columns, records, { table = 'my_table', batch = 500, nullEmpty = true, types = null } = {}) {
  const head = `INSERT INTO ${quoteTable(table)} (${columns.map(quoteIdent).join(', ')}) VALUES`;
  const lit = (v, k) => {
    if (v === '' && nullEmpty) return 'NULL';
    const t = types?.[k];
    if (t && /^null$/i.test(v) && t !== 'string') return 'NULL';
    if (t === 'integer' || t === 'number') return NUM.test(v) ? v : sqlStr(v);
    if (t === 'boolean') return BOOL.test(v) ? v.toUpperCase() : sqlStr(v);
    return sqlStr(v);
  };
  const size = Math.max(1, Math.floor(Number(batch)) || 500);
  const out = [];
  for (let i = 0; i < records.length; i += size) {
    const rows = records.slice(i, i + size).map((r) => `  (${r.map(lit).join(', ')})`);
    out.push(`${head}\n${rows.join(',\n')};`);
  }
  return out.join('\n\n');
}

/** PostgreSQL text-format COPY: tab separated, backslash escapes, \N for NULL, terminated by \. */
export function pgCopy(columns, records, { table = 'my_table', nullEmpty = true } = {}) {
  const esc = (v) => (v === '' && nullEmpty ? '\\N'
    : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
  return [`COPY ${quoteTable(table)} (${columns.map(quoteIdent).join(', ')}) FROM stdin;`,
    ...records.map((r) => r.map(esc).join('\t')), '\\.'].join('\n');
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function htmlTable(columns, records) {
  const tr = (cells, tag) => `    <tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  return ['<table>', '  <thead>', tr(columns, 'th'), '  </thead>', '  <tbody>', ...records.map((r) => tr(r, 'td')), '  </tbody>', '</table>'].join('\n');
}

/* ------------------------------------------------------------------ JSON → CSV */
/** Parses a JSON array / object or JSONL text into {columns, records} (records as strings). */
export function jsonToTable(text) {
  const src = stripBom(text).trim();
  if (!src) return { columns: [], records: [] };
  let data;
  try {
    data = JSON.parse(src);
    if (!Array.isArray(data)) data = [data];
  } catch (e) {
    const lines = src.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error(`Not valid JSON: ${e.message}`);
    data = lines.map((l, k) => {
      try { return JSON.parse(l); } catch (err) { throw new Error(`Line ${k + 1} is not valid JSON (tried JSON, then JSONL): ${err.message}`); }
    });
  }
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (data.every((r) => Array.isArray(r))) {
    const width = data.reduce((m, r) => Math.max(m, r.length), 0);
    const [first, ...rest] = data;
    const headerLike = first && first.every((v) => typeof v === 'string');
    const columns = headerLike ? headerNames(first.map(String), width) : Array.from({ length: width }, (_, k) => `column_${k + 1}`);
    return { columns, records: (headerLike ? rest : data).map((r) => Array.from({ length: width }, (_, k) => cell(r[k]))), headerFromData: headerLike };
  }
  const columns = [];
  const seen = new Set();
  const isObj = (r) => r && typeof r === 'object' && !Array.isArray(r);
  for (const r of data) {
    if (!isObj(r)) { if (!seen.has('value')) { seen.add('value'); columns.push('value'); } continue; }
    for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  const records = data.map((r) => columns.map((c) => (isObj(r) ? (Object.hasOwn(r, c) ? cell(r[c]) : '') : (c === 'value' ? cell(r) : ''))));
  return { columns, records };
}

/** CSV text from a table. opts: delimiter, quoteAll, header (bool), eol ('\n' | '\r\n'). */
export function toCsv(columns, records, { delimiter = ',', quoteAll = false, header = true, eol = '\n' } = {}) {
  const field = (v) => {
    const s = String(v ?? '');
    return quoteAll || s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = header ? [columns, ...records] : records;
  return rows.map((r) => r.map(field).join(delimiter)).join(eol);
}
