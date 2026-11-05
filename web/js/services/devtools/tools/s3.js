// 🪣 S3 path: parse any S3 location (s3://, virtual-hosted / path-style / legacy URLs, ARN, console, presigned) and
// write it every other way. Runs entirely in the page; inputs are never stored, only the mode and default region.

import { segmented } from '../../../core/components.js';
import { clear, copyText, debounce, fmt, h, loadCss } from '../../../core/dom.js';
import { area, kvList, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './s3.logic.js';

/** Caption + control group for segmented controls (a <label> would forward clicks to their first button). */
const group = (label, el, extra) => h('div', { class: 'dt-data-field', role: 'group', 'aria-label': label }, h('span', { class: 'row' }, label, extra), el);

const T = 's3';
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'eu-north-1', 'eu-south-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-east-1',
  'sa-east-1', 'me-south-1', 'af-south-1', 'cn-north-1', 'us-gov-west-1'];
const BULK_COLUMNS = [
  { value: 's3', label: 'S3 URI' }, { value: 'virtual', label: 'Virtual-hosted' }, { value: 'path', label: 'Path-style' },
  { value: 'arn', label: 'ARN' }, { value: 'console', label: 'Console' }, { value: 'bucket', label: 'Bucket' },
  { value: 'key', label: 'Key' }, { value: 'filename', label: 'File name' },
];

