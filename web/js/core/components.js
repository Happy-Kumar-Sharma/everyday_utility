// Reusable UI building blocks shared by every service tab.

import { api, downloadUrl, get, post } from './api.js';
import { clear, copyText, fmt, h, modal, store, toast, toastError } from './dom.js';

/* ------------------------------------------------------------------ segmented control */
/** options: [{value, label}] ; returns element with .value getter/setter */
export function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const render = () => clear(el, options.map((o) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(o.value === value), class: o.value === value ? 'on' : '',
    title: o.title, onclick: () => { value = o.value; render(); onChange?.(value); },
  }, o.label)));
  render();
  Object.defineProperty(el, 'value', { get: () => value, set: (v) => { value = v; render(); } });
  return el;
}

export function checkbox(label, checked, onChange, title) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange?.(input.checked) });
  return h('label', { class: 'check', title }, input, label);
}

/* ------------------------------------------------------------------ code block with copy */
export function codeBlock(text = '', { maxHeight } = {}) {
  const pre = h('pre', { class: 'code', style: maxHeight ? { maxHeight } : null });
  const wrap = h('div', { class: 'code-wrap' }, pre,
    h('button', { class: 'btn sm copy-btn', type: 'button', onclick: () => copyText(pre.textContent) }, 'Copy'));
  wrap.set = (t) => { pre.textContent = t; };
  wrap.set(text);
  return wrap;
}

/* ------------------------------------------------------------------ data table */
export function dataTable(rows, columns) {
  columns = columns || (rows[0] ? Object.keys(rows[0]) : []);
  if (!rows.length) return h('p', { class: 'muted small' }, 'No rows.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { title: c }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { title: r[c] ?? '' }, r[c] ?? '')))))));
}

/** Loads a CSV/Excel via /api/files/inspect and shows rows + preview table + download link. */
export async function filePreview(path, { rows = 20 } = {}) {
  const info = await get('/api/files/inspect', { path, rows });
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 'pill ok' }, `${fmt.int(info.row_count)} rows`),
      h('span', { class: 'muted small mono' }, info.path),
      h('span', { style: { flex: 1 } }),
      h('a', { class: 'btn sm', href: downloadUrl(info.path) }, '⬇ Download')),
    dataTable(info.preview, info.columns));
}

/* ------------------------------------------------------------------ file browser */
/**
 * Server-side file browser. Resolves with the chosen path, or undefined if dismissed.
 * mode 'tabular' lists CSV/Excel files, 'any' lists every file, 'dir' picks a folder.
 */
export function browseFiles(startPath = '', { mode = 'tabular' } = {}) {
  const dirMode = mode === 'dir';
  const memoKey = dirMode ? 'eu.browse.lastDir' : 'eu.browse.last';
  return modal(dirMode ? 'Choose a folder' : 'Choose a file', (close) => {
    const pathInput = h('input', { type: 'text', class: 'mono', placeholder: '/path/to/folder' });
    const list = h('div', { class: 'fs-list' });
    const quick = h('div', { class: 'chips' });
    let current = '';
    async function open(path) {
      try {
        const res = await get('/api/fs/list', { path, only_tabular: mode === 'tabular', show_hidden: mode === 'any' });
        current = res.path;
        pathInput.value = res.path;
        const files = dirMode ? [] : res.files;
        clear(list,
          res.parent && h('button', { class: 'fs-item', onclick: () => open(res.parent) }, '⬆️', h('span', { class: 'grow' }, '..')),
          res.dirs.map((d) => h('button', { class: 'fs-item', onclick: () => open(d.path) }, '📁', h('span', { class: 'grow' }, d.name))),
          files.map((f) => h('button', { class: 'fs-item', onclick: () => close(f.path), title: f.path },
            '📄', h('span', { class: 'grow' }, f.name), h('span', { class: 'muted small' }, `${fmt.bytes(f.size)} · ${fmt.ago(f.mtime)}`))),
          !res.dirs.length && !files.length && h('div', { class: 'fs-item muted' }, dirMode ? 'No sub-folders' : 'No matching files here'));
      } catch (e) { toastError(e); }
    }
    for (const [label, p] of [['🏠 Home', '~'], ['⬇ Downloads', '~/Downloads'], ['💼 workspace', '~/workspace']]) {
      quick.append(h('button', { class: 'chip', type: 'button', onclick: () => open(p) }, label));
    }
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(pathInput.value); });
    open(startPath || store.get(memoKey, dirMode ? '~/workspace' : '~/Downloads'));
    return h('div', { class: 'stack' }, quick, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathInput,
      h('button', { class: 'btn', onclick: () => open(pathInput.value) }, 'Go'),
      dirMode && h('button', { class: 'btn primary', onclick: () => close(current) }, 'Select this folder')), list,
      h('p', { class: 'muted small', style: { margin: 0 } }, dirMode ? 'Open a folder, then “Select this folder”.'
        : mode === 'tabular' ? 'Newest files first. Only .csv / .tsv / .txt / .xlsx / .xls are listed.' : 'Newest files first. Dotfiles like .env are shown.'));
  }).then((path) => {
    if (path) store.set(memoKey, dirMode ? path : path.replace(/\/[^/]*$/, ''));
    return path;
  });
}

