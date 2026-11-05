// Unicode inspector logic: per-character info, text summary and clean-up transforms. Pure, no DOM.
// Works on code points (surrogate pairs stay together; lone surrogates are reported) and, for display, on grapheme
// clusters via Intl.Segmenter (so "e + ◌́", flags and ZWJ emoji families are one chip).

/* ------------------------------------------------------------------ names of the characters people trip over */
const NAMES = {
  0x0000: ['NULL', 'NUL'], 0x0009: ['CHARACTER TABULATION', 'TAB'], 0x000A: ['LINE FEED', 'LF'], 0x000B: ['LINE TABULATION', 'VT'],
  0x000C: ['FORM FEED', 'FF'], 0x000D: ['CARRIAGE RETURN', 'CR'], 0x001B: ['ESCAPE', 'ESC'], 0x0020: ['SPACE', 'SP'],
  0x007F: ['DELETE', 'DEL'], 0x0085: ['NEXT LINE', 'NEL'], 0x00A0: ['NO-BREAK SPACE', 'NBSP'], 0x00AD: ['SOFT HYPHEN', 'SHY'],
  0x034F: ['COMBINING GRAPHEME JOINER', 'CGJ'], 0x061C: ['ARABIC LETTER MARK', 'ALM'], 0x115F: ['HANGUL CHOSEONG FILLER', 'HCF'],
  0x1160: ['HANGUL JUNGSEONG FILLER', 'HJF'], 0x180E: ['MONGOLIAN VOWEL SEPARATOR', 'MVS'],
  0x2000: ['EN QUAD', 'NQSP'], 0x2001: ['EM QUAD', 'MQSP'], 0x2002: ['EN SPACE', 'ENSP'], 0x2003: ['EM SPACE', 'EMSP'],
  0x2004: ['THREE-PER-EM SPACE', '3/MSP'], 0x2005: ['FOUR-PER-EM SPACE', '4/MSP'], 0x2006: ['SIX-PER-EM SPACE', '6/MSP'],
  0x2007: ['FIGURE SPACE', 'FSP'], 0x2008: ['PUNCTUATION SPACE', 'PSP'], 0x2009: ['THIN SPACE', 'THSP'], 0x200A: ['HAIR SPACE', 'HSP'],
  0x200B: ['ZERO WIDTH SPACE', 'ZWSP'], 0x200C: ['ZERO WIDTH NON-JOINER', 'ZWNJ'], 0x200D: ['ZERO WIDTH JOINER', 'ZWJ'],
  0x200E: ['LEFT-TO-RIGHT MARK', 'LRM'], 0x200F: ['RIGHT-TO-LEFT MARK', 'RLM'],
  0x2010: ['HYPHEN', '‐'], 0x2011: ['NON-BREAKING HYPHEN', 'NBH'], 0x2012: ['FIGURE DASH', '‒'], 0x2013: ['EN DASH', '–'],
  0x2014: ['EM DASH', '—'], 0x2018: ['LEFT SINGLE QUOTATION MARK', '‘'], 0x2019: ['RIGHT SINGLE QUOTATION MARK', '’'],
  0x201C: ['LEFT DOUBLE QUOTATION MARK', '“'], 0x201D: ['RIGHT DOUBLE QUOTATION MARK', '”'], 0x2026: ['HORIZONTAL ELLIPSIS', '…'],
  0x2028: ['LINE SEPARATOR', 'LS'], 0x2029: ['PARAGRAPH SEPARATOR', 'PS'],
  0x202A: ['LEFT-TO-RIGHT EMBEDDING', 'LRE'], 0x202B: ['RIGHT-TO-LEFT EMBEDDING', 'RLE'], 0x202C: ['POP DIRECTIONAL FORMATTING', 'PDF'],
  0x202D: ['LEFT-TO-RIGHT OVERRIDE', 'LRO'], 0x202E: ['RIGHT-TO-LEFT OVERRIDE', 'RLO'], 0x202F: ['NARROW NO-BREAK SPACE', 'NNBSP'],
  0x205F: ['MEDIUM MATHEMATICAL SPACE', 'MMSP'], 0x2060: ['WORD JOINER', 'WJ'], 0x2061: ['FUNCTION APPLICATION', 'FA'],
  0x2062: ['INVISIBLE TIMES', 'IT'], 0x2063: ['INVISIBLE SEPARATOR', 'IS'], 0x2064: ['INVISIBLE PLUS', 'IP'],
  0x2066: ['LEFT-TO-RIGHT ISOLATE', 'LRI'], 0x2067: ['RIGHT-TO-LEFT ISOLATE', 'RLI'], 0x2068: ['FIRST STRONG ISOLATE', 'FSI'],
  0x2069: ['POP DIRECTIONAL ISOLATE', 'PDI'], 0x2212: ['MINUS SIGN', '−'], 0x3000: ['IDEOGRAPHIC SPACE', 'IDSP'],
  0x3164: ['HANGUL FILLER', 'HF'], 0xFE0E: ['VARIATION SELECTOR-15 (text style)', 'VS15'], 0xFE0F: ['VARIATION SELECTOR-16 (emoji style)', 'VS16'],
  0xFEFF: ['ZERO WIDTH NO-BREAK SPACE / BYTE ORDER MARK', 'BOM'], 0xFFA0: ['HALFWIDTH HANGUL FILLER', 'HHF'],
  0xFFFC: ['OBJECT REPLACEMENT CHARACTER', 'OBJ'], 0xFFFD: ['REPLACEMENT CHARACTER', '�'],
  0x1F3FB: ['EMOJI MODIFIER FITZPATRICK TYPE-1-2', '🏻'], 0x1F3FC: ['EMOJI MODIFIER FITZPATRICK TYPE-3', '🏼'],
  0x1F3FD: ['EMOJI MODIFIER FITZPATRICK TYPE-4', '🏽'], 0x1F3FE: ['EMOJI MODIFIER FITZPATRICK TYPE-5', '🏾'],
  0x1F3FF: ['EMOJI MODIFIER FITZPATRICK TYPE-6', '🏿'], 0xE0001: ['LANGUAGE TAG', 'TAG'], 0xE007F: ['CANCEL TAG', 'TAG'],
};

