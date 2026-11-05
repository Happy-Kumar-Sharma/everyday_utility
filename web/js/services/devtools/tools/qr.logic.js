// QR Code encoder (ISO/IEC 18004), written from scratch: no DOM, no dependencies, so node can test it.
//
// encodeQr(text, {ecl, minVersion, maxVersion, mask, mode}) -> {modules: boolean[][] (row-major, true = dark),
//   size, version, ecl, mask, mode, dataCodewords, ecCodewords, dataBits, capacityBits, penalty}
// Also exported for tests/tools: buildSegment, dataCodewords, rsGenerator, rsRemainder, formatBits, versionBits,
// alignmentPositions, penalty, wifiString, vcardString, toSvg, contrastRatio.

export const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT = { L: 1, M: 0, Q: 3, H: 2 };  // the 2 bits that go into the format information

// ECC codewords per block and number of blocks, indexed [ecl][version] (index 0 unused). From the standard's table 9.
const EC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MODES = {
  numeric: { indicator: 0b0001, countBits: [10, 12, 14] },
  alphanumeric: { indicator: 0b0010, countBits: [9, 11, 13] },
  byte: { indicator: 0b0100, countBits: [8, 16, 16] },
};

/* ------------------------------------------------------------------ sizes */
export const sizeOf = (version) => 17 + 4 * version;

/** Modules available for data + EC codewords (everything but function patterns and format/version info). */
export function rawDataModules(v) {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const align = Math.floor(v / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}
export const totalCodewords = (v) => Math.floor(rawDataModules(v) / 8);
export const dataCapacity = (v, ecl) => totalCodewords(v) - EC_PER_BLOCK[ECL[ecl]][v] * NUM_BLOCKS[ECL[ecl]][v];

/** Centre coordinates of the alignment patterns (same list for rows and columns). */
export function alignmentPositions(v) {
  if (v === 1) return [];
  const count = Math.floor(v / 7) + 2;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(v) - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/* ------------------------------------------------------------------ data encoding */
const utf8 = (s) => new TextEncoder().encode(s);

/** The densest single mode that can hold the whole text. */
export function pickMode(text) {
  if (/^[0-9]*$/.test(text)) return 'numeric';
  if ([...text].every((c) => ALNUM.includes(c))) return 'alphanumeric';
  return 'byte';
}

class Bits {
  constructor() { this.bits = []; }
  push(value, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
}

/** Payload bits for one segment (without mode indicator / count). Returns {mode, count, bits:number[]} */
export function buildSegment(text, mode = pickMode(text)) {
  const b = new Bits();
  let count;
  if (mode === 'numeric') {
    if (!/^[0-9]*$/.test(text)) throw new Error('Numeric mode only holds the digits 0–9.');
    count = text.length;
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      b.push(Number(chunk), chunk.length * 3 + 1);  // 3 digits → 10 bits, 2 → 7, 1 → 4
    }
  } else if (mode === 'alphanumeric') {
    count = text.length;
    for (let i = 0; i < text.length; i += 2) {
      const a = ALNUM.indexOf(text[i]);
      if (a < 0 || (i + 1 < text.length && ALNUM.indexOf(text[i + 1]) < 0)) throw new Error('Alphanumeric mode only holds 0–9, A–Z, space and $%*+-./:');
      if (i + 1 < text.length) b.push(a * 45 + ALNUM.indexOf(text[i + 1]), 11);
      else b.push(a, 6);
    }
  } else if (mode === 'byte') {
    const bytes = utf8(text);
    count = bytes.length;
    for (const x of bytes) b.push(x, 8);
  } else throw new Error(`Unknown mode: ${mode}`);
  return { mode, count, bits: b.bits };
}

const countBitsFor = (mode, v) => MODES[mode].countBits[v <= 9 ? 0 : v <= 26 ? 1 : 2];
const segmentBits = (seg, v) => 4 + countBitsFor(seg.mode, v) + seg.bits.length;

/** Data codewords for a segment at version v / level ecl: header, payload, terminator, byte padding, 0xEC/0x11 fill. */
export function dataCodewords(seg, v, ecl) {
  const capacityBits = dataCapacity(v, ecl) * 8;
  const b = new Bits();
  b.push(MODES[seg.mode].indicator, 4);
  const cb = countBitsFor(seg.mode, v);
  if (seg.count >= 2 ** cb) throw new Error('Too much data for this version.');
  b.push(seg.count, cb);
  b.bits.push(...seg.bits);
  if (b.length > capacityBits) throw new Error('Too much data for this version.');
  b.push(0, Math.min(4, capacityBits - b.length));
  b.push(0, (8 - (b.length % 8)) % 8);
  for (let pad = 0xEC; b.length < capacityBits; pad ^= 0xEC ^ 0x11) b.push(pad, 8);
  const out = new Uint8Array(b.length / 8);
  b.bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

/* ------------------------------------------------------------------ Reed–Solomon over GF(256), poly 0x11D */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
export const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial ∏(x − α^i), i = 0..degree−1; coefficients high→low, leading 1 included. */
export function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gfMul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}

/** EC codewords: remainder of data(x)·x^n divided by the generator. */
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree).slice(1);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

/** Split data into blocks, add EC to each, interleave. Returns {codewords, ecBlocks}. */
export function interleave(data, v, ecl) {
  const nBlocks = NUM_BLOCKS[ECL[ecl]][v], ecLen = EC_PER_BLOCK[ECL[ecl]][v];
  const raw = totalCodewords(v);
  const numShort = nBlocks - (raw % nBlocks);
  const shortData = Math.floor(raw / nBlocks) - ecLen;
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortData + (i < numShort ? 0 : 1);
    const d = Array.from(data.slice(k, k + len));
    k += len;
    blocks.push({ d, ec: rsRemainder(d, ecLen) });
  }
  const out = [];
  for (let i = 0; i <= shortData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return { codewords: out, ecBlocks: blocks.map((b) => b.ec) };
}

/* ------------------------------------------------------------------ BCH format / version info */
/** 15-bit format information (already XOR-masked with 101010000010010). */
export function formatBits(ecl, mask) {
  const data = (ECL_FORMAT[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions ≥ 7). */
export function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (v << 12) | rem;
}

/* ------------------------------------------------------------------ matrix */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function grid(size, fill) { return Array.from({ length: size }, () => new Array(size).fill(fill)); }

/** Function patterns: finders + separators, timing, alignment, dark module, reserved format/version areas. */
function functionPatterns(v) {
  const size = sizeOf(v);
  const m = grid(size, false), fn = grid(size, false);
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }  // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {  // finders + separator ring
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignmentPositions(v);
  for (const ay of al) for (const ax of al) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;  // overlaps a finder
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(m, fn, 0, 'L', true);  // reserve; real bits are drawn per mask
  if (v >= 7) {
    const bits = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  return { m, fn, size };
}

function drawFormat(m, fn, mask, ecl, reserveOnly = false) {
  const size = m.length;
  const bits = reserveOnly ? 0 : formatBits(ecl, mask);
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);  // the dark module
}

/** Reads the 15 format bits back out of the top-left copy (bit 14 first) — used by tests. */
export function readFormat(modules, copy = 1) {
  const size = modules.length;
  const g = (x, y) => (modules[y][x] ? 1 : 0);
  let bits = 0;
  const at = [];
  if (copy === 1) {
    for (let i = 0; i <= 5; i++) at[i] = [8, i];
    at[6] = [8, 7]; at[7] = [8, 8]; at[8] = [7, 8];
    for (let i = 9; i < 15; i++) at[i] = [14 - i, 8];
  } else {
    for (let i = 0; i < 8; i++) at[i] = [size - 1 - i, 8];
    for (let i = 8; i < 15; i++) at[i] = [8, size - 15 + i];
  }
  for (let i = 0; i < 15; i++) bits |= g(...at[i]) << i;
  return bits;
}

function placeCodewords(m, fn, codewords) {
  const size = m.length;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;  // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        m[y][x] = i < total ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;  // remainder bits are 0
        i++;
      }
    }
  }
}

