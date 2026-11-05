// 🗄️ SQL format + IN list: PostgreSQL-flavoured formatter / minifier, and an IN-list builder for pasted values.
// Runs entirely in the page; inputs are never stored, only the options.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, debounce, fmt, h, loadCss } from '../../../core/dom.js';
import { highlight } from '../../../core/highlight.js';
import { area, copyBtn, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './sql.logic.js';

/** Caption + control group for segmented controls (a <label> would forward clicks to their first button). */
const group = (label, el, extra) => h('div', { class: 'dt-data-field', role: 'group', 'aria-label': label }, h('span', { class: 'row' }, label, extra), el);

const T = 'sql';
const HIGHLIGHT_LIMIT = 300_000;  // above this the output is shown as plain text (still copied in full)

/** Highlighted, copyable output block. */
function sqlOutput() {
  let text = '';
  const pre = h('pre', { class: 'code dt-data-out', tabindex: 0, 'aria-label': 'Output' });
  const copy = copyBtn(() => text);
  copy.classList.add('copy-btn');
  const wrap = h('div', { class: 'code-wrap' }, pre, copy);
  wrap.hidden = true;
  wrap.set = (t) => {
    text = t;
    wrap.hidden = !t;
    if (t.length > HIGHLIGHT_LIMIT) pre.textContent = t; else clear(pre, highlight(t, 'sql'));
  };
  return wrap;
}

export default function build() {
  loadCss('/static/css/devtools-data.css');
  const sqlIn = area({ rows: 10, placeholder: 'Paste SQL…', 'aria-label': 'SQL' });
  const valuesIn = area({ rows: 8, placeholder: 'Paste ids or values — one per line, comma/tab separated, or a CSV column…', 'aria-label': 'Values' });
  const out = sqlOutput();
  const status = notice();
  const stats = h('div', { class: 'stats' });
  const live = debounce(() => update(), 200);
  const set = (k) => (v) => { setOpt(T, k, v); update(); };

  const mode = segmented([{ value: 'format', label: 'Format' }, { value: 'minify', label: 'Minify' }, { value: 'in', label: 'IN list' }],
    opt(T, 'mode', 'format'), set('mode'));
  const kwCase = segmented([{ value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'preserve', label: 'As typed' }],
    opt(T, 'case', 'upper'), set('case'));
  const indent = segmented([{ value: 2, label: '2 spaces' }, { value: 4, label: '4 spaces' }], opt(T, 'indent', 2), set('indent'));
  const strip = checkbox('Strip comments', opt(T, 'strip', false), set('strip'));

  // IN-list options
  const dedupe = checkbox('Remove duplicates', opt(T, 'dedupe', true), set('dedupe'));
  const perLine = checkbox('One per line', opt(T, 'perLine', false), set('perLine'));
  const quote = segmented([{ value: 'auto', label: 'Auto', title: 'Numbers unquoted, otherwise quoted strings' },
    { value: 'number', label: 'Numbers' }, { value: 'string', label: 'Strings' }], opt(T, 'quote', 'auto'), set('quote'));
  const format = segmented([{ value: 'in', label: 'IN (…)' }, { value: 'any', label: "= ANY('{…}')" }, { value: 'values', label: 'VALUES' }],
    opt(T, 'format', 'in'), set('format'));
  const join = segmented([{ value: 'or', label: 'OR-ed' }, { value: 'separate', label: 'Separate' }], opt(T, 'join', 'or'), set('join'));
  const column = h('input', { type: 'text', class: 'mono', value: opt(T, 'column', ''), placeholder: 'id', 'aria-label': 'Column name',
    oninput: () => { setOpt(T, 'column', column.value); live(); } });
  const chunk = h('input', { type: 'number', min: 0, step: 100, value: String(opt(T, 'chunk', 1000)), 'aria-label': 'Values per list (0 = all in one)',
    oninput: () => { setOpt(T, 'chunk', Number(chunk.value) || 0); live(); } });
  const template = h('input', { type: 'text', class: 'mono', value: opt(T, 'template', ''), placeholder: 'SELECT * FROM t WHERE {list};',
    'aria-label': 'Wrap each list in a statement', oninput: () => { setOpt(T, 'template', template.value); live(); } });

  const fmtOpts = h('div', { class: 'row' }, kwCase, indent);
  const minOpts = h('div', { class: 'row' }, strip);
  const sqlField = labelled('SQL', sqlIn);
  const inOpts = h('div', { class: 'stack dt-data-opts' },
    h('div', { class: 'row' }, group('Quote', quote), group('Output as', format)),
    h('div', { class: 'row' },
      labelled('Column', column), labelled('Values per list', chunk), group('Several lists', join)),
    labelled('Statement template', template, h('span', { class: 'muted small' }, '{list} is replaced; leave empty for just the list')),
    h('div', { class: 'row' }, dedupe, perLine));
  const valuesField = labelled('Values', valuesIn);

  function update() {
    try {
      const m = mode.value;
      const isIn = m === 'in';
      fmtOpts.hidden = m !== 'format'; minOpts.hidden = m !== 'minify'; sqlField.hidden = isIn;
      inOpts.hidden = !isIn; valuesField.hidden = !isIn; stats.hidden = !isIn;
      if (isIn) return updateIn();
      const src = sqlIn.value;
      if (!src.trim()) { out.set(''); show(status, ''); return; }
      const res = m === 'format'
        ? L.formatSql(src, { indent: indent.value, keywordCase: kwCase.value })
        : L.minifySql(src, { stripComments: strip.querySelector('input').checked });
      out.set(res);
      // safety net: the output must hold exactly the same tokens (words compared case-insensitively)
      const norm = (s) => L.significant(s, { comments: !(m === 'minify' && strip.querySelector('input').checked) })
        .map((t) => (t.type === 'word' ? t.v.toLowerCase() : t.v)).join('\u0000');
      const warnings = L.sqlWarnings(src);
      if (norm(src) !== norm(res)) show(status, 'err', '✗ Formatting changed the tokens of this query — please use the original. (This is a bug; the output is shown for reference only.)');
      else if (warnings.length) show(status, 'warn', warnings.join(' '));
      else show(status, 'ok', m === 'format' ? `✓ Formatted · ${fmt.int(res.split('\n').length)} lines` : `✓ Minified · ${fmt.int(src.length)} → ${fmt.int(res.length)} chars`);
    } catch (e) {
      out.set('');
      show(status, 'err', `✗ ${e.message}`);
    }
  }

  function updateIn() {
    if (!valuesIn.value.trim()) { out.set(''); clear(stats); show(status, ''); return; }
    const r = L.buildInList(valuesIn.value, {
      dedupe: dedupe.querySelector('input').checked, quote: quote.value, format: format.value, column: column.value,
      chunk: Number(chunk.value) || 0, join: join.value, template: template.value, perLine: perLine.querySelector('input').checked,
    });
    out.set(r.text);
    clear(stats, [['values', r.total], ['unique', r.unique], ['duplicates', r.duplicates], ['in output', r.count], ['lists', r.chunks]]
      .map(([k, v]) => h('span', {}, h('b', {}, fmt.int(v)), ` ${k}`)),
    h('span', { class: `pill ${r.quoted ? '' : 'ok'}` }, r.quoted ? 'quoted strings' : 'numbers'));
    const msgs = [...r.notes];
    if (r.invalid.length) msgs.unshift(`${r.invalid.length} value${r.invalid.length > 1 ? 's are' : ' is'} not a number and ${r.invalid.length > 1 ? 'were' : 'was'} left out: ${r.invalid.slice(0, 5).join(', ')}${r.invalid.length > 5 ? ' …' : ''}`);
    if (!r.count) show(status, 'err', '✗ No usable values.', ...msgs.map((x) => h('div', {}, x)));
    else if (msgs.length) show(status, 'warn', ...msgs.map((x) => h('div', {}, x)));
    else show(status, '');
  }

  sqlIn.addEventListener('input', live);
  valuesIn.addEventListener('input', live);
  update();
  return {
    el: h('div', { class: 'stack dt-tool dt-data' }, h('div', { class: 'row' }, mode), fmtOpts, minOpts, inOpts,
      sqlField, valuesField, stats, status, out),
    clear() { sqlIn.value = ''; valuesIn.value = ''; update(); },
    focus() { (mode.value === 'in' ? valuesIn : sqlIn).focus(); },
  };
}
