// 📐 YAML ⇄ JSON — converted by this app's own server (PyYAML safe loader/dumper, app/services/devtools/yaml_api.py).
// Nothing is stored; the text only travels from this page to the local server and back.

import { post } from '../../../core/api.js';
import { checkbox, segmented } from '../../../core/components.js';
import { clear, debounce, downloadText, fmt, h, loadCss } from '../../../core/dom.js';
import { highlight } from '../../../core/highlight.js';
import { area, copyBtn, dropZone, labelled, notice, opt, setOpt, show } from '../ui.js';
import { lineColToOffset, YAML_SAMPLE } from './yaml.logic.js';

const T = 'yaml';
const MAX_BYTES = 2 * 1024 * 1024;
const HIGHLIGHT_LIMIT = 200_000;  // bigger outputs are shown as plain text (highlighting is per-token DOM)

/** Selects line:column in the textarea and scrolls it into view. */
function gotoLine(ta, line, col) {
  const pos = lineColToOffset(ta.value, line, col);
  ta.focus();
  ta.setSelectionRange(pos, Math.min(pos + 1, ta.value.length));
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
}

export default function build() {
  loadCss('/static/css/devtools-formats.css');
  let output = '';
  let seq = 0;

  const input = area({ rows: 16, placeholder: 'Paste YAML (Helm values, k8s manifests, compose files…)', 'aria-label': 'Input' });
  const out = h('pre', { class: 'code dt-fmt-out', tabindex: 0, 'aria-label': 'Output', 'aria-live': 'off' });
  const status = notice();
  const inLabel = h('span', {}, 'YAML');
  const outLabel = h('span', {}, 'JSON');

  const dir = segmented([{ value: 'y2j', label: 'YAML → JSON' }, { value: 'j2y', label: 'JSON → YAML' }],
    opt(T, 'dir', 'y2j'), (v) => { setOpt(T, 'dir', v); sync(); run(); });
  const jsonIndent = segmented([{ value: 2, label: '2 spaces' }, { value: 4, label: '4 spaces' }, { value: 0, label: 'Minified' }],
    opt(T, 'jsonIndent', 2), (v) => { setOpt(T, 'jsonIndent', v); run(); });
  const yamlIndent = segmented([{ value: 2, label: '2 spaces' }, { value: 4, label: '4 spaces' }],
    opt(T, 'yamlIndent', 2), (v) => { setOpt(T, 'yamlIndent', v); run(); });
  const option = (key, label, title, fallback = false) => {
    const el = checkbox(label, opt(T, key, fallback), (v) => { setOpt(T, key, v); run(); }, title);
    el.get = () => el.querySelector('input').checked;
    el.set = (v) => { el.querySelector('input').checked = v; setOpt(T, key, v); };
    return el;
  };
  const multi = option('multi', 'Multiple documents (---)', 'Every --- separated document becomes one item of a JSON array');
  const sortKeys = option('sort', 'Sort keys', 'Sort object keys alphabetically');
  const flow = option('flow', 'Flow style', 'Inline {a: 1, b: [x, y]} style instead of block style');
  const splitDocs = option('splitDocs', 'Array → documents', 'A top-level JSON array becomes one YAML document per item');

  const y2jOpts = h('div', { class: 'row' }, jsonIndent, multi);
  const j2yOpts = h('div', { class: 'row' }, yamlIndent, flow, splitDocs);

  function sync() {
    const y2j = dir.value === 'y2j';
    inLabel.textContent = y2j ? 'YAML' : 'JSON';
    outLabel.textContent = y2j ? 'JSON' : 'YAML';
    input.placeholder = y2j ? 'Paste YAML (Helm values, k8s manifests, compose files…)' : 'Paste JSON…';
    y2jOpts.hidden = !y2j; j2yOpts.hidden = y2j;
  }

  function setOutput(text, type) {
    output = text;
    if (!text) { clear(out); return; }
    if (text.length > HIGHLIGHT_LIMIT) out.textContent = text;
    else clear(out, highlight(text, type));
  }

  function errorNotice(err, lead) {
    const where = err.line ? `Line ${err.line}, column ${err.column ?? 1} — ` : '';
    show(status, 'err', `✗ ${lead}${where}${err.message}`,
      err.line ? h('button', { type: 'button', class: 'btn sm dt-fmt-goto', onclick: () => gotoLine(input, err.line, err.column ?? 1) }, 'Go to line') : null,
      /expected a single document/.test(err.message || '') && !multi.get()
        ? h('button', { type: 'button', class: 'btn sm dt-fmt-goto', onclick: () => { multi.set(true); run(); } }, 'Read all documents') : null);
  }

  async function run() {
    const mine = ++seq;
    const text = input.value;
    if (!text.trim()) { show(status, ''); setOutput(''); return; }
    const bytes = new Blob([text]).size;
    if (bytes > MAX_BYTES) { show(status, 'err', `✗ The input is ${fmt.bytes(bytes)}; the limit is 2 MB.`); setOutput(''); return; }
    const y2j = dir.value === 'y2j';
    try {
      const res = y2j
        ? await post('/api/devtools/yaml/to-json', { text, multi: multi.get(), indent: Number(jsonIndent.value), sort_keys: sortKeys.get() })
        : await post('/api/devtools/yaml/from-json', { text, indent: Number(yamlIndent.value), sort_keys: sortKeys.get(), flow: flow.get(), multi: splitDocs.get() });
      if (mine !== seq) return;  // a newer edit is on its way
      if (!res.ok) { errorNotice(res.error, y2j ? 'Invalid YAML: ' : 'Invalid JSON: '); setOutput(''); return; }
      setOutput(y2j ? res.json : res.yaml, y2j ? 'json' : 'yaml');
      const what = y2j ? `✓ Valid YAML${res.count > 1 || multi.get() ? ` · ${res.count} document${res.count === 1 ? '' : 's'}` : ''}` : '✓ Valid JSON';
      if (res.notes?.length) show(status, 'warn', `${what} — note: ${res.notes.join('; ')}.`);
      else show(status, 'ok', what);
    } catch (e) {
      if (mine !== seq) return;
      setOutput('');
      show(status, 'err', `✗ ${e.status === 413 ? 'Too large: ' : 'Conversion failed: '}${e.message}`);
    }
  }

  const live = debounce(run, 300);
  input.addEventListener('input', live);
  sortKeys.addEventListener('change', () => run());

  function swap() {
    if (!output) return;
    input.value = output;
    dir.value = dir.value === 'y2j' ? 'j2y' : 'y2j';
    setOpt(T, 'dir', dir.value);
    sync(); run();
  }

  async function loadFile(file) {
    try {
      if (file.size > MAX_BYTES) { show(status, 'err', `✗ ${file.name} is ${fmt.bytes(file.size)}; the limit is 2 MB.`); return; }
      input.value = await file.text();
      const isJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(input.value);
      dir.value = isJson ? 'j2y' : 'y2j'; setOpt(T, 'dir', dir.value);
      sync(); run();
    } catch (e) { show(status, 'err', `✗ Could not read ${file.name}: ${e.message}`); }
  }

  sync();
  const outActions = h('div', { class: 'row dt-fmt-actions' },
    copyBtn(() => output),
    h('button', { type: 'button', class: 'btn sm', onclick: () => output && downloadText(output, dir.value === 'y2j' ? 'converted.json' : 'converted.yaml') }, '⬇ Download'),
    h('button', { type: 'button', class: 'btn sm', title: 'Use the output as the new input and flip the direction', onclick: swap }, '⇄ Swap'));
  const el = h('div', { class: 'stack dt-tool dt-fmt' },
    h('div', { class: 'row' }, dir, sortKeys,
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { input.value = YAML_SAMPLE; multi.set(true); dir.value = 'y2j'; setOpt(T, 'dir', 'y2j'); sync(); run(); } }, 'Sample')),
    y2jOpts, j2yOpts,
    h('div', { class: 'dt-pair dt-fmt-pair' },
      labelled(inLabel, input),
      h('div', { class: 'field dt-fmt-field' }, h('span', { class: 'row' }, outLabel, h('span', { class: 'dt-fmt-spacer' }), outActions), out)),
    status,
    dropZone('📄 Drop a .yaml / .yml / .json file here (or click)', loadFile),
    h('p', { class: 'muted small dt-fmt-note' }, '🔒 Processed locally by this app’s server (PyYAML safe loader — tags can’t run code; alias bombs and inputs over 2 MB are refused). Nothing is stored.'));
  return {
    el,
    clear() { seq += 1; input.value = ''; show(status, ''); setOutput(''); },
    focus() { input.focus(); },
  };
}
