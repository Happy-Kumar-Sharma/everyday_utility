// App shell: sidebar navigation, hash routing, lazy-loaded service tabs, jobs drawer, theme.
//
// A service tab is web/js/services/<service-id>.js exporting `mount(container, ctx)`.
// It may return { onShow() } to refresh when its tab becomes visible again.
// Tabs are mounted once and kept alive, so running jobs keep streaming while you switch tabs.

import { get } from './core/api.js';
import { clear, fmt, h, modal, store, toastError } from './core/dom.js';
import { jobConsole, statusPill } from './core/components.js';

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

async function route() {
  const id = location.hash.replace(/^#\/?/, '') || store.get('eu.lastTab', services[0]?.id);
  const service = services.find((s) => s.id === id) || services[0];
  if (!service) return;
  currentId = service.id;
  if (location.hash !== `#/${service.id}`) history.replaceState(null, '', `#/${service.id}`);
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
    try {
      const mod = await import(`./services/${service.id}.js`);
      entry.hooks = (await mod.mount(panel, { service })) || null;
    } catch (e) {
      console.error(e);
      panel.append(h('div', { class: 'notice err' }, `Failed to load this tab: ${e.message}`));
    }
  } else {
    entry.hooks?.onShow?.();
  }
  // the user may have switched tabs while this one was loading
  if (currentId === service.id) entry.panel.hidden = false;
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
document.getElementById('theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  store.set('eu.theme', root.dataset.theme);
});

boot();
