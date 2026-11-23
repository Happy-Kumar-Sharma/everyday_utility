// Home tab: today at a glance — tasks, focus timer, next reminder, jobs, backup age, library shortcuts and
// recent activity, from one GET /api/home/summary. Refreshes every 30 s while visible and on planner changes.
// Screen time, water and standup cards come from GET /api/home/wellbeing; their reminders run from background().

import { api, get, post } from '../core/api.js';
import { openSettings, statusPill } from '../core/components.js';
import { clear, copyText, fmt, h, loadCss, store, toast, toastError } from '../core/dom.js';
import { fillTemplate, placeholders } from '../core/highlight.js';
import { parseQuick } from './planner.js';

const DESKTOP_SOURCES = { gnome: 'Measured from GNOME idle time', windows: 'Measured from Windows idle time' };

const CHANGED = 'planner:changed';
const REFRESH_MS = 30_000;
const TYPE_ICON = { sql: '🗄️', mongo: '🍃', shell: '💻', python: '🐍', link: '🔗', note: '📝', json: '🧾', yaml: '🧾' };
const KIND_ICON = { job: '▶️', library: '📚', credentials: '🔑', 'env-files': '🧾', backup: '💾', settings: '⚙️', auth: '🔐', pipeline: '🧠' };
const QUICK_HINT = '#tag   !high / !low   @today @tomorrow @fri @+3 @2026-12-01   ^daily ^weekdays ^weekly ^monthly';

/* ---------------------------------------------------------------- time helpers (browser-local) */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const now = () => Date.now() / 1000;

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : hr < 22 ? 'Good evening' : 'Working late';
}

function prettyDate(s) {
  if (!s) return '';
  const d = new Date(`${s}T00:00`);
  const days = Math.round((d - new Date(`${today()}T00:00`)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function relTime(ts) {
  const s = ts - now();
  const a = Math.abs(s);
  const span = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `in ${span}` : `${span} ago`;
}

const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** A text node that the 1 s ticker keeps up to date: base seconds + time since `from` (epoch). */
const ticking = (from, base, format) => h('span', { class: 'mono', dataset: { tickFrom: from, tickBase: base, tickFmt: format } },
  format === 'clock' ? clock(base + now() - from) : fmt.duration(base + now() - from));

/* ---------------------------------------------------------------- building blocks */
function card(icon, title, body, action) {
  return h('section', { class: 'card home-card', 'aria-label': title },
    h('div', { class: 'card-head' }, h('h2', {}, `${icon}  ${title}`), h('span', { class: 'spacer' }), action),
    h('div', { class: 'card-body' }, body));
}

const linkBtn = (href, label) => h('a', { class: 'btn sm ghost', href }, label);
const empty = (emoji, text, sub) => h('div', { class: 'home-empty' }, h('div', { class: 'home-empty-icon', 'aria-hidden': 'true' }, emoji),
  h('div', {}, text), sub && h('div', { class: 'muted small' }, sub));
const sectionError = (section) => h('div', { class: 'notice err' }, `Couldn't load this: ${section.error}`);
const label = (text, cls = '') => h('div', { class: `home-label ${cls}` }, text);

/* ================================================================ wellbeing: screen time, water, standup
 * One poll of GET /api/home/wellbeing (every 60 s, on visibilitychange and after each action) feeds both the
 * Home cards (when mounted) and the reminders. background() starts it at page load, so the break / water / standup
 * toasts and the browser screen-time heartbeat work whichever tab is open. */
const WB_URL = '/api/home/wellbeing';
const WB_POLL_MS = 60_000;
const HEARTBEAT_MS = 60_000;
const BREAK_KEY = 'eu.home.break';          // {start, until}: no nudge for this session until `until` (epoch ms)
const WATER_SNOOZE_KEY = 'eu.home.waterSnooze';  // epoch ms
const ALERT_STYLE = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--accent)' };

const wb = { data: null, error: null, started: false, pending: null, lastInput: Date.now(), soon: null };
const wbListeners = new Set();
const showing = { break: null, breakStart: null, water: null, standup: null };

const pad2 = (n) => String(n).padStart(2, '0');
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m}m`);
const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function whenLabel(ts) {
  const d = new Date(ts * 1000);
  return ymd(d) === today() ? clockTime(ts) : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(ts)}`;
}

function wbSet(data) {
  wb.data = data;
  wb.error = null;
  for (const fn of wbListeners) { try { fn(data, null); } catch (e) { console.error(e); } }
  try { reminders(data); } catch (e) { console.error(e); }
  return data;
}

function wbLoad() {
  if (wb.pending) return wb.pending;
  wb.pending = get(WB_URL).then(wbSet).catch((e) => {
    wb.error = e;
    for (const fn of wbListeners) { try { fn(wb.data, e); } catch (err) { console.error(err); } }
  }).finally(() => { wb.pending = null; });
  return wb.pending;
}

