// Color logic (no DOM): CSS color parsing, conversions (hex/rgb/hsl/hwb/oklch), WCAG contrast, tints and harmonies.
// A color is { r, g, b, a } with r/g/b in 0..255 (may be fractional) and a in 0..1.

// The 148 CSS named colors (CSS Color 4, incl. rebeccapurple and grey/gray spellings).
const NAMED_TEXT = `
aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4
black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0
chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff
darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9
darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000
darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f
darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969
dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc
ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080
honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa
lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff
lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1
lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899
lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000
mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371
mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585
midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080
oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa
palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f
pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f
royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee
sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa
springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0
violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32
`.trim().split(/\s+/);
export const NAMED = Object.freeze(Object.fromEntries(Array.from({ length: NAMED_TEXT.length / 2 }, (_, i) => [NAMED_TEXT[2 * i], `#${NAMED_TEXT[2 * i + 1]}`])));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 0) => { const f = 10 ** d; const r = Math.round(v * f) / f; return Object.is(r, -0) ? 0 : r; };

function parseHex(hex) {
  const h = hex.replace(/^#/, '');
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const n = (i) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? round(n(6) / 255, 4) : 1 };
}

/** "50%" → 0.5*scale, "120" → 120; null if malformed. */
function num(tok, scale = 1) {
  if (tok === undefined) return null;
  if (tok === 'none') return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(tok);
  if (!m) return null;
  return m[2] ? (Number(m[1]) / 100) * scale : Number(m[1]);
}

function hue(tok) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|turn|rad|grad)?$/i.exec(tok ?? '');
  if (!m) return tok === 'none' ? 0 : null;
  const v = Number(m[1]);
  const deg = { turn: v * 360, rad: (v * 180) / Math.PI, grad: v * 0.9 }[m[2]?.toLowerCase()] ?? v;
  return ((deg % 360) + 360) % 360;
}

const alpha = (tok) => (tok === undefined ? 1 : num(tok, 1));

/** Splits "rgb(1, 2, 3 / 50%)" style arguments → [name, [a, b, c], alphaToken]; legacy comma syntax allowed. */
function fnArgs(str) {
  const m = /^([a-z]+)\(\s*(.*?)\s*\)$/i.exec(str);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const body = m[2];
  let parts, a;
  if (body.includes(',')) {
    parts = body.split(/\s*,\s*/);
    if (parts.length === 4) a = parts.pop();
  } else {
    const [main, al] = body.split(/\s*\/\s*/);
    parts = main.split(/\s+/);
    a = al;
  }
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return [name, parts, a];
}

export function hslToRgb(h, s, l) {
  s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const f = (n) => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export function hwbToRgb(h, w, b) {
  w = clamp(w, 0, 1); b = clamp(b, 0, 1);
  if (w + b >= 1) { const gray = (w / (w + b)) * 255; return { r: gray, g: gray, b: gray }; }
  const c = hslToRgb(h, 1, 0.5);
  const f = (v) => (v / 255) * (1 - w - b) * 255 + w * 255;
  return { r: f(c.r), g: f(c.g), b: f(c.b) };
}

/** Parses any supported CSS color string → {r,g,b,a}; throws a friendly error otherwise. */
export function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/;$/, '');
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[s]) return parseHex(NAMED[s]);
  if (s.startsWith('#') || /^[0-9a-f]{6}$|^[0-9a-f]{8}$/.test(s)) {
    const c = parseHex(s);
    if (c) return c;
    throw new Error('Hex colors have 3, 4, 6 or 8 hex digits: #fa0, #fa08, #ffaa00, #ffaa0080.');
  }
  const f = fnArgs(s);
  if (!f) throw new Error(`“${input}” is not a color I know — try #ff8800, rgb(255 136 0), hsl(32 100% 50%), hwb(…) or a CSS name.`);
  const [name, [x, y, z], at] = f;
  const a = alpha(at);
  let c = null;
  if (name === 'rgb' || name === 'rgba') {
    const [r, g, b] = [x, y, z].map((t) => num(t, 255));
    if ([r, g, b].every((v) => v !== null)) c = { r, g, b };
  } else if (name === 'hsl' || name === 'hsla') {
    const h = hue(x), sat = num(y.endsWith('%') ? y : `${y}%`, 1), l = num(z.endsWith('%') ? z : `${z}%`, 1);
    if (h !== null && sat !== null && l !== null) c = hslToRgb(h, sat, l);
  } else if (name === 'hwb') {
    const h = hue(x), w = num(y.endsWith('%') ? y : `${y}%`, 1), bl = num(z.endsWith('%') ? z : `${z}%`, 1);
    if (h !== null && w !== null && bl !== null) c = hwbToRgb(h, w, bl);
  } else {
    throw new Error(`${name}() is not supported here — use rgb(), hsl(), hwb(), hex or a CSS name.`);
  }
  if (!c || a === null) throw new Error(`Could not read the values in “${input}”.`);
  return { r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255), a: round(clamp(a, 0, 1), 4) };
}