/* ------------------------------------------------------------------ file picker */
/**
 * Upload (drag & drop / click) or point at a local path. Calls onLoad(info) with
 * {path, name, sheets, sheet, columns, row_count, preview} or onLoad(null) when cleared.
 */
export function filePicker({ storageKey, onLoad }) {
  const el = h('div', { class: 'stack' });
  let info = null;

  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.xls', hidden: true,
    onchange: () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) upload(f); } });  // reset so re-picking the same file fires again
  const pathInput = h('input', { type: 'text', class: 'mono', placeholder: '/home/…/file.csv  (Enter to load)',
    onkeydown: (e) => { if (e.key === 'Enter') load(pathInput.value); } });

  async function upload(file) {
    const form = new FormData();
    form.append('file', file);
    try {
      busy(`Uploading ${file.name}…`);
      const res = await api('/api/files/upload', { method: 'POST', form });
      await load(res.path);
    } catch (e) { toastError(e); renderEmpty(); }
  }

  async function load(path, sheet, { silent = false } = {}) {
    if (!path?.trim()) return;
    const had = info !== null;
    try {
      busy('Reading file…');
      info = await get('/api/files/inspect', { path: path.trim(), sheet, rows: 10 });
      if (storageKey) store.set(storageKey, { path: info.path, sheet: info.sheet });
      renderLoaded();
      onLoad?.(info);
    } catch (e) {
      if (silent) { if (storageKey) store.set(storageKey, null); } else toastError(e);
      renderEmpty(path);
      if (had) onLoad?.(null);  // the consumer must not keep using the previous file
    }
  }

  function busy(msg) { clear(el, h('div', { class: 'dropzone' }, h('span', { class: 'big' }, '⏳'), msg)); }

  function renderEmpty(path = '') {
    info = null;
    pathInput.value = path;
    const zone = h('div', { class: 'dropzone', tabindex: 0, role: 'button',
      onclick: () => fileInput.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
      ondragover: (e) => { e.preventDefault(); zone.classList.add('drag'); },
      ondragleave: () => zone.classList.remove('drag'),
      ondrop: (e) => { e.preventDefault(); zone.classList.remove('drag'); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); },
    }, h('span', { class: 'big' }, '📂'), h('b', {}, 'Drop a CSV / Excel file or click to upload'),
      h('span', { class: 'muted small' }, '.csv  .tsv  .txt  .xlsx  .xls'));
    clear(el, zone, fileInput,
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathInput,
        h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await browseFiles(); if (p) load(p); } }, 'Browse…'),
        h('button', { class: 'btn', type: 'button', onclick: () => load(pathInput.value) }, 'Load')));
  }

  function renderLoaded() {
    const sheetSel = info.sheets.length > 1 && h('select', { style: { width: 'auto' }, value: info.sheet || info.sheets[0],
      onchange: () => load(info.path, sheetSel.value) }, info.sheets.map((s) => h('option', { value: s }, s)));
    clear(el, h('div', { class: 'file-chip' }, h('span', { class: 'big' }, '📄'),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, info.name),
        h('div', { class: 'muted small' }, `${fmt.int(info.row_count)} rows · ${info.columns.length} columns`)),
      sheetSel,
      h('button', { class: 'btn sm', type: 'button', title: 'Re-read the file from disk', onclick: () => load(info.path, info.sheet) }, '↻'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { renderEmpty(info.path); onLoad?.(null); } }, 'Change')));
  }

  renderEmpty();
  const saved = storageKey && store.get(storageKey);
  if (saved?.path) load(saved.path, saved.sheet, { silent: true });  // reopen the last file; quietly falls back to empty

  return { el, load, get info() { return info; } };
}

/* ------------------------------------------------------------------ column chips */
export function columnPicker(columns, selected, onChange) {
  const el = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Column' });
  const render = () => clear(el, columns.map((c) => h('button', {
    type: 'button', class: `chip ${c === selected ? 'on' : ''}`, role: 'radio', 'aria-checked': String(c === selected),
    onclick: () => { selected = c; render(); onChange(c); },
  }, c)));
  render();
  return el;
}

/* ------------------------------------------------------------------ job console */
const STATUS_PILL = { running: 'run', succeeded: 'ok', failed: 'err', cancelled: 'warn' };

export function statusPill(status) {
  return h('span', { class: `pill ${STATUS_PILL[status] || ''}` }, status);
}

/**
 * Live log viewer for a background job. Survives server-side reconnects by resuming from the
 * last committed line. onDone(job) fires once when the job finishes.
 */