function startWellbeing() {
  if (wb.started) return;
  wb.started = true;
  const seen = () => { wb.lastInput = Date.now(); };
  for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
    window.addEventListener(ev, seen, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wbLoad(); });
  setInterval(wbLoad, WB_POLL_MS);
  setInterval(heartbeat, HEARTBEAT_MS);
  wbLoad();
}

/** Browser fallback for screen time: only while GNOME idle time is unavailable, this tab is visible and in use. */
async function heartbeat() {
  const s = wb.data?.screen;
  // a desktop idle source (GNOME / Windows) measures real screen time; browser heartbeats only fill in without one
  if (!s || s.error || DESKTOP_SOURCES[s.source] || document.visibilityState !== 'visible') return;
  if (Date.now() - wb.lastInput > (s.idle_seconds || 120) * 1000) return;
  try { await post('/api/home/screen/heartbeat'); } catch { /* server restarting */ }
}

export function background() {
  loadCss('/static/css/home.css');
  startWellbeing();
}

/* ---- reminder toasts (same look and behaviour as the planner's) */
function desktopNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: body || '', tag });
    n.onclick = () => { window.focus(); location.hash = '#/home'; };
  } catch { /* some platforms disallow page-created notifications */ }
}

function closeAlert(key) {
  showing[key]?.remove();
  showing[key] = null;
}

/** Stays until a button is pressed (first action is primary). `keep: true` actions leave it open. */
function alertToast(key, title, body, actions) {
  desktopNotify(title, body, `home-${key}`);
  const el = h('div', { class: 'toast', role: 'alert', style: ALERT_STYLE },
    h('div', { class: 'stack', style: { gap: '8px' } },
      h('b', {}, title),
      body && h('span', { class: 'muted small' }, body),
      h('div', { class: 'row' }, actions.map((a, i) => h('button', { class: `btn sm ${i === 0 ? 'primary' : ''}`, type: 'button',
        onclick: async () => {
          if (!a.keep) closeAlert(key);
          try { await a.run(); } catch (e) { toastError(e); }
        } }, a.label)))));
  showing[key] = el;
  document.getElementById('toasts')?.append(el);
}

const postWater = (delta) => post('/api/home/water', { delta }).then(wbSet);
const postStandup = (action, minutes) => post('/api/home/standup', minutes ? { action, minutes } : { action }).then(wbSet);
const copySummary = () => copyText(wb.data?.standup?.summary?.text || '', 'Standup summary copied');

function reminders(d) {
  breakReminder(d.screen);
  waterReminder(d.water);
  standupReminder(d.standup);
  // a standup or water reminder due before the next poll: check again right then instead of up to 60 s late
  clearTimeout(wb.soon);
  const nowS = now();
  const next = [d.standup?.next_at, d.water?.next_reminder_at].filter((t) => t && t > nowS && t - nowS < WB_POLL_MS / 1000);
  if (next.length) wb.soon = setTimeout(wbLoad, (Math.min(...next) - nowS) * 1000 + 1500);
}

function breakReminder(s) {
  if (!s || s.error) return;
  const start = s.current_streak_start;
  // the session ended or a new one began since the toast went up: that was the break, so drop the stale toast
  if (showing.break && (!start || start !== showing.breakStart)) closeAlert('break');
  if (!start || !s.break_minutes || s.current_streak_minutes < s.break_minutes || showing.break) return;
  const st = store.get(BREAK_KEY, null);
  if (st && st.start === start && Date.now() < st.until) return;
  // "Taking one" stays quiet for another break_minutes: if the session hasn't reset by then (the break was too
  // short to end it), nudge again rather than staying silent for the rest of a long session
  const quietMs = s.break_minutes * 60_000;
  alertToast('break', `Time for a short break — you've been at the screen for ${s.current_streak_minutes} min`, null, [
    { label: 'Taking one', run: () => store.set(BREAK_KEY, { start, until: Date.now() + quietMs }) },
    { label: 'Snooze 10 min', run: () => store.set(BREAK_KEY, { start, until: Date.now() + 10 * 60_000 }) },
  ]);
  showing.breakStart = start;
}

function waterReminder(w) {
  if (!w || w.error) return;
  if (!w.due_now) { closeAlert('water'); return; }  // logged from the card, goal reached or work day over
  if (showing.water || Date.now() < store.get(WATER_SNOOZE_KEY, 0)) return;
  alertToast('water', '💧 Time for some water', `${w.count} / ${w.goal} glasses so far today${w.last_at ? ` · last one ${fmt.ago(w.last_at)}` : ''}`, [
    { label: '+1 glass', run: async () => { await postWater(1); toast('💧 +1 glass', 'ok'); } },
    { label: 'Snooze 15 min', run: () => store.set(WATER_SNOOZE_KEY, Date.now() + 15 * 60_000) },
  ]);
}

