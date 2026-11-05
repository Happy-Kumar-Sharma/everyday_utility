// 🛡️ chmod calculator: permission grid ↔ octal ↔ symbolic ↔ chmod commands, ls -l parsing, umask, presets.

import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { copyBtn, labelled, notice, show } from '../ui.js';
import * as C from './chmod.logic.js';

const DEFAULT = 0o644;

export default function build() {
  loadCss('/static/css/devtools-secrets.css');
  let mode = DEFAULT;
  let isDir = false;
  let target = 'file';

  const status = notice();
  const text = (label, placeholder) => h('input', { type: 'text', class: 'mono', spellcheck: false, autocomplete: 'off', placeholder, 'aria-label': label });
  const octal = text('Octal mode', '755 or 2775');
  const symbolic = text('Symbolic mode', 'rwxr-x--- or drwxr-sr-x');
  const cmdNum = text('Numeric chmod command', 'chmod 755 file');
  const cmdSym = text('Symbolic chmod command', 'chmod u=rwx,g=rx,o= file');
  const targetInput = text('Target path', 'file');
  targetInput.value = target;
  const dirBox = h('input', { type: 'checkbox', onchange: () => { isDir = dirBox.checked; render(); } });
  const explain = h('ul', { class: 'dt-chmod-explain small' });

  // ---------------------------------------------------------------- the grid
  const boxes = [];
  const grid = h('table', { class: 'data dt-chmod-grid' },
    h('caption', { class: 'muted small' }, 'Permissions'),
    h('thead', {}, h('tr', {}, h('th', {}, ''), C.PERMS.map((p) => h('th', { scope: 'col' }, `${p.label} (${p.bit})`)),
      h('th', { scope: 'col' }, 'Special'))),
    h('tbody', {}, C.WHO.map((w) => h('tr', {},
      h('th', { scope: 'row' }, `${w.label} (${w.key})`),
      C.PERMS.map((p) => {
        const bit = p.bit << w.shift;
        const input = h('input', { type: 'checkbox', 'aria-label': `${w.label} ${p.label.toLowerCase()}`, onchange: () => { mode = input.checked ? mode | bit : mode & ~bit; render(); } });
        boxes.push([input, bit]);
        return h('td', {}, h('label', { class: 'check dt-chmod-cell' }, input));
      }),
      h('td', {}, (() => {
        const sp = C.SPECIAL.find((s) => s.bit === w.special);
        const input = h('input', { type: 'checkbox', 'aria-label': sp.key, onchange: () => { mode = input.checked ? mode | sp.bit : mode & ~sp.bit; render(); } });
        boxes.push([input, sp.bit]);
        return h('label', { class: 'check', title: sp.help }, input, sp.key);
      })())))));

  // ---------------------------------------------------------------- render all views except the one being typed in
  function render(from) {
    for (const [input, bit] of boxes) input.checked = Boolean(mode & bit);
    if (from !== 'octal') octal.value = C.toOctal(mode);
    if (from !== 'symbolic') symbolic.value = (isDir ? 'd' : '-') + C.toSymbolic(mode);
    if (from !== 'cmdNum') cmdNum.value = C.chmodNumeric(mode, target || 'file');
    if (from !== 'cmdSym') cmdSym.value = C.chmodSymbolic(mode, target || 'file');
    dirBox.checked = isDir;
    clear(explain, C.describe(mode).map((l) => h('li', { class: /^Warning/.test(l) ? 'dt-chmod-warn' : '' }, l)));
    if (!from) show(status, '');
  }

  const parsers = {
    octal: () => { mode = C.parseOctal(octal.value); },
    symbolic: () => { const r = C.parseSymbolic(symbolic.value); mode = r.mode; if (r.type) isDir = r.type === 'd'; },
    // relative clauses (g+w) apply to the mode as it was when editing started, not once per keystroke
    cmdNum: () => { mode = C.parseChmodCommand(cmdNum.value, base, { isDir }); },
    cmdSym: () => { mode = C.parseChmodCommand(cmdSym.value, base, { isDir }); },
  };
  let base = mode;
  const fields = { octal, symbolic, cmdNum, cmdSym };
  for (const [key, input] of Object.entries(fields)) {
    input.addEventListener('input', debounce(() => {
      if (!input.value.trim()) return show(status, '');
      try { parsers[key](); show(status, ''); render(key); } catch (e) { show(status, 'err', e.message); }
    }, 200));
    input.addEventListener('focus', () => { base = mode; });
    input.addEventListener('blur', () => { if (status.hidden) render(); });  // normalise what was typed
  }
  targetInput.addEventListener('input', debounce(() => { target = targetInput.value.trim(); render(); }, 150));

  // ---------------------------------------------------------------- umask
  const umaskInput = text('umask', '022');
  umaskInput.value = '022';
  const umaskOut = h('div', { class: 'stack' });
  function renderUmask() {
    try {
      const u = C.umask(umaskInput.value);
      const row = (label, m, dir) => h('div', { class: 'row dt-chmod-umask-row' },
        h('span', { class: 'dt-chmod-umask-label' }, label), h('code', { class: 'mono' }, C.toOctal(m)),
        h('code', { class: 'mono' }, (dir ? 'd' : '-') + C.toSymbolic(m)),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { mode = m; isDir = dir; render(); } }, 'Load above'));
      clear(umaskOut, row('New files (666 & ~umask)', u.file, false), row('New directories (777 & ~umask)', u.dir, true));
    } catch (e) { clear(umaskOut, h('div', { class: 'notice err' }, e.message)); }
  }
  umaskInput.addEventListener('input', debounce(renderUmask, 150));

  // ---------------------------------------------------------------- presets
  const presets = h('div', { class: 'dt-chmod-presets' }, C.PRESETS.map((p) => h('button', {
    type: 'button', class: 'dt-chmod-preset', onclick: () => { mode = p.mode; isDir = /directory/i.test(p.title); render(); },
  }, h('span', { class: 'row' }, h('code', { class: 'mono' }, C.toOctal(p.mode)), h('b', {}, p.title)),
  h('span', { class: 'muted small' }, p.help))));

  render();
  renderUmask();
  return {
    el: h('div', { class: 'stack dt-tool dt-chmod' },
      h('div', { class: 'table-wrap' }, grid),
      h('div', { class: 'dt-pair' },
        labelled('Octal', octal, copyBtn(() => octal.value)),
        labelled('Symbolic / ls -l', symbolic, copyBtn(() => symbolic.value))),
      h('div', { class: 'dt-pair' },
        labelled('chmod (numeric)', cmdNum, copyBtn(() => cmdNum.value)),
        labelled('chmod (symbolic)', cmdSym, copyBtn(() => cmdSym.value))),
      h('div', { class: 'row' }, h('label', { class: 'row' }, 'Target', targetInput),
        h('label', { class: 'check', title: 'Shows d in the symbolic form and makes X add execute' }, dirBox, 'Directory')),
      status,
      explain,
      h('p', { class: 'muted small' }, 'Every field is editable. Symbolic commands may be relative (g+w, o-rwx, a+X) and apply to the current mode; ls -l output like drwxrwsr-t is accepted.'),
      h('h3', { class: 'dt-h' }, 'umask'),
      h('div', { class: 'row dt-nowrap' }, h('span', {}, 'umask'), umaskInput),
      umaskOut,
      h('h3', { class: 'dt-h' }, 'Common modes'),
      presets),
    clear() {
      mode = DEFAULT; isDir = false; target = 'file'; targetInput.value = 'file'; umaskInput.value = '022';
      render(); renderUmask();
    },
    focus() { octal.focus(); },
  };
}
