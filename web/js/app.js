// App shell: sidebar navigation, hash routing, lazy-loaded service tabs, jobs drawer, theme, Ctrl+K palette.
//
// A service tab is web/js/services/<service-id>.js exporting `mount(container, ctx)`.
// It may return { onShow() } to refresh when its tab becomes visible again, and { open(ref) } to show one
// thing (a search result, 'new', …): open(serviceId, ref) below, the palette and #/<id>?ref=<ref> links call it.
// Tabs are mounted once and kept alive, so running jobs keep streaming while you switch tabs.

import { get } from './core/api.js';
import { clear, fmt, h, modal, store, toast, toastError } from './core/dom.js';
import { jobConsole, statusPill } from './core/components.js';
import { createPalette } from './core/palette.js';

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const descEl = document.getElementById('page-desc');

let services = [];
const mounted = new Map(); // id -> { panel, hooks }
let currentId = null;

async function boot() {
  try {
    services = await get('/api/services');
  } catch (e) {
    titleEl.textContent = 'Could not reach the server';
    descEl.textContent = e.message;
    return;
  }
  clear(nav, services.map((s) => h('a', { class: 'nav-item', href: `#/${s.id}`, dataset: { id: s.id } },
    h('span', { class: 'nav-icon' }, s.icon), h('span', {}, s.title))));
  // service packages that crashed on import: visible, so a typo in a new tab doesn't just vanish
  get('/api/services-failed').then((failed) => {
    for (const f of failed) {
      nav.append(h('div', { class: 'nav-item muted', title: f.traceback }, h('span', { class: 'nav-icon' }, '⚠️'), h('span', {}, `${f.name} (failed)`)));
    }
  }).catch(() => {});
  setupPalette();
  window.addEventListener('hashchange', route);
  route();
  pollJobs();
  startBackground();
}

// services flagged `background` get their module's background(ctx) started at page load
function startBackground() {
  for (const s of services.filter((x) => x.background)) {
    import(`./services/${s.id}.js`)
      .then((mod) => mod.background?.({ service: s }))
      .catch((e) => console.error(`background task of ${s.id} failed`, e));
  }
}

// #/<id> or #/<id>?ref=<urlencoded>: the ref is handed to the tab's open() once, then dropped from the URL
async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const id = path || store.get('eu.lastTab', services[0]?.id);
  const ref = new URLSearchParams(query).get('ref');
  const service = services.find((s) => s.id === id) || services[0];
  if (!service) return;
  if (location.hash !== `#/${service.id}`) history.replaceState(null, '', `#/${service.id}`);
  const entry = await show(service);
  if (ref !== null && service.id === id) await callOpen(service, entry, ref);
}

/** Navigate to a tab (adding a history entry) and, with a ref, ask it to open that item. */
async function open(serviceId, ref) {
  const service = services.find((s) => s.id === serviceId);
  if (!service) return toast(`No “${serviceId}” tab`, 'err');
  if (location.hash !== `#/${service.id}`) history.pushState(null, '', `#/${service.id}`);  // no hashchange: shown here
  const entry = await show(service);
  if (ref !== undefined && ref !== null && ref !== '') await callOpen(service, entry, ref);
}

async function callOpen(service, entry, ref) {
  if (!entry.hooks?.open) return toast(`${service.title} cannot open “${ref}”`, 'err');
  try { await entry.hooks.open(ref); } catch (e) { toastError(e); }
}

