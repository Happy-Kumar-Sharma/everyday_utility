// 🔢 Number & unit converter: integer bases (BigInt, exact), data sizes + transfer time, time units.

import { segmented } from '../../../core/components.js';
import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { kvList, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as U from './units.logic.js';

const T = 'units';

const select = (options, value, label) => h('select', { 'aria-label': label, value },
  options.map((o) => h('option', { value: o.key }, o.label ?? o.key)));

/* ------------------------------------------------------------------ bases */
function basesSection() {
  const status = notice();
  const details = h('div', { class: 'stack' });
  const inputs = {};
  for (const b of U.BASES) {
    inputs[b.key] = h('input', { type: 'text', class: 'mono', spellcheck: false, autocomplete: 'off', inputmode: b.key === 'dec' ? 'numeric' : 'text',
      placeholder: { dec: '-42 or 1_000_000', hex: '0xFF or ff', bin: '0b1010', oct: '0o755' }[b.key] });
  }

  function render(value, from) {
    for (const b of U.BASES) if (b.key !== from) inputs[b.key].value = value === null ? '' : U.formatInteger(value, b.radix);
    if (value === null) return clear(details);
    const bl = U.bitLength(value);
    const bytes = U.toBytes(value);
    const widths = [8, 16, 32, 64, 128];
    clear(details,
      kvList([
        ['Bit length', `${bl.unsigned} bits unsigned${value < 0n ? ' (of |n|)' : ''} · ${bl.signed} bits as signed`],
        [`Bytes (big-endian)${value < 0n ? ', two’s complement' : ''}`, U.hexBytes(bytes)],
        [`Bytes (little-endian)${value < 0n ? ', two’s complement' : ''}`, U.hexBytes([...bytes].reverse())],
        ['Hex (grouped)', U.formatInteger(value, 16, { group: 4, sep: '_', prefix: true })],
        ['Binary (grouped)', U.formatInteger(value, 2, { group: 4, sep: ' ' })],
      ]),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-units-tc' },
        h('caption', { class: 'muted small' }, 'Two’s complement — the bit pattern at each width and how it reads back'),
        h('thead', {}, h('tr', {}, ['Width', 'Fits', 'Hex', 'Binary', 'As signed', 'As unsigned'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, widths.map((w) => {
          const t = U.twosComplement(value, w);
          return h('tr', {},
            h('th', { scope: 'row' }, `${w}-bit`),
            h('td', {}, h('span', { class: `pill ${t.fits ? 'ok' : 'warn'}` }, t.fits ? 'yes' : 'overflows')),
            h('td', { class: 'mono' }, t.hex), h('td', { class: 'mono dt-units-bin' }, t.bin),
            h('td', { class: 'mono' }, t.signed.toString()), h('td', { class: 'mono' }, t.unsigned.toString()));
        })))));
  }

  function onInput(from) {
    try {
      const radix = U.BASES.find((b) => b.key === from).radix;
      const r = U.parseInteger(inputs[from].value, radix);
      show(status, '');
      render(r ? r.value : null, from);
    } catch (e) { show(status, 'err', e.message); clear(details); }
  }
  for (const b of U.BASES) inputs[b.key].addEventListener('input', debounce(() => onInput(b.key), 150));

  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'dt-units-grid' }, U.BASES.map((b) => labelled(`${b.label}${b.prefix ? ` (${b.prefix})` : ''}`, inputs[b.key]))),
      h('p', { class: 'muted small' }, 'Type in any field. Prefixes 0x / 0b / 0o, a minus sign, underscores and spaces are accepted; values of any size are exact.'),
      status, details),
    clear() { for (const i of Object.values(inputs)) i.value = ''; show(status, ''); clear(details); },
    focus() { inputs.dec.focus(); },
  };
}

