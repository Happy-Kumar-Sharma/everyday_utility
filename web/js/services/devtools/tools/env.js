// 🧾 .env converter: read .env / export lines / JSON / docker -e / compose / k8s env, write any of them.
// Values are masked on screen unless "Reveal" is on; Copy always copies the real values. Nothing is stored.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, h, loadCss } from '../../../core/dom.js';
import { area, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as E from './env.logic.js';

const T = 'env';
const FORMAT_NAME = Object.fromEntries(E.INPUT_FORMATS);
const FLAG_PILL = {
  secret: ['warn', '🔒 secret', 'Key name looks like a secret (PASSWORD / SECRET / TOKEN / KEY)'],
  dup: ['warn', 'duplicate', 'Defined more than once; the last value wins'],
  invalid: ['err', 'invalid name', 'Variable names are letters, digits and _, not starting with a digit'],
  empty: ['', 'empty', 'Empty value'],
  spaces: ['', 'spaces', 'Value contains whitespace; outputs quote it'],
};

export default function build() {
  loadCss('/static/css/devtools-timecron.css');

  const formatSelect = (label) => h('select', { 'aria-label': label }, E.INPUT_FORMATS.map(([v, l]) => h('option', { value: v }, l)));
  const input = area({ rows: 10, placeholder: 'Paste a .env file, export lines, JSON, docker run -e …, compose environment: or k8s env: …' });
  const inFormat = formatSelect('Input format');
  const detected = h('span', { class: 'pill', hidden: true });
  const second = area({ rows: 8, 'aria-label': 'Env to compare with', placeholder: 'Paste the other env to compare with (any supported format)…' });
  const secondFormat = formatSelect('Compare input format');

  const outFormat = segmented(E.OUTPUT_FORMATS.map(([value, label]) => ({ value, label })), opt(T, 'out', 'dotenv'),
    (v) => { setOpt(T, 'out', v); update(); });
  const sort = checkbox('Sort keys', opt(T, 'sort', false), (v) => { setOpt(T, 'sort', v); update(); });
  let revealed = false;
  const reveal = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', onclick: () => {
    revealed = !revealed; reveal.setAttribute('aria-pressed', String(revealed));
    reveal.textContent = revealed ? '🙈 Hide values' : '👁 Reveal values'; update();
  } }, '👁 Reveal values');
  const compare = checkbox('Compare with another env', false, () => update());
  const isOn = (cb) => cb.querySelector('input').checked;

  const status = notice();
  const issuesBox = h('div', {});
  const keysBox = h('div', {});
  const pre = h('pre', { class: 'code dt-env-out', tabindex: 0, 'aria-label': 'Converted output' });
  let realText = '';
  const outWrap = h('div', { class: 'code-wrap' }, pre,
    h('button', { type: 'button', class: 'btn sm copy-btn', onclick: () => copyText(realText, 'Copied (real values)') }, 'Copy'));
  const secondField = h('div', { class: 'stack' }, h('div', { class: 'row' }, h('b', {}, 'Compare with'), h('span', { class: 'dt-zone' }, secondFormat)), second);
  const diffStatus = notice();
  const diffBox = h('div', {});

  const shown = (v) => (revealed ? v : E.mask(v));

  function renderIssues(issues) {
    if (!issues.length) return clear(issuesBox);
    const kinds = { err: 'err', warn: 'warn', info: '' };
    clear(issuesBox, h('details', { class: 'dt-tc-section', open: issues.some((i) => i.kind !== 'info') },
      h('summary', {}, `${issues.length} note${issues.length === 1 ? '' : 's'}`),
      h('ul', { class: 'dt-env-issues' }, issues.map((i) => h('li', {},
        h('span', { class: `pill ${kinds[i.kind]}` }, i.kind === 'err' ? 'error' : i.kind === 'warn' ? 'warning' : 'info'), ' ', i.message)))));
  }

  function renderKeys(r) {
    if (!r.vars.length) return clear(keysBox);
    clear(keysBox, h('details', { class: 'dt-tc-section' }, h('summary', {}, `Keys (${r.vars.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'), h('th', {}, 'Length'), h('th', {}, 'Flags'))),
        h('tbody', {}, r.vars.map((v) => h('tr', {},
          h('td', { class: 'mono' }, v.key), h('td', { class: 'mono dt-env-val' }, shown(v.value)), h('td', {}, [...v.value].length),
          h('td', {}, [...(r.flags[v.key] || [])].map((f) => h('span', { class: `pill ${FLAG_PILL[f][0]}`, title: FLAG_PILL[f][2] }, FLAG_PILL[f][1]))))))))));
  }

  function renderDiff(a) {
    secondField.hidden = !isOn(compare);
    diffBox.hidden = !isOn(compare);
    if (!isOn(compare)) { show(diffStatus, ''); return clear(diffBox); }
    if (!second.value.trim() || !a) { show(diffStatus, ''); return clear(diffBox); }
    const b = E.parseEnv(second.value, secondFormat.value);
    const d = E.diffEnv(a.vars, b.vars);
    const total = d.added.length + d.removed.length + d.changed.length;
    show(diffStatus, total ? 'warn' : 'ok', total
      ? `${d.added.length} added · ${d.removed.length} removed · ${d.changed.length} changed · ${d.same} unchanged (right side read as ${FORMAT_NAME[b.format]})`
      : `✓ Same ${d.same} variable${d.same === 1 ? '' : 's'} and values`);
    const rows = [
      ...d.added.map((x) => ['added', 'ok', x.key, '', shown(x.to)]),
      ...d.removed.map((x) => ['removed', 'err', x.key, shown(x.from), '']),
      ...d.changed.map((x) => ['changed', 'warn', x.key, shown(x.from), shown(x.to)]),
    ];
    clear(diffBox, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Change'), h('th', {}, 'Key'), h('th', {}, 'Before'), h('th', {}, 'After'))),
      h('tbody', {}, rows.map(([op, cls, k, from, to]) => h('tr', {},
        h('td', {}, h('span', { class: `pill ${cls}` }, op)), h('td', { class: 'mono' }, k),
        h('td', { class: 'mono dt-env-val' }, from), h('td', { class: 'mono dt-env-val' }, to))))))
      : null);
  }

  function update() {
    let r = null;
    try {
      if (!input.value.trim()) {
        show(status, ''); clear(issuesBox); clear(keysBox); pre.textContent = ''; realText = ''; detected.hidden = true;
        outWrap.hidden = true;
        renderDiff(null);
        return;
      }
      r = E.parseEnv(input.value, inFormat.value);
      detected.hidden = inFormat.value !== 'auto';
      detected.textContent = `detected: ${FORMAT_NAME[r.format]}`;
      const opts = { sort: isOn(sort) };
      realText = E.formatEnv(r.vars, outFormat.value, opts);
      pre.textContent = E.formatEnv(r.vars, outFormat.value, { ...opts, masked: !revealed });
      outWrap.hidden = !r.vars.length;
      const secrets = r.vars.filter((v) => v.secret).length;
      const errs = r.issues.filter((i) => i.kind === 'err').length;
      show(status, r.vars.length ? (errs ? 'warn' : 'ok') : 'err',
        r.vars.length
          ? `${r.vars.length} variable${r.vars.length === 1 ? '' : 's'} read as ${FORMAT_NAME[r.format]}${secrets ? ` · 🔒 ${secrets} look${secrets === 1 ? 's' : ''} secret` : ''}${revealed ? '' : ' · values masked on screen (Copy uses real values)'}`
          : `No variables found (read as ${FORMAT_NAME[r.format]}). Pick the input format if detection guessed wrong.`);
      renderIssues(r.issues);
      renderKeys(r);
    } catch (e) {
      show(status, 'err', `Could not convert: ${e.message}`);
      pre.textContent = ''; realText = ''; outWrap.hidden = true;
    }
    try { renderDiff(r); } catch (e) { show(diffStatus, 'err', `Could not compare: ${e.message}`); }
  }

  const live = debounce(update, 200);
  input.addEventListener('input', live); second.addEventListener('input', live);
  inFormat.addEventListener('change', update); secondFormat.addEventListener('change', update);
  update();

  return {
    el: h('div', { class: 'stack dt-tool dt-env' },
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Input'), h('span', { class: 'dt-zone' }, inFormat), detected),
      h('div', { class: 'dt-pair' }, labelled('Env input', input), secondField),
      status, issuesBox,
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Output'), outFormat),
      h('div', { class: 'row' }, sort, reveal, compare),
      outWrap, keysBox, diffStatus, diffBox),
    focus() { input.focus(); },
    clear() {
      input.value = ''; second.value = '';
      if (revealed) reveal.click(); else update();
    },
  };
}
