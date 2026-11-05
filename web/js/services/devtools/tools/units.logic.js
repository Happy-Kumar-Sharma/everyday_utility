// Number & unit converter logic (no DOM): integer bases with BigInt, data sizes and time units.

/* ------------------------------------------------------------------ decimal formatting */

/** Rounds to `sig` significant digits and prints without float junk (0.1+0.2 → "0.3"), no exponent for sane ranges. */
export function fmtNum(x, sig = 12) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  if (Number.isSafeInteger(x)) return String(x);  // exact integers stay exact
  const r = Number(x.toPrecision(sig));
  const abs = Math.abs(r);
  if (abs >= 1e21 || abs < 1e-9) return r.toExponential().replace(/\.?0+e/, 'e');
  // toLocaleString avoids exponents; en-US keeps '.' as decimal point, no grouping so it can be pasted back
  return r.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20, maximumSignificantDigits: sig });
}

/** Parses a decimal number typed by a person: "1,234.5", "1_000", "1e6", " 2.5 ". */
export function parseDecimal(str) {
  const s = String(str ?? '').trim().replace(/[_\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!s) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) throw new Error(`“${str}” is not a number.`);
  return Number(s);
}

/* ------------------------------------------------------------------ integer bases */

export const BASES = [
  { key: 'dec', radix: 10, label: 'Decimal', prefix: '' },
  { key: 'hex', radix: 16, label: 'Hexadecimal', prefix: '0x' },
  { key: 'bin', radix: 2, label: 'Binary', prefix: '0b' },
  { key: 'oct', radix: 8, label: 'Octal', prefix: '0o' },
];
const DIGITS = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^[0-9]+$/, 16: /^[0-9a-f]+$/i };
const PREFIX = { '0x': 16, '0b': 2, '0o': 8 };

/**
 * Parses an integer typed in `radix` (a 0x/0b/0o prefix overrides it). Accepts a sign, underscores, spaces
 * and (for decimal) thousands commas. Returns { value: BigInt, radix } or null for empty input.
 */
export function parseInteger(str, radix = 10) {
  let s = String(str ?? '').trim().replace(/[_\s]/g, '');
  if (radix === 10) s = s.replace(/,/g, '');
  if (!s) return null;
  let neg = false;
  if (/^[+-]/.test(s)) { neg = s[0] === '-'; s = s.slice(1); }
  const p = s.slice(0, 2).toLowerCase();
  if (PREFIX[p]) { radix = PREFIX[p]; s = s.slice(2); }
  if (!s) throw new Error('Digits are missing after the prefix.');
  if (!DIGITS[radix].test(s)) {
    const bad = [...s].find((c) => !DIGITS[radix].test(c));
    throw new Error(`“${bad}” is not a ${({ 2: 'binary', 8: 'octal', 10: 'decimal', 16: 'hex' })[radix]} digit.`);
  }
  const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[radix];
  const v = BigInt(prefix + s);  // BigInt('0x…') etc. — exact at any size
  return { value: neg ? -v : v, radix };
}

/** Formats a BigInt in a radix, with optional digit grouping (every `group` digits from the right, separated by _ or space). */
export function formatInteger(v, radix, { group = 0, sep = '_', prefix = false } = {}) {
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString(radix);
  if (radix === 16) digits = digits.toUpperCase();
  if (group) digits = digits.replace(new RegExp(`\\B(?=(.{${group}})+$)`, 'g'), sep);
  const pre = prefix ? ({ 2: '0b', 8: '0o', 16: '0x', 10: '' })[radix] : '';
  return (neg ? '-' : '') + pre + digits;
}

/** Bits needed for |v| (unsigned) and for v as a two's complement signed value. */
export function bitLength(v) {
  const abs = v < 0n ? -v : v;
  const unsigned = abs === 0n ? 0 : abs.toString(2).length;
  // signed: smallest n with -2^(n-1) <= v < 2^(n-1)
  const signed = v >= 0n ? unsigned + 1 : (-v - 1n === 0n ? 1 : (-v - 1n).toString(2).length + 1);
  return { unsigned, signed };
}

/**
 * Two's complement view in `bits` (8/16/32/64…). fits=false if v is outside [-2^(b-1), 2^b - 1].
 * Returns the bit pattern as hex/bin and both interpretations of that pattern.
 */
export function twosComplement(v, bits) {
  const size = 1n << BigInt(bits);
  const fits = v >= -(size >> 1n) && v < size;
  const pattern = ((v % size) + size) % size;
  return {
    bits, fits,
    hex: pattern.toString(16).toUpperCase().padStart(bits / 4, '0'),
    bin: pattern.toString(2).padStart(bits, '0').replace(/\B(?=(.{8})+$)/g, ' '),
    unsigned: pattern,
    signed: pattern >= size >> 1n ? pattern - size : pattern,
  };
}

