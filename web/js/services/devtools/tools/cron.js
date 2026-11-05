// ⏰ Cron helper: explain / validate a 5-field cron expression, list the next runs (local + any IANA zone),
// build one from a small form, and copy a crontab line. Runs entirely in the browser.

import { codeBlock } from '../../../core/components.js';
import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { copyBtn, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as C from './cron.logic.js';

const T = 'cron';

const zones = () => {
  const list = Intl.supportedValuesOf?.('timeZone') || [];
  return list.includes('UTC') ? list : ['UTC', ...list];
};

function relative(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60), hh = Math.floor(m / 60), d = Math.floor(hh / 24);
  if (d) return `in ${d}d ${hh % 24}h`;
  if (hh) return `in ${hh}h ${m % 60}m`;
  return `in ${m}m`;
}

const fmtCache = new Map();
function fmtIn(ms, tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined, weekday: 'short', year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }));
  }
  return fmtCache.get(key).format(new Date(ms));
}

export default function build() {
  loadCss('/static/css/devtools-timecron.css');
  const local = C.localZone();

  /* ---------- expression + presets */
  const input = h('input', { type: 'text', class: 'mono dt-cron-expr', placeholder: '0 21 * * 1-5   or   @daily', spellcheck: false,
    autocomplete: 'off', 'aria-describedby': 'dt-cron-status' });
  const preset = h('select', { 'aria-label': 'Presets', onchange: () => {
    if (preset.value) { input.value = preset.value; preset.value = ''; update(); input.focus(); }
  } }, h('option', { value: '' }, 'Presets…'), C.PRESETS.map(([label, expr]) => h('option', { value: expr }, `${label} — ${expr}`)));

  const status = notice();
  status.id = 'dt-cron-status';
  const desc = h('p', { class: 'dt-cron-desc', 'aria-live': 'polite' });
  const fieldsBox = h('div', { class: 'dt-cron-fields', role: 'list', 'aria-label': 'Fields' });
  const breakdown = h('div', {});

  /* ---------- next runs */
  const zone = h('select', { 'aria-label': 'Also show in time zone', onchange: () => { setOpt(T, 'zone', zone.value); update(); } },
    h('option', { value: '' }, '— none —'), zones().map((z) => h('option', { value: z }, z)));
  zone.value = zones().includes(opt(T, 'zone', '')) ? opt(T, 'zone', '') : '';
  const basis = h('select', { 'aria-label': 'Evaluate the schedule in', onchange: () => { setOpt(T, 'basis', basis.value); update(); } },
    h('option', { value: 'local' }, `local time (${local})`), h('option', { value: 'zone' }, 'the chosen zone (server TZ)'));
  basis.value = opt(T, 'basis', 'local');
  const runs = h('div', {});

  /* ---------- crontab line */
  const command = h('input', { type: 'text', class: 'mono', placeholder: '/path/to/command >> /tmp/job.log 2>&1', spellcheck: false });
  const line = codeBlock('');

  /* ---------- builder */
  const kind = h('select', { 'aria-label': 'Schedule kind' }, [
    ['everyN', 'Every N minutes'], ['hourly', 'Hourly at :MM'], ['daily', 'Daily at HH:MM'],
    ['weekdays', 'Weekdays (Mon–Fri) at'], ['weekly', 'Weekly on days at'], ['monthly', 'Monthly on day at'],
  ].map(([v, l]) => h('option', { value: v }, l)));
  kind.value = opt(T, 'kind', 'daily');
  const num = (label, min, max, value) => h('input', { type: 'number', min, max, value, 'aria-label': label, class: 'dt-cron-num' });
  const bN = num('Every N minutes', 1, 59, 5), bMin = num('Minute', 0, 59, 0), bHour = num('Hour', 0, 23, 9), bDom = num('Day of month', 1, 31, 1);
  const dayBoxes = C.DAYS.map((d, i) => h('input', { type: 'checkbox', value: i, checked: i === 1, 'aria-label': d }));
  const daysRow = h('div', { class: 'chips dt-cron-days', role: 'group', 'aria-label': 'Days of week' },
    dayBoxes.map((cb, i) => h('label', { class: 'chip' }, cb, C.DAYS[i].slice(0, 3))));
  const bWrap = {
    n: labelled('Every', h('span', { class: 'row dt-nowrap' }, bN, h('span', { class: 'muted small' }, 'minutes'))),
    dom: labelled('Day of month', bDom),
    hour: labelled('Hour (0–23)', bHour),
    min: labelled('Minute (0–59)', bMin),
    days: h('div', { class: 'field dt-cron-dayfield' }, h('span', { class: 'dt-tc-label' }, 'Days'), daysRow),
  };
  const bStatus = notice();

  function syncBuilder() {
    const k = kind.value;
    bWrap.n.hidden = k !== 'everyN';
    bWrap.min.hidden = k === 'everyN';
    bWrap.hour.hidden = ['everyN', 'hourly'].includes(k);
    bWrap.days.hidden = k !== 'weekly';
    bWrap.dom.hidden = k !== 'monthly';
  }
  function applyBuilder() {
    try {
      const expr = C.buildCron({
        kind: kind.value, n: bN.value, minute: bMin.value, hour: bHour.value, dom: bDom.value,
        days: dayBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
      });
      show(bStatus, '');
      input.value = expr; update();
    } catch (e) { show(bStatus, 'err', e.message); }
  }
  kind.addEventListener('change', () => { setOpt(T, 'kind', kind.value); syncBuilder(); applyBuilder(); });
  for (const el of [bN, bMin, bHour, bDom, ...dayBoxes]) el.addEventListener('input', debounce(applyBuilder, 200));
  for (const cb of dayBoxes) cb.addEventListener('change', () => cb.closest('label').classList.toggle('on', cb.checked));
  dayBoxes.forEach((cb) => cb.closest('label')?.classList.toggle('on', cb.checked));
  syncBuilder();

  /* ---------- render */
  function renderFields(p) {
    const rows = C.fieldBreakdown(p);
    const parts = p.fields.length ? p.fields : [];
    clear(fieldsBox, parts.map((f, i) => h('div', { class: `dt-cron-field ${f.error ? 'err' : ''}`, role: 'listitem', title: f.error || rows[i]?.values || '' },
      h('span', { class: 'mono dt-cron-raw' }, f.raw), h('span', { class: 'muted small' }, f.label))));
    clear(breakdown, rows.length ? h('div', { class: 'table-wrap dt-cron-table' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Value'), h('th', {}, 'Allowed'), h('th', {}, 'Matches'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.error ? 'dt-cron-bad' : '' },
        h('td', {}, r.label), h('td', { class: 'mono' }, r.raw), h('td', { class: 'muted small' }, r.range),
        h('td', { class: r.error ? '' : 'mono' }, r.error ? h('span', { class: 'pill err' }, r.error) : r.values)))))) : null);
  }

  function renderRuns(p) {
    const z2 = zone.value || null;
    const evalTz = basis.value === 'zone' && z2 ? z2 : undefined;
    if (basis.value === 'zone' && !z2) show(status, 'warn', 'Pick a time zone below to evaluate the schedule in it.');
    let list;
    try { list = C.nextRuns(p, Date.now(), 10, evalTz); } catch (e) { clear(runs, h('div', { class: 'notice err' }, `Could not compute run times: ${e.message}`)); return; }
    if (!list.length) {
      clear(runs, h('div', { class: 'notice warn' }, '⚠ This schedule never fires in the next 12 years (e.g. 30 February or 31 April).'));
      return;
    }
    const now = Date.now();
    const showLocalCol = !(evalTz && evalTz === local);
    clear(runs, h('div', { class: 'table-wrap dt-cron-table' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), showLocalCol ? h('th', {}, `Local (${local})`) : null,
        z2 ? h('th', {}, z2) : null, h('th', {}, 'When'), h('th', {}, ''))),
      h('tbody', {}, list.map((r, i) => h('tr', {},
        h('td', { class: 'muted' }, i + 1),
        showLocalCol ? h('td', { class: 'mono' }, fmtIn(r.t)) : null,
        z2 ? h('td', { class: 'mono' }, fmtIn(r.t, z2)) : null,
        h('td', { class: 'muted small' }, relative(r.t - now)),
        h('td', {}, r.note === 'dst-gap' ? h('span', { class: 'pill warn', title: 'This wall-clock time does not exist on this day (clocks spring forward); cron runs it when the gap ends.' }, 'DST: shifted')
          : r.note === 'dst-repeat' ? h('span', { class: 'pill warn', title: 'Clocks fall back and this time happens twice.' }, 'DST: repeated hour') : null)))))));
  }

  let parsed = C.parseCron('');
  function update() {
    try {
      const expr = input.value;
      parsed = C.parseCron(expr);
      input.classList.toggle('dt-bad', !!expr.trim() && !parsed.ok);
      input.setAttribute('aria-invalid', String(!!expr.trim() && !parsed.ok));
      line.set(parsed.ok ? C.crontabLine(parsed.expr, command.value) : '');
      if (!expr.trim()) {
        show(status, ''); clear(desc); clear(fieldsBox); clear(breakdown); clear(runs);
        desc.append(h('span', { class: 'muted' }, 'Type an expression, pick a preset or use the builder below.'));
        return;
      }
      renderFields(parsed);
      if (!parsed.ok) {
        clear(desc);
        show(status, 'err', ...parsed.errors.map((e, i) => [i ? h('br') : null, `✗ ${e.message}`]));
        clear(runs);
        return;
      }
      show(status, '');
      clear(desc, C.describeCron(parsed), parsed.macro && !parsed.reboot ? h('span', { class: 'muted small' }, `  (${parsed.macro} = ${C.MACROS[parsed.macro]})`) : null);
      if (parsed.reboot) { clear(breakdown); clear(runs, h('p', { class: 'muted small' }, '@reboot runs once when the cron daemon starts; there are no scheduled times.')); return; }
      renderRuns(parsed);
    } catch (e) {
      show(status, 'err', `Something went wrong: ${e.message}`);
    }
  }
  const live = debounce(update, 150);
  input.addEventListener('input', live);
  command.addEventListener('input', debounce(() => { line.set(parsed.ok ? C.crontabLine(parsed.expr, command.value) : ''); }, 150));
  update();

  const el = h('div', { class: 'stack dt-tool dt-cron' },
    h('div', { class: 'row dt-cron-top' }, h('div', { class: 'dt-grow' }, labelled('Cron expression', input)), h('label', { class: 'field' }, h('span', {}, 'Presets'), preset)),
    status, desc, fieldsBox,
    h('div', { class: 'dt-tc-section stack' },
      h('div', { class: 'row' }, h('b', {}, 'Next 10 runs'), h('span', { class: 'spacer', style: { flex: 1 } }),
        h('label', { class: 'row small' }, h('span', { class: 'muted' }, 'Also show in'), h('span', { class: 'dt-zone' }, zone)),
        h('label', { class: 'row small' }, h('span', { class: 'muted' }, 'Schedule runs in'), basis)),
      runs),
    h('details', { class: 'dt-tc-section' }, h('summary', {}, 'Field breakdown'), breakdown),
    h('div', { class: 'dt-tc-section stack' }, h('b', {}, 'Builder'),
      h('div', { class: 'row dt-cron-builder' }, labelled('Schedule', kind), bWrap.n, bWrap.days, bWrap.dom, bWrap.hour, bWrap.min,
        h('button', { type: 'button', class: 'btn sm', onclick: applyBuilder }, 'Use')),
      bStatus),
    h('div', { class: 'dt-tc-section stack' },
      h('div', { class: 'row' }, h('b', {}, 'Crontab line'), h('span', { class: 'spacer', style: { flex: 1 } }),
        copyBtn(() => (parsed.ok ? C.crontabLine(parsed.expr, command.value) : ''), 'Copy crontab line')),
      labelled('Command', command), line,
      h('p', { class: 'muted small' }, 'Cron uses the server’s time zone (or CRON_TZ= / TZ= at the top of the crontab). Day-of-month and day-of-week: when both are restricted, a match on either one fires (Vixie cron).')));

  return {
    el,
    focus() { input.focus(); },
    clear() { input.value = ''; command.value = ''; show(bStatus, ''); update(); },
  };
}
