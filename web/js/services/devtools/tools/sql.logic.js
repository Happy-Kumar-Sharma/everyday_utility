// Pure logic for the "SQL format + IN list" dev tool (no DOM; unit-tested from tests/test_devtools_data.py).
//
// The formatter only ever changes whitespace and the letter case of unquoted words (which PostgreSQL folds anyway):
// strings, quoted identifiers, dollar-quoted bodies and comments are copied byte for byte.

/* ------------------------------------------------------------------ tokenizer */
const OP_CHARS = '+-*/<>=~!@#%^&|`?';
const OP_SPECIAL = /[~!@#%^&|`?]/;
const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD = /^[A-Za-z_\u0080-￿][\w$\u0080-￿]*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;

/**
 * Splits SQL into tokens {type, v}: ws, line-comment, block-comment, string, ident, dollar, number, word, param,
 * op, punct. Concatenating every token's v gives back the input exactly. Unterminated strings / comments run to
 * the end of the input and get `open: true`.
 */
export function tokenize(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  const push = (type, end, extra) => { out.push({ type, v: sql.slice(i, end), ...extra }); i = end; };
  while (i < n) {
    const c = sql[i];
    const rest = sql.slice(i, i + 64);
    let m;
    if (/\s/.test(c)) { let j = i; while (j < n && /\s/.test(sql[j])) j++; push('ws', j); continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); push('line-comment', j < 0 ? n : j); continue; }
    if (c === '/' && sql[i + 1] === '*') {  // PostgreSQL block comments nest
      let depth = 0, j = i;
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (!depth) break; } else j++;
      }
      push('block-comment', Math.min(j, n), depth ? { open: true } : undefined); continue;
    }
    // string literals, optionally prefixed: E'..' (backslash escapes), B'..', X'..', N'..', U&'..'
    if ((m = /^(?:[eE]|[bB]|[xX]|[nN]|[uU]&)?'/.exec(rest))) {
      const escapes = /^[eE]/.test(m[0]);
      let j = i + m[0].length;
      let closed = false;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } j++; closed = true; break; }
        j++;
      }
      push('string', Math.min(j, n), closed ? undefined : { open: true }); continue;
    }
    if ((m = /^(?:[uU]&)?"/.exec(rest))) {
      let j = i + m[0].length, closed = false;
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } j++; closed = true; break; }
        j++;
      }
      push('ident', j, closed ? undefined : { open: true }); continue;
    }
    if (c === '$') {
      if ((m = /^\$\d+/.exec(rest))) { push('param', i + m[0].length); continue; }
      if ((m = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 200)))) {
        const end = sql.indexOf(m[0], i + m[0].length);
        push('dollar', end < 0 ? n : end + m[0].length, end < 0 ? { open: true } : undefined); continue;
      }
    }
    if (WORD_START.test(c)) { push('word', i + WORD.exec(sql.slice(i, i + 4000))[0].length); continue; }
    if ((m = NUMBER.exec(rest))) { push('number', i + m[0].length); continue; }
    // client-side placeholders: %s / %(name)s (Python DB-API), :name / :'name' / :"name" (psql, ORMs)
    if ((m = /^%(?:\([^()\s]*\))?s(?![\w$])/.exec(rest))) { push('param', i + m[0].length); continue; }
    if (c === ':') {
      if (sql[i + 1] === ':') { push('op', i + 2); continue; }
      if (sql[i + 1] === '=') { push('op', i + 2); continue; }
      if ((m = /^:(?:[A-Za-z_][\w]*|'[^'\n]*'|"[^"\n]*")/.exec(rest)) && !/[\w)\]]/.test(sql[i - 1] || '')) { push('param', i + m[0].length); continue; }
      push('punct', i + 1); continue;
    }
    if ('(),;[].'.includes(c)) { push('punct', i + 1); continue; }
    if (OP_CHARS.includes(c)) {
      // PostgreSQL lexer rules: greedy, stops before a comment start, and a multi-char operator may only end
      // in + or - when it contains one of ~ ! @ # % ^ & | ` ?
      let j = i;
      while (j < n && OP_CHARS.includes(sql[j]) && !(sql[j] === '-' && sql[j + 1] === '-') && !(sql[j] === '/' && sql[j + 1] === '*')) j++;
      if (j === i) j = i + 1;
      let op = sql.slice(i, j);
      if (op.length > 1 && !OP_SPECIAL.test(op)) while (op.length > 1 && /[+-]$/.test(op)) op = op.slice(0, -1);
      push('op', i + op.length); continue;
    }
    push('punct', i + 1);  // anything else (stray characters) is kept as-is
  }
  return out;
}