function applyMask(m, fn, mask) {
  const f = MASKS[mask];
  const out = m.map((row) => row.slice());
  for (let y = 0; y < out.length; y++) for (let x = 0; x < out.length; x++) if (!fn[y][x] && f(x, y)) out[y][x] = !out[y][x];
  return out;
}

/* ------------------------------------------------------------------ penalty (ISO 18004 §7.8.3) */
const FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function linePenalty(line) {
  let p = 0;
  // rule 1: runs of ≥ 5 same-colour modules: 3 + (run − 5)
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) run++;
    else { if (run >= 5) p += run - 2; run = 1; }
  }
  // rule 3: 1:1:3:1:1 finder-like pattern with 4 light modules on one side (outside the symbol counts as light)
  const pad = [0, 0, 0, 0, ...line.map(Number), 0, 0, 0, 0];
  for (let i = 0; i + 11 <= pad.length; i++) {
    if (FINDER_A.every((b, k) => pad[i + k] === b)) p += 40;
    if (FINDER_B.every((b, k) => pad[i + k] === b)) p += 40;
  }
  return p;
}

export function penalty(m) {
  const size = m.length;
  let p = 0, dark = 0;
  for (let y = 0; y < size; y++) {
    p += linePenalty(m[y]);
    p += linePenalty(m.map((row) => row[y]));
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {  // rule 2: 2×2 blocks
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  for (const row of m) for (const c of row) if (c) dark++;
  const k = Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5);  // rule 4: dark ratio away from 50%
  return p + k * 10;
}

/* ------------------------------------------------------------------ public encoder */
export function encodeQr(text, { ecl = 'M', minVersion = 1, maxVersion = 40, mask = -1, mode } = {}) {
  if (!(ecl in ECL)) throw new Error(`Unknown error-correction level: ${ecl}`);
  const seg = buildSegment(String(text ?? ''), mode || pickMode(String(text ?? '')));
  let v = minVersion;
  for (; v <= maxVersion; v++) {
    const cb = countBitsFor(seg.mode, v);
    if (seg.count < 2 ** cb && segmentBits(seg, v) <= dataCapacity(v, ecl) * 8) break;
  }
  if (v > maxVersion) {
    const max = maxCapacity(seg.mode, ecl);
    throw new Error(`Too long for a QR code at level ${ecl}: ${seg.count} ${seg.mode === 'byte' ? 'bytes' : 'characters'} (max ${max} in ${seg.mode} mode). Use a lower error-correction level or shorter text.`);
  }
  const data = dataCodewords(seg, v, ecl);
  const { codewords } = interleave(data, v, ecl);
  const { m, fn, size } = functionPatterns(v);
  placeCodewords(m, fn, codewords);
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask >= 0 && k !== mask) continue;
    const mm = applyMask(m, fn, k);
    drawFormat(mm, fn.map((r) => r.slice()), k, ecl);
    const score = penalty(mm);
    if (!best || score < best.penalty) best = { modules: mm, mask: k, penalty: score };
  }
  return {
    modules: best.modules, size, version: v, ecl, mask: best.mask, mode: seg.mode, penalty: best.penalty,
    dataCodewords: Array.from(data), codewords, count: seg.count,
    dataBits: segmentBits(seg, v), capacityBits: dataCapacity(v, ecl) * 8,
  };
}

