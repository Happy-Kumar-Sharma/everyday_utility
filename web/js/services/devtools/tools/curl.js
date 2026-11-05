// curl converter: curl → fetch / requests / httpx / axios / HTTPie / normalized curl, and fetch(...) → curl.

import { checkbox, codeBlock, segmented } from '../../../core/components.js';
import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { area, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './curl.logic.js';

const T = 'curl';

export default function build() {
  loadCss('/static/css/devtools-web.css');
  const input = area({ rows: 9, placeholder: "curl 'https://api.example.com/items' -H 'authorization: Bearer …' --data-raw '{\"a\":1}'\n\n(DevTools → Network → right-click → Copy as cURL (bash) or (cmd))" });
  const fetchInput = area({ rows: 9, placeholder: 'fetch("https://api.example.com/items", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify({ a: 1 }),\n});' });
  const status = notice();
  const secretNotice = notice();
  const warnList = h('ul', { class: 'dt-curl-warnings', hidden: true });
  const out = codeBlock('', { maxHeight: '460px' });
  const summary = h('div', { class: 'row dt-curl-summary' });

  let mode = opt(T, 'mode', 'curl');
  let target = opt(T, 'target', 'fetch');
  if (!L.TARGETS.some(([k]) => k === target)) target = 'fetch';
  let redactOn = opt(T, 'redact', false);

  const modeSeg = segmented([{ value: 'curl', label: 'curl → code' }, { value: 'fetch', label: 'fetch() → curl' }], mode,
    (v) => { mode = v; setOpt(T, 'mode', v); update(); });
  const targetSeg = segmented(L.TARGETS.map(([value, label]) => ({ value, label })), target,
    (v) => { target = v; setOpt(T, 'target', v); update(); });
  targetSeg.setAttribute('aria-label', 'Output language');
  const redactBox = checkbox('Redact secrets', redactOn, (v) => { redactOn = v; setOpt(T, 'redact', v); update(); },
    'Replace Authorization / Cookie / API-key values and -u passwords with placeholders in every output');
  const curlField = labelled('curl command', input);
  const fetchField = labelled('fetch(…) call', fetchInput);

  function listItems(items, kind) {
    return items.map((t) => h('li', {}, h('span', { class: `pill ${kind}` }, kind === 'warn' ? 'warning' : 'note'), ' ', t));
  }

  function reset() {
    out.set(''); show(status, ''); show(secretNotice, ''); clear(summary); clear(warnList); warnList.hidden = true;
  }

  function update() {
    const isCurl = mode === 'curl';
    curlField.hidden = !isCurl; targetSeg.hidden = !isCurl; redactBox.hidden = !isCurl; fetchField.hidden = isCurl;
    reset();
    try {
      if (isCurl) {
        if (!input.value.trim()) return;
        const r = L.convertCurl(input.value, { redactSecrets: redactOn });
        out.set(r.outputs[target]);
        const { req } = r;
        clear(summary,
          h('span', { class: 'pill run mono' }, req.method),
          h('span', { class: 'mono small dt-curl-url' }, redactOn ? L.redact(req).url : req.url),
          h('span', { class: 'muted small' }, `${req.headers.length} header${req.headers.length === 1 ? '' : 's'}`),
          req.bodyKind !== 'none' ? h('span', { class: 'pill' }, `body: ${req.bodyKind}`) : null,
          req.insecure ? h('span', { class: 'pill warn' }, 'TLS verify off (-k)') : null,
          req.follow ? h('span', { class: 'pill' }, 'follows redirects') : null);
        if (r.secrets.length) {
          show(secretNotice, redactOn ? 'ok' : 'warn', redactOn
            ? `Secrets replaced with placeholders: ${r.secrets.join(', ')}.`
            : `This request contains secrets (${r.secrets.join(', ')}). Don't paste the output into tickets or chats — tick "Redact secrets" first.`);
        }
        const items = [...listItems(r.warnings, 'warn'), ...listItems(r.notes, '')];
        warnList.hidden = !items.length; clear(warnList, items);
        show(status, r.warnings.length ? 'warn' : 'ok', r.warnings.length
          ? `Converted with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'} — see below.`
          : '✓ Parsed');
      } else {
        if (!fetchInput.value.trim()) return;
        const r = L.fetchToCurl(fetchInput.value);
        out.set(r.curl);
        warnList.hidden = !r.notes.length; clear(warnList, listItems(r.notes, ''));
        const secrets = L.secretsIn(r.req);
        if (secrets.length) show(secretNotice, 'warn', `Contains secrets (${secrets.join(', ')}) — be careful where you paste it.`);
        show(status, 'ok', '✓ Converted');
      }
    } catch (e) {
      out.set('');
      show(status, 'err', `✗ ${e.message}`);
    }
  }

  const live = debounce(update, 200);
  input.addEventListener('input', live);
  fetchInput.addEventListener('input', live);
  update();

  return {
    el: h('div', { class: 'stack dt-tool dt-curl' },
      h('div', { class: 'row' }, modeSeg, redactBox),
      curlField, fetchField, status, secretNotice, summary, targetSeg, out, warnList),
    clear() { input.value = ''; fetchInput.value = ''; update(); },
    focus() { (mode === 'curl' ? input : fetchInput).focus(); },
  };
}
