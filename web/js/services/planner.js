// Planner tab: tasks (status, priority, due, reminders, repeat, tags, checklists, time tracking), done log,
// weekly review, daily notes. background() runs from page load so reminders and Pomodoro fire whichever tab is open.

import { api, get, post } from '../core/api.js';
import { checkbox, segmented } from '../core/components.js';
import { clear, confirmDialog, copyText, debounce, downloadText, h, loadCss, modal, store, toast, toastError } from '../core/dom.js';

const API = '/api/planner';
const CHANGED = 'planner:changed';  // window event after any planner mutation (the Home tab listens too)
const changed = (source) => window.dispatchEvent(new CustomEvent(CHANGED, { detail: { source } }));

/* ---------------------------------------------------------------- dates (local time, YYYY-MM-DD) */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(`${s}T00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function prettyDate(s) {
  if (!s) return '';
  const t = today();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  if (s === addDays(t, -1)) return 'Yesterday';
  const d = new Date(`${s}T00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}
const prettyTime = (epoch) => new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayName = (s) => new Date(`${s}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/* ---- durations */
const pad2 = (n) => String(n).padStart(2, '0');
/** 1h 05m / 12m / <1m */
function hm(s) {
  const m = Math.floor((s || 0) / 60);
  if (m < 1) return s > 0 ? '<1m' : '0m';
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m}m`;
}
/** mm:ss, or h:mm:ss past an hour */
function clockFmt(s) {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  return `${hh ? `${hh}:` : ''}${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
const spent = (t) => (t.time_spent || 0) + (t.timer_started_at ? Math.max(0, Date.now() / 1000 - t.timer_started_at) : 0);
const toLocalInput = (epoch) => { if (!epoch) return ''; const d = new Date(epoch * 1000); return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * Quick-add syntax:  "Renew cert #ops #infra !high @tomorrow ^weekly"
 *   #tag   !high / !low   @today @tomorrow @mon..@sun @2026-11-20 @+3 (days)   ^daily ^weekdays ^weekly ^monthly
 */
export function parseQuick(text) {
  const out = { title: '', tags: [], priority: 'normal', due: null, repeat: 'none' };
  const words = [];
  for (const w of text.trim().split(/\s+/)) {
    const lw = w.toLowerCase();
    if (/^#\S+/.test(w)) out.tags.push(w.slice(1).toLowerCase());
    else if (['!high', '!h', '!!'].includes(lw)) out.priority = 'high';
    else if (['!low', '!l'].includes(lw)) out.priority = 'low';
    else if (/^\^(daily|weekdays|weekly|monthly)$/.test(lw)) out.repeat = lw.slice(1);
    else if (lw === '@today') out.due = today();
    else if (lw === '@tomorrow' || lw === '@tmr') out.due = addDays(today(), 1);
    else if (/^@\+\d+d?$/.test(lw)) out.due = addDays(today(), parseInt(lw.slice(2), 10));
    else if (/^@\d{4}-\d{2}-\d{2}$/.test(lw)) out.due = lw.slice(1);
    else if (/^@(sun|mon|tue|wed|thu|fri|sat)/.test(lw)) {
      const target = WEEKDAYS.indexOf(lw.slice(1, 4));
      const diff = ((target - new Date().getDay()) + 7) % 7 || 7;  // next occurrence, never today
      out.due = addDays(today(), diff);
    } else words.push(w);
  }
  out.title = words.join(' ');
  if (out.repeat !== 'none' && !out.due) out.due = today();
  return out;
}

/* ================================================================ background: reminders */
const shown = new Set();

export function background() {
  const tick = async () => {
    try {
      for (const t of await get(`${API}/reminders/due`)) {
        if (shown.has(t.id)) continue;
        shown.add(t.id);
        showReminder(t);
      }
    } catch { /* server restarting */ }
  };
  tick();
  setInterval(tick, 30_000);
  setInterval(pomoTick, 1000);
}

function desktopNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); location.hash = '#/planner'; };
  } catch { /* some platforms disallow page-created notifications */ }
}

const ALERT_STYLE = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--accent)' };

function showReminder(t) {
  desktopNotify(`⏰ ${t.title}`, t.notes || (t.due ? `Due ${prettyDate(t.due)}` : ''), `planner-${t.id}`);
  const act = async (fn, msg) => {
    try { await fn(); el.remove(); shown.delete(t.id); if (msg) toast(msg, 'ok'); window.dispatchEvent(new Event(CHANGED)); } catch (e) { toastError(e); }
  };
  const snooze = (m) => act(() => post(`${API}/reminders/${t.id}/ack`, { minutes: m }), `Snoozed ${m >= 60 ? `${m / 60} h` : `${m} min`}`);
  const el = h('div', { class: 'toast', role: 'alert', style: ALERT_STYLE },
    h('div', { class: 'stack', style: { gap: '8px' } },
      h('b', {}, `⏰ ${t.title}`),
      t.notes && h('span', { class: 'muted small', style: { whiteSpace: 'pre-wrap' } }, t.notes),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => act(() => api(`${API}/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } }), 'Done ✓') }, '✓ Done'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => snooze(10) }, '10 min'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => snooze(60) }, '1 h'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => snooze(24 * 60) }, 'Tomorrow'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => act(() => post(`${API}/reminders/${t.id}/ack`, { minutes: 0 })) }, 'Dismiss'))));
  document.getElementById('toasts').append(el);
}