/* ------------------------------------------------------------------ data sizes */
function sizeSection() {
  const status = notice();
  const out = h('div', { class: 'stack' });
  const value = h('input', { type: 'text', class: 'mono', placeholder: 'e.g. 1.5 or 700 MiB', autocomplete: 'off', spellcheck: false, 'aria-label': 'Size' });
  const unit = select(U.SIZE_UNITS, opt(T, 'sizeUnit', 'GB'), 'Size unit');
  const speed = h('input', { type: 'text', class: 'mono', placeholder: '100', value: '', autocomplete: 'off', 'aria-label': 'Speed' });
  const speedUnit = select(U.SPEED_UNITS, opt(T, 'speedUnit', 'Mbps'), 'Speed unit');

  function update() {
    clear(out);
    try {
      const p = U.parseSize(value.value, unit.value);
      if (!p) return show(status, '');
      show(status, '');
      const bytes = U.toBytesCount(p.value, p.unit);
      const rows = U.convertSize(bytes);
      const group = (g, title) => h('div', { class: 'stack' }, h('h4', { class: 'dt-h' }, title),
        kvList(rows.filter((r) => r.group === g || (g === 'decimal' && r.key === 'B')).map((r) => [r.label, r.value])));
      out.append(h('div', { class: 'dt-pair' },
        group('decimal', 'Decimal (SI, ×1000) — disks, network, macOS'),
        group('binary', 'Binary (IEC, ×1024) — RAM, Linux/Windows file sizes'),
        group('bits', 'Bits — line speeds')));
      if (!Number.isInteger(bytes)) out.append(h('p', { class: 'muted small' }, `Not a whole number of bytes (${U.fmtNum(bytes)} B).`));
      const sp = U.parseDecimal(speed.value);
      if (sp !== null) {
        const secs = U.transferSeconds(bytes, sp, speedUnit.value);
        out.append(kvList([['Transfer time', secs >= 1 ? U.humanDuration(Math.round(secs) * 1e9) : `${U.fmtNum(secs * 1000, 4)} ms`], ['Seconds', U.fmtNum(secs)]]));
      }
    } catch (e) { show(status, 'err', e.message); }
  }
  const live = debounce(update, 150);
  value.addEventListener('input', live); speed.addEventListener('input', live);
  unit.addEventListener('change', () => { setOpt(T, 'sizeUnit', unit.value); update(); });
  speedUnit.addEventListener('change', () => { setOpt(T, 'speedUnit', speedUnit.value); update(); });

  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'row dt-nowrap' }, h('span', {}, 'Size'), value, unit),
      h('div', { class: 'row dt-nowrap' }, h('span', {}, 'Transfer at'), speed, speedUnit),
      h('p', { class: 'muted small' }, 'A unit typed after the number (700 MiB, 5 Gb) overrides the menu. b = bits, B = bytes.'),
      status, out),
    clear() { value.value = ''; speed.value = ''; update(); },
    focus() { value.focus(); },
  };
}

/* ------------------------------------------------------------------ time */
function timeSection() {
  const status = notice();
  const out = h('div', { class: 'stack' });
  const value = h('input', { type: 'text', class: 'mono', placeholder: 'e.g. 90 or 1d 2h 3m or 1.5h', autocomplete: 'off', spellcheck: false, 'aria-label': 'Duration' });
  const unit = select(U.TIME_UNITS.map((u) => ({ key: u.key, label: `${u.key} — ${u.label}` })), opt(T, 'timeUnit', 's'), 'Time unit');

  function update() {
    clear(out);
    try {
      const ns = U.parseDuration(value.value, unit.value);
      if (ns === null) return show(status, '');
      show(status, '');
      out.append(kvList([
        ['Human', U.humanDuration(ns)],
        ['Human (with weeks)', U.humanDuration(ns, { weeks: true })],
        ...U.TIME_UNITS.map((u) => [`${u.label} (${u.key})`, U.fmtNum(ns / u.ns)]),
      ]));
    } catch (e) { show(status, 'err', e.message); }
  }
  value.addEventListener('input', debounce(update, 150));
  unit.addEventListener('change', () => { setOpt(T, 'timeUnit', unit.value); update(); });
  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'row dt-nowrap' }, h('span', {}, 'Duration'), value, unit),
      h('p', { class: 'muted small' }, 'A plain number uses the unit on the right; text like 1d 2h 3m, 2 weeks, 1h30m or 250ms is read as is.'),
      status, out),
    clear() { value.value = ''; update(); },
    focus() { value.focus(); },
  };
}

export default function build() {
  loadCss('/static/css/devtools-secrets.css');
  const sections = { bases: basesSection(), size: sizeSection(), time: timeSection() };
  const tabs = segmented([{ value: 'bases', label: 'Number bases' }, { value: 'size', label: 'Data size' }, { value: 'time', label: 'Time' }],
    opt(T, 'section', 'bases'), (v) => { setOpt(T, 'section', v); sync(); sections[v].focus(); });
  tabs.setAttribute('aria-label', 'Converter');
  const sync = () => { for (const [k, s] of Object.entries(sections)) s.el.hidden = k !== tabs.value; };
  sync();
  return {
    el: h('div', { class: 'stack dt-tool dt-units' }, h('div', { class: 'row' }, tabs), Object.values(sections).map((s) => s.el)),
    clear() { for (const s of Object.values(sections)) s.clear(); },
    focus() { sections[tabs.value].focus(); },
  };
}
