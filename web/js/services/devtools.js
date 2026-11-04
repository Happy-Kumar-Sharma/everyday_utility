// 🛠 Dev Tools: small developer utilities. Everything runs in this page; nothing is sent to the server,
// and tool inputs are never stored (they may hold tokens) — only the chosen tool and options are remembered.

import { checkbox, codeBlock, segmented } from '../core/components.js';
import { clear, copyText, debounce, fmt, h, loadCss, store, toast } from '../core/dom.js';
import * as L from './devtools/logic.js';

const TOOLS = [
  ['json', '🧾', 'JSON', jsonTool],
  ['diff', '🔀', 'Text diff', diffTool],
  ['base64', '🔤', 'Base64', base64Tool],
  ['jwt', '🎫', 'JWT decoder', jwtTool],
  ['time', '🕒', 'Time', timeTool],
  ['uuid', '🆔', 'UUID', uuidTool],
  ['url', '🔗', 'URL', urlTool],
  ['regex', '🧩', 'Regex tester', regexTool],
  ['hash', '#️⃣', 'Hash', hashTool],
  ['text', '✂️', 'Text utilities', textTool],
];

const opts = store.get('devtools.opts', {});
const opt = (tool, key, fallback) => opts[tool]?.[key] ?? fallback;
const setOpt = (tool, key, value) => { (opts[tool] ||= {})[key] = value; store.set('devtools.opts', opts); };

export async function mount(container) {
  loadCss('/static/css/devtools.css');
  const built = new Map();  // key -> {el, clear}
  const title = h('h2', {});
  const body = h('div', { class: 'card-body' });
  const navButtons = new Map();
  let current = null;

  const nav = h('nav', { class: 'dt-nav card', 'aria-label': 'Dev tools' }, TOOLS.map(([key, icon, label]) => {
    const b = h('button', { type: 'button', class: 'nav-item', onclick: () => select(key) },
      h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), label);
    navButtons.set(key, b);
    return b;
  }));
  nav.addEventListener('keydown', (e) => {  // arrow keys move between tools
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const keys = TOOLS.map((t) => t[0]);
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = keys[(keys.indexOf(current) + step + keys.length) % keys.length];
    e.preventDefault();
    select(next);
    navButtons.get(next).focus();
  });

  function select(key) {
    const tool = TOOLS.find((t) => t[0] === key) || TOOLS[0];
    current = tool[0];
    store.set('devtools.tool', current);
    for (const [k, b] of navButtons) {
      b.classList.toggle('active', k === current);
      b.setAttribute('aria-current', k === current ? 'page' : 'false');
    }
    if (!built.has(current)) built.set(current, tool[3]());
    title.textContent = `${tool[1]}  ${tool[2]}`;
    clear(body, built.get(current).el);
  }

  const card = h('section', { class: 'card dt-main' },
    h('div', { class: 'card-head' }, title, h('span', { class: 'spacer' }),
      h('span', { class: 'muted small dt-private' }, '🔒 runs in your browser'),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => built.get(current)?.clear() }, 'Clear')),
    body);
  container.append(h('div', { class: 'dt-layout' }, nav, card));
  select(store.get('devtools.tool', 'json'));

  return {
    open(ref) { select(ref); body.querySelector('textarea, input[type=text]')?.focus(); },
  };
}

/* ------------------------------------------------------------------ shared bits */
const area = (props = {}) => h('textarea', { class: 'dt-input mono', rows: 8, spellcheck: false, ...props });
const labelled = (label, el, extra) => h('label', { class: 'field' }, h('span', { class: 'row' }, label, extra), el);
const notice = () => h('div', { class: 'notice', hidden: true, role: 'status' });
const show = (el, kind, ...text) => { el.hidden = !text.length; el.className = `notice ${kind}`; clear(el, ...text); };
const copyBtn = (getText, label = 'Copy') => h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(getText()) }, label);

/** Click-or-drop file target; onFile(file) gets a File. */
function dropZone(label, onFile) {
  const input = h('input', { type: 'file', hidden: true, onchange: () => input.files[0] && onFile(input.files[0]) });
  const zone = h('button', { type: 'button', class: 'dropzone dt-drop', onclick: () => input.click() }, label, input);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('drag');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  return zone;
}

