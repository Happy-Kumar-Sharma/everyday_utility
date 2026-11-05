// Pure logic for the ⏳ Duration calculator (no DOM): flexible date-time parsing (ISO, epoch, log formats)
// in a chosen time zone, differences, business days, duration parsing (3d 4h, 1w2d, PT1H30M) and log scanning.

import { wallParts, wallToInstant } from './cron.logic.js';

export const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON_RE = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

const zoneMs = (z) => {  // "Z" | "+05:30" | "+0530" | "-08" | "UTC" → offset ms, undefined when absent
  if (!z) return undefined;
  if (/^(z|utc|gmt)$/i.test(z)) return 0;
  const m = z.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (!m) return undefined;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
};
const fracMs = (f) => (f ? Math.round(Number(`0.${f}`) * 1000) : 0);

function build(y, mo, d, h, mi, s, ms, zone, tz) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;  // 31 Feb etc.
  const off = zoneMs(zone);
  if (off !== undefined) return Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59), ms) - off;
  return wallToInstant(y, mo, d, h, mi, tz, Math.min(s, 59), ms);
}

// patterns that find a timestamp anywhere in a line; each returns ms or null. `ctx` = {tz, year}
const PATTERNS = [
  { kind: 'ISO 8601', re: /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2}\b|UTC|GMT)?/i,
    at: (m, c) => build(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), fracMs(m[7]), m[8], c.tz) },
  { kind: 'YYYY/MM/DD', re: /(\d{4})\/(\d{2})\/(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s?(Z|[+-]\d{2}:?\d{2})?/i,
    at: (m, c) => build(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), fracMs(m[7]), m[8], c.tz) },
  { kind: 'Apache / nginx', re: new RegExp(`(\\d{1,2})/(${MON_RE})/(\\d{4}):(\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d{1,9}))?(?:\\s*([+-]\\d{4}))?`, 'i'),
    at: (m, c) => build(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6], fracMs(m[7]), m[8], c.tz) },
  { kind: 'RFC 2822', re: new RegExp(`(\\d{1,2}) (${MON_RE})[a-z]* (\\d{4}),? (\\d{2}):(\\d{2})(?::(\\d{2}))?\\s*(GMT|UTC|Z|[+-]\\d{4})?`, 'i'),
    at: (m, c) => build(+m[3], MON[m[2].slice(0, 3).toLowerCase()], +m[1], +m[4], +m[5], +(m[6] || 0), 0, m[7], c.tz) },
  { kind: 'Month day, year', re: new RegExp(`\\b(${MON_RE})[a-z]* (\\d{1,2}),? (\\d{4})(?:,? (\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?\\s*(GMT|UTC|Z|[+-]\\d{2}:?\\d{2})?`, 'i'),
    at: (m, c) => build(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), 0, m[7], c.tz) },
  { kind: 'syslog (no year)', re: new RegExp(`\\b(${MON_RE}) {1,2}(\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d{1,9}))?`, 'i'),
    at: (m, c) => build(c.year, MON[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5], fracMs(m[6]), null, c.tz) },
];
const EPOCH_RE = /(?<![\d.])(\d{10}(?:\.\d{1,6})?|\d{13})(?![\d])/;

/** Epoch from a bare number: ≤ 11 digits = seconds, 12–14 = ms, 15–17 = µs, 18–19 = ns. */
function epoch(s) {
  const neg = s.startsWith('-');
  const [int] = s.replace('-', '').split('.');
  const n = Number(s);
  const digits = int.length;
  const unit = digits <= 11 ? 's' : digits <= 14 ? 'ms' : digits <= 17 ? 'µs' : 'ns';
  const ms = { s: n * 1000, ms: n, 'µs': n / 1000, ns: n / 1e6 }[unit];
  return { ms: Math.round(ms) * (neg && ms > 0 ? -1 : 1), kind: `epoch ${unit}` };
}

/**
 * parseDateTime(text, {tz, now}) → {ms, kind, assumedYear?} or null.
 * Wall times without an offset are read in tz (undefined = local); year-less syslog stamps get the year of `now`
 * (or the previous year when that would put them more than a day in the future).
 */
