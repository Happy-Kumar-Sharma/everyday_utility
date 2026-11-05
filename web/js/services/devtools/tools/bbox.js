// 🔲 Box / polygon viewer: draw prediction boxes and polygons on an image (or a blank canvas), convert box
// formats, compute IoU and export the annotated image. The image never leaves the page.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { area, copyBtn, dropZone, kvList, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as B from './bbox.logic.js';

const T = 'bbox';
const EXAMPLE = [
  '# one shape per line, optional "label score:" prefix — or paste CSV/TSV rows with a header',
  'dent 0.91: [120, 80, 340, 260]',
  'scratch 0.78: {"x": 380, "y": 150, "w": 180, "h": 90}',
  'scratch 0.66: [[400,300],[560,280],[600,380],[470,420],[430,360]]',
  'crack: ((150,300),(320,310),(300,420),(220,380),(140,410))',
].join('\n');

const colorOf = (s, a = 1) => `hsla(${B.labelHue(s.label || 'shape')}, 80%, 48%, ${a})`;
const r2 = (a) => a.map((v) => B.round(v, 2));
const r6 = (a) => a.map((v) => B.round(v, 6));
const list = (a) => JSON.stringify(a);

export default function build() {
  loadCss('/static/css/devtools-pipeline.css');

  /* ---------------- inputs */
  const shapesIn = area({ rows: 8, placeholder: 'dent 0.91: [10,20,110,80]\n{"x":5,"y":5,"w":40,"h":30}\n[[x,y],[x,y],…]  — or paste CSV / TSV rows with a header', 'aria-label': 'Shapes' });
  const urlIn = h('input', { type: 'url', class: 'mono', placeholder: 'https://… image URL (Enter to load)', 'aria-label': 'Image URL' });
  const wIn = h('input', { type: 'number', min: 1, step: 1, class: 'mono', placeholder: 'auto', 'aria-label': 'Image width' });
  const hIn = h('input', { type: 'number', min: 1, step: 1, class: 'mono', placeholder: 'auto', 'aria-label': 'Image height' });
  const sizeHint = h('span', { class: 'muted small' });
  const imgInfo = h('span', { class: 'muted small' });
  const removeImg = h('button', { type: 'button', class: 'btn sm', hidden: true, onclick: () => { setImage(null); render(); } }, '✕ Remove image');
  const status = notice();
  const imgStatus = notice();

  const fmtSeg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'xyxy', label: 'xyxy' }, { value: 'xywh', label: 'xywh', title: 'top-left x, y, width, height' },
    { value: 'cxcywh', label: 'cxcywh', title: 'centre x, y, width, height' }, { value: 'yolo', label: 'YOLO', title: 'normalized cx cy w h' },
    { value: 'coco', label: 'COCO', title: 'pixel x y w h' }], opt(T, 'format', 'auto'), (v) => { setOpt(T, 'format', v); render(); });
  const unitSeg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'pixel', label: 'Pixels' }, { value: 'normalized', label: 'Normalized 0–1' }],
    opt(T, 'units', 'auto'), (v) => { setOpt(T, 'units', v); render(); });
  const zoomSeg = segmented([{ value: 'fit', label: 'Fit' }, { value: '100', label: '100%' }], opt(T, 'zoom', 'fit'), (v) => { setOpt(T, 'zoom', v); draw(); });
  let showLabels = opt(T, 'labels', true);
  const labelsBox = checkbox('Labels', showLabels, (v) => { showLabels = v; setOpt(T, 'labels', v); draw(); });

  const canvas = h('canvas', { class: 'dt-bbox-canvas', role: 'img', 'aria-label': 'Annotated image' });
  const canvasWrap = h('div', { class: 'dt-bbox-stage' }, canvas);
  const listEl = h('div', { class: 'dt-bbox-list', role: 'list', 'aria-label': 'Shapes' });
  const convOut = h('div', { class: 'stack' });
  const iouOut = h('div', { class: 'stack' });
  const selA = h('select', { 'aria-label': 'Shape A', onchange: () => updateIou() });
  const selB = h('select', { 'aria-label': 'Shape B', onchange: () => updateIou() });
  const pasteA = h('input', { type: 'text', class: 'mono', placeholder: 'or paste a box / polygon', 'aria-label': 'Shape A coordinates' });
  const pasteB = h('input', { type: 'text', class: 'mono', placeholder: 'or paste a box / polygon', 'aria-label': 'Shape B coordinates' });

  /* ---------------- state */
  let img = null, objectUrl = null, tainted = false;
  let shapes = [], W = 0, H = 0, scale = 1;
  let selected = null, hover = null;

  const safe = (fn) => (...args) => { try { return fn(...args); } catch (e) { show(status, 'err', `✗ ${e.message || e}`); } };

  function setImage(next, { url = null, isTainted = false } = {}) {
    if (objectUrl && objectUrl !== url) URL.revokeObjectURL(objectUrl);
    objectUrl = url; img = next; tainted = isTainted;
    removeImg.hidden = !img;
    wIn.disabled = hIn.disabled = !!img;
    if (img) { wIn.value = img.naturalWidth; hIn.value = img.naturalHeight; } else { wIn.value = ''; hIn.value = ''; }
    imgInfo.textContent = img ? `${img.naturalWidth} × ${img.naturalHeight}px${tainted ? ' · no CORS: PNG export disabled' : ''}` : '';
  }

  function loadImage(src, { revoke = false, name = '' } = {}) {
    show(imgStatus, '', 'Loading image…');
    const attempt = (cors) => {
      const im = new Image();
      if (cors) im.crossOrigin = 'anonymous';
      im.onload = () => { setImage(im, { url: revoke ? src : null, isTainted: !cors }); show(imgStatus, ''); if (name) imgInfo.textContent = `${name} · ${imgInfo.textContent}`; render(); };
      im.onerror = () => {
        if (cors && !revoke) return attempt(false);  // server without CORS headers: still displayable, but the canvas becomes tainted
        if (revoke) URL.revokeObjectURL(src);
        show(imgStatus, 'err', '✗ Could not load that image (not an image, or the URL is unreachable).');
      };
      im.src = src;
    };
    attempt(true);
  }

  const onFile = safe((file) => {
    if (!/^image\//.test(file.type)) return show(imgStatus, 'err', `✗ ${file.name} is not an image.`);
    urlIn.value = '';
    loadImage(URL.createObjectURL(file), { revoke: true, name: file.name });
  });
  const loadUrl = safe(() => {
    const u = urlIn.value.trim();
    if (!u) return;
    if (!/^(https?:|data:image\/|blob:)/i.test(u)) return show(imgStatus, 'err', '✗ Use an http(s) URL or a data:image URL.');
    loadImage(u);
  });
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadUrl(); } });
  const zone = dropZone('🖼 Drop an image here (or click to pick one) — it stays in this page', onFile);
  zone.querySelector('input[type=file]').accept = 'image/*';

  /* ---------------- parse + resolve */
  function sizeFor(parsed) {
    if (img) return [img.naturalWidth, img.naturalHeight, 'from the image'];
    const w = Number(wIn.value), hh = Number(hIn.value);
    if (w > 0 && hh > 0) return [w, hh, 'entered'];
    const units = unitSeg.value;
    const normalized = fmtSeg.value === 'yolo' || units === 'normalized' || (units === 'auto' && B.detectNormalized(parsed));
    if (normalized || !parsed.length) return [1000, 1000, 'blank 1000 × 1000 canvas — enter the real size to get pixel values'];
    const { shapes: px } = B.resolve(parsed, { format: fmtSeg.value, units, w: 1, h: 1 });
    const mx = Math.max(...px.map((s) => s.px[2])), my = Math.max(...px.map((s) => s.px[3]));
    return [Math.max(100, Math.ceil(mx * 1.05)), Math.max(100, Math.ceil(my * 1.05)), 'guessed from the shapes — enter the real size for correct normalized values'];
  }

  const render = safe(() => {
    const { shapes: parsed, errors } = B.parseInput(shapesIn.value);
    let note;
    [W, H, note] = sizeFor(parsed);
    sizeHint.textContent = img ? '' : note;
    shapes = B.resolve(parsed, { format: fmtSeg.value, units: unitSeg.value, w: W, h: H }).shapes;
    if (selected != null && selected >= shapes.length) selected = null;
    if (selected == null && shapes.length) selected = 0;
    hover = null;
    const errText = errors.slice(0, 5).map((e) => `line ${e.line}: ${e.error}`).join(' · ') + (errors.length > 5 ? ` · +${errors.length - 5} more` : '');
    if (!shapesIn.value.trim()) show(status, '');
    else if (!shapes.length) show(status, 'err', `✗ No shapes read. ${errText}`);
    else {
      const units = [...new Set(shapes.map((s) => (s.normalized ? 'normalized' : 'pixel')))].join(' + ');
      const fmts = [...new Set(shapes.filter((s) => s.type === 'box').map((s) => s.fmt))].join(', ');
      const base = `${shapes.length} shape${shapes.length > 1 ? 's' : ''} · ${units}${fmts ? ` · boxes as ${fmts}` : ''}`;
      show(status, errors.length ? 'warn' : 'ok', errors.length ? `${base} · ${errors.length} skipped — ${errText}` : `✓ ${base}`);
    }
    renderList(); renderSelects(); renderConverter(); updateIou(); draw();
  });

  /* ---------------- canvas */
  function paint(ctx, s, k, { active = null, labels = true, bg = '#ffffff', image = img } = {}) {
    if (image) ctx.drawImage(image, 0, 0, W, H);
    else { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    const lw = 2 / k;
    shapes.forEach((sh, i) => {
      const on = i === active;
      ctx.globalAlpha = active != null && !on && i !== selected ? 0.35 : 1;
      ctx.lineWidth = on || i === selected ? lw * 2 : lw;
      ctx.strokeStyle = colorOf(sh);
      ctx.beginPath();
      if (sh.type === 'box') { const [x1, y1, x2, y2] = sh.px; ctx.rect(x1, y1, x2 - x1, y2 - y1); }
      else { sh.pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
      ctx.fillStyle = colorOf(sh, sh.type === 'poly' ? (on ? 0.45 : 0.25) : on ? 0.2 : 0);
      ctx.fill();
      ctx.stroke();
      if (on || i === selected) {  // light halo so the highlighted shape reads on any image
        ctx.save(); ctx.setLineDash([4 / k, 4 / k]); ctx.lineWidth = lw / 2; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
      }
    });
    ctx.globalAlpha = 1;
    if (!labels) return;
    const fs = 12 / k, pad = 3 / k;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    shapes.forEach((sh, i) => {
      const text = `${sh.label || `#${i + 1}`}${sh.score != null ? ` ${sh.score.toFixed(2)}` : ''}`;
      const tw = ctx.measureText(text).width + pad * 2, th = fs + pad * 2;
      const [x1, y1] = sh.px;
      const y = y1 - th >= 0 ? y1 - th : y1;
      ctx.globalAlpha = active != null && i !== active && i !== selected ? 0.4 : 1;
      ctx.fillStyle = colorOf(sh);
      ctx.fillRect(x1, y, tw, th);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x1 + pad, y + pad);
    });
    ctx.globalAlpha = 1;
  }

  const draw = safe(() => {
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    const avail = Math.max(120, canvasWrap.clientWidth - 2);
    const maxH = Math.max(240, window.innerHeight * 0.7);
    scale = zoomSeg.value === '100' ? 1 : Math.min(avail / W, maxH / H);
    const cw = Math.max(1, Math.round(W * scale)), ch = Math.max(1, Math.round(H * scale));
    canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    const bg = getComputedStyle(canvasWrap).getPropertyValue('--surface-2').trim() || '#f1f3f6';
    paint(ctx, shapes, scale, { active: hover ?? null, labels: showLabels, bg });
    canvas.setAttribute('aria-label', `Annotated ${img ? 'image' : 'blank canvas'} ${W} × ${H} with ${shapes.length} shapes`);
  });

  function hitTest(e) {
    const r = canvas.getBoundingClientRect();
    const p = [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
    let best = null, bestArea = Infinity;
    shapes.forEach((s, i) => {
      const inside = s.type === 'box' ? p[0] >= s.px[0] && p[0] <= s.px[2] && p[1] >= s.px[1] && p[1] <= s.px[3] : B.pointInPolygon(p, s.pts);
      const a = s.type === 'box' ? B.boxArea(s.px) : B.polygonArea(s.pts);
      if (inside && a < bestArea) { best = i; bestArea = a; }
    });
    return best;
  }
  canvas.addEventListener('mousemove', safe((e) => {
    const i = hitTest(e);
    canvas.style.cursor = i == null ? 'default' : 'pointer';
    if (i !== hover) { hover = i; draw(); markList(); }
  }));
  canvas.addEventListener('mouseleave', () => { if (hover != null) { hover = null; draw(); markList(); } });
  canvas.addEventListener('click', safe((e) => { const i = hitTest(e); if (i != null) select(i); }));
  if (window.ResizeObserver) new ResizeObserver(debounce(() => { if (zoomSeg.value === 'fit') draw(); }, 60)).observe(canvasWrap);

  /* ---------------- side list */
  function select(i) { selected = i; renderConverter(); markList(); draw(); }
  function markList() {
    [...listEl.children].forEach((b, i) => {
      b.classList.toggle('on', i === selected); b.classList.toggle('hot', i === hover);
      b.setAttribute('aria-pressed', String(i === selected));
    });
  }
  function renderList() {
    clear(listEl, shapes.length ? shapes.map((s, i) => h('button', {
      type: 'button', class: 'dt-bbox-item', role: 'listitem',
      onclick: () => select(i),
      onmouseenter: () => { hover = i; draw(); markList(); }, onmouseleave: () => { hover = null; draw(); markList(); },
      onfocus: () => { hover = i; draw(); markList(); }, onblur: () => { hover = null; draw(); markList(); },
    }, h('span', { class: 'dt-bbox-swatch', style: { background: colorOf(s) } }),
    h('span', { class: 'grow' }, h('b', {}, `#${i + 1} `), s.label || h('span', { class: 'muted' }, 'unlabelled'),
      s.score != null ? h('span', { class: 'muted' }, ` ${s.score.toFixed(2)}`) : null),
    h('span', { class: 'pill' }, s.type === 'box' ? 'box' : `poly ${s.pts.length}`))) : h('p', { class: 'muted small' }, 'No shapes yet.'));
    markList();
  }

  /* ---------------- converter */
  function boxRows(px) {
    const yolo = r6(B.fromXyxy(px, 'yolo', true, W, H));
    const [x1, y1, x2, y2] = r2(px);
    return [
      ['xyxy (px)', list(r2(px))],
      ['xywh / COCO (px)', list(r2(B.fromXyxy(px, 'xywh')))],
      ['cxcywh (px)', list(r2(B.fromXyxy(px, 'cxcywh')))],
      ['xyxy (norm)', list(r6(B.fromXyxy(px, 'xyxy', true, W, H)))],
      ['xywh (norm)', list(r6(B.fromXyxy(px, 'xywh', true, W, H)))],
      ['YOLO cx cy w h', list(yolo)],
      ['YOLO txt line', `0 ${yolo.join(' ')}`],
      ['{x, y, w, h}', JSON.stringify({ x: x1, y: y1, w: B.round(x2 - x1), h: B.round(y2 - y1) })],
      ['Postgres box', `(${x2},${y2}),(${x1},${y1})`],
    ];
  }
  function renderConverter() {
    const s = shapes[selected];
    if (!s) return clear(convOut, h('p', { class: 'muted small' }, 'Select a shape in the list or on the image.'));
    const [x1, y1, x2, y2] = s.px;
    const stats = [['width', B.round(x2 - x1)], ['height', B.round(y2 - y1)]];
    let rows;
    if (s.type === 'box') {
      stats.push(['area', B.round(B.boxArea(s.px))], ['centre', `${B.round((x1 + x2) / 2)}, ${B.round((y1 + y2) / 2)}`]);
      rows = [...boxRows(s.px), ['polygon (px)', list(B.boxToPolygon(r2(s.px)))]];
    } else {
      stats.push(['polygon area', B.round(B.polygonArea(s.pts))], ['bbox area', B.round(B.boxArea(s.px))], ['points', s.pts.length]);
      const pxPts = s.pts.map(r2), nPts = s.pts.map(([x, y]) => r6([x / W, y / H]));
      rows = [
        ['polygon (px)', list(pxPts)],
        ['polygon (norm)', list(nPts)],
        ['flat (px)', list(pxPts.flat())],
        ['YOLO seg line', `0 ${nPts.flat().join(' ')}`],
        ['Postgres polygon', `(${pxPts.map(([x, y]) => `(${x},${y})`).join(',')})`],
        ...boxRows(s.px).map(([k, v]) => [`bbox ${k}`, v]),
      ];
    }
    clear(convOut,
      h('div', { class: 'row' }, h('b', {}, `#${selected + 1} ${s.label || ''}`),
        h('span', { class: 'muted small' }, `read as ${s.type === 'box' ? s.fmt : 'polygon'} · ${s.normalized ? 'normalized' : 'pixels'} · image ${W} × ${H}`)),
      h('div', { class: 'stats dt-bbox-stats' }, stats.map(([k, v]) => h('span', {}, h('b', {}, String(v)), ` ${k}`))),
      kvList(rows));
  }

  /* ---------------- IoU */
  function renderSelects() {
    const opts = (sel, def) => {
      const keep = sel.value;
      clear(sel, h('option', { value: '' }, '— pick a shape —'), shapes.map((s, i) => h('option', { value: String(i) }, `#${i + 1} ${s.label || ''} (${s.type})`)));
      sel.value = keep !== '' && Number(keep) < shapes.length ? keep : def < shapes.length ? String(def) : '';
    };
    opts(selA, 0); opts(selB, 1);
  }
  function pick(sel, paste, name) {
    const t = paste.value.trim();
    if (t) {
      const p = B.parseShape(t);
      if (p.error) throw new Error(`${name}: ${p.error}`);
      return B.resolve([p], { format: fmtSeg.value, units: unitSeg.value, w: W, h: H }).shapes[0];
    }
    return sel.value === '' ? null : shapes[Number(sel.value)];
  }
  const updateIou = () => {
    try {
      const a = pick(selA, pasteA, 'A'), b = pick(selB, pasteB, 'B');
      if (!a || !b) return clear(iouOut, h('p', { class: 'muted small' }, 'Pick or paste two shapes.'));
      const r = B.iouShapes(a, b);
      clear(iouOut,
        h('div', { class: 'row' }, h('span', { class: `pill ${r.iou >= 0.5 ? 'ok' : r.iou > 0 ? 'warn' : ''}` }, `IoU ${r.iou.toFixed(4)}`)),
        kvList([['IoU', String(B.round(r.iou, 6))], ['intersection', String(B.round(r.intersection))], ['union', String(B.round(r.union))], ['method', r.method]]));
    } catch (e) { clear(iouOut, h('div', { class: 'notice err' }, `✗ ${e.message}`)); }
  };
  const liveIou = debounce(updateIou, 200);
  pasteA.addEventListener('input', liveIou); pasteB.addEventListener('input', liveIou);

  /* ---------------- export */
  const exportPng = safe(() => {
    if (!shapes.length && !img) return show(status, 'warn', 'Nothing to export yet.');
    if (tainted) return show(status, 'err', '✗ This image URL does not allow cross-origin reads (no CORS), so the browser blocks exporting it. Download the image and drop the file instead.');
    const off = h('canvas', { width: W, height: H });
    paint(off.getContext('2d'), shapes, 1, { labels: showLabels, bg: '#ffffff' });
    off.toBlob((blob) => {
      if (!blob) return show(status, 'err', '✗ The image is too large to export.');
      const url = URL.createObjectURL(blob);
      h('a', { href: url, download: 'annotated.png' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  const live = debounce(render, 200);
  shapesIn.addEventListener('input', live);
  wIn.addEventListener('input', live); hIn.addEventListener('input', live);
  render();

  const el = h('div', { class: 'stack dt-tool dt-bbox' },
    zone,
    h('div', { class: 'row dt-nowrap' }, urlIn, h('button', { type: 'button', class: 'btn', onclick: loadUrl }, 'Load URL'), removeImg),
    imgStatus,
    h('div', { class: 'row' },
      h('label', { class: 'row' }, h('span', { class: 'small' }, 'Width'), wIn),
      h('label', { class: 'row' }, h('span', { class: 'small' }, 'Height'), hIn),
      imgInfo, sizeHint),
    labelled('Shapes', shapesIn, h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { shapesIn.value = EXAMPLE; render(); } }, 'Example')),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Boxes'), fmtSeg),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Units'), unitSeg, h('span', { class: 'spacer grow' }), labelsBox, zoomSeg,
      h('button', { type: 'button', class: 'btn sm', onclick: exportPng }, '⬇ PNG')),
    status,
    h('div', { class: 'dt-bbox-grid' }, canvasWrap, listEl),
    h('div', { class: 'dt-pair' },
      h('section', { class: 'stack', 'aria-label': 'Converter' }, h('h3', { class: 'dt-bbox-h' }, 'Selected shape'), convOut),
      h('section', { class: 'stack', 'aria-label': 'IoU' }, h('h3', { class: 'dt-bbox-h' }, 'IoU'),
        h('div', { class: 'dt-bbox-iou' }, labelled('A', selA), pasteA, labelled('B', selB), pasteB), iouOut,
        h('p', { class: 'muted small' }, 'Box–box uses the exact formula. Anything with a polygon is exact too: both shapes are split into signed fan triangles and every triangle pair is clipped (convex–convex), so concave polygons work.'))),
    h('p', { class: 'muted small' }, 'Accepts [x1,y1,x2,y2], {"x","y","w","h"}, {x1…}/{xmin…}, [[x,y],…], flat [x1,y1,x2,y2,…], Postgres {…} arrays and (x,y) text, YOLO txt lines. All values ≤ 1 are read as normalized unless you override it.'));

  return {
    el,
    focus: () => shapesIn.focus(),
    clear() {
      shapesIn.value = ''; urlIn.value = ''; pasteA.value = ''; pasteB.value = '';
      selA.value = ''; selB.value = ''; selected = null;
      setImage(null); show(imgStatus, ''); render();
    },
  };
}
