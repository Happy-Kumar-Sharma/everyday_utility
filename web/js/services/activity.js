// 🧾 Activity: the audit log as a day-grouped timeline with filters, stats and export.

import { get } from '../core/api.js';
import { clear, debounce, fmt, h, loadCss, store, toastError } from '../core/dom.js';
import { segmented, statusPill } from '../core/components.js';

const KEY = 'eu.activity.filters';
const REFRESH_MS = 15000;
const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: 0 };
const ENV_PILL = { prod: 'err', staging: 'warn', local: 'ok' };
const DEFAULTS = { kind: '', status: '', env: '', q: '', range: '7d' };

export async function mount(container) {
  loadCss('/static/css/activity.css');
  const st = { ...DEFAULTS, ...store.get(KEY, {}), limit: 300 };
  const expanded = new Set();  // ts of open rows, kept across auto-refresh
  let icons = {};
  let seq = 0;

  const stats = h('div', { class: 'status-grid act-stats' });
  const kindChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kind' });
  const statusSeg = segmented([{ value: '', label: 'Any' }, { value: 'succeeded', label: 'Succeeded' }, { value: 'failed', label: 'Failed' }],
    st.status, (v) => set({ status: v }));
  const rangeSeg = segmented([{ value: '24h', label: '24 h' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: 'all', label: 'All' }],
    st.range, (v) => set({ range: v }));
  const envSel = h('select', { 'aria-label': 'Environment', onchange: () => set({ env: envSel.value }) },
    [['', 'Any env'], ['prod', 'prod'], ['staging', 'staging'], ['local', 'local'], ['none', 'no env']].map(([v, l]) => h('option', { value: v }, l)));
  envSel.value = st.env;
  const search = h('input', { type: 'search', placeholder: 'Search target, action, detail…', 'aria-label': 'Search activity', value: st.q,
    oninput: debounce(() => set({ q: search.value.trim() }), 300) });
  const exportTxt = h('a', { class: 'btn sm', download: '' }, '⬇ Export .txt');
  const exportJsonl = h('a', { class: 'btn sm', download: '' }, '⬇ .jsonl');
  const summary = h('span', { class: 'muted small' });
  const timeline = h('div', { class: 'act-timeline' }, h('p', { class: 'muted' }, 'Loading…'));

  clear(container,
    stats,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Filters'), h('span', { class: 'spacer' }), exportTxt, exportJsonl),
      h('div', { class: 'card-body' },
        kindChips,
        h('div', { class: 'row act-filters' }, statusSeg, envSel, rangeSeg, h('div', { class: 'act-search' }, search)))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Timeline'), h('span', { class: 'spacer' }), summary,
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => load(), title: 'Refresh now' }, '↻')),
      h('div', { class: 'card-body' }, timeline)));

  function set(patch) {
    Object.assign(st, patch);
    statusSeg.value = st.status; rangeSeg.value = st.range; envSel.value = st.env;
    if (search.value.trim() !== st.q) search.value = st.q;
    store.set(KEY, { kind: st.kind, status: st.status, env: st.env, q: st.q, range: st.range });
    return load();
  }

  function query() {
    const secs = RANGES[st.range];
    return { kind: st.kind, status: st.status, env: st.env, q: st.q, since: secs ? Math.floor(Date.now() / 1000 - secs) : undefined };
  }

  function exportHref(format) {
    const qs = new URLSearchParams(Object.entries({ format, ...query() }).filter(([, v]) => v !== undefined && v !== ''));
    return `/api/activity/export?${qs}`;
  }

  async function load() {
    const mine = ++seq;
    try {
      const data = await get('/api/activity/events', { ...query(), limit: st.limit });
      if (mine !== seq) return;  // a newer load (filter change) already started
      icons = Object.fromEntries(data.kinds.map((k) => [k.kind, k.icon]));
      // re-rendering detaches the focused button; put focus back on its rebuilt twin so keyboard users keep their place
      const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
      renderStats(data.stats);
      renderKinds(data.kinds);
      renderTimeline(data.events);
      if (focused) [...container.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focused)?.focus({ preventScroll: true });
      summary.textContent = data.total > data.events.length ? `latest ${fmt.int(data.events.length)} of ${fmt.int(data.total)}` : `${fmt.int(data.total)} events`;
      exportTxt.href = exportHref('txt');
      exportJsonl.href = exportHref('jsonl');
    } catch (e) {
      if (mine === seq) toastError(e);
    }
  }

  function statCard(label, value, sub, onclick, tone) {
    return h('button', { type: 'button', class: `card stat-card act-stat ${tone || ''}`, dataset: { focus: `stat:${label}` }, onclick }, h('span', { class: 'label' }, label),
      h('span', { class: 'value' }, value), h('span', { class: 'sub' }, sub));
  }

  function renderStats(s) {
    const ok = s.last_backup_ok, last = s.last_backup;
    const backupSub = !last ? 'no backup recorded yet'
      : last.status === 'failed' ? `last attempt failed ${fmt.ago(last.ts)}` : last.target;
    const backupAge = ok ? (Date.now() / 1000 - ok.ts) / 86400 : Infinity;
    clear(stats,
      statCard('Events today', fmt.int(s.today), 'show the last 24 h', () => set({ ...DEFAULTS, range: '24h' })),
      statCard('Jobs failed · 7 days', fmt.int(s.jobs_failed_7d), 'show them',
        () => set({ ...DEFAULTS, kind: 'job', status: 'failed', range: '7d' }), s.jobs_failed_7d ? 'bad' : ''),
      statCard('Last backup', ok ? fmt.ago(ok.ts) : 'never', backupSub,
        () => set({ ...DEFAULTS, kind: 'backup', range: 'all' }), backupAge > 7 ? 'bad' : ''));
  }

  function renderKinds(kinds) {
    const total = kinds.reduce((n, k) => n + k.count, 0);
    const chip = (kind, label) => h('button', { type: 'button', class: `chip ${st.kind === kind ? 'on' : ''}`, 'aria-pressed': String(st.kind === kind),
      dataset: { focus: `kind:${kind}` }, onclick: () => set({ kind: st.kind === kind && kind ? '' : kind }) }, label);
    const list = st.kind && !kinds.some((k) => k.kind === st.kind) ? [...kinds, { kind: st.kind, count: 0, icon: '•' }] : kinds;
    clear(kindChips, chip('', `All ${fmt.int(total)}`), list.map((k) => chip(k.kind, `${k.icon} ${k.kind} ${fmt.int(k.count)}`)));
  }

  function renderTimeline(events) {
    if (!events.length) {
      return clear(timeline, h('p', { class: 'muted' }, 'Nothing recorded for these filters.'));
    }
    const days = new Map();
    for (const e of events) {
      const key = new Date(e.ts * 1000).toDateString();
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }
    clear(timeline, [...days].map(([key, list]) => h('section', { class: 'act-day' },
      h('h3', { class: 'act-day-head' }, dayLabel(key), h('span', { class: 'muted small' }, ` · ${list.length}`)),
      h('ul', { class: 'act-list' }, list.map(row)))));
  }

  function row(e) {
    const id = `act-${String(e.ts).replace('.', '-')}`;
    const open = expanded.has(e.ts);
    const detail = h('div', { class: 'act-detail', id, hidden: !open }, detailTable(e.detail));
    const btn = h('button', { type: 'button', class: 'act-row', 'aria-expanded': String(open), 'aria-controls': id,
      dataset: { focus: `row:${e.ts}` }, onclick: () => {
        const show = detail.hidden;
        detail.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
        if (show) expanded.add(e.ts); else expanded.delete(e.ts);
      } },
    h('span', { class: 'act-time mono small' }, new Date(e.ts * 1000).toLocaleTimeString()),
    h('span', { class: 'act-icon', title: e.kind, 'aria-label': e.kind }, icons[e.kind] || '•'),
    h('span', { class: 'act-main' }, h('span', { class: 'act-action' }, e.action), ' ', h('span', { class: 'act-target' }, e.target)),
    h('span', { class: 'act-pills' },
      e.env && h('span', { class: `pill ${ENV_PILL[e.env] || ''}` }, e.env),
      e.status && statusPill(e.status)));
    return h('li', { class: 'act-item', dataset: { ts: String(e.ts) } }, btn, detail);
  }

  function detailTable(detail) {
    const entries = Object.entries(detail || {});
    if (!entries.length) return h('p', { class: 'muted small' }, 'No details.');
    return h('table', { class: 'data act-kv' }, h('tbody', {}, entries.map(([k, v]) =>
      h('tr', {}, h('th', { scope: 'row' }, k), h('td', { class: 'mono small' }, show(v))))));
  }

  // auto-refresh only while this tab is on screen
  setInterval(() => { if (!document.hidden && container.offsetParent !== null) load(); }, REFRESH_MS);

  await load();

  return {
    onShow: load,
    async open(ref) {
      const ts = Number(ref);
      await set({ ...DEFAULTS, range: 'all' });
      let li = find(ts);
      if (!li && st.limit < 5000) { st.limit = 5000; await load(); li = find(ts); }
      if (!li) return toastError('That event is no longer in the log');
      const btn = li.querySelector('.act-row');
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
      li.scrollIntoView({ block: 'center', behavior: 'smooth' });
      btn.focus({ preventScroll: true });
      li.classList.remove('act-flash');
      void li.offsetWidth;  // restart the animation when the same event is opened twice
      li.classList.add('act-flash');
    },
  };

  function find(ts) {
    return [...timeline.querySelectorAll('.act-item')].find((li) => Math.abs(Number(li.dataset.ts) - ts) < 1e-6);
  }
}

function dayLabel(key) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (key === today.toDateString()) return 'Today';
  if (key === yesterday.toDateString()) return 'Yesterday';
  return new Date(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function show(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') || '—';
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 2 && 'from' in v && 'to' in v) return `${v.from} → ${v.to}`;
    return keys.map((k) => `${k}: ${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`).join('; ');
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