export function parseDateTime(text, { tz, now = Date.now() } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return { ms: now, kind: 'now' };
  if (/^-?\d+(\.\d+)?$/.test(s)) return epoch(s);
  const year = wallParts(now, tz).y;
  const body = s.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+/i, '');
  for (const p of PATTERNS) {
    const m = body.match(p.re);
    if (!m || m.index !== 0) continue;
    const rest = body.slice(m[0].length).trim();
    if (rest && !/^[\])]/.test(rest)) continue;  // must be the whole input (log brackets allowed)
    let ms = p.at(m, { tz, year });
    if (ms === null) return null;
    let assumedYear;
    if (p.kind.startsWith('syslog')) {
      assumedYear = year;
      if (ms > now + 86400000) { ms = p.at(m, { tz, year: year - 1 }); assumedYear = year - 1; }
    }
    return { ms, kind: p.kind, assumedYear };
  }
  const bracket = s.match(/^\[(.*)\]$/);
  if (bracket) return parseDateTime(bracket[1], { tz, now });
  return null;
}

/** Find the first timestamp in a log line → {ms, kind, text} or null. */
export function findTimestamp(line, { tz, year, epochs = true }) {
  let best = null;
  for (const p of PATTERNS) {
    const m = line.match(p.re);
    if (!m || (best && m.index >= best.index)) continue;
    if (p.kind === 'ISO 8601' && !m[4] && /\d{4}-\d{2}-\d{2}\d/.test(line.slice(m.index))) continue;
    const ms = p.at(m, { tz, year });
    if (ms !== null) best = { ms, kind: p.kind, text: m[0].trim(), index: m.index };
  }
  if (!best && epochs) {
    const m = line.match(EPOCH_RE);
    if (m) best = { ...epoch(m[1]), text: m[1], index: m.index };
  }
  return best;
}

/**
 * scanLog(text, {tz, now, gapSeconds}) → {stamps: [{line, ms, kind, text}], first, last, spanMs, gaps: [{from, to, ms}],
 *   backwards: [{from, to, ms}], lines, kinds}
 */
export function scanLog(text, { tz, now = Date.now(), gapSeconds = 60 } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const year = wallParts(now, tz).y;
  const stamps = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const t = findTimestamp(l, { tz, year });
    if (t) stamps.push({ line: i + 1, ms: t.ms, kind: t.kind, text: t.text, content: l });
  });
  const gaps = [], backwards = [];
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i].ms - stamps[i - 1].ms;
    if (d < 0) backwards.push({ from: stamps[i - 1], to: stamps[i], ms: d });
    else if (d > gapSeconds * 1000) gaps.push({ from: stamps[i - 1], to: stamps[i], ms: d });
  }
  const sorted = stamps.map((s) => s.ms);
  const first = stamps.length ? Math.min(...sorted) : null, last = stamps.length ? Math.max(...sorted) : null;
  const kinds = [...new Set(stamps.map((s) => s.kind))];
  return { stamps, first, last, spanMs: stamps.length ? last - first : 0, gaps, backwards, lines: lines.filter((l) => l.trim()).length, kinds };
}

/* ------------------------------------------------------------------ differences */
/** 93784005 → {sign, d, h, m, s, ms} */
export function splitMs(ms) {
  const sign = ms < 0 ? -1 : 1;
  let r = Math.abs(ms);
  const d = Math.floor(r / 86400000); r -= d * 86400000;
  const h = Math.floor(r / 3600000); r -= h * 3600000;
  const m = Math.floor(r / 60000); r -= m * 60000;
  const s = Math.floor(r / 1000);
  return { sign, d, h, m, s, ms: Math.round(r - s * 1000) };
}

/** "1d 2h 3m 4s" (zero parts dropped, ms shown when present). */
export function formatDuration(ms) {
  const p = splitMs(ms);
  const parts = [[p.d, 'd'], [p.h, 'h'], [p.m, 'm'], [p.s, 's'], [p.ms, 'ms']].filter(([n]) => n).map(([n, u]) => `${n}${u}`);
  return (p.sign < 0 && parts.length ? '−' : '') + (parts.join(' ') || '0s');
}