function standupReminder(s) {
  if (!s || s.error) return;
  if (!s.due_now) { closeAlert('standup'); return; }
  if (showing.standup) return;
  alertToast('standup', '🗣 Standup time', `Standup at ${s.time} — copy the summary to paste it.`, [
    { label: '📋 Copy summary', keep: true, run: copySummary },
    { label: 'Done', run: async () => { await postStandup('done'); toast('Standup done ✓', 'ok'); } },
    { label: 'Snooze 10 min', run: () => postStandup('snooze', 10) },
  ]);
}

/* ---- Home cards: built once, updated in place so focus never jumps */
function wellbeingCards(service) {
  const settingsBtn = (what) => !service?.settings?.length ? null : h('button', { class: 'btn sm ghost', type: 'button', title: 'Settings',
    'aria-label': `${what} settings`, onclick: async () => {
      try { openSettings(service, await get(`/api/services/${service.id}/settings`), () => wbLoad()); } catch (e) { toastError(e); }
    } }, '⚙');

  async function act(btn, fn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (e) { toastError(e); } finally { delete btn.dataset.busy; btn.removeAttribute('aria-busy'); }
  }

  const fillBar = (cls, ratio) => {
    const el = h('span', { class: cls });
    el.style.setProperty('--fill', `${Math.min(100, Math.round(ratio * 100))}%`);
    return el;
  };
  const errBox = () => h('div', { class: 'notice err', hidden: true });
  const showErr = (box, section, loadError) => {
    const msg = section?.error ? `Couldn't load this: ${section.error}` : !section && loadError ? `Couldn't load this: ${loadError.message}` : '';
    box.hidden = !msg;
    box.textContent = msg;
    return !!msg;
  };

  /* -- screen time */
  const sc = {
    err: errBox(), big: h('span', { class: 'home-big' }, '—'), source: h('div', { class: 'muted small' }),
    bars: Array.from({ length: 24 }, () => h('span', { class: 'home-hour', role: 'img' })),
    first: h('dd'), vs: h('dd'), session: h('dd'),
  };
  const screenEl = card('🖥', 'Screen time', [
    sc.err,
    h('div', { class: 'home-big-row' }, sc.big, h('span', { class: 'muted' }, 'today')),
    sc.source,
    h('div', { class: 'home-hours', role: 'group', 'aria-label': 'Screen time per hour today' }, sc.bars),
    h('div', { class: 'home-hours-axis muted', 'aria-hidden': 'true' }, ['00', '06', '12', '18', '24'].map((x) => h('span', {}, x))),
    h('dl', { class: 'home-facts' },
      h('dt', {}, 'Active'), sc.first,
      h('dt', {}, 'vs yesterday'), sc.vs,
      h('dt', {}, 'This session'), sc.session),
  ], settingsBtn('Screen time'));

  function drawScreen(s, loadError) {
    if (showErr(sc.err, s, loadError) || !s) return;
    sc.big.textContent = hm(s.today_minutes);
    sc.source.textContent = DESKTOP_SOURCES[s.source] || 'Time active in this app (desktop idle time unavailable)';
    const hour = new Date().getHours();
    s.hourly.forEach((n, i) => {
      const bar = sc.bars[i];
      bar.style.setProperty('--fill', `${Math.min(100, Math.round((n / 60) * 100))}%`);
      bar.classList.toggle('now', i === hour);
      bar.classList.toggle('later', i > hour);
      const lbl = `${pad2(i)}:00–${pad2((i + 1) % 24)}:00: ${n} min${i === hour ? ' (this hour)' : ''}`;
      bar.setAttribute('aria-label', lbl);
      bar.title = lbl;
    });
    sc.first.textContent = s.first_active ? `${s.first_active} – ${s.last_active}` : 'not yet today';
    const diff = s.today_minutes - s.yesterday_minutes;
    sc.vs.textContent = `${diff >= 0 ? '+' : '−'}${hm(Math.abs(diff))} (yesterday ${hm(s.yesterday_minutes)})`;
    sc.session.textContent = s.current_streak_minutes ? `${hm(s.current_streak_minutes)} without a break` : 'on a break';
    sc.session.classList.toggle('home-warn', !!s.break_minutes && s.current_streak_minutes >= s.break_minutes);
  }

  /* -- water */
  const wa = {
    err: errBox(), glasses: h('div', { class: 'home-glasses', role: 'img' }), count: h('div', { class: 'home-water-count' }),
    since: h('div', { class: 'muted small' }), next: h('div', { class: 'muted small' }),
    history: h('div', { class: 'home-mini', role: 'group', 'aria-label': 'Glasses per day, last 7 days' }),
  };
  const plus = h('button', { class: 'btn primary', type: 'button', onclick: () => act(plus, async () => { await postWater(1); toast('💧 +1 glass', 'ok'); }) }, '+1 glass');
  const minus = h('button', { class: 'btn', type: 'button', 'aria-label': 'Undo last glass', title: 'Undo last glass',
    onclick: () => { if ((wb.data?.water?.count || 0) > 0) act(minus, () => postWater(-1)); } }, '−');
  const waterEl = card('💧', 'Water', [
    wa.err, wa.glasses, wa.count, h('div', { class: 'row' }, plus, minus, wa.since), wa.next,
    h('div', { class: 'home-label' }, 'Last 7 days'), wa.history,
  ], settingsBtn('Water'));

  function drawWater(w, loadError) {
    if (showErr(wa.err, w, loadError) || !w) return;
    wa.glasses.setAttribute('aria-label', `${w.count} of ${w.goal} glasses`);
    const icons = Math.max(w.goal, w.count);
    clear(wa.glasses, icons <= 16
      ? Array.from({ length: icons }, (_, i) => h('span', { class: `home-glass ${i < w.count ? 'full' : ''} ${i >= w.goal ? 'extra' : ''}` }))
      : h('div', { class: 'progress home-water-bar' }, h('div', { style: { width: `${Math.min(100, (w.count / w.goal) * 100)}%` } })));
    wa.count.textContent = `${w.count} / ${w.goal} · ${w.ml} ml`;
    minus.setAttribute('aria-disabled', String(w.count === 0));
    wa.since.textContent = w.last_at ? `last glass ${fmt.ago(w.last_at)}` : 'none yet today';
    wa.next.textContent = w.count >= w.goal ? 'Goal reached 🎉'
      : !w.remind_minutes ? 'Water reminders are off'
        : w.due_now ? 'Reminder due now'
          : w.next_reminder_at ? `Next reminder ${whenLabel(w.next_reminder_at)} (work hours ${w.work_start}–${w.work_end})` : '';
    clear(wa.history, w.history.map((x) => {
      const d = new Date(`${x.date}T00:00`);
      const lbl = `${d.toLocaleDateString(undefined, { weekday: 'long' })}: ${x.count} of ${w.goal} glasses`;
      return h('span', { class: `home-mini-day ${x.date === today() ? 'now' : ''}`, role: 'img', 'aria-label': lbl, title: lbl },
        fillBar('home-mini-bar', x.count / w.goal),
        h('span', { class: 'home-mini-lbl', 'aria-hidden': 'true' }, d.toLocaleDateString(undefined, { weekday: 'narrow' })));
    }));
  }

  /* -- standup */
  const su = {
    err: errBox(), pill: h('span', { class: 'pill' }), status: h('span', { class: 'muted small' }),
    lists: { yesterday: h('ul', { class: 'home-list home-su-list' }), today: h('ul', { class: 'home-list home-su-list' }), blockers: h('ul', { class: 'home-list home-su-list' }) },
    yLabel: h('div', { class: 'home-label' }, 'Yesterday'), sumErr: h('div', { class: 'notice err small', hidden: true }),
  };
  const copyBtn = h('button', { class: 'btn sm', type: 'button', onclick: copySummary }, '📋 Copy summary');
  const doneBtn = h('button', { class: 'btn sm primary', type: 'button', onclick: () => act(doneBtn, async () => { await postStandup('done'); toast('Standup done ✓', 'ok'); }) }, '✓ Done');
  const skipBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => act(skipBtn, () => postStandup('skip')) }, 'Skip today');
  const standupEl = card('🗣', 'Standup', [
    su.err,
    h('div', { class: 'row' }, su.pill, su.status),
    su.sumErr,
    h('div', { class: 'home-su' },
      h('div', {}, su.yLabel, su.lists.yesterday),
      h('div', {}, h('div', { class: 'home-label' }, 'Today'), su.lists.today),
      h('div', {}, h('div', { class: 'home-label' }, 'Blockers'), su.lists.blockers)),
    h('div', { class: 'row' }, copyBtn, doneBtn, skipBtn),
  ], settingsBtn('Standup'));

  const MAX_ITEMS = 4;
  const suItems = (items) => (items.length ? [
    ...items.slice(0, MAX_ITEMS).map((i) => h('li', { class: 'home-row' },
      i.priority === 'high' && h('span', { class: 'pill err' }, 'high'),
      h('span', { class: 'home-title', title: i.title }, i.title),
      i.note && h('span', { class: `home-meta small ${/overdue|failed/.test(i.note) || i.kind === 'job' ? 'home-overdue' : 'muted'}` }, i.note))),
    items.length > MAX_ITEMS && h('li', { class: 'muted small' }, `+${items.length - MAX_ITEMS} more (in the copied summary)`),
  ] : h('li', { class: 'muted' }, '—'));

  function drawStandup(s, loadError) {
    if (showErr(su.err, s, loadError) || !s) return;
    const st = s.status_today;
    su.pill.className = `pill ${!s.enabled ? '' : s.due_now ? 'warn' : st === 'done' ? 'ok' : ''}`;
    su.pill.textContent = !s.enabled ? 'reminder off' : s.due_now ? 'Due now' : st === 'done' ? '✓ done' : st === 'skipped' ? 'skipped'
      : s.next_at ? `Next ${whenLabel(s.next_at)}` : '—';
    su.status.textContent = st === 'done' ? 'Done for today' : st === 'skipped' ? 'Skipped today'
      : !s.is_standup_day ? 'No standup today' : s.snooze_until ? `Snoozed until ${clockTime(s.snooze_until)}` : `Today at ${s.time} · not done yet`;
    const sum = s.summary;
    su.sumErr.hidden = !sum?.error;
    su.sumErr.textContent = sum?.error ? `Couldn't build the summary: ${sum.error}` : '';
    if (!sum || sum.error) return;
    const prev = new Date(`${sum.previous_day}T00:00`);
    const isYesterday = Math.round((new Date(`${today()}T00:00`) - prev) / 86_400_000) === 1;
    su.yLabel.textContent = isYesterday ? 'Yesterday' : `Yesterday · since ${prev.toLocaleDateString(undefined, { weekday: 'short' })}`;
    clear(su.lists.yesterday, suItems(sum.yesterday));
    clear(su.lists.today, suItems(sum.today));
    clear(su.lists.blockers, suItems(sum.blockers));
  }

  const el = h('div', { class: 'home-grid home-wb' }, screenEl, waterEl, standupEl);
  const problems = h('div');
  const draw = (d, loadError) => {
    drawScreen(d?.screen, loadError);
    drawWater(d?.water, loadError);
    drawStandup(d?.standup, loadError);
    // settings that fell back to defaults: say so once, at the top
    clear(problems, d?.errors?.length ? h('div', { class: 'notice warn small' }, `⚠️ Home settings: ${d.errors.join(' ')}`) : null);
  };
  return { el: h('div', { class: 'stack' }, problems, el), draw };
}