/** Reminder-style toast that stays until a button is pressed (first action is primary), plus a desktop notification. */
function alertToast(title, body, actions) {
  desktopNotify(title, body, 'planner-pomodoro');
  const el = h('div', { class: 'toast', role: 'alert', style: ALERT_STYLE },
    h('div', { class: 'stack', style: { gap: '8px' } },
      h('b', {}, title),
      h('span', { class: 'muted small' }, body),
      h('div', { class: 'row' }, actions.map((a, i) => h('button', { class: `btn sm ${i === 0 ? 'primary' : ''}`, type: 'button',
        onclick: async () => { el.remove(); try { await a.run?.(); } catch (e) { toastError(e); } } }, a.label)))));
  document.getElementById('toasts').append(el);
}

/* ================================================================ timer + Pomodoro
 * The server owns the running timer (timer_started_at), so elapsed time survives reloads. Pomodoro phases live
 * in localStorage and are advanced by background(), so they fire whichever tab is open. */
const POMO_KEY = 'eu.plan.pomo';        // {on, work, brk} in minutes
const PHASE_KEY = 'eu.plan.pomoPhase';  // {phase: 'work' | 'break', start: ms, len: min, id, title} or null
const pomoCfg = () => ({ on: false, work: 25, brk: 5, ...store.get(POMO_KEY, {}) });
const getPhase = () => store.get(PHASE_KEY, null);
const setPhase = (p) => store.set(PHASE_KEY, p);
// a phase keeps the length it started with, so editing the setting mid-interval cannot back-date its end past time worked
const phaseLen = (p) => p.len ?? (p.phase === 'work' ? pomoCfg().work : pomoCfg().brk);
const phaseLeft = (p) => phaseLen(p) * 60 - (Date.now() - p.start) / 1000;
const workPhase = (id, title) => ({ phase: 'work', start: Date.now(), len: pomoCfg().work, id, title });

async function startTimer(id) {
  const t = await post(`${API}/tasks/${id}/timer`, { action: 'start' });
  if (pomoCfg().on) setPhase(workPhase(id, t.title));
  changed();
}

async function stopTimer(id, at) {
  await post(`${API}/tasks/${id}/timer`, { action: 'stop', at });
  const p = getPhase();
  if (p?.phase === 'work' && p.id === id) setPhase(null);
  changed();
}

let pomoChecking = false;
async function pomoTick() {
  const p = getPhase();
  if (pomoChecking || !p || !pomoCfg().on || phaseLeft(p) > 0) return;
  const resume = { label: `▶ Resume “${p.title}”`, run: () => startTimer(p.id) };
  if (p.phase === 'work') {
    // the timer may have been stopped or its task finished where no Planner tab was mounted (Home, a reminder toast)
    let run;
    pomoChecking = true;
    try { run = await get(`${API}/timer`); } catch { return; /* server restarting: retry next tick */ } finally { pomoChecking = false; }
    if (JSON.stringify(getPhase()) !== JSON.stringify(p)) return;  // another page handled it meanwhile
    if (run?.id !== p.id) { setPhase(null); changed(); return; }
    // stop at the interval's end, even if the page was closed when it passed
    const end = p.start + phaseLen(p) * 60_000;
    setPhase({ ...p, phase: 'break', start: end, len: pomoCfg().brk });
    stopTimer(p.id, end / 1000).catch(toastError);
    alertToast(`🍅 Pomodoro done: ${p.title}`, `Timer stopped. Take a ${pomoCfg().brk} min break.`, [{ label: 'OK' }, { ...resume, label: '▶ Skip break' }]);
  } else {
    setPhase(null);
    changed();
    alertToast('☕ Break over', `Back to “${p.title}”?`, [resume, { label: 'Later' }]);
  }
}

/* ================================================================ tab */
const VIEWS = [
  { value: 'today', label: '☀️ Today' },
  { value: 'upcoming', label: '📅 Upcoming' },
  { value: 'all', label: '📋 All open' },
  { value: 'done', label: '✅ Done' },
  { value: 'review', label: '📊 Week' },
  { value: 'notes', label: '📝 Daily notes' },
];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const REVIEW_RANGES = [{ value: 7, label: '7 days' }, { value: 14, label: '14 days' }, { value: 30, label: '30 days' }];