// shows a tab, mounting it on first use; resolves with its { panel, hooks } once mounted
async function show(service) {
  currentId = service.id;
  store.set('eu.lastTab', service.id);

  for (const a of nav.children) a.classList.toggle('active', a.dataset.id === service.id);
  titleEl.textContent = `${service.icon}  ${service.title}`;
  descEl.textContent = service.description;
  document.title = `${service.title} · Everyday Utility`;

  for (const { panel } of mounted.values()) panel.hidden = true;
  let entry = mounted.get(service.id);
  if (!entry) {
    const panel = h('div', { class: 'view' });
    view.append(panel);
    entry = { panel, hooks: null };
    mounted.set(service.id, entry);
    entry.ready = (async () => {
      try {
        const mod = await import(`./services/${service.id}.js`);
        entry.hooks = (await mod.mount(panel, { service, open })) || null;
      } catch (e) {
        console.error(e);
        panel.append(h('div', { class: 'notice err' }, `Failed to load this tab: ${e.message}`));
      }
    })();
  } else {
    entry.hooks?.onShow?.();
  }
  await entry.ready;  // also when a second open() arrives while the first mount is still loading
  // the user may have switched tabs while this one was loading
  if (currentId === service.id) entry.panel.hidden = false;
  return entry;
}

/* ---------- command palette (Ctrl+K / Cmd+K) ---------- */
function setupPalette() {
  const has = (id) => services.some((s) => s.id === id);
  const actions = [
    { id: 'new-task', title: 'New task', icon: '✅', hint: 'Planner', run: () => open('planner', 'new'), service: 'planner' },
    { id: 'new-library-item', title: 'New library item', icon: '📚', hint: 'Library', run: () => open('library', 'new'), service: 'library' },
    { id: 'add-login', title: 'Add login', icon: '🔑', hint: 'Manager · Logins', run: () => open('manager', 'new-login'), service: 'manager' },
    { id: 'backup', title: 'Create backup', icon: '💾', hint: 'Guide', run: () => open('guide', 'backup'), service: 'guide' },
    { id: 'theme', title: 'Toggle theme', icon: '🌓', hint: 'Light / dark', run: toggleTheme },
    { id: 'jobs', title: 'Show jobs', icon: '⚙️', hint: 'Background jobs drawer', run: () => document.getElementById('jobs-btn').click() },
  ].filter((a) => !a.service || has(a.service));
  const palette = createPalette({ services, actions, open });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  nav.parentNode.insertBefore(h('button', { class: 'nav-item pal-trigger', type: 'button', title: 'Search everything',
    'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K', onclick: () => palette.show() },
  h('span', { class: 'nav-icon' }, '🔎'), h('span', {}, 'Search'),
  h('span', { class: 'pal-keys' }, h('kbd', {}, mac ? '⌘' : 'Ctrl'), h('kbd', {}, 'K'))), nav);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.toggle();
    }
  });
}

/* ---------- jobs indicator + drawer ---------- */
const badge = document.getElementById('jobs-badge');

async function pollJobs() {
  try {
    const jobs = await get('/api/jobs');
    const running = jobs.filter((j) => j.status === 'running').length;
    badge.hidden = !running;
    badge.textContent = running;
  } catch { /* server restarting */ }
  setTimeout(pollJobs, 4000);
}

document.getElementById('jobs-btn').addEventListener('click', () => modal('Jobs', () => {
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  get('/api/jobs').then((jobs) => {
    if (!jobs.length) return clear(list, h('p', { class: 'muted' }, 'No jobs yet in this server session.'));
    clear(list, jobs.map((j) => {
      const slot = h('div', {});
      const row = h('button', { type: 'button', class: 'file-chip', style: { cursor: 'pointer', width: '100%', textAlign: 'left', background: 'none', color: 'inherit', font: 'inherit' },
        title: 'Show output', 'aria-expanded': 'false',
        onclick: () => {
          if (slot.firstChild) { slot.firstChild.close?.(); clear(slot); row.setAttribute('aria-expanded', 'false'); }
          else { slot.append(jobConsole(j)); row.setAttribute('aria-expanded', 'true'); }
        } },
      statusPill(j.status),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, j.title),
        h('div', { class: 'muted small' }, `${fmt.ago(j.started_at)} · ${fmt.duration(j.duration)}`)));
      return h('div', { class: 'stack' }, row, slot);
    }));
  }).catch(toastError);
  return list;
}, { drawer: true }));

/* ---------- theme ---------- */
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  store.set('eu.theme', root.dataset.theme);
}
document.getElementById('theme-btn').addEventListener('click', toggleTheme);

boot();