/** Cyrillic / Greek letters that look like Latin ones: code point -> [name, Latin look-alike]. */
export const HOMOGLYPHS = {
  0x0430: ['CYRILLIC SMALL LETTER A', 'a'], 0x0435: ['CYRILLIC SMALL LETTER IE', 'e'], 0x043E: ['CYRILLIC SMALL LETTER O', 'o'],
  0x0440: ['CYRILLIC SMALL LETTER ER', 'p'], 0x0441: ['CYRILLIC SMALL LETTER ES', 'c'], 0x0445: ['CYRILLIC SMALL LETTER HA', 'x'],
  0x0443: ['CYRILLIC SMALL LETTER U', 'y'], 0x0456: ['CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I', 'i'],
  0x0458: ['CYRILLIC SMALL LETTER JE', 'j'], 0x0455: ['CYRILLIC SMALL LETTER DZE', 's'], 0x04BB: ['CYRILLIC SMALL LETTER SHHA', 'h'],
  0x0501: ['CYRILLIC SMALL LETTER KOMI DE', 'd'], 0x051B: ['CYRILLIC SMALL LETTER QA', 'q'], 0x051D: ['CYRILLIC SMALL LETTER WE', 'w'],
  0x0410: ['CYRILLIC CAPITAL LETTER A', 'A'], 0x0412: ['CYRILLIC CAPITAL LETTER VE', 'B'], 0x0415: ['CYRILLIC CAPITAL LETTER IE', 'E'],
  0x041A: ['CYRILLIC CAPITAL LETTER KA', 'K'], 0x041C: ['CYRILLIC CAPITAL LETTER EM', 'M'], 0x041D: ['CYRILLIC CAPITAL LETTER EN', 'H'],
  0x041E: ['CYRILLIC CAPITAL LETTER O', 'O'], 0x0420: ['CYRILLIC CAPITAL LETTER ER', 'P'], 0x0421: ['CYRILLIC CAPITAL LETTER ES', 'C'],
  0x0422: ['CYRILLIC CAPITAL LETTER TE', 'T'], 0x0425: ['CYRILLIC CAPITAL LETTER HA', 'X'], 0x0423: ['CYRILLIC CAPITAL LETTER U', 'Y'],
  0x0405: ['CYRILLIC CAPITAL LETTER DZE', 'S'], 0x0406: ['CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I', 'I'],
  0x0408: ['CYRILLIC CAPITAL LETTER JE', 'J'],
  0x03BF: ['GREEK SMALL LETTER OMICRON', 'o'], 0x03BD: ['GREEK SMALL LETTER NU', 'v'], 0x0391: ['GREEK CAPITAL LETTER ALPHA', 'A'],
  0x0392: ['GREEK CAPITAL LETTER BETA', 'B'], 0x0395: ['GREEK CAPITAL LETTER EPSILON', 'E'], 0x0396: ['GREEK CAPITAL LETTER ZETA', 'Z'],
  0x0397: ['GREEK CAPITAL LETTER ETA', 'H'], 0x0399: ['GREEK CAPITAL LETTER IOTA', 'I'], 0x039A: ['GREEK CAPITAL LETTER KAPPA', 'K'],
  0x039C: ['GREEK CAPITAL LETTER MU', 'M'], 0x039D: ['GREEK CAPITAL LETTER NU', 'N'], 0x039F: ['GREEK CAPITAL LETTER OMICRON', 'O'],
  0x03A1: ['GREEK CAPITAL LETTER RHO', 'P'], 0x03A4: ['GREEK CAPITAL LETTER TAU', 'T'], 0x03A5: ['GREEK CAPITAL LETTER UPSILON', 'Y'],
  0x03A7: ['GREEK CAPITAL LETTER CHI', 'X'],
};