export async function mount(root) {
  loadCss('/static/css/planner.css');
  let tasks = [];
  let view = store.get('eu.plan.view', 'today');
  let query = '';
  let tagFilter = null;
  let reviewDays = store.get('eu.plan.reviewDays', 7);

  /* ---- quick add */
  const quick = h('input', { type: 'text', placeholder: 'Add a task…   e.g.  Renew SSL cert #ops !high @tomorrow ^monthly   (Enter)',
    'aria-label': 'Quick add task', onkeydown: (e) => { if (e.key === 'Enter') quickAdd(); } });
  const hint = h('div', { class: 'muted small' });
  quick.addEventListener('input', () => {
    const p = parseQuick(quick.value);
    clear(hint, quick.value.trim() ? [
      h('b', {}, p.title || '(no title)'),
      p.priority !== 'normal' && ` · ${p.priority} priority`,
      p.due && ` · due ${prettyDate(p.due)}`,
      p.repeat !== 'none' && ` · repeats ${p.repeat}`,
      p.tags.length > 0 && ` · ${p.tags.map((x) => `#${x}`).join(' ')}`,
    ] : '#tag   !high / !low   @today @tomorrow @fri @+3 @2026-12-01   ^daily ^weekdays ^weekly ^monthly');
  });
  quick.dispatchEvent(new Event('input'));

  async function quickAdd() {
    const p = parseQuick(quick.value);
    if (!p.title) return;
    // adding from Today without a date means "today"
    if (!p.due && view === 'today') p.due = today();
    try { await post(`${API}/tasks`, p); quick.value = ''; quick.dispatchEvent(new Event('input')); changed(); } catch (e) { toastError(e); }
  }

  const notifyBtn = h('button', { class: 'btn sm', type: 'button', hidden: !('Notification' in window) || Notification.permission !== 'default',
    onclick: async () => { await Notification.requestPermission(); notifyBtn.hidden = Notification.permission !== 'default'; } }, '🔔 Enable desktop notifications');

  const stats = h('div', { class: 'status-grid' });
  const search = h('input', { type: 'text', placeholder: 'Search…', style: { maxWidth: '240px' }, oninput: debounce(() => { query = search.value.trim().toLowerCase(); draw(); }, 120) });
  const tagsEl = h('div', { class: 'chips' });
  const content = h('div', { class: 'stack', style: { gap: '16px' } });
  const focusEl = h('div', { role: 'region', 'aria-label': 'Focus timer' });
  const viewSeg = segmented(VIEWS, view, (v) => setView(v));

  root.append(
    focusEl,
    h('div', { class: 'card' }, h('div', { class: 'card-body', style: { gap: '6px' } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, quick, h('button', { class: 'btn primary', type: 'button', onclick: quickAdd }, '＋ Add'),
        h('button', { class: 'btn', type: 'button', title: 'Add with all fields', onclick: () => editTask(null) }, '⋯')),
      hint)),
    stats,
    h('div', { class: 'row' },
      viewSeg,
      h('span', { style: { flex: 1 } }), notifyBtn,
      h('button', { class: 'btn sm', type: 'button', onclick: exportAll }, '⬇ Export .txt')),
    h('div', { class: 'row' }, search, tagsEl),
    content);

  function setView(v) {
    view = v;
    store.set('eu.plan.view', v);
    viewSeg.value = v;
    draw();
  }

  async function load() {
    try { tasks = await get(`${API}/tasks`); } catch (e) { toastError(e); return; }
    syncPhase();
    draw();
  }
  // a note autosave must not re-render the note being typed
  window.addEventListener(CHANGED, (e) => { if (e.detail?.source !== 'note') load(); });

  // keeps the Pomodoro phase in line with the server's timer (stopped by "done", started from another tab, …)
  function syncPhase() {
    const p = getPhase();
    const run = tasks.find((t) => t.timer_started_at);
    // a break that began after this session started means its auto-stop is still in flight
    const current = run && p?.id === run.id && (p.phase === 'work' || p.start > run.timer_started_at * 1000);
    if (run && pomoCfg().on && !current) {
      // this browser did not see the interval start, so count a fresh one from now rather than back-dating its stop
      setPhase(workPhase(run.id, run.title));
    } else if (!run && p?.phase === 'work') setPhase(null);
  }

  /* ---- derived lists */
  const open = () => tasks.filter((t) => t.status !== 'done');
  const matches = (t) => (!tagFilter || t.tags.includes(tagFilter))
    && (!query || [t.title, t.notes, t.tags.join(' '), ...t.checklist.map((i) => i.text)].join(' ').toLowerCase().includes(query));
  const sortOpen = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || a.created_at - b.created_at;

  function drawStats() {
    const t = today();
    const o = open();
    const doneToday = tasks.filter((x) => x.status === 'done' && x.done_at && ymd(new Date(x.done_at * 1000)) === t).length;
    const weekAgo = Date.now() / 1000 - 7 * 86400;
    const doneWeek = tasks.filter((x) => x.status === 'done' && (x.done_at || 0) >= weekAgo).length;
    const card = (label, value, cls, onclick) => h('button', { type: 'button', class: 'card stat-card', onclick,
      style: { textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' } },
    h('span', { class: 'label' }, label), h('span', { class: 'value', style: cls ? { color: `var(--${cls})` } : null }, value));
    const go = (v) => () => setView(v);
    clear(stats,
      card('Overdue', o.filter((x) => x.due && x.due < t).length, o.some((x) => x.due && x.due < t) ? 'err' : null, go('today')),
      card('Due today', o.filter((x) => x.due === t).length, null, go('today')),
      card('In progress', o.filter((x) => x.status === 'doing').length, null, go('all')),
      card('Open', o.length, null, go('all')),
      card('Done today', doneToday, doneToday ? 'ok' : null, go('done')),
      card('Done in 7 days', doneWeek, null, go('done')));
  }

  function drawTags() {
    const all = [...new Set(tasks.flatMap((t) => t.tags))].sort();
    if (tagFilter && !all.includes(tagFilter)) tagFilter = null;
    clear(tagsEl, all.map((tag) => h('button', { type: 'button', class: `chip ${tag === tagFilter ? 'on' : ''}`,
      onclick: () => { tagFilter = tagFilter === tag ? null : tag; draw(); } }, `#${tag}`)));
  }

  function section(title, list, { empty, collapsed = false } = {}) {
    if (!list.length && !empty) return null;
    const body = list.length ? h('div', { class: 'stack', style: { gap: '6px' } }, list.map(taskRow)) : h('p', { class: 'muted small', style: { margin: 0 } }, empty);
    return h('details', { open: !collapsed },
      h('summary', { style: { cursor: 'pointer', marginBottom: '8px' } }, h('b', {}, title), h('span', { class: 'muted' }, `  ${list.length}`)),
      body);
  }

  function draw() {
    drawFocus();
    drawStats();
    drawTags();
    const t = today();
    const o = open().filter(matches).sort(sortOpen);
    if (view === 'today') {
      const overdue = o.filter((x) => x.due && x.due < t);
      const due = o.filter((x) => x.due === t);
      const doing = o.filter((x) => x.status === 'doing' && !(x.due && x.due <= t));
      const inbox = o.filter((x) => !x.due && x.status !== 'doing');
      const doneToday = tasks.filter((x) => x.status === 'done' && x.done_at && ymd(new Date(x.done_at * 1000)) === t && matches(x));
      clear(content,
        section('⚠️ Overdue', overdue),
        section('☀️ Today', due, { empty: 'Nothing due today. Add something above.' }),
        section('▶ In progress', doing),
        section('📥 Inbox (no date)', inbox, { collapsed: inbox.length > 8 }),
        section('✅ Done today', doneToday, { collapsed: true }));
    } else if (view === 'upcoming') {
      const later = o.filter((x) => x.due && x.due > t);
      const byDay = Object.groupBy ? Object.groupBy(later, (x) => x.due) : later.reduce((m, x) => ((m[x.due] ||= []).push(x), m), {});
      const days = Object.keys(byDay).sort();
      clear(content, days.length ? days.map((d) => section(prettyDate(d), byDay[d])) : h('div', { class: 'notice' }, 'Nothing scheduled after today.'));
    } else if (view === 'all') {
      clear(content, section('Open tasks', o, { empty: 'All clear 🎉' }));
    } else if (view === 'done') {
      const done = tasks.filter((x) => x.status === 'done' && matches(x)).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
      const groups = {};
      for (const x of done) (groups[ymd(new Date((x.done_at || 0) * 1000))] ||= []).push(x);
      clear(content,
        h('div', { class: 'row' }, h('span', { class: 'muted small' }, `${done.length} completed`), h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Clear old done tasks?', 'Removes completed tasks finished more than 30 days ago. Export first if you want to keep a record.', { okLabel: 'Clear', danger: true }))) return;
            try { const r = await post(`${API}/tasks/clear-done`, { older_than_days: 30 }); toast(`Removed ${r.removed}`); changed(); } catch (e) { toastError(e); }
          } }, 'Clear done > 30 days')),
        done.length ? Object.keys(groups).map((d) => section(prettyDate(d), groups[d])) : h('div', { class: 'notice' }, 'Nothing completed yet.'));
    } else if (view === 'review') {
      drawReview();
    } else {
      drawNotes();
    }
  }

  /* ---- focus bar: running timer, Pomodoro, break countdown */
  let focusKey = '';
  let focusTick = null;  // updates the bar's live numbers every second
  function drawFocus() {
    const run = tasks.find((t) => t.timer_started_at);
    const cfg = pomoCfg();
    const p = getPhase();
    const brk = !run && cfg.on && p?.phase === 'break' ? p : null;
    // rebuilt only when its state changes, so its inputs keep focus across re-renders
    const key = JSON.stringify([run?.id, run?.title, run?.timer_started_at, brk?.start, cfg.on]);
    if (key === focusKey) return;
    focusKey = key;
    focusTick = null;
    if (brk) drawBreak(brk);
    else if (run) drawRunning(run, cfg);
    else clear(focusEl);
    focusTick?.();
  }

  function drawRunning(run, cfg) {
    const session = h('span', { class: 'pl-clock', title: 'This session' });
    const total = h('span', { class: 'muted small' });
    const pomoLeft = h('span', { class: 'pill run' });
    focusTick = () => {
      session.textContent = clockFmt(Date.now() / 1000 - run.timer_started_at);
      total.textContent = `total ${hm(spent(run))}`;
      const ph = getPhase();
      pomoLeft.hidden = !(cfg.on && ph?.phase === 'work');
      if (!pomoLeft.hidden) pomoLeft.textContent = `🍅 ${clockFmt(phaseLeft(ph))} left`;
    };
    const toggle = h('button', { class: 'btn sm pl-toggle', type: 'button', 'aria-pressed': String(cfg.on),
      title: 'Work / break intervals: the timer stops when a work interval ends', onclick: () => {
        const on = !pomoCfg().on;
        store.set(POMO_KEY, { ...pomoCfg(), on });
        setPhase(on ? workPhase(run.id, run.title) : null);
        if (on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        drawFocus();
      } }, '🍅 Pomodoro');
    const minutes = (key, label) => {
      const input = h('input', { type: 'number', min: 1, max: 180, value: cfg[key], 'aria-label': `${label} minutes`, onchange: () => {
        const v = Math.min(180, Math.max(1, Math.round(Number(input.value)) || pomoCfg()[key]));
        input.value = v;
        store.set(POMO_KEY, { ...pomoCfg(), [key]: v });
        focusTick?.();
      } });
      return h('label', { title: 'Applies from the next interval' }, label, input, 'min');
    };
    clear(focusEl, h('div', { class: 'pl-focus' },
      h('span', { class: 'pill run' }, 'Focusing'),
      h('button', { class: 'pl-focus-title', type: 'button', title: 'Open task', onclick: () => editTask(run) }, run.title),
      session, total,
      h('span', { class: 'pl-spacer' }),
      h('div', { class: 'pl-pomo' }, toggle, cfg.on && [minutes('work', 'Work'), minutes('brk', 'Break')], pomoLeft),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => stopTimer(run.id).catch(toastError) }, '⏹ Stop')));
  }

  function drawBreak(brk) {
    const left = h('span', { class: 'pl-clock' });
    focusTick = () => { left.textContent = clockFmt(phaseLeft(brk)); };
    clear(focusEl, h('div', { class: 'pl-focus break' },
      h('span', { class: 'pill ok' }, '☕ Break'), left,
      h('span', { class: 'muted small' }, `then back to “${brk.title}”`),
      h('span', { class: 'pl-spacer' }),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => startTimer(brk.id).catch(toastError) }, '▶ Resume now'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { setPhase(null); drawFocus(); } }, 'End break')));
  }

  /* ---- weekly review */
  async function drawReview() {
    const days = reviewDays;
    if (!content.querySelector('.pl-review')) clear(content, h('p', { class: 'muted' }, 'Loading…'));
    let r;
    try { r = await get(`${API}/review`, { days, tz: new Date().getTimezoneOffset() }); } catch (e) { toastError(e); return; }
    if (view !== 'review' || days !== reviewDays) return;  // switched away while loading
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const panel = (title, ...body) => h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('b', {}, title)), h('div', { class: 'card-body' }, body));
    const stat = (label, value, cls) => h('div', { class: 'card stat-card' },
      h('span', { class: 'label' }, label), h('span', { class: 'value', style: cls ? { color: `var(--${cls})` } : null }, value));
    clear(content, h('div', { class: 'stack pl-review', style: { gap: '16px' } },
      h('div', { class: 'row' },
        segmented(REVIEW_RANGES, days, (v) => { reviewDays = v; store.set('eu.plan.reviewDays', v); drawReview(); }),
        h('span', { class: 'muted small' }, `${dayName(r.start)} – ${dayName(r.end)}`),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(reviewMarkdown(r), 'Review copied as Markdown') }, '📋 Copy as text')),
      h('div', { class: 'status-grid' },
        stat('Done', r.done_count, r.done_count ? 'ok' : null),
        stat('Created', r.created_count),
        stat('Time focused', hm(r.time_total)),
        stat('Slipped', r.slipped.length, r.slipped.length ? 'err' : null)),
      panel('Done per day', doneBars(r)),
      h('div', { class: 'pl-review-grid' },
        panel('⏱ Time by tag', tagTimes(r),
          r.top_tags.length > 0 && h('div', { class: 'chips', 'aria-label': 'Top tags by tasks done' },
            h('span', { class: 'muted small' }, 'Top tags'), r.top_tags.map((x) => h('span', { class: 'pill' }, `#${x.tag} · ${x.count}`)))),
        panel(`⚠️ Slipped (${r.slipped.length})`, r.slipped.length
          ? h('ul', { class: 'pl-list' }, r.slipped.map((x) => slippedItem(x, byId.get(x.id), r.end)))
          : h('p', { class: 'muted small', style: { margin: 0 } }, 'Nothing overdue or postponed 🎉'))),
      panel(`✅ Completed (${r.done_count})`, r.done.length
        ? r.done.map((g) => h('details', { open: g.date === r.end },
          h('summary', { style: { cursor: 'pointer' } }, h('b', {}, prettyDate(g.date)), h('span', { class: 'muted' }, `  ${g.tasks.length}`)),
          h('ul', { class: 'pl-list', style: { margin: '8px 0 0 4px' } }, g.tasks.map((t) => h('li', {},
            h('button', { class: 'pl-item-title', type: 'button', onclick: () => byId.has(t.id) && editTask(byId.get(t.id)) }, t.title),
            t.time_spent > 0 && h('span', { class: 'pill' }, `⏱ ${hm(t.time_spent)}`),
            t.tags.map((tag) => h('span', { class: 'pill' }, `#${tag}`)))))))
        : h('p', { class: 'muted small', style: { margin: 0 } }, 'Nothing completed in this range.'))));
  }

  function doneBars(r) {
    const max = Math.max(1, ...r.days.map((d) => d.done));
    const short = r.days.length <= 14;
    return h('div', { class: 'pl-bars', role: 'list', 'aria-label': 'Tasks done per day' }, r.days.map((d) => {
      const label = `${dayName(d.date)}: ${d.done} done`;
      const dt = new Date(`${d.date}T00:00`);
      return h('div', { class: `pl-bar ${d.date === r.end ? 'today' : ''}`, role: 'listitem', 'aria-label': label, title: label },
        h('span', { class: 'pl-bar-track', 'aria-hidden': 'true' }, h('span', { class: 'pl-bar-fill', style: { height: `${(d.done / max) * 100}%` } })),
        h('span', { class: 'pl-bar-n', 'aria-hidden': 'true' }, String(d.done)),
        h('span', { class: 'pl-bar-day', 'aria-hidden': 'true' }, short ? dt.toLocaleDateString(undefined, { weekday: 'short' }) : String(dt.getDate())));
    }));
  }

  function tagTimes(r) {
    if (!r.time_by_tag.length) return h('p', { class: 'muted small', style: { margin: 0 } }, 'No time tracked in this range. Use ⏱ on a task.');
    const max = Math.max(...r.time_by_tag.map((x) => x.seconds));
    return h('div', { class: 'pl-hbars' }, r.time_by_tag.map((x) => {
      const name = x.tag === '(untagged)' ? x.tag : `#${x.tag}`;
      return [h('span', { class: 'small' }, name),
        h('div', { class: 'pl-hbar', role: 'img', 'aria-label': `${name}: ${hm(x.seconds)}` }, h('span', { style: { width: `${(x.seconds / max) * 100}%` } })),
        h('span', { class: 'small mono' }, hm(x.seconds))];
    }));
  }

  function slippedItem(x, t, end) {
    return h('li', {},
      h('button', { class: 'pl-item-title', type: 'button', onclick: () => t && editTask(t) }, x.title),
      x.due && h('span', { class: `pill ${x.due < end ? 'err' : ''}` }, `📅 ${prettyDate(x.due)}`),
      x.postponed > 0 && h('span', { class: 'pill warn', title: 'Times the due date was moved later' }, `↷ ${x.postponed}×`),
      x.due !== today() && h('button', { class: 'btn sm', type: 'button', onclick: () => patch(x, { due: today() }, 'Moved to today') }, '☀️ Today'),
      h('button', { class: 'btn sm ghost', type: 'button', title: 'Delete', 'aria-label': `Delete “${x.title}”`, onclick: () => deleteTask(x) }, '🗑'));
  }

  function reviewMarkdown(r) {
    const tag = (x) => (x === '(untagged)' ? x : `#${x}`);
    const out = [`## Review ${r.start} → ${r.end}`, '',
      `- Done: ${r.done_count} · Created: ${r.created_count} · Focused: ${hm(r.time_total)} · Slipped: ${r.slipped.length}`];
    if (r.top_tags.length) out.push(`- Top tags: ${r.top_tags.map((x) => `#${x.tag} (${x.count})`).join(', ')}`);
    if (r.time_by_tag.length) out.push(`- Time by tag: ${r.time_by_tag.map((x) => `${tag(x.tag)} ${hm(x.seconds)}`).join(', ')}`);
    out.push('', '### Done');
    if (!r.done.length) out.push('- nothing completed');
    for (const g of r.done) {
      out.push('', `**${dayName(g.date)}**`);
      for (const t of g.tasks) out.push(`- ${t.title}${t.time_spent > 0 ? ` (${hm(t.time_spent)})` : ''}${t.tags.map((x) => ` #${x}`).join('')}`);
    }
    if (r.slipped.length) {
      out.push('', '### Slipped');
      for (const t of r.slipped) out.push(`- ${t.title}${t.due ? ` — due ${t.due}` : ''}${t.postponed ? `, postponed ${t.postponed}×` : ''}`);
    }
    return `${out.join('\n')}\n`;
  }

  /* ---- task row */
  function patch(t, body, msg) {
    return api(`${API}/tasks/${t.id}`, { method: 'PATCH', body }).then((r) => {
      if (r.spawned) toast(`Next “${r.spawned.title}” scheduled for ${prettyDate(r.spawned.due)}`, 'ok');
      else if (msg) toast(msg, 'ok');
      changed();
    }).catch(toastError);
  }

  async function deleteTask(t) {
    if (!(await confirmDialog('Delete task?', `“${t.title}”`, { okLabel: 'Delete', danger: true }))) return;
    try { await api(`${API}/tasks/${t.id}`, { method: 'DELETE' }); changed(); } catch (e) { toastError(e); }
  }

  // live numbers: elements with data-since (epoch) count up from data-base seconds
  const liveSpan = (since, base, fmtName) => h('span', { dataset: { since, base, fmt: fmtName } },
    (fmtName === 'hm' ? hm : clockFmt)(base + Date.now() / 1000 - since));

  function timerButton(t) {
    if (t.timer_started_at) {
      return h('button', { class: 'btn sm pl-timer on', type: 'button', title: 'Stop timer', 'aria-label': `Stop timer for “${t.title}”`,
        onclick: () => stopTimer(t.id).catch(toastError) }, '⏹ ', liveSpan(t.timer_started_at, 0, 'clock'));
    }
    return h('button', { class: 'btn sm ghost pl-timer', type: 'button', title: 'Start timer (stops any other)', 'aria-label': `Start timer for “${t.title}”`,
      onclick: () => startTimer(t.id).catch(toastError) }, '⏱');
  }

  function taskRow(t) {
    const tday = today();
    const done = t.status === 'done';
    const checked = t.checklist.filter((i) => i.done).length;
    const dueCls = !done && t.due ? (t.due < tday ? 'err' : t.due === tday ? 'run' : '') : '';
    const box = h('input', { type: 'checkbox', checked: done, title: done ? 'Mark as not done' : 'Mark as done',
      style: { width: '18px', height: '18px', accentColor: 'var(--accent)', flex: 'none', cursor: 'pointer' },
      onchange: () => patch(t, { status: done ? 'todo' : 'done' }) });
    return h('div', { class: 'card', style: { padding: '8px 12px', opacity: done ? 0.7 : 1 } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'flex-start' } },
        h('div', { style: { paddingTop: '2px' } }, box),
        h('div', { class: 'stack', style: { gap: '4px', flex: 1, minWidth: 0, cursor: 'pointer' }, onclick: () => editTask(t), role: 'button', tabindex: 0,
          onkeydown: (e) => { if (e.key === 'Enter') editTask(t); } },
        h('span', { style: { textDecoration: done ? 'line-through' : 'none', fontWeight: 500, wordBreak: 'break-word' } }, t.title),
        h('div', { class: 'row', style: { gap: '6px' } },
          t.priority === 'high' && h('span', { class: 'pill err' }, '↑ high'),
          t.priority === 'low' && h('span', { class: 'pill' }, '↓ low'),
          t.status === 'doing' && h('span', { class: 'pill run' }, 'in progress'),
          t.due && h('span', { class: `pill ${dueCls}` }, `📅 ${prettyDate(t.due)}`),
          t.repeat !== 'none' && h('span', { class: 'pill', title: `repeats ${t.repeat}` }, `🔁 ${t.repeat}`),
          t.remind_at && !done && h('span', { class: `pill ${t.reminded ? '' : 'warn'}`, title: t.reminded ? 'reminder shown' : 'reminder pending' }, `🔔 ${prettyTime(t.remind_at)}`),
          t.checklist.length > 0 && h('span', { class: `pill ${checked === t.checklist.length ? 'ok' : ''}` }, `☑ ${checked}/${t.checklist.length}`),
          spent(t) > 0 && h('span', { class: 'pill', title: 'Time spent' }, '⏱ ',
            t.timer_started_at ? liveSpan(t.timer_started_at, t.time_spent || 0, 'hm') : hm(t.time_spent)),
          t.tags.map((tag) => h('span', { class: 'pill' }, `#${tag}`)),
          t.notes && h('span', { class: 'muted small', title: t.notes }, '📝'))),
        !done && h('button', { class: 'btn sm ghost', type: 'button', title: t.status === 'doing' ? 'Back to todo' : 'Start (in progress)',
          onclick: () => patch(t, { status: t.status === 'doing' ? 'todo' : 'doing' }) }, t.status === 'doing' ? '⏸' : '▶'),
        !done && timerButton(t),
        !done && t.due !== tday && h('button', { class: 'btn sm ghost', type: 'button', title: 'Move to today', onclick: () => patch(t, { due: tday }, 'Moved to today') }, '☀️'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Delete', onclick: () => deleteTask(t) }, '🗑')),
      // checklist is tickable straight from the list
      t.checklist.length > 0 && !done && h('div', { class: 'stack', style: { gap: '2px', margin: '6px 0 0 30px' } },
        t.checklist.map((item) => checkbox(h('span', { style: { textDecoration: item.done ? 'line-through' : 'none', color: item.done ? 'var(--muted)' : 'inherit' } }, item.text),
          item.done, (v) => patch(t, { checklist: t.checklist.map((i) => (i.id === item.id ? { ...i, done: v } : i)) })))));
  }

  /* ---- editor */
  function editTask(t) {
    const d = t ? structuredClone(t) : { title: '', notes: '', status: 'todo', priority: 'normal', due: view === 'today' ? today() : null, remind_at: null, repeat: 'none', tags: [], checklist: [] };
    modal(t ? 'Edit task' : 'New task', (close) => {
      const title = h('input', { type: 'text', value: d.title, oninput: () => { d.title = title.value; } });
      const notes = h('textarea', { rows: 3, oninput: () => { d.notes = notes.value; } }, d.notes);
      const due = h('input', { type: 'date', value: d.due || '', onchange: () => { d.due = due.value || null; } });
      const remind = h('input', { type: 'datetime-local', value: toLocalInput(d.remind_at), onchange: () => {
        d.remind_at = remind.value ? new Date(remind.value).getTime() / 1000 : null;
        if (remind.value && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      } });
      const repeat = h('select', { value: d.repeat, onchange: () => { d.repeat = repeat.value; } },
        ['none', 'daily', 'weekdays', 'weekly', 'monthly'].map((r) => h('option', { value: r }, r === 'none' ? 'Does not repeat' : `Repeats ${r}`)));
      const tags = h('input', { type: 'text', value: d.tags.join(', '), placeholder: 'work, home, ops', oninput: () => { d.tags = tags.value.split(',').map((x) => x.trim()).filter(Boolean); } });

      const listEl = h('div', { class: 'stack', style: { gap: '4px' } });
      const newItem = h('input', { type: 'text', placeholder: 'Add checklist item (Enter)', onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (newItem.value.trim()) { d.checklist.push({ id: '', text: newItem.value.trim(), done: false }); newItem.value = ''; drawList(); } }
      } });
      function drawList() {
        clear(listEl, d.checklist.map((item, i) => h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('input', { type: 'checkbox', checked: item.done, onchange: (e) => { item.done = e.target.checked; } }),
          h('input', { type: 'text', value: item.text, oninput: (e) => { item.text = e.target.value; } }),
          h('button', { class: 'btn sm ghost', type: 'button', title: 'Move up', disabled: i === 0, onclick: () => { [d.checklist[i - 1], d.checklist[i]] = [d.checklist[i], d.checklist[i - 1]]; drawList(); } }, '↑'),
          h('button', { class: 'btn sm ghost', type: 'button', title: 'Remove', onclick: () => { d.checklist.splice(i, 1); drawList(); } }, '✕'))));
      }
      drawList();

      const quickDue = (label, value) => h('button', { class: 'chip', type: 'button', onclick: () => { d.due = value; due.value = value || ''; } }, label);
      const quickRemind = (label, mins) => h('button', { class: 'chip', type: 'button', onclick: () => {
        d.remind_at = Date.now() / 1000 + mins * 60; remind.value = toLocalInput(d.remind_at);
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      } }, label);

      return h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        if (newItem.value.trim()) d.checklist.push({ id: '', text: newItem.value.trim(), done: false });
        const body = { title: d.title, notes: d.notes, status: d.status, priority: d.priority, due: d.due, repeat: d.repeat, tags: d.tags, checklist: d.checklist };
        if (!t || d.remind_at !== t.remind_at) body.remind_at = d.remind_at;  // re-arms the reminder only when changed
        try {
          if (t) await patch(t, body, 'Saved');
          else { await post(`${API}/tasks`, body); toast('Added', 'ok'); changed(); }
          close();
        } catch (ex) { toastError(ex); }
      } },
      h('label', { class: 'field' }, 'Title', title),
      h('div', { class: 'row', style: { gap: '20px' } },
        h('div', { class: 'stack' }, h('b', {}, 'Status'), segmented([{ value: 'todo', label: 'To do' }, { value: 'doing', label: 'In progress' }, { value: 'done', label: 'Done' }], d.status, (v) => { d.status = v; })),
        h('div', { class: 'stack' }, h('b', {}, 'Priority'), segmented([{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }], d.priority, (v) => { d.priority = v; }))),
      h('label', { class: 'field' }, 'Due date', due),
      h('div', { class: 'chips' }, quickDue('Today', today()), quickDue('Tomorrow', addDays(today(), 1)), quickDue('+1 week', addDays(today(), 7)), quickDue('No date', null)),
      h('label', { class: 'field' }, 'Remind me at', remind),
      h('div', { class: 'chips' }, quickRemind('in 30 min', 30), quickRemind('in 1 h', 60), quickRemind('in 3 h', 180), quickRemind('tomorrow', 24 * 60),
        h('button', { class: 'chip', type: 'button', onclick: () => { d.remind_at = null; remind.value = ''; } }, 'No reminder')),
      h('label', { class: 'field' }, 'Repeat', repeat, h('span', { class: 'hint' }, 'Completing a repeating task schedules the next one (checklist reset).')),
      h('label', { class: 'field' }, 'Tags', tags),
      h('div', { class: 'stack' }, h('b', {}, 'Checklist'), listEl, newItem),
      h('label', { class: 'field' }, 'Notes', notes),
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, t ? 'Save' : 'Add')));
    }, { drawer: true });
  }

  /* ---- daily notes */
  let noteDay = today();
  function drawNotes() {
    const status = h('span', { class: 'muted small' });
    const area = h('textarea', { rows: 16, class: 'mono', placeholder: 'What happened today, decisions, links, commands worth keeping…', 'aria-label': 'Daily note' });
    const dayInput = h('input', { type: 'date', value: noteDay, style: { width: 'auto' }, onchange: () => { if (dayInput.value) { noteDay = dayInput.value; drawNotes(); } } });
    const index = h('div', { class: 'chips' });
    let dirty = false;
    const save = debounce(async () => {
      try {
        await api(`${API}/notes/${noteDay}`, { method: 'PUT', body: { text: area.value } });
        dirty = false; status.textContent = 'Saved'; loadIndex(); changed('note');
      } catch (e) { toastError(e); }
    }, 700);
    area.addEventListener('input', () => { dirty = true; status.textContent = 'Saving…'; save(); });
    area.addEventListener('blur', () => { if (dirty) save(); });
    const shift = (n) => { noteDay = addDays(noteDay, n); drawNotes(); };
    async function loadIndex() {
      try {
        const days = await get(`${API}/notes`);
        clear(index, days.slice(0, 30).map((x) => h('button', { type: 'button', class: `chip ${x.date === noteDay ? 'on' : ''}`, onclick: () => { noteDay = x.date; drawNotes(); } }, prettyDate(x.date))));
      } catch { /* ignore */ }
    }
    clear(content,
      h('div', { class: 'card' }, h('div', { class: 'card-body' },
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => shift(-1), 'aria-label': 'Previous day' }, '◀'),
          dayInput,
          h('button', { class: 'btn sm', type: 'button', onclick: () => shift(1), 'aria-label': 'Next day' }, '▶'),
          noteDay !== today() && h('button', { class: 'btn sm', type: 'button', onclick: () => { noteDay = today(); drawNotes(); } }, 'Today'),
          h('b', {}, prettyDate(noteDay)), h('span', { style: { flex: 1 } }), status),
        area,
        h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Days with notes'), index))));
    get(`${API}/notes/${noteDay}`).then((r) => { area.value = r.text; area.focus(); }).catch(toastError);
    loadIndex();
  }

  async function exportAll() {
    try { downloadText(await post(`${API}/export`), `planner_export_${today()}.txt`); } catch (e) { toastError(e); }
  }

  /* ---- deep links from global search / Home: 'new', 'task:<id>', 'note:<YYYY-MM-DD>' */
  function inView(t, v) {
    const tday = today();
    if (t.status === 'done') return v === 'done' || (v === 'today' && !!t.done_at && ymd(new Date(t.done_at * 1000)) === tday);
    if (v === 'all') return true;
    if (v === 'upcoming') return !!t.due && t.due > tday;
    return v === 'today' && (!t.due || t.due <= tday || t.status === 'doing');
  }

  async function openRef(ref) {
    ref = String(ref || '');
    if (ref === 'new') { editTask(null); return; }
    if (ref.startsWith('note:') && /^\d{4}-\d{2}-\d{2}$/.test(ref.slice(5))) {
      noteDay = ref.slice(5);
      setView('notes');
      return;
    }
    if (!ref.startsWith('task:')) return;
    await load();
    const t = tasks.find((x) => x.id === ref.slice(5));
    if (!t) { toast('That task no longer exists', 'err'); return; }
    // clear filters so the task is visible behind the editor
    query = ''; search.value = ''; tagFilter = null;
    if (inView(t, view)) draw();
    else setView(t.status === 'done' ? 'done' : 'all');
    editTask(t);
  }

  await load();
  // re-render every minute so "today" / overdue roll over at midnight without a reload
  setInterval(() => { if (root.isConnected && !root.closest('[hidden]') && view !== 'notes' && view !== 'review') draw(); }, 60_000);
  const ticker = setInterval(() => {
    if (!root.isConnected) { clearInterval(ticker); return; }
    if (root.closest('[hidden]')) return;
    drawFocus();  // picks up phase changes made by background() (cheap when nothing changed)
    focusTick?.();
    const now = Date.now() / 1000;
    for (const el of root.querySelectorAll('[data-since]')) {
      el.textContent = (el.dataset.fmt === 'hm' ? hm : clockFmt)(Number(el.dataset.base) + now - Number(el.dataset.since));
    }
  }, 1000);
  return { onShow: load, open: openRef };
}
