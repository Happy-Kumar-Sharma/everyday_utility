// Remote Jupyter tab: server profiles (prod, staging, …), pre-flight checks (key, VPN, port, ssh),
// "Connect & start Jupyter" as a background ssh job, the parsed URL (token masked) and Disconnect.
// The Jupyter token is a credential: it is only shown on demand and never stored by this page.

import { del, get, post, put } from '../core/api.js';
import { browseFiles, checkbox, codeBlock, jobConsole, segmented } from '../core/components.js';
import { clear, confirmDialog, copyText, fmt, h, loadCss, modal, store, toast, toastError } from '../core/dom.js';

const API = '/api/jupyter';
const SEL_KEY = 'eu.jupyter.selected';
const AUTO_OPEN_KEY = 'eu.jupyter.autoOpen';
const STATE_PILL = { connecting: 'run', ready: 'ok', failed: 'err', stopped: '' };
const MODE_LABEL = { tunnel: '🔒 tunnel', direct: '🌐 direct' };
const MODE_HELP = {
  tunnel: 'Jupyter listens only on the server’s localhost; your browser reaches it through the ssh connection '
    + '(127.0.0.1:<local port> here). Nobody else on the VPN can open it.',
  direct: 'Jupyter listens on all interfaces (--ip 0.0.0.0) and you open http://<host>:<port>. Anyone on the VPN '
    + 'who gets the token can use it — prefer the tunnel.',
};

const maskUrl = (url) => (url || '').replace(/token=[^&#\s]+/, 'token=••••');

function openUrl(url) {
  // noopener: the Jupyter page gets no handle back to this app
  window.open(url, '_blank', 'noopener,noreferrer');
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'eu-jupyter' }); } catch { /* ignore */ }
}

