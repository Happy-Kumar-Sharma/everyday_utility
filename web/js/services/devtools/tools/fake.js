// 🎲 Fake data: schema builder → seeded rows → CSV / JSON / JSONL / SQL INSERT / Markdown.
// The schema, seed and output options are remembered (opt/setOpt); generated data never is.

import { segmented } from '../../../core/components.js';
import { clear, copyText, debounce, fmt, h, loadCss, toast, toastError } from '../../../core/dom.js';
import { labelled, notice, opt, setOpt, show } from '../ui.js';
import * as F from './fake.logic.js';

const T = 'fake';
const PREVIEW = 20;
const MAX_ROWS = 100000;
const CHUNK = 5000;  // multiple of the SQL batch size (500), so chunked SQL equals one-shot SQL

const tick = () => new Promise((r) => setTimeout(r, 0));
const randomSeed = () => Math.random().toString(36).slice(2, 8);
const clone = (x) => JSON.parse(JSON.stringify(x));

export default function build() {
  loadCss('/static/css/devtools-generate.css');
  let columns = (() => {
    const saved = opt(T, 'schema', null);
    return Array.isArray(saved) && saved.length ? saved.map(F.normalizeColumn) : clone(F.EXAMPLE_SCHEMA);
  })();
  let running = null;  // {cancelled} while a full generation runs

  /* ---------- settings */
  const rowsIn = h('input', { type: 'number', min: 1, max: MAX_ROWS, step: 1, value: opt(T, 'rows', 1000) });
  const seedIn = h('input', { type: 'text', class: 'mono dt-fake-seed', value: opt(T, 'seed', '42'), autocomplete: 'off', spellcheck: false });
  const newSeed = h('button', { type: 'button', class: 'btn sm', title: 'Pick a random seed', 'aria-label': 'Random seed',
    onclick: () => { seedIn.value = randomSeed(); setOpt(T, 'seed', seedIn.value); refresh(); } }, '🎲');
  const format = segmented(F.FORMATS.map((f) => ({ value: f.value, label: f.label })), opt(T, 'format', 'csv'),
    (v) => { setOpt(T, 'format', v); tableField.hidden = v !== 'sql'; refresh(); });
  format.setAttribute('aria-label', 'Output format');
  const tableIn = h('input', { type: 'text', class: 'mono', value: opt(T, 'table', 'fake_data'), autocomplete: 'off', spellcheck: false });
  const tableField = labelled('Table name', tableIn);
  tableField.hidden = format.value !== 'sql';
  rowsIn.addEventListener('input', debounce(() => { setOpt(T, 'rows', rowsIn.value); refresh(); }, 200));
  seedIn.addEventListener('input', debounce(() => { setOpt(T, 'seed', seedIn.value); refresh(); }, 200));
  tableIn.addEventListener('input', debounce(() => { setOpt(T, 'table', tableIn.value); refresh(); }, 200));

  /* ---------- saved schemas */
  const savedSel = h('select', { 'aria-label': 'Saved schemas' });
  const saveName = h('input', { type: 'text', placeholder: 'Schema name', 'aria-label': 'Name to save the schema as', autocomplete: 'off' });
  const saved = () => ({ ...opt(T, 'saved', {}) });
  function renderSaved(selected = '') {
    const names = Object.keys(saved()).sort();
    clear(savedSel, h('option', { value: '' }, names.length ? 'Saved schemas…' : 'No saved schemas'), names.map((n) => h('option', { value: n }, n)));
    savedSel.value = names.includes(selected) ? selected : '';
  }
  const savedBox = h('div', { class: 'row dt-fake-saved' }, savedSel,
    h('button', { type: 'button', class: 'btn sm', onclick: () => {
      const s = saved()[savedSel.value];
      if (!s) return toast('Pick a saved schema first');
      columns = s.map(F.normalizeColumn); saveName.value = savedSel.value; schemaChanged(); toast(`Loaded “${savedSel.value}”`, 'ok');
    } }, 'Load'),
    h('button', { type: 'button', class: 'btn sm', onclick: () => {
      const name = savedSel.value;
      if (!name) return;
      const all = saved(); delete all[name]; setOpt(T, 'saved', all); renderSaved(); toast(`Deleted “${name}”`);
    } }, 'Delete'),
    saveName,
    h('button', { type: 'button', class: 'btn sm', onclick: () => {
      const name = saveName.value.trim();
      if (!name) { saveName.focus(); return toast('Give the schema a name'); }
      setOpt(T, 'saved', { ...saved(), [name]: clone(columns) }); renderSaved(name); toast(`Saved “${name}”`, 'ok');
    } }, 'Save schema'),
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { columns = clone(F.EXAMPLE_SCHEMA); schemaChanged(); } }, 'Example'));
  renderSaved();

  /* ---------- schema editor */
  const typeSelect = (value, onChange) => {
    const groups = [...new Set(F.TYPES.map((t) => t.group))];
    return h('select', { value, 'aria-label': 'Column type', onchange: (e) => onChange(e.target.value) },
      groups.map((g) => h('optgroup', { label: g }, F.TYPES.filter((t) => t.group === g).map((t) => h('option', { value: t.value }, t.label)))));
  };
  const list = h('div', { class: 'dt-fake-cols', role: 'list', 'aria-label': 'Columns' });

  function paramInput(col, p, i) {
    const id = `${p.label} for ${col.name || `column ${i + 1}`}`;
    const set = (v) => { col[p.key] = v; persist(); };
    let el;
    if (p.type === 'select') {
      el = h('select', { 'aria-label': id, value: String(col[p.key]), onchange: () => { set(el.value); refresh(); } },
        p.options.map(([v, l]) => h('option', { value: v }, l)));
    } else {
      el = h('input', { type: p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text', 'aria-label': id,
        class: p.type === 'text' ? 'mono' : '', value: String(col[p.key] ?? ''), spellcheck: false,
        oninput: () => { set(p.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value); liveRefresh(); } });
    }
    return h('label', { class: `dt-fake-param ${p.type}` }, h('span', { class: 'muted small' }, p.label), el);
  }

  function renderColumns() {
    clear(list, columns.map((col, i) => {
      const t = F.TYPE_MAP[col.type];
      const label = col.name || `column ${i + 1}`;
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= columns.length) return;
        [columns[i], columns[j]] = [columns[j], columns[i]];
        schemaChanged();
        list.children[j]?.querySelector(`[data-move="${d}"]`)?.focus();
      };
      return h('div', { class: 'dt-fake-col', role: 'listitem' },
        h('input', { type: 'text', class: 'mono dt-fake-name', value: col.name, placeholder: 'column', 'aria-label': `Name of column ${i + 1}`,
          spellcheck: false, oninput: (e) => { col.name = e.target.value; persist(); liveRefresh(); } }),
        typeSelect(col.type, (v) => { columns[i] = F.normalizeColumn({ name: col.name, nullPct: col.nullPct, type: v }); schemaChanged(); }),
        h('label', { class: 'dt-fake-param dt-fake-null', title: 'Share of rows that get NULL' }, h('span', { class: 'muted small' }, 'Null %'),
          h('input', { type: 'number', min: 0, max: 100, value: String(col.nullPct), 'aria-label': `Null percent for ${label}`,
            oninput: (e) => { col.nullPct = Math.min(100, Math.max(0, Number(e.target.value) || 0)); persist(); liveRefresh(); } })),
        h('div', { class: 'dt-fake-move' },
          h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Move ${label} up`, dataset: { move: '-1' }, disabled: i === 0, onclick: () => move(-1) }, '↑'),
          h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Move ${label} down`, dataset: { move: '1' }, disabled: i === columns.length - 1, onclick: () => move(1) }, '↓'),
          h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Remove ${label}`, onclick: () => { columns.splice(i, 1); schemaChanged(); } }, '✕')),
        h('div', { class: 'dt-fake-params' }, (t.params || []).map((p) => paramInput(col, p, i))));
    }));
  }
  const addBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => {
    let n = columns.length + 1;
    while (columns.some((c) => c.name === `col_${n}`)) n++;
    columns.push(F.normalizeColumn({ name: `col_${n}`, type: 'int' }));
    schemaChanged();
    list.lastElementChild?.querySelector('input')?.focus();
  } }, '+ Add column');

  const persist = debounce(() => setOpt(T, 'schema', columns), 300);
  function schemaChanged() { renderColumns(); persist(); refresh(); }

  /* ---------- output */
  const status = notice();
  const domainNote = notice();
  const previewBox = h('div', {});
  const outPre = h('pre', { class: 'code dt-fake-out', tabindex: 0, 'aria-label': 'Output preview' });
  const progress = h('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: { width: '0%' } }));
  const progressText = h('span', { class: 'muted small', role: 'status' });
  const runBtns = [];
  const runBtn = (label, cls, fn) => { const b = h('button', { type: 'button', class: `btn sm ${cls}`, onclick: fn }, label); runBtns.push(b); return b; };
  const cancelBtn = h('button', { type: 'button', class: 'btn sm danger', hidden: true, onclick: () => { if (running) running.cancelled = true; } }, 'Cancel');

  const rowCount = () => Math.min(MAX_ROWS, Math.max(1, Math.trunc(Number(rowsIn.value)) || 1));
  const opts = () => ({ table: tableIn.value.trim() || 'fake_data' });

  function check() {
    const errs = F.validateSchema(columns);
    if (errs.length) { show(status, 'err', errs.slice(0, 4).join(' ')); return false; }
    if (Number(rowsIn.value) > MAX_ROWS) show(status, 'warn', `Capped at ${fmt.int(MAX_ROWS)} rows.`);
    else show(status, '');
    const unsafe = [...new Set(columns.filter((c) => c.type === 'email').flatMap((c) => F.splitList(c.domains)).filter((d) => !F.isSafeDomain(d)))];
    if (unsafe.length) show(domainNote, 'warn', `${unsafe.join(', ')} may be a real domain — generated addresses could belong to real people. Prefer example.com or *.test.`);
    else show(domainNote, '');
    return true;
  }

  function refresh() {
    try {
      if (!check()) { clear(previewBox); outPre.textContent = ''; return; }
      const g = F.createGenerator(columns, seedIn.value);
      const rows = g.next(Math.min(PREVIEW, rowCount()));
      const head = g.columns.map((c) => c.name);
      clear(previewBox, h('div', { class: 'table-wrap dt-fake-table' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, head.map((c) => h('th', { scope: 'col', title: c }, c)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, r.map((v) => {
          const s = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return h('td', { class: v === null ? 'muted' : '', title: s }, s);
        })))))));
      outPre.textContent = F.formatRows(format.value, g.columns, rows, opts());
      progressText.textContent = rowCount() > PREVIEW ? `Preview of ${PREVIEW} of ${fmt.int(rowCount())} rows — same seed, same rows.` : `${rows.length} rows — same seed, same rows.`;
    } catch (e) {
      clear(previewBox); outPre.textContent = '';
      show(status, 'err', e.message || String(e));
    }
  }
  const liveRefresh = debounce(refresh, 200);

  /** Full run in chunks so the page stays responsive; resolves with the text, or null when cancelled/failed. */
  async function generateAll() {
    if (running) return null;
    if (!check()) return null;
    const total = rowCount();
    const me = { cancelled: false };
    running = me;
    for (const b of runBtns) b.disabled = true;
    cancelBtn.hidden = false; progress.hidden = false;
    const bar = progress.firstChild;
    try {
      const g = F.createGenerator(columns, seedIn.value);
      const parts = [];
      for (let done = 0; done < total;) {
        const n = Math.min(CHUNK, total - done);
        parts.push(F.formatRows(format.value, g.columns, g.next(n), { ...opts(), first: done === 0, last: done + n >= total }));
        done += n;
        const pct = Math.round((done / total) * 100);
        bar.style.width = `${pct}%`; progress.setAttribute('aria-valuenow', pct);
        progressText.textContent = `Generating ${fmt.int(done)} / ${fmt.int(total)} rows…`;
        await tick();
        if (me.cancelled) { progressText.textContent = 'Cancelled.'; return null; }
      }
      const text = parts.join('');
      progressText.textContent = `${fmt.int(total)} rows · ${fmt.bytes(new Blob([text]).size)}`;
      return text;
    } catch (e) {
      toastError(e);
      progressText.textContent = '';
      return null;
    } finally {
      running = null;
      for (const b of runBtns) b.disabled = false;
      cancelBtn.hidden = true; progress.hidden = true; bar.style.width = '0%';
    }
  }

  const ext = () => F.FORMATS.find((f) => f.value === format.value)?.ext || 'txt';
  const mime = { csv: 'text/csv', json: 'application/json', jsonl: 'application/x-ndjson', sql: 'application/sql', md: 'text/markdown' };
  const actions = h('div', { class: 'row' },
    runBtn('⬇ Generate & download', 'primary', async () => {
      const text = await generateAll();
      if (text === null) return;
      const url = URL.createObjectURL(new Blob([text], { type: `${mime[format.value] || 'text/plain'};charset=utf-8` }));
      h('a', { href: url, download: `${(tableIn.value.trim() || 'fake_data').replace(/[^\w.-]+/g, '_')}.${ext()}` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }),
    runBtn('Copy all', '', async () => {
      const text = await generateAll();
      if (text !== null) copyText(text, `Copied ${fmt.int(rowCount())} rows`);
    }),
    h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(outPre.textContent, 'Preview copied') }, 'Copy preview'),
    cancelBtn, progressText);

  renderColumns();
  refresh();

  return {
    el: h('div', { class: 'stack dt-tool dt-fake' },
      h('div', { class: 'row dt-fake-settings' },
        labelled('Rows', rowsIn),
        labelled('Seed', h('span', { class: 'row dt-nowrap' }, seedIn, newSeed)),
        h('div', { class: 'stack dt-fake-format' }, h('span', { class: 'small', style: { fontWeight: 500 } }, 'Format'), format),
        tableField),
      h('div', { class: 'stack dt-fake-schema' },
        h('div', { class: 'row' }, h('b', {}, 'Columns'), h('span', { class: 'muted small' }, `Name · type · options · null %`)),
        list, h('div', { class: 'row' }, addBtn)),
      savedBox,
      status, domainNote,
      actions, progress,
      previewBox,
      outPre),
    clear() {
      if (running) running.cancelled = true;
      columns = clone(F.EXAMPLE_SCHEMA);
      rowsIn.value = 1000; seedIn.value = '42'; saveName.value = '';
      setOpt(T, 'rows', 1000); setOpt(T, 'seed', '42');
      schemaChanged();
    },
    focus() { list.querySelector('input')?.focus(); },
  };
}