/** Largest number of characters (bytes for byte mode) that fit at version 40. */
export function maxCapacity(mode, ecl) {
  const bits = dataCapacity(40, ecl) * 8 - 4 - countBitsFor(mode, 40);
  if (mode === 'numeric') return Math.floor(bits / 10) * 3 + (bits % 10 >= 7 ? 2 : bits % 10 >= 4 ? 1 : 0);
  if (mode === 'alphanumeric') return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
  return Math.floor(bits / 8);
}

/* ------------------------------------------------------------------ payload presets */
const wifiEscape = (s) => String(s ?? '').replace(/([\\;,:"])/g, '\\$1');

/** WIFI:T:WPA;S:<ssid>;P:<pass>;H:true;; — security is WPA, WEP or nopass. */
export function wifiString({ ssid = '', password = '', security = 'WPA', hidden = false } = {}) {
  const t = security === 'nopass' ? 'nopass' : security;
  let s = `WIFI:T:${t};S:${wifiEscape(ssid)};`;
  if (t !== 'nopass') s += `P:${wifiEscape(password)};`;
  if (hidden) s += 'H:true;';
  return `${s};`;
}

const vEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Minimal vCard 3.0. */
export function vcardString({ first = '', last = '', org = '', title = '', phone = '', email = '', url = '' } = {}) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0',
    `N:${vEscape(last)};${vEscape(first)};;;`, `FN:${vEscape([first, last].filter(Boolean).join(' '))}`];
  if (org) lines.push(`ORG:${vEscape(org)}`);
  if (title) lines.push(`TITLE:${vEscape(title)}`);
  if (phone) lines.push(`TEL;TYPE=CELL:${vEscape(phone)}`);
  if (email) lines.push(`EMAIL:${vEscape(email)}`);
  if (url) lines.push(`URL:${vEscape(url)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

/* ------------------------------------------------------------------ rendering helpers */
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const HEX = /^#[0-9a-fA-F]{6}$/;

/** SVG markup built as an escaped string: one path for all dark modules. */
export function toSvg(modules, { quiet = 4, scale = 8, dark = '#000000', light = '#ffffff', title = '' } = {}) {
  const n = modules.length, full = n + quiet * 2;
  const d = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      let w = 1;
      while (x + w < n && modules[y][x + w]) w++;
      d.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
      x += w - 1;
    }
  }
  const fg = HEX.test(dark) ? dark : '#000000', bg = HEX.test(light) ? light : '#ffffff';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${full * scale}" height="${full * scale}" shape-rendering="crispEdges">`
    + (title ? `<title>${xmlEscape(title)}</title>` : '')
    + `<rect width="100%" height="100%" fill="${xmlEscape(bg)}"/><path fill="${xmlEscape(fg)}" d="${d.join('')}"/></svg>\n`;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