/** Key/value list with a copy button per row. rows: [[label, value]] */
function kvList(rows) {
  return h('div', { class: 'dt-kv' }, rows.map(([k, v]) => h('div', { class: 'dt-kv-row' },
    h('span', { class: 'muted' }, k), h('span', { class: 'mono dt-kv-val' }, v),
    v ? h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Copy ${k}`, onclick: () => copyText(v) }, '⧉') : h('span'))));
}

/* ------------------------------------------------------------------ 1. JSON */
function jsonTool() {
  const t = 'json';
  const input = area({ rows: 12, placeholder: 'Paste JSON…' });
  const second = area({ rows: 12, placeholder: 'Paste the JSON to compare with…' });
  const out = codeBlock('', { maxHeight: '480px' });
  const status = notice();
  const diffOut = h('div', { class: 'stack' });
  const mode = segmented([{ value: 'format', label: 'Format' }, { value: 'minify', label: 'Minify' }, { value: 'diff', label: 'Diff' }],
    opt(t, 'mode', 'format'), (v) => { setOpt(t, 'mode', v); update(); });
  const indent = segmented([{ value: 2, label: '2 spaces' }, { value: 4, label: '4 spaces' }, { value: '\t', label: 'Tab' }],
    opt(t, 'indent', 2), (v) => { setOpt(t, 'indent', v); update(); });
  const sort = checkbox('Sort keys', opt(t, 'sort', false), (v) => { setOpt(t, 'sort', v); update(); });
  const secondField = labelled('Compare with', second);

  function gotoError(line, col) {
    const lines = input.value.split('\n');
    const pos = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
    input.focus(); input.setSelectionRange(pos, pos + 1);
  }

  function errorNotice(which, r) {
    const where = r.line ? `Line ${r.line}, column ${r.col}` : 'Invalid JSON';
    return [`✗ ${which}${where} — ${r.error}`, r.line && which === '' ? h('button', { type: 'button', class: 'btn sm', style: { marginLeft: '8px' }, onclick: () => gotoError(r.line, r.col) }, 'Go to error') : null];
  }

  const lossyWarning = (r) => `Valid JSON, but ${r.unsafeInts.length} integer${r.unsafeInts.length > 1 ? 's exceed' : ' exceeds'} 2^53 and lose${r.unsafeInts.length > 1 ? '' : 's'} precision here (e.g. ${r.unsafeInts[0]}).`;

  function update() {
    const isDiff = mode.value === 'diff';
    indent.hidden = mode.value !== 'format';
    secondField.hidden = !isDiff; diffOut.hidden = !isDiff; out.hidden = isDiff;
    if (!input.value.trim()) { show(status, ''); out.set(''); clear(diffOut); return; }
    const r = L.parseJson(input.value);
    if (r.error) { show(status, 'err', ...errorNotice(isDiff ? 'Left: ' : '', r)); out.set(''); clear(diffOut); return; }
    const value = sort.querySelector('input').checked ? L.sortKeys(r.value) : r.value;
    if (!isDiff) {
      out.set(JSON.stringify(value, null, mode.value === 'minify' ? 0 : indent.value));
      return r.unsafeInts.length ? show(status, 'warn', lossyWarning(r)) : show(status, 'ok', '✓ Valid JSON');
    }
    if (!second.value.trim()) { show(status, 'ok', '✓ Left side is valid — paste the right side to compare.'); return clear(diffOut); }
    const r2 = L.parseJson(second.value);
    if (r2.error) { show(status, 'err', ...errorNotice('Right: ', r2)); return clear(diffOut); }
    const changes = L.jsonDiff(r.value, r2.value);
    const lossy = r.unsafeInts.length || r2.unsafeInts.length ? ` — ${lossyWarning({ unsafeInts: [...r.unsafeInts, ...r2.unsafeInts] })}` : '';
    show(status, changes.length || lossy ? 'warn' : 'ok',
      (changes.length ? `${changes.length} difference${changes.length > 1 ? 's' : ''}` : '✓ Structurally identical') + lossy);
    const val = (v) => (v === undefined ? '' : JSON.stringify(v));
    clear(diffOut, changes.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-jdiff' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Change'), h('th', {}, 'Path'), h('th', {}, 'Before'), h('th', {}, 'After'))),
      h('tbody', {}, changes.map((c) => h('tr', {},
        h('td', {}, h('span', { class: `pill ${c.op === 'added' ? 'ok' : c.op === 'removed' ? 'err' : 'warn'}` }, c.op)),
        h('td', { class: 'mono' }, c.path), h('td', { class: 'mono' }, val(c.from)), h('td', { class: 'mono' }, val(c.to))))))) : null);
  }
  const live = debounce(update, 150);
  input.addEventListener('input', live); second.addEventListener('input', live);
  update();
  return {
    el: h('div', { class: 'stack dt-tool' }, h('div', { class: 'row' }, mode, indent, sort),
      h('div', { class: 'dt-pair' }, labelled('JSON', input), secondField), status, out, diffOut),
    clear() { input.value = ''; second.value = ''; update(); },
  };
}

/* ------------------------------------------------------------------ 2. text diff */
function diffTool() {
  const t = 'diff';
  const left = area({ placeholder: 'Original text…' });
  const right = area({ placeholder: 'Changed text…' });
  const counts = h('div', { class: 'row' });
  const status = notice();
  const out = h('div', { class: 'dt-diff-out' });
  let ops = [];
  const view = segmented([{ value: 'split', label: 'Side by side' }, { value: 'unified', label: 'Unified' }],
    opt(t, 'view', 'split'), (v) => { setOpt(t, 'view', v); render(); });

  const num = (n) => h('td', { class: 'dt-ln' }, n ?? '');
  const cell = (op, cls) => h('td', { class: `dt-code ${op ? cls : 'dt-empty'}` }, op ? op.text : '');

  function render() {
    if (!ops.length) return clear(out);
    const rows = view.value === 'split'
      ? L.sideBySide(ops).map(({ left: a, right: b }) => h('tr', {},
        num(a?.a), cell(a, a?.type === 'del' ? 'dt-del' : ''), num(b?.b), cell(b, b?.type === 'add' ? 'dt-add' : '')))
      : ops.map((o) => h('tr', {}, num(o.a), num(o.b),
        h('td', { class: `dt-code ${o.type === 'add' ? 'dt-add' : o.type === 'del' ? 'dt-del' : ''}` },
          `${o.type === 'add' ? '+' : o.type === 'del' ? '−' : ' '} ${o.text}`)));
    clear(out, h('div', { class: 'table-wrap dt-diff-wrap' }, h('table', { class: `dt-diff ${view.value}` }, h('tbody', {}, rows))));
  }

  function update() {
    show(status, '');
    try {
      ops = left.value || right.value ? L.lineDiff(left.value, right.value) : [];
    } catch (e) { ops = []; show(status, 'err', e.message); }
    const c = L.diffCounts(ops);
    clear(counts, ops.length ? [
      h('span', { class: 'pill ok' }, `+${c.add} added`), h('span', { class: 'pill err' }, `−${c.del} removed`),
      h('span', { class: 'muted small' }, `${c.eq} unchanged`),
      !c.add && !c.del ? h('span', { class: 'pill ok' }, 'identical') : null,
      h('span', { class: 'spacer', style: { flex: 1 } }), copyBtn(() => L.unifiedText(ops), 'Copy unified'),
    ] : []);
    render();
  }
  const live = debounce(update, 250);
  left.addEventListener('input', live); right.addEventListener('input', live);
  return {
    el: h('div', { class: 'stack dt-tool' }, h('div', { class: 'row' }, view),
      h('div', { class: 'dt-pair' }, labelled('Original', left), labelled('Changed', right)), status, counts, out),
    clear() { left.value = ''; right.value = ''; update(); },
  };
}

/* ------------------------------------------------------------------ 3. Base64 */
function base64Tool() {
  const t = 'base64';
  const input = area({ placeholder: 'Text to encode, or Base64 to decode…' });
  const out = codeBlock('', { maxHeight: '360px' });
  const status = notice();
  let fileBytes = null, fileName = '';
  const dir = segmented([{ value: 'encode', label: 'Encode' }, { value: 'decode', label: 'Decode' }],
    opt(t, 'dir', 'encode'), (v) => { setOpt(t, 'dir', v); fileBytes = null; update(); });
  const urlSafe = checkbox('URL-safe (- _ no padding)', opt(t, 'urlSafe', false), (v) => { setOpt(t, 'urlSafe', v); update(); });
  const isUrlSafe = () => urlSafe.querySelector('input').checked;

  function update() {
    show(status, '');
    if (fileBytes) {
      out.set(L.bytesToBase64(fileBytes, isUrlSafe()));
      return show(status, 'ok', `${fileName} · ${fmt.bytes(fileBytes.length)} → ${fmt.int(out.textContent.length)} Base64 chars`);
    }
    if (!input.value) return out.set('');
    try {
      out.set(dir.value === 'encode' ? L.encodeBase64(input.value, isUrlSafe()) : L.decodeBase64(input.value));
    } catch (e) {
      out.set('');
      show(status, 'err', e instanceof TypeError ? 'Decoded bytes are not UTF-8 text (binary data?).' : e.message);
    }
  }
  input.addEventListener('input', debounce(() => { fileBytes = null; update(); }, 120));
  const drop = dropZone('📄 Drop a file here (or click) to get its Base64', async (file) => {
    fileBytes = new Uint8Array(await file.arrayBuffer()); fileName = file.name;
    dir.value = 'encode'; input.value = ''; update();
  });
  return {
    el: h('div', { class: 'stack dt-tool' }, h('div', { class: 'row' }, dir, urlSafe), input, drop, status, out),
    clear() { input.value = ''; fileBytes = null; update(); },
  };
}

/* ------------------------------------------------------------------ 4. JWT */
function jwtTool() {
  const input = area({ rows: 5, placeholder: 'Paste a JWT (eyJ…), "Bearer " prefix is fine' });
  const status = notice();
  const out = h('div', { class: 'stack' });

  function update() {
    show(status, ''); clear(out);
    if (!input.value.trim()) return;
    let jwt;
    try { jwt = L.decodeJwt(input.value); } catch (e) { return show(status, 'err', e.message); }
    const p = jwt.payload;
    const st = L.jwtStatus(p);
    const badge = {
      expired: ['err', `expired ${L.humanDuration(st.seconds)} ago`],
      valid: ['ok', `valid for ${L.humanDuration(st.seconds)}`],
      'not-yet': ['warn', `not valid for another ${L.humanDuration(st.seconds)}`],
      'no-exp': ['warn', 'no expiry (exp) claim'],
    }[st.state];
    const times = ['iat', 'nbf', 'exp'].filter((k) => typeof p[k] === 'number')
      .map((k) => [{ iat: 'Issued (iat)', nbf: 'Not before (nbf)', exp: 'Expires (exp)' }[k],
        `${new Date(p[k] * 1000).toLocaleString()}  (${L.relativeTime(new Date(p[k] * 1000))})`]);
    clear(out,
      h('div', { class: 'row' }, h('span', { class: `pill ${badge[0]}` }, badge[1]),
        p.sub ? h('span', { class: 'muted small' }, `sub: ${p.sub}`) : null, p.iss ? h('span', { class: 'muted small' }, `iss: ${p.iss}`) : null),
      times.length ? kvList(times) : null,
      h('div', { class: 'dt-pair' },
        h('div', { class: 'stack' }, h('b', {}, 'Header'), codeBlock(JSON.stringify(jwt.header, null, 2))),
        h('div', { class: 'stack' }, h('b', {}, 'Payload'), codeBlock(JSON.stringify(p, null, 2), { maxHeight: '420px' }))));
  }
  input.addEventListener('input', debounce(update, 120));
  return {
    el: h('div', { class: 'stack dt-tool' },
      h('div', { class: 'notice warn' }, '⚠ Decoding only — the signature is NOT verified. Anyone can make a token that decodes like this.'),
      input, status, out),
    clear() { input.value = ''; update(); },
  };
}

/* ------------------------------------------------------------------ 5. time */
function timeTool() {
  const t = 'time';
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = (Intl.supportedValuesOf?.('timeZone') || [local, 'UTC']);
  const input = h('input', { type: 'text', class: 'mono', placeholder: '1700000000, 1700000000000 or 2026-11-04T10:00Z' });
  const zone = h('select', { 'aria-label': 'Time zone', onchange: () => { setOpt(t, 'zone', zone.value); update(); } },
    zones.map((z) => h('option', { value: z }, z)));
  zone.value = zones.includes(opt(t, 'zone', '')) ? opt(t, 'zone') : local;
  const status = notice();
  const out = h('div', {});
  const clock = h('div', { class: 'muted small mono', 'aria-live': 'off' });

  function update() {
    show(status, ''); clear(out);
    if (!input.value.trim()) return;
    const r = L.parseTimeInput(input.value);
    if (!r || Number.isNaN(r.date.getTime())) return show(status, 'err', 'Not an epoch number or a date the browser understands.');
    const d = r.date, ms = d.getTime();
    clear(out, kvList([
      ['Read as', r.unit === 'date' ? 'date string' : `epoch ${r.unit}`],
      ['Epoch seconds', String(Math.floor(ms / 1000))],
      ['Epoch milliseconds', String(ms)],
      ['ISO 8601 (UTC)', d.toISOString()],
      ['UTC', d.toUTCString()],
      [`Local (${local})`, d.toString()],
      [zone.value, L.formatInZone(d, zone.value)],
      ['Relative', L.relativeTime(d)],
    ]));
  }
  const tick = () => {
    if (!clock.isConnected) return;
    clock.textContent = `now: ${Math.floor(Date.now() / 1000)} s · ${new Date().toISOString()}`;
  };
  setInterval(tick, 1000); tick();
  input.addEventListener('input', debounce(update, 150));
  return {
    el: h('div', { class: 'stack dt-tool' },
      h('div', { class: 'row dt-nowrap' }, input,
        h('button', { type: 'button', class: 'btn primary', onclick: () => { input.value = String(Math.floor(Date.now() / 1000)); update(); } }, 'Now')),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Also show in'), h('span', { class: 'dt-zone' }, zone)),
      clock, status, out),
    clear() { input.value = ''; update(); },
  };
}

/* ------------------------------------------------------------------ 6. UUID */
function uuidTool() {
  const t = 'uuid';
  const count = h('input', { type: 'number', min: 1, max: 100, value: opt(t, 'count', 5), 'aria-label': 'How many' });
  const upper = checkbox('UPPERCASE', opt(t, 'upper', false), (v) => { setOpt(t, 'upper', v); restyle(); });
  const hyphens = checkbox('Hyphens', opt(t, 'hyphens', true), (v) => { setOpt(t, 'hyphens', v); restyle(); });
  const out = codeBlock('', { maxHeight: '420px' });
  let ids = [];

  const restyle = () => out.set(ids.map((u) => L.formatUuid(u, {
    upper: upper.querySelector('input').checked, hyphens: hyphens.querySelector('input').checked })).join('\n'));
  function generate() {
    const n = Math.min(100, Math.max(1, Math.floor(Number(count.value) || 1)));
    count.value = n; setOpt(t, 'count', n);
    ids = Array.from({ length: n }, () => crypto.randomUUID());
    restyle();
  }
  count.addEventListener('change', generate);
  generate();
  return {
    el: h('div', { class: 'stack dt-tool' },
      h('div', { class: 'row' }, h('label', { class: 'row' }, 'Count', count), upper, hyphens,
        h('button', { type: 'button', class: 'btn primary', onclick: generate }, '↻ Generate v4'),
        copyBtn(() => out.textContent, 'Copy all')),
      out),
    clear() { ids = []; restyle(); },
  };
}

/* ------------------------------------------------------------------ 7. URL */
function urlTool() {
  const t = 'url';
  const input = area({ rows: 4, placeholder: 'Text or a URL…' });
  const out = codeBlock('');
  const status = notice();
  const parsed = h('div', { class: 'stack' });
  let params = [];
  const mode = segmented([{ value: 'encode', label: 'Encode' }, { value: 'decode', label: 'Decode' }, { value: 'parse', label: 'Parse' }],
    opt(t, 'mode', 'encode'), (v) => { setOpt(t, 'mode', v); update(); });
  const scope = segmented([{ value: 'component', label: 'Component', title: 'encodeURIComponent: escapes / ? & = too' },
    { value: 'full', label: 'Full URL', title: 'encodeURI: keeps URL structure' }],
  opt(t, 'scope', 'component'), (v) => { setOpt(t, 'scope', v); update(); });
  const rebuilt = codeBlock('');

  const paramSlot = h('div', {});
  const rebuild = () => { try { rebuilt.set(L.rebuildUrl(input.value, params)); } catch { rebuilt.set(''); } };

  function renderParams() {
    const edit = (p, i) => (e) => { p[i] = e.target.value; rebuild(); };
    const rows = params.map((p, i) => h('tr', {},
      h('td', {}, h('input', { type: 'text', class: 'mono', value: p[0], 'aria-label': `Key ${i + 1}`, oninput: edit(p, 0) })),
      h('td', {}, h('input', { type: 'text', class: 'mono', value: p[1], 'aria-label': `Value ${i + 1}`, oninput: edit(p, 1) })),
      h('td', {}, h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Remove ${p[0] || 'parameter'}`,
        onclick: () => { params.splice(i, 1); renderParams(); } }, '✕'))));
    const add = () => { params.push(['', '']); renderParams(); paramSlot.querySelector('tbody tr:last-child input')?.focus(); };
    rebuild();
    clear(paramSlot,
      h('div', { class: 'row' }, h('b', {}, `Query parameters (${params.length})`), h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', class: 'btn sm', onclick: add }, '+ Add')),
      params.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-params' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value (decoded)'), h('th', {}, ''))), h('tbody', {}, rows))) : null,
      h('b', {}, 'Rebuilt URL'), rebuilt);
  }

  function update() {
    const isParse = mode.value === 'parse';
    scope.hidden = isParse; out.hidden = isParse; parsed.hidden = !isParse;
    show(status, ''); out.set(''); clear(parsed);
    const v = input.value;
    if (!v) return;
    const full = scope.value === 'full';
    try {
      if (mode.value === 'encode') return out.set(full ? encodeURI(v) : encodeURIComponent(v));
      if (mode.value === 'decode') return out.set(full ? decodeURI(v.trim()) : decodeURIComponent(v.trim().replace(/\+/g, ' ')));
      const u = L.parseUrl(v);
      params = u.params;
      clear(parsed, kvList([['Protocol', u.protocol], ['Host', u.host], ['Port', u.port], ['Path', u.path], ['Fragment', u.hash], ['Origin', u.origin]]
        .concat(u.username ? [['User', u.username]] : [])), paramSlot);
      renderParams();
    } catch (e) {
      show(status, 'err', isParse && e instanceof TypeError ? 'Not a full URL (needs a scheme, e.g. https://…).' : e.message);
    }
  }
  input.addEventListener('input', debounce(update, 150));
  return {
    el: h('div', { class: 'stack dt-tool' }, h('div', { class: 'row' }, mode, scope), input, status, out, parsed),
    clear() { input.value = ''; update(); },
  };
}