/** ISO 8601 duration of an exact span: PT… with days split off (P1DT2H3M4.5S). */
export function toIsoDuration(ms) {
  const p = splitMs(ms);
  const sec = p.s + p.ms / 1000;
  let t = '';
  if (p.h) t += `${p.h}H`;
  if (p.m) t += `${p.m}M`;
  if (sec) t += `${Number(sec.toFixed(3))}S`;
  const out = `P${p.d ? `${p.d}D` : ''}${t ? `T${t}` : ''}`;
  return (p.sign < 0 && out !== 'P' ? '-' : '') + (out === 'P' ? 'PT0S' : out);
}

const dayNum = (ms, tz) => { const w = wallParts(ms, tz); return Date.UTC(w.y, w.mo - 1, w.d) / 86400000; };

/**
 * Weekdays (Mon–Fri) between the calendar dates of a and b in tz: `elapsed` counts [startDate, endDate)
 * (Mon → Fri = 4), `inclusive` counts both ends (Mon → Fri = 5). Order-independent.
 */
export function businessDays(a, b, tz) {
  let x = dayNum(Math.min(a, b), tz), y = dayNum(Math.max(a, b), tz);
  const weekdaysBefore = (n) => {  // weekdays in days [0, n) counted from 1970-01-01 (Thursday)
    const weeks = Math.floor(n / 7), rem = n - weeks * 7;
    let c = weeks * 5;
    for (let i = 0; i < rem; i++) { const wd = (((4 + weeks * 7 + i) % 7) + 7) % 7; if (wd !== 0 && wd !== 6) c++; }
    return c;
  };
  const elapsed = weekdaysBefore(y) - weekdaysBefore(x);
  const lastWd = ((4 + y) % 7 + 7) % 7;
  return { elapsed, inclusive: elapsed + (lastWd !== 0 && lastWd !== 6 ? 1 : 0), calendarDays: y - x };
}

/** Full comparison of two instants. */
export function compare(a, b, tz) {
  const ms = b - a;
  return {
    ms, parts: splitMs(ms), text: formatDuration(ms), iso: toIsoDuration(ms),
    totals: { days: ms / 86400000, hours: ms / 3600000, minutes: ms / 60000, seconds: ms / 1000, ms },
    business: businessDays(a, b, tz),
  };
}

/* ------------------------------------------------------------------ duration parsing + arithmetic */
const UNIT = {
  y: 'y', yr: 'y', yrs: 'y', year: 'y', years: 'y',
  mo: 'mo', mon: 'mo', mons: 'mo', month: 'mo', months: 'mo',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  d: 'd', day: 'd', days: 'd',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  ms: 'ms', msec: 'ms', millis: 'ms', millisecond: 'ms', milliseconds: 'ms',
};

/**
 * parseDuration('3d 4h 30m' | '1w2d' | '90m' | '-1.5h' | 'PT1H30M' | 'P1Y2M3DT4H' | '01:30:00') →
 * {sign: 1|-1, parts: {y, mo, w, d, h, m, s, ms}} ; throws Error with a readable message.
 */
