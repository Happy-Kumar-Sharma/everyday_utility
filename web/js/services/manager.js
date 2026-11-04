// Manager tab: 🔑 Logins (a local plain-text file kept out of git) and 🧾 Env files (per-repo .env & credentials).

import { api, get, post } from '../core/api.js';
import { browseFiles, checkbox, codeBlock, openSettings, segmented } from '../core/components.js';
import { clear, confirmDialog, copyText, debounce, downloadText, fmt, h, modal, store, toast, toastError } from '../core/dom.js';

const API = '/api/manager';
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export async function mount(root, { service }) {
  let section = store.get('eu.mgr.section', 'creds');
  if (section !== 'env') section = 'creds';
  const body = h('div', { class: 'stack', style: { gap: '16px' } });
  const seg = segmented([{ value: 'creds', label: '🔑 Logins' }, { value: 'env', label: '🧾 Env files' }], section, (v) => {
    section = v; store.set('eu.mgr.section', v); render();
  });
  root.append(
    h('div', { class: 'row' }, seg,
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        openSettings(service, await get(`/api/services/${service.id}/settings`), () => render());
      } }, '⚙ Settings')),
    body);

  const creds = credsSection();
  const env = envSection();
  function render() {
    clear(body, section === 'creds' ? creds.el : env.el);
    return (section === 'creds' ? creds : env).refresh();
  }
  render();

  // global search / palette refs: new-login · login:<index>:<hash> · repo:<path> · envfile:<path>
  async function open(ref) {
    const [kind, ...rest] = ref.split(':');
    const target = kind === 'repo' || kind === 'envfile' ? 'env' : 'creds';
    section = target; store.set('eu.mgr.section', target); seg.value = target;
    await render();
    if (kind === 'new-login') return creds.add();
    if (kind === 'login') return creds.edit(Number(rest[0]), rest.slice(1).join(':'));
    if (kind === 'repo') return env.showRepo(rest.join(':'));
    if (kind === 'envfile') return env.showFile(rest.join(':'));
    toast(`Unknown Manager link “${ref}”`, 'err');
  }
  return { onShow: () => (section === 'creds' ? creds : env).refresh(), open };
}

