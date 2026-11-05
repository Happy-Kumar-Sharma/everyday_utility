// 🎨 Color: parse any CSS color → hex / rgb / hsl / hwb / oklch, WCAG contrast, tints/shades, harmonies, eyedropper.

import { segmented } from '../../../core/components.js';
import { clear, copyText, debounce, h, loadCss } from '../../../core/dom.js';
import { kvList, notice, opt, setOpt, show } from '../ui.js';
import * as C from './color.logic.js';

const T = 'color';
const solidHex = (c) => C.toHex(c, { alpha: false });

/** Clickable swatch that copies its hex. */
function swatch(c, label) {
  const hex = C.toHex(c);
  const el = h('button', {
    type: 'button', class: 'dt-color-swatch', title: `${label ? `${label} · ` : ''}${hex} — click to copy`,
    'aria-label': `Copy ${hex}${label ? ` (${label})` : ''}`,
    style: { color: C.readableOn(C.over(c, { r: 255, g: 255, b: 255, a: 1 })) },
    onclick: () => copyText(hex, `Copied ${hex}`),
  }, h('span', { class: 'mono' }, hex));
  el.style.setProperty('--sw', hex);
  return el;
}

export default function build() {
  loadCss('/static/css/devtools-secrets.css');
  const status = notice();
  const bgStatus = notice();

  const text = h('input', { type: 'text', class: 'mono', spellcheck: false, autocomplete: 'off', 'aria-label': 'Color',
    placeholder: '#4f46e5, rgb(79 70 229), hsl(243 75% 59%), rebeccapurple…' });
  const picker = h('input', { type: 'color', value: '#4f46e5', 'aria-label': 'Pick a color', class: 'dt-color-native' });
  const bgText = h('input', { type: 'text', class: 'mono', spellcheck: false, autocomplete: 'off', 'aria-label': 'Background color', value: opt(T, 'bg', '#ffffff') });
  const bgPicker = h('input', { type: 'color', value: '#ffffff', 'aria-label': 'Pick the background color', class: 'dt-color-native' });
  const varName = h('input', { type: 'text', class: 'mono dt-color-var', value: opt(T, 'varName', 'color-primary'), spellcheck: false, 'aria-label': 'CSS variable name' });
  const preview = h('div', { class: 'dt-color-preview', role: 'img', 'aria-label': 'Color preview' });
  const values = h('div', {});
  const contrastOut = h('div', { class: 'stack' });
  const palettes = h('div', { class: 'stack' });

  const eyedrop = 'EyeDropper' in window && h('button', {
    type: 'button', class: 'btn', title: 'Pick a color from anywhere on screen',
    onclick: async () => {
      try {
        const r = await new window.EyeDropper().open();
        text.value = r.sRGBHex; update();
      } catch (e) { if (e?.name !== 'AbortError') show(status, 'err', `Eyedropper failed: ${e.message || e}`); }
    },
  }, '💧 Eyedropper');

  const bgPreset = segmented([{ value: '#ffffff', label: 'White' }, { value: '#000000', label: 'Black' }, { value: 'swap', label: '⇄ Swap' }],
    null, (v) => {
      if (v === 'swap') { const fg = text.value; text.value = bgText.value; bgText.value = fg || '#ffffff'; } else bgText.value = v;
      bgPreset.value = null; update();
    });
  bgPreset.setAttribute('aria-label', 'Background presets');

  let current = null;

  function renderContrast(fg) {
    clear(contrastOut);
    let bg;
    try { bg = C.parseColor(bgText.value) || { r: 255, g: 255, b: 255, a: 1 }; show(bgStatus, ''); } catch (e) { show(bgStatus, 'err', e.message); return; }
    if (/^#[0-9a-f]{6}$/i.test(solidHex(bg))) bgPicker.value = solidHex(bg);
    const ratio = C.contrast(fg, bg);
    const lv = C.wcag(ratio);
    const badge = (ok, label) => h('span', { class: `pill ${ok ? 'ok' : 'err'}` }, `${ok ? '✓' : '✗'} ${label}`);
    const bgCss = C.toRgb(bg), fgCss = C.toRgb(fg);
    contrastOut.append(
      h('div', { class: 'row' }, h('b', { class: 'dt-color-ratio mono' }, C.fmtRatio(ratio)),
        badge(lv.aaNormal, 'AA normal'), badge(lv.aaLarge, 'AA large'), badge(lv.aaaNormal, 'AAA normal'), badge(lv.aaaLarge, 'AAA large')),
      h('div', { class: 'dt-color-sample', style: { background: bgCss, color: fgCss } },
        h('p', { class: 'dt-color-sample-normal' }, 'Normal text — the quick brown fox jumps over the lazy dog.'),
        h('p', { class: 'dt-color-sample-large' }, 'Large text (24px, or 18.66px bold)')),
      h('p', { class: 'muted small' }, 'WCAG 2.x: AA needs 4.5:1 for normal text and 3:1 for large text; AAA needs 7:1 and 4.5:1. Translucent colors are flattened first (background over white).'));
  }

  function renderPalettes(c) {
    const { tints, shades } = C.tintsAndShades(c);
    clear(palettes,
      h('h4', { class: 'dt-h' }, 'Tints (towards white)'),
      h('div', { class: 'dt-color-row' }, tints.map((t) => swatch(t, `${t.weight}% white`))),
      h('h4', { class: 'dt-h' }, 'Shades (towards black)'),
      h('div', { class: 'dt-color-row' }, shades.map((t) => swatch(t, `${t.weight}% black`))),
      h('h4', { class: 'dt-h' }, 'Harmonies'),
      C.harmonies(c).map((hm) => h('div', { class: 'dt-color-harmony' }, h('span', { class: 'muted small' }, hm.name),
        h('div', { class: 'dt-color-row' }, hm.colors.map((x) => swatch(x, hm.name))))),
      h('p', { class: 'muted small' }, 'Click a swatch to copy its hex.'));
  }

  function update() {
    try {
      const c = text.value.trim() ? C.parseColor(text.value) : null;
      current = c;
      if (!c) { show(status, ''); clear(values); clear(contrastOut); clear(palettes); preview.style.removeProperty('--sw'); return; }
      show(status, '');
      picker.value = solidHex(c);
      preview.style.setProperty('--sw', C.toRgb(c));
      const name = C.nameOf(c);
      clear(values, kvList([
        ...(name ? [['CSS name', name]] : []),
        ['HEX', C.toHex(c)], ['RGB', C.toRgb(c)], ['HSL', C.toHsl(c)], ['HWB', C.toHwb(c)], ['OKLCH', C.toOklch(c)],
        ['CSS variable', C.cssVar(c, varName.value)],
      ]));
      renderContrast(c);
      renderPalettes(c);
    } catch (e) { show(status, 'err', e.message); }
  }

  const live = debounce(update, 120);
  text.addEventListener('input', live);
  picker.addEventListener('input', () => { text.value = current && current.a < 1 ? C.toHex({ ...C.parseColor(picker.value), a: current.a }) : picker.value; live(); });
  bgText.addEventListener('input', debounce(() => { setOpt(T, 'bg', bgText.value.trim()); if (current) renderContrast(current); }, 120));
  bgPicker.addEventListener('input', () => { bgText.value = bgPicker.value; setOpt(T, 'bg', bgPicker.value); if (current) renderContrast(current); });
  varName.addEventListener('input', debounce(() => { setOpt(T, 'varName', varName.value); update(); }, 200));

  text.value = '#4f46e5';
  update();
  return {
    el: h('div', { class: 'stack dt-tool dt-color' },
      h('div', { class: 'dt-color-top' }, preview,
        h('div', { class: 'stack dt-grow' },
          h('div', { class: 'field' }, h('span', {}, 'Color'), h('div', { class: 'row dt-nowrap' }, picker, text, eyedrop || null)),
          status,
          h('label', { class: 'row small' }, 'Variable name', varName))),
      values,
      h('h3', { class: 'dt-h' }, 'Contrast'),
      h('div', { class: 'row' }, h('span', {}, 'Against'), h('div', { class: 'row dt-nowrap dt-grow' }, bgPicker, bgText), bgPreset),
      bgStatus, contrastOut,
      palettes),
    clear() { text.value = ''; picker.value = '#000000'; update(); },
    focus() { text.focus(); },
  };
}