export function jobConsole(job, { onDone } = {}) {
  const lines = [];
  let partial = '';
  let since = 0;
  let source = null;
  let finished = false;
  let follow = true;
  let retry = 0;

  const pre = h('pre', { class: 'console', onscroll: () => {
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  } });
  const pill = h('span', {});
  const elapsed = h('span', { class: 'muted small' });
  const cancelBtn = h('button', { class: 'btn sm danger', type: 'button', onclick: cancel }, 'Cancel');
  const el = h('div', { class: 'job' },
    h('div', { class: 'job-head' }, pill, h('span', { class: 'title' }, job.title), elapsed, h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(lines.concat(partial ? [partial] : []).join('\n'), 'Log copied') }, 'Copy log'),
      h('a', { class: 'btn sm', href: `/api/jobs/${job.id}/log` }, 'Full log'),
      cancelBtn),
    pre);

  function setState(j) {
    job = j;
    clear(pill, statusPill(j.status));
    elapsed.textContent = fmt.duration(j.duration) + (j.exit_code != null && j.status !== 'succeeded' ? ` · exit ${j.exit_code}` : '');
    cancelBtn.hidden = j.status !== 'running';
  }

  function render() {
    // keep the DOM bounded; the full log is on disk
    if (lines.length > 4000) lines.splice(0, lines.length - 4000);
    pre.textContent = lines.join('\n') + (lines.length ? '\n' : '');
    if (partial) pre.append(h('span', { class: 'partial' }, partial));
    if (follow) pre.scrollTop = pre.scrollHeight;
  }

  function connect() {
    source = new EventSource(`/api/jobs/${job.id}/stream?since=${since}`);
    source.addEventListener('output', (e) => {
      const out = JSON.parse(e.data);
      lines.push(...out.lines);
      since = out.start + out.lines.length;
      partial = out.partial;
      render();
    });
    source.addEventListener('done', (e) => {
      finished = true;
      source.close();
      setState(JSON.parse(e.data));
      stopTimer();
      onDone?.(job);
    });
    source.onerror = async () => {
      source.close();
      if (finished || !el.isConnected) return;
      try {
        const j = await get(`/api/jobs/${job.id}`, { since });
        if (j.status !== 'running') {
          // finished while we were disconnected: take the remaining output and close out
          lines.push(...j.output.lines); partial = j.output.partial; render();
          finished = true; setState(j); stopTimer(); onDone?.(j);
          return;
        }
        retry = 0;
      } catch (e) {
        if (e.status === 404) {
          // jobs live in server memory; after a server restart this one is gone (its log file stays on disk)
          finished = true; stopTimer();
          setState({ ...job, status: 'failed', duration: Date.now() / 1000 - job.started_at });
          partial = ''; lines.push('', '[lost: the server restarted, the job is no longer tracked — see data/jobs/ for its log]'); render();
          onDone?.({ ...job, status: 'failed', lost: true });
          return;
        }
      }
      retry = Math.min(retry + 1, 5);
      setTimeout(connect, 1000 * retry);  // resume from `since`, no duplicates
    };
  }

  async function cancel() {
    try { setState(await post(`/api/jobs/${job.id}/cancel`)); toast('Cancelling…'); } catch (e) { toastError(e); }
  }

  const started = job.started_at;
  const timer = setInterval(() => {
    if (!el.isConnected) { stopTimer(); source?.close(); return; }
    if (job.status === 'running') elapsed.textContent = fmt.duration(Date.now() / 1000 - started);
  }, 1000);
  const stopTimer = () => clearInterval(timer);

  setState(job);
  render();
  connect();
  el.close = () => { finished = true; source?.close(); stopTimer(); };
  return el;
}

/* ------------------------------------------------------------------ settings drawer */
/** Generic editor for a service's declared settings (SettingField list from /api/services). */
export function openSettings(service, values, onApply) {
  const draft = { ...values };
  return modal(`${service.title} — settings`, (close) => {
    const groups = {};
    for (const f of service.settings) (groups[f.group] ||= []).push(f);
    const body = h('div', { class: 'stack', style: { gap: '20px' } });
    for (const [group, fields] of Object.entries(groups)) {
      body.append(h('div', { class: 'settings-group' }, h('h3', {}, group), fields.map((f) => {
        if (f.type === 'bool') return checkbox(f.label, draft[f.key], (v) => { draft[f.key] = v; }, f.help);
        const numeric = f.type === 'int' || f.type === 'float';
        const input = h('input', { type: numeric ? 'number' : 'text', step: f.type === 'float' ? 'any' : null, class: f.type === 'path' ? 'mono' : '',
          value: String(draft[f.key] ?? ''), oninput: () => { draft[f.key] = numeric ? Number(input.value) : input.value; } });
        return h('label', { class: 'field' }, f.label, input, f.help && h('span', { class: 'hint' }, f.help));
      })));
    }
    body.append(h('div', { class: 'row end', style: { position: 'sticky', bottom: '-16px', background: 'var(--surface)', padding: '12px 0' } },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        try { const v = await api(`/api/services/${service.id}/settings`, { method: 'DELETE' }); onApply(v); toast('Settings reset to defaults'); close(); } catch (e) { toastError(e); }
      } }, 'Reset to defaults'),
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { const v = await api(`/api/services/${service.id}/settings`, { method: 'PUT', body: draft }); onApply(v); toast('Settings saved', 'ok'); close(); } catch (e) { toastError(e); }
      } }, 'Save')));
    return body;
  }, { drawer: true });
}
