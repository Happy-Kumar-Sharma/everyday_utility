// Shared building blocks for Dev Tools: every tool module (built-in or in ./tools/) uses these, so all tools
// look and behave the same. Tool inputs are never persisted — only options via opt()/setOpt().

import { clear, copyText, h, store } from '../../core/dom.js';

const opts = store.get('devtools.opts', {});
/** Remembered per-tool option (never tool input: inputs may hold tokens). */
export const opt = (tool, key, fallback) => opts[tool]?.[key] ?? fallback;
export const setOpt = (tool, key, value) => { (opts[tool] ||= {})[key] = value; store.set('devtools.opts', opts); };

export const area = (props = {}) => h('textarea', { class: 'dt-input mono', rows: 8, spellcheck: false, ...props });
export const labelled = (label, el, extra) => h('label', { class: 'field' }, h('span', { class: 'row' }, label, extra), el);
export const notice = () => h('div', { class: 'notice', hidden: true, role: 'status' });
/** show(noticeEl, 'ok'|'warn'|'err'|'', ...children) — no children hides it. */
export const show = (el, kind, ...text) => { el.hidden = !text.length; el.className = `notice ${kind}`; clear(el, ...text); };
export const copyBtn = (getText, label = 'Copy') => h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(getText()) }, label);

/** Click-or-drop file target; onFile(file) gets a File. */
export function dropZone(label, onFile) {
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
export function kvList(rows) {
  return h('div', { class: 'dt-kv' }, rows.map(([k, v]) => h('div', { class: 'dt-kv-row' },
    h('span', { class: 'muted' }, k), h('span', { class: 'mono dt-kv-val' }, v),
    v ? h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Copy ${k}`, onclick: () => copyText(v) }, '⧉') : h('span'))));
}