/* ------------------------------------------------------------------ 8. regex */
const REGEX_TEXT_CAP = 100_000;
const REGEX_TIMEOUT_MS = 1500;

function regexTool() {
  const t = 'regex';
  const pattern = h('input', { type: 'text', class: 'mono', placeholder: '(\\w+)@(?<domain>[\\w.]+)', 'aria-label': 'Pattern' });
  const replacement = h('input', { type: 'text', class: 'mono', placeholder: 'Replacement, e.g. $1 at $<domain>', 'aria-label': 'Replacement' });
  const text = area({ rows: 8, placeholder: 'Test text…' });
  const status = notice();
  const preview = h('pre', { class: 'dt-hl mono', 'aria-label': 'Matches highlighted' });
  const list = h('div', {});
  const replaced = codeBlock('');
  const flags = new Set(opt(t, 'flags', ['g']));
  let worker = null, timer = null;

  const flagChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Flags' }, [
    ['g', 'global'], ['i', 'ignore case'], ['m', 'multiline ^ $'], ['s', 'dot matches newline'], ['u', 'unicode'],
  ].map(([f, title]) => {
    const chip = h('button', { type: 'button', class: `chip mono ${flags.has(f) ? 'on' : ''}`, title, 'aria-pressed': String(flags.has(f)),
      onclick: () => {
        flags.has(f) ? flags.delete(f) : flags.add(f);
        chip.classList.toggle('on', flags.has(f)); chip.setAttribute('aria-pressed', String(flags.has(f)));
        setOpt(t, 'flags', [...flags]); run();
      } }, f);
    return chip;
  }));

  function stop() { worker?.terminate(); worker = null; clearTimeout(timer); }

  function run() {
    stop();
    show(status, ''); clear(preview); clear(list); replaced.set(''); replaced.hidden = !replacement.value;
    if (!pattern.value) { preview.textContent = text.value.slice(0, REGEX_TEXT_CAP); return; }
    const flagStr = 'gimsu'.split('').filter((f) => flags.has(f)).join('');
    const sample = text.value.slice(0, REGEX_TEXT_CAP);
    const capped = text.value.length > REGEX_TEXT_CAP;
    worker = new Worker(new URL('./devtools/regex-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => { stop(); render(data, sample, capped); };
    worker.onerror = (e) => { stop(); show(status, 'err', e.message); };
    timer = setTimeout(() => {
      stop();
      show(status, 'err', `Stopped after ${REGEX_TIMEOUT_MS / 1000} s — the pattern likely backtracks catastrophically (e.g. (a+)+). Simplify it or test less text.`);
    }, REGEX_TIMEOUT_MS);
    worker.postMessage({ pattern: pattern.value, flags: flagStr, text: sample, replacement: replacement.value ? replacement.value : null });
  }

  function render(data, sample, capped) {
    if (data.error) return show(status, 'err', data.error);
    const { matches } = data;
    const notes = [`${matches.length}${data.truncated ? '+' : ''} match${matches.length === 1 ? '' : 'es'}`];
    if (capped) notes.push(` · only the first ${fmt.int(REGEX_TEXT_CAP)} characters are tested`);
    show(status, matches.length ? 'ok' : 'warn', ...notes);

    const parts = [];
    let at = 0;
    matches.forEach((m, i) => {
      if (m.index > at) parts.push(sample.slice(at, m.index));
      parts.push(h('mark', { class: `dt-mark ${i % 2 ? 'alt' : ''}`, title: `#${i + 1} at ${m.index}` }, m.text || '​'));
      at = Math.max(at, m.end);
    });
    parts.push(sample.slice(at));
    clear(preview, parts);

    if (matches.length) {
      const groupCount = Math.max(...matches.map((m) => m.groups.length));
      const names = Object.keys(matches.find((m) => m.named)?.named || {});
      clear(list, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Index'), h('th', {}, 'Match'),
          Array.from({ length: groupCount }, (_, g) => h('th', {}, `$${g + 1}`)), names.map((n) => h('th', {}, `<${n}>`)))),
        h('tbody', {}, matches.slice(0, 500).map((m, i) => h('tr', {},
          h('td', {}, i + 1), h('td', { class: 'mono' }, `${m.index}–${m.end}`), h('td', { class: 'mono' }, m.text),
          Array.from({ length: groupCount }, (_, g) => h('td', { class: 'mono' }, m.groups[g] ?? '')),
          names.map((n) => h('td', { class: 'mono' }, m.named?.[n] ?? ''))))))));
    }
    if (data.replaced !== null) replaced.set(data.replaced);
  }

  const live = debounce(run, 200);
  for (const el of [pattern, replacement, text]) el.addEventListener('input', live);
  return {
    el: h('div', { class: 'stack dt-tool' },
      h('div', { class: 'row' }, h('div', { class: 'row dt-nowrap dt-grow' },
        h('span', { class: 'mono muted' }, '/'), pattern, h('span', { class: 'mono muted' }, '/')), flagChips),
      text, status, h('b', {}, 'Highlighted'), preview, list,
      labelled('Replace preview', replacement, h('span', { class: 'hint' }, '$1, $<name>, $& work')), replaced),
    clear() { pattern.value = ''; replacement.value = ''; text.value = ''; run(); },
  };
}

