// ⏳ Duration calculator: difference between two date-times (+ business days), date ± duration, and
// timestamps / gaps in a pasted log excerpt. Wall times without an offset are read in the chosen time zone.

import { segmented } from '../../../core/components.js';
import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { area, kvList, labelled, notice, opt, setOpt, show } from '../ui.js';
import { localZone } from './cron.logic.js';
import * as D from './duration.logic.js';

const T = 'duration';
const num = (n, digits = 4) => String(Number(n.toFixed(digits)));  // plain digits: easy to copy and paste into code

export default function build() {
  loadCss('/static/css/devtools-timecron.css');
  const local = localZone();
  const zoneList = Intl.supportedValuesOf?.('timeZone') || [];
  const tzSel = h('select', { 'aria-label': 'Time zone for times without an offset' },
    h('option', { value: '' }, `Local (${local})`), (zoneList.includes('UTC') ? zoneList : ['UTC', ...zoneList]).map((z) => h('option', { value: z }, z)));
  tzSel.value = [...tzSel.options].some((o) => o.value === opt(T, 'tz', '')) ? opt(T, 'tz', '') : '';
  const tz = () => tzSel.value || undefined;
  const tzName = () => tzSel.value || local;

  const mode = segmented([{ value: 'between', label: 'Between two times' }, { value: 'add', label: 'Date ± duration' }, { value: 'log', label: 'Log timestamps' }],
    opt(T, 'mode', 'between'), (v) => { setOpt(T, 'mode', v); update(); });

  const dtInput = (label, placeholder) => h('input', { type: 'text', class: 'mono', placeholder, 'aria-label': label, spellcheck: false, autocomplete: 'off' });
  const nowText = () => D.formatWall(Math.floor(Date.now() / 1000) * 1000, tz());
  const withNow = (input, label) => h('div', { class: 'stack dt-dur-field' },
    labelled(label, h('span', { class: 'row dt-nowrap' }, input,
      h('button', { type: 'button', class: 'btn sm', onclick: () => { input.value = nowText(); update(); } }, 'Now'))),
    h('span', { class: 'muted small dt-dur-hint', 'aria-live': 'polite' }));
  const hintOf = (field) => field.querySelector('.dt-dur-hint');

  /* ---------- (a) between */
  const startIn = dtInput('Start', '2026-11-05 10:30, 1762338600, 05/Nov/2026:10:30:00 +0530');
  const endIn = dtInput('End', 'Nov 5 18:45:00, 2026-11-06T09:00Z, now');
  const startField = withNow(startIn, 'Start'), endField = withNow(endIn, 'End');
  const betweenStatus = notice();
  const betweenOut = h('div', {});
  const betweenBox = h('div', { class: 'stack' }, h('div', { class: 'dt-pair' }, startField, endField), betweenStatus, betweenOut);

  /* ---------- (b) add */
  const baseIn = dtInput('Date-time', '2026-11-05 10:30 or now');
  const baseField = withNow(baseIn, 'Date-time');
  const durIn = h('input', { type: 'text', class: 'mono', placeholder: '3d 4h 30m · 1w2d · 90m · -2h · PT1H30M', 'aria-label': 'Duration', spellcheck: false });
  const op = segmented([{ value: 1, label: '+ add' }, { value: -1, label: '− subtract' }], 1, () => update());
  const addStatus = notice();
  const addOut = h('div', {});
  const addBox = h('div', { class: 'stack' }, h('div', { class: 'dt-pair' }, baseField,
    h('div', { class: 'stack dt-dur-field' }, labelled('Duration', durIn), h('div', { class: 'row' }, op))), addStatus, addOut,
  h('p', { class: 'muted small' }, 'Years, months, weeks and days move the calendar (same wall-clock time, even across DST; the 31st clamps to the month’s last day). Hours, minutes and seconds are exact elapsed time.'));

  /* ---------- (c) log */
  const logIn = area({ rows: 10, placeholder: 'Paste log lines — ISO, nginx/apache ([05/Nov/2026:10:30:00 +0530]), syslog (Nov  5 10:30:00), epoch …' });
  const gapIn = h('input', { type: 'text', class: 'mono dt-dur-gap', value: opt(T, 'gap', '1m'), 'aria-label': 'Gap threshold', spellcheck: false });
  const logStatus = notice();
  const logOut = h('div', { class: 'stack' });
  const logBox = h('div', { class: 'stack' }, labelled('Log excerpt', logIn),
    h('label', { class: 'row small' }, h('span', { class: 'muted' }, 'Report gaps longer than'), gapIn, h('span', { class: 'muted' }, '(e.g. 30s, 5m, 1h)')),
    logStatus, logOut);

  const read = (input, field) => {
    const hint = hintOf(field);
    input.classList.remove('dt-bad'); input.removeAttribute('aria-invalid');
    if (!input.value.trim()) { hint.textContent = ''; return null; }
    const r = D.parseDateTime(input.value, { tz: tz() });
    if (!r || !Number.isFinite(r.ms)) {
      input.classList.add('dt-bad'); input.setAttribute('aria-invalid', 'true');
      hint.textContent = '✗ Not a date-time I understand (ISO, epoch s/ms, 05/Nov/2026:10:30:00 +0530, Nov 5 10:30:00).';
      return { bad: true };
    }
    hint.textContent = `→ ${D.isoInZone(r.ms, tz())} · read as ${r.kind}${r.assumedYear ? ` (year ${r.assumedYear} assumed)` : ''}`;
    return r;
  };

  function updateBetween() {
    const a = read(startIn, startField), b = read(endIn, endField);
    if (!a || !b || a.bad || b.bad) {
      show(betweenStatus, a?.bad || b?.bad ? 'err' : '', ...(a?.bad || b?.bad ? ['Fix the highlighted date-time.'] : []));
      return clear(betweenOut);
    }
    const c = D.compare(a.ms, b.ms, tz());
    const p = c.parts;
    show(betweenStatus, c.ms < 0 ? 'warn' : 'ok', c.ms < 0 ? `End is before start — difference is ${c.text}` : `${c.text}`);
    clear(betweenOut, kvList([
      ['Difference', `${p.sign < 0 ? '−' : ''}${p.d} d ${p.h} h ${p.m} m ${p.s} s${p.ms ? ` ${p.ms} ms` : ''}`],
      ['ISO 8601 duration', c.iso],
      ['Total days', num(c.totals.days)],
      ['Total hours', num(c.totals.hours)],
      ['Total minutes', num(c.totals.minutes, 2)],
      ['Total seconds', num(c.totals.seconds, 3)],
      ['Total milliseconds', String(c.totals.ms)],
      ['Calendar days', String(c.business.calendarDays)],
      ['Business days (Mon–Fri)', `${c.business.elapsed} elapsed · ${c.business.inclusive} counting both ends`],
    ]));
  }

  function updateAdd() {
    const a = read(baseIn, baseField);
    durIn.classList.remove('dt-bad');
    if (!a || a.bad || !durIn.value.trim()) {
      show(addStatus, a?.bad ? 'err' : '', ...(a?.bad ? ['Fix the highlighted date-time.'] : []));
      return clear(addOut);
    }
    let dur;
    try { dur = D.parseDuration(durIn.value); } catch (e) { durIn.classList.add('dt-bad'); show(addStatus, 'err', e.message); return clear(addOut); }
    const eff = { ...dur, sign: dur.sign * op.value };
    const t = D.addDuration(a.ms, eff, tz());
    if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) { show(addStatus, 'err', 'The result is outside the supported date range.'); return clear(addOut); }
    show(addStatus, 'ok', `${D.formatWall(a.ms, tz())} ${eff.sign < 0 ? '−' : '+'} ${D.describeDuration({ ...dur, sign: 1 })} = ${D.formatWall(t, tz())}`);
    const rows = [
      [`Result (${tzName()})`, `${D.formatWall(t, tz())} (${D.offsetText(t, tz())})`],
      ['ISO 8601 (zone offset)', D.isoInZone(t, tz())],
      ['ISO 8601 (UTC)', new Date(t).toISOString()],
      ['UTC', D.formatWall(t, 'UTC')],
    ];
    if (tzSel.value && tzSel.value !== local) rows.splice(1, 0, [`Local (${local})`, `${D.formatWall(t)} (${D.offsetText(t)})`]);
    rows.push(['Epoch seconds', String(Math.floor(t / 1000))], ['Epoch milliseconds', String(t)], ['Elapsed', D.formatDuration(t - a.ms)]);
    clear(addOut, kvList(rows));
  }

  function updateLog() {
    clear(logOut);
    gapIn.classList.remove('dt-bad');
    if (!logIn.value.trim()) return show(logStatus, '');
    let gapS;
    try {
      const g = D.parseDuration(/^\d+(\.\d+)?$/.test(gapIn.value.trim()) ? `${gapIn.value.trim()}s` : gapIn.value || '1m');
      if (g.parts.y || g.parts.mo) throw new Error('Use days or smaller units for the gap threshold');
      gapS = D.fixedMs(g.parts) / 1000;
      setOpt(T, 'gap', gapIn.value.trim());
    } catch (e) { gapIn.classList.add('dt-bad'); return show(logStatus, 'err', `Gap threshold: ${e.message}`); }
    const r = D.scanLog(logIn.value, { tz: tz(), gapSeconds: gapS });
    if (!r.stamps.length) return show(logStatus, 'warn', `No timestamps found in ${r.lines} line${r.lines === 1 ? '' : 's'}.`);
    show(logStatus, r.backwards.length ? 'warn' : 'ok',
      `${r.stamps.length} of ${r.lines} lines have a timestamp · span ${D.formatDuration(r.spanMs)} · ${r.gaps.length} gap${r.gaps.length === 1 ? '' : 's'} > ${D.formatDuration(gapS * 1000)}`
      + (r.backwards.length ? ` · ⚠ ${r.backwards.length} time${r.backwards.length === 1 ? '' : 's'} going backwards` : ''));
    const yearNote = r.kinds.includes('syslog (no year)') ? ' (syslog lines have no year; the current year is assumed)' : '';
    logOut.append(kvList([
      ['First', `${D.isoInZone(r.first, tz())}`],
      ['Last', `${D.isoInZone(r.last, tz())}`],
      ['Span', `${D.formatDuration(r.spanMs)}  (${D.toIsoDuration(r.spanMs)})`],
      ['Formats seen', r.kinds.join(', ') + yearNote],
    ]));
    const table = (title, list, cls) => list.length && h('div', { class: 'stack' }, h('b', {}, title),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-dur-gaps' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Lines'), h('th', {}, 'Gap'), h('th', {}, 'From'), h('th', {}, 'To'))),
        h('tbody', {}, list.slice(0, 500).map((g) => h('tr', {},
          h('td', { class: 'mono' }, `${g.from.line} → ${g.to.line}`),
          h('td', {}, h('span', { class: `pill ${cls}` }, D.formatDuration(g.ms))),
          h('td', { class: 'mono small', title: g.from.content }, g.from.text),
          h('td', { class: 'mono small', title: g.to.content }, g.to.text)))))));
    logOut.append(...[table(`Gaps longer than ${D.formatDuration(gapS * 1000)}`, [...r.gaps].sort((x, y) => y.ms - x.ms), 'warn'),
      table('Out of order (time goes backwards)', r.backwards, 'err')].filter(Boolean));
  }

  function update() {
    betweenBox.hidden = mode.value !== 'between';
    addBox.hidden = mode.value !== 'add';
    logBox.hidden = mode.value !== 'log';
    try {
      if (mode.value === 'between') updateBetween();
      else if (mode.value === 'add') updateAdd();
      else updateLog();
    } catch (e) {
      const st = { between: betweenStatus, add: addStatus, log: logStatus }[mode.value];
      show(st, 'err', `Something went wrong: ${e.message}`);
    }
  }
  const live = debounce(update, 200);
  for (const el of [startIn, endIn, baseIn, durIn, logIn, gapIn]) el.addEventListener('input', live);
  tzSel.addEventListener('change', () => { setOpt(T, 'tz', tzSel.value); update(); });
  update();

  return {
    el: h('div', { class: 'stack dt-tool dt-dur' },
      h('div', { class: 'row' }, mode, h('span', { class: 'spacer', style: { flex: 1 } }),
        h('label', { class: 'row small' }, h('span', { class: 'muted' }, 'Time zone'), h('span', { class: 'dt-zone' }, tzSel))),
      betweenBox, addBox, logBox),
    focus() { ({ between: startIn, add: baseIn, log: logIn })[mode.value].focus(); },
    clear() {
      for (const el of [startIn, endIn, baseIn, durIn, logIn]) el.value = '';
      op.value = 1; update();
    },
  };
}