export function parseDuration(text) {
  let s = String(text ?? '').trim().replace(/^−/, '-');
  if (!s) throw new Error('Enter a duration, e.g. 3d 4h 30m, 1w2d, 90m or PT1H30M');
  let sign = 1;
  if (/^[-+]/.test(s)) { sign = s[0] === '-' ? -1 : 1; s = s.slice(1).trim(); }
  const parts = { y: 0, mo: 0, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 };
  const iso = s.match(/^P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i);
  if (iso) {
    if (s.length <= 1 || /T$/i.test(s)) throw new Error(`"${text}" is an incomplete ISO 8601 duration`);
    const n = (v) => Number(String(v || 0).replace(',', '.'));
    if ([iso[1], iso[2]].some((v) => v && /[.,]/.test(v))) throw new Error('Fractional years/months are ambiguous; use days or hours');
    Object.assign(parts, { y: n(iso[1]), mo: n(iso[2]), w: n(iso[3]), d: n(iso[4]), h: n(iso[5]), m: n(iso[6]), s: n(iso[7]) });
    return { sign, parts };
  }
  const clock = s.match(/^(?:(\d+)[.d ]\s*)?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (clock) {
    Object.assign(parts, { d: +(clock[1] || 0), h: +clock[2], m: +clock[3], s: +(clock[4] || 0), ms: clock[5] ? Number(clock[5].padEnd(3, '0')) : 0 });
    return { sign, parts };
  }
  const re = /(\d+(?:\.\d+)?)\s*([a-zµ]+)\s*,?\s*(?:and\s+)?/giy;
  let m, seen = 0;
  while ((m = re.exec(s))) {
    const u = UNIT[m[2].toLowerCase()];
    if (!u) throw new Error(`Unknown unit "${m[2]}" — use y, mo, w, d, h, m, s or ms`);
    if ((u === 'y' || u === 'mo') && !Number.isInteger(Number(m[1]))) throw new Error('Fractional years/months are ambiguous; use days or hours');
    parts[u] += Number(m[1]);
    seen = re.lastIndex;
  }
  if (!seen || seen !== s.length) {
    if (/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${s}" needs a unit, e.g. ${s}m or ${s}s`);
    throw new Error(`Could not read "${text}" — try 3d 4h 30m, 1w2d, 90m, -2h or PT1H30M`);
  }
  return { sign, parts };
}

/** Exact milliseconds of the fixed-length part (weeks, days as 24 h, h, m, s, ms); years/months excluded. */
export const fixedMs = (p) => ((p.w * 7 + p.d) * 86400 + p.h * 3600 + p.m * 60 + p.s) * 1000 + p.ms;

/** Human text of a parsed duration: "−1 month 2 days 3h". */
export function describeDuration({ sign, parts: p }) {
  const words = [[p.y, 'year'], [p.mo, 'month'], [p.w, 'week'], [p.d, 'day']].filter(([n]) => n).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`);
  const rest = [[p.h, 'h'], [p.m, 'm'], [p.s, 's'], [p.ms, 'ms']].filter(([n]) => n).map(([n, u]) => `${n}${u}`);
  const txt = [...words, ...rest].join(' ') || '0s';
  return sign < 0 ? `−${txt}` : txt;
}

/**
 * addDuration(ms, dur, tz) → ms. Years, months, weeks and whole days move the calendar date in tz keeping the
 * wall-clock time (so DST does not shift it; the 31st clamps to the month's last day); fractional days, hours,
 * minutes, seconds and ms are exact elapsed time.
 */
export function addDuration(ms, { sign, parts: p }, tz) {
  const days = p.w * 7 + p.d;
  const calDays = Math.trunc(days);
  const exact = ((days - calDays) * 86400 + p.h * 3600 + p.m * 60 + p.s) * 1000 + p.ms;
  let t = ms;
  if (p.y || p.mo || calDays) {
    const w = wallParts(ms, tz);
    const msec = ((ms % 1000) + 1000) % 1000;
    let y = w.y, mo = w.mo - 1 + sign * (p.y * 12 + p.mo);
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const base = new Date(Date.UTC(y, mo, Math.min(w.d, dim)));
    base.setUTCDate(base.getUTCDate() + sign * calDays);
    t = wallToInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), w.h, w.mi, tz, w.s, msec);
  }
  return t + sign * exact;
}

/** Wall-clock text of ms in tz: "2026-11-05 10:30:00" (+ ".123" when there are ms). */
export function formatWall(ms, tz) {
  const w = wallParts(ms, tz);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const frac = ((ms % 1000) + 1000) % 1000;
  return `${p(w.y, 4)}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}:${p(w.s)}${frac ? `.${p(frac, 3)}` : ''}`;
}

/** UTC offset of tz at ms as "+05:30". */
export function offsetText(ms, tz) {
  const w = wallParts(ms, tz);
  const off = Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
  const a = Math.abs(off);
  return `${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** ISO 8601 with the zone's offset: 2026-11-05T10:30:00+05:30 */
export const isoInZone = (ms, tz) => `${formatWall(ms, tz).replace(' ', 'T')}${offsetText(ms, tz)}`;
