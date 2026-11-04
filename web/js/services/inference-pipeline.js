// AI Inference Pipeline tab: one card per step, each showing the exact command / SQL it runs,
// with Copy and Run (background job with live logs). Status strip at the top tracks the files
// that flow between steps.

import { get, post } from '../core/api.js';
import {
  checkbox, codeBlock, columnPicker, filePicker, filePreview, jobConsole, openSettings, segmented,
} from '../core/components.js';
import { clear, confirmDialog, fmt, h, store, toast, toastError } from '../core/dom.js';

const API = '/api/inference-pipeline';
const COLLAPSE_KEY = 'eu.pipe.collapsed';

export async function mount(root, { service }) {
  let settings = await get(`/api/services/${service.id}/settings`);
  let status = null;
  let plan = null;
  const collapsed = new Set(store.get(COLLAPSE_KEY, []));
  const body = () => ({ settings });

  /* ---------------- toolbar + status strip ---------------- */
  const statusGrid = h('div', { class: 'status-grid' });
  const warnings = h('div', { class: 'stack' });
  root.append(
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => openSettings(service, settings, (v) => { settings = v; refresh(); }) }, '⚙ Settings'),
      h('button', { class: 'btn', type: 'button', onclick: () => refresh() }, '↻ Refresh'),
      h('span', { class: 'muted small' }, 'Steps run as background jobs; you can switch tabs or reload — running jobs reattach.')),
    statusGrid, warnings);

  const base = (p) => p.split('/').pop();

  function statCard(label, value, sub, extra, title) {
    return h('div', { class: 'card stat-card', title }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value),
      sub && h('span', { class: 'sub' }, sub), extra);
  }

  function renderStatus() {
    if (!status) return;
    const { ids, pred_input_csv: csv, pred_output_jsonl: jsonl, db } = status;
    const pct = csv.exists && jsonl.exists && csv.rows ? Math.min(100, (jsonl.rows / csv.rows) * 100) : 0;
    clear(statusGrid,
      statCard('Image ids', ids.exists ? fmt.int(ids.count) : '—', ids.exists ? `${base(ids.path)} · ${fmt.ago(ids.mtime)}` : 'not written yet', null, ids.path),
      statCard('Images CSV', csv.exists ? fmt.int(csv.rows) : '—', csv.exists ? `${base(csv.path)} · ${fmt.ago(csv.mtime)}` : 'not exported yet', null, csv.path),
      statCard('Predictions', jsonl.exists ? fmt.int(jsonl.rows) : '—', jsonl.exists ? `${base(jsonl.path)} · ${fmt.bytes(jsonl.size)} · ${fmt.ago(jsonl.mtime)}` : 'no JSONL yet',
        csv.exists && jsonl.exists && h('div', { class: 'stack', style: { gap: '2px' } },
          h('div', { class: 'progress', title: `${pct.toFixed(1)}% of CSV rows` }, h('div', { style: { width: `${pct}%` } })),
          h('span', { class: 'sub' }, `${pct.toFixed(1)}% of images CSV`)), jsonl.path),
      statCard('Local DB', db.ok ? '✓ configured' : '✗', db.ok ? db.target : db.error));
    clear(warnings, status.missing_paths.length > 0 && h('div', { class: 'notice warn' },
      `Not found: ${status.missing_paths.join(', ')} — check ⚙ Settings.`));
  }

  async function refresh() {
    try {
      [status, plan] = await Promise.all([post(`${API}/status`, body()), post(`${API}/plan`, body())]);
      renderStatus();
      for (const s of steps) s.update?.();
    } catch (e) { toastError(e); }
  }

  /* ---------------- step scaffolding ---------------- */
  const stepsEl = h('div', { class: 'stack', style: { gap: '12px' } });
  root.append(stepsEl);

  function stepCard(n, key, title, desc, content) {
    const card = h('div', { class: `card step ${collapsed.has(key) ? 'collapsed' : ''}` });
    const toggle = () => {
      card.classList.toggle('collapsed');
      card.classList.contains('collapsed') ? collapsed.add(key) : collapsed.delete(key);
      store.set(COLLAPSE_KEY, [...collapsed]);
    };
    const statusSlot = h('span', {});
    card.append(
      h('div', { class: 'card-head', role: 'button', tabindex: 0, 'aria-expanded': String(!collapsed.has(key)),
        onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      h('span', { class: 'num' }, n), h('div', { class: 'stack', style: { gap: '2px' } }, h('h2', {}, title), h('p', { class: 'desc' }, desc)),
      h('span', { class: 'spacer' }), statusSlot, h('span', { class: 'chev' }, '▾')),
      h('div', { class: 'card-body' }, content));
    card.setStatus = (job) => clear(statusSlot, job && h('span', { class: `pill ${{ running: 'run', succeeded: 'ok', failed: 'err', cancelled: 'warn' }[job.status]}` }, job.status));
    return card;
  }

  /** Run button + job console slot shared by all script/SQL steps. */
  function runner(card, step, { confirm, options = () => ({}), onDone, label = '▶ Run' } = {}) {
    const slot = h('div', { class: 'stack' });
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: start }, label);
    let pollTimer = null;

    async function start() {
      if (confirm && !(await confirmDialog(confirm.title, confirm.message(), { okLabel: confirm.ok || 'Run', danger: confirm.danger }))) return;
      try {
        btn.disabled = true;
        attach(await post(`${API}/run/${step()}`, { ...body(), options: options() }));
      } catch (e) { toastError(e); btn.disabled = false; }
    }

    function attach(job) {
      btn.disabled = true;
      card.setStatus(job);
      clear(slot).append(jobConsole(job, {
        onDone: (j) => {
          btn.disabled = false;
          card.setStatus(j);
          clearInterval(pollTimer);
          toast(`${j.title}: ${j.status}`, j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'err' : '');
          refresh();
          onDone?.(j);
        },
      }));
      if (step() === 'predict' || step() === 'predict_single') {
        pollTimer = setInterval(() => post(`${API}/status`, body()).then((s) => { status = s; renderStatus(); }).catch(() => {}), 4000);
      }
    }
    return { btn, slot, attach };
  }

  /* ---------------- 1 · image ids ---------------- */
  const idsStep = (() => {
    let source = store.get('eu.pipe.idsSource', 'file');
    let fileInfo = null;
    let column = null;
    const resultSlot = h('div', {});
    const current = h('div', { class: 'muted small' });
    const text = h('textarea', { class: 'mono', rows: 6, placeholder: '6838864, 6846942, 7069049 …  (any separators: commas, spaces, new lines)' });
    const fileSlot = h('div', { class: 'stack' });
    const colSlot = h('div', {});
    const picker = filePicker({ storageKey: 'eu.pipe.idsFile', onLoad: (info) => {
      fileInfo = info;
      if (!info) { clear(colSlot); return; }
      column = info.columns.find((c) => /^(image_?id|id)$/i.test(c)) || info.columns[0];
      clear(colSlot, h('div', { class: 'stack' }, h('b', {}, 'Id column'), columnPicker(info.columns, column, (c) => { column = c; })));
    } });
    fileSlot.append(picker.el, colSlot);
    const srcBody = h('div', {});
    const renderSource = () => clear(srcBody, source === 'file' ? fileSlot : text);
    const req = () => (source === 'file'
      ? { source, path: fileInfo?.path || '', column: column || '', sheet: fileInfo?.sheet }
      : { source, text: text.value });

    function summary(r, wrote) {
      return h('div', { class: `notice ${wrote ? 'ok' : ''}` },
        wrote ? `✓ Wrote ${fmt.int(r.count)} ids to ${r.path}` : `${fmt.int(r.count)} unique ids`,
        r.duplicates ? ` · ${fmt.int(r.duplicates)} duplicates dropped` : '',
        r.invalid_count ? ` · ${fmt.int(r.invalid_count)} non-numeric skipped (e.g. ${r.invalid_sample.slice(0, 3).join(', ')})` : '',
        wrote && r.backup ? h('div', { class: 'small' }, `previous file backed up to ${r.backup}`) : '');
    }

    async function check() {
      try { clear(resultSlot, summary(await post(`${API}/ids/parse`, { ...body(), ...req() }), false)); } catch (e) { toastError(e); }
    }
    async function write() {
      try {
        const parsed = await post(`${API}/ids/parse`, { ...body(), ...req() });
        if (!parsed.count) return toastError(new Error('No valid ids found'));
        const ok = await confirmDialog('Overwrite ids file?', h('div', { class: 'stack' },
          h('p', { style: { margin: 0 } }, `Write ${fmt.int(parsed.count)} ids to:`), h('code', {}, settings.ids_file),
          h('p', { class: 'muted small', style: { margin: 0 } }, 'The current file is kept as a timestamped .bak next to it.')), { okLabel: 'Write' });
        if (!ok) return;
        clear(resultSlot, summary(await post(`${API}/ids/write`, { ...body(), ...req() }), true));
        refresh();
      } catch (e) { toastError(e); }
    }

    const card = stepCard(1, 'ids', 'Image ids', 'Pick the images for this run: a column from a CSV/Excel file, or paste ids.', [
      h('div', { class: 'row' }, segmented([{ value: 'file', label: '📄 From file' }, { value: 'text', label: '✍ Paste' }], source,
        (v) => { source = v; store.set('eu.pipe.idsSource', v); renderSource(); })),
      srcBody,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: check }, 'Check'),
        h('button', { class: 'btn primary', type: 'button', onclick: write }, '💾 Write ids file'),
        current),
      resultSlot,
    ]);
    renderSource();
    return {
      card,
      update() {
        const ids = status?.ids;
        clear(current, ids?.exists ? `Current file: ${fmt.int(ids.count)} ids (${ids.sample.slice(0, 4).join(', ')}${ids.count > 4 ? ', …' : ''})` : 'No ids file yet');
      },
    };
  })();

  /* ---------------- 2 · migrate prod -> local ---------------- */
  const migrateStep = (() => {
    const opts = { dry_run: false, replace: false, batch_size: null };
    const code = codeBlock();
    const batch = h('input', { type: 'number', min: 1, placeholder: '500', oninput: () => { opts.batch_size = Number(batch.value) || null; } });
    const card = stepCard(2, 'migrate', 'Load images into local ai_cdb', 'Copies ImageData (and related rows) for the ids file from prod into your local database.', []);
    const run = runner(card, () => 'migrate', {
      options: () => opts,
      confirm: { title: 'Run prod → local migration?', message: () => `Reads ${fmt.int(status?.ids?.count)} images from prod and writes them into the local DB${opts.dry_run ? ' (dry run: every batch is rolled back)' : ''}.` },
    });
    card.querySelector('.card-body').append(code,
      h('div', { class: 'row', style: { gap: '18px' } },
        checkbox('Dry run', false, (v) => { opts.dry_run = v; }, 'do everything but roll back each batch'),
        checkbox('Replace existing', false, (v) => { opts.replace = v; }, 'delete and re-copy images already present locally'),
        h('label', { class: 'check' }, 'Batch size', batch),
        h('span', { style: { flex: 1 } }), run.btn),
      run.slot);
    return { card, run, steps: ['migrate'], update: () => code.set(plan.migrate) };
  })();

  /* ---------------- 3 · export images csv ---------------- */
  const exportStep = (() => {
    const code = codeBlock('', { maxHeight: '220px' });
    const target = h('span', { class: 'muted small mono' });
    const preview = h('div', {});
    const card = stepCard(3, 'export', 'Export images CSV', 'Runs the ImageData query on the local DB (read-only session) and saves the result as the prediction input.', []);
    const run = runner(card, () => 'export_images', {
      onDone: (j) => { if (j.status === 'succeeded') filePreview(j.meta.output).then((el) => clear(preview, el)).catch(toastError); },
    });
    card.querySelector('.card-body').append(code, h('div', { class: 'row' }, h('span', {}, 'Saves to'), target, h('span', { style: { flex: 1 } }), run.btn), run.slot, preview);
    return { card, run, steps: ['export_images'], update() { code.set(plan.export_images); target.textContent = settings.pred_input_csv; } };
  })();

  /* ---------------- 4 · predictions ---------------- */
  const predictStep = (() => {
    let variant = store.get('eu.pipe.predictVariant', 'predict');
    const code = codeBlock();
    const card = stepCard(4, 'predict', 'Run model predictions', 'YoloV11 + damage ensemble over the images CSV. Appends to the JSONL and skips images already done, so it is safe to stop and resume.', []);
    const run = runner(card, () => variant);
    const seg = segmented([
      { value: 'predict', label: '⚡ Batched (parallel)' },
      { value: 'predict_single', label: '🐢 Single model (debug)' },
    ], variant, (v) => { variant = v; store.set('eu.pipe.predictVariant', v); update(); });
    function update() { code.set(variant === 'predict' ? plan.predict : plan.predict_single); }
    card.querySelector('.card-body').append(h('div', { class: 'row' }, seg, h('span', { class: 'muted small' }, 'Workers, queue size, FP16 etc. live in ⚙ Settings.')),
      code, h('div', { class: 'row end' }, run.btn), run.slot);
    return { card, run, steps: ['predict'], update };
  })();

  /* ---------------- 5 · load predictions ---------------- */
  const loadStep = (() => {
    const opts = { dry_run: false, replace: false };
    const code = codeBlock();
    const card = stepCard(5, 'load', 'Load predictions into local DB', 'Inserts the JSONL predictions as DamageDetectionPredictions under the configured AIModels row.', []);
    const run = runner(card, () => 'load', {
      options: () => opts,
      confirm: { title: 'Load predictions into the local DB?', message: () => `Loads ${fmt.int(status?.pred_output_jsonl?.rows)} prediction lines as ${settings.model_name} / ${settings.model_version}${opts.replace ? ', replacing images already loaded for this model' : ''}${opts.dry_run ? ' (dry run)' : ''}.` },
    });
    card.querySelector('.card-body').append(code,
      h('div', { class: 'row', style: { gap: '18px' } },
        checkbox('Dry run', false, (v) => { opts.dry_run = v; }),
        checkbox('Replace existing', false, (v) => { opts.replace = v; }, 'delete and reload images already loaded for this model'),
        h('span', { style: { flex: 1 } }), run.btn),
      run.slot);
    return { card, run, steps: ['load'], update: () => code.set(plan.load) };
  })();

  /* ---------------- 6 · query predictions ---------------- */
  const queryStep = (() => {
    const code = codeBlock('', { maxHeight: '220px' });
    const preview = h('div', {});
    const damage = h('span', { class: 'muted small' });
    const card = stepCard(6, 'query', 'Query predictions', 'Pulls the loaded predictions for the ids (filtered by damage type) into a CSV you can preview and download.', []);
    const run = runner(card, () => 'query_predictions', {
      onDone: (j) => { if (j.status === 'succeeded') filePreview(j.meta.output).then((el) => clear(preview, el)).catch(toastError); },
    });
    card.querySelector('.card-body').append(code, h('div', { class: 'row' }, damage, h('span', { style: { flex: 1 } }), run.btn), run.slot, preview);
    return {
      card, run, steps: ['query_predictions'],
      update() { code.set(plan.query_predictions); damage.textContent = settings.damage_type_ids ? `Damage types: ${settings.damage_type_ids}` : 'All damage types'; },
    };
  })();

  const steps = [idsStep, migrateStep, exportStep, predictStep, loadStep, queryStep];
  stepsEl.append(...steps.map((s) => s.card));

  await refresh();

  // reattach to jobs started earlier (page reload / another tab); newest job per step wins
  try {
    const jobs = await get('/api/jobs');
    for (const s of steps.filter((x) => x.run)) {
      const job = jobs.find((j) => s.steps.includes(j.meta?.step));
      if (!job) continue;
      if (job.status === 'running') s.run.attach(job);
      else s.card.setStatus(job);
    }
  } catch { /* not fatal */ }

  return { onShow: refresh };
}
