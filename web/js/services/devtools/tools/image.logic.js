// Pure logic for the 🖼️ Image tool (no DOM): file sniffing, a from-scratch EXIF reader (JPEG APP1 / PNG eXIf,
// TIFF IFD0 + Exif IFD + GPS IFD, both byte orders), PNG text chunks, orientation and resize/crop maths.
// Unit-tested from tests/test_devtools_netimg.py via node.

export const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** MIME type from the first bytes (null if not one of JPEG / PNG / WebP / GIF). */
export function sniffMime(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 6 && String.fromCharCode(...b.subarray(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
/** {ratio: '16:9', decimal: 1.778, name?} */
export function aspectRatio(w, h) {
  if (!(w > 0 && h > 0)) return { ratio: '', decimal: 0 };
  const g = gcd(w, h);
  let ratio = `${w / g}:${h / g}`;
  const decimal = w / h;
  const common = [[1, 1], [4, 3], [3, 2], [16, 9], [16, 10], [21, 9], [5, 4], [3, 4], [2, 3], [9, 16], [10, 16], [4, 5]];
  const near = common.find(([a, b]) => Math.abs(a / b - decimal) < 0.01);
  if (w / g > 50 && near) ratio = `≈ ${near[0]}:${near[1]}`;
  return { ratio, decimal: Math.round(decimal * 1000) / 1000 };
}

/* ------------------------------------------------------------------ EXIF */
const TAGS = {
  ifd0: { 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
    0x8298: 'Copyright', 0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer' },
  exif: { 0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO', 0x9003: 'DateTimeOriginal', 0x920a: 'FocalLength',
    0xa434: 'LensModel', 0xa433: 'LensMake', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0x9010: 'OffsetTimeOriginal' },
  gps: { 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude',
    0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude' },
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Parse a TIFF block (the bytes after "Exif\0\0", or a PNG eXIf chunk). Returns {tags} with raw values. */
export function parseTiff(b) {
  if (b.length < 8) throw new Error('EXIF block is too short');
  const order = String.fromCharCode(b[0], b[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('EXIF block has no valid byte order');
  const le = order === 'II';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le), i32 = (o) => dv.getInt32(o, le);
  if (u16(2) !== 42) throw new Error('EXIF block is not TIFF (magic 42 missing)');
  const tags = {};
  const seen = new Set();

  function value(type, count, off) {
    const read = (i) => {
      const o = off + i * TYPE_SIZE[type];
      switch (type) {
        case 1: case 7: return b[o];
        case 6: return dv.getInt8(o);
        case 3: return u16(o);
        case 8: return dv.getInt16(o, le);
        case 4: return u32(o);
        case 9: return i32(o);
        case 5: { const d = u32(o + 4); return d ? u32(o) / d : null; }
        case 10: { const d = i32(o + 4); return d ? i32(o) / d : null; }
        case 11: return dv.getFloat32(o, le);
        case 12: return dv.getFloat64(o, le);
        default: return null;
      }
    };
    if (type === 2) {  // ASCII, NUL-terminated
      let s = '';
      for (let i = 0; i < count && b[off + i]; i++) s += String.fromCharCode(b[off + i]);
      try { s = decodeURIComponent(escape(s)); } catch { /* not UTF-8: keep latin-1 */ }
      return s.trim();
    }
    if (type === 7 && count > 4) {  // UNDEFINED blobs (MakerNote etc.) — not needed
      return null;
    }
    const n = Math.min(count, 64);
    const out = [];
    for (let i = 0; i < n; i++) out.push(read(i));
    return count === 1 ? out[0] : out;
  }

  function ifd(offset, names) {
    if (!offset || seen.has(offset) || offset + 2 > b.length) return;
    seen.add(offset);
    const n = u16(offset);
    if (offset + 2 + n * 12 > b.length) throw new Error('EXIF directory runs past the end of the data');
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const name = names[tag];
      if (!name || !TYPE_SIZE[type]) continue;
      const bytes = TYPE_SIZE[type] * count;
      const off = bytes <= 4 ? e + 8 : u32(e + 8);
      if (off + bytes > b.length || bytes > 1 << 20) continue;  // broken pointer: skip this tag only
      tags[name] = value(type, count, off);
    }
  }

  ifd(u32(4), TAGS.ifd0);
  if (typeof tags.ExifIFDPointer === 'number') ifd(tags.ExifIFDPointer, TAGS.exif);
  if (typeof tags.GPSInfoIFDPointer === 'number') ifd(tags.GPSInfoIFDPointer, TAGS.gps);
  delete tags.ExifIFDPointer; delete tags.GPSInfoIFDPointer;
  return { tags, byteOrder: le ? 'little-endian (II)' : 'big-endian (MM)' };
}

/** Degrees/minutes/seconds + 'N'/'S'/'E'/'W' -> signed decimal degrees (null if unusable). */
export function dmsToDecimal(dms, ref) {
  const parts = Array.isArray(dms) ? dms : [dms];
  if (!parts.length || parts.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [d, m = 0, s = 0] = parts;
  let v = d + m / 60 + s / 3600;
  if (/^[SW]/i.test(ref || '')) v = -v;
  return Math.round(v * 1e7) / 1e7;
}

/** Offsets of the APP1 "Exif" segments of a JPEG: [{start, end, tiffStart}] (start..end = whole segment incl. marker). */
export function jpegExifSegments(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error('Not a JPEG file');
  const out = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error(`Corrupt JPEG: expected a marker at byte ${i}`);
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }  // fill byte
    if (marker === 0xd9 || marker === 0xda) break;  // end of image / start of scan: no more metadata
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error('Corrupt JPEG: a segment runs past the end of the file');
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === 'Exif\0\0') {
      out.push({ start: i, end: i + 2 + len, tiffStart: i + 10 });
    }
    i += 2 + len;
  }
  return out;
}

/** JPEG bytes without their EXIF APP1 segments (so the browser decodes the raw, un-rotated pixels). */
export function stripJpegExif(b) {
  const segs = jpegExifSegments(b);
  if (!segs.length) return b;
  const parts = [];
  let last = 0;
  for (const s of segs) { parts.push(b.subarray(last, s.start)); last = s.end; }
  parts.push(b.subarray(last));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const latin1 = (b) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };
const utf8 = (b) => new TextDecoder('utf-8', { fatal: false }).decode(b);

/** PNG chunks: [{type, start (data offset), length}] — stops at IEND. */
export function pngChunks(b) {
  if (sniffMime(b) !== 'image/png') throw new Error('Not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const length = dv.getUint32(i);
    const type = latin1(b.subarray(i + 4, i + 8));
    if (i + 12 + length > b.length) throw new Error(`Corrupt PNG: chunk ${type} runs past the end of the file`);
    out.push({ type, start: i + 8, length });
    if (type === 'IEND') break;
    i += 12 + length;
  }
  return out;
}

/** PNG tEXt / iTXt (and zTXt, noted as compressed) chunks: [{chunk, keyword, text, lang?}] */
export function pngText(b) {
  const out = [];
  for (const c of pngChunks(b)) {
    const d = b.subarray(c.start, c.start + c.length);
    const nul = d.indexOf(0);
    if (!['tEXt', 'iTXt', 'zTXt'].includes(c.type) || nul < 1) continue;
    const keyword = latin1(d.subarray(0, nul));
    if (c.type === 'tEXt') out.push({ chunk: 'tEXt', keyword, text: latin1(d.subarray(nul + 1)) });
    else if (c.type === 'zTXt') out.push({ chunk: 'zTXt', keyword, text: '(compressed text)', compressed: true });
    else {
      const compressed = d[nul + 1] === 1;
      let p = nul + 3;
      const langEnd = d.indexOf(0, p); if (langEnd < 0) continue;
      const lang = latin1(d.subarray(p, langEnd)); p = langEnd + 1;
      const trEnd = d.indexOf(0, p); if (trEnd < 0) continue;
      p = trEnd + 1;
      out.push({ chunk: 'iTXt', keyword, lang, text: compressed ? '(compressed text)' : utf8(d.subarray(p)), compressed });
    }
  }
  return out;
}

const fmtNum = (v, digits = 2) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10 ** digits) / 10 ** digits));
export const ORIENTATIONS = { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored + rotated 90° CCW',
  6: 'Rotated 90° CW', 7: 'Mirrored + rotated 90° CW', 8: 'Rotated 90° CCW' };

/** Human-readable EXIF from raw tags: {rows: [[label, value]], gps: {lat, lon}|null, orientation} */
export function describeExif(tags) {
  const rows = [];
  const add = (label, v) => { if (v !== undefined && v !== null && v !== '') rows.push([label, String(v)]); };
  add('Make', tags.Make); add('Model', tags.Model); add('Lens', tags.LensModel);
  add('Date taken', tags.DateTimeOriginal ? `${tags.DateTimeOriginal}${tags.OffsetTimeOriginal ? ` ${tags.OffsetTimeOriginal}` : ''}` : null);
  if (typeof tags.ExposureTime === 'number' && tags.ExposureTime > 0) {
    add('Exposure', tags.ExposureTime >= 1 ? `${fmtNum(tags.ExposureTime, 1)} s` : `1/${Math.round(1 / tags.ExposureTime)} s`);
  }
  if (typeof tags.FNumber === 'number') add('Aperture', `f/${fmtNum(tags.FNumber, 1)}`);
  add('ISO', Array.isArray(tags.ISO) ? tags.ISO[0] : tags.ISO);
  if (typeof tags.FocalLength === 'number') add('Focal length', `${fmtNum(tags.FocalLength, 1)} mm`);
  const orientation = typeof tags.Orientation === 'number' && tags.Orientation >= 1 && tags.Orientation <= 8 ? tags.Orientation : null;
  if (orientation) add('Orientation', `${orientation} — ${ORIENTATIONS[orientation]}`);
  add('Software', tags.Software); add('Modified', tags.DateTime); add('Artist', tags.Artist); add('Copyright', tags.Copyright);
  let gps = null;
  const lat = dmsToDecimal(tags.GPSLatitude, tags.GPSLatitudeRef), lon = dmsToDecimal(tags.GPSLongitude, tags.GPSLongitudeRef);
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    gps = { lat, lon };
    add('GPS', `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    if (typeof tags.GPSAltitude === 'number') add('Altitude', `${fmtNum(tags.GPSAltitudeRef === 1 ? -tags.GPSAltitude : tags.GPSAltitude, 1)} m`);
  }
  return { rows, gps, orientation };
}

/** Everything the info panel needs from the raw bytes: {mime, exif|null, exifError?, text: [...] } */
export function readMetadata(b) {
  const mime = sniffMime(b);
  const out = { mime, exif: null, text: [] };
  try {
    if (mime === 'image/jpeg') {
      const seg = jpegExifSegments(b)[0];
      if (seg) {
        const t = parseTiff(b.subarray(seg.tiffStart, seg.end));
        out.exif = { ...describeExif(t.tags), byteOrder: t.byteOrder };
      }
    } else if (mime === 'image/png') {
      out.text = pngText(b);
      const ex = pngChunks(b).find((c) => c.type === 'eXIf');
      if (ex) {
        const t = parseTiff(b.subarray(ex.start, ex.start + ex.length));
        out.exif = { ...describeExif(t.tags), byteOrder: t.byteOrder };
      }
    }
  } catch (e) { out.exifError = e.message; }
  return out;
}

/* ------------------------------------------------------------------ geometry */
/**
 * Canvas transform for an EXIF orientation: draw the raw image (w×h) after ctx.setTransform(...matrix).
 * Returns {width, height, matrix: [a, b, c, d, e, f]} of the upright output.
 */
export function orientationMatrix(o, w, h) {
  switch (o) {
    case 2: return { width: w, height: h, matrix: [-1, 0, 0, 1, w, 0] };
    case 3: return { width: w, height: h, matrix: [-1, 0, 0, -1, w, h] };
    case 4: return { width: w, height: h, matrix: [1, 0, 0, -1, 0, h] };
    case 5: return { width: h, height: w, matrix: [0, 1, 1, 0, 0, 0] };
    case 6: return { width: h, height: w, matrix: [0, 1, -1, 0, h, 0] };
    case 7: return { width: h, height: w, matrix: [0, -1, -1, 0, h, w] };
    case 8: return { width: h, height: w, matrix: [0, -1, 1, 0, 0, w] };
    default: return { width: w, height: h, matrix: [1, 0, 0, 1, 0, 0] };
  }
}

/** Matrix for user rotation (0/90/180/270 clockwise) + flips, applied to a w×h image. */
export function rotateMatrix(deg, flipH, flipV, w, h) {
  const r = ((deg % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  const W = swap ? h : w, H = swap ? w : h;
  // rotation about the origin, then translate into view
  const rot = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, h, 0], 180: [-1, 0, 0, -1, w, h], 270: [0, -1, 1, 0, 0, w] }[r];
  // flips act on the rotated output: x' = W - x, y' = H - y
  const fx = flipH ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, 1, 0, 0];
  const fy = flipV ? [1, 0, 0, -1, 0, H] : [1, 0, 0, 1, 0, 0];
  return { width: W, height: H, matrix: multiply(fy, multiply(fx, rot)) };
}

/** Canvas-style 2D affine multiply: returns m1 ∘ m2 (apply m2 first). */
export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1, [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Integer crop rectangle kept inside w×h (at least 1×1). */
export function clampCrop({ x, y, w: cw, h: ch }, w, h) {
  const X = Math.min(Math.max(0, Math.round(Number(x) || 0)), w - 1);
  const Y = Math.min(Math.max(0, Math.round(Number(y) || 0)), h - 1);
  const W = Math.min(Math.max(1, Math.round(Number(cw) || 0)), w - X);
  const H = Math.min(Math.max(1, Math.round(Number(ch) || 0)), h - Y);
  return { x: X, y: Y, w: W, h: H };
}

/** Rectangle from two drag points (any direction), clamped. */
export const rectFromPoints = (x1, y1, x2, y2, w, h) => clampCrop({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }, w, h);

export const MAX_SIDE = 16384;
/**
 * Target size for a resize. opts: {mode: 'px'|'pct', width, height, lock, pct, changed: 'width'|'height'}
 * With lock on, the other side follows the one just changed. Returns {width, height} (integers ≥ 1) or {error}.
 */
export function resizeTo(srcW, srcH, opts) {
  let W, H;
  if (opts.mode === 'pct') {
    const p = Number(opts.pct);
    if (!(p > 0)) return { error: 'Enter a percentage above 0.' };
    W = Math.max(1, Math.round(srcW * p / 100)); H = Math.max(1, Math.round(srcH * p / 100));
  } else {
    const w = Number(opts.width), h = Number(opts.height);
    if (opts.lock) {
      if (opts.changed === 'height' && h > 0) { H = Math.round(h); W = Math.max(1, Math.round(h * srcW / srcH)); }
      else if (w > 0) { W = Math.round(w); H = Math.max(1, Math.round(w * srcH / srcW)); }
      else if (h > 0) { H = Math.round(h); W = Math.max(1, Math.round(h * srcW / srcH)); }
      else return { error: 'Enter a width or height.' };
    } else {
      if (!(w > 0) || !(h > 0)) return { error: 'Enter both width and height (or lock the aspect ratio).' };
      W = Math.round(w); H = Math.round(h);
    }
  }
  if (W > MAX_SIDE || H > MAX_SIDE) return { error: `That is too large (max ${MAX_SIDE} px per side).` };
  return { width: W, height: H };
}

/** Base64 length for n bytes, and whether to warn (data URLs over 1 MB are slow to paste anywhere). */
export const base64Size = (n) => 4 * Math.ceil(n / 3);
export const DATA_URL_WARN = 1024 * 1024;

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const toHex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** File name for an export: photo.jpg + 'png' -> photo-edited.png */
export function exportName(name, ext, suffix = 'edited') {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'image';
  return `${base}-${suffix}.${ext}`;
}