function relative(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const text = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

export default function build() {
  loadCss('/static/css/devtools-data.css');
  const single = h('input', { type: 'text', class: 'mono', spellcheck: false, 'aria-label': 'S3 location',
    placeholder: 's3://bucket/key, https://bucket.s3.region.amazonaws.com/key, arn:aws:s3:::bucket/key, console or presigned URL' });
  const bulk = area({ rows: 8, placeholder: 'One S3 location per line…', 'aria-label': 'S3 locations, one per line' });
  const regionList = h('datalist', { id: 'dt-s3-regions' }, REGIONS.map((r) => h('option', { value: r })));
  const region = h('input', { type: 'text', class: 'mono dt-data-region', list: 'dt-s3-regions', value: opt(T, 'region', ''),
    placeholder: 'e.g. us-east-1', 'aria-label': 'Default region', spellcheck: false,
    oninput: () => { setOpt(T, 'region', region.value.trim()); live(); } });
  const status = notice();
  const out = h('div', { class: 'stack' });
  const live = debounce(() => update(), 150);
  const mode = segmented([{ value: 'single', label: 'Single' }, { value: 'bulk', label: 'Bulk' }], opt(T, 'mode', 'single'),
    (v) => { setOpt(T, 'mode', v); update(); });
  const column = segmented(BULK_COLUMNS, opt(T, 'column', 's3'), (v) => { setOpt(T, 'column', v); update(); });
  const singleField = labelled('S3 location', single);
  const bulkField = labelled('S3 locations (one per line)', bulk);
  const defaultRegion = () => region.value.trim();

  function renderSingle() {
    const src = single.value.trim();
    if (!src) { show(status, ''); clear(out); return; }
    const p = L.parseS3(src);
    const parts = L.keyParts(p.key);
    const r = p.region || defaultRegion();
    const pills = [h('span', { class: 'pill' }, p.style),
      p.region ? h('span', { class: 'pill ok' }, `region ${p.region}`)
        : h('span', { class: 'pill warn', title: 'Set a default region above to fill it into the URLs' }, r ? `region ${r} (default)` : 'region unknown')];
    if (p.versionId) pills.push(h('span', { class: 'pill' }, `versionId ${p.versionId}`));
    if (p.presigned) {
      const exp = p.presigned.expiresAt;
      const left = exp == null ? null : exp - Date.now();
      pills.push(h('span', { class: `pill ${left == null ? 'warn' : left > 0 ? 'ok' : 'err'}`, title: exp ? new Date(exp).toISOString() : 'No expiry in the URL' },
        `🔏 presigned ${p.presigned.version} · ${left == null ? 'expiry unknown' : `${left > 0 ? 'expires' : 'expired'} ${relative(left)}`}`));
    }
    const rows = [['Bucket', p.bucket], ['Key', p.key], ['Folder (prefix)', parts.prefix], ['File name', parts.filename],
      ['Extension', parts.extension], ['Region', r]];
    if (p.presigned?.signedAt) rows.push(['Signed at', new Date(p.presigned.signedAt).toISOString()]);
    if (p.presigned?.expiresAt) rows.push(['Expires at', `${new Date(p.presigned.expiresAt).toISOString()}  (${new Date(p.presigned.expiresAt).toLocaleString()})`]);
    if (p.presigned?.seconds) rows.push(['Valid for', `${fmt.int(p.presigned.seconds)} s`]);
    const forms = L.forms(p, { defaultRegion: defaultRegion() });
    clear(out, h('div', { class: 'row' }, pills),
      h('h3', { class: 'dt-data-h' }, 'Parts'), kvList(rows),
      h('h3', { class: 'dt-data-h' }, 'Every form'), kvList(forms.map((f) => [f.label, f.value])),
      !r && h('p', { class: 'muted small' }, 'No region in the input: URLs use the global endpoint. Set a default region to get regional URLs.'));
    if (p.warnings.length) show(status, 'warn', ...p.warnings.map((w) => h('div', {}, w)));
    else show(status, 'ok', '✓ Parsed');
  }

  function renderBulk() {
    const rows = L.parseMany(bulk.value, { defaultRegion: defaultRegion() });
    if (!rows.length) { show(status, ''); clear(out); return; }
    const bad = rows.filter((r) => r.error);
    const col = column.value;
    const label = BULK_COLUMNS.find((c) => c.value === col)?.label || col;
    const values = rows.filter((r) => !r.error).map((r) => r[col] ?? '');
    clear(out,
      h('div', { class: 'row' }, group('Column', column),
        h('button', { type: 'button', class: 'btn sm', disabled: !values.length, onclick: () => copyText(values.join('\n'), `Copied ${values.length} values`) },
          `Copy “${label}” column (${fmt.int(values.length)})`)),
      h('div', { class: 'table-wrap dt-data-bulk' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Bucket'), h('th', {}, 'Key'), h('th', {}, label))),
        h('tbody', {}, rows.map((r, k) => h('tr', {},
          h('td', { class: 'muted' }, k + 1),
          r.error
            ? h('td', { colspan: 3, title: r.input }, h('span', { class: 'pill err' }, 'error'), ' ', r.error, h('span', { class: 'muted mono' }, ` — ${r.input}`))
            : [h('td', { class: 'mono', title: r.bucket }, r.bucket), h('td', { class: 'mono', title: r.key }, r.key),
              h('td', { class: 'mono', title: r[col] }, r[col])]))))));
    if (bad.length) show(status, 'warn', `${bad.length} of ${rows.length} line${rows.length > 1 ? 's' : ''} could not be parsed (left out of the copied column).`);
    else show(status, 'ok', `✓ ${fmt.int(rows.length)} location${rows.length > 1 ? 's' : ''}`);
  }

  function update() {
    const isBulk = mode.value === 'bulk';
    singleField.hidden = isBulk; bulkField.hidden = !isBulk;
    try { if (isBulk) renderBulk(); else renderSingle(); } catch (e) { clear(out); show(status, 'err', `✗ ${e.message}`); }
  }

  single.addEventListener('input', live);
  bulk.addEventListener('input', live);
  update();
  return {
    el: h('div', { class: 'stack dt-tool dt-data' },
      h('div', { class: 'row' }, mode, h('span', { class: 'spacer' }),
        labelled('Default region', region, h('span', { class: 'muted small' }, 'used when the input has none'))),
      regionList, singleField, bulkField, status, out),
    clear() { single.value = ''; bulk.value = ''; update(); },
    focus() { (mode.value === 'bulk' ? bulk : single).focus(); },
  };
}
