// 📜 JSONL inspector: stream a .jsonl / .ndjson file (or pasted text) line by line in this page — counts, bad
// lines, key frequencies, a preview table, extracting one key path and filtering rows. Nothing is uploaded.

import { checkbox, dataTable, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, downloadText, fmt, h, loadCss } from '../../../core/dom.js';
import { area, dropZone, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './jsonl.logic.js';

const T = 'jsonl';
const SHOW_VALUES = 1000;    // values shown in the extract box (Copy / CSV take all of them)
const MAX_VALUES = 5_000_000; // keep memory bounded on huge files
const CHUNK = 256 * 1024;

export default function build() {
  loadCss('/static/css/devtools-pipeline.css');

  /* ---------------- inputs */
  const input = area({ rows: 8, placeholder: '{"image_id": 1, "predictions": [{"label": "dent", "score": 0.91}]}\n{"image_id": 2, "predictions": []}', 'aria-label': 'JSONL text' });
  const fileChip = h('div', { class: 'row', hidden: true });
  const progress = h('progress', { class: 'dt-jl-progress', max: 1, value: 0, 'aria-label': 'Progress' });
  const progressText = h('span', { class: 'muted small' });
  const cancelBtn = h('button', { type: 'button', class: 'btn sm danger', onclick: () => cancel() }, 'Cancel');
  const progressRow = h('div', { class: 'row dt-nowrap', hidden: true }, progress, progressText, cancelBtn);
  const status = notice();
  const summary = h('div', { class: 'stack' });
  const keysOut = h('div', { class: 'stack' });
  const invalidOut = h('div', { class: 'stack' });
  const previewOut = h('div', { class: 'stack' });

  const previewN = segmented([10, 20, 50, 100].map((n) => ({ value: n, label: String(n) })), opt(T, 'preview', 20),
    (v) => { setOpt(T, 'preview', v); analyse(); });

  const pathIn = h('input', { type: 'text', class: 'mono', placeholder: 'image_id  ·  predictions.0.score  ·  predictions[].label', 'aria-label': 'Key path to extract', list: 'dt-jl-paths' });
  const pathList = h('datalist', { id: 'dt-jl-paths' });
  let uniqueOnly = opt(T, 'unique', false);
  const uniqueBox = checkbox('Unique only', uniqueOnly, (v) => { uniqueOnly = v; setOpt(T, 'unique', v); renderExtract(); });
  const extractStatus = notice();
  const extractBox = h('textarea', { class: 'dt-input mono', rows: 8, readonly: true, 'aria-label': 'Extracted values', hidden: true });
  const extractActions = h('div', { class: 'row', hidden: true });

  const filterIn = h('input', { type: 'text', class: 'mono', placeholder: 'score > 0.5  ·  damage_name == "dent"  ·  predictions[].label contains scratch  ·  error exists', 'aria-label': 'Filter expression' });
  const filterStatus = notice();
  const filterOut = h('div', { class: 'stack' });

  /* ---------------- source + streaming */
  let file = null, job = null;
  let extracted = null;  // { path, values }
  let matched = null;    // { expr, lines }

  function cancel() { if (job) job.cancelled = true; }

  /** Calls onLine(line) for each line of the current source; resolves { cancelled, lines }. One job at a time. */
  async function scan(label, onLine) {
    cancel();
    const me = { cancelled: false };
    job = me;
    let lines = 0, last = performance.now();
    const split = L.lineSplitter();
    const total = file ? file.size : input.value.length;
    const showProgress = total > CHUNK;
    progressRow.hidden = !showProgress;
    progressText.textContent = `${label}…`;
    progress.value = 0;
    const feed = (arr) => { for (const l of arr) { lines++; onLine(l); } };
    const tick = async (done) => {
      if (showProgress) {
        progress.value = total ? done / total : 1;
        progressText.textContent = `${label}: ${fmt.int(lines)} lines · ${file ? `${fmt.bytes(done)} / ${fmt.bytes(total)}` : `${Math.round((100 * done) / (total || 1))}%`}`;
      }
      if (performance.now() - last > 40) { await new Promise((r) => setTimeout(r)); last = performance.now(); }  // let the page breathe
    };
    try {
      if (file) {
        const reader = file.stream().getReader();
        const dec = new TextDecoder('utf-8');
        let done = 0;
        for (;;) {
          if (me.cancelled) { await reader.cancel(); break; }
          const { done: end, value } = await reader.read();
          if (end) { feed(split.push(dec.decode())); break; }
          done += value.length;
          feed(split.push(dec.decode(value, { stream: true })));
          await tick(done);
        }
      } else {
        const text = input.value;
        for (let i = 0; i < text.length; i += CHUNK) {
          if (me.cancelled) break;
          feed(split.push(text.slice(i, i + CHUNK)));
          await tick(i + CHUNK);
        }
      }
      if (!me.cancelled) feed(split.end());
    } finally {
      if (job === me) { job = null; progressRow.hidden = true; }
    }
    return { cancelled: me.cancelled, lines };
  }

  const hasSource = () => !!file || !!input.value.trim();

  /* ---------------- analyse */
  async function analyse() {
    try {
      if (!hasSource()) { cancel(); show(status, ''); clearOutputs(); return; }
      const stats = L.createStats({ preview: previewN.value, maxInvalid: 50, maxPaths: 500, depth: 3 });
      const res = await scan('Reading', (l) => stats.add(l));
      if (res.cancelled && job) {  // superseded by another scan (extract / filter / new input)
        show(status, 'warn', 'Reading was interrupted by another action. ',
          h('button', { type: 'button', class: 'btn sm', onclick: () => analyse() }, '↻ Read again'));
        return;
      }
      renderStats(stats.result(), res.cancelled);
    } catch (e) { show(status, 'err', `✗ Could not read: ${e.message || e}`); }
  }

  function renderStats(r, cancelled) {
    const size = file ? file.size : new TextEncoder().encode(input.value).length;
    const head = `${fmt.int(r.valid)} valid · ${fmt.int(r.invalid)} invalid · ${fmt.int(r.blank)} blank of ${fmt.int(r.total)} lines`;
    if (cancelled) show(status, 'warn', `Cancelled after ${fmt.int(r.total)} lines — partial results. ${head}`);
    else if (!r.valid && r.invalid) show(status, 'err', `✗ No valid JSON lines. ${head}`);
    else show(status, r.invalid ? 'warn' : 'ok', `${r.invalid ? '' : '✓ '}${head}`);
    const types = Object.entries(r.rootTypes).map(([t, n]) => `${fmt.int(n)} ${t}`).join(', ');
    clear(summary, h('div', { class: 'stats' }, [
      ['lines', fmt.int(r.total)], ['valid', fmt.int(r.valid)], ['invalid', fmt.int(r.invalid)], ['blank', fmt.int(r.blank)],
      ['size', fmt.bytes(size)], ['avg line', `${fmt.int(Math.round(r.avgLen))} chars`],
      ['shortest', `${fmt.int(r.minLen)} chars`], ['longest', `${fmt.int(r.maxLen)} chars${r.maxLine ? ` (line ${r.maxLine})` : ''}`],
    ].map(([k, v]) => h('span', {}, h('b', {}, v), ` ${k}`))),
    types && h('span', { class: 'muted small' }, `Row types: ${types}`));

    clear(pathList, r.keys.map((k) => h('option', { value: k.path })));
    clear(keysOut, r.keys.length ? [
      h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-jl-keys' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Key path'), h('th', {}, 'Rows'), h('th', {}, '% of rows'), h('th', {}, 'Types'))),
        h('tbody', {}, r.keys.map((k) => h('tr', {},
          h('td', {}, h('button', { type: 'button', class: 'dt-jl-path mono', title: 'Extract this key', onclick: () => { pathIn.value = k.path; extract(); } }, k.path)),
          h('td', { class: 'num' }, fmt.int(k.count)),
          h('td', { class: 'num' }, h('span', { class: 'dt-jl-bar', style: { '--pct': `${k.pct}%` } }, `${k.pct.toFixed(1)}%`)),
          h('td', { class: 'small' }, k.types.join(', '))))))),
      r.pathsTruncated && h('p', { class: 'muted small' }, 'Only the first 500 distinct key paths are counted (objects keyed by ids create a path per id).'),
      h('p', { class: 'muted small' }, 'Up to 3 levels deep; [] means "any element of the array". Click a path to extract it.'),
    ] : h('p', { class: 'muted small' }, 'No object rows to count keys in.'));

    clear(invalidOut, r.invalidLines.length ? h('details', { open: r.valid === 0 },
      h('summary', {}, `Invalid lines (${r.invalid > r.invalidLines.length ? `first ${r.invalidLines.length} of ${fmt.int(r.invalid)}` : fmt.int(r.invalid)})`),
      dataTable(r.invalidLines.map((x) => ({ line: String(x.line), error: x.error, text: x.text })), ['line', 'error', 'text'])) : null);

    const cols = [];
    for (const p of r.preview) {
      const keys = p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? Object.keys(p.value) : ['(value)'];
      for (const k of keys) if (!cols.includes(k) && cols.length < 30) cols.push(k);
    }
    clear(previewOut, r.preview.length ? dataTable(r.preview.map((p) => {
      const row = { line: String(p.line) };
      const isObj = p.value && typeof p.value === 'object' && !Array.isArray(p.value);
      for (const c of cols) row[c] = L.cellText(isObj ? p.value[c] : c === '(value)' ? p.value : undefined);
      return row;
    }), ['line', ...cols]) : h('p', { class: 'muted small' }, 'No valid rows to preview.'));
  }

  function clearOutputs() {
    clear(summary); clear(keysOut); clear(invalidOut); clear(previewOut); clear(pathList);
    extracted = null; renderExtract(); matched = null; renderFilter();
  }

  /* ---------------- extract */
  async function extract() {
    try {
      const path = pathIn.value.trim();
      if (!path) { extracted = null; renderExtract(); return; }
      if (!hasSource()) { show(extractStatus, 'warn', 'Drop a file or paste JSONL first.'); return; }
      const values = [];
      let rows = 0, missing = 0, capped = false;
      const res = await scan('Extracting', (l) => {
        const r = L.parseLine(l);
        if (r.blank || r.error) return;
        rows++;
        const vs = L.valuesAt(r.value, path);
        if (!vs.length) { missing++; return; }
        if (values.length + vs.length > MAX_VALUES) { capped = true; return; }
        values.push(...vs);
      });
      if (res.cancelled && job) return;
      extracted = { path, values, rows, missing, capped, cancelled: res.cancelled };
      renderExtract();
    } catch (e) { show(extractStatus, 'err', `✗ ${e.message || e}`); }
  }

  const keyOf = (v) => (typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v)}`);
  const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  function currentValues() {
    if (!extracted) return [];
    if (!uniqueOnly) return extracted.values;
    const seen = new Set();
    return extracted.values.filter((v) => { const k = keyOf(v); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function renderExtract() {
    extractBox.hidden = extractActions.hidden = !extracted;
    if (!extracted) { show(extractStatus, ''); extractBox.value = ''; return; }
    const vals = currentValues();
    const unique = uniqueOnly ? vals.length : new Set(extracted.values.map(keyOf)).size;
    const e = extracted;
    show(extractStatus, e.values.length ? (e.cancelled || e.capped ? 'warn' : 'ok') : 'warn',
      `${fmt.int(e.values.length)} values · ${fmt.int(unique)} unique · found in ${fmt.int(e.rows - e.missing)} of ${fmt.int(e.rows)} rows`
      + (e.missing ? ` · missing in ${fmt.int(e.missing)}` : '') + (e.capped ? ` · stopped at ${fmt.int(MAX_VALUES)} values` : '') + (e.cancelled ? ' · cancelled (partial)' : ''));
    extractBox.value = vals.slice(0, SHOW_VALUES).map(asText).join('\n') + (vals.length > SHOW_VALUES ? `\n… ${fmt.int(vals.length - SHOW_VALUES)} more (Copy / CSV include all)` : '');
    const safeName = e.path.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'values';
    clear(extractActions,
      h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(currentValues().map(asText).join('\n'), `Copied ${fmt.int(vals.length)} values`) }, 'Copy'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => downloadText(L.toCsvColumn(e.path, currentValues()), `${safeName}.csv`) }, '⬇ CSV'),
      uniqueBox);
  }

  /* ---------------- filter */
  async function runFilter() {
    try {
      const expr = filterIn.value.trim();
      if (!expr) { matched = null; renderFilter(); return; }
      const f = L.parseFilter(expr);
      if (f.error) { matched = null; renderFilter(); show(filterStatus, 'err', `✗ ${f.error}`); return; }
      if (!hasSource()) { show(filterStatus, 'warn', 'Drop a file or paste JSONL first.'); return; }
      const lines = [];
      let rows = 0;
      const res = await scan('Filtering', (l) => {
        const r = L.parseLine(l);
        if (r.blank || r.error) return;
        rows++;
        if (L.matchFilter(r.value, f)) lines.push(l);
      });
      if (res.cancelled && job) return;
      matched = { expr, lines, rows, cancelled: res.cancelled };
      renderFilter();
    } catch (e) { show(filterStatus, 'err', `✗ ${e.message || e}`); }
  }

  function renderFilter() {
    if (!matched) { show(filterStatus, ''); clear(filterOut); return; }
    const m = matched;
    show(filterStatus, m.cancelled ? 'warn' : m.lines.length ? 'ok' : 'warn',
      `${fmt.int(m.lines.length)} of ${fmt.int(m.rows)} rows match${m.rows ? ` (${((100 * m.lines.length) / m.rows).toFixed(1)}%)` : ''}${m.cancelled ? ' · cancelled (partial)' : ''}`);
    clear(filterOut, m.lines.length ? [
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => {
          const url = URL.createObjectURL(new Blob(m.lines.map((l) => `${l}\n`), { type: 'application/x-ndjson' }));
          h('a', { href: url, download: 'filtered.jsonl' }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } }, '⬇ Matching lines (.jsonl)'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(m.lines.join('\n'), `Copied ${fmt.int(m.lines.length)} lines`) }, 'Copy')),
      h('pre', { class: 'code dt-jl-sample' }, m.lines.slice(0, 5).map((l) => L.cellText(l, 400)).join('\n') + (m.lines.length > 5 ? `\n… ${fmt.int(m.lines.length - 5)} more` : '')),
    ] : null);
  }

  /* ---------------- wiring */
  function setFile(f) {
    file = f;
    fileChip.hidden = !f;
    input.disabled = !!f;
    clear(fileChip, f && [h('span', { class: 'pill ok' }, '📄 ' + f.name), h('span', { class: 'muted small' }, fmt.bytes(f.size)),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { setFile(null); analyse(); } }, '✕ Close file')]);
  }
  const zone = dropZone('📜 Drop a .jsonl / .ndjson file (or click) — streamed in this page, nothing is uploaded', (f) => {
    input.value = ''; setFile(f); extracted = null; matched = null; renderExtract(); renderFilter(); analyse();
  });
  zone.querySelector('input[type=file]').accept = '.jsonl,.ndjson,.json,.txt,.log,application/x-ndjson,application/json,text/plain';

  const small = () => !file && input.value.length < 2_000_000;
  input.addEventListener('input', debounce(() => {
    analyse().then(() => { if (small() && extracted) extract(); if (small() && matched) runFilter(); });
  }, 300));
  pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); extract(); } });
  filterIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runFilter(); } });
  pathIn.addEventListener('input', debounce(() => { if (small()) extract(); }, 300));
  filterIn.addEventListener('input', debounce(() => { if (small()) runFilter(); }, 300));

  const section = (title, ...kids) => h('section', { class: 'stack dt-jl-section', 'aria-label': title }, h('h3', { class: 'dt-jl-h' }, title), ...kids);

  return {
    el: h('div', { class: 'stack dt-tool dt-jsonl' },
      zone, fileChip, labelled('…or paste JSONL', input), progressRow, status, summary, invalidOut,
      section('Keys', keysOut),
      section('Preview', h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'First rows'), previewN), previewOut),
      section('Extract a key',
        h('div', { class: 'row dt-nowrap' }, pathIn, pathList, h('button', { type: 'button', class: 'btn', onclick: extract }, 'Extract')),
        extractStatus, extractBox, extractActions),
      section('Filter rows',
        h('div', { class: 'row dt-nowrap' }, filterIn, h('button', { type: 'button', class: 'btn', onclick: runFilter }, 'Filter')),
        h('p', { class: 'muted small' }, 'Ops: == != > < >= <= contains (case-insensitive; on arrays: has element) exists, !exists. Paths with [] match when any element matches. Values are JSON when they parse ("1" vs 1 compare equal).'),
        filterStatus, filterOut)),
    focus: () => input.focus(),
    clear() {
      cancel(); setFile(null); input.value = ''; pathIn.value = ''; filterIn.value = '';
      show(status, ''); show(extractStatus, ''); show(filterStatus, ''); progressRow.hidden = true; clearOutputs();
    },
  };
}
