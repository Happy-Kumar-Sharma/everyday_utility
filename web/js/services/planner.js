// Planner tab: tasks (status, priority, due, reminders, repeat, tags, checklists), done log, daily notes.
// background() runs from page load so reminders fire whichever tab is open.

import { api, get, post } from '../core/api.js';
import { checkbox, segmented } from '../core/components.js';
import { clear, confirmDialog, debounce, downloadText, h, modal, store, toast, toastError } from '../core/dom.js';

const API = '/api/planner';
const CHANGED = 'planner:changed';  // window event: data changed elsewhere (e.g. reminder acked)

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
}

function showReminder(t) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`⏰ ${t.title}`, { body: t.notes || (t.due ? `Due ${prettyDate(t.due)}` : ''), tag: `planner-${t.id}` });
      n.onclick = () => { window.focus(); location.hash = '#/planner'; };
    } catch { /* some platforms disallow page-created notifications */ }
  }
  const act = async (fn, msg) => {
    try { await fn(); el.remove(); shown.delete(t.id); if (msg) toast(msg, 'ok'); window.dispatchEvent(new Event(CHANGED)); } catch (e) { toastError(e); }
  };
  const snooze = (m) => act(() => post(`${API}/reminders/${t.id}/ack`, { minutes: m }), `Snoozed ${m >= 60 ? `${m / 60} h` : `${m} min`}`);
  const el = h('div', { class: 'toast', role: 'alert', style: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--accent)' } },
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

/* ================================================================ tab */
const VIEWS = [
  { value: 'today', label: '☀️ Today' },
  { value: 'upcoming', label: '📅 Upcoming' },
  { value: 'all', label: '📋 All open' },
  { value: 'done', label: '✅ Done' },
  { value: 'notes', label: '📝 Daily notes' },
];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };

export async function mount(root) {
  let tasks = [];
  let view = store.get('eu.plan.view', 'today');
  let query = '';
  let tagFilter = null;

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
    try { await post(`${API}/tasks`, p); quick.value = ''; quick.dispatchEvent(new Event('input')); await load(); } catch (e) { toastError(e); }
  }

  const notifyBtn = h('button', { class: 'btn sm', type: 'button', hidden: !('Notification' in window) || Notification.permission !== 'default',
    onclick: async () => { await Notification.requestPermission(); notifyBtn.hidden = Notification.permission !== 'default'; } }, '🔔 Enable desktop notifications');

  const stats = h('div', { class: 'status-grid' });
  const search = h('input', { type: 'text', placeholder: 'Search…', style: { maxWidth: '240px' }, oninput: debounce(() => { query = search.value.trim().toLowerCase(); draw(); }, 120) });
  const tagsEl = h('div', { class: 'chips' });
  const content = h('div', { class: 'stack', style: { gap: '16px' } });

  root.append(
    h('div', { class: 'card' }, h('div', { class: 'card-body', style: { gap: '6px' } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, quick, h('button', { class: 'btn primary', type: 'button', onclick: quickAdd }, '＋ Add'),
        h('button', { class: 'btn', type: 'button', title: 'Add with all fields', onclick: () => editTask(null) }, '⋯')),
      hint)),
    stats,
    h('div', { class: 'row' },
      segmented(VIEWS, view, (v) => { view = v; store.set('eu.plan.view', v); draw(); }),
      h('span', { style: { flex: 1 } }), notifyBtn,
      h('button', { class: 'btn sm', type: 'button', onclick: exportAll }, '⬇ Export .txt')),
    h('div', { class: 'row' }, search, tagsEl),
    content);

  async function load() {
    try { tasks = await get(`${API}/tasks`); draw(); } catch (e) { toastError(e); }
  }
  window.addEventListener(CHANGED, load);

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
    const go = (v) => () => { view = v; store.set('eu.plan.view', v); rebuildSeg(); draw(); };
    clear(stats,
      card('Overdue', o.filter((x) => x.due && x.due < t).length, o.some((x) => x.due && x.due < t) ? 'err' : null, go('today')),
      card('Due today', o.filter((x) => x.due === t).length, null, go('today')),
      card('In progress', o.filter((x) => x.status === 'doing').length, null, go('all')),
      card('Open', o.length, null, go('all')),
      card('Done today', doneToday, doneToday ? 'ok' : null, go('done')),
      card('Done in 7 days', doneWeek, null, go('done')));
  }
  // the view switcher row is rebuilt when a stat card changes the view
  function rebuildSeg() {
    const row = root.children[2];
    row.replaceChild(segmented(VIEWS, view, (v) => { view = v; store.set('eu.plan.view', v); draw(); }), row.firstChild);
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
            try { const r = await post(`${API}/tasks/clear-done`, { older_than_days: 30 }); toast(`Removed ${r.removed}`); load(); } catch (e) { toastError(e); }
          } }, 'Clear done > 30 days')),
        done.length ? Object.keys(groups).map((d) => section(prettyDate(d), groups[d])) : h('div', { class: 'notice' }, 'Nothing completed yet.'));
    } else {
      drawNotes();
    }
  }

  /* ---- task row */
  function patch(t, body, msg) {
    return api(`${API}/tasks/${t.id}`, { method: 'PATCH', body }).then((r) => {
      if (r.spawned) toast(`Next “${r.spawned.title}” scheduled for ${prettyDate(r.spawned.due)}`, 'ok');
      else if (msg) toast(msg, 'ok');
      return load();
    }).catch(toastError);
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
          t.tags.map((tag) => h('span', { class: 'pill' }, `#${tag}`)),
          t.notes && h('span', { class: 'muted small', title: t.notes }, '📝'))),
        !done && h('button', { class: 'btn sm ghost', type: 'button', title: t.status === 'doing' ? 'Back to todo' : 'Start (in progress)',
          onclick: () => patch(t, { status: t.status === 'doing' ? 'todo' : 'doing' }) }, t.status === 'doing' ? '⏸' : '▶'),
        !done && t.due !== tday && h('button', { class: 'btn sm ghost', type: 'button', title: 'Move to today', onclick: () => patch(t, { due: tday }, 'Moved to today') }, '☀️'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Delete', onclick: async () => {
          if (!(await confirmDialog('Delete task?', `“${t.title}”`, { okLabel: 'Delete', danger: true }))) return;
          try { await api(`${API}/tasks/${t.id}`, { method: 'DELETE' }); load(); } catch (e) { toastError(e); }
        } }, '🗑')),
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
          else { await post(`${API}/tasks`, body); toast('Added', 'ok'); load(); }
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
      try { await api(`${API}/notes/${noteDay}`, { method: 'PUT', body: { text: area.value } }); dirty = false; status.textContent = 'Saved'; loadIndex(); } catch (e) { toastError(e); }
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

  await load();
  // re-render every minute so "today" / overdue roll over at midnight without a reload
  setInterval(() => { if (root.isConnected && !root.closest('[hidden]') && view !== 'notes') draw(); }, 60_000);
  return { onShow: load };
}