/* ------------------------------------------------------------------ output formats */

const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
export const toHex = (c, { alpha: withAlpha = true } = {}) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${withAlpha && c.a < 1 ? hex2(c.a * 255) : ''}`;
const aPart = (c) => (c.a < 1 ? ` / ${round(c.a * 100, 1)}%` : '');
export const toRgb = (c) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}${aPart(c)})`;

export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}
export function toHsl(c) {
  const { h, s, l } = rgbToHsl(c);
  return `hsl(${round(h, 1)} ${round(s * 100, 1)}% ${round(l * 100, 1)}%${aPart(c)})`;
}

export function rgbToHwb(c) {
  const { h } = rgbToHsl(c);
  const w = Math.min(c.r, c.g, c.b) / 255, bl = 1 - Math.max(c.r, c.g, c.b) / 255;
  return { h, w, b: bl };
}
export function toHwb(c) {
  const { h, w, b } = rgbToHwb(c);
  return `hwb(${round(h, 1)} ${round(w * 100, 1)}% ${round(b * 100, 1)}%${aPart(c)})`;
}

const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

/** sRGB → OKLCH (Björn Ottosson's OKLab matrices). */
export function rgbToOklch(c) {
  const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.sqrt(A * A + B * B);
  const H = C < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c: C, h: H };
}
export function toOklch(c) {
  const { l, c: ch, h } = rgbToOklch(c);
  return `oklch(${round(l * 100, 2)}% ${round(ch, 4)} ${round(h, 2)}${aPart(c)})`;
}

/** Reverse lookup: the CSS name for an exact opaque color, if any. */
export function nameOf(c) {
  if (c.a < 1) return '';
  const hex = toHex(c, { alpha: false });
  return Object.keys(NAMED).find((n) => NAMED[n] === hex) || '';
}

export function cssVar(c, name = 'color') {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'color';
  return `--${slug}: ${toHex(c)};`;
}

/* ------------------------------------------------------------------ contrast (WCAG 2.x) */

export function luminance(c) {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** Composites `fg` (with alpha) over an opaque `bg`. */
export const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
});

/** Contrast ratio 1..21. Translucent colors are flattened: bg over white, then fg over bg. */
export function contrast(fg, bg) {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const b = bg.a < 1 ? over(bg, white) : bg;
  const f = fg.a < 1 ? over(fg, b) : fg;
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.x levels. Large text = 18pt (24px) regular or 14pt (~18.66px) bold. Compares the unrounded ratio. */
export const wcag = (ratio) => ({
  aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5,
});

/** Ratio shown the way WCAG tools do: truncated (never rounded up into a pass) to 2 decimals. */
export const fmtRatio = (ratio) => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

/* ------------------------------------------------------------------ palettes */

export const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });

/** `steps` tints (mixed towards white) and shades (towards black), evenly spaced, excluding pure white/black; alpha ignored. */
export function tintsAndShades(c, steps = 10) {
  const solid = { ...c, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 }, black = { r: 0, g: 0, b: 0, a: 1 };
  const at = (target) => Array.from({ length: steps }, (_, i) => ({ ...mix(solid, target, (i + 1) / (steps + 1)), weight: Math.round(((i + 1) / (steps + 1)) * 100) }));
  return { tints: at(white), shades: at(black) };
}

export function rotateHue(c, deg) {
  const { h, s, l } = rgbToHsl(c);
  return { ...hslToRgb((h + deg + 360) % 360, s, l), a: c.a };
}

export function harmonies(c) {
  return [
    { name: 'Complementary', colors: [c, rotateHue(c, 180)] },
    { name: 'Analogous', colors: [rotateHue(c, -30), c, rotateHue(c, 30)] },
    { name: 'Triadic', colors: [c, rotateHue(c, 120), rotateHue(c, 240)] },
    { name: 'Split complementary', colors: [c, rotateHue(c, 150), rotateHue(c, 210)] },
  ];
}

/** Black or white, whichever reads better on `c` (for swatch labels). */
export const readableOn = (c) => (contrast({ r: 0, g: 0, b: 0, a: 1 }, c) >= contrast({ r: 255, g: 255, b: 255, a: 1 }, c) ? '#000000' : '#ffffff');
