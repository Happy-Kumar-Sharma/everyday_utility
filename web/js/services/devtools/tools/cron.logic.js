// Pure logic for the ⏰ Cron helper (no DOM): parse / describe / next runs / build, plus time-zone helpers
// (wall clock ⇄ instant in an IANA zone) that the duration calculator reuses.

/* ------------------------------------------------------------------ time zones */
const fmtCache = new Map();
function zoneFmt(tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    }));
  }
  return fmtCache.get(key);
}

/** True when tz is a time zone this engine knows (undefined / '' mean the local zone). */
export function validZone(tz) {
  if (!tz) return true;
  try { zoneFmt(tz); return true; } catch { fmtCache.delete(tz); return false; }
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Wall-clock parts of instant `ms` in tz: {y, mo (1-12), d, h, mi, s, dow (0=Sun)}. */
export function wallParts(ms, tz) {
  const p = {};
  for (const { type, value } of zoneFmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute),
    s: Number(p.second), dow: WD[p.weekday],
  };
}

/** UTC offset (ms) of tz at instant ms, at whole-second precision. */
export function zoneOffset(ms, tz) {
  const w = wallParts(ms, tz);
  const floor = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floor;
}

const sameWall = (ms, tz, y, mo, d, h, mi) => {
  const w = wallParts(ms, tz);
  return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
};

/**
 * Instants at which the wall clock in tz shows y-mo-d h:mi (+ s, ms). Returns
 * {instants: [ms…]} — 0 entries inside a DST gap (then `gapEnd` is the first instant after the gap),
 * 1 normally, 2 when the clock falls back and the time repeats.
 */
export function wallToInstants(y, mo, d, h, mi, tz, s = 0, msec = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, msec);
  const offs = new Set([zoneOffset(guess - 86400000, tz), zoneOffset(guess, tz), zoneOffset(guess + 86400000, tz)]);
  const instants = [...offs].map((o) => guess - o).filter((t) => sameWall(t, tz, y, mo, d, h, mi)).sort((a, b) => a - b);
  const uniq = instants.filter((t, i) => i === 0 || t !== instants[i - 1]);
  if (uniq.length) return { instants: uniq };
  // in a gap: binary search the transition between guess - maxOffset and guess - minOffset
  let lo = guess - Math.max(...offs), hi = guess - Math.min(...offs);
  const oLo = zoneOffset(lo, tz);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (zoneOffset(mid, tz) === oLo) lo = mid; else hi = mid;
  }
  return { instants: [], gapEnd: hi };
}