const BIDI = new Set([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
/** The explicit embedding/override/isolate controls used in "Trojan Source" attacks (CVE-2021-42574). */
export const TROJAN = new Set([0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZERO_WIDTH = new Set([0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x180E, 0x00AD, 0x034F, 0x2061, 0x2062, 0x2063, 0x2064]);
const ODD_SPACES = new Set([0x00A0, 0x202F, 0x2007, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009,
  0x200A, 0x205F, 0x3000]);

export const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** UTF-8 bytes of one code point as "E2 80 8B"; null for a lone surrogate (not encodable). */
export function utf8(cp) {
  if (cp >= 0xD800 && cp <= 0xDFFF) return null;
  const b = cp < 0x80 ? [cp]
    : cp < 0x800 ? [0xC0 | (cp >> 6), 0x80 | (cp & 63)]
      : cp < 0x10000 ? [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)]
        : [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

const RX = {
  emoji: /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u,
  letter: /\p{L}/u, mark: /\p{M}/u, number: /\p{N}/u, space: /[\p{Zs}\p{Zl}\p{Zp}]/u, control: /\p{Cc}/u, format: /\p{Cf}/u,
  punct: /\p{P}/u, symbol: /\p{S}/u, surrogate: /\p{Cs}/u, private: /\p{Co}/u, unassigned: /\p{Cn}/u,
};
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Devanagari', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Georgian'];
const SCRIPT_RX = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]);

export function category(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xD800 && cp <= 0xDFFF && ch.length === 1) return 'surrogate';
  if (RX.emoji.test(ch) && cp > 0xFF) return 'emoji';
  for (const k of ['letter', 'mark', 'number', 'space', 'control', 'format', 'punct', 'symbol', 'private', 'unassigned']) if (RX[k].test(ch)) return k;
  return 'other';
}

export function scriptOf(ch) {
  for (const [name, rx] of SCRIPT_RX) if (rx.test(ch)) return name;
  return null;
}

/** Everything known about one code point. */
export function charInfo(cp) {
  const ch = String.fromCodePoint(cp);
  const cat = category(ch);
  const homo = HOMOGLYPHS[cp];
  let name = NAMES[cp]?.[0] || homo?.[0] || null;
  if (!name && cp < 0x20) name = `CONTROL ${hex(cp)}`;
  if (!name && cp >= 0xE0020 && cp <= 0xE007E) name = `TAG ${String.fromCharCode(cp - 0xE0000)}`;
  if (!name && cp >= 0xFE00 && cp <= 0xFE0F) name = `VARIATION SELECTOR-${cp - 0xFE00 + 1}`;
  if (!name && cat === 'surrogate') name = 'LONE SURROGATE (invalid UTF-16)';
  const flags = [];
  if (BIDI.has(cp)) flags.push(TROJAN.has(cp) ? 'bidi-control' : 'bidi-mark');
  if (ZERO_WIDTH.has(cp)) flags.push('zero-width');
  if (ODD_SPACES.has(cp)) flags.push('odd-space');
  if (homo) flags.push('homoglyph');
  if (cp === 0xFEFF) flags.push('bom');
  if (cp > 0x7F) flags.push('non-ascii');
  const invisible = isInvisible(cp, cat);
  return { cp, ch, hex: hex(cp), name, short: NAMES[cp]?.[1] || null, category: cat, utf8: utf8(cp), invisible, flags,
    looksLike: homo?.[1] || null, script: cat === 'letter' ? scriptOf(ch) : null };
}

/** Characters you can't see (or can't tell apart from a plain space) in most editors. */
function isInvisible(cp, cat = category(String.fromCodePoint(cp))) {
  if (cp === 0x0A || cp === 0x0D || cp === 0x09 || cp === 0x20) return false;  // ordinary whitespace, shown but not flagged
  return cat === 'control' || cat === 'format' || ZERO_WIDTH.has(cp) || ODD_SPACES.has(cp) || BIDI.has(cp)
    || cp === 0x2028 || cp === 0x2029 || cp === 0x3164 || cp === 0x115F || cp === 0x1160 || cp === 0xFFA0
    || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0000 && cp <= 0xE007F) || cat === 'surrogate';
}

