// 🔍 Unicode inspector — reveals invisible / look-alike characters, line endings and BOMs, and cleans them up.
// Runs entirely in the browser (unicode.logic.js); nothing is stored.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, debounce, fmt, h, loadCss } from '../../../core/dom.js';
import { area, copyBtn, kvList, labelled, notice, opt, setOpt, show } from '../ui.js';
import { analyze, applyClean, RENDER_CAP, summarize } from './unicode.logic.js';

const T = 'unicode';

const CATEGORY_LABEL = {
  letter: 'Letter', mark: 'Combining mark', number: 'Number', space: 'Space / separator', control: 'Control', format: 'Format (invisible)',
  punct: 'Punctuation', symbol: 'Symbol', emoji: 'Emoji', surrogate: 'Lone surrogate', private: 'Private use', unassigned: 'Unassigned', other: 'Other',
};

const STEPS = [
  ['bom', 'Strip BOM', 'Remove a U+FEFF byte order mark at the start'],
  ['zw', 'Remove zero-width', 'ZWSP, ZWNJ, ZWJ (kept inside emoji), word joiner, soft hyphen, BOM anywhere'],
  ['bidi', 'Remove bidi controls', 'LRM/RLM/ALM and the embedding/override/isolate controls (U+202A–202E, U+2066–2069)'],
  ['nbsp', 'NBSP → space', 'No-break, narrow no-break, thin, figure and other odd spaces become a normal space'],
  ['eol', 'Normalize line endings', 'Convert every CRLF / CR / LF to the chosen ending'],
  ['normalize', 'Unicode normalization', 'Compose or decompose accents (NFC/NFD) or also fold compatibility forms (NFKC/NFKD)'],
  ['homoglyphs', 'Latin look-alikes', 'Cyrillic/Greek letters inside Latin words become the Latin letter they imitate'],
  ['fold', 'ASCII-fold', 'é → e, ß → ss, “smart quotes” → "plain", — → -'],
];

function chipClass(c) {
  const f = c.flags;
  if (f.includes('bidi-control') || c.cps.some((x) => x.category === 'surrogate')) return 'err';
  if (c.invisible || f.includes('homoglyph') || f.includes('bom')) return 'warn';
  if (c.crlf || c.text === '\r') return 'eol';
  if (f.includes('non-ascii')) return 'uni';
  return '';
}

const pill = (kind, text, title) => h('span', { class: `pill ${kind}`, title }, text);

function summaryPills(s) {
  const eolKind = s.lineEndings === 'mixed' ? 'warn' : '';
  const eolText = s.lineEndings === 'none' ? 'No line breaks'
    : s.lineEndings === 'mixed' ? `Mixed line endings (LF ${s.lf} · CRLF ${s.crlf} · CR ${s.cr})` : `${s.lineEndings} line endings`;
  return [
    pill(eolKind, eolText),
    s.bom ? pill('warn', 'BOM at start', 'U+FEFF byte order mark') : pill('ok', 'No BOM'),
    pill(s.invisible ? 'warn' : 'ok', `${fmt.int(s.invisible)} invisible`),
    s.trojan ? pill('err', `${s.trojan} bidi control${s.trojan > 1 ? 's' : ''} (Trojan Source)`, 'Text may display in a different order than it is stored') : null,
    s.homoglyphs ? pill('warn', `${s.homoglyphs} look-alike letter${s.homoglyphs > 1 ? 's' : ''}`) : null,
    s.mixedScripts.words.length ? pill('warn', `Mixed scripts: ${s.mixedScripts.words.length} word${s.mixedScripts.words.length > 1 ? 's' : ''}`) : null,
    s.loneSurrogates ? pill('err', `${s.loneSurrogates} lone surrogate${s.loneSurrogates > 1 ? 's' : ''}`) : null,
    s.lineSeparators ? pill('warn', `${s.lineSeparators} U+2028/2029`, 'Unicode line/paragraph separators break JS string literals in older engines') : null,
    pill(s.nonAscii ? '' : 'ok', `${fmt.int(s.nonAscii)} non-ASCII`),
    pill('', `${fmt.int(s.codePoints)} code points · ${fmt.int(s.utf8Bytes)} UTF-8 bytes · ${fmt.int(s.utf16Units)} UTF-16 units`),
  ];
}

