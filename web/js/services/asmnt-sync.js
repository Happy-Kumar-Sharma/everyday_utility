// Prod → Staging Sync tab: a two-step stepper around the sync repo's two scripts.
//   Step 1 (PROD VPN):    <python> <sync script> sync_ids --ids … [--reupload]  -> new json ids
//   Step 2 (STAGING VPN): <python> <lookup script> --ids <json ids> …           -> staging assessment ids + OTPs
// Both run as background jobs; runs (ids and results only) are kept server-side and reattach after a reload.

import { api, del, get, post } from '../core/api.js';
import { checkbox, jobConsole, openSettings, statusPill } from '../core/components.js';
import { clear, confirmDialog, copyText, debounce, downloadText, fmt, h, loadCss, store, toast, toastError } from '../core/dom.js';

const API = '/api/asmnt-sync';
const RUN_KEY = 'eu.asmnt.run';
const DRAFT_KEY = 'eu.asmnt.draft';
const EXAMPLE = '0f1e2d3c-4b5a-4697-8877-665544332211';

const SYNC_PILL = {
  synced: ['ok', '✓ synced'], not_found: ['warn', '⚠ not found'], failed: ['err', '✗ failed'],
  pending: ['', 'pending'], skipped: ['', '— lookup only'],
};
const LOOKUP_PILL = {
  found: ['ok', '✓ found'], processing: ['warn', '⏳ processing'], not_found: ['warn', '⚠ not found'],
  failed: ['err', '✗ failed'], pending: ['', 'pending'],
};

function pill(map, state, active, activeLabel) {
  if (active) return h('span', { class: 'pill run' }, activeLabel);
  const [cls, label] = map[state] || ['', state];
  return h('span', { class: `pill ${cls}` }, label);
}

function idCell(value, label) {
  if (!value) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'as-id' }, h('span', { class: 'mono' }, value),
    h('button', { class: 'btn ghost sm as-copy', type: 'button', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
      onclick: (e) => { e.stopPropagation(); copyText(value, `${label} copied`); } }, '⧉'));
}

const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');