/* =================================================================== credentials file */
function credsSection() {
  const el = h('div', { class: 'stack', style: { gap: '16px' } });
  let data = null;
  let query = '';

  async function refresh() {
    try {
      data = await get(`${API}/creds`);
      data.configured ? renderList() : renderChooser();
    } catch (e) { toastError(e); }
  }

  function gitBadge(g) {
    if (data.problem) return h('span', { class: 'pill err' }, '⚠ unusable');
    if (!g.in_repo) return h('span', { class: 'pill ok', title: 'Not inside any git repository' }, '✓ outside git');
    if (g.safe) return h('span', { class: 'pill ok', title: `${g.repo}: ${g.rel} is in .gitignore` }, '✓ git-ignored');
    return h('span', { class: 'pill err' }, g.tracked ? '⚠ tracked by git' : '⚠ not git-ignored');
  }

  /* ---- choose / change location */
  function renderChooser(current) {
    const input = h('input', { type: 'text', class: 'mono', value: current || data.suggested || '',
      onkeydown: (e) => { if (e.key === 'Enter') use(); } });
    async function use() {
      try { data = await post(`${API}/creds/location`, { path: input.value }); toast('Location saved', 'ok'); renderList(); } catch (e) { toastError(e); }
    }
    clear(el, h('div', { class: 'card', style: { maxWidth: '760px' } },
      h('div', { class: 'card-head' }, h('h2', {}, current ? 'Change credentials file location' : 'Where should your credentials file live?')),
      h('div', { class: 'card-body' },
        h('p', { style: { margin: 0 } }, 'Logins (URL, username, password, notes) are saved to this plain-text file on your machine only. ',
          'Pick a folder outside any git repo, or keep the suggested ', h('code', {}, 'private/'), ' folder, which this repo’s .gitignore excludes. ',
          'Saving is blocked while the file could be committed.'),
        h('label', { class: 'field' }, 'File path (an existing .txt is read as-is; a folder gets credentials.txt)',
          h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, input,
            h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await browseFiles('', { mode: 'any' }); if (p) input.value = p; } }, 'Pick file…'),
            h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await browseFiles('', { mode: 'dir' }); if (p) input.value = `${p}/credentials.txt`; } }, 'Pick folder…'))),
        h('div', { class: 'row end' },
          current && h('button', { class: 'btn', type: 'button', onclick: () => renderList() }, 'Cancel'),
          h('button', { class: 'btn primary', type: 'button', onclick: use }, 'Use this location')))));
    input.focus();
  }

  /* ---- list */
  function renderList() {
    const g = data.git;
    const problem = data.problem && h('div', { class: 'notice err' }, h('div', {}, data.problem),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => renderChooser(data.path) }, 'Pick another location')));
    const search = h('input', { type: 'text', placeholder: 'Search title, URL, username, tags, notes…', value: query,
      style: { maxWidth: '340px' }, oninput: debounce(() => { query = search.value; draw(); }, 120) });
    const listEl = h('div', { class: 'stack' });
    clear(el,
      h('div', { class: 'card' }, h('div', { class: 'card-body', style: { gap: '8px' } },
        h('div', { class: 'row' }, h('b', {}, '📄'), h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, data.path),
          gitBadge(g), !data.exists && h('span', { class: 'pill' }, 'created on first save'),
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(data.path, 'Path copied') }, 'Copy path'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => renderChooser(data.path) }, 'Change location')),
        problem,
        !problem && !g.safe && h('div', { class: 'notice err' },
          h('div', {}, g.tracked
            ? `This file is already tracked by git in ${g.repo}. Remove it from git (git rm --cached "${g.rel}") and ignore it, or move it outside the repo.`
            : `This file is inside the git repo ${g.repo} and is not ignored, so a push would upload it. Saving is blocked until that is fixed.`),
          !g.tracked && h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              try { data = await post(`${API}/creds/gitignore`); toast('Added to .gitignore', 'ok'); renderList(); } catch (e) { toastError(e); }
            } }, `Add /${g.rel}* to ${g.repo}/.gitignore`),
            h('button', { class: 'btn sm', type: 'button', onclick: () => renderChooser(data.path) }, 'Pick another location'))))),
      h('div', { class: 'row' }, search, h('span', { class: 'muted small' }, `${data.entries.length} entries`), h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn primary', type: 'button', disabled: !g.safe, onclick: () => editEntry() }, '＋ Add login')),
      listEl);

    function draw() {
      const q = query.trim().toLowerCase();
      const shown = data.entries.filter((e) => !q || ['title', 'url', 'username', 'tags', 'notes'].some((k) => (e[k] || '').toLowerCase().includes(q)));
      if (!data.entries.length) return clear(listEl, h('div', { class: 'notice' }, 'No logins yet. Click ＋ Add login (or edit the file by hand — the format is shown in it).'));
      if (!shown.length) return clear(listEl, h('div', { class: 'notice' }, 'Nothing matches.'));
      clear(listEl, shown.map(entryRow));
    }
    draw();
  }

  function entryRow(e) {
    const pwText = h('span', { class: 'mono' }, e.password ? '••••••••' : h('span', { class: 'muted' }, '—'));
    let shown = false;
    const href = e.url && (/^[a-z]+:\/\//i.test(e.url) ? e.url : `https://${e.url}`);
    return h('div', { class: 'card', style: { padding: '12px 14px' } },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } },
        h('div', { class: 'stack', style: { gap: '4px', flex: '1 1 260px', minWidth: 0 } },
          h('div', { class: 'row' }, h('b', {}, e.title), e.tags && e.tags.split(',').map((t) => t.trim() && h('span', { class: 'pill' }, t.trim()))),
          e.url && h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'small', style: { wordBreak: 'break-all' } }, e.url),
          e.notes && h('div', { class: 'muted small', style: { whiteSpace: 'pre-wrap' } }, e.notes)),
        h('div', { class: 'stack', style: { gap: '6px', flex: '1 1 260px' } },
          e.username && h('div', { class: 'row' }, h('span', { class: 'muted small', style: { width: '70px' } }, 'Username'),
            h('span', { class: 'mono' }, e.username),
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Copy username', onclick: () => copyText(e.username, 'Username copied') }, '📋')),
          e.password && h('div', { class: 'row' }, h('span', { class: 'muted small', style: { width: '70px' } }, 'Password'), pwText,
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Show / hide', onclick: () => { shown = !shown; pwText.textContent = shown ? e.password : '••••••••'; } }, '👁'),
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Copy password', onclick: () => copyText(e.password, 'Password copied') }, '📋'))),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', disabled: !data.git.safe, onclick: () => editEntry(e) }, 'Edit'),
          h('button', { class: 'btn sm danger', type: 'button', disabled: !data.git.safe, onclick: async () => {
            if (!(await confirmDialog('Delete login?', `“${e.title}” will be removed from the file (the previous version is kept as .bak).`, { okLabel: 'Delete', danger: true }))) return;
            try { await api(`${API}/creds/entries/${e.index}?${new URLSearchParams({ hash: e.hash })}`, { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (ex) { toastError(ex); refresh(); }
          } }, 'Delete'))));
  }

  function generatePassword(len = 20) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
  }

  function editEntry(entry) {
    const d = { title: '', url: '', username: '', password: '', notes: '', tags: '', ...(entry || {}) };
    modal(entry ? `Edit · ${entry.title}` : 'New login', (close) => {
      const input = (key, attrs = {}) => h('input', { type: 'text', value: d[key], oninput: (ev) => { d[key] = ev.target.value; }, ...attrs });
      const pw = input('password', { type: 'password', class: 'mono', autocomplete: 'new-password' });
      const notes = h('textarea', { rows: 4, oninput: () => { d.notes = notes.value; } }, d.notes);
      return h('form', { class: 'stack', onsubmit: async (ev) => {
        ev.preventDefault();
        const body = { title: d.title, url: d.url, username: d.username, password: d.password, notes: d.notes, tags: d.tags };
        try {
          if (entry) await api(`${API}/creds/entries/${entry.index}`, { method: 'PUT', body: { ...body, original_hash: entry.hash } });
          else await post(`${API}/creds/entries`, body);
          toast(entry ? 'Saved' : 'Added', 'ok'); close(); refresh();
        } catch (ex) { toastError(ex); if (ex.status === 400) refresh(); }
      } },
      h('label', { class: 'field' }, 'Title', input('title', { placeholder: 'e.g. AWS console (prod)' })),
      h('label', { class: 'field' }, 'Login URL', input('url', { placeholder: 'https://…' })),
      h('label', { class: 'field' }, 'Username / email', input('username', { autocomplete: 'off' })),
      h('label', { class: 'field' }, 'Password', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pw,
        h('button', { class: 'btn', type: 'button', title: 'Show / hide', onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; } }, '👁'),
        h('button', { class: 'btn', type: 'button', title: 'Generate a random 20-char password', onclick: () => { d.password = pw.value = generatePassword(); pw.type = 'text'; } }, '🎲'))),
      h('label', { class: 'field' }, 'Tags', input('tags', { placeholder: 'comma separated: work, aws, prod' })),
      h('label', { class: 'field' }, 'Notes', notes),
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    });
  }

  function add() {
    if (!data?.configured) return toast('Choose where the credentials file lives first', 'err');
    if (!data.git.safe || data.problem) return toast('Saving is blocked for this file — see the notice above', 'err');
    editEntry();
  }

  // by fingerprint, so a stale index (file edited since the search) still finds the right entry or none
  function edit(index, hash) {
    const entries = data?.entries || [];
    const entry = entries.find((e) => e.index === index && e.hash === hash) || entries.find((e) => e.hash === hash);
    if (!entry) return toast('That login changed or is gone — search again', 'err');
    if (!data.git.safe) return toast('Saving is blocked for this file — see the notice above', 'err');
    editEntry(entry);
  }

  return { el, refresh, add, edit };
}