function detailRows(c) {
  return c.cps.flatMap((x, i) => {
    const units = x.ch.length === 2 ? [x.ch.charCodeAt(0), x.ch.charCodeAt(1)] : [x.ch.charCodeAt(0)];
    const rows = [
      [`${c.cps.length > 1 ? `#${i + 1} ` : ''}Code point`, x.hex],
      ['Name', x.name || (x.category === 'emoji' ? 'emoji (name not bundled)' : '—')],
      ['Category', CATEGORY_LABEL[x.category] + (x.script ? ` · ${x.script} script` : '')],
      ['UTF-8', x.utf8 ?? 'not encodable (lone surrogate)'],
      ['UTF-16', units.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join(' ')],
      ['JS / JSON escape', x.cp > 0xFFFF ? `\\u{${x.cp.toString(16).toUpperCase()}}` : `\\u${x.cp.toString(16).toUpperCase().padStart(4, '0')}`],
      ['HTML entity', `&#x${x.cp.toString(16).toUpperCase()};`],
    ];
    if (x.looksLike) rows.push(['Looks like', `Latin “${x.looksLike}” (U+${x.looksLike.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`]);
    return rows;
  });
}

export default function build() {
  loadCss('/static/css/devtools-formats.css');
  let result = null;
  let selected = 0;
  let cleaned = '';

  const input = area({ rows: 6, placeholder: 'Paste text to inspect — e.g. a config value that “looks right” but fails…', 'aria-label': 'Text to inspect' });
  const status = notice();
  const pills = h('div', { class: 'row dt-uni-pills', 'aria-live': 'polite' });
  const chips = h('div', { class: 'dt-uni-chips', role: 'listbox', 'aria-label': 'Characters (arrow keys move, Enter shows details)' });
  const detail = h('div', { class: 'dt-uni-detail' });
  const filter = segmented([{ value: 'all', label: 'All' }, { value: 'special', label: 'Invisible & special' }, { value: 'nonascii', label: 'Non-ASCII' }],
    opt(T, 'filter', 'all'), (v) => { setOpt(T, 'filter', v); renderChips(); });

  /* ---------- clean-up */
  const steps = new Set(opt(T, 'steps', ['bom', 'zw', 'bidi']));
  const eol = segmented([{ value: 'LF', label: 'LF' }, { value: 'CRLF', label: 'CRLF' }], opt(T, 'eol', 'LF'), (v) => { setOpt(T, 'eol', v); updateClean(); });
  const form = segmented(['NFC', 'NFD', 'NFKC', 'NFKD'].map((f) => ({ value: f, label: f })), opt(T, 'form', 'NFC'), (v) => { setOpt(T, 'form', v); updateClean(); });
  const stepBoxes = h('div', { class: 'dt-uni-steps' }, STEPS.map(([key, label, title]) => h('div', { class: 'row dt-uni-step' },
    checkbox(label, steps.has(key), (on) => { on ? steps.add(key) : steps.delete(key); setOpt(T, 'steps', [...steps]); updateClean(); }, title),
    key === 'eol' ? eol : key === 'normalize' ? form : null)));
  const cleanOut = area({ rows: 5, readOnly: true, 'aria-label': 'Cleaned text', placeholder: 'Cleaned text appears here' });
  const cleanInfo = h('div', { class: 'row dt-uni-pills' });

  function updateClean() {
    try {
      const text = input.value;
      if (!text) { cleaned = ''; cleanOut.value = ''; clear(cleanInfo); return; }
      cleaned = applyClean(text, steps, { eol: eol.value, form: form.value });
      cleanOut.value = cleaned;
      const s = summarize(cleaned);
      clear(cleanInfo, cleaned === text ? pill('', 'No changes') : pill('ok', `Changed: ${fmt.int(text.length)} → ${fmt.int(cleaned.length)} UTF-16 units`),
        pill(s.invisible ? 'warn' : 'ok', `${fmt.int(s.invisible)} invisible left`),
        pill(s.lineEndings === 'mixed' ? 'warn' : '', s.lineEndings === 'none' ? 'No line breaks' : `${s.lineEndings} line endings`),
        s.bom ? pill('warn', 'BOM still present') : null);
    } catch (e) {
      cleaned = '';
      show(status, 'err', `✗ Clean-up failed: ${e.message}`);
    }
  }

  /* ---------- characters */
  const visible = () => {
    if (!result) return [];
    const all = result.chars.map((c, i) => [c, i]);
    if (filter.value === 'special') return all.filter(([c]) => c.invisible || c.flags.some((f) => f !== 'non-ascii') || c.crlf || c.text === '\r');
    if (filter.value === 'nonascii') return all.filter(([c]) => c.flags.includes('non-ascii'));
    return all;
  };

  function renderChips() {
    const list = visible();
    if (!list.some(([, i]) => i === selected)) selected = list[0]?.[1] ?? 0;
    clear(chips, list.length ? list.map(([c, i]) => h('button', {
      type: 'button', role: 'option', class: `dt-uni-chip ${chipClass(c)}`, tabindex: i === selected ? 0 : -1,
      'aria-selected': String(i === selected), dataset: { i: String(i) },
      'aria-label': `${c.cps.map((x) => x.hex + (x.name ? ` ${x.name}` : '')).join(' + ')}`,
      title: c.cps.map((x) => `${x.hex}${x.name ? ` ${x.name}` : ''}`).join(' + '),
    }, h('span', { class: 'dt-uni-glyph', 'aria-hidden': 'true' }, c.display),
    h('span', { class: 'dt-uni-cp mono', 'aria-hidden': 'true' }, c.cps.length > 1 ? `${c.cps[0].hex}+${c.cps.length - 1}` : c.cps[0].hex)))
      : h('p', { class: 'muted small' }, result?.chars.length ? 'No characters match this filter.' : ''));
    renderDetail();
  }

  function renderDetail() {
    const c = result?.chars[selected];
    if (!c) { clear(detail); return; }
    clear(detail, h('div', { class: 'row' }, h('b', {}, `Character ${fmt.int(selected + 1)}`),
      h('span', { class: 'muted small' }, `offset ${fmt.int(c.index)} (UTF-16)`),
      c.cps.length > 1 ? h('span', { class: 'pill' }, `grapheme of ${c.cps.length} code points`) : null),
    kvList(detailRows(c)));
  }

  function select(i, focus = false) {
    selected = i;
    for (const b of chips.querySelectorAll('.dt-uni-chip')) {
      const on = Number(b.dataset.i) === i;
      b.tabIndex = on ? 0 : -1;
      b.setAttribute('aria-selected', String(on));
      if (on && focus) b.focus();
    }
    renderDetail();
  }

  chips.addEventListener('click', (e) => {
    const b = e.target.closest('.dt-uni-chip');
    if (b) select(Number(b.dataset.i));
  });
  chips.addEventListener('keydown', (e) => {
    const buttons = [...chips.querySelectorAll('.dt-uni-chip')];
    const at = buttons.findIndex((b) => Number(b.dataset.i) === selected);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(buttons.length - 1, at + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next === null || !buttons[next]) return;
    e.preventDefault();
    select(Number(buttons[next].dataset.i), true);
  });

  function update() {
    try {
      const text = input.value;
      if (!text) { result = null; clear(pills); clear(chips); clear(detail); show(status, ''); updateClean(); return; }
      result = analyze(text, RENDER_CAP);
      const s = result.summary;
      clear(pills, summaryPills(s));
      const notes = [];
      if (result.truncated) notes.push(`Showing the first ${fmt.int(RENDER_CAP)} of ${fmt.int(result.graphemes)} characters; the summary and clean-up cover the whole text.`);
      if (s.trojan) notes.push('Bidi override/isolate controls can make code or text display in a different order than it runs (“Trojan Source”).');
      if (s.mixedScripts.words.length) notes.push(`Words mixing Latin with Cyrillic/Greek letters: ${s.mixedScripts.words.slice(0, 8).map((w) => `“${w.word}”`).join(', ')}${s.mixedScripts.words.length > 8 ? '…' : ''}`);
      if (notes.length) show(status, s.trojan ? 'err' : 'warn', notes.join(' ')); else show(status, '');
      if (selected >= result.chars.length) selected = 0;
      renderChips();
      updateClean();
    } catch (e) {
      result = null;
      show(status, 'err', `✗ Could not inspect this text: ${e.message}`);
    }
  }

  input.addEventListener('input', debounce(update, 200));
  update();

  return {
    el: h('div', { class: 'stack dt-tool dt-uni' },
      labelled('Text', input),
      pills, status,
      h('div', { class: 'row' }, h('b', {}, 'Characters'), filter),
      chips, detail,
      h('h3', { class: 'dt-uni-h' }, 'Clean up'),
      stepBoxes,
      h('div', { class: 'field' }, h('span', { class: 'row' }, 'Cleaned text', h('span', { class: 'dt-fmt-spacer' }),
        copyBtn(() => cleaned, 'Copy cleaned'),
        h('button', { type: 'button', class: 'btn sm', title: 'Inspect the cleaned text', onclick: () => { if (cleaned) { input.value = cleaned; update(); } } }, 'Use as input')),
      cleanOut),
      cleanInfo),
    clear() { input.value = ''; selected = 0; update(); },
    focus() { input.focus(); },
  };
}
