// Column Extractor tab: file + column -> values joined in the chosen format.

import { post } from '../core/api.js';
import { checkbox, columnPicker, dataTable, filePicker, segmented } from '../core/components.js';
import { clear, copyText, debounce, downloadText, fmt, h, store, toastError } from '../core/dom.js';

const DELIMITERS = [
  { value: 'comma', label: 'Comma  a,b' },
  { value: 'comma_space', label: 'Comma + space  a, b' },
  { value: 'newline', label: 'New line' },
  { value: 'comma_newline', label: 'Comma + new line' },
  { value: 'tab', label: 'Tab' },
  { value: 'dot', label: 'Dot  a.b' },
  { value: 'pipe', label: 'Pipe  a|b' },
  { value: 'semicolon', label: 'Semicolon  a;b' },
  { value: 'space', label: 'Space' },
  { value: 'custom', label: 'Custom…' },
];
const QUOTES = [
  { value: 'none', label: 'None' },
  { value: 'single', label: h('code', {}, "'a'") },
  { value: 'double', label: h('code', {}, '"a"') },
  { value: 'backtick', label: h('code', {}, '`a`') },
];
const WRAPS = [
  { value: 'none', label: 'None' },
  { value: 'paren', label: h('code', {}, '( )') },
  { value: 'bracket', label: h('code', {}, '[ ]') },
  { value: 'brace', label: h('code', {}, '{ }') },
];
const SORTS = [
  { value: 'none', label: 'File order' },
  { value: 'asc', label: 'A → Z' },
  { value: 'desc', label: 'Z → A' },
];
const PRESETS = [
  { label: 'SQL IN (ids)', opts: { delimiter: 'comma', quote: 'none', wrap: 'paren', unique: true } },
  { label: "SQL IN ('text')", opts: { delimiter: 'comma', quote: 'single', wrap: 'paren', unique: true } },
  { label: 'Python list', opts: { delimiter: 'comma_space', quote: 'double', wrap: 'bracket' } },
  { label: 'One per line', opts: { delimiter: 'newline', quote: 'none', wrap: 'none' } },
  { label: 'Plain CSV', opts: { delimiter: 'comma', quote: 'none', wrap: 'none' } },
];
const DEFAULTS = {
  delimiter: 'comma', custom_delimiter: '', quote: 'none', wrap: 'none', unique: false, skip_blank: true,
  trim: true, sort: 'none', numeric_sort: false, per_line: 0,
};
const OPTS_KEY = 'eu.colx.opts';
const COL_KEY = 'eu.colx.column';