/* ---------------------------------------------------------------- tab */
export async function mount(root, ctx = {}) {
  loadCss('/static/css/home.css');
  let data = null;
  let loading = false;
  let reloadAfter = false;  // a change arrived mid-request: fetch again once it returns
  // data-fkey of controls whose request is in flight. They get aria-disabled, not `disabled`, because a
  // disabled element drops keyboard focus; the busy check is what blocks a second submit.
  const busy = new Set();

  const titleEl = h('h1', { class: 'home-greeting' });
  const dateEl = h('div', { class: 'muted' });
  const statsEl = h('div', { class: 'chips' });
  const grid = h('div', { class: 'home-grid' });

  /* ---- quick add (same syntax as the planner; no date means today) */
  const quick = h('input', { type: 'text', placeholder: 'Add a task for today…   e.g.  Renew SSL cert #ops !high @tomorrow   (Enter)',
    'aria-label': 'Quick add task', onkeydown: (e) => { if (e.key === 'Enter') quickAdd(); } });
  const hint = h('div', { class: 'muted small' });
  quick.addEventListener('input', () => {
    const p = parseQuick(quick.value);
    clear(hint, quick.value.trim() ? [
      h('b', {}, p.title || '(no title)'),
      p.priority !== 'normal' && ` · ${p.priority} priority`,
      ` · due ${prettyDate(p.due || today())}`,
      p.repeat !== 'none' && ` · repeats ${p.repeat}`,
      p.tags.length > 0 && ` · ${p.tags.map((x) => `#${x}`).join(' ')}`,
    ] : QUICK_HINT);
  });
  quick.dispatchEvent(new Event('input'));

  async function quickAdd() {
    const p = parseQuick(quick.value);
    if (!p.title) return;
    if (!p.due) p.due = today();
    try {
      await post('/api/planner/tasks', p);
      quick.value = '';
      quick.dispatchEvent(new Event('input'));
      toast('Task added', 'ok');
      window.dispatchEvent(new Event(CHANGED));
    } catch (e) { toastError(e); }
  }

  // screen time / water / standup: update in place from the shared wellbeing poll
  const wellbeing = wellbeingCards(ctx.service);
  wbListeners.add(wellbeing.draw);
  if (wb.data || wb.error) wellbeing.draw(wb.data, wb.error);
  startWellbeing();  // normally already running from background()

  root.append(
    h('div', { class: 'home-hero' }, h('div', { class: 'stack', style: { gap: '2px' } }, titleEl, dateEl), statsEl),
    h('div', { class: 'card' }, h('div', { class: 'card-body', style: { gap: '6px' } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, quick, h('button', { class: 'btn primary', type: 'button', onclick: quickAdd }, '＋ Add')),
      hint)),
    wellbeing.el,
    grid);

  const visible = () => !root.hidden && document.visibilityState === 'visible';

  async function load() {
    if (loading) { reloadAfter = true; return; }
    loading = true;
    try {
      data = await get('/api/home/summary');
      draw();
    } catch (e) {
      if (!data) clear(grid, h('div', { class: 'notice err' }, `Couldn't load the dashboard: ${e.message}`));
    } finally {
      loading = false;
      if (reloadAfter) { reloadAfter = false; load(); }
    }
  }

  function drawHeader() {
    titleEl.textContent = greeting();
    const week = data?.date?.week ? ` · week ${data.date.week}` : '';
    dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + week;
    const p = data?.planner;
    clear(statsEl, p && !p.error && [
      h('span', { class: 'chip', title: 'Tasks completed today' }, `✅ ${p.done_today} done today`),
      h('span', { class: 'chip', title: 'Tasks completed since Monday' }, `📈 ${p.done_week} this week`),
      p.counts.overdue > 0 && h('a', { class: 'chip home-chip-err', href: '#/planner' }, `⚠️ ${p.counts.overdue} overdue`),
    ]);
  }

  const focusables = () => [...grid.querySelectorAll('a[href], button, input')];
  const byKey = (key) => grid.querySelector(`[data-fkey="${CSS.escape(key)}"]`);

  // Cards are rebuilt from scratch, so put focus back on the same control (by data-fkey) — or, when that one
  // is gone (e.g. the task just completed), on whatever now sits at its position, i.e. the next row.
  function draw() {
    drawHeader();
    const active = grid.contains(document.activeElement) ? document.activeElement : null;
    const key = active?.dataset.fkey;
    const index = active ? focusables().indexOf(active) : -1;
    clear(grid,
      todayCard(data.planner),
      timerCard(data.planner),
      reminderCard(data.planner),
      jobsCard(data.jobs),
      backupCard(data.backup),
      libraryCard(data.library),
      activityCard(data.activity));
    for (const k of busy) markBusy(byKey(k), true);
    if (!active) return;
    const all = focusables();
    (key && byKey(key) || all[Math.min(index, all.length - 1)])?.focus({ preventScroll: true });
  }

  function markBusy(el, on) {
    if (!el) return;
    el.setAttribute('aria-disabled', String(on));
    if (el.type === 'checkbox') el.checked = on;
  }

  /** Runs a request for the control keyed `key` once at a time, keeping it marked busy across redraws. */
  async function inFlight(key, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    markBusy(byKey(key), true);
    try { await fn(); } catch (e) {
      markBusy(byKey(key), false);  // the control may be a redrawn copy by now
      toastError(e);
    } finally { busy.delete(key); }
  }

  /* ---- Today */
  const complete = (task) => inFlight(`done:${task.id}`, async () => {
    const r = await api(`/api/planner/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { status: 'done' } });
    toast(r.spawned ? `Done ✓ — next one due ${prettyDate(r.spawned.due)}` : 'Done ✓', 'ok');
    window.dispatchEvent(new Event(CHANGED));
  });

  function taskRow(t, { overdue = false } = {}) {
    const box = h('input', { type: 'checkbox', 'aria-label': `Complete “${t.title}”`, dataset: { fkey: `done:${t.id}` },
      onclick: (e) => { if (busy.has(`done:${t.id}`)) e.preventDefault(); }, onchange: () => complete(t) });
    const meta = [
      t.priority === 'high' && h('span', { class: 'pill err' }, 'high'),
      overdue && t.due && h('span', { class: 'home-overdue small' }, prettyDate(t.due)),
      t.checklist.total > 0 && h('span', { class: 'muted small', title: 'Checklist' }, `☑ ${t.checklist.done}/${t.checklist.total}`),
      t.tags.slice(0, 3).map((x) => h('span', { class: 'muted small' }, `#${x}`)),
    ];
    return h('li', { class: 'home-row' }, box,
      h('a', { class: `home-title ${overdue ? 'home-overdue' : ''}`, href: `#/planner?ref=task:${encodeURIComponent(t.id)}`, title: t.title, dataset: { fkey: `task:${t.id}` } }, t.title),
      h('span', { class: 'home-meta' }, meta));
  }

  function taskGroup(title, tasks, count, opts) {
    if (!tasks.length) return null;
    return h('div', { class: 'stack', style: { gap: '4px' } },
      label(count > tasks.length ? `${title} · ${tasks.length} of ${count}` : title, opts?.overdue ? 'home-overdue' : ''),
      h('ul', { class: 'home-list' }, tasks.map((t) => taskRow(t, opts))));
  }

  function todayCard(p) {
    const action = linkBtn('#/planner', 'Planner →');
    if (p.error) return card('☀️', 'Today', sectionError(p), action);
    const groups = [
      taskGroup('Overdue', p.overdue, p.counts.overdue, { overdue: true }),
      taskGroup('Due today', p.today, p.counts.today),
      taskGroup('In progress', p.doing, p.counts.doing),
    ].filter(Boolean);
    return card('☀️', 'Today', groups.length ? groups
      : empty('🎉', 'Nothing due today.', p.counts.open ? `${p.counts.open} open task${p.counts.open === 1 ? '' : 's'} for later.` : 'Add one above to get started.'), action);
  }

  /* ---- Focus timer */
  function timerCard(p) {
    if (p.error) return card('⏱️', 'Focus timer', sectionError(p));
    const t = p.timer;
    if (!t) return card('⏱️', 'Focus timer', empty('🧘', 'No timer running.', 'Start one from a task in the Planner.'), linkBtn('#/planner', 'Planner →'));
    const stop = h('button', { class: 'btn sm', type: 'button', dataset: { fkey: `stop:${t.id}` }, onclick: () => inFlight(`stop:${t.id}`, async () => {
      await post(`/api/planner/tasks/${encodeURIComponent(t.id)}/timer`, { action: 'stop' });
      toast('Timer stopped', 'ok');
      window.dispatchEvent(new Event(CHANGED));
    }) }, '■ Stop');
    return card('⏱️', 'Focus timer', [
      h('a', { class: 'home-title', href: `#/planner?ref=task:${encodeURIComponent(t.id)}`, title: t.title }, t.title),
      h('div', { class: 'home-timer', role: 'timer', 'aria-label': 'Time spent on this task' }, ticking(t.started_at, t.time_spent, 'clock')),
      h('div', { class: 'row' }, stop, h('span', { class: 'muted small' }, `started ${fmt.ago(t.started_at)}`)),
    ], h('span', { class: 'pill run' }, 'running'));
  }

  /* ---- Next reminder */
  function reminderCard(p) {
    if (p.error) return card('⏰', 'Next reminder', sectionError(p));
    const r = p.next_reminder;
    if (!r) return card('⏰', 'Next reminder', empty('🔕', 'No reminders pending.', 'Set “Remind me at” on a task.'));
    const due = r.remind_at <= now();
    return card('⏰', 'Next reminder', [
      h('a', { class: 'home-title', href: `#/planner?ref=task:${encodeURIComponent(r.id)}`, title: r.title }, r.title),
      h('div', { class: 'row' },
        h('span', { class: `pill ${due ? 'warn' : 'run'}` }, due ? 'due' : relTime(r.remind_at)),
        h('span', { class: 'muted small' }, new Date(r.remind_at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))),
    ]);
  }

  /* ---- Jobs */
  const openJobs = () => document.getElementById('jobs-btn')?.click();

  function jobRow(j) {
    const when = j.status === 'running' ? ticking(j.started_at, 0, 'duration') : `${fmt.ago(j.ended_at || j.started_at)} · ${fmt.duration(j.duration)}`;
    return h('li', {}, h('button', { type: 'button', class: 'home-row home-row-btn', onclick: openJobs, title: 'Open the jobs drawer', dataset: { fkey: `job:${j.id}` } },
      statusPill(j.status), h('span', { class: 'home-title' }, j.title), h('span', { class: 'home-meta muted small' }, when)));
  }

  function jobsCard(j) {
    const action = h('button', { class: 'btn sm ghost', type: 'button', onclick: openJobs }, 'All jobs →');
    if (j.error) return card('⚙️', 'Jobs', sectionError(j), action);
    if (!j.running.length && !j.finished.length) return card('⚙️', 'Jobs', empty('💤', 'No jobs in this server session.', 'Runs from the Pipeline and Library show up here.'), action);
    return card('⚙️', 'Jobs', [
      j.running.length > 0 && [label(`Running · ${j.running.length}`), h('ul', { class: 'home-list' }, j.running.map(jobRow))],
      j.finished.length > 0 && [label('Recently finished'), h('ul', { class: 'home-list' }, j.finished.map(jobRow))],
    ], action);
  }

  /* ---- Backup */
  function backupCard(b) {
    if (b.error) return card('💾', 'Backup', sectionError(b));
    const backupNow = linkBtn('#/guide?ref=backup', 'Back up now →');
    if (!b.last) {
      return card('💾', 'Backup', [h('div', { class: 'row' }, h('span', { class: 'pill warn' }, 'never'), h('span', {}, 'No backup recorded yet.')), backupNow]);
    }
    const failed = ['failed', 'error'].includes(b.last.status);
    return card('💾', 'Backup', [
      h('div', { class: 'row' },
        h('span', { class: `pill ${failed ? 'err' : b.stale ? 'warn' : 'ok'}` }, failed ? 'failed' : b.stale ? 'stale' : 'fresh'),
        h('span', {}, `Last backup ${fmt.ago(b.last.ts)}`)),
      b.last.target && h('div', { class: 'mono small muted home-path', title: b.last.target }, b.last.target),
      b.stale ? backupNow : h('div', { class: 'muted small' }, `Next one is due in ${Math.max(0, Math.ceil(7 - b.age_days))} d.`),
    ]);
  }

  /* ---- Library */
  async function useItem(item, track) {
    if (item.content === null || placeholders(item.content).length) {
      location.hash = `#/library?ref=${encodeURIComponent(item.path)}`;
      return;
    }
    await copyText(fillTemplate(item.content, {}), `Copied ${item.name}`);
    if (track) post('/api/library/items/use', { path: item.path }).then(() => load()).catch(toastError);
  }

  function itemRow(item, section, track) {
    const direct = item.content !== null && !placeholders(item.content).length;
    return h('li', { class: 'home-row' },
      h('span', { 'aria-hidden': 'true' }, TYPE_ICON[item.type] || '📄'),
      h('a', { class: 'home-title', href: `#/library?ref=${encodeURIComponent(item.path)}`, title: item.path, dataset: { fkey: `${section}:open:${item.path}` } }, item.name),
      h('span', { class: 'home-meta' },
        item.env && h('span', { class: `pill ${item.env === 'prod' ? 'err' : ''}` }, item.env),
        h('button', { class: 'btn sm', type: 'button', title: direct ? 'Copy to clipboard' : 'Has fill-in fields: open in the Library',
          'aria-label': `${direct ? 'Copy' : 'Fill in'} ${item.name}`, dataset: { fkey: `${section}:use:${item.path}` },
          onclick: () => useItem(item, track) }, direct ? '⧉ Copy' : '✎ Fill')));
  }

  function libraryCard(l) {
    const action = linkBtn('#/library', 'Library →');
    if (l.error) return card('📚', 'Library', sectionError(l), action);
    if (l.hint) return card('📚', 'Library', h('div', { class: 'notice' }, l.hint), action);
    if (!l.favourites.length && !l.recent.length) return card('📚', 'Library', [l.warning && h('div', { class: 'notice warn small' }, `⚠️ ${l.warning}`), empty('⭐', 'No favourites yet.', 'Star queries and commands in the Library to keep them one click away.')], action);
    const favPaths = new Set(l.favourites.map((i) => i.path));
    const recent = l.recent.filter((i) => !favPaths.has(i.path));
    const track = !l.warning;  // the Library refuses the usage write while the folder isn't git-safe
    return card('📚', 'Library', [
      l.warning && h('div', { class: 'notice warn small' }, `⚠️ ${l.warning}`),
      l.favourites.length > 0 && [label('⭐ Favourites'), h('ul', { class: 'home-list' }, l.favourites.map((i) => itemRow(i, 'fav', track)))],
      recent.length > 0 && [label('🕘 Recently used'), h('ul', { class: 'home-list' }, recent.map((i) => itemRow(i, 'recent', track)))],
    ], action);
  }

  /* ---- Recent activity */
  function activityCard(a) {
    const action = linkBtn('#/activity', 'All activity →');
    if (a.error) return card('📜', 'Recent activity', sectionError(a), action);
    if (!a.events.length) return card('📜', 'Recent activity', empty('🌱', 'Nothing has run yet.', 'Jobs, backups and library runs are logged here.'), action);
    return card('📜', 'Recent activity', h('ul', { class: 'home-list' }, a.events.map((e) => h('li', { class: 'home-row' },
      h('span', { 'aria-hidden': 'true', title: e.kind }, KIND_ICON[e.kind] || '•'),
      h('span', { class: 'home-title', title: `${e.kind} · ${e.action} ${e.target || ''}` }, h('span', { class: 'muted' }, `${e.action} `), e.target || e.kind),
      h('span', { class: 'home-meta' },
        e.env && h('span', { class: `pill ${e.env === 'prod' ? 'err' : ''}` }, e.env),
        e.status && statusPill(e.status),
        h('span', { class: 'muted small', title: new Date(e.ts * 1000).toLocaleString() }, relTime(e.ts)))))), action);
  }

  /* ---- live updates */
  setInterval(() => {
    if (!visible()) return;
    for (const el of root.querySelectorAll('[data-tick-from]')) {
      const s = Number(el.dataset.tickBase) + now() - Number(el.dataset.tickFrom);
      el.textContent = el.dataset.tickFmt === 'clock' ? clock(s) : fmt.duration(s);
    }
  }, 1000);
  setInterval(() => { if (visible()) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (visible()) load(); });
  window.addEventListener(CHANGED, load);

  drawHeader();
  clear(grid, h('p', { class: 'muted' }, 'Loading…'));
  await load();
  return { onShow: () => { load(); wbLoad(); } };
}
