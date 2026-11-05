// 🔑 Password generator: random passwords, passphrases, PINs and tokens from crypto.getRandomValues, plus a local
// strength check. Generated values and the checked password are never stored or sent anywhere.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, h, loadCss } from '../../../core/dom.js';
import { labelled, notice, opt, setOpt, show } from '../ui.js';
import * as P from './password.logic.js';

const T = 'password';

/** Strength bar + label for an entropy in bits. */
function meter(bits, extra) {
  const s = P.strength(bits);
  return h('div', { class: 'dt-pw-meter' },
    h('div', { class: `dt-pw-bar lvl${s.level}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 128, 'aria-valuenow': Math.round(bits),
      'aria-label': `Strength: ${s.label}` }, h('div', { style: { width: `${Math.min(100, (bits / 128) * 100)}%` } })),
    h('div', { class: 'row small' }, h('span', { class: `pill ${s.kind}` }, s.label),
      h('span', { class: 'mono' }, `${bits.toFixed(1)} bits`),
      h('span', { class: 'muted' }, `~${P.crackTime(bits)} to guess at 10 billion guesses/s`), extra));
}

const num = (min, max, value, label) => h('input', { type: 'number', min, max, value, 'aria-label': label });

export default function build() {
  loadCss('/static/css/devtools-secrets.css');

  // ---------------------------------------------------------------- options (remembered), never the outputs
  const o = {
    length: opt(T, 'length', 20), lower: opt(T, 'lower', true), upper: opt(T, 'upper', true), digits: opt(T, 'digits', true),
    symbols: opt(T, 'symbols', true), symbolSet: opt(T, 'symbolSet', P.DEFAULT_SYMBOLS), excludeAmbiguous: opt(T, 'excludeAmbiguous', false),
    requireEach: opt(T, 'requireEach', true), words: opt(T, 'words', 5), separator: opt(T, 'separator', '-'),
    capitalize: opt(T, 'capitalize', false), addNumber: opt(T, 'addNumber', false), pinLength: opt(T, 'pinLength', 6),
    bytes: opt(T, 'bytes', 32), format: opt(T, 'format', 'hex'), count: opt(T, 'count', 5),
  };
  const set = (k, v) => { o[k] = v; setOpt(T, k, v); regenerate(); };
  const check = (label, k, title) => checkbox(label, o[k], (v) => set(k, v), title);

  const mode = segmented([
    { value: 'random', label: 'Random' }, { value: 'passphrase', label: 'Passphrase' },
    { value: 'pin', label: 'PIN' }, { value: 'token', label: 'Token' },
  ], opt(T, 'mode', 'random'), (v) => { setOpt(T, 'mode', v); regenerate(); });
  mode.setAttribute('aria-label', 'Generator');

  const numberOpt = (k, limits, label) => {
    const input = num(limits[0], limits[1], o[k], label);
    input.addEventListener('change', () => { const v = P.clampInt(input.value, limits, o[k]); input.value = v; set(k, v); });
    return input;
  };

  const lengthRange = h('input', { type: 'range', min: P.LIMITS.length[0], max: P.LIMITS.length[1], value: o.length, 'aria-label': 'Length (slider)', class: 'dt-pw-range' });
  const lengthNum = numberOpt('length', P.LIMITS.length, 'Length');
  lengthRange.addEventListener('input', () => { lengthNum.value = lengthRange.value; o.length = Number(lengthRange.value); regenerateSoon(); });
  lengthRange.addEventListener('change', () => setOpt(T, 'length', o.length));
  lengthNum.addEventListener('change', () => { lengthRange.value = lengthNum.value; });

  const symbolSet = h('input', { type: 'text', class: 'mono', value: o.symbolSet, spellcheck: false, autocomplete: 'off', 'aria-label': 'Symbols to use' });
  symbolSet.addEventListener('input', debounce(() => set('symbolSet', symbolSet.value), 250));
  const separator = h('input', { type: 'text', class: 'mono dt-pw-sep', value: o.separator, maxlength: 5, spellcheck: false, autocomplete: 'off', 'aria-label': 'Separator' });
  separator.addEventListener('input', debounce(() => set('separator', separator.value), 250));
  const format = segmented([{ value: 'hex', label: 'hex' }, { value: 'base64url', label: 'base64url' }], o.format, (v) => set('format', v));
  format.setAttribute('aria-label', 'Token format');

  const panels = {
    random: h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', {}, 'Length'), lengthRange, lengthNum),
      h('div', { class: 'row' }, check('a–z', 'lower'), check('A–Z', 'upper'), check('0–9', 'digits'), check('Symbols', 'symbols'),
        check('Exclude ambiguous (I l 1 O 0)', 'excludeAmbiguous'), check('At least one of each', 'requireEach',
          'Redraws until every chosen set appears; all valid passwords stay equally likely.')),
      labelled('Symbol set', symbolSet)),
    passphrase: h('div', { class: 'row' }, h('label', { class: 'row' }, 'Words', numberOpt('words', P.LIMITS.words, 'Words')),
      h('label', { class: 'row' }, 'Separator', separator), check('Capitalize', 'capitalize'), check('Add a number', 'addNumber', 'Appends 0–99 to one random word'),
      h('span', { class: 'muted small' }, `${P.WORDS.length.toLocaleString()}-word list · ${Math.log2(P.WORDS.length).toFixed(2)} bits per word`)),
    pin: h('div', { class: 'row' }, h('label', { class: 'row' }, 'Digits', numberOpt('pinLength', P.LIMITS.pin, 'PIN digits'))),
    token: h('div', { class: 'row' }, h('label', { class: 'row' }, 'Bytes', numberOpt('bytes', P.LIMITS.bytes, 'Token bytes')), format),
  };
  const countInput = numberOpt('count', P.LIMITS.count, 'How many');

  const status = notice();
  const strengthEl = h('div', {});
  const list = h('ol', { class: 'dt-pw-list', 'aria-label': 'Generated values', 'aria-live': 'polite' });
  let values = [];

  const settings = () => {
    const m = mode.value;
    if (m === 'pin') return { length: o.pinLength };
    if (m === 'random') return { ...o, length: o.length };
    return o;
  };

  function regenerate() {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== mode.value;
    try {
      const s = settings();
      const bits = P.entropyFor(mode.value, s);
      values = Array.from({ length: o.count }, () => P.generate(mode.value, s));
      show(status, '');
      clear(strengthEl, meter(bits, h('span', { class: 'muted' }, mode.value === 'random' && s.requireEach ? '(from the settings, after requiring each set)' : '(from the settings)')));
    } catch (e) {
      values = [];
      show(status, 'err', e.message);
      clear(strengthEl);
    }
    clear(list, values.map((v, i) => h('li', { class: 'dt-pw-item' },
      h('code', { class: 'mono dt-pw-value' }, v),
      h('button', { type: 'button', class: 'btn sm', 'aria-label': `Copy value ${i + 1}`, onclick: () => copyText(v) }, 'Copy'))));
  }
  const regenerateSoon = debounce(regenerate, 120);

  // ---------------------------------------------------------------- local strength check
  const checkInput = h('input', { type: 'password', class: 'mono', autocomplete: 'off', spellcheck: false, 'aria-label': 'Password to check',
    placeholder: 'Type a password to estimate its strength', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const reveal = checkbox('Show', false, (v) => { checkInput.type = v ? 'text' : 'password'; });
  const checkOut = h('div', { class: 'stack', 'aria-live': 'polite' });
  function runCheck() {
    try {
      const r = P.checkPassword(checkInput.value);
      if (!r) return clear(checkOut);
      const classes = Object.entries(r.classes).filter(([, v]) => v).map(([k]) => k);
      clear(checkOut, meter(r.bits),
        h('div', { class: 'chips' }, h('span', { class: 'chip' }, `${r.length} characters`), classes.map((c) => h('span', { class: 'chip' }, c))),
        r.warnings.length ? h('ul', { class: 'dt-pw-warn small' }, r.warnings.map((w) => h('li', {}, w))) : h('p', { class: 'muted small' }, 'No obvious patterns found.'));
    } catch (e) { clear(checkOut, h('div', { class: 'notice err' }, e.message)); }
  }
  checkInput.addEventListener('input', debounce(runCheck, 150));

  regenerate();
  return {
    el: h('div', { class: 'stack dt-tool dt-pw' },
      h('div', { class: 'row' }, mode),
      ...Object.values(panels),
      h('div', { class: 'row' }, h('label', { class: 'row' }, 'How many', countInput),
        h('button', { type: 'button', class: 'btn primary', onclick: regenerate }, '↻ Generate'),
        h('button', { type: 'button', class: 'btn', onclick: () => values.length && copyText(values.join('\n'), `Copied ${values.length}`) }, 'Copy all')),
      status, strengthEl, list,
      h('section', { class: 'stack dt-pw-check', 'aria-label': 'Check a password' },
        h('h3', { class: 'dt-h' }, 'Check a password'),
        h('div', { class: 'row dt-nowrap' }, checkInput, reveal),
        h('p', { class: 'muted small' }, 'Estimated in this page only — never sent anywhere and never saved. It looks at length, character kinds, repeats, sequences, keyboard walks, years, words and a list of very common passwords.'),
        checkOut)),
    clear() { checkInput.value = ''; checkInput.type = 'password'; reveal.querySelector('input').checked = false; clear(checkOut); values = []; clear(list); },
    focus() { mode.querySelector('button.on')?.focus(); },
  };
}
