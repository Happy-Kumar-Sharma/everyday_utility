// Tiny DOM toolkit: element builder, toasts, clipboard, modal, local storage helpers.

/**
 * h('button', {class: 'btn', onclick: fn}, 'Label', child, ...)
 * props: class, style (object or string), dataset, on<event>, any attribute; boolean false/null skips it.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'value') value = v;  // set after children, so <select> options exist
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;  // value, checked, disabled, ...
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3000);
}

export const toastError = (e) => toast(e?.message || String(e), 'err');

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs a secure context; 127.0.0.1 is one, this is a fallback for odd setups
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(label, 'ok');
}

export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a modal; content is built by build(close). Resolves with whatever close(value) gets. */
export function modal(title, build, { drawer = false } = {}) {
  return new Promise((resolve) => {
    const close = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const body = h('div', { class: 'card-body' });
    const box = h('div', { class: `card ${drawer ? 'drawer' : 'modal'}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'card-head' }, h('h2', {}, title), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', onclick: () => close(undefined), 'aria-label': 'Close' }, '✕')),
      body);
    const overlay = h('div', { class: `overlay ${drawer ? 'drawer-overlay' : ''}`, onmousedown: (e) => { if (e.target === overlay) close(undefined); } }, box);
    append(body, [build(close)]);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    box.querySelector('input, select, textarea, .btn.primary')?.focus();
  });
}

export function confirmDialog(title, message, { okLabel = 'Run', danger = false } = {}) {
  return modal(title, (close) => h('div', { class: 'stack' },
    typeof message === 'string' ? h('p', { style: { margin: 0 } }, message) : message,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel)),
  )).then(Boolean);
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const fmt = {
  int: (n) => (n ?? 0).toLocaleString(),
  bytes(n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts * 1000).toLocaleString();
  },
  duration(s) {
    s = Math.round(s || 0);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}h ${mm}m` : mm ? `${mm}m ${ss}s` : `${ss}s`;
  },
};