/* =================================================================== env files */
function envSection() {
  const el = h('div', { class: 'stack', style: { gap: '16px' } });
  const list = h('div', { class: 'stack', style: { gap: '12px' } });
  const open = new Set(store.get('eu.mgr.openRepos', []));
  const pathInput = h('input', { type: 'text', class: 'mono', placeholder: '~/workspace/my-repo  (Enter to add)',
    onkeydown: (e) => { if (e.key === 'Enter') addRepo(pathInput.value); } });

  el.append(
    h('div', { class: 'card' }, h('div', { class: 'card-body' },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathInput,
        h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await browseFiles('', { mode: 'dir' }); if (p) addRepo(p); } }, 'Browse…'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => addRepo(pathInput.value) }, '＋ Add repo')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: scanWorkspace }, '🔎 Scan workspace for repos'),
        h('button', { class: 'btn', type: 'button', onclick: () => exportEnv([]) }, '⬇ Export all repos .txt'),
        h('span', { class: 'muted small' }, 'Matches .env, .env.*, *.env, *credentials*.sh … (patterns in ⚙ Settings). venv / node_modules / .git are skipped.')))),
    list);

  let repos = [];
  const viewers = new Map();  // repo path -> { card, viewer } of the cards currently shown

  async function refresh() {
    try {
      repos = await get(`${API}/env/repos`);
      viewers.clear();
      if (!repos.length) return clear(list, h('div', { class: 'notice' }, 'No repositories yet. Add one above or scan your workspace.'));
      clear(list, repos.map(repoCard));
    } catch (e) { toastError(e); }
  }

  // expands a repo's card (re-rendering keeps it open) and scrolls to it
  async function showRepo(path) {
    if (!repos.some((r) => r.path === path)) { toast('That repository is no longer registered', 'err'); return null; }
    if (!open.has(path)) { open.add(path); store.set('eu.mgr.openRepos', [...open]); await refresh(); }
    const slot = viewers.get(path);
    slot?.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return slot;
  }

  async function showFile(path) {
    const repo = repos.find((r) => r.files.some((f) => f.path === path));
    if (!repo) return toast('That file is no longer part of a registered repository', 'err');
    const slot = await showRepo(repo.path);
    if (slot) viewFile(repo.files.find((f) => f.path === path), slot.viewer);
  }

  async function addRepo(path) {
    if (!path?.trim()) return;
    try { const r = await post(`${API}/env/repos`, { path: path.trim() }); pathInput.value = ''; open.add(r.path); store.set('eu.mgr.openRepos', [...open]); toast(`Added ${r.name}`, 'ok'); refresh(); } catch (e) { toastError(e); }
  }

  async function exportEnv(repoPaths) {
    const ok = await confirmDialog('Export env files as plain text?', 'The file contains every secret from these env / credentials files. Store it somewhere safe.', { okLabel: 'Export' });
    if (!ok) return;
    try {
      const text = await post(`${API}/env/export`, { repos: repoPaths });
      const name = repoPaths.length === 1 ? repoPaths[0].split('/').pop() : 'all_repos';
      downloadText(text, `env_export_${name}_${stamp()}.txt`);
    } catch (e) { toastError(e); }
  }

  async function scanWorkspace() {
    let res;
    try { res = await get(`${API}/env/scan`); } catch (e) { return toastError(e); }
    const picked = new Set(res.candidates.filter((c) => !c.registered && c.env_files).map((c) => c.path));
    const ok = await modal(`Repos in ${res.root}`, (close) => h('div', { class: 'stack' },
      !res.candidates.length && h('p', { class: 'muted' }, 'No sub-folders with .git or env files found.'),
      res.candidates.map((c) => h('div', { class: 'row' },
        c.registered ? h('span', { class: 'pill ok' }, 'added') : checkbox('', picked.has(c.path), (v) => (v ? picked.add(c.path) : picked.delete(c.path))),
        h('b', {}, c.name), h('span', { class: 'muted small' }, `${c.env_files} env file${c.env_files === 1 ? '' : 's'}${c.git ? ' · git' : ''}`))),
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => close(true) }, 'Add selected'))));
    if (!ok || !picked.size) return;
    for (const p of picked) {
      try { await post(`${API}/env/repos`, { path: p }); } catch (e) { toastError(e); }
    }
    toast(`Added ${picked.size} repos`, 'ok');
    refresh();
  }

  function repoCard(repo) {
    const isOpen = open.has(repo.path);
    const card = h('div', { class: `card step ${isOpen ? '' : 'collapsed'}` });
    const toggle = () => {
      card.classList.toggle('collapsed');
      card.classList.contains('collapsed') ? open.delete(repo.path) : open.add(repo.path);
      store.set('eu.mgr.openRepos', [...open]);
    };
    const viewer = h('div', {});
    viewers.set(repo.path, { card, viewer });
    const files = repo.files;
    card.append(
      h('div', { class: 'card-head', role: 'button', tabindex: 0, onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      h('span', { class: 'num' }, '📁'),
      h('div', { class: 'stack', style: { gap: '2px', minWidth: 0 } }, h('h2', {}, repo.name), h('p', { class: 'desc mono', style: { wordBreak: 'break-all' } }, repo.path)),
      h('span', { class: 'spacer' }),
      !repo.exists ? h('span', { class: 'pill err' }, 'folder missing') : h('span', { class: 'pill' }, `${files.length} file${files.length === 1 ? '' : 's'}`),
      h('span', { class: 'chev' }, '▾')),
      h('div', { class: 'card-body' },
        files.length ? h('div', { class: 'fs-list' }, files.map((f) => h('div', { class: 'fs-item', style: { cursor: 'default' } },
          '📄', h('span', { class: 'grow mono', title: f.path }, f.rel),
          f.manual && h('span', { class: 'pill' }, 'added'),
          !f.exists ? h('span', { class: 'pill err' }, 'missing')
            : h('span', { class: 'muted small' }, `${f.var_count ?? '?'} vars · ${fmt.bytes(f.size)} · ${fmt.ago(f.mtime)}`),
          f.exists && h('button', { class: 'btn sm', type: 'button', onclick: () => viewFile(f, viewer) }, 'View'),
          f.manual && h('button', { class: 'btn sm ghost', type: 'button', title: 'Remove from list', onclick: async () => {
            try { await post(`${API}/env/files/remove`, { repo: repo.path, path: f.path }); refresh(); } catch (e) { toastError(e); }
          } }, '✕'))))
          : h('div', { class: 'notice' }, 'No env files found with the current patterns. Add one manually below.'),
        viewer,
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            const p = await browseFiles(repo.path, { mode: 'any' });
            if (!p) return;
            try { await post(`${API}/env/files`, { repo: repo.path, path: p }); toast('File added', 'ok'); refresh(); } catch (e) { toastError(e); }
          } }, '＋ Add file manually'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => exportEnv([repo.path]) }, '⬇ Export this repo'),
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Remove repository?', `Stops tracking ${repo.name}. Nothing on disk is changed.`, { okLabel: 'Remove', danger: true }))) return;
            try { await post(`${API}/env/repos/remove`, { path: repo.path }); refresh(); } catch (e) { toastError(e); }
          } }, 'Remove repo'))));
    return card;
  }

  async function viewFile(f, slot) {
    let data;
    try { data = await get(`${API}/env/file`, { path: f.path }); } catch (e) { return toastError(e); }
    let mode = 'vars';
    let reveal = false;
    const content = h('div', {});
    const mask = (v) => (reveal || !v ? v : '•'.repeat(Math.min(12, Math.max(6, v.length))));
    function draw() {
      if (mode === 'raw') {
        // raw view masks values too until revealed
        const text = reveal ? data.content : data.content.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gm, (_, k, v) => k + mask(v));
        return clear(content, codeBlock(text, { maxHeight: '420px' }));
      }
      if (!data.vars.length) return clear(content, h('p', { class: 'muted' }, 'No KEY=VALUE lines found.'));
      clear(content, h('div', { class: 'table-wrap', style: { maxHeight: '420px' } }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'), h('th', {}, ''))),
        h('tbody', {}, data.vars.map((v) => h('tr', {},
          h('td', { class: 'mono' }, v.key), h('td', { class: 'mono', title: reveal ? v.value : '' }, mask(v.value)),
          h('td', {}, h('button', { class: 'btn sm ghost', type: 'button', title: 'Copy value', onclick: () => copyText(v.value, `${v.key} copied`) }, '📋'),
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Copy KEY=value', onclick: () => copyText(`${v.key}=${v.value}`, 'Copied') }, '⧉'))))))));
    }
    clear(slot, h('div', { class: 'stack', style: { borderTop: '1px solid var(--border)', paddingTop: '12px' } },
      h('div', { class: 'row' }, h('b', { class: 'mono' }, f.rel),
        segmented([{ value: 'vars', label: 'Variables' }, { value: 'raw', label: 'Raw file' }], mode, (v) => { mode = v; draw(); }),
        checkbox('Reveal values', false, (v) => { reveal = v; draw(); }),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(data.content, 'File copied') }, '📋 Copy file'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => clear(slot) }, '✕')),
      content));
    draw();
  }

  return { el, refresh, showRepo, showFile };
}