export async function mount(root, { service }) {
  loadCss('/static/css/asmnt-sync.css');
  root.classList.add('as-root');

  let settings = await get(`/api/services/${service.id}/settings`);
  let status = null;
  let runs = [];
  let current = null;
  let pollTimer = null;
  const consoles = { sync: null, lookup: null };  // job id currently shown per step

  /* ---------------- header: status strip ---------------- */
  const statusEl = h('div', { class: 'card as-status' });
  const settingsBtn = () => openSettings(service, settings, (v) => { settings = v; loadStatus(); });
  root.append(
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: settingsBtn }, '⚙ Settings'),
      h('button', { class: 'btn', type: 'button', onclick: () => { loadStatus(); loadRuns(); } }, '↻ Refresh'),
      h('span', { class: 'muted small' }, 'Steps run as background jobs; switch tabs or reload — running jobs reattach.')),
    statusEl);

  function probePill(label, p) {
    if (!p || !p.configured) return h('span', { class: 'pill', title: 'Set a host:port in ⚙ Settings → VPN check' }, `${label}: not configured`);
    return h('span', { class: `pill ${p.ok ? 'ok' : 'warn'}`, title: p.detail }, p.ok ? `${label} reachable` : `${label} not reachable`);
  }

  function check(ok, label, title) {
    return h('span', { class: `as-check ${ok ? 'ok' : 'bad'}`, title }, ok ? '✓' : '✗', ' ', label);
  }

  function renderStatus() {
    if (!status) { clear(statusEl, h('span', { class: 'muted small' }, 'Checking…')); return; }
    const { repo_dir: repo, scripts, python, vpn_interfaces: ifs } = status;
    const allOk = repo.exists && scripts.sync_script.exists && scripts.lookup_script.exists && python.found;
    clear(statusEl,
      h('div', { class: 'row' },
        check(repo.exists, 'repo', repo.path),
        check(scripts.sync_script.exists, scripts.sync_script.name, 'step 1 script'),
        check(scripts.lookup_script.exists, scripts.lookup_script.name, 'step 2 script'),
        check(python.found, python.value || 'python', python.path || 'not found'),
        !allOk && h('button', { class: 'btn sm', type: 'button', onclick: settingsBtn }, '⚙ Fix in Settings')),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'VPN interfaces:'),
        ifs.length ? ifs.map((i) => h('span', { class: 'pill', title: i.state ? `state: ${i.state}` : '' }, i.name + (i.state && i.state !== 'unknown' ? ` · ${i.state}` : '')))
          : h('span', { class: 'muted small' }, 'none detected'),
        h('span', { class: 'spacer' }),
        probePill('Prod', status.prod_probe), probePill('Staging', status.staging_probe),
        h('button', { class: 'btn sm', type: 'button', title: 'Re-check the VPN probes', onclick: () => loadStatus() }, '↻')));
    renderBanner();
  }

  async function loadStatus() {
    status = null; renderStatus();
    try { status = await get(`${API}/status`); renderStatus(); } catch (e) { toastError(e); }
  }

  /* ---------------- step 1 ---------------- */
  const idsBox = h('textarea', { class: 'mono', rows: 5, placeholder: `${EXAMPLE}\n(one or many prod assessment ids — any separators: new lines, commas, spaces, a pasted CSV column)`,
    value: store.get(DRAFT_KEY, ''), oninput: () => { store.set(DRAFT_KEY, idsBox.value); checkIds(); } });
  const idsInfo = h('div', { class: 'stack' });
  let reupload = false;
  let validCount = 0;
  const syncBtn = h('button', { class: 'btn primary', type: 'button', onclick: startSync }, '▶ Sync to staging');
  const syncConsole = h('div', {});
  const syncResults = h('div', {});

  const checkIds = debounce(async () => {
    try {
      const r = await post(`${API}/ids/check`, { text: idsBox.value });
      validCount = r.ids.length;
      clear(idsInfo,
        h('span', { class: 'small' }, `${fmt.int(validCount)} valid id${validCount === 1 ? '' : 's'}`, r.duplicates ? ` · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} dropped` : ''),
        r.rejected_count > 0 && h('div', { class: 'notice warn small' },
          `Ignored ${r.rejected_count} token${r.rejected_count === 1 ? '' : 's'} that are not ids: `,
          r.rejected.slice(0, 8).map((t, i) => [i ? ', ' : '', h('code', {}, t)]), r.rejected_count > 8 ? ', …' : ''));
      syncBtn.disabled = !validCount || isRunning('sync');
    } catch (e) { toastError(e); }
  }, 250);

  async function startSync() {
    const n = validCount;
    const ok = await confirmDialog('Sync to STAGING?', h('div', { class: 'stack' },
      h('p', { style: { margin: 0 } }, h('b', {}, `Uploads ${n} assessment(s) from prod to STAGING.`)),
      h('p', { class: 'small', style: { margin: 0 } }, reupload ? 'With --reupload: the prod json_uuid is kept.' : 'A new json_uuid is generated for each assessment.'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Needs the PROD VPN.')), { okLabel: 'Sync' });
    if (!ok) return;
    try {
      syncBtn.disabled = true;
      const run = await post(`${API}/runs`, { ids: idsBox.value, reupload });
      select(run);
      loadRuns(false);
    } catch (e) { toastError(e); syncBtn.disabled = false; }
  }

  const step1 = h('section', { class: 'card as-step' },
    h('div', { class: 'card-head' }, h('span', { class: 'as-num' }, '1'),
      h('div', { class: 'stack', style: { gap: '2px' } }, h('h2', {}, 'Sync from PROD'), h('p', { class: 'desc' }, 'Connect the PROD VPN first.'))),
    h('div', { class: 'card-body' },
      h('label', { class: 'field' }, 'Prod assessment ids', idsBox), idsInfo,
      h('div', { class: 'row' },
        checkbox('--reupload', false, (v) => { reupload = v; }),
        h('span', { class: 'muted small as-grow' }, 'Keeps the prod json_uuid instead of generating a new one, so id_at_source matches across environments. Without it each sync is a distinct new upload in staging.'),
        syncBtn),
      syncConsole, syncResults));

  function renderSyncResults() {
    const items = current?.kind === 'sync' ? current.items : [];
    if (!items.length) { clear(syncResults); return; }
    clear(syncResults, h('ul', { class: 'as-results' }, items.map((i) => h('li', { class: `as-res ${i.sync_state}` },
      pill(SYNC_PILL, i.sync_state, i.active, 'syncing…'),
      h('span', { class: 'mono as-ellipsis', title: i.prod_id }, i.prod_id),
      i.json_id && [h('span', { class: 'muted' }, '→'), idCell(i.json_id, 'json id')],
      (i.sync_state === 'failed' || i.sync_state === 'not_found') && h('span', { class: 'as-hint', title: i.sync_error }, i.sync_hint || i.sync_error)))),
    current.sync_message && current.sync_message.text && h('div', { class: `notice ${current.sync_message.status === 'succeeded' ? '' : 'err'} small` },
      current.sync_message.hint ? h('b', {}, current.sync_message.hint) : '', current.sync_message.hint ? h('br') : '',
      h('span', { class: 'mono' }, current.sync_message.text)));
  }

  /* ---------------- VPN switch banner ---------------- */
  const bannerPill = h('span', {});
  const banner = h('div', { class: 'as-banner', role: 'note' },
    h('span', { class: 'as-banner-icon' }, '🔀'),
    h('div', { class: 'stack', style: { gap: '2px' } }, h('b', {}, 'Switch your VPN to STAGING, then continue'),
      h('span', { class: 'small' }, 'Step 1 talks to prod, step 2 reads the staging database.')),
    h('span', { class: 'spacer' }), bannerPill,
    h('button', { class: 'btn sm', type: 'button', onclick: () => pollStagingProbe(true) }, '↻'));

  function renderBanner() {
    const synced = current?.items.some((i) => i.json_id && i.lookup_state !== 'found');
    banner.classList.toggle('hot', !!synced && !isRunning('sync'));
    clear(bannerPill, status ? probePill('Staging', status.staging_probe) : '');
  }

  async function pollStagingProbe(force) {
    if (!status?.staging_probe?.configured) return;
    if (!force && (document.hidden || !banner.offsetParent)) return;  // only while visible
    try {
      const p = await get(`${API}/probe/staging`);
      status = { ...status, staging_probe: p, vpn_interfaces: p.vpn_interfaces };
      renderStatus();
    } catch { /* ignore */ }
  }
  const probeTimer = setInterval(() => { if (!root.isConnected) clearInterval(probeTimer); else pollStagingProbe(false); }, 10000);

  /* ---------------- step 2 ---------------- */
  const lookupBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => startLookup(true) }, '▶ Look up staging assessments');
  const retryBtn = h('button', { class: 'btn', type: 'button', onclick: () => startLookup(true), title: 'Look up the processing / not found / failed ones again' }, '↻ Retry lookup');
  const allBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => startLookup(false), title: 'Look up every json id of this run again' }, 'Look up all again');
  const lookupHint = h('span', { class: 'muted small' });
  const lookupConsole = h('div', {});
  const lookupOnlyBox = h('textarea', { class: 'mono', rows: 3, placeholder: '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d.json\n(json ids from an earlier sync, with or without .json)' });

  async function startLookup(onlyMissing) {
    if (!current) return;
    try {
      lookupBtn.disabled = retryBtn.disabled = true;
      select(await post(`${API}/runs/${current.id}/lookup`, { only_missing: onlyMissing }));
    } catch (e) { toastError(e); renderStep2(); }
  }

  async function startLookupOnly() {
    if (!lookupOnlyBox.value.trim()) return toastError(new Error('Paste some json ids first'));
    try {
      const run = await post(`${API}/lookup`, { ids: lookupOnlyBox.value });
      lookupOnlyBox.value = '';
      select(run);
      loadRuns(false);
    } catch (e) { toastError(e); }
  }

  const step2 = h('section', { class: 'card as-step' },
    h('div', { class: 'card-head' }, h('span', { class: 'as-num' }, '2'),
      h('div', { class: 'stack', style: { gap: '2px' } }, h('h2', {}, 'Look up in STAGING'), h('p', { class: 'desc' }, 'Connect the STAGING VPN first.'))),
    h('div', { class: 'card-body' },
      h('div', { class: 'row' }, lookupBtn, retryBtn, allBtn, lookupHint),
      lookupConsole,
      h('details', { class: 'as-only' }, h('summary', {}, 'Lookup only — json ids from an earlier sync'),
        h('div', { class: 'stack' }, lookupOnlyBox,
          h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: startLookupOnly }, '▶ Look up these'))))));

  function renderStep2() {
    const c = current?.counts;
    const missing = current ? current.items.filter((i) => i.json_id && i.lookup_state !== 'found').length : 0;
    const retryable = current ? current.items.some((i) => i.json_id && ['processing', 'not_found', 'failed'].includes(i.lookup_state)) : false;
    const busy = isRunning('sync') || isRunning('lookup');
    lookupBtn.disabled = !missing || busy;
    retryBtn.hidden = !retryable;
    retryBtn.disabled = busy;
    allBtn.hidden = !c || !c.with_json || missing === c.with_json;
    allBtn.disabled = busy;
    lookupHint.textContent = !current ? 'Start a sync, or use “Lookup only” below.'
      : !c.with_json ? 'No json ids in this run yet (step 1 gives them).'
      : `${missing} of ${c.with_json} json id(s) without a staging id`
        + (c.lookup_processing ? ' · staging is still processing some — retry in a minute' : '');
    const msg = current?.lookup_message;
    lookupConsole.querySelector('.as-msg')?.remove();
    if (msg && !isRunning('lookup')) lookupConsole.append(h('div', { class: 'notice err small as-msg' }, h('b', {}, msg.hint || msg.text)));
  }

  root.append(h('div', { class: 'as-stepper' }, step1, banner, step2));

  /* ---------------- results ---------------- */
  const resultsEl = h('section', { class: 'card as-runcard' });
  const pastEl = h('section', { class: 'card' });
  root.append(resultsEl, pastEl);

  async function exportText(format) {
    return api(`${API}/runs/${current.id}/export`, { query: { format } });
  }

  const saveNotes = debounce(async (id, notes) => {
    try { await api(`${API}/runs/${id}`, { method: 'PATCH', body: { notes } }); } catch (e) { toastError(e); }
  }, 600);

  function renderResults() {
    if (!current) {
      clear(resultsEl, h('div', { class: 'card-body' }, h('p', { class: 'muted', style: { margin: 0 } }, 'No run selected. Results of a sync or lookup show up here.')));
      return;
    }
    const r = current;
    const c = r.counts;
    const retryIds = r.items.filter((i) => i.prod_id && !i.sync_uploaded && ['failed', 'pending'].includes(i.sync_state)).map((i) => i.prod_id);
    const stagingIds = r.items.map((i) => i.staging_id).filter(Boolean);
    const notes = h('input', { type: 'text', placeholder: 'Notes for this run (ticket, reason …)', value: r.notes || '',
      oninput: () => saveNotes(r.id, notes.value) });
    clear(resultsEl,
      h('div', { class: 'card-head' },
        h('h2', {}, r.kind === 'lookup' ? 'Lookup run' : 'Sync run'),
        h('span', { class: 'muted small' }, `${when(r.created_at)} · ${c.total} id(s)${r.reupload ? ' · --reupload' : ''}`),
        h('span', { class: 'spacer' }),
        r.sync_job && statusPill(r.sync_job.status === 'lost' ? 'failed' : r.sync_job.status),
        r.lookup_job && h('span', { class: 'muted small' }, 'lookup'), r.lookup_job && statusPill(r.lookup_job.status === 'lost' ? 'failed' : r.lookup_job.status)),
      h('div', { class: 'card-body' },
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: async () => copyText(await exportText('md'), 'Table copied as Markdown') }, 'Copy table as Markdown'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => copyText(await exportText('csv'), 'Copied as CSV') }, 'Copy as CSV'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => downloadText(await exportText('csv'), `asmnt-sync-${r.id}.csv`) }, '⬇ Download CSV'),
          h('button', { class: 'btn sm', type: 'button', disabled: !stagingIds.length, onclick: () => copyText(stagingIds.join('\n'), `${stagingIds.length} staging id(s) copied`) }, 'Copy staging ids only'),
          h('span', { class: 'spacer' }),
          retryIds.length > 0 && h('button', { class: 'btn sm', type: 'button', title: 'Put the failed / pending prod ids back into step 1',
            onclick: () => { idsBox.value = retryIds.join('\n'); store.set(DRAFT_KEY, idsBox.value); checkIds(); step1.scrollIntoView({ behavior: 'smooth' }); } }, `↻ Re-sync ${retryIds.length} failed/pending`)),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data as-table' },
          h('thead', {}, h('tr', {}, ['prod assessment id', 'staging json id', 'staging assessment id', 'OTP', 'status', 'created', 'state'].map((t) => h('th', {}, t)))),
          h('tbody', {}, r.items.map((i) => h('tr', {},
            h('td', {}, idCell(i.prod_id, 'prod id')),
            h('td', {}, idCell(i.json_id, 'json id')),
            h('td', {}, idCell(i.staging_id, 'staging id')),
            h('td', {}, idCell(i.otp, 'OTP')),
            h('td', {}, i.status || ''),
            h('td', { class: 'small' }, i.created_date || ''),
            h('td', { class: 'as-states' },
              pill(SYNC_PILL, i.sync_state, i.active && i.sync_state === 'pending' && isRunning('sync'), 'syncing…'),
              i.json_id && pill(LOOKUP_PILL, i.lookup_state, i.active && isRunning('lookup'), 'looking up…'),
              (i.sync_hint || i.lookup_hint) && h('div', { class: 'as-hint small', title: [i.sync_error, i.lookup_error].filter(Boolean).join('\n') },
                i.lookup_hint || i.sync_hint))))))),
        notes));
  }

  function renderPast() {
    clear(pastEl,
      h('div', { class: 'card-head' }, h('h2', {}, 'Past runs'), h('span', { class: 'muted small' }, `${runs.length}`)),
      h('div', { class: 'card-body' }, !runs.length ? h('p', { class: 'muted small', style: { margin: 0 } }, 'No runs yet.')
        : h('ul', { class: 'as-runs' }, runs.map((r) => h('li', { class: `as-run ${current?.id === r.id ? 'on' : ''}` },
          h('button', { class: 'as-run-open', type: 'button', onclick: () => { select(r); resultsEl.scrollIntoView({ behavior: 'smooth' }); } },
            h('span', { class: 'small' }, when(r.created_at)),
            h('span', { class: 'pill' }, r.kind === 'lookup' ? 'lookup only' : 'sync'),
            h('span', { class: 'small' }, `${r.counts.total} id(s)`),
            r.kind === 'sync' && h('span', { class: 'small as-c-ok' }, `${r.counts.sync_synced} synced`),
            r.counts.sync_failed + r.counts.sync_not_found > 0 && h('span', { class: 'small as-c-bad' }, `${r.counts.sync_failed + r.counts.sync_not_found} not synced`),
            h('span', { class: 'small as-c-ok' }, `${r.counts.lookup_found} found`),
            r.counts.lookup_processing > 0 && h('span', { class: 'small as-c-warn' }, `${r.counts.lookup_processing} processing`),
            r.running && h('span', { class: 'pill run' }, 'running'),
            r.notes && h('span', { class: 'muted small as-ellipsis' }, r.notes)),
          h('button', { class: 'btn ghost sm', type: 'button', title: 'Delete this run', 'aria-label': 'Delete run', disabled: r.running, onclick: () => remove(r) }, '🗑'))))));
  }

  async function remove(r) {
    if (!(await confirmDialog('Delete this run?', `Removes the run from ${when(r.created_at)} (${r.counts.total} id(s)) from this list. Nothing changes in prod or staging.`, { okLabel: 'Delete', danger: true }))) return;
    try {
      await del(`${API}/runs/${r.id}`);
      if (current?.id === r.id) { current = null; store.set(RUN_KEY, null); }
      await loadRuns(false);
      toast('Run deleted', 'ok');
    } catch (e) { toastError(e); }
  }

  /* ---------------- selection, jobs, polling ---------------- */
  function isRunning(stage) {
    const j = stage === 'sync' ? current?.sync_job : current?.lookup_job;
    return j?.status === 'running';
  }

  function attachConsole(stage, job, slot) {
    if (!job || job.gone) { if (consoles[stage]) { clear(slot); consoles[stage] = null; } return; }
    if (consoles[stage] === job.id) return;
    slot.querySelector('.job')?.close?.();
    consoles[stage] = job.id;
    const wasRunning = job.status === 'running';  // a finished job's console reports done at once: no toast then
    clear(slot, jobConsole(job, { onDone: (j) => {
      if (!wasRunning) return;
      toast(`${j.title}: ${j.status}`, j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'err' : '');
      reloadCurrent();
    } }));
  }

  function render() {
    attachConsole('sync', current?.sync_job, syncConsole);
    attachConsole('lookup', current?.lookup_job, lookupConsole);
    renderSyncResults();
    renderBanner();
    renderStep2();
    renderResults();
    renderPast();
    syncBtn.disabled = !validCount || isRunning('sync');
  }

  function select(run) {
    current = run;
    store.set(RUN_KEY, run?.id || null);
    const i = runs.findIndex((r) => r.id === run?.id);
    if (i >= 0) runs[i] = run;
    render();
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (current?.running) pollTimer = setTimeout(reloadCurrent, 2000);
  }

  async function reloadCurrent() {
    if (!current || !root.isConnected) return;
    try {
      const run = await get(`${API}/runs/${current.id}`);
      if (current?.id !== run.id) return;
      select(run);
    } catch (e) {
      if (e.status === 404) { current = null; render(); } else toastError(e);
    }
  }

  async function loadRuns(pick = true) {
    try {
      runs = await get(`${API}/runs`);
      const wanted = pick ? store.get(RUN_KEY, null) : current?.id;
      const run = runs.find((r) => r.id === wanted) || (pick ? runs[0] : current && runs.find((r) => r.id === current.id)) || null;
      if (run) select(run); else { current = null; render(); }
    } catch (e) { toastError(e); }
  }

  render();
  checkIds();
  await Promise.all([loadRuns(), loadStatus()]);

  return {
    onShow() { loadRuns(false); },
    async open(ref) {
      if (!runs.some((r) => r.id === ref)) await loadRuns(false);
      const run = runs.find((r) => r.id === ref);
      if (!run) return toast('That run no longer exists', 'err');
      select(run);
      resultsEl.scrollIntoView({ behavior: 'smooth' });
    },
  };
}