/** Wall time → one instant (earliest when repeated, the end of the gap when skipped). */
export function wallToInstant(y, mo, d, h = 0, mi = 0, tz, s = 0, msec = 0) {
  const r = wallToInstants(y, mo, d, h, mi, tz, s, msec);
  return r.instants.length ? r.instants[0] : r.gapEnd;
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ------------------------------------------------------------------ parsing */
export const FIELDS = [
  { name: 'minute', label: 'Minute', min: 0, max: 59 },
  { name: 'hour', label: 'Hour', min: 0, max: 23 },
  { name: 'dom', label: 'Day of month', min: 1, max: 31 },
  { name: 'month', label: 'Month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'dow', label: 'Day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function parseNum(tok, f) {
  const t = tok.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(t);
    if (i >= 0) return f.name === 'month' ? i + 1 : i;
  }
  if (!/^\d+$/.test(t)) throw new Error(`"${tok}" is not a number${f.names ? ` or a name (${f.names[0]}…${f.names.at(-1)})` : ''}`);
  const n = Number(t);
  if (n < f.min || n > f.max) throw new Error(`${n} is out of range ${f.min}–${f.max}`);
  return n;
}

/** Parse one field → sorted unique values (dow 7 folded into 0). Throws Error with a readable message. */
export function parseField(raw, f) {
  if (raw === '') throw new Error('is empty');
  const values = new Set();
  for (const part of raw.split(',')) {
    if (part === '') throw new Error('has an empty list item (",,")');
    const m = part.match(/^([^/]+)(?:\/(.*))?$/);
    if (!m) throw new Error(`"${part}" is not valid`);
    const [, range, stepRaw] = m;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new Error(`step "/${stepRaw}" must be a positive number`);
      step = Number(stepRaw);
      if (step < 1) throw new Error('step /0 is not allowed');
      if (step > f.max - f.min + 1 && f.name !== 'dow') throw new Error(`step /${step} is larger than the field's range`);
    }
    let lo, hi;
    if (range === '*' || range === '?') {
      [lo, hi] = [f.min, f.name === 'dow' ? 6 : f.max];
    } else if (range.includes('-')) {
      const [a, b, ...rest] = range.split('-');
      if (rest.length || !a || !b) throw new Error(`"${range}" is not a valid range`);
      lo = parseNum(a, f); hi = parseNum(b, f);
      if (lo > hi) throw new Error(`range ${a}-${b} runs backwards (start must be ≤ end)`);
    } else {
      lo = parseNum(range, f);
      hi = stepRaw !== undefined ? (f.name === 'dow' ? 6 : f.max) : lo;  // "5/15" means 5-max/15
    }
    for (let v = lo; v <= hi; v += step) values.add(f.name === 'dow' && v === 7 ? 0 : v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * parseCron('0 21 * * 1-5') → {ok, expr, macro, reboot, fields: [{name,label,raw,values,star}], errors: [{field, message}]}
 * `star` = the field starts with * (Vixie: such a DOM/DOW does not count as restricted).
 */
export function parseCron(input) {
  const expr = String(input ?? '').trim().replace(/\s+/g, ' ');
  const out = { ok: false, expr, macro: null, reboot: false, fields: [], errors: [] };
  if (!expr) { out.errors.push({ field: null, message: 'Enter a cron expression.' }); return out; }
  let body = expr;
  if (expr.startsWith('@')) {
    const m = expr.toLowerCase();
    if (m === '@reboot') { out.ok = true; out.reboot = true; out.macro = '@reboot'; return out; }
    if (!MACROS[m]) {
      out.errors.push({ field: null, message: `Unknown macro "${expr}". Use @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly or @reboot.` });
      return out;
    }
    out.macro = m; body = MACROS[m];
  }
  const parts = body.split(' ');
  if (parts.length !== 5) {
    const hint = parts.length === 6 ? ' (6 fields looks like a seconds or Quartz/Spring cron; standard cron has 5)'
      : parts.length > 6 ? ' (is a command included? paste only the 5 schedule fields)' : '';
    out.errors.push({ field: null, message: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}${hint}.` });
    return out;
  }
  FIELDS.forEach((f, i) => {
    const raw = parts[i];
    try {
      out.fields.push({ name: f.name, label: f.label, raw, values: parseField(raw, f), star: raw.startsWith('*') || raw.startsWith('?') });
    } catch (e) {
      out.fields.push({ name: f.name, label: f.label, raw, values: [], star: false, error: e.message });
      out.errors.push({ field: f.name, index: i, message: `${f.label} "${raw}": ${e.message}` });
    }
  });
  out.ok = !out.errors.length;
  return out;
}

/* ------------------------------------------------------------------ description */
const pad = (n) => String(n).padStart(2, '0');
const joinList = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** Describe the comma-separated pieces of one field using name(v) for values. */
function pieces(raw, f, name, unit) {
  return raw.split(',').map((part) => {
    const [range, step] = part.split('/');
    const val = (t) => name(parseNum(t, f) === 7 && f.name === 'dow' ? 0 : parseNum(t, f));
    if (range === '*' || range === '?') return step ? `every ${ordinal(Number(step))} ${unit}` : `every ${unit}`;
    if (range.includes('-')) {
      const [a, b] = range.split('-');
      return step ? `every ${ordinal(Number(step))} ${unit} from ${val(a)} through ${val(b)}` : `${val(a)} through ${val(b)}`;
    }
    return step ? `every ${ordinal(Number(step))} ${unit} starting at ${val(range)}` : val(range);
  });
}
const isSingle = (raw) => /^\d+$/.test(raw);
const isStepAll = (raw) => /^[*?]\/\d+$/.test(raw);
const isPlain = (raw) => raw === '*' || raw === '?';

function timePart(min, hr) {
  const m = min.raw, hRaw = hr.raw;
  const mf = FIELDS[0], hf = FIELDS[1];
  if (isPlain(m) && isPlain(hRaw)) return 'Every minute';
  if (isSingle(m) && hr.values.length <= 8 && hRaw.split(',').every(isSingle)) {
    return `At ${joinList(hr.values.map((h) => `${pad(h)}:${pad(min.values[0])}`))}`;
  }
  let minText;
  if (isPlain(m)) minText = 'Every minute';
  else if (isStepAll(m)) minText = `Every ${m.split('/')[1]} minutes`;
  else if (isSingle(m)) minText = `At minute ${min.values[0]}`;
  else minText = `At minutes ${joinList(pieces(m, mf, String, 'minute'))}`.replace('At minutes every', 'Every');
  if (isPlain(hRaw)) return isSingle(m) ? `${minText} past every hour` : minText;
  if (/^\d+-\d+$/.test(hRaw) && !isSingle(m)) {
    const [a, b] = hRaw.split('-').map(Number);
    return `${minText}, between ${pad(a)}:00 and ${pad(b)}:59`;
  }
  if (isStepAll(hRaw)) return `${minText} past every ${hRaw.split('/')[1]} hours`.replace('every 1 hours', 'every hour');
  return `${minText} past hour ${joinList(pieces(hRaw, hf, String, 'hour'))}`;
}

/** Plain-English description, e.g. "At 21:00, Monday through Friday". */
export function describeCron(p) {
  if (!p?.ok) return '';
  if (p.reboot) return 'Once, at system startup (@reboot)';
  const [min, hr, dom, mon, dow] = p.fields;
  let text = timePart(min, hr);
  const dowText = joinList(pieces(dow.raw, FIELDS[4], (v) => DAYS[v], 'day of the week'));
  const domText = (() => {
    if (isStepAll(dom.raw)) return `every ${ordinal(Number(dom.raw.split('/')[1]))} day of the month`;
    const ps = pieces(dom.raw, FIELDS[2], (v) => ordinal(v), 'day');
    return `on the ${joinList(ps)} of the month`.replace('on the every', 'on every');
  })();
  const domR = !dom.star, dowR = !dow.star;
  if (domR && dowR) text += `, ${domText} or on ${dowText}`;
  else if (domR) text += `, ${domText}`;
  else if (dowR || !isPlain(dow.raw)) text += `, ${/through|every/.test(dowText) ? '' : 'only on '}${dowText}`;
  else if (!isPlain(dom.raw)) text += `, ${domText}`;
  if (!isPlain(mon.raw)) {
    const ps = pieces(mon.raw, FIELDS[3], (v) => MONTHS[v - 1], 'month');
    text += `, ${ps.some((s) => s.startsWith('every')) ? '' : 'in '}${joinList(ps)}`;
  }
  return text;
}

/** One line per field for the breakdown table: {label, raw, meaning, values (string)}. */
export function fieldBreakdown(p) {
  if (!p?.fields?.length) return [];
  return p.fields.map((fl, i) => {
    const f = FIELDS[i];
    const name = f.name === 'month' ? (v) => MONTHS[v - 1].slice(0, 3) : f.name === 'dow' ? (v) => DAYS[v].slice(0, 3) : String;
    const all = fl.values.length === (f.name === 'dow' ? 7 : f.max - f.min + 1);
    return {
      label: f.label, raw: fl.raw, error: fl.error || null,
      range: f.name === 'month' ? '1–12 or jan–dec' : f.name === 'dow' ? '0–7 or sun–sat (0 and 7 = Sun)' : `${f.min}–${f.max}`,
      values: fl.error ? '' : all ? `all (${fl.values.length})` : fl.values.map(name).join(', '),
    };
  });
}

/* ------------------------------------------------------------------ next runs */
/**
 * Next `count` run times after `from` (ms) with wall clock in tz (undefined = local).
 * Returns [{t: ms, note?}] — note marks DST-shifted ('dst-gap') and repeated-hour ('dst-repeat') runs.
 * Non-existent wall times (spring forward): fixed-hour jobs run when the gap ends, wildcard-hour jobs are skipped.
 * Repeated wall times (fall back): fixed-hour jobs run once, wildcard-hour jobs run in both copies (Vixie behaviour).
 */
export function nextRuns(p, from, count = 10, tz, { maxDays = 366 * 12 } = {}) {
  if (!p?.ok || p.reboot) return [];
  const [min, hr, dom, mon, dow] = p.fields;
  const hourWild = hr.star;
  const months = new Set(mon.values), doms = new Set(dom.values), dows = new Set(dow.values);
  const domR = !dom.star, dowR = !dow.star;
  const dayMatches = (y, m, d) => {
    if (!months.has(m)) return false;
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (domR && dowR) return doms.has(d) || dows.has(wd);
    return doms.has(d) && dows.has(wd);
  };
  const start = wallParts(from, tz);
  const out = [];
  const seen = new Set();
  const day = new Date(Date.UTC(start.y, start.mo - 1, start.d - 1));  // a day early: covers fall-back overlaps
  for (let i = 0; i < maxDays && out.length < count; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!dayMatches(y, m, d)) continue;
    const early = i <= 2;  // only the first days can hold instants before `from`
    for (const h of hr.values) {
      for (const mi of min.values) {
        if (early && Date.UTC(y, m - 1, d, h, mi) < Date.UTC(start.y, start.mo - 1, start.d, start.h, start.mi) - 4 * 3600000) continue;
        const r = wallToInstants(y, m, d, h, mi, tz);
        let cands;
        if (!r.instants.length) cands = hourWild ? [] : [{ t: r.gapEnd, note: 'dst-gap' }];
        else if (r.instants.length > 1) cands = hourWild ? r.instants.map((t) => ({ t, note: 'dst-repeat' })) : [{ t: r.instants[0], note: 'dst-repeat' }];
        else cands = [{ t: r.instants[0] }];
        for (const c of cands) {
          if (c.t > from && !seen.has(c.t)) { seen.add(c.t); out.push(c); }
        }
      }
    }
    if (out.length >= count) break;
  }
  return out.sort((a, b) => a.t - b.t).slice(0, count);
}

/* ------------------------------------------------------------------ builder */
/**
 * buildCron({kind, n, minute, hour, days, dom}) → expression.
 * kinds: everyN (every n minutes) · hourly (at :minute) · daily · weekdays · weekly (days: [0-6]) · monthly (dom)
 */
export function buildCron(o) {
  const int = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be a whole number ${lo}–${hi}`);
    return n;
  };
  const mi = () => int(o.minute ?? 0, 0, 59, 'Minute');
  const hh = () => int(o.hour ?? 0, 0, 23, 'Hour');
  switch (o.kind) {
    case 'everyN': {
      const n = int(o.n ?? 5, 1, 59, 'Interval');
      return n === 1 ? '* * * * *' : `*/${n} * * * *`;
    }
    case 'hourly': return `${mi()} * * * *`;
    case 'daily': return `${mi()} ${hh()} * * *`;
    case 'weekdays': return `${mi()} ${hh()} * * 1-5`;
    case 'weekly': {
      const days = [...new Set((o.days || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
      if (!days.length) throw new Error('Pick at least one day of the week');
      return `${mi()} ${hh()} * * ${compactList(days)}`;
    }
    case 'monthly': return `${mi()} ${hh()} ${int(o.dom ?? 1, 1, 31, 'Day of month')} * *`;
    default: throw new Error(`Unknown schedule kind "${o.kind}"`);
  }
}

/** [1,2,3,5] → "1-3,5" */
export function compactList(vals) {
  const out = [];
  for (let i = 0; i < vals.length;) {
    let j = i;
    while (j + 1 < vals.length && vals[j + 1] === vals[j] + 1) j++;
    out.push(j - i >= 2 ? `${vals[i]}-${vals[j]}` : vals.slice(i, j + 1).join(','));
    i = j + 1;
  }
  return out.join(',');
}

export const PRESETS = [
  ['Every minute', '* * * * *'], ['Every 5 minutes', '*/5 * * * *'], ['Every 15 minutes', '*/15 * * * *'],
  ['Hourly', '0 * * * *'], ['Every 6 hours', '0 */6 * * *'], ['Daily at midnight', '0 0 * * *'],
  ['Daily at 02:30', '30 2 * * *'], ['Weekdays at 09:00', '0 9 * * 1-5'], ['Weekdays 9–17, every 30 min', '*/30 9-17 * * mon-fri'],
  ['Sundays at 03:00', '0 3 * * 0'], ['1st of the month', '0 0 1 * *'], ['Quarterly', '0 0 1 1,4,7,10 *'],
  ['@reboot', '@reboot'],
];

/** "0 9 * * 1-5" + command → crontab line. */
export const crontabLine = (expr, command) => `${String(expr).trim()} ${String(command || '').trim() || '/path/to/command >> /tmp/job.log 2>&1'}`;
