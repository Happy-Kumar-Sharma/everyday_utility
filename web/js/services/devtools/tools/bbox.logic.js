// Pure logic for the Box / polygon viewer (no DOM): parse boxes/polygons in the shapes people paste from
// prediction tables, convert between box formats, areas and IoU. Exercised from tests/test_devtools_pipeline.py.
//
// Parsed shape: { label, score, type: 'box', box: [4 numbers], fmtHint, unitHint }
//            or { label, score, type: 'poly', points: [[x, y], ...], unitHint }
// fmtHint: 'xyxy' | 'xywh' | 'cxcywh' | 'yolo' | null (null = ambiguous 4-number list)
// unitHint: 'normalized' | 'pixel' | null

export const FORMATS = ['xyxy', 'xywh', 'cxcywh', 'yolo', 'coco'];
const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (typeof v === 'string' && NUM.test(v.trim()) ? Number(v) : v);

/* ------------------------------------------------------------------ parsing */

/** Splits an optional "label score:" prefix from the coordinates. */
function splitPrefix(text) {
  const s = text.trim();
  let open = s.search(/[[{]/);
  if (open < 0) open = s.search(/\(/);
  if (open > 0) return { prefix: s.slice(0, open), body: s.slice(open) };
  if (open === 0) return { prefix: '', body: s };
  const colon = s.lastIndexOf(':');
  if (colon > 0) return { prefix: s.slice(0, colon), body: s.slice(colon + 1) };
  // bare tokens: leading non-numeric words are the label
  const tokens = s.split(/[\s,;]+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && !NUM.test(tokens[i])) i++;
  return { prefix: tokens.slice(0, i).join(' '), body: tokens.slice(i).join(' '), bare: true };
}

function parsePrefix(prefix) {
  const p = prefix.trim().replace(/[:=,\s]+$/, '').trim();
  if (!p) return { label: '', score: null };
  const tokens = p.split(/\s+/);
  const last = tokens[tokens.length - 1].replace(/[()%]/g, '');
  if (tokens.length > 1 && NUM.test(last)) {
    let score = Number(last);
    if (/%\)?$/.test(tokens[tokens.length - 1]) || score > 1) score /= 100;
    return { label: tokens.slice(0, -1).join(' ').replace(/[:=,]+$/, ''), score };
  }
  if (tokens.length === 1 && NUM.test(last)) return { label: '', score: Number(last) };
  return { label: p.replace(/^["']|["']$/g, ''), score: null };
}

/** Postgres array text {1,2,3} / {{1,2},{3,4}} → JSON; geometric (1,2),(3,4) → JSON pairs. */
function pgToJson(body) {
  const b = body.trim();
  if (/^\{[\s\d.,eE+\-{}]*\}$/.test(b)) return b.replace(/\{/g, '[').replace(/\}/g, ']');
  if (/\(/.test(b) && /^[\s\d.,eE+\-()[\]]*$/.test(b)) {
    const pts = [...b.matchAll(/\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (pts.length) return { pgPoints: pts };
  }
  return null;
}

function objectShape(o) {
  const g = (...keys) => { for (const k of keys) { const v = toNum(o[k]); if (isNum(v)) return v; } return undefined; };
  const all = (...v) => v.every(isNum);
  let x1 = g('x1', 'xmin', 'x_min', 'left', 'minx'), y1 = g('y1', 'ymin', 'y_min', 'top', 'miny');
  let x2 = g('x2', 'xmax', 'x_max', 'right', 'maxx'), y2 = g('y2', 'ymax', 'y_max', 'bottom', 'maxy');
  if (all(x1, y1, x2, y2)) return { type: 'box', box: [x1, y1, x2, y2], fmtHint: 'xyxy' };
  const w = g('w', 'width'), hgt = g('h', 'height');
  const cx = g('cx', 'x_center', 'xc', 'center_x'), cy = g('cy', 'y_center', 'yc', 'center_y');
  if (all(cx, cy, w, hgt)) return { type: 'box', box: [cx, cy, w, hgt], fmtHint: 'cxcywh' };
  x1 = g('x', 'left', 'x1', 'xmin'); y1 = g('y', 'top', 'y1', 'ymin');
  if (all(x1, y1, w, hgt)) return { type: 'box', box: [x1, y1, w, hgt], fmtHint: 'xywh' };
  for (const k of ['bbox', 'bounding_box', 'box', 'boundingBox']) if (o[k] != null) return valueShape(o[k]);
  for (const k of ['points', 'polygon', 'segmentation', 'coordinates', 'vertices']) if (o[k] != null) return valueShape(o[k]);
  if (isNum(toNum(o.x)) && isNum(toNum(o.y))) return { point: [toNum(o.x), toNum(o.y)] };
  throw new Error('Unrecognised object — expected x/y/w/h, x1/y1/x2/y2, xmin…, cx/cy/w/h or points');
}

/** A parsed JSON value → shape (without label). */
function valueShape(v) {
  if (typeof v === 'string') return bodyShape(v);
  if (v && !Array.isArray(v) && typeof v === 'object') {
    if (v.type === 'Polygon' && Array.isArray(v.coordinates)) return valueShape(v.coordinates[0]);
    return objectShape(v);
  }
  if (!Array.isArray(v)) throw new Error('Expected a list or an object of coordinates');
  v = v.map(toNum);
  // unwrap [[...]] with a single element: [[x1,y1,x2,y2]] or [[[x,y],...]]
  while (v.length === 1 && Array.isArray(v[0])) v = v[0].map(toNum);
  if (!v.length) throw new Error('Empty coordinate list');
  if (v.every(isNum)) return flatShape(v);
  if (v.every((p) => p && typeof p === 'object' && !Array.isArray(p))) {
    const pts = v.map((p) => objectShape(p).point);
    if (pts.every(Boolean)) return pointsShape(pts);
  }
  if (v.every((p) => Array.isArray(p))) {
    const pts = v.map((p) => p.map(toNum));
    if (pts.every((p) => p.length >= 2 && isNum(p[0]) && isNum(p[1]))) return pointsShape(pts.map((p) => [p[0], p[1]]));
    if (Array.isArray(pts[0]?.[0])) return valueShape(pts[0]);  // first ring of a multi-polygon
  }
  throw new Error('Could not read coordinates from this list');
}

function pointsShape(pts) {
  if (pts.length === 2) {  // two corners
    const [[ax, ay], [bx, by]] = pts;
    return { type: 'box', box: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], fmtHint: 'xyxy' };
  }
  if (pts.length < 3) throw new Error('A polygon needs at least 3 points');
  return { type: 'poly', points: pts };
}

function flatShape(nums) {
  if (nums.length === 4) return { type: 'box', box: nums, fmtHint: null };
  if (nums.length >= 6 && nums.length % 2 === 0) return pointsShape(pairs(nums));
  throw new Error(`Got ${nums.length} numbers — need 4 for a box or an even count ≥ 6 for a polygon`);
}
const pairs = (nums) => { const out = []; for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]); return out; };

function bodyShape(body) {
  const b = body.trim();
  if (!b) throw new Error('No coordinates');
  const pg = pgToJson(b);
  if (pg?.pgPoints) {
    const pts = pg.pgPoints;
    // Postgres box '(x2,y2),(x1,y1)' has 2 corners; polygon '((..),(..),(..))'
    return pointsShape(pts);
  }
  const src = typeof pg === 'string' ? pg : b;
  if (/^[[{"]/.test(src)) {
    let v;
    try { v = JSON.parse(src); } catch (e) {
      // python-ish: single quotes, None, trailing commas
      try { v = JSON.parse(src.replace(/'/g, '"').replace(/,\s*([\]}])/g, '$1')); } catch { throw new Error(`Invalid JSON: ${e.message}`); }
    }
    return valueShape(v);
  }
  const tokens = b.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.every((t) => NUM.test(t))) throw new Error('Expected numbers, a JSON list/object or Postgres text');
  return flatShape(tokens.map(Number));
}

/**
 * One line → shape. Accepts an optional "label score:" prefix, JSON lists/objects, flat lists, Postgres array
 * and geometric text, and YOLO txt lines ("cls cx cy w h" / "cls x1 y1 x2 y2 …" normalized).
 */
export function parseShape(text) {
  try {
    const { prefix, body, bare } = splitPrefix(String(text ?? ''));
    let { label, score } = parsePrefix(prefix);
    if (bare && !prefix.includes(':')) {
      const nums = body.split(/\s+/).filter(Boolean).map(Number);
      const restNorm = (a) => a.every((n) => n >= 0 && n <= 1);
      if (!label && Number.isInteger(nums[0]) && nums.length % 2 === 1 && nums.length >= 5 && restNorm(nums.slice(1))) {
        const s = nums.length === 5 ? { type: 'box', box: nums.slice(1), fmtHint: 'yolo' } : pointsShape(pairs(nums.slice(1)));
        return { label: `class ${nums[0]}`, score: null, ...s, unitHint: 'normalized' };
      }
      if (nums.length % 2 === 1 && nums.length >= 5 && nums[0] >= 0 && nums[0] <= 1) {  // "dent 0.91 10 20 110 80"
        return { label, score: nums[0], ...flatShape(nums.slice(1)), unitHint: null };
      }
    }
    const s = bodyShape(body);
    if (s.point) throw new Error('A single point is not a shape');
    return { label, score, ...s, unitHint: s.fmtHint === 'yolo' ? 'normalized' : null };
  } catch (e) {
    return { error: e.message };
  }
}

/* ------------------------------------------------------------------ CSV / TSV rows */

/** RFC-4180-ish CSV parser (quotes, "" escapes, newlines in quotes). */
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field.trim() === '') { quoted = true; field = ''; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COLS = {
  box: ['bounding_box', 'bbox', 'box', 'boundingbox', 'bounding_boxes'],
  poly: ['polygon', 'poly', 'segmentation', 'mask_polygon', 'polygons'],
  label: ['damage_name', 'label', 'class_name', 'class', 'category', 'name', 'damage_type'],
  score: ['score', 'confidence', 'conf', 'probability', 'prob'],
};
const norm = (h) => h.trim().replace(/^"|"$/g, '').toLowerCase();

/** True when the first line looks like a header of a predictions export. */
export function looksLikeHeader(line) {
  const cells = line.split(/[\t,|;]/).map(norm);
  return cells.some((c) => COLS.box.includes(c) || COLS.poly.includes(c));
}

/**
 * CSV/TSV/psql-aligned text with a header → { shapes, errors: [{line, error}], columns, delimiter }.
 * Each row yields up to two shapes (its box and its polygon), sharing label and score.
 */
export function parseRows(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const header = lines.find((l) => l.trim()) || '';
  const counts = { '\t': 0, '|': 0, ',': 0, ';': 0 };
  for (const c of header) if (c in counts) counts[c]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  let rows = parseDelimited(text, delim).filter((r) => r.some((c) => c.trim()));
  if (delim === '|') rows = rows.filter((r) => !/^[-+\s]+$/.test(r.join('|')) && !/^\(\d+ rows?\)$/.test(r.join('').trim()));
  if (!rows.length) return { shapes: [], errors: [], columns: [], delimiter: delim };
  const columns = rows[0].map((c) => c.trim());
  const idx = (names) => { const lc = columns.map(norm); for (const n of names) { const i = lc.indexOf(n); if (i >= 0) return i; } return -1; };
  const ib = idx(COLS.box), ip = idx(COLS.poly), il = idx(COLS.label), is = idx(COLS.score);
  const shapes = [], errors = [];
  if (ib < 0 && ip < 0) errors.push({ line: 1, error: 'No bounding_box / bbox / polygon column in the header' });
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const cell = (i) => (i >= 0 && r[i] != null ? r[i].trim() : '');
    const label = cell(il);
    let score = cell(is) !== '' && NUM.test(cell(is)) ? Number(cell(is)) : null;
    if (score != null && score > 1) score /= 100;
    for (const [i, kind] of [[ib, 'box'], [ip, 'polygon']]) {
      const v = cell(i);
      if (!v || /^(null|none|\\N|nan)$/i.test(v)) continue;
      const s = parseShape(v);
      if (s.error) errors.push({ line, error: `${columns[i]}: ${s.error}` });
      else shapes.push({ ...s, label: label || s.label, score: score ?? s.score, row: line, source: kind });
    }
  });
  return { shapes, errors, columns, delimiter: delim };
}

/** Whole textarea → { shapes, errors }: a header line switches to row mode, otherwise one shape per line. */
export function parseInput(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.find((l) => l.trim()) || '';
  if (looksLikeHeader(first) && !/[[{(]/.test(first)) return parseRows(text);
  const shapes = [], errors = [];
  lines.forEach((l, n) => {
    if (!l.trim() || /^\s*(#|\/\/)/.test(l)) return;
    const s = parseShape(l);
    if (s.error) errors.push({ line: n + 1, error: s.error });
    else shapes.push({ ...s, row: n + 1 });
  });
  return { shapes, errors };
}

/* ------------------------------------------------------------------ formats */

/** Box in `fmt` (+ normalized?) → pixel xyxy. Formats: xyxy, xywh/coco, cxcywh, yolo (= normalized cxcywh). */
export function toXyxy(box, fmt, normalized = false, w = 1, h = 1) {
  let [a, b, c, d] = box;
  if (fmt === 'yolo') normalized = true;
  if (normalized) { a *= w; b *= h; c *= w; d *= h; }
  switch (fmt) {
    case 'xyxy': return [a, b, c, d];
    case 'xywh': case 'coco': return [a, b, a + c, b + d];
    case 'cxcywh': case 'yolo': return [a - c / 2, b - d / 2, a + c / 2, b + d / 2];
    default: throw new Error(`Unknown box format: ${fmt}`);
  }
}

/** Pixel xyxy → box in `fmt` (+ normalized?). */
export function fromXyxy(xyxy, fmt, normalized = false, w = 1, h = 1) {
  const [x1, y1, x2, y2] = xyxy;
  let out;
  switch (fmt) {
    case 'xyxy': out = [x1, y1, x2, y2]; break;
    case 'xywh': case 'coco': out = [x1, y1, x2 - x1, y2 - y1]; break;
    case 'cxcywh': case 'yolo': out = [(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1]; break;
    default: throw new Error(`Unknown box format: ${fmt}`);
  }
  if (fmt === 'yolo') normalized = true;
  if (fmt === 'coco') normalized = false;
  return normalized ? [out[0] / w, out[1] / h, out[2] / w, out[3] / h] : out;
}

/**
 * convert(box, from, to, w, h). from/to: 'xyxy' | 'xywh' | 'cxcywh' | 'coco' | 'yolo', with an 'n' suffix
 * ('xyxyn', 'xywhn', 'cxcywhn') for normalized 0–1 values. w/h are needed whenever normalization changes.
 */
export function convert(box, from, to, w = 1, h = 1) {
  const split = (f) => (/^(xyxy|xywh|cxcywh)n$/.test(f) ? [f.slice(0, -1), true] : [f, false]);
  const [ff, fn] = split(from), [tf, tn] = split(to);
  return fromXyxy(toXyxy(box, ff, fn, w, h), tf, tn, w, h);
}

/** Pixel xyxy of a 4-number box under auto-detection: invalid as xyxy (x2 ≤ x1 or y2 ≤ y1) → xywh. */
export function guessFormat(shape) {
  if (shape.fmtHint) return shape.fmtHint;
  const [a, b, c, d] = shape.box;
  return c > a && d > b ? 'xyxy' : 'xywh';
}

/** All coordinates of all shapes within [0, 1] (slightly past 1 for rounding) → normalized. */
export function detectNormalized(shapes) {
  const vals = shapes.flatMap((s) => (s.type === 'box' ? s.box : s.points.flat()));
  return vals.length > 0 && vals.every((v) => v >= -0.01 && v <= 1.0001);
}

/**
 * Resolve parsed shapes to pixel geometry. opts: { format: 'auto'|FORMATS, units: 'auto'|'pixel'|'normalized', w, h }.
 * Returns { shapes: [{...shape, fmt, normalized, px: [x1,y1,x2,y2] | points: px points, bbox}], normalized }.
 */
export function resolve(shapes, { format = 'auto', units = 'auto', w = 1, h = 1 } = {}) {
  const autoNorm = detectNormalized(shapes);
  const out = shapes.map((s) => {
    const fmt = format !== 'auto' ? format : s.type === 'box' ? guessFormat(s) : null;
    const normalized = fmt === 'yolo' ? true : units === 'normalized' ? true : units === 'pixel' ? false
      : s.unitHint ? s.unitHint === 'normalized' : autoNorm;
    if (s.type === 'box') {
      const px = toXyxy(s.box, fmt, normalized, w, h);
      const [x1, y1, x2, y2] = px;
      return { ...s, fmt, normalized, px: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] };
    }
    const pts = s.points.map(([x, y]) => (normalized ? [x * w, y * h] : [x, y]));
    return { ...s, fmt: null, normalized, pts, px: polygonBBox(pts) };
  });
  return { shapes: out, normalized: autoNorm };
}

/* ------------------------------------------------------------------ geometry */

export function boxArea([x1, y1, x2, y2]) { return Math.max(0, x2 - x1) * Math.max(0, y2 - y1); }

/** IoU of two xyxy boxes → { iou, intersection, union }. */
export function iouBoxes(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = iw * ih;
  const union = boxArea(a) + boxArea(b) - intersection;
  return { iou: union > 0 ? intersection / union : 0, intersection, union };
}

export function signedArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}
/** Shoelace area (absolute). */
export const polygonArea = (pts) => Math.abs(signedArea(pts));

export function polygonBBox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const boxToPolygon = ([x1, y1, x2, y2]) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

/** Sutherland–Hodgman: clip polygon `subject` by the CONVEX counter-clockwise polygon `clip`. */
function clipConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const [ax, ay] = clip[i], [bx, by] = clip[(i + 1) % clip.length];
    const side = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);  // ≥ 0 → inside (left of edge)
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out;
}

/** Fan triangles from the first vertex, each with its orientation sign; made CCW so they can be clip windows. */
function signedTriangles(pts) {
  const sign = Math.sign(signedArea(pts)) || 1;  // so the polygon's interior has winding +1 whatever its orientation
  const tris = [];
  for (let i = 1; i + 1 < pts.length; i++) {
    const t = [pts[0], pts[i], pts[i + 1]];
    const a = signedArea(t);
    if (!a) continue;
    tris.push({ tri: a > 0 ? t : [t[0], t[2], t[1]], s: Math.sign(a) * sign });
  }
  return tris;
}

/**
 * Exact intersection area of two simple polygons (convex or not, any orientation).
 * Method: each polygon's indicator is the signed sum of its fan triangles (winding number), so
 * area(A ∩ B) = Σᵢ Σⱼ sᵢ sⱼ · area(Tᵢ ∩ Tⱼ), and every Tᵢ ∩ Tⱼ is a convex–convex clip (exact). O(n·m).
 */
export function polygonIntersectionArea(a, b) {
  const ta = signedTriangles(a), tb = signedTriangles(b);
  let sum = 0;
  for (const p of ta) for (const q of tb) {
    const c = clipConvex(p.tri, q.tri);
    if (c.length >= 3) sum += p.s * q.s * polygonArea(c);
  }
  return Math.max(0, sum);
}

/** IoU of two polygons (lists of [x, y]) → { iou, intersection, union, method }. */
export function iouPolygons(a, b) {
  const intersection = polygonIntersectionArea(a, b);
  const union = polygonArea(a) + polygonArea(b) - intersection;
  return { iou: union > 0 ? intersection / union : 0, intersection, union, method: 'exact (signed-triangle decomposition + convex clipping)' };
}

/** IoU of two resolved shapes (boxes use the exact box formula, anything with a polygon uses iouPolygons). */
export function iouShapes(a, b) {
  if (a.type === 'box' && b.type === 'box') return { ...iouBoxes(a.px, b.px), method: 'exact (box–box)' };
  const pa = a.type === 'box' ? boxToPolygon(a.px) : a.pts, pb = b.type === 'box' ? boxToPolygon(b.px) : b.pts;
  return iouPolygons(pa, pb);
}

export function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Stable hue (0–359) for a label, so the same class always gets the same colour. */
export function labelHue(label) {
  let hsh = 2166136261;
  for (const c of String(label || '')) { hsh ^= c.codePointAt(0); hsh = Math.imul(hsh, 16777619); }
  return ((hsh >>> 0) * 137.508) % 360 | 0;
}

export const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : n);