/* ------------------------------------------------------------------ 9. hash */
function hashTool() {
  const input = area({ rows: 6, placeholder: 'Text to hash (UTF-8)…' });
  const expected = h('input', { type: 'text', class: 'mono', placeholder: 'Optional: paste an expected hash to compare', 'aria-label': 'Expected hash' });
  const status = notice();
  const out = h('div', {});
  let file = null, seq = 0;

  async function update() {
    const mine = ++seq;
    show(status, '');
    if (!file && !input.value) return clear(out);
    const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(input.value);
    const hashes = await Promise.all(L.HASHES.map(async (a) => [a, L.toHex(await crypto.subtle.digest(a, bytes))]));
    if (mine !== seq) return;  // a newer input arrived while hashing
    if (file) show(status, 'ok', `${file.name} · ${fmt.bytes(bytes.length)}`);
    const want = expected.value.trim().toLowerCase();
    clear(out, kvList(hashes));
    if (want) {
      const hit = hashes.find(([, hex]) => hex === want);
      out.append(h('div', { class: `notice ${hit ? 'ok' : 'err'}` }, hit ? `✓ Matches ${hit[0]}` : '✗ No algorithm matches the expected hash'));
    }
  }
  input.addEventListener('input', debounce(() => { file = null; update(); }, 200));
  expected.addEventListener('input', debounce(update, 200));
  return {
    el: h('div', { class: 'stack dt-tool' }, input,
      dropZone('📄 Drop a file here (or click) to hash it', (f) => { file = f; input.value = ''; update(); }),
      expected, status, out,
      h('p', { class: 'muted small' }, 'MD5 is not available in the browser’s WebCrypto API; use `md5sum file` in a terminal.')),
    clear() { input.value = ''; expected.value = ''; file = null; update(); },
  };
}