/** Tokens that carry meaning (no whitespace), for comparing two versions of a query. */
export const significant = (sql, { comments = true } = {}) => tokenize(sql)
  .filter((t) => t.type !== 'ws' && (comments || !t.type.endsWith('comment')));

/* ------------------------------------------------------------------ keywords */
export const KEYWORDS = new Set(`
all alter analyze and any array as asc asymmetric authorization begin between bigint bigserial boolean both by call cascade case cast
check collate column commit concurrently conflict constraint create cross current_date current_time current_timestamp current_user
date default deferrable delete desc distinct do drop else end except exists explain extract false fetch filter first following for
foreign from full function grant group having ilike in index inner insert integer intersect interval into is isnull join json jsonb
key last lateral leading left like limit local localtime localtimestamp materialized natural not nothing notnull null nulls numeric
offset on only or order outer over overlaps partition placing preceding primary range real recursive references replace restrict returning
revoke right rollback row rows select serial session_user set similar smallint some symmetric table tablesample temp temporary text then
ties time timestamp timestamptz to trailing transaction trigger true truncate unbounded union unique unlogged update using uuid vacuum
values varchar variadic verbose view when where window with within without zone coalesce nullif greatest least count sum avg min max
`.trim().split(/\s+/));

// words before which "(" gets a space (everything else followed by "(" is treated as a function call)
const SPACE_BEFORE_PAREN = new Set(`in values as on using exists and or not over from join where select into table any all some with union
intersect except then else when by returning set lateral distinct is like ilike between case filter within over conflict do recursive
materialized references primary key unique check default`.split(/\s+/));

// words after which a "-"/"+" is a sign rather than an operator
const SIGN_AFTER = new Set('select where and or not then else when by in values return returning set on having limit offset like ilike between is case as'.split(' '));

const JOIN_PREFIX = new Set(['left', 'right', 'full', 'inner', 'cross', 'natural', 'outer']);
const LIST_CLAUSES = new Set(['select', 'set', 'returning', 'values', 'with']);
const BREAK_AFTER = new Set(['select', 'set', 'values']);  // these put their first item on a new line too
const NAME_BEFORE_PAREN = new Set(['into', 'table', 'references', 'exists', 'view', 'index', 'on', 'only']);

/* ------------------------------------------------------------------ formatter */
/**
 * Pretty-prints PostgreSQL-flavoured SQL.
 * opts: indent (number of spaces, default 2), keywordCase 'upper' | 'lower' | 'preserve'.
 */