/** Bytes of v, big-endian, minimum width; negatives use two's complement in the smallest whole number of bytes. */
export function toBytes(v) {
  const { unsigned, signed } = bitLength(v);
  const width = Math.max(1, Math.ceil((v < 0n ? signed : unsigned) / 8));
  const size = 1n << BigInt(width * 8);
  let pattern = ((v % size) + size) % size;
  const out = [];
  for (let i = 0; i < width; i++) { out.unshift(Number(pattern & 0xffn)); pattern >>= 8n; }
  return out;
}

export const hexBytes = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/* ------------------------------------------------------------------ data sizes */

// factor = bytes per unit
export const SIZE_UNITS = [
  { key: 'b', label: 'bits (b)', factor: 1 / 8, group: 'bits' },
  { key: 'B', label: 'bytes (B)', factor: 1, group: 'bytes' },
  { key: 'KB', label: 'KB (1000)', factor: 1e3, group: 'decimal' },
  { key: 'MB', label: 'MB (1000²)', factor: 1e6, group: 'decimal' },
  { key: 'GB', label: 'GB (1000³)', factor: 1e9, group: 'decimal' },
  { key: 'TB', label: 'TB (1000⁴)', factor: 1e12, group: 'decimal' },
  { key: 'PB', label: 'PB (1000⁵)', factor: 1e15, group: 'decimal' },
  { key: 'KiB', label: 'KiB (1024)', factor: 1024, group: 'binary' },
  { key: 'MiB', label: 'MiB (1024²)', factor: 1024 ** 2, group: 'binary' },
  { key: 'GiB', label: 'GiB (1024³)', factor: 1024 ** 3, group: 'binary' },
  { key: 'TiB', label: 'TiB (1024⁴)', factor: 1024 ** 4, group: 'binary' },
  { key: 'PiB', label: 'PiB (1024⁵)', factor: 1024 ** 5, group: 'binary' },
  { key: 'Kb', label: 'Kbit (1000 b)', factor: 1e3 / 8, group: 'bits' },
  { key: 'Mb', label: 'Mbit (1000² b)', factor: 1e6 / 8, group: 'bits' },
  { key: 'Gb', label: 'Gbit (1000³ b)', factor: 1e9 / 8, group: 'bits' },
];
const SIZE_BY_KEY = Object.fromEntries(SIZE_UNITS.map((u) => [u.key, u]));
const SIZE_ALIASES = { k: 'KB', kb: 'KB', m: 'MB', mb: 'MB', g: 'GB', gb: 'GB', t: 'TB', tb: 'TB', pb: 'PB',
  kib: 'KiB', mib: 'MiB', gib: 'GiB', tib: 'TiB', pib: 'PiB', byte: 'B', bytes: 'B', bit: 'b', bits: 'b',
  kbit: 'Kb', mbit: 'Mb', gbit: 'Gb' };

/** "1.5 GiB" → { value: 1.5, unit: 'GiB' }; the unit falls back to `defaultUnit` when omitted. Case matters for b/B and Kb/KB. */
export function parseSize(str, defaultUnit = 'B') {
  const m = String(str ?? '').trim().match(/^([+-]?[\d.,_eE+-]*\d\.?)\s*([a-zA-Z]*)$/);
  if (!String(str ?? '').trim()) return null;
  if (!m) throw new Error(`Could not read “${str}” — try e.g. 1.5 GB or 700 MiB.`);
  const value = parseDecimal(m[1]);
  let unit = m[2] || defaultUnit;
  if (!SIZE_BY_KEY[unit]) unit = SIZE_ALIASES[unit.toLowerCase()];
  if (!unit) throw new Error(`Unknown unit “${m[2]}”.`);
  if (value < 0) throw new Error('Sizes cannot be negative.');
  return { value, unit };
}

export const toBytesCount = (value, unit) => value * SIZE_BY_KEY[unit].factor;

/** All units for a byte count: [{key, label, group, value(string)}]. */
export function convertSize(bytes) {
  return SIZE_UNITS.map((u) => ({ ...u, value: fmtNum(bytes / u.factor) }));
}

/** Best human unit in a family: 'decimal' (1000) or 'binary' (1024). */
export function humanSize(bytes, family = 'binary') {
  const units = family === 'decimal' ? ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const step = family === 'decimal' ? 1000 : 1024;
  let i = 0, v = bytes;
  while (Math.abs(v) >= step && i < units.length - 1) { v /= step; i++; }
  return `${fmtNum(v, 4)} ${units[i]}`;
}

