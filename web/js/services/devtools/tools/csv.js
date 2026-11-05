// 📊 CSV ⇄ JSON / INSERT: CSV/TSV → JSON, JSONL, Markdown, SQL INSERT, Postgres COPY, HTML; JSON/JSONL → CSV.
// Runs entirely in the page; inputs are never stored, only the options.

import { checkbox, dataTable, segmented } from '../../../core/components.js';
import { clear, debounce, downloadText, fmt, h, loadCss } from '../../../core/dom.js';
import { area, copyBtn, dropZone, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './csv.logic.js';

/** Caption + control group for segmented controls (a <label> would forward clicks to their first button). */
const group = (label, el, extra) => h('div', { class: 'dt-data-field', role: 'group', 'aria-label': label }, h('span', { class: 'row' }, label, extra), el);

const T = 'csv';
const PREVIEW_ROWS = 50;
const SHOW_LIMIT = 400_000;  // longer outputs are shown truncated; Copy / Download still give everything
const EXT = { json: 'json', arrays: 'json', jsonl: 'jsonl', markdown: 'md', insert: 'sql', copy: 'sql', html: 'html' };
const TYPE_PILL = { integer: 'ok', number: 'ok', boolean: 'warn', empty: '', string: '' };

export default function build() {
  loadCss('/static/css/devtools-data.css');
  const input = area({ rows: 10, placeholder: 'Paste CSV / TSV — or JSON / JSONL in “JSON → CSV” mode…', 'aria-label': 'Input' });
  const status = notice();
  const stats = h('div', { class: 'stats' });
  const typesEl = h('div', { class: 'chips dt-data-types', 'aria-label': 'Column types' });
  const preview = h('div', {});
  let output = '';
  let fileName = '';
  const pre = h('pre', { class: 'code dt-data-out', tabindex: 0, 'aria-label': 'Output' });
  const truncNote = h('p', { class: 'muted small', hidden: true });
  const outActions = h('div', { class: 'row' },
    copyBtn(() => output, 'Copy output'),
    h('button', { type: 'button', class: 'btn sm', onclick: () => downloadText(output, outName()) }, '⬇ Download'));
  const outWrap = h('div', { class: 'stack', hidden: true }, outActions, pre, truncNote);
  const live = debounce(() => update(), 250);
  const set = (k) => (v) => { setOpt(T, k, v); update(); };

  const dir = segmented([{ value: 'csv', label: 'CSV → …' }, { value: 'json', label: 'JSON → CSV' }], opt(T, 'dir', 'csv'), set('dir'));
  const delim = segmented([{ value: 'auto', label: 'Auto' }, { value: ',', label: ', comma' }, { value: ';', label: '; semicolon' },
    { value: '\t', label: 'Tab' }, { value: '|', label: '| pipe' }], opt(T, 'delim', 'auto'), set('delim'));
  const header = checkbox('First row is the header', opt(T, 'header', true), set('header'));
  const format = segmented([
    { value: 'json', label: 'JSON objects' }, { value: 'arrays', label: 'JSON arrays' }, { value: 'jsonl', label: 'JSONL' },
    { value: 'markdown', label: 'Markdown' }, { value: 'insert', label: 'SQL INSERT' }, { value: 'copy', label: 'COPY' }, { value: 'html', label: 'HTML' },
  ], opt(T, 'format', 'json'), set('format'));
  const infer = checkbox('Infer types (numbers, booleans)', opt(T, 'infer', true), set('infer'));
  const nullEmpty = checkbox('Empty → null / NULL / \\N', opt(T, 'nullEmpty', true), set('nullEmpty'));
  const table = h('input', { type: 'text', class: 'mono', value: opt(T, 'table', 'my_table'), 'aria-label': 'Table name',
    oninput: () => { setOpt(T, 'table', table.value); live(); } });
  const batch = h('input', { type: 'number', min: 1, step: 100, value: String(opt(T, 'batch', 500)), 'aria-label': 'Rows per INSERT',
    oninput: () => { setOpt(T, 'batch', Number(batch.value) || 500); live(); } });
  const sqlOpts = h('div', { class: 'row' }, labelled('Table', table), labelled('Rows per INSERT', batch));
  // JSON → CSV
  const outDelim = segmented([{ value: ',', label: ', comma' }, { value: ';', label: '; semicolon' }, { value: '\t', label: 'Tab' },
    { value: '|', label: '| pipe' }], opt(T, 'outDelim', ','), set('outDelim'));
  const quoteAll = checkbox('Quote every field', opt(T, 'quoteAll', false), set('quoteAll'));
  const crlf = checkbox('CRLF line ends', opt(T, 'crlf', false), set('crlf'));

  const csvOpts = h('div', { class: 'stack dt-data-opts' }, h('div', { class: 'row' }, group('Delimiter', delim), header),
    group('Output', format), h('div', { class: 'row' }, infer, nullEmpty), sqlOpts);
  const jsonOpts = h('div', { class: 'stack dt-data-opts' }, group('Delimiter', outDelim), h('div', { class: 'row' }, quoteAll, crlf));

  function outName() {
    const base = (fileName.replace(/\.[^.]+$/, '') || 'data').replace(/[^\w.-]+/g, '_');
    return dir.value === 'json' ? `${base}.csv` : `${base}.${EXT[format.value] || 'txt'}`;
  }

  function setOutput(text) {
    output = text;
    outWrap.hidden = !text;
    pre.textContent = text.length > SHOW_LIMIT ? text.slice(0, SHOW_LIMIT) : text;
    truncNote.hidden = text.length <= SHOW_LIMIT;
    truncNote.textContent = `Showing the first ${fmt.int(SHOW_LIMIT)} of ${fmt.int(text.length)} characters — Copy and Download give the full output.`;
  }

  function renderTable(columns, records, types) {
    clear(stats,
      h('span', {}, h('b', {}, fmt.int(records.length)), ' rows'),
      h('span', {}, h('b', {}, fmt.int(columns.length)), ' columns'),
      records.length > PREVIEW_ROWS && h('span', {}, `preview shows the first ${PREVIEW_ROWS}`));
    clear(typesEl, types.map((c) => h('span', { class: `pill ${TYPE_PILL[c.type] ?? ''}`, title: `${c.empty} empty · ${c.distinct} distinct` },
      h('span', { class: 'mono' }, c.name), ` ${c.type}`, c.empty ? h('span', { class: 'muted' }, ` · ${fmt.int(c.empty)} empty`) : null)));
    const rows = records.slice(0, PREVIEW_ROWS).map((r) => Object.fromEntries(columns.map((c, k) => [c, r[k]])));
    clear(preview, columns.length ? dataTable(rows, columns) : null);
  }

  function reset() { setOutput(''); clear(stats); clear(typesEl); clear(preview); }

  function update() {
    const toCsv = dir.value === 'json';
    csvOpts.hidden = toCsv; jsonOpts.hidden = !toCsv;
    sqlOpts.hidden = !['insert', 'copy'].includes(format.value);
    infer.hidden = !['json', 'arrays', 'jsonl', 'insert'].includes(format.value);
    input.placeholder = toCsv ? 'Paste a JSON array (of objects or arrays) or JSONL…' : 'Paste CSV / TSV, or drop a file below…';
    if (!input.value.trim()) { reset(); show(status, ''); return; }
    try {
      if (toCsv) {
        const { columns, records } = L.jsonToTable(input.value);
        if (!columns.length) { reset(); show(status, 'warn', 'The JSON holds no rows.'); return; }
        setOutput(L.toCsv(columns, records, { delimiter: outDelim.value, quoteAll: quoteAll.querySelector('input').checked, eol: crlf.querySelector('input').checked ? '\r\n' : '\n' }));
        renderTable(columns, records, L.columnTypes(columns, records));
        show(status, 'ok', `✓ ${fmt.int(records.length)} rows × ${columns.length} columns`);
        return;
      }
      const parsed = L.parseCsv(input.value, { delimiter: delim.value });
      const { columns, records } = L.toTable(parsed.rows, { header: header.querySelector('input').checked });
      const types = L.columnTypes(columns, records);
      setOutput(L.render(columns, records, format.value, {
        infer: infer.querySelector('input').checked, nullEmpty: nullEmpty.querySelector('input').checked,
        table: table.value.trim() || 'my_table', batch: Number(batch.value) || 500,
      }));
      renderTable(columns, records, types);
      const dname = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[parsed.delimiter];
      const msg = `${delim.value === 'auto' ? `Delimiter: ${dname} (detected)` : `Delimiter: ${dname}`}`;
      if (parsed.warnings.length) show(status, 'warn', msg, ...parsed.warnings.map((w) => h('div', {}, w)));
      else show(status, 'ok', `✓ ${msg}`);
    } catch (e) {
      reset();
      show(status, 'err', `✗ ${e.message}`);
    }
  }

  async function loadFile(file) {
    try {
      if (file.size > 50 * 1024 * 1024) { show(status, 'err', `✗ ${file.name} is ${fmt.bytes(file.size)} — files over 50 MB are too big for the browser.`); return; }
      fileName = file.name;
      input.value = await file.text();
      if (/\.(jsonl?|ndjson)$/i.test(file.name) && dir.value !== 'json') { dir.value = 'json'; setOpt(T, 'dir', 'json'); }
      else if (/\.(csv|tsv|txt)$/i.test(file.name) && dir.value !== 'csv') { dir.value = 'csv'; setOpt(T, 'dir', 'csv'); }
      update();
    } catch (e) { show(status, 'err', `✗ Could not read ${file.name}: ${e.message}`); }
  }

  input.addEventListener('input', () => { fileName = ''; live(); });
  update();
  return {
    el: h('div', { class: 'stack dt-tool dt-data' }, h('div', { class: 'row' }, dir), csvOpts, jsonOpts,
      labelled('Input', input), dropZone('📄 Drop a .csv / .tsv / .json / .jsonl file here (or click)', loadFile),
      status, stats, typesEl, preview, outWrap),
    clear() { input.value = ''; fileName = ''; update(); },
    focus() { input.focus(); },
  };
}