/* ------------------------------------------------------------------ 10. text */
function textTool() {
  const t = 'text';
  const input = area({ rows: 10, placeholder: 'Text or a list of identifiers…' });
  const stats = h('div', { class: 'stats' });
  const out = codeBlock('', { maxHeight: '420px' });
  const ops = [
    ...Object.entries(L.CASES).map(([k, c]) => ({ value: k, label: c.label })),
    { value: 'lower', label: 'lower' }, { value: 'upper', label: 'UPPER' },
    ...Object.entries(L.LINE_OPS).map(([k, c]) => ({ value: k, label: c.label })),
  ];
  const op = segmented(ops, opt(t, 'op', 'camel'), (v) => { setOpt(t, 'op', v); update(); });

  function update() {
    const c = L.textCounts(input.value);
    clear(stats, [['chars', c.chars], ['words', c.words], ['lines', c.lines], ['bytes (UTF-8)', c.bytes]]
      .map(([k, v]) => h('span', {}, h('b', {}, fmt.int(v)), ` ${k}`)));
    out.set(!input.value ? '' : L.LINE_OPS[op.value] ? L.applyLineOp(input.value, op.value) : L.convertCase(input.value, op.value));
  }
  input.addEventListener('input', debounce(update, 120));
  update();
  return {
    el: h('div', { class: 'stack dt-tool' }, input, stats, op, out,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn sm', onclick: () => {
        input.value = out.textContent; update(); toast('Output moved to the input', 'ok');
      } }, '↑ Use output as input'))),
    clear() { input.value = ''; update(); },
  };
}
