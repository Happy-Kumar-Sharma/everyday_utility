// 📡 API tester: a tiny Postman. The request is sent by this app's server (POST /api/devtools/api/send) because
// browsers block most cross-origin calls. Inputs are never stored; only options (and, if asked, variable values).

import { ApiError, get, post } from '../../../core/api.js';
import { checkbox, codeBlock, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, fmt, h, loadCss, modal, toast } from '../../../core/dom.js';
import * as L from './api.logic.js';
import { area, copyBtn, labelled, notice, opt, setOpt, show } from '../ui.js';

const T = 'api';
const COLLECTION = 'API requests';
const HISTORY_MAX = 20;
const SECRETISH = /token|secret|pass|pwd|key|auth|cookie|session/i;

const blank = () => ({ method: 'GET', url: '', headers: [{ key: '', value: '', on: true }], bodyType: 'none', body: '',
  form: [{ key: '', value: '', on: true }], auth: { type: 'none', token: '', user: '', password: '' }, query: [] });
const clone = (s) => JSON.parse(JSON.stringify(s));

/** Editable key/value rows with an on/off checkbox per row. rows are mutated in place; onChange() after edits. */
function rowsEditor(label, getRows, onChange, { keyPh = 'Name', valuePh = 'Value' } = {}) {
  const body = h('tbody');
  const render = () => {
    const rows = getRows();
    clear(body, rows.map((r, i) => h('tr', { class: r.on === false ? 'dt-api-off' : '' },
      h('td', {}, h('input', { type: 'checkbox', checked: r.on !== false, 'aria-label': `Enable ${label} row ${i + 1}`,
        onchange: (e) => { r.on = e.target.checked; e.target.closest('tr').classList.toggle('dt-api-off', !r.on); onChange(); } })),
      h('td', {}, h('input', { type: 'text', class: 'mono', value: r.key, placeholder: keyPh, spellcheck: false, 'aria-label': `${label} ${i + 1} name`,
        oninput: (e) => { r.key = e.target.value; onChange(); } })),
      h('td', {}, h('input', { type: 'text', class: 'mono', value: r.value, placeholder: valuePh, spellcheck: false, 'aria-label': `${label} ${i + 1} value`,
        oninput: (e) => { r.value = e.target.value; onChange(); } })),
      h('td', {}, h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Remove ${label} row ${i + 1}`,
        onclick: () => { rows.splice(i, 1); render(); onChange(); } }, '✕')))));
  };
  const el = h('div', { class: 'stack dt-api-rows' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-api-table', 'aria-label': label },
      h('thead', {}, h('tr', {}, h('th', { class: 'dt-api-on' }, h('span', { class: 'dt-api-sr' }, 'On')), h('th', {}, keyPh), h('th', {}, valuePh), h('th', { class: 'dt-api-x' }, h('span', { class: 'dt-api-sr' }, 'Remove')))),
      body)),
    h('div', {}, h('button', { type: 'button', class: 'btn sm', onclick: () => {
      getRows().push({ key: '', value: '', on: true }); render();
      body.querySelector('tr:last-child input[type=text]')?.focus();
    } }, `+ Add ${label.toLowerCase().replace(/s$/, '')}`)));
  el.render = render;
  render();
  return el;
}

/** Collapsible JSON tree; children are built when a node is first opened (large responses stay fast). */
function jsonTree(value, key = null, depth = 0) {
  const label = key === null ? null : h('span', { class: 'dt-api-key' }, typeof key === 'number' ? `${key}` : JSON.stringify(key), ': ');
  if (value === null || typeof value !== 'object') {
    const cls = value === null ? 'null' : typeof value;
    return h('div', { class: 'dt-api-leaf' }, label, h('span', { class: `dt-api-v-${cls}` }, JSON.stringify(value)));
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const summary = h('summary', {}, label, isArr ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]` : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`);
  if (!entries.length) return h('div', { class: 'dt-api-leaf' }, label, isArr ? '[]' : '{}');
  const kids = h('div', { class: 'dt-api-kids' });
  const d = h('details', { open: depth < 1 }, summary, kids);
  let built = false;
  const build = () => {
    if (built) return; built = true;
    const LIMIT = 500;
    entries.slice(0, LIMIT).forEach(([k, v]) => kids.append(jsonTree(v, k, depth + 1)));
    if (entries.length > LIMIT) kids.append(h('div', { class: 'muted small' }, `… ${entries.length - LIMIT} more (see Raw)`));
  };
  if (depth < 1) build();
  d.addEventListener('toggle', () => d.open && build());
  return d;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function build() {
  loadCss('/static/css/devtools-netimg.css');
  let state = blank();
  let values = opt(T, 'rememberValues', false) ? { ...opt(T, 'varValues', {}) } : {};
  let response = null;
  let seq = 0;
  const history = [];

  const status = notice();
  const reqNotice = notice();

  /* ---------- request line ---------- */
  const method = h('select', { 'aria-label': 'HTTP method', class: 'dt-api-method',
    onchange: () => { state.method = method.value; refreshVars(); } }, L.METHODS.map((m) => h('option', { value: m }, m)));
  const url = h('input', { type: 'text', class: 'mono dt-api-url', placeholder: 'https://api.example.com/items?page=1  ·  {{base}}/items',
    spellcheck: false, autocomplete: 'off', 'aria-label': 'Request URL' });
  const sendBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => send(), title: 'Ctrl+Enter' }, 'Send');
  url.addEventListener('input', () => {
    state.url = url.value;
    const disabled = state.query.filter((r) => r.on === false);
    state.query = [...L.parseQuery(url.value), ...disabled];
    queryEd.render();
    refreshVars();
  });

  const queryEd = rowsEditor('Query params', () => state.query, () => {
    url.value = L.withQuery(url.value, state.query); state.url = url.value; refreshVars();
  }, { keyPh: 'Parameter', valuePh: 'Value' });
  const headersEd = rowsEditor('Headers', () => state.headers, () => { refreshVars(); }, { keyPh: 'Header', valuePh: 'Value' });

  /* ---------- auth ---------- */
  const token = h('input', { type: 'password', class: 'mono', autocomplete: 'off', spellcheck: false, placeholder: 'token or {{token}}',
    oninput: () => { state.auth.token = token.value; refreshVars(); } });
  const user = h('input', { type: 'text', class: 'mono', autocomplete: 'off', spellcheck: false, placeholder: 'user or {{user}}',
    oninput: () => { state.auth.user = user.value; refreshVars(); } });
  const pass = h('input', { type: 'password', class: 'mono', autocomplete: 'off', spellcheck: false, placeholder: 'password or {{password}}',
    oninput: () => { state.auth.password = pass.value; refreshVars(); } });
  const reveal = checkbox('Show', false, (v) => { token.type = v ? 'text' : 'password'; pass.type = v ? 'text' : 'password'; });
  const bearerBox = h('div', { class: 'row' }, h('div', { class: 'dt-grow' }, labelled('Bearer token', token)));
  const basicBox = h('div', { class: 'row' }, h('div', { class: 'dt-grow' }, labelled('Username', user)), h('div', { class: 'dt-grow' }, labelled('Password', pass)));
  const authType = segmented([{ value: 'none', label: 'No auth' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic' }],
    'none', (v) => { state.auth.type = v; renderAuth(); refreshVars(); });
  function renderAuth() {
    bearerBox.hidden = state.auth.type !== 'bearer'; basicBox.hidden = state.auth.type !== 'basic';
    reveal.hidden = state.auth.type === 'none';
  }
  const authPanel = h('div', { class: 'stack' }, h('div', { class: 'row' }, authType, reveal), bearerBox, basicBox,
    h('p', { class: 'muted small' }, 'Adds an Authorization header unless you set one yourself. Use {{variables}} so saved requests don’t contain the secret.'));

  /* ---------- body ---------- */
  const bodyText = area({ rows: 10, placeholder: '{\n  "name": "{{name}}"\n}', 'aria-label': 'Request body' });
  const bodyNotice = notice();
  const formEd = rowsEditor('Form fields', () => state.form, () => refreshVars(), { keyPh: 'Field', valuePh: 'Value' });
  const formatBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => {
    const r = L.checkJson(bodyText.value);
    if (r.error) return show(bodyNotice, 'err', `✗ Can’t format: ${r.error}`);
    if (!r.empty) { bodyText.value = JSON.stringify(JSON.parse(bodyText.value), null, 2); state.body = bodyText.value; checkBody(); }
  } }, 'Format JSON');
  const bodyType = segmented([{ value: 'none', label: 'None' }, { value: 'json', label: 'JSON' }, { value: 'form', label: 'Form (urlencoded)' }, { value: 'raw', label: 'Raw text' }],
    'none', (v) => { state.bodyType = v; renderBody(); refreshVars(); });
  function renderBody() {
    const t = state.bodyType;
    bodyText.hidden = !(t === 'json' || t === 'raw'); formEd.hidden = t !== 'form'; formatBtn.hidden = t !== 'json';
    checkBody();
  }
  function checkBody() {
    if (state.bodyType !== 'json') return show(bodyNotice, '');
    const filled = L.fill(bodyText.value, values);
    const r = L.checkJson(filled);
    if (r.empty) return show(bodyNotice, '');
    if (r.error) return show(bodyNotice, 'err', `✗ Not valid JSON${r.line ? ` — line ${r.line}, column ${r.col}` : ''}: ${r.error}`);
    const missing = L.unfilled(filled);
    show(bodyNotice, 'ok', `✓ Valid JSON${missing.length ? ' (with variables still to fill)' : ''}`);
  }
  bodyText.addEventListener('input', debounce(() => { state.body = bodyText.value; checkBody(); refreshVars(); }, 200));
  const bodyPanel = h('div', { class: 'stack' }, h('div', { class: 'row' }, bodyType, formatBtn), bodyText, formEd, bodyNotice);

  /* ---------- variables ---------- */
  const varsBox = h('div', { class: 'stack' });
  const remember = checkbox('Remember values in this browser', opt(T, 'rememberValues', false), (v) => {
    setOpt(T, 'rememberValues', v);
    setOpt(T, 'varValues', v ? { ...values } : {});
    rememberWarn();
  });
  const varsNotice = notice();
  const rememberWarn = () => (opt(T, 'rememberValues', false)
    ? show(varsNotice, 'warn', '⚠ Values are stored unencrypted in this browser’s localStorage. Don’t remember tokens or passwords.')
    : show(varsNotice, ''));
  const saveValues = debounce(() => { if (opt(T, 'rememberValues', false)) setOpt(T, 'varValues', { ...values }); }, 400);
  let lastVarKey = '';
  function refreshVars() {
    const names = L.requestVariables(state);
    const known = opt(T, 'varNames', []);
    const merged = [...names, ...known.filter((n) => !names.includes(n))];
    if (names.some((n) => !known.includes(n))) setOpt(T, 'varNames', [...new Set([...known, ...names])].slice(-50));
    const key = merged.join('\u0000') + '|' + names.join('\u0000');
    if (key !== lastVarKey) {
      lastVarKey = key;
      clear(varsBox, merged.length ? h('div', { class: 'dt-api-vars' }, merged.map((n) => {
        const input = h('input', { type: SECRETISH.test(n) ? 'password' : 'text', class: 'mono', value: values[n] ?? '', autocomplete: 'off', spellcheck: false,
          'aria-label': `Value of ${n}`, oninput: () => { values[n] = input.value; saveValues(); checkBody(); } });
        return h('label', { class: `field dt-api-var ${names.includes(n) ? '' : 'dt-api-unused'}` },
          h('span', { class: 'row' }, h('code', {}, `{{${n}}}`), names.includes(n) ? null : h('span', { class: 'muted small' }, 'not used here'),
            h('span', { class: 'spacer' }), names.includes(n) ? null : h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Forget ${n}`, onclick: (e) => {
              e.preventDefault();
              setOpt(T, 'varNames', opt(T, 'varNames', []).filter((x) => x !== n)); delete values[n]; saveValues(); refreshVars();
            } }, '✕')),
          input);
      })) : h('p', { class: 'muted small' }, 'Type {{name}} in the URL, headers, body or auth to create a variable.'));
    }
    varsTab.textContent = names.length ? `Variables (${names.length})` : 'Variables';
  }
  const varsPanel = h('div', { class: 'stack' }, varsBox, h('div', { class: 'row' }, remember), varsNotice,
    h('p', { class: 'muted small' }, 'Only variable names are remembered unless you tick the box. {{today}} and {{now}} are filled in automatically.'));

  /* ---------- options ---------- */
  const timeout = h('input', { type: 'number', min: 1, max: 120, step: 1, value: opt(T, 'timeout', 30), class: 'dt-api-num', 'aria-label': 'Timeout in seconds',
    onchange: () => setOpt(T, 'timeout', Math.min(120, Math.max(1, Number(timeout.value) || 30))) });
  const follow = checkbox('Follow redirects', opt(T, 'follow', true), (v) => setOpt(T, 'follow', v));
  const verify = checkbox('Verify TLS certificates', opt(T, 'verify', true), (v) => setOpt(T, 'verify', v));
  const optsPanel = h('div', { class: 'row' }, h('label', { class: 'row' }, 'Timeout', timeout, 's'), follow, verify);

  /* ---------- request tabs ---------- */
  const panels = { params: queryEd, headers: headersEd, body: bodyPanel, auth: authPanel, vars: varsPanel, options: optsPanel };
  const varsTab = h('span', {}, 'Variables');
  const reqTabs = segmented([
    { value: 'params', label: 'Params' }, { value: 'headers', label: 'Headers' }, { value: 'body', label: 'Body' },
    { value: 'auth', label: 'Auth' }, { value: 'vars', label: varsTab }, { value: 'options', label: 'Options' }],
  opt(T, 'tab', 'params'), (v) => { setOpt(T, 'tab', v); showPanel(); });
  const showPanel = () => { for (const [k, p] of Object.entries(panels)) p.hidden = k !== reqTabs.value; };

  /* ---------- response ---------- */
  const resHead = h('div', { class: 'row dt-api-reshead' });
  const resBody = h('div', { class: 'stack' });
  const resHeaders = h('div', {});
  const resView = segmented([{ value: 'body', label: 'Body' }, { value: 'headers', label: 'Headers' }], 'body', () => renderResponse());
  const bodyView = segmented([{ value: 'pretty', label: 'Pretty' }, { value: 'raw', label: 'Raw' }], opt(T, 'view', 'pretty'),
    (v) => { setOpt(T, 'view', v); renderResponse(); });
  const resActions = h('div', { class: 'row' });
  const resCard = h('section', { class: 'dt-api-res stack', 'aria-label': 'Response', hidden: true },
    resHead, h('div', { class: 'row' }, resView, bodyView, h('span', { class: 'spacer' }), resActions), resBody, resHeaders);

  function bodyBytes(r) { return r.body_text != null ? new TextEncoder().encode(r.body_text) : base64ToBytes(r.body_base64 || ''); }

  function renderResponse() {
    const r = response;
    resCard.hidden = !r;
    if (!r) return;
    const ct = L.headerValue(r.headers, 'content-type') || '';
    const kind = L.bodyKind(r);
    clear(resHead,
      h('span', { class: `pill ${L.statusKind(r.status)} dt-api-status` }, `${r.status} ${r.reason || ''}`.trim()),
      h('span', { class: 'muted small' }, `${fmt.int(Math.round(r.elapsed_ms))} ms`),
      h('span', { class: 'muted small' }, fmt.bytes(r.size)),
      h('span', { class: 'muted small' }, r.http_version || ''),
      ct ? h('span', { class: 'muted small mono' }, ct) : null,
      r.truncated ? h('span', { class: 'pill warn' }, 'truncated at 5 MB') : null);
    if (r.redirects?.length) resHead.append(h('details', { class: 'small dt-api-redirects' }, h('summary', {}, `${r.redirects.length} redirect${r.redirects.length > 1 ? 's' : ''}`),
      h('ol', {}, r.redirects.map((u) => h('li', { class: 'mono' }, u)))));
    clear(resActions,
      r.body_text != null ? copyBtn(() => r.body_text, 'Copy body') : null,
      h('button', { type: 'button', class: 'btn sm', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([bodyBytes(r)], { type: ct.split(';')[0] || 'application/octet-stream' })), download: L.bodyFilename(r.url || state.url, ct) });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, '⬇ Download body'));
    const onBody = resView.value === 'body';
    resBody.hidden = !onBody; resHeaders.hidden = onBody;
    bodyView.hidden = !onBody || kind !== 'json';
    clear(resHeaders, h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-api-hdrs' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Header'), h('th', {}, 'Value'))),
      h('tbody', {}, r.headers.map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, v)))))));
    if (!onBody) return;
    if (!r.size) return clear(resBody, h('p', { class: 'muted small' }, 'Empty body.'));
    if (kind === 'image') {
      const type = /^image\/[\w.+-]+$/i.test(ct.split(';')[0].trim()) ? ct.split(';')[0].trim() : 'image/png';
      const b64 = r.body_base64 ?? L.utf8Base64(r.body_text);
      return clear(resBody, h('div', { class: 'dt-api-img' }, h('img', { src: `data:${type};base64,${b64}`, alt: 'Response image' })));
    }
    if (kind === 'binary') return clear(resBody, h('p', { class: 'muted small' }, `Binary body (${fmt.bytes(r.size)}) — use Download body.`));
    if (kind === 'json' && bodyView.value === 'pretty') {
      try { return clear(resBody, h('div', { class: 'dt-api-tree mono' }, jsonTree(JSON.parse(r.body_text)))); } catch { /* fall through to raw */ }
    }
    const raw = codeBlock('', { maxHeight: '520px' });
    raw.set(r.body_text);
    clear(resBody, raw);
  }

  /* ---------- history (memory only) ---------- */
  const historyBox = h('div', { class: 'stack' });
  function renderHistory() {
    clear(historyBox, history.length ? h('ol', { class: 'dt-api-history' }, history.map((e, i) => h('li', {},
      h('button', { type: 'button', class: 'btn sm ghost dt-api-hist', title: 'Load this request', onclick: () => loadState(e.state) },
        h('span', { class: `pill ${e.status ? L.statusKind(e.status) : 'err'}` }, e.status || 'error'),
        h('span', { class: 'mono' }, e.state.method), h('span', { class: 'mono dt-api-hist-url' }, e.state.url),
        h('span', { class: 'muted small' }, e.ms != null ? `${Math.round(e.ms)} ms` : ''))))) : h('p', { class: 'muted small' }, 'Requests you send appear here (this page only, not stored).'));
  }

  /* ---------- send ---------- */
  function currentRequest() { return L.buildRequest(state, values); }

  async function send() {
    try {
      state.body = bodyText.value;
      const req = currentRequest();
      show(status, '');
      if (req.problems.length) { show(reqNotice, 'err', ...req.problems.map((p) => h('div', {}, `✗ ${p}`))); return; }
      show(reqNotice, '');
      const mine = ++seq;
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      show(status, '');
      const snapshot = clone(state);
      try {
        const r = await post('/api/devtools/api/send', {
          method: req.method, url: req.url, headers: req.headers, body: req.body,
          timeout_s: Math.min(120, Math.max(1, Number(timeout.value) || 30)),
          follow_redirects: follow.querySelector('input').checked, verify_tls: verify.querySelector('input').checked,
        });
        if (mine !== seq) return;
        response = r;
        history.unshift({ state: snapshot, status: r.status, ms: r.elapsed_ms });
        renderResponse();
      } catch (e) {
        if (mine !== seq) return;
        response = null; renderResponse();
        history.unshift({ state: snapshot, status: null, ms: null });
        const hint = e instanceof ApiError && e.status === 502 ? ' (sent from this app’s server)' : '';
        show(status, 'err', `✗ ${e.message || e}${hint}`);
      } finally {
        if (mine === seq) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
        history.splice(HISTORY_MAX);
        renderHistory();
      }
    } catch (e) {
      sendBtn.disabled = false; sendBtn.textContent = 'Send';
      show(status, 'err', `✗ ${e.message || e}`);
    }
  }

  /* ---------- load / save ---------- */
  function loadState(s) {
    state = { ...blank(), ...clone(s) };
    state.auth = { ...blank().auth, ...state.auth };
    if (!state.headers.length) state.headers.push({ key: '', value: '', on: true });
    if (!state.form.length) state.form.push({ key: '', value: '', on: true });
    state.query = [...L.parseQuery(state.url), ...(s.query || []).filter((r) => r.on === false)];
    if (![...method.options].some((o) => o.value === state.method)) method.append(h('option', { value: state.method }, state.method));
    method.value = state.method;
    url.value = state.url; bodyText.value = state.body;
    token.value = state.auth.token || ''; user.value = state.auth.user || ''; pass.value = state.auth.password || '';
    authType.value = state.auth.type; bodyType.value = state.bodyType;
    queryEd.render(); headersEd.render(); formEd.render();
    renderAuth(); renderBody(); refreshVars();
    show(reqNotice, '');
  }

  function defaultName() {
    const { base } = L.splitUrl(state.url);
    const path = base.replace(/^[a-z]+:\/\/[^/]*/i, '').split('/').filter(Boolean).pop() || base.replace(/^[a-z]+:\/\//i, '').split('/')[0] || 'request';
    return `${state.method} ${path}`.replace(/[\\/\0{}]+/g, '_').slice(0, 80);
  }

  async function saveToLibrary() {
    try {
      state.body = bodyText.value;
      if (!state.url.trim()) return show(reqNotice, 'err', '✗ Enter a URL before saving.');
      const secrets = L.literalSecrets(state);
      const name = await modal('Save to Library', (close) => {
        const input = h('input', { type: 'text', value: defaultName(), 'aria-label': 'Name', onkeydown: (e) => { if (e.key === 'Enter') close(input.value.trim()); } });
        return h('div', { class: 'stack' },
          labelled('Name', input),
          h('p', { class: 'muted small' }, `Saved as JSON in the “${COLLECTION}” collection. {{variables}} are kept, their values are not saved.`),
          secrets.length ? h('div', { class: 'notice warn' }, `⚠ This request contains a literal secret (${secrets.join(', ')}). It will be written to the Library file in plain text — consider replacing it with a {{variable}} first.`) : null,
          h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
            h('button', { type: 'button', class: `btn ${secrets.length ? 'danger' : 'primary'}`, onclick: () => close(input.value.trim()) }, secrets.length ? 'Save anyway' : 'Save')));
      });
      if (!name) return;
      const item = await post('/api/library/items', { collection: COLLECTION, name, type: 'json', content: L.toSaved(state) });
      toast(`Saved to Library: ${item?.path || name}`, 'ok');
    } catch (e) { show(status, 'err', `✗ Could not save: ${e.message || e}`); }
  }

  async function openFromLibrary() {
    try {
      const data = await get('/api/library/items');
      if (data?.problem) return show(status, 'warn', `Library: ${data.problem}`);
      const items = (data?.items || []).filter((i) => i.collection === COLLECTION || i.collection?.startsWith(`${COLLECTION}/`));
      if (!items.length) return show(status, 'warn', `No saved requests yet — use “Save to Library” (collection “${COLLECTION}”).`);
      const picked = await modal('Open from Library', (close) => {
        const filter = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter saved requests' });
        const list = h('div', { class: 'stack dt-api-lib' });
        const render = () => {
          const q = filter.value.trim().toLowerCase();
          clear(list, items.filter((i) => !q || `${i.name} ${i.content}`.toLowerCase().includes(q)).map((i) => {
            let preview = '';
            try { const d = JSON.parse(i.content); preview = `${d.method || 'GET'} ${d.url || ''}`; } catch { preview = 'not a saved request'; }
            return h('button', { type: 'button', class: 'btn dt-api-libitem', onclick: () => close(i) },
              h('strong', {}, i.name), h('span', { class: 'muted small mono' }, preview));
          }));
        };
        filter.addEventListener('input', render);
        render();
        return h('div', { class: 'stack' }, filter, list);
      });
      if (!picked) return;
      if (picked.truncated || picked.binary) return show(status, 'err', '✗ That item is too large or not text.');
      loadState(L.fromSaved(picked.content));
      response = null; renderResponse();
      show(status, 'ok', `Loaded “${picked.name}” from the Library.`);
    } catch (e) { show(status, 'err', `✗ ${e.message || e}`); }
  }

  function copyCurl() {
    try {
      state.body = bodyText.value;
      const req = currentRequest();
      const problems = req.problems.filter((p) => !p.startsWith('Body is not valid JSON'));
      if (!req.url) return show(reqNotice, 'err', '✗ Enter a URL first.');
      copyText(L.toCurl(req, { insecure: !verify.querySelector('input').checked, follow: follow.querySelector('input').checked }), 'curl command copied');
      if (problems.length) show(reqNotice, 'warn', ...problems.map((p) => h('div', {}, `⚠ ${p}`)));
    } catch (e) { show(status, 'err', `✗ ${e.message || e}`); }
  }

  /* ---------- layout ---------- */
  const el = h('div', { class: 'stack dt-tool dt-api' },
    h('div', { class: 'row dt-api-line' }, method, url, sendBtn),
    h('div', { class: 'row' }, reqTabs, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn sm', onclick: copyCurl }, 'Copy as curl'),
      h('button', { type: 'button', class: 'btn sm', onclick: saveToLibrary }, '💾 Save to Library'),
      h('button', { type: 'button', class: 'btn sm', onclick: openFromLibrary }, '📂 Open from Library')),
    ...Object.values(panels), reqNotice, status, resCard,
    h('details', { class: 'dt-api-histwrap' }, h('summary', {}, 'History (last 20, this page only)'), historyBox),
    h('p', { class: 'muted small' }, 'Requests are sent by this app’s server (no browser CORS limits) — so “localhost” means the machine running Everyday Utility. Response bodies are capped at 5 MB.'));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Enter' && e.target === url) { e.preventDefault(); send(); }
  });

  showPanel(); renderAuth(); renderBody(); refreshVars(); renderHistory(); rememberWarn();
  return {
    el,
    clear() {
      seq++;
      values = opt(T, 'rememberValues', false) ? { ...opt(T, 'varValues', {}) } : {};
      lastVarKey = '';
      response = null; history.length = 0;
      sendBtn.disabled = false; sendBtn.textContent = 'Send';
      loadState(blank()); renderResponse(); renderHistory();
      show(status, ''); show(reqNotice, '');
    },
    focus() { url.focus(); },
  };
}