/** A visible stand-in for a grapheme's glyph in a chip. */
export function displayGlyph(text) {
  if (text === '\r\n') return '␍␊';
  const cps = [...text].map((c) => c.codePointAt(0));
  if (cps.length === 1) {
    const cp = cps[0];
    if (cp === 0x20) return '␠';
    if (cp === 0x09) return '⇥';
    if (cp === 0x0A) return '␊';
    if (cp === 0x0D) return '␍';
    if (cp < 0x20) return String.fromCodePoint(0x2400 + cp);  // Control Pictures
    if (cp === 0x7F) return '␡';
    const info = charInfo(cp);
    if (info.invisible) return info.short || '◌';
    if (info.category === 'mark') return `◌${text}`;
  }
  // grapheme with only invisible members (e.g. ZWJ + VS16) would render as nothing
  if (cps.every((cp) => isInvisible(cp))) return cps.map((cp) => NAMES[cp]?.[1] || '◌').join('+');
  return text;
}

/* ------------------------------------------------------------------ text analysis */
export const RENDER_CAP = 5000;

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]();
  }
  // fallback: code points
  let index = 0;
  const it = text[Symbol.iterator]();
  return { next() { const r = it.next(); if (r.done) return r; const v = { segment: r.value, index }; index += r.value.length; return { value: v, done: false }; } };
}

/**
 * analyze(text, cap) -> { chars: [{text, index, display, cps:[info], invisible, flags}] (first `cap` graphemes),
 *   truncated, summary }
 */
export function analyze(text, cap = RENDER_CAP) {
  const chars = [];
  const it = graphemes(text);
  let total = 0;
  for (let r = it.next(); !r.done; r = it.next()) {
    total += 1;
    if (chars.length >= cap) continue;
    const { segment, index } = r.value;
    const cps = [...segment].map((c) => charInfo(c.codePointAt(0)));
    const flags = [...new Set(cps.flatMap((c) => c.flags))];
    chars.push({ text: segment, index, display: displayGlyph(segment), cps, invisible: cps.some((c) => c.invisible), flags,
      crlf: segment === '\r\n' });
  }
  return { chars, truncated: total > chars.length, graphemes: total, summary: summarize(text) };
}

/** Whole-text summary (fast, no per-character objects). */
export function summarize(text) {
  let lf = 0, crlf = 0, cr = 0, ls = 0, invisible = 0, nonAscii = 0, bidi = 0, trojan = 0, zeroWidth = 0, oddSpaces = 0,
    homoglyphs = 0, codePoints = 0, utf8Bytes = 0, loneSurrogates = 0, boms = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x0D) { if (text.charCodeAt(i + 1) === 0x0A) { crlf += 1; i += 1; codePoints += 2; utf8Bytes += 2; continue; } cr += 1; }
    else if (c === 0x0A) lf += 1;
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0D || cp === 0x0A) continue;  // counted above (CRLF pairs too)
    codePoints += 1;
    utf8Bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (cp < 0x80) continue;
    nonAscii += 1;
    if (cp >= 0xD800 && cp <= 0xDFFF) { loneSurrogates += 1; invisible += 1; continue; }
    if (cp === 0x2028 || cp === 0x2029) ls += 1;
    if (BIDI.has(cp)) bidi += 1;
    if (TROJAN.has(cp)) trojan += 1;
    if (ZERO_WIDTH.has(cp)) zeroWidth += 1;
    if (ODD_SPACES.has(cp)) oddSpaces += 1;
    if (HOMOGLYPHS[cp]) homoglyphs += 1;
    if (cp === 0xFEFF) boms += 1;
    if (isInvisible(cp)) invisible += 1;
  }
  // control characters below 0x80 other than tab/LF/CR are invisible too
  for (const m of text.matchAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g)) if (m) invisible += 1;
  codePoints += lf + cr;
  utf8Bytes += lf + cr;
  const kinds = [lf && 'LF', crlf && 'CRLF', cr && 'CR'].filter(Boolean);
  const lineEndings = kinds.length > 1 ? 'mixed' : kinds[0] || 'none';
  return { lineEndings, lf, crlf, cr, lineSeparators: ls, lines: text ? lf + crlf + cr + 1 : 0,
    bom: text.charCodeAt(0) === 0xFEFF, boms, invisible, nonAscii, bidi, trojan, zeroWidth, oddSpaces, homoglyphs,
    loneSurrogates, codePoints, utf16Units: text.length, utf8Bytes, mixedScripts: mixedScripts(text) };
}