export function mount(root) {
  let opts = { ...DEFAULTS, ...store.get(OPTS_KEY, {}) };
  let file = null;
  let column = null;
  let lastText = '';
  let seq = 0;

  // ---- source card
  const columnsSlot = h('div', { class: 'stack' });
  const previewSlot = h('div', {});
  const picker = filePicker({ storageKey: 'eu.colx.file', onLoad: onFile });
  const sourceCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '1 · Source')),
    h('div', { class: 'card-body' }, picker.el, columnsSlot, previewSlot));

  // ---- format card
  const optsSlot = h('div', { class: 'stack', style: { gap: '14px' } });
  const formatCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '2 · Format'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => setOpts({ ...DEFAULTS }) }, 'Reset')),
    h('div', { class: 'card-body' }, optsSlot));

  // ---- output card
  const stats = h('div', { class: 'stats' }, 'Pick a file and a column.');
  const output = h('textarea', { class: 'output mono', readonly: true, rows: 12, spellcheck: false,
    placeholder: 'Values appear here…', 'aria-label': 'Formatted output' });
  const copyBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => copyText(lastText, `Copied ${stats.dataset.count || ''} values`) }, '📋 Copy');
  const dlBtn = h('button', { class: 'btn', type: 'button', disabled: true,
    onclick: () => downloadText(lastText, `${(file?.name || 'values').replace(/\.[^.]+$/, '')}_${column}.txt`) }, '⬇ .txt');
  const outputCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '3 · Output'), h('span', { class: 'spacer' }), dlBtn, copyBtn),
    h('div', { class: 'card-body' }, stats, output));

  root.append(h('div', { class: 'grid-2' }, sourceCard, formatCard), outputCard);

  function onFile(info) {
    seq++;  // drop in-flight responses for the previous file
    file = info;
    clear(previewSlot);
    if (!info) { column = null; clear(columnsSlot); resetOutput(); return; }
    const remembered = store.get(COL_KEY);
    column = info.columns.includes(column) ? column : info.columns.includes(remembered) ? remembered : info.columns[0];
    clear(columnsSlot, h('div', { class: 'row' }, h('b', {}, 'Column'), h('span', { class: 'muted small' }, 'click to choose')),
      columnPicker(info.columns, column, (c) => { column = c; store.set(COL_KEY, c); run(); }));
    previewSlot.append(h('details', {}, h('summary', { class: 'muted small', style: { cursor: 'pointer' } }, 'Preview first rows'),
      h('div', { style: { marginTop: '8px' } }, dataTable(info.preview, info.columns))));
    run();
  }

  function setOpts(next) {
    opts = { ...opts, ...next };
    store.set(OPTS_KEY, opts);
    renderOpts();
    run();
  }

  function renderOpts() {
    const custom = h('input', { type: 'text', class: 'mono', value: opts.custom_delimiter, placeholder: 'e.g.  ;  or  \\n  or  " OR "',
      style: { maxWidth: '240px' }, oninput: debounce(() => setOptsQuiet({ custom_delimiter: custom.value }), 300) });
    const perLine = h('input', { type: 'number', min: 0, value: String(opts.per_line || 0),
      oninput: debounce(() => setOptsQuiet({ per_line: Math.max(0, Number(perLine.value) || 0) }), 300) });
    clear(optsSlot,
      h('div', { class: 'stack' }, h('b', {}, 'Presets'), h('div', { class: 'chips' },
        PRESETS.map((p) => h('button', { class: 'chip', type: 'button', onclick: () => setOpts(p.opts) }, p.label)))),
      h('div', { class: 'stack' }, h('b', {}, 'Delimiter'), segmented(DELIMITERS, opts.delimiter, (v) => setOpts({ delimiter: v })),
        opts.delimiter === 'custom' && custom),
      h('div', { class: 'row', style: { gap: '24px', alignItems: 'flex-start' } },
        h('div', { class: 'stack' }, h('b', {}, 'Quote each value'), segmented(QUOTES, opts.quote, (v) => setOpts({ quote: v }))),
        h('div', { class: 'stack' }, h('b', {}, 'Wrap all'), segmented(WRAPS, opts.wrap, (v) => setOpts({ wrap: v })))),
      h('div', { class: 'row', style: { gap: '24px', alignItems: 'flex-start' } },
        h('div', { class: 'stack' }, h('b', {}, 'Order'), segmented(SORTS, opts.sort, (v) => setOpts({ sort: v }))),
        h('label', { class: 'field' }, 'Line break every N items', perLine, h('span', { class: 'hint' }, '0 = never'))),
      h('div', { class: 'row', style: { gap: '18px' } },
        checkbox('Unique only', opts.unique, (v) => setOpts({ unique: v })),
        checkbox('Skip blanks', opts.skip_blank, (v) => setOpts({ skip_blank: v })),
        checkbox('Trim spaces', opts.trim, (v) => setOpts({ trim: v })),
        checkbox('Numeric sort', opts.numeric_sort, (v) => setOpts({ numeric_sort: v }), 'Sort 2 before 10')),
    );
  }

  // text inputs update without re-rendering (keeps focus/caret)
  function setOptsQuiet(next) { opts = { ...opts, ...next }; store.set(OPTS_KEY, opts); run(); }

  function resetOutput() {
    seq++;
    lastText = ''; output.value = ''; copyBtn.disabled = dlBtn.disabled = true;
    clear(stats, 'Pick a file and a column.');
  }

  const run = debounce(async () => {
    if (!file || !column) return;
    const my = ++seq;
    clear(stats, 'Formatting…');
    try {
      const res = await post('/api/column-extractor/extract', { path: file.path, sheet: file.sheet, column, ...opts });
      if (my !== seq) return;  // a newer request superseded this one
      lastText = res.text;
      // very large outputs: the textarea shows a prefix, Copy / Download always use the full text
      output.value = res.text.length > 2_000_000 ? `${res.text.slice(0, 2_000_000)}\n… (truncated in view — Copy/Download have everything)` : res.text;
      copyBtn.disabled = dlBtn.disabled = false;
      stats.dataset.count = fmt.int(res.count);
      clear(stats,
        h('span', {}, h('b', {}, fmt.int(res.count)), ' values'),
        h('span', {}, 'from ', h('b', {}, fmt.int(res.total_rows)), ' rows'),
        res.blank_skipped > 0 && h('span', {}, h('b', {}, fmt.int(res.blank_skipped)), ' blanks skipped'),
        res.duplicates_removed > 0 && h('span', {}, h('b', {}, fmt.int(res.duplicates_removed)), ' duplicates removed'),
        h('span', {}, h('b', {}, fmt.bytes(new Blob([res.text]).size))));
    } catch (e) {
      if (my !== seq) return;
      resetOutput();
      clear(stats, h('span', { class: 'pill err' }, 'Error'), ' ', e.message);
      toastError(e);
    }
  }, 150);

  renderOpts();
}