// bytes per second
export const SPEED_UNITS = [
  { key: 'Kbps', label: 'Kbit/s', factor: 1e3 / 8 },
  { key: 'Mbps', label: 'Mbit/s', factor: 1e6 / 8 },
  { key: 'Gbps', label: 'Gbit/s', factor: 1e9 / 8 },
  { key: 'KB/s', label: 'KB/s', factor: 1e3 },
  { key: 'MB/s', label: 'MB/s', factor: 1e6 },
  { key: 'GB/s', label: 'GB/s', factor: 1e9 },
  { key: 'MiB/s', label: 'MiB/s', factor: 1024 ** 2 },
];

/** Seconds to move `bytes` at `speed` in `speedUnit`. */
export function transferSeconds(bytes, speed, speedUnit) {
  const u = SPEED_UNITS.find((s) => s.key === speedUnit);
  if (!u) throw new Error(`Unknown speed unit ${speedUnit}`);
  if (!(speed > 0)) throw new Error('Speed must be more than 0.');
  return bytes / (speed * u.factor);
}

/* ------------------------------------------------------------------ time units */

// nanoseconds per unit (exact integers, so conversions go through BigInt-free exact ratios where possible)
export const TIME_UNITS = [
  { key: 'ns', label: 'nanoseconds', ns: 1 },
  { key: 'µs', label: 'microseconds', ns: 1e3 },
  { key: 'ms', label: 'milliseconds', ns: 1e6 },
  { key: 's', label: 'seconds', ns: 1e9 },
  { key: 'min', label: 'minutes', ns: 60e9 },
  { key: 'h', label: 'hours', ns: 3600e9 },
  { key: 'd', label: 'days', ns: 86400e9 },
  { key: 'wk', label: 'weeks', ns: 604800e9 },
];
const TIME_ALIASES = { ns: 'ns', nanosecond: 'ns', nanoseconds: 'ns', us: 'µs', 'µs': 'µs', 'μs': 'µs', microsecond: 'µs', microseconds: 'µs',
  ms: 'ms', millisecond: 'ms', milliseconds: 'ms', s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd', w: 'wk', wk: 'wk', wks: 'wk', week: 'wk', weeks: 'wk' };
const TIME_BY_KEY = Object.fromEntries(TIME_UNITS.map((u) => [u.key, u]));

/** value in unit → [{key, label, value}] in every unit. */
export function convertTime(value, unit) {
  const ns = value * TIME_BY_KEY[unit].ns;
  return TIME_UNITS.map((u) => ({ ...u, value: fmtNum(ns / u.ns) }));
}

export const toNanoseconds = (value, unit) => value * TIME_BY_KEY[unit].ns;

/**
 * Parses "1d 2h 3m", "1h30m", "2 weeks 1 day", "90s", "1.5h" or a plain number (in `defaultUnit`) to nanoseconds.
 */
export function parseDuration(str, defaultUnit = 's') {
  const s = String(str ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s.replace(/[_,]/g, ''))) return toNanoseconds(parseDecimal(s), defaultUnit);
  let neg = false, rest = s;
  if (rest.startsWith('-')) { neg = true; rest = rest.slice(1); }
  const re = /(\d+\.?\d*|\.\d+)\s*([a-zµμ]+)\s*,?\s*(and\s+)?/gy;
  let ns = 0, m, matched = 0;
  while ((m = re.exec(rest))) {
    const unit = TIME_ALIASES[m[2]];
    if (!unit) throw new Error(`Unknown time unit “${m[2]}”.`);
    ns += Number(m[1]) * TIME_BY_KEY[unit].ns;
    matched = re.lastIndex;
  }
  if (matched !== rest.length) throw new Error(`Could not read “${str}” — try e.g. 1d 2h 3m or 90s.`);
  return neg ? -ns : ns;
}

/** Nanoseconds → "1d 2h 3m 4s 500ms" (whole units; trailing sub-second parts kept). Weeks fold into days unless weeks=true. */
export function humanDuration(ns, { weeks = false } = {}) {
  if (!Number.isFinite(ns)) return '';
  let n = BigInt(Math.round(ns));
  if (n === 0n) return '0s';
  const neg = n < 0n;
  if (neg) n = -n;
  const parts = [];
  const units = [['w', 604800n * 10n ** 9n], ['d', 86400n * 10n ** 9n], ['h', 3600n * 10n ** 9n], ['m', 60n * 10n ** 9n],
    ['s', 10n ** 9n], ['ms', 10n ** 6n], ['µs', 1000n], ['ns', 1n]].filter(([k]) => weeks || k !== 'w');
  for (const [label, size] of units) {
    const q = n / size;
    if (q) { parts.push(`${q}${label}`); n -= q * size; }
  }
  return (neg ? '-' : '') + parts.join(' ');
}