/** Words mixing Latin with Cyrillic/Greek letters (classic look-alike spoofing): {scripts, words}. */
export function mixedScripts(text, limit = 20) {
  const scripts = new Set();
  const words = [];
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
    const set = new Set();
    for (const ch of m[0]) { const s = /\p{L}/u.test(ch) ? scriptOf(ch) : null; if (s) { set.add(s); scripts.add(s); } }
    const confusable = ['Latin', 'Cyrillic', 'Greek'].filter((s) => set.has(s));
    if (confusable.length > 1 && words.length < limit && !words.some((w) => w.word === m[0])) words.push({ word: m[0], scripts: confusable, index: m.index });
  }
  return { scripts: [...scripts], words };
}

/* ------------------------------------------------------------------ clean-up transforms */
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/u;

export const clean = {
  stripBom: (t) => t.replace(/^﻿/, ''),
  /** zero-width chars, soft hyphens and the BOM; a ZWJ inside an emoji sequence (👨‍👩‍👧) is kept */
  removeZeroWidth(t) {
    const out = [];
    const cps = [...t];
    for (let i = 0; i < cps.length; i += 1) {
      const cp = cps[i].codePointAt(0);
      if (!ZERO_WIDTH.has(cp)) { out.push(cps[i]); continue; }
      if (cp === 0x200D && i > 0 && i + 1 < cps.length && EMOJI_PART.test(cps[i - 1]) && /\p{Extended_Pictographic}/u.test(cps[i + 1])) out.push(cps[i]);
    }
    return out.join('');
  },
  nbspToSpace: (t) => t.replace(/[    -  -  　]/g, ' '),
  removeBidi: (t) => t.replace(/[؜‎‏‪-‮⁦-⁩]/g, ''),
  eol: (t, kind = 'LF') => t.replace(/\r\n|\r|\n/g, kind === 'CRLF' ? '\r\n' : '\n'),
  normalize: (t, form = 'NFC') => t.normalize(form),
  /** Cyrillic/Greek look-alikes → the Latin letters they imitate, only in words that also contain Latin letters
   *  (so "pаypаl" is fixed but a genuine Russian or Greek word is left alone) */
  homoglyphs: (t) => t.replace(/[\p{L}\p{M}\p{N}_]+/gu, (w) => (/\p{Script=Latin}/u.test(w)
    ? w.replace(/[\u0370-\u052F]/g, (ch) => HOMOGLYPHS[ch.codePointAt(0)]?.[1] ?? ch) : w)),
  /** é → e, ß → ss, “ ” → " … ; anything without an ASCII equivalent is kept */
  asciiFold(t) {
    const MAP = { ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', ı: 'i',
      þ: 'th', Þ: 'Th', ð: 'd', Ð: 'D', ħ: 'h', Ħ: 'H', ŋ: 'n', Ŋ: 'N', ſ: 's',
      '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
      '‹': "'", '›': "'", '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-', '…': '...', '•': '*',
      ' ': ' ', ' ': ' ', ' ': ' ', '×': 'x', '÷': '/', '€': 'EUR', '£': 'GBP', '©': '(c)', '®': '(r)', '™': 'TM' };
    let out = '';
    for (const ch of t) {
      if (ch.charCodeAt(0) < 0x80) { out += ch; continue; }
      if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
      const folded = ch.normalize('NFKD').replace(/\p{M}/gu, '');
      out += /^[\x00-\x7F]+$/.test(folded) && folded ? folded : ch;
    }
    return out;
  },
};

/** Applies the named clean-up steps in a fixed, sensible order. steps: Set/array of names. */
export function applyClean(text, steps, { eol = 'LF', form = 'NFC' } = {}) {
  const on = new Set(steps);
  let t = text;
  if (on.has('bom')) t = clean.stripBom(t);
  if (on.has('zw')) t = clean.removeZeroWidth(t);
  if (on.has('bidi')) t = clean.removeBidi(t);
  if (on.has('nbsp')) t = clean.nbspToSpace(t);
  if (on.has('eol')) t = clean.eol(t, eol);
  if (on.has('normalize')) t = clean.normalize(t, form);
  if (on.has('homoglyphs')) t = clean.homoglyphs(t);
  if (on.has('fold')) t = clean.asciiFold(t);
  return t;
}
