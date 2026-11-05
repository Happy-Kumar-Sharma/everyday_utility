// ▦ QR code: from-scratch encoder (qr.logic.js) with a live canvas preview, PNG/SVG download and presets.
// Inputs (text, Wi-Fi password, contact details) are never stored; only options (level, colours, sizes, preset).

import { checkbox, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, h, loadCss, toastError } from '../../../core/dom.js';
import { area, copyBtn, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as Q from './qr.logic.js';

const T = 'qr';
const MAX_CANVAS = 4096;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const intOpt = (input, lo, hi, fallback) => {
  const n = Math.trunc(Number(input.value));
  return Number.isFinite(n) && input.value !== '' ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export default function build() {
  loadCss('/static/css/devtools-generate.css');
  let result = null;  // last successful encode

  /* ---------- payload inputs per preset */
  const text = area({ rows: 4, placeholder: 'Any text…', 'aria-label': 'Text to encode' });
  const url = h('input', { type: 'text', class: 'mono', placeholder: 'https://example.com', 'aria-label': 'URL', autocomplete: 'off' });
  const ssid = h('input', { type: 'text', placeholder: 'Network name', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: 'Password', 'aria-label': 'Wi-Fi password', autocomplete: 'new-password' });
  const security = h('select', {}, [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'None (open)']].map(([v, l]) => h('option', { value: v }, l)));
  security.value = opt(T, 'wifiSecurity', 'WPA');
  const hidden = checkbox('Hidden network', false, () => update());
  const showPass = checkbox('Show', false, (v) => { pass.type = v ? 'text' : 'password'; });
  const vc = Object.fromEntries(['first', 'last', 'org', 'title', 'phone', 'email', 'url'].map((k) => [k, h('input', { type: 'text', autocomplete: 'off' })]));
  const vcLabels = { first: 'First name', last: 'Last name', org: 'Organisation', title: 'Job title', phone: 'Phone', email: 'Email', url: 'Website' };

  const panes = {
    text: h('div', { class: 'stack' }, labelled('Text', text)),
    url: h('div', { class: 'stack' }, labelled('URL', url)),
    wifi: h('div', { class: 'dt-qr-grid' }, labelled('Network name (SSID)', ssid),
      h('div', { class: 'stack dt-qr-pass' }, h('span', { class: 'dt-qr-label' }, 'Password'),
        h('span', { class: 'row dt-nowrap' }, pass, showPass)), labelled('Security', security),
      h('div', { class: 'dt-qr-check' }, hidden),
      h('p', { class: 'muted small dt-qr-full' }, 'The password is only used to draw the code — it is never saved.')),
    vcard: h('div', { class: 'dt-qr-grid' }, Object.entries(vc).map(([k, el]) => labelled(vcLabels[k], el))),
  };
  const preset = segmented([{ value: 'text', label: 'Text' }, { value: 'url', label: 'URL' }, { value: 'wifi', label: 'Wi-Fi' }, { value: 'vcard', label: 'vCard' }],
    opt(T, 'preset', 'text'), (v) => { setOpt(T, 'preset', v); showPane(); update(); focus(); });
  preset.setAttribute('aria-label', 'Content type');
  const paneBox = h('div', {});
  const showPane = () => clear(paneBox, panes[preset.value] || panes.text);

  function payload() {
    switch (preset.value) {
      case 'url': return url.value.trim();
      case 'wifi': return ssid.value ? Q.wifiString({ ssid: ssid.value, password: pass.value, security: security.value, hidden: hidden.querySelector('input').checked }) : '';
      case 'vcard': return Object.values(vc).some((el) => el.value.trim())
        ? Q.vcardString(Object.fromEntries(Object.entries(vc).map(([k, el]) => [k, el.value.trim()]))) : '';
      default: return text.value;
    }
  }

  /* ---------- options */
  const ecl = segmented(['L', 'M', 'Q', 'H'].map((v) => ({ value: v, label: v, title: { L: '~7% recovery', M: '~15% recovery', Q: '~25% recovery', H: '~30% recovery' }[v] })),
    opt(T, 'ecl', 'M'), (v) => { setOpt(T, 'ecl', v); update(); });
  ecl.setAttribute('aria-label', 'Error correction level');
  const quiet = h('input', { type: 'number', min: 0, max: 20, value: opt(T, 'quiet', 4) });
  const scale = h('input', { type: 'number', min: 1, max: 64, value: opt(T, 'scale', 8) });
  const dark = h('input', { type: 'color', value: opt(T, 'dark', '#000000') });
  const light = h('input', { type: 'color', value: opt(T, 'light', '#ffffff') });
  const resetColors = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => {
    dark.value = '#000000'; light.value = '#ffffff'; setOpt(T, 'dark', dark.value); setOpt(T, 'light', light.value); draw();
  } }, 'Reset colours');
  for (const [el, key] of [[quiet, 'quiet'], [scale, 'scale'], [dark, 'dark'], [light, 'light']]) {
    el.addEventListener('input', debounce(() => { setOpt(T, key, el.value); draw(); }, 120));
  }

  /* ---------- output */
  const status = notice();
  const colorNote = notice();
  const info = h('div', { class: 'row dt-qr-info' });
  const canvas = h('canvas', { class: 'dt-qr-canvas', role: 'img', 'aria-label': 'QR code preview' });
  const preview = h('div', { class: 'dt-qr-preview', hidden: true }, canvas);
  const actionBtn = (label, fn) => { const b = h('button', { type: 'button', class: 'btn sm', onclick: () => { try { fn(); } catch (e) { toastError(e); } } }, label); return b; };
  const actions = h('div', { class: 'row', hidden: true },
    actionBtn('⬇ PNG', () => canvas.toBlob((b) => (b ? downloadBlob(b, 'qr-code.png') : toastError(new Error('Could not render the PNG.'))), 'image/png')),
    actionBtn('⬇ SVG', () => downloadBlob(new Blob([svg()], { type: 'image/svg+xml' }), 'qr-code.svg')),
    actionBtn('Copy data URL', () => copyText(canvas.toDataURL('image/png'), 'PNG data URL copied')),
    actionBtn('Copy SVG', () => copyText(svg(), 'SVG copied')),
    copyBtn(() => payload(), 'Copy encoded text'));

  const quietN = () => intOpt(quiet, 0, 20, 4);
  const svg = () => Q.toSvg(result.modules, { quiet: quietN(), scale: intOpt(scale, 1, 64, 8), dark: dark.value, light: light.value, title: 'QR code' });

  function colorCheck() {
    const ratio = Q.contrastRatio(dark.value, light.value);
    const inverted = Q.contrastRatio(dark.value, '#000000') > Q.contrastRatio(light.value, '#000000');
    if (ratio < 3) show(colorNote, 'err', `Contrast ${ratio.toFixed(1)}:1 is too low — most scanners will fail. Aim for 4:1 or more.`);
    else if (inverted) show(colorNote, 'warn', 'The “dark” colour is lighter than the background. Inverted codes do not scan with many readers.');
    else if (ratio < 4) show(colorNote, 'warn', `Contrast ${ratio.toFixed(1)}:1 is marginal; some scanners may struggle.`);
    else show(colorNote, '');
  }

  function draw() {
    colorCheck();
    if (!result) return;
    const q = quietN();
    const n = result.size + q * 2;
    let s = intOpt(scale, 1, 64, 8);
    if (n * s > MAX_CANVAS) s = Math.max(1, Math.floor(MAX_CANVAS / n));
    canvas.width = canvas.height = n * s;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark.value;
    result.modules.forEach((row, y) => row.forEach((on, x) => { if (on) ctx.fillRect((x + q) * s, (y + q) * s, s, s); }));
    canvas.style.width = `${Math.min(n * s, 360)}px`;
    canvas.setAttribute('aria-label', `QR code, version ${result.version}, ${result.size}×${result.size} modules`);
  }

  function update() {
    try {
      const data = payload();
      if (preset.value === 'wifi') setOpt(T, 'wifiSecurity', security.value);
      if (!data) {
        result = null;
        preview.hidden = true; actions.hidden = true; clear(info);
        show(status, preset.value === 'wifi' && !ssid.value && pass.value ? 'warn' : '', ...(preset.value === 'wifi' && !ssid.value && pass.value ? ['Enter the network name (SSID).'] : []));
        return colorCheck();
      }
      result = Q.encodeQr(data, { ecl: ecl.value });
      const pct = Math.round((result.dataBits / result.capacityBits) * 100);
      clear(info,
        h('span', { class: 'pill ok' }, `Version ${result.version}`),
        h('span', { class: 'pill' }, `${result.size}×${result.size} modules`),
        h('span', { class: 'pill' }, `${result.mode} mode`),
        h('span', { class: 'pill' }, `EC ${result.ecl} · mask ${result.mask}`),
        h('span', { class: `pill ${pct > 95 ? 'warn' : ''}`, title: `${result.dataBits} of ${result.capacityBits} data bits` }, `${pct}% of capacity`),
        h('span', { class: 'muted small' }, `${result.count} ${result.mode === 'byte' ? 'bytes' : 'chars'} · max ${Q.maxCapacity(result.mode, result.ecl)} at v40`));
      show(status, '');
      if (preset.value === 'url' && !/^[a-z][a-z0-9+.-]*:/i.test(data)) show(status, 'warn', 'No scheme — phones may treat this as plain text. Add https://');
      preview.hidden = false; actions.hidden = false;
      draw();
    } catch (e) {
      result = null;
      preview.hidden = true; actions.hidden = true; clear(info);
      show(status, 'err', e.message || String(e));
    }
  }

  const live = debounce(update, 150);
  for (const el of [text, url, ssid, pass, ...Object.values(vc)]) el.addEventListener('input', live);
  security.addEventListener('change', update);
  showPane();
  update();

  function focus() {
    ({ text, url, wifi: ssid, vcard: vc.first })[preset.value]?.focus();
  }

  return {
    el: h('div', { class: 'stack dt-tool dt-qr' },
      preset, paneBox,
      h('div', { class: 'row dt-qr-opts' },
        h('span', { class: 'row' }, h('span', { class: 'muted small' }, 'Error correction'), ecl),
        labelled('Quiet zone', quiet), labelled('Module px', scale),
        labelled('Dark', dark), labelled('Light', light), resetColors),
      status, colorNote, info,
      h('div', { class: 'dt-qr-out' }, preview, actions)),
    clear() {
      text.value = ''; url.value = ''; ssid.value = ''; pass.value = ''; pass.type = 'password';
      showPane();
      hidden.querySelector('input').checked = false; showPass.querySelector('input').checked = false;
      for (const el of Object.values(vc)) el.value = '';
      update();
    },
    focus,
  };
}