export function formatSql(sql, { indent = 2, keywordCase = 'upper' } = {}) {
  const toks = tokenize(sql);
  const sig = [];
  let nlBefore = true;  // whether the original text had a newline right before this token
  for (const t of toks) {
    if (t.type === 'ws') { nlBefore = nlBefore || t.v.includes('\n'); continue; }
    sig.push({ ...t, nl: nlBefore, lw: t.type === 'word' ? t.v.toLowerCase() : null });
    nlBefore = false;
  }

  const pad = ' '.repeat(Math.max(0, Number(indent) || 2));
  const lines = [];
  let line = '', lineLevel = 0, fresh = true;
  let forceBreak = false;  // after a line comment the next token must start a new line
  const newline = (level) => {
    if (!fresh) lines.push(line.replace(/\s+$/, ''));
    lineLevel = Math.max(0, level); line = pad.repeat(lineLevel); fresh = true; forceBreak = false;
  };
  const blank = () => { if (!fresh) newline(0); if (lines.length && lines[lines.length - 1] !== '') lines.push(''); };

  const caseWord = (t) => {
    if (t.type !== 'word' || !KEYWORDS.has(t.lw) || keywordCase === 'preserve') return t.v;
    return keywordCase === 'lower' ? t.v.toLowerCase() : t.v.toUpperCase();
  };

  const root = { kind: 'root', base: 0, clause: null, caseDepth: 0, between: false, pending: false };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const stmtCtx = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind !== 'paren') return stack[k]; return root; };

  let prev = null;  // previous emitted significant token
  let prev2 = null;  // the one before it
  let stmtBreak = false;  // a ';' was just written: blank line before the next statement

  function spaceBetween(a, b) {
    if (!a) return false;
    const av = a.v, bv = b.v;
    if (b.type === 'punct' && [',', ';', ')', ']', '.'].includes(bv)) return false;
    if (a.type === 'punct' && ['(', '[', '.'].includes(av)) return false;
    if (av === '::' || bv === '::') return false;
    if (b.type === 'punct' && bv === '(') {
      if (prev2 && prev2.type === 'word' && NAME_BEFORE_PAREN.has(prev2.lw) && (a.type === 'word' || a.type === 'ident')) return true;
      if (a.type === 'word') return SPACE_BEFORE_PAREN.has(a.lw);
      return !(a.type === 'ident' || a.type === 'param' || (a.type === 'punct' && av === ']'));
    }
    if (b.type === 'punct' && bv === '[') return !(['word', 'ident', 'param'].includes(a.type) || av === ')' || av === ']');
    if (a.sign) return false;
    return true;
  }

  function emit(t, text = t.v) {
    if (forceBreak && !fresh) newline(lineLevel);
    if (!fresh && spaceBetween(prev, t)) line += ' ';
    line += text; fresh = false;
    if (t.type === 'line-comment') forceBreak = true;
    prev2 = prev; prev = t;
  }

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const next = sig[i + 1];
    const ctx = top();
    const st = ctx.kind === 'paren' ? null : ctx;  // clause logic applies only at statement level
    const prevW = prev && prev.type === 'word' ? prev.lw : null;

    const isComment = t.type === 'line-comment' || t.type === 'block-comment';
    if (stmtBreak && !(isComment && !t.nl)) { stmtBreak = false; blank(); }
    if (isComment) {
      if (t.nl && !fresh) newline(lineLevel);
      emit(t);
      continue;
    }

    // pending break after SELECT / SET / VALUES / RETURNING (keeps DISTINCT [ON (...)] / ALL on the keyword line)
    if (st && st.pending) {
      const keep = (t.lw === 'distinct' || t.lw === 'all' || (t.lw === 'on' && prevW === 'distinct') || (t.v === '(' && prevW === 'on'));
      if (!keep) { st.pending = false; newline(st.base + 1); }
    }

    if (t.type === 'word' && st) {
      const w = t.lw;
      let clause = null;
      if (['select', 'where', 'having', 'limit', 'offset', 'window', 'returning', 'values'].includes(w)) clause = w;
      else if (w === 'from' && prevW !== 'distinct' && prevW !== 'delete') clause = w;
      else if ((w === 'group' || w === 'order') && next?.lw === 'by') clause = w;
      else if (w === 'set') clause = 'set';
      else if (['union', 'intersect', 'except'].includes(w)) clause = w;
      else if (w === 'with' && (!prev || prev.v === ';' || prev.v === '(')) clause = 'with';
      else if (['insert', 'update', 'delete'].includes(w) && (!prev || prev.v === ';' || prev.v === '(' || prev.v === ')')) clause = w;
      else if (w === 'join' && !JOIN_PREFIX.has(prevW)) clause = 'join';
      else if (JOIN_PREFIX.has(w) && w !== 'outer' && !JOIN_PREFIX.has(prevW) && (next?.lw === 'join' || (JOIN_PREFIX.has(next?.lw) && sig[i + 2]?.lw === 'join'))) clause = 'join';
      else if (w === 'on' && next?.lw === 'conflict') clause = 'conflict';
      else if (w === 'for' && ['update', 'share', 'no', 'key'].includes(next?.lw) && st.clause !== null) clause = 'for';
      if (clause) {
        const isSet = ['union', 'intersect', 'except'].includes(clause);
        if (isSet) { newline(st.base); emit(t, caseWord(t)); newline(st.base); }
        else { newline(st.base); emit(t, caseWord(t)); }
        st.clause = clause; st.between = false; st.caseDepth = 0;
        if (BREAK_AFTER.has(clause)) st.pending = true;
        if (isSet) st.clause = null;
        continue;
      }
      if (w === 'case') st.caseDepth++;
      if (w === 'end' && st.caseDepth > 0) st.caseDepth--;
      if (w === 'between') st.between = true;
      if ((w === 'and' || w === 'or') && st.caseDepth === 0) {
        if (w === 'and' && st.between) { st.between = false; emit(t, caseWord(t)); continue; }
        if (['where', 'having'].includes(st.clause)) { newline(st.base + 1); emit(t, caseWord(t)); continue; }
        if (['join', 'conflict'].includes(st.clause)) { newline(st.base + 2); emit(t, caseWord(t)); continue; }
      }
    }

    if (t.type === 'punct' && t.v === '(') {
      const sub = next && next.type === 'word' && ['select', 'with'].includes(next.lw);
      emit(t);
      if (sub) {
        const s = { kind: 'sub', base: lineLevel + 1, clause: null, caseDepth: 0, between: false, pending: false, open: lineLevel };
        stack.push(s); newline(s.base);
      } else stack.push({ kind: 'paren' });
      continue;
    }
    if (t.type === 'punct' && t.v === ')') {
      if (stack.length > 1) {
        const closed = stack.pop();
        if (closed.kind === 'sub') newline(closed.open);
      }
      emit(t);
      continue;
    }
    if (t.type === 'punct' && t.v === ',') {
      emit(t);
      if (st && st.caseDepth === 0) {
        if (st.clause === 'with') newline(st.base);
        else if (LIST_CLAUSES.has(st.clause)) newline(st.base + 1);
      }
      continue;
    }
    if (t.type === 'punct' && t.v === ';') {
      emit(t);
      if (ctx === root) { stmtBreak = true; root.clause = null; root.pending = false; root.caseDepth = 0; }
      continue;
    }
    if (t.type === 'op' && (t.v === '-' || t.v === '+') && next && ['number', 'word', 'ident', 'param', 'punct'].includes(next.type)
      && (!prev || (prev.type === 'op' && prev.v !== '::') || (prev.type === 'punct' && ['(', ',', '['].includes(prev.v)) || (prev.type === 'word' && SIGN_AFTER.has(prev.lw)))) {
      if (!(next.type === 'punct' && next.v !== '(')) { emit({ ...t, sign: true }); continue; }
    }
    emit(t, caseWord(t));
  }
  if (!fresh) lines.push(line.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Collapses whitespace to the minimum that keeps the tokens apart. Line comments keep their line break; with
 * stripComments they are removed (as are block comments).
 */
export function minifySql(sql, { stripComments = false } = {}) {
  const toks = significant(sql, { comments: !stripComments });
  // a space is needed only where gluing two tokens would change how they lex (a b, E 'x', - -1, a $$..$$)
  const wordy = (t) => ['word', 'number', 'param', 'ident', 'string', 'dollar'].includes(t.type);
  const comment = (t) => t.type.endsWith('comment');
  let out = '';
  let prev = null;
  for (const t of toks) {
    if (prev) {
      if (prev.type === 'line-comment') out += '\n';
      else if ((wordy(prev) && wordy(t)) || (prev.type === 'op' && t.type === 'op') || comment(prev) || comment(t)
        || (prev.type === 'op' && t.type === 'param')) out += ' ';
    }
    out += t.v;
    prev = t;
  }
  return out;
}

/** Problems worth telling the user about (unterminated strings / comments / quotes). */
export function sqlWarnings(sql) {
  const names = { string: 'string literal', ident: 'quoted identifier', dollar: 'dollar-quoted string', 'block-comment': '/* comment' };
  return tokenize(sql).filter((t) => t.open).map((t) => `Unterminated ${names[t.type] || t.type} — everything after it is treated as part of it.`);
}

/* ------------------------------------------------------------------ IN-list builder */
/**
 * Splits pasted values on newlines, commas, tabs, semicolons and pipes (or on spaces when there are none of
 * those). 'single' / "double" quoted values may contain separators; wrapping ( ) / [ ] / { } is ignored.
 */
export function parseValues(text) {
  let s = String(text ?? '').replace(/^﻿/, '').trim();
  const wrap = /^[([{]([\s\S]*)[)\]}]$/.exec(s);
  if (wrap) s = wrap[1];
  const seps = /[\n\r,;\t|]/.test(s) ? '\n\r,;\t|' : ' ';
  const values = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (seps.includes(s[i]) || /\s/.test(s[i]))) i++;
    if (i >= s.length) break;
    const q = s[i];
    if (q === "'" || q === '"') {
      let j = i + 1, v = '';
      for (; j < s.length; j++) {
        if (s[j] === q) { if (s[j + 1] === q) { v += q; j++; continue; } break; }
        v += s[j];
      }
      if (j < s.length) {  // closed: skip to the next separator
        let k = j + 1;
        while (k < s.length && !seps.includes(s[k])) k++;
        if (!s.slice(j + 1, k).trim()) { values.push(v); i = k; continue; }
      }
    }
    let j = i;
    while (j < s.length && !seps.includes(s[j])) j++;
    const v = s.slice(i, j).trim();
    if (v) values.push(v);
    i = j;
  }
  return values;
}

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const LEADING_ZERO = /^[+-]?0\d/;
export const isNumeric = (v) => NUMERIC.test(v);
export const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Element of a PostgreSQL array literal ('{a,"b c"}'). */
function arrayElement(v, quoted) {
  if (!quoted) return v;
  return /^$|[{},"\\\s]|^null$/i.test(v) ? `"${v.replace(/[\\"]/g, '\\$&')}"` : v;
}

/**
 * Builds IN lists. opts:
 *   dedupe (bool), quote 'auto' | 'number' | 'string', format 'in' | 'any' | 'values',
 *   column (string, optional), chunk (N values per list, 0 = one list), join 'or' | 'separate',
 *   template (optional, '{list}' is replaced by each list / the OR-ed lists), perLine (one value per line).
 * Returns { text, total, unique, duplicates, invalid: [..], chunks, quoted, notes: [..] }.
 */
export function buildInList(text, opts = {}) {
  const { dedupe = true, quote = 'auto', format = 'in', column = '', chunk = 0, join = 'or', template = '', perLine = false } = opts;
  const all = parseValues(text);
  let values = all;
  const notes = [];
  if (dedupe) values = [...new Set(all)];
  const duplicates = all.length - new Set(all).size;
  const invalid = [];
  let quoted;
  if (quote === 'number') {
    quoted = false;
    values = values.filter((v) => (NUMERIC.test(v) ? true : (invalid.push(v), false)));
  } else if (quote === 'string') quoted = true;
  else {
    quoted = !values.every((v) => NUMERIC.test(v) && !LEADING_ZERO.test(v));
    if (quoted && values.some((v) => NUMERIC.test(v) && LEADING_ZERO.test(v)) && values.every((v) => NUMERIC.test(v))) {
      notes.push('Values have leading zeros, so they are quoted as strings (choose “Numbers” to drop the zeros).');
    } else if (quoted && values.some((v) => NUMERIC.test(v))) {
      notes.push('Some values are not numbers, so every value is quoted as a string.');
    }
  }
  const size = Number(chunk) > 0 ? Math.floor(Number(chunk)) : values.length || 1;
  const groups = [];
  for (let k = 0; k < values.length; k += size) groups.push(values.slice(k, k + size));
  const col = String(column || '').trim();
  const sepIn = perLine ? ',\n  ' : ', ';
  const list = (g) => {
    if (format === 'any') {
      const lit = `{${g.map((v) => arrayElement(v, quoted)).join(',')}}`;
      return `${col ? `${col} ` : ''}= ANY(${sqlString(lit)})`;
    }
    if (format === 'values') {
      const rows = g.map((v) => `(${quoted ? sqlString(v) : v})`);
      return `VALUES ${perLine ? '\n  ' : ''}${rows.join(perLine ? ',\n  ' : ', ')}`;
    }
    const items = g.map((v) => (quoted ? sqlString(v) : v));
    return `${col ? `${col} ` : ''}IN (${perLine ? '\n  ' : ''}${items.join(sepIn)}${perLine ? '\n' : ''})`;
  };
  const fill = (s) => (template.includes('{list}') ? template.split('{list}').join(s) : s);
  let out = '';
  if (groups.length) {
    const parts = groups.map(list);
    if (parts.length === 1) out = fill(parts[0]);
    else if (join === 'or' && format !== 'values') out = fill(`(\n  ${parts.join('\n  OR ')}\n)`);
    else out = parts.map(fill).join(template ? '\n' : '\n\n');
    if (parts.length > 1 && join === 'or' && format === 'values') notes.push('VALUES lists cannot be OR-ed; they are output as separate lists.');
  }
  if (!col && groups.length > 1 && join === 'or' && format !== 'values') notes.push('Set a column name so the OR-ed lists read “col IN (…) OR col IN (…)”.');
  return { text: out, total: all.length, unique: new Set(all).size, duplicates, invalid, chunks: groups.length, count: values.length, quoted, notes };
}
