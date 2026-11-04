// Command palette (Ctrl+K / Cmd+K): tabs and actions matched in the browser, plus every tab's server search
// (GET /api/search). Choosing a result calls open(serviceId, ref) from app.js; the last 8 choices are remembered.

import { get } from './api.js';
import { clear, debounce, h, loadCss, store } from './dom.js';

const RECENT_KEY = 'eu.palette.recent';
const RECENT_MAX = 8;

/** Positions of q's characters in text: a contiguous substring if there is one, else a fuzzy subsequence. */
function matchPositions(text, q) {
  const t = text.toLowerCase();
  q = q.toLowerCase();
  if (!q) return [];
  const at = t.indexOf(q);
  if (at >= 0) return Array.from(q, (_, i) => at + i);
  const out = [];
  let from = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** text with the matched characters wrapped in <span class="pal-hl"> (built with h(), never innerHTML).
 *  Whole query, else each word; `fuzzy` (tab / action titles) falls back to scattered characters. */
function highlighted(text, q, fuzzy = false) {
  const t = text.toLowerCase();
  const span = (i, len) => Array.from({ length: len }, (_, k) => i + k);
  let pos = t.includes(q.toLowerCase()) ? matchPositions(text, q)
    : q.toLowerCase().split(/\s+/).filter(Boolean).flatMap((w) => { const i = t.indexOf(w); return i < 0 ? [] : span(i, w.length); });
  if (!pos.length && fuzzy) pos = matchPositions(text, q) || [];
  const hits = new Set(pos);
  const parts = [];
  let run = '', runHit = false;
  const flush = () => { if (run) parts.push(runHit ? h('span', { class: 'pal-hl' }, run) : run); run = ''; };
  for (let i = 0; i < text.length; i++) {  // UTF-16 indices, like indexOf
    if (hits.has(i) !== runHit) { flush(); runHit = !runHit; }
    run += text[i];
  }
  flush();
  return parts;
}

// fewer, tighter-packed matched characters rank first
function fuzzyScore(text, q) {
  const pos = matchPositions(text, q);
  if (!pos) return null;
  if (!pos.length) return 0;
  return (text.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 10) + (pos[pos.length - 1] - pos[0]);
}

/**
 * createPalette({ services, actions, open }) -> { show, hide, toggle }
 *   services: [{id, title, icon}]      actions: [{id, title, icon, hint?, run()}]
 *   open(serviceId, ref?): navigate to a tab (and hand it ref)
 */
export function createPalette({ services, actions, open }) {
  loadCss('/static/css/palette.css');
  let items = [];       // flat list of choosable rows, in display order
  let active = 0;
  let seq = 0;          // ignores server responses that arrive after a newer query
  let server = [];      // groups from /api/search for the current query
  let loading = false;
  let returnFocus = null;

  const input = h('input', { type: 'text', class: 'pal-input', placeholder: 'Search tasks, library, logins, env files… or type a command',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  const foot = h('div', { class: 'pal-foot muted small' },
    h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move'), h('span', {}, h('kbd', {}, 'Enter'), ' open'), h('span', {}, h('kbd', {}, 'Esc'), ' close'));
  // Clicks anywhere but the input must not steal its focus, or the keyboard handling (and Esc) would stop working.
  const box = h('div', { class: 'pal card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search',
    onmousedown: (e) => { if (e.target !== input) e.preventDefault(); } },
    h('div', { class: 'pal-head' }, h('span', { class: 'pal-glass', 'aria-hidden': 'true' }, '🔎'), input), list, foot);
  const overlay = h('div', { class: 'pal-overlay', hidden: true, onmousedown: (e) => { if (e.target === overlay) hide(); } }, box);
  document.body.append(overlay);

  const serviceById = (id) => services.find((s) => s.id === id);
  const keyOf = (it) => `${it.kind}:${it.service || ''}:${it.ref ?? it.id ?? ''}`;

  /* ---- data */
  function recents() {
    return store.get(RECENT_KEY, []).map((r) => {
      if (r.kind === 'action') { const a = actions.find((x) => x.id === r.id); return a && { ...a, kind: 'action', subtitle: a.hint }; }
      if (r.kind === 'tab') { const s = serviceById(r.service); return s && { kind: 'tab', service: s.id, title: s.title, icon: s.icon }; }
      return serviceById(r.service) && r;
    }).filter(Boolean);
  }

  function remember(it) {
    const entry = it.kind === 'action' ? { kind: 'action', id: it.id }
      : { kind: it.kind, service: it.service, ref: it.ref, title: it.title, subtitle: it.subtitle, icon: it.icon };
    const rest = store.get(RECENT_KEY, []).filter((r) => keyOf(r) !== keyOf(entry));
    store.set(RECENT_KEY, [entry, ...rest].slice(0, RECENT_MAX));
  }

  function clientGroups(q) {
    const tabs = services.map((s) => ({ kind: 'tab', service: s.id, title: s.title, icon: s.icon, subtitle: 'Go to tab', score: fuzzyScore(s.title, q) }));
    const acts = actions.map((a) => ({ ...a, kind: 'action', subtitle: a.hint, score: fuzzyScore(a.title, q) }));
    const pick = (xs) => (q ? xs.filter((x) => x.score !== null).sort((a, b) => a.score - b.score) : xs);
    return [{ title: 'Tabs', icon: '🗂️', results: pick(tabs) }, { title: 'Actions', icon: '⚡', results: pick(acts) }];
  }

  /* ---- render */
  function render() {
    const q = input.value.trim();
    const groups = q ? [...clientGroups(q), ...server.map((g) => ({ ...g, results: g.results.map((r) => ({ ...r, kind: 'result' })) }))]
      : [{ title: 'Recent', icon: '🕘', results: recents() }, ...clientGroups('').reverse()];
    items = [];
    const nodes = [];
    for (const g of groups.filter((x) => x.results.length)) {
      nodes.push(h('div', { class: 'pal-group', role: 'presentation' }, h('span', { 'aria-hidden': 'true' }, g.icon), ' ', g.title));
      for (const it of g.results) nodes.push(row(it, items.push(it) - 1, q));
    }
    if (q && loading) nodes.push(h('div', { class: 'pal-empty muted small' }, 'Searching…'));
    else if (!items.length) nodes.push(h('div', { class: 'pal-empty muted' }, q ? `Nothing found for “${q}”.` : 'Type to search.'));
    active = Math.min(active, Math.max(0, items.length - 1));
    clear(list, nodes);
    mark();
  }

  function row(it, i, q) {
    const svc = it.kind === 'result' && serviceById(it.service);
    return h('div', { class: 'pal-item', role: 'option', id: `pal-opt-${i}`, 'aria-selected': 'false', dataset: { i },
      onmousemove: () => { if (active !== i) { active = i; mark(false); } },
      onclick: () => choose(it) },
    h('span', { class: 'pal-icon', 'aria-hidden': 'true' }, it.icon || '•'),
    h('span', { class: 'pal-text' },
      h('span', { class: 'pal-title' }, highlighted(it.title || '', q, it.kind !== 'result')),
      it.subtitle && h('span', { class: 'pal-sub muted small' }, highlighted(it.subtitle, q))),
    h('span', { class: 'pal-kind muted small' }, it.kind === 'tab' ? 'Tab' : it.kind === 'action' ? 'Action' : svc ? svc.title : ''));
  }

  function mark(scroll = true) {
    for (const el of list.querySelectorAll('.pal-item')) {
      const on = Number(el.dataset.i) === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    }
    if (items.length) input.setAttribute('aria-activedescendant', `pal-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /* ---- server search */
  const fetchServer = debounce(async (q, id) => {
    let groups = [];
    try { groups = await get('/api/search', { q }); } catch { /* server unreachable: client results still work */ }
    if (id !== seq) return;
    server = groups;
    loading = false;
    render();
  }, 150);

  function onInput() {
    const q = input.value.trim();
    const id = ++seq;
    server = [];
    active = 0;
    loading = !!q;
    render();
    if (q) fetchServer(q, id);
  }

  /* ---- choose / keyboard */
  function choose(it) {
    if (!it) return;
    remember(it);
    hide();
    if (it.kind === 'action') it.run();
    else open(it.service, it.kind === 'result' ? it.ref : undefined);
  }

  function onKey(e) {
    const move = (d) => { e.preventDefault(); if (items.length) { active = (active + d + items.length) % items.length; mark(); } };
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }  // don't also close a modal underneath
    else if (e.key === 'Tab') e.preventDefault();  // focus stays in the dialog
  }
  input.addEventListener('input', onInput);
  overlay.addEventListener('keydown', onKey);  // any focused descendant, so Esc never reaches a modal underneath

  /* ---- show / hide */
  function show() {
    if (!overlay.hidden) return input.select();
    returnFocus = document.activeElement;
    overlay.hidden = false;
    input.value = '';
    onInput();
    input.focus();
  }

  function hide() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    seq++;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  return { show, hide, toggle: () => (overlay.hidden ? show() : hide()) };
}
