// 🗞 Web Clipper: paste a public URL -> Markdown + every image in a folder (background job, any page length).
// Everything from the clipped page is untrusted: it is only ever put into the DOM as text (h() / textContent)
// or loaded as <img> through the sandboxed /file endpoint — never as HTML.

import { get, post } from '../core/api.js';
import { checkbox, jobConsole, openSettings } from '../core/components.js';
import { clear, confirmDialog, copyText, fmt, h, loadCss, modal, store, toast, toastError } from '../core/dom.js';

const API = '/api/clipper';
const OPTS_KEY = 'eu.clip.opts';
const IMAGE_PAGE = 240;  // thumbnails rendered per "Show more"

const fileUrl = (name, path) => `${API}/clips/${encodeURIComponent(name)}/file?${new URLSearchParams({ path })}`;
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const safeHref = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

export async function mount(root, { service }) {
  loadCss('/static/css/clipper.css');
  let status = null;
  let clips = [];
  let running = null;      // { job, console, poll, since }
  let current = null;      // detail of the clip shown in the result card
  const opts = { mode: 'auto', content: 'main', images: true, html: false, ...store.get(OPTS_KEY, {}) };
  const saveOpts = () => store.set(OPTS_KEY, opts);

  /* ------------------------------------------------------------------ layout */
  const banner = h('div', {});
  const urlInput = h('input', {
    type: 'text', class: 'clip-url', placeholder: 'https://example.com/some/long/article', autocomplete: 'off',
    spellcheck: false, 'aria-label': 'Page URL', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } },
  });
  const clipBtn = h('button', { class: 'btn primary clip-go', type: 'button', onclick: () => start() }, '✂ Clip');
  const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mode' });
  const contentSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Content' });
  const modeHint = h('div', { class: 'muted small' });
  const form = h('div', { class: 'card clip-form' }, h('div', { class: 'card-body' },
    h('div', { class: 'clip-url-row' }, urlInput, clipBtn),
    h('div', { class: 'row clip-opts' },
      h('span', { class: 'clip-label' }, 'Mode'), modeSeg,
      h('span', { class: 'clip-label' }, 'Content'), contentSeg,
      checkbox('Download images', opts.images, (v) => { opts.images = v; saveOpts(); }, 'Save every image of the page into the clip folder'),
      checkbox('Save raw HTML', opts.html, (v) => { opts.html = v; saveOpts(); }, 'Also keep the page HTML as fetched / rendered (page.html)')),
    modeHint));
  const progress = h('div', { class: 'clip-progress', hidden: true });
  const runArea = h('div', { class: 'stack' });
  const result = h('div', {});
  const historyEl = h('div', { class: 'clip-history' });
  const historyCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'History'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', type: 'button', title: 'Clips folder and limits', onclick: settings }, '⚙ Settings')),
    h('div', { class: 'card-body' }, historyEl));
  root.append(h('div', { class: 'stack clip-page' }, banner, form, progress, runArea, result, historyCard));

  /* ------------------------------------------------------------------ option controls */
  function seg(el, options, value, onChange) {
    clear(el, options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === value), class: o.value === value ? 'on' : '',
      title: o.title, disabled: o.disabled,
      onclick: () => { if (!o.disabled) { onChange(o.value); } },
    }, o.label)));
  }

  function renderOptions() {
    const chrome = status?.chrome;
    if (!chrome && opts.mode === 'browser') opts.mode = 'auto';
    seg(modeSeg, [
      { value: 'auto', label: 'Auto', title: 'Static download first; switches to the browser when the page is rendered by JavaScript' },
      { value: 'static', label: 'Static', title: 'Download the HTML only (fast, no JavaScript)' },
      { value: 'browser', label: 'Browser', disabled: !chrome,
        title: chrome ? `Render with headless Chrome (${chrome}): JavaScript pages, lazy images, very long pages`
          : 'No Google Chrome / Chromium found on this machine' },
    ], opts.mode, (v) => { opts.mode = v; saveOpts(); renderOptions(); });
    seg(contentSeg, [
      { value: 'main', label: 'Main article', title: 'Readability-style: the article without menus, sidebars, comments, ads' },
      { value: 'full', label: 'Whole page', title: 'Everything in the page body (scripts and hidden parts removed)' },
    ], opts.content, (v) => { opts.content = v; saveOpts(); renderOptions(); });
    modeHint.textContent = opts.mode === 'static' ? 'Static: one guarded download of the HTML; images are fetched with the same address checks.'
      : chrome ? 'In browser mode Chrome loads the page and everything it pulls in itself; the clipper checks the page address and every image it downloads.'
        : 'Browser rendering is unavailable (no Chrome / Chromium found) — Auto keeps the static result.';
  }

  /* ------------------------------------------------------------------ data */
  async function loadStatus() {
    try { status = await get(`${API}/status`); } catch (e) { toastError(e); }
    renderBanner();
    renderOptions();
  }

  async function loadClips() {
    try {
      const data = await get(`${API}/clips`);
      clips = data.clips;
    } catch (e) { toastError(e); clips = []; }
    renderHistory();
  }

  function renderBanner() {
    if (!status) return clear(banner);
    const g = status.git || {};
    clear(banner, !status.writable && h('div', { class: 'notice err' },
      status.problem || `The clips folder ${status.clips_dir} is inside the git repo ${g.repo} and not ignored, so a push would upload clipped pages. Clipping is blocked.`,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', type: 'button', onclick: settings }, '⚙ Change clips folder'))));
    clipBtn.disabled = !status.writable || !!running;
  }

  /* ------------------------------------------------------------------ running a clip */
  function normalize(raw) {
    let v = raw.trim();
    if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
    let u;
    try { u = new URL(v); } catch { return null; }
    return /^https?:$/.test(u.protocol) && u.hostname ? u.href : null;
  }

  async function start() {
    if (running) return toast('A clip is already running', 'err');
    const url = normalize(urlInput.value);
    if (!url) { toast('Enter an http:// or https:// address', 'err'); urlInput.focus(); return; }
    try {
      const job = await post(`${API}/clip`, { url, mode: opts.mode, content: opts.content, download_images: opts.images, save_html: opts.html });
      attach(job);
    } catch (e) { toastError(e); }
  }

  function setProgress(p) {
    progress.hidden = !p;
    if (!p) return clear(progress);
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
    clear(progress,
      h('div', { class: 'row' },
        h('span', { class: 'pill run' }, p.step || 'working'),
        p.mode && h('span', { class: 'pill' }, `mode: ${p.mode}`),
        p.words && h('span', { class: 'pill' }, `${p.words} words`),
        p.total != null && h('span', { class: 'pill' }, `images ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ''}`)),
      pct !== null && h('div', { class: 'clip-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('div', { style: { width: `${pct}%` } })));
  }

  function parseLines(lines, p) {
    for (const ln of lines) {
      let m;
      if (ln.startsWith('fetching')) p.step = 'fetching';
      else if ((m = /^mode: (static|browser)/.exec(ln))) { p.mode = m[1]; p.step = m[1] === 'browser' ? 'rendering' : 'parsing'; }
      else if ((m = /^content: ([\d,.\s]+) words/.exec(ln))) { p.words = m[1].trim(); p.step = 'images'; }
      else if ((m = /^images: ([\d,]+) found/.exec(ln))) { p.total = Number(m[1].replace(/,/g, '')); p.done = 0; }
      else if ((m = /^images: (\d+)\/(\d+) saved \((\d+) failed/.exec(ln))) { p.done = +m[1]; p.total = +m[2]; p.failed = +m[3]; }
      else if (ln.startsWith('CLIP_DONE ')) { try { p.doneInfo = JSON.parse(ln.slice(10)); } catch { /* ignore */ } }
      else if (ln.startsWith('CLIP_ERROR ')) p.error = ln.slice(11);
    }
    return p;
  }

  function attach(job) {
    const p = { step: 'starting' };
    const con = jobConsole(job, { onDone: (j) => finished(j) });
    running = { job, console: con, since: 0, p };
    clear(runArea, con);
    clear(result);
    setProgress(p);
    renderBanner();
    const tick = async () => {
      if (!running || running.job.id !== job.id) return;
      try {
        const j = await get(`/api/jobs/${job.id}`, { since: running.since });
        running.since = j.output.start + j.output.lines.length;
        parseLines(j.output.lines, p);
        setProgress(p);
        if (j.status !== 'running') return;
      } catch { /* the console shows connection trouble */ }
      running.poll = setTimeout(tick, 1000);
    };
    tick();
  }

  async function finished(job) {
    if (!running) return;
    clearTimeout(running.poll);
    const p = running.p;
    try {
      const j = await get(`/api/jobs/${job.id}`, { since: running.since });
      parseLines(j.output.lines, p);
    } catch { /* job lost after a restart */ }
    running = null;
    setProgress(null);
    renderBanner();
    if (p.doneInfo?.name) {
      toast(`Clipped “${p.doneInfo.title}”`, 'ok');
      await loadClips();
      await showClip(p.doneInfo.name);
    } else if (job.status === 'cancelled') {
      toast('Clip cancelled');
    } else {
      toast(p.error ? `Clip failed: ${p.error}` : 'Clip failed — see the log', 'err');
    }
  }

  async function reconnect() {
    try {
      const jobs = await get('/api/jobs');
      const job = jobs.find((j) => j.status === 'running' && j.meta?.step === 'clipper');
      if (job && !running) attach(job);
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ result card */
  async function showClip(name) {
    try {
      current = await get(`${API}/clips/${encodeURIComponent(name)}`);
    } catch (e) { toastError(e); return; }
    renderResult();
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function fullMarkdown() {
    if (!current.truncated) return current.markdown;
    const res = await fetch(fileUrl(current.name, 'index.md'));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  }

  function renderResult() {
    if (!current) return clear(result);
    const m = current.meta || {};
    const c = m.counts || {};
    const name = current.name;
    const source = safeHref(m.url);
    const pills = [
      h('span', { class: 'pill' }, `${fmt.int(m.words)} words`),
      h('span', { class: 'pill ok' }, `${fmt.int(c.saved)} images saved`),
      c.failed ? h('span', { class: 'pill err' }, `${fmt.int(c.failed)} failed`) : null,
      c.deduped ? h('span', { class: 'pill' }, `${fmt.int(c.deduped)} duplicates`) : null,
      c.skipped ? h('span', { class: 'pill warn' }, `${fmt.int(c.skipped)} over the limit`) : null,
      m.mode && h('span', { class: 'pill' }, m.mode === 'browser' ? 'rendered in Chrome' : 'static'),
      m.content && h('span', { class: 'pill' }, m.content === 'full' ? 'whole page' : 'main article'),
    ];
    const failures = m.failures || [];
    const body = h('div', { class: 'card-body' },
      h('div', { class: 'clip-meta' },
        source ? h('a', { href: source, target: '_blank', rel: 'noopener noreferrer', class: 'clip-src' }, m.url) : h('span', { class: 'muted' }, m.url || ''),
        (m.author || m.published) && h('div', { class: 'muted small' }, [m.author && `by ${m.author}`, m.published && `published ${m.published}`].filter(Boolean).join(' · ')),
        h('div', { class: 'row clip-path' }, h('code', { class: 'mono' }, current.path),
          h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(current.path, 'Folder path copied') }, 'Copy path'))),
      h('div', { class: 'row' }, pills),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: `${API}/clips/${encodeURIComponent(name)}/zip`, download: `${name}.zip` }, '⬇ Download .zip'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { try { copyText(await fullMarkdown(), 'Markdown copied'); } catch (e) { toastError(e); } } }, '📋 Copy Markdown'),
        h('button', { class: 'btn', type: 'button', disabled: !failures.length, onclick: () => showFailures(failures) },
          failures.length ? `Show failures (${failures.length})` : 'No failures'),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn danger', type: 'button', disabled: !status?.writable, onclick: () => remove(name, m.title) }, '🗑 Delete')),
      preview());
    clear(result, h('div', { class: 'card clip-result' },
      h('div', { class: 'card-head' }, h('h2', { class: 'clip-title' }, m.title || name), h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, m.clipped_at ? new Date(m.clipped_at).toLocaleString() : ''),
        h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Close', onclick: () => { current = null; clear(result); } }, '✕')),
      body));
  }

  function preview() {
    let tab = store.get('eu.clip.tab', 'md');
    const tabs = h('div', { class: 'seg', role: 'tablist' });
    const pane = h('div', {});
    const render = () => {
      clear(tabs,
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'md'), class: tab === 'md' ? 'on' : '', onclick: () => { tab = 'md'; store.set('eu.clip.tab', tab); render(); } }, 'Markdown'),
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'img'), class: tab === 'img' ? 'on' : '', onclick: () => { tab = 'img'; store.set('eu.clip.tab', tab); render(); } }, `Images (${current.images.length})`));
      clear(pane, tab === 'md' ? markdownPane() : imagesPane());
    };
    render();
    return h('div', { class: 'stack' }, tabs, pane);
  }

  function markdownPane() {
    const pre = h('pre', { class: 'code clip-md' });
    pre.textContent = current.markdown;  // plain text, never rendered
    return h('div', { class: 'stack' },
      current.truncated && h('div', { class: 'notice warn' }, `Preview shows the first ${fmt.bytes(current.markdown.length)} of ${fmt.bytes(current.markdown_bytes)} — Copy and the .zip have everything.`),
      h('div', { class: 'code-wrap' }, pre,
        h('button', { class: 'btn sm copy-btn', type: 'button', onclick: async () => { try { copyText(await fullMarkdown(), 'Markdown copied'); } catch (e) { toastError(e); } } }, 'Copy')));
  }

  function imagesPane() {
    const imgs = current.images;
    if (!imgs.length) return h('p', { class: 'muted' }, 'No images were saved for this clip.');
    const grid = h('div', { class: 'clip-grid' });
    let shown = 0;
    const more = h('button', { class: 'btn sm', type: 'button', onclick: () => add() });
    const add = () => {
      const next = imgs.slice(shown, shown + IMAGE_PAGE);
      shown += next.length;
      grid.append(...next.map((path) => {
        const url = fileUrl(current.name, path);
        return h('a', { class: 'clip-thumb', href: url, target: '_blank', rel: 'noopener noreferrer', title: path },
          h('img', { src: url, loading: 'lazy', alt: path.replace(/^images\//, ''), decoding: 'async' }),
          h('span', { class: 'small muted' }, path.replace(/^images\//, '')));
      }));
      more.hidden = shown >= imgs.length;
      more.textContent = `Show more (${fmt.int(imgs.length - shown)} left)`;
    };
    add();
    return h('div', { class: 'stack' }, grid, more);
  }

  function showFailures(failures) {
    modal(`Images not saved (${failures.length})`, () => h('div', { class: 'stack' },
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Failed downloads keep their remote URL in the Markdown. Tracking pixels are left out.'),
      h('div', { class: 'clip-fails' }, failures.map((f) => h('div', { class: 'clip-fail' },
        h('div', { class: 'mono small clip-fail-url' }, f.url),
        h('div', { class: 'small' }, f.reason)))),
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => copyText(failures.map((f) => `${f.url}\t${f.reason}`).join('\n'), 'Failures copied') }, 'Copy list'))));
  }

  async function remove(name, title) {
    const ok = await confirmDialog('Delete clip', `Move “${title || name}” to the clips trash folder (.trash)?`, { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await post(`${API}/clips/${encodeURIComponent(name)}/delete`);
      toast('Moved to .trash', 'ok');
      if (current?.name === name) { current = null; clear(result); }
      loadClips();
    } catch (e) { toastError(e); }
  }

  /* ------------------------------------------------------------------ history */
  function renderHistory() {
    if (!clips.length) {
      return clear(historyEl, h('p', { class: 'muted', style: { margin: 0 } },
        status?.clips_dir ? `No clips yet. They are saved in ${status.clips_dir}.` : 'No clips yet.'));
    }
    clear(historyEl, clips.map((c) => h('div', { class: 'clip-item' },
      h('button', { type: 'button', class: 'clip-item-main', onclick: () => showClip(c.name), title: c.name },
        h('div', { class: 'clip-item-title' }, c.title),
        h('div', { class: 'muted small' }, [hostOf(c.url), c.clipped_at ? new Date(c.clipped_at).toLocaleString() : '',
          `${fmt.int(c.words)} words`, `${fmt.int(c.images_saved)} images${c.images_failed ? ` (${fmt.int(c.images_failed)} failed)` : ''}`,
          fmt.bytes(c.bytes)].filter(Boolean).join(' · '))),
      h('button', { class: 'btn sm ghost', type: 'button', title: 'Move to trash', 'aria-label': `Delete ${c.title}`, disabled: !status?.writable,
        onclick: () => remove(c.name, c.title) }, '🗑'))));
  }

  async function settings() {
    openSettings(service, await get(`/api/services/${service.id}/settings`), async () => { await loadStatus(); loadClips(); });
  }

  async function open(ref) {
    await loadClips();
    if (!clips.some((c) => c.name === ref)) return toast(`Clip “${ref}” is no longer there`, 'err');
    await showClip(ref);
  }

  await loadStatus();
  await loadClips();
  await reconnect();
  if (!running) urlInput.focus();
  return {
    onShow: () => { loadStatus(); loadClips(); if (!running) reconnect(); },
    open,
  };
}