export async function mount(root) {
  loadCss('/static/css/jupyter.css');

  let profiles = [];
  let sessions = [];
  let selectedId = store.get(SEL_KEY, null);
  let autoOpen = store.get(AUTO_OPEN_KEY, false);
  const prevStates = new Map();  // job id -> last seen state (to notify on connecting -> ready)
  let firstLoad = true;
  let pollTimer = null;
  let tickTimer = null;
  const revealed = new Set();  // job ids whose token is shown
  const consoles = new Map();  // job id -> console element (kept across re-renders)

  /* ---------------- layout ---------------- */
  const list = h('div', { class: 'jp-list' });
  const panel = h('div', { class: 'jp-panel stack' });
  root.append(
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => editProfile(null) }, '＋ Add profile'),
      h('button', { class: 'btn', type: 'button', onclick: () => refresh() }, '↻ Refresh'),
      'Notification' in window && Notification.permission === 'default' && h('button', {
        class: 'btn sm', type: 'button',
        onclick: async (e) => { await Notification.requestPermission(); e.target.hidden = Notification.permission !== 'default'; },
      }, '🔔 Notify me when Jupyter is ready'),
      h('span', { class: 'muted small' }, 'Connect the VPN first. Sessions keep running when you switch tabs or reload.')),
    h('div', { class: 'jp-layout' }, list, panel));

  const selected = () => profiles.find((p) => p.id === selectedId) || null;
  const sessionsOf = (pid) => sessions.filter((s) => s.profile_id === pid);
  const liveSession = (pid) => sessionsOf(pid).find((s) => s.status === 'running');

  /* ---------------- data ---------------- */
  async function refresh() {
    try {
      [profiles, sessions] = await Promise.all([get(`${API}/profiles`), get(`${API}/sessions`)]);
      if (!selected()) selectedId = profiles[0]?.id || null;
      trackStates();
      renderList();
      renderPanel();
      schedulePoll();
    } catch (e) { toastError(e); }
  }

  async function pollSessions() {
    try {
      sessions = await get(`${API}/sessions`);
      trackStates();
      renderList();
      renderSessions();
      syncStartButton();
    } catch { /* server restarting: try again next tick */ }
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!root.isConnected) return;
    const busy = sessions.some((s) => s.status === 'running');
    if (busy) pollTimer = setTimeout(pollSessions, sessions.some((s) => s.state === 'connecting') ? 1500 : 5000);
  }

  function trackStates() {
    for (const s of sessions) {
      const before = prevStates.get(s.job_id);
      if (!firstLoad && s.state === 'ready' && before && before !== 'ready') onReady(s);
      if (!firstLoad && s.state === 'failed' && before && before !== 'failed') toast(`${s.name}: ${s.error || 'failed'}`, 'err');
      prevStates.set(s.job_id, s.state);
    }
    firstLoad = false;
  }

  function onReady(s) {
    toast(`🪐 ${s.name}: Jupyter is ready`, 'ok');
    notify('Jupyter is ready', `${s.name} · ${s.mode === 'tunnel' ? `127.0.0.1:${s.local_port}` : s.host}`);
    if (autoOpen && s.url) openUrl(s.url);
  }

  /* ---------------- profile list ---------------- */
  function renderList() {
    clear(list,
      !profiles.length && h('div', { class: 'card jp-empty' },
        h('p', { class: 'muted' }, 'No servers yet. Add one with the host, user, key file, remote folder and conda environment you use by hand.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => editProfile(null) }, '＋ Add profile')),
      profiles.map((p) => {
        const live = liveSession(p.id);
        return h('button', {
          type: 'button', class: `card jp-card ${p.id === selectedId ? 'on' : ''}`, 'aria-pressed': String(p.id === selectedId),
          onclick: () => select(p.id),
        },
        h('div', { class: 'row' }, h('b', {}, p.name), h('span', { class: 'spacer' }),
          live && h('span', { class: `pill ${STATE_PILL[live.state]}` }, live.state),
          h('span', { class: `pill jp-mode ${p.mode}` }, MODE_LABEL[p.mode])),
        h('span', { class: 'mono small' }, `${p.user}@${p.host}`),
        h('span', { class: 'muted small jp-ellipsis', title: p.remote_dir }, `🐍 ${p.conda_env} · 📁 ${p.remote_dir}`));
      }));
  }

  function select(id) {
    selectedId = id;
    store.set(SEL_KEY, id);
    renderList();
    renderPanel();
  }

  /* ---------------- selected profile panel ---------------- */
  let checkSlot, serversSlot, sessionSlot, startBtn, findBtn;

  function renderPanel() {
    const p = selected();
    if (!p) { clear(panel); return; }
    checkSlot = h('div', { class: 'stack' });
    serversSlot = h('div', { class: 'stack' });
    sessionSlot = h('div', { class: 'stack' });
    startBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => start(p) }, '▶ Connect & start Jupyter');
    findBtn = h('button', { class: 'btn', type: 'button', onclick: () => findServers(p) }, '🔎 Find running servers');
    const cmdSlot = h('div', { class: 'stack' });

    clear(panel,
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', { class: 'stack', style: { gap: '2px' } }, h('h2', {}, p.name),
            h('span', { class: 'mono small muted' }, `${p.user}@${p.host}`)),
          h('span', { class: 'spacer' }),
          h('span', { class: `pill jp-mode ${p.mode}` }, MODE_LABEL[p.mode]),
          h('button', { class: 'btn sm', type: 'button', onclick: () => editProfile(p) }, '✎ Edit'),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => removeProfile(p) }, 'Delete')),
        h('div', { class: 'card-body' },
          h('dl', { class: 'jp-facts' },
            h('dt', {}, 'Key'), h('dd', { class: 'mono' }, p.key_path),
            h('dt', {}, 'Folder'), h('dd', { class: 'mono' }, p.remote_dir),
            h('dt', {}, 'Conda env'), h('dd', { class: 'mono' }, p.conda_env),
            h('dt', {}, 'Ports'), h('dd', {}, p.mode === 'tunnel'
              ? `remote ${p.remote_port} → local 127.0.0.1:${p.local_port}` : `remote ${p.remote_port} (opened directly)`),
            p.startup_steps && [h('dt', {}, 'Startup steps'), h('dd', { class: 'mono jp-notes' }, p.startup_steps)],
            [h('dt', {}, 'Shell'), h('dd', {}, p.login_shell === false ? 'plain (non-interactive)' : 'like my terminal (bash -lic)')],
            p.extra_ssh_args && [h('dt', {}, 'ssh args'), h('dd', { class: 'mono' }, p.extra_ssh_args)],
            p.notes && [h('dt', {}, 'Notes'), h('dd', { class: 'jp-notes' }, p.notes)]))),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Pre-flight'), h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', type: 'button', onclick: () => runChecks(p) }, '↻ Re-check')),
        h('div', { class: 'card-body' }, checkSlot)),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Session')),
        h('div', { class: 'card-body' },
          h('div', { class: 'row' }, startBtn, findBtn, h('span', { class: 'spacer' }),
            checkbox('Open automatically when ready', autoOpen, (v) => { autoOpen = v; store.set(AUTO_OPEN_KEY, v); },
              'Opens a new browser tab as soon as the URL appears (your browser may block it as a pop-up)')),
          serversSlot, sessionSlot,
          h('p', { class: 'muted small jp-note' },
            '🔐 The token in the URL is a password for this Jupyter. It is masked here and never saved in profiles or the activity log — '
            + 'but the job logs in data/jobs/ (git-ignored) contain the full Jupyter output, token included.'))),

      h('details', { class: 'card jp-details', ontoggle: (e) => { if (e.target.open && !cmdSlot.childElementCount) loadCommands(p, cmdSlot); } },
        h('summary', { class: 'card-head' }, h('h2', {}, 'Do it by hand'), h('span', { class: 'muted small' }, 'copyable commands')),
        h('div', { class: 'card-body' }, cmdSlot)));

    renderSessions();
    syncStartButton();
    runChecks(p);
  }

  function syncStartButton() {
    const p = selected();
    if (!p || !startBtn) return;
    const live = liveSession(p.id);
    startBtn.disabled = !!live;
    startBtn.title = live ? 'A session for this profile is running — disconnect it first' : '';
    findBtn.disabled = false;
  }

  /* ---------------- pre-flight ---------------- */
  async function runChecks(p) {
    clear(checkSlot, h('span', { class: 'muted small' }, 'Checking key, VPN, port and ssh…'));
    try {
      const checks = await get(`${API}/profiles/${p.id}/check`);
      if (selectedId !== p.id) return;
      clear(checkSlot, h('ul', { class: 'jp-checks' }, checks.map((c) => h('li', { class: `jp-check ${c.level}` },
        h('span', { class: 'jp-icon', 'aria-label': c.level }, c.level === 'info' ? 'ℹ' : c.ok ? '✓' : '✗'),
        h('div', { class: 'stack', style: { gap: '2px' } },
          h('b', {}, c.name), c.detail && h('span', { class: 'small muted' }, c.detail),
          c.hint && h('span', { class: 'small jp-hint' }, c.hint),
          (c.fixable || c.suggest_port) && h('div', { class: 'row' },
            c.fixable && h('button', { class: 'btn sm', type: 'button', onclick: () => fixPerms(p) }, '🔧 Fix permissions (chmod 600)'),
            c.suggest_port && h('button', { class: 'btn sm', type: 'button', onclick: () => usePort(p, c.suggest_port) }, `Use local port ${c.suggest_port}`)))))));
    } catch (e) {
      clear(checkSlot, h('div', { class: 'notice err' }, e.message));
    }
  }

  async function fixPerms(p) {
    const ok = await confirmDialog('Fix key permissions', h('div', { class: 'stack' },
      h('p', { style: { margin: 0 } }, 'ssh refuses private keys that others can read. This runs:'),
      h('pre', { class: 'code' }, `chmod 600 ${p.key_path}`)), { okLabel: 'Fix permissions' });
    if (!ok) return;
    try {
      await post(`${API}/profiles/${p.id}/fix-key-perms`);
      toast('Key permissions set to 600', 'ok');
      runChecks(p);
    } catch (e) { toastError(e); }
  }

  async function usePort(p, port) {
    try {
      await put(`${API}/profiles/${p.id}`, { ...p, local_port: port });
      toast(`Local port set to ${port}`, 'ok');
      await refresh();
    } catch (e) { toastError(e); }
  }

  /* ---------------- start / stop / reuse ---------------- */
  async function start(p) {
    startBtn.disabled = true;
    try {
      const s = await post(`${API}/profiles/${p.id}/start`);
      prevStates.set(s.job_id, s.state);
      sessions = [s, ...sessions.filter((x) => x.job_id !== s.job_id)];
      renderList();
      renderSessions();
      schedulePoll();
    } catch (e) { toastError(e); }
    syncStartButton();
  }

  async function stop(s) {
    if (!(await confirmDialog('Disconnect', `Close the ssh connection to ${s.name}? `
      + (s.reuse ? 'The tunnel closes; the remote Jupyter keeps running.' : 'The Jupyter server started by this session stops too (unsaved notebook changes are lost).'),
    { okLabel: '⏹ Disconnect', danger: true }))) return;
    try {
      await post(`${API}/sessions/${s.job_id}/stop`);
      setTimeout(pollSessions, 600);
    } catch (e) { toastError(e); }
  }

  async function findServers(p) {
    findBtn.disabled = true;
    clear(serversSlot, h('span', { class: 'muted small' }, 'Asking the server (jupyter server list)… up to 20 s'));
    try {
      const { servers } = await post(`${API}/profiles/${p.id}/remote-servers`);
      if (selectedId !== p.id) return;
      clear(serversSlot, h('div', { class: 'jp-servers' },
        h('div', { class: 'row' }, h('b', {}, `Running on ${p.host}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => clear(serversSlot) }, '✕')),
        !servers.length && h('p', { class: 'muted small', style: { margin: 0 } }, 'No Jupyter servers running in that conda env.'),
        servers.map((srv) => h('div', { class: 'jp-server row' },
          h('span', { class: 'mono small grow jp-ellipsis', title: srv.root_dir }, `:${srv.port} · ${srv.root_dir || '?'}${srv.pid ? ` · pid ${srv.pid}` : ''}`),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !srv.port, onclick: () => reuse(p, srv) },
            p.mode === 'tunnel' ? '↪ Reuse (tunnel)' : '↗ Open')))));
    } catch (e) {
      clear(serversSlot, h('div', { class: 'notice err' }, e.message));
    } finally { findBtn.disabled = false; }
  }

  async function reuse(p, srv) {
    try {
      const r = await post(`${API}/profiles/${p.id}/reuse`, { port: srv.port, token: srv.token || '', base_url: srv.base_url || '/',
        scheme: (srv.url || '').startsWith('https') ? 'https' : 'http' });
      if (r.url && !r.job_id) { openUrl(r.url); return; }
      prevStates.set(r.job_id, r.state);
      sessions = [r, ...sessions];
      clear(serversSlot);
      renderList();
      renderSessions();
      schedulePoll();
    } catch (e) { toastError(e); }
  }

  /* ---------------- session cards ---------------- */
  function renderSessions() {
    const p = selected();
    if (!p || !sessionSlot) return;
    const mine = sessionsOf(p.id);
    const live = mine.filter((s) => s.status === 'running');
    const last = mine.find((s) => s.status !== 'running');
    const show = live.length ? live : last ? [last] : [];
    clear(sessionSlot, show.map(sessionCard));
    clearInterval(tickTimer);
    if (live.length) tickTimer = setInterval(() => {
      if (!root.isConnected) { clearInterval(tickTimer); return; }
      for (const el of sessionSlot.querySelectorAll('[data-started]')) {
        el.textContent = fmt.duration(Date.now() / 1000 - Number(el.dataset.started));
      }
    }, 1000);
  }

  function sessionCard(s) {
    const running = s.status === 'running';
    const shown = revealed.has(s.job_id);
    const urlText = h('span', { class: 'mono jp-url' }, s.url ? (shown ? s.url : maskUrl(s.url)) : '');
    const toggle = h('button', { class: 'btn sm ghost', type: 'button', title: shown ? 'Hide token' : 'Reveal token', 'aria-pressed': String(shown),
      onclick: () => { shown ? revealed.delete(s.job_id) : revealed.add(s.job_id); renderSessions(); } }, shown ? '🙈' : '👁');

    let logBody = consoles.get(s.job_id);
    const details = h('details', { class: 'jp-log', ontoggle: (e) => {
      if (e.target.open && !logBody) {
        logBody = jobConsole({ id: s.job_id, title: s.title, display: s.display, status: s.status, duration: s.duration, exit_code: s.exit_code },
          { onDone: () => setTimeout(pollSessions, 200) });
        consoles.set(s.job_id, logBody);
        e.target.append(logBody);
      }
    } }, h('summary', { class: 'small' }, 'Show log'));
    if (logBody) { details.open = true; details.append(logBody); }

    const hint = {
      connecting: s.reuse ? 'Opening the ssh tunnel…' : 'Connecting over ssh and starting Jupyter… (the URL appears once Jupyter prints it)',
      stopped: 'Disconnected.',
    }[s.state];

    return h('div', { class: `jp-session ${s.state}` },
      h('div', { class: 'row' },
        h('span', { class: `pill ${STATE_PILL[s.state]}` }, s.state),
        h('b', {}, s.reuse ? 'Tunnel to running server' : 'Jupyter session'),
        h('span', { class: 'muted small' }, s.mode === 'tunnel' ? `127.0.0.1:${s.local_port} → ${s.host}:${s.remote_port}` : `${s.host}:${s.remote_port}`),
        h('span', { class: 'spacer' }),
        h('span', running ? { class: 'muted small', 'data-started': String(s.started_at) } : { class: 'muted small' },
          fmt.duration(running ? Date.now() / 1000 - s.started_at : s.duration)),
        running && h('button', { class: 'btn sm danger', type: 'button', onclick: () => stop(s) }, '⏹ Disconnect')),
      s.url && h('div', { class: 'jp-url-row' }, urlText, toggle,
        h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(s.url, 'URL copied (with token)') }, 'Copy URL'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => openUrl(s.url) }, '↗ Open Jupyter')),
      hint && !s.error && h('span', { class: 'muted small' }, hint),
      s.error && h('div', { class: `notice ${s.state === 'failed' ? 'err' : 'warn'}` }, h('b', {}, s.error),
        s.hint && h('div', { class: 'small' }, s.hint)),
      details);
  }

  /* ---------------- commands ---------------- */
  async function loadCommands(p, slot) {
    try {
      const c = await get(`${API}/profiles/${p.id}/commands`);
      clear(slot,
        h('b', {}, 'ssh login'), codeBlock(c.ssh_login),
        h('b', {}, 'Manual steps (after logging in)'), codeBlock(c.manual_steps),
        c.tunnel && [h('b', {}, 'Tunnel only (in a second terminal), then open'), codeBlock(c.tunnel)],
        h('span', { class: 'mono small muted' }, c.open),
        h('b', {}, 'What “Connect & start Jupyter” runs'), codeBlock(c.start, { maxHeight: '220px' }));
    } catch (e) { clear(slot, h('div', { class: 'notice err' }, e.message)); }
  }

  /* ---------------- profile form ---------------- */
  async function editProfile(p) {
    const v = p ? { login_shell: true, startup_steps: '', ...p }
      : { mode: 'tunnel', remote_port: 8888, local_port: 8888, user: 'ubuntu', extra_ssh_args: '', notes: '', login_shell: true, startup_steps: '' };
    const saved = await modal(p ? `Edit ${p.name}` : 'Add server profile', (close) => {
      const input = (key, attrs = {}) => h('input', { type: 'text', value: v[key] ?? '', oninput: (e) => { v[key] = e.target.value; }, ...attrs });
      const field = (label, control, hint) => h('label', { class: 'field' }, label, control, hint && h('span', { class: 'hint' }, hint));
      const keyInput = input('key_path', { class: 'mono', placeholder: '~/keys/server.pem' });
      const modeHelp = h('p', { class: 'muted small', style: { margin: 0 } }, MODE_HELP[v.mode]);
      const localPort = field('Local port', input('local_port', { type: 'number', min: 1, max: 65535 }), 'browser opens 127.0.0.1:<this>');
      const err = h('div', {});
      const mode = segmented([
        { value: 'tunnel', label: '🔒 SSH tunnel (recommended)' },
        { value: 'direct', label: '🌐 Direct (--ip 0.0.0.0)' },
      ], v.mode, (m) => { v.mode = m; modeHelp.textContent = MODE_HELP[m]; localPort.hidden = m !== 'tunnel'; });
      localPort.hidden = v.mode !== 'tunnel';

      async function save() {
        try {
          const body = { ...v, remote_port: Number(v.remote_port), local_port: Number(v.local_port) };
          const r = p ? await put(`${API}/profiles/${p.id}`, body) : await post(`${API}/profiles`, body);
          for (const w of r.warnings || []) toast(`⚠ ${w}`, 'err');
          close(r.profile);
        } catch (e) { clear(err, h('div', { class: 'notice err' }, e.message)); }
      }

      return h('form', { class: 'stack jp-form', onsubmit: (e) => { e.preventDefault(); save(); } },
        field('Name', input('name', { placeholder: 'prod', required: true })),
        h('div', { class: 'grid-2' },
          field('Host / IP', input('host', { class: 'mono', placeholder: '10.0.0.5', required: true }), 'private IP or hostname (reachable over the VPN)'),
          field('User', input('user', { class: 'mono', placeholder: 'ubuntu', required: true }))),
        field('Key file', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, keyInput,
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            const path = await browseFiles(v.key_path ? v.key_path.replace(/\/[^/]*$/, '') : '~/workspace', { mode: 'any' });
            if (path) { v.key_path = path; keyInput.value = path; }
          } }, 'Browse…')), 'the .pem / private key — only its path is stored, never its contents'),
        field('Remote folder', input('remote_dir', { class: 'mono', placeholder: '/mnt/efs/cron_jobs/project', required: true }), 'cd here before starting Jupyter'),
        field('Conda environment', input('conda_env', { class: 'mono', placeholder: 'my_env', required: true })),
        h('div', { class: 'stack' }, h('b', {}, 'How to reach Jupyter'), mode, modeHelp),
        h('div', { class: 'grid-2' },
          field('Remote port', input('remote_port', { type: 'number', min: 1, max: 65535 }), 'Jupyter --port on the server'),
          localPort),
        field('Startup steps', h('textarea', { class: 'mono', rows: 3, value: v.startup_steps || '', spellcheck: false,
          placeholder: 'export MY_VAR=1\ngit pull\npip install -r requirements.txt',
          oninput: (e) => { v.startup_steps = e.target.value; } }),
        'optional — your own commands, one per line, run on the server after “cd” and “conda activate”, right before Jupyter starts'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v.login_shell !== false, onchange: (e) => { v.login_shell = e.target.checked; } }),
          'Run like my terminal (bash -lic: loads ~/.profile and ~/.bashrc, so PATH and conda match a manual ssh session)'),
        field('Extra ssh args', input('extra_ssh_args', { class: 'mono', placeholder: '-p 2222' }), 'optional; options that run local commands (ProxyCommand, …) are refused'),
        field('Notes', h('textarea', { rows: 2, value: v.notes || '', oninput: (e) => { v.notes = e.target.value; } })),
        err,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
          h('button', { class: 'btn primary', type: 'submit' }, p ? 'Save' : 'Add profile')));
    });
    if (saved) {
      toast(`Saved ${saved.name}`, 'ok');
      selectedId = saved.id;
      store.set(SEL_KEY, saved.id);
      await refresh();
    }
  }

  async function removeProfile(p) {
    if (liveSession(p.id)) { toast('Disconnect the running session first', 'err'); return; }
    if (!(await confirmDialog('Delete profile', `Delete “${p.name}” (${p.user}@${p.host})? The key file is not touched.`, { okLabel: 'Delete', danger: true }))) return;
    try {
      await del(`${API}/profiles/${p.id}`);
      if (selectedId === p.id) selectedId = null;
      await refresh();
    } catch (e) { toastError(e); }
  }

  await refresh();

  return {
    onShow: () => refresh(),
    open: async (ref) => {
      if (ref === 'new') { editProfile(null); return; }
      if (!profiles.some((p) => p.id === ref)) await refresh();
      if (profiles.some((p) => p.id === ref)) select(ref);
    },
  };
}
