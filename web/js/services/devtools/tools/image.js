// 🖼️ Image tool: info, EXIF / PNG text, strip metadata, resize / crop / rotate / flip, re-encode, data URL,
// pixel inspector. Everything happens in this page: the image never leaves the browser.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, fmt, h, loadCss } from '../../../core/dom.js';
import * as L from './image.logic.js';
import { dropZone, kvList, labelled, notice, opt, setOpt, show } from '../ui.js';

const T = 'image';
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LABEL = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode this image.'))), type, quality);
});

function numInput(label, props = {}) {
  return h('input', { type: 'number', min: 0, step: 1, class: 'dt-img-num', 'aria-label': label, ...props });
}

export default function build() {
  loadCss('/static/css/devtools-netimg.css');
  let img = null;   // {file, bytes, mime, meta, bitmap, rawW, rawH, orientation}
  let stage = null; // canvas: oriented + rotated/flipped full image
  let stageKey = '';
  let result = null; // {blob, url, width, height, type}
  let seq = 0;
  let rot = 0, flipH = false, flipV = false;
  let crop = null;   // {x, y, w, h} in stage pixels, or null
  let lastHex = '';

  const status = notice();
  const outNotice = notice();
  const copyNotice = notice();
  const infoBox = h('div', {});
  const metaBox = h('div', { class: 'stack' });

  const drop = dropZone('🖼️ Drop an image here (or click) — JPEG, PNG, WebP or GIF. It stays in this browser.', (f) => load(f));
  drop.querySelector('input').accept = L.SUPPORTED.join(',');

  /* ---------- preview with crop + pixel inspector ---------- */
  const stageWrap = h('div', { class: 'dt-img-stage', 'aria-label': 'Image preview: drag to select a crop area, hover to inspect pixels' });
  const cropBox = h('div', { class: 'dt-img-crop', hidden: true });
  const swatch = h('span', { class: 'dt-img-swatch', 'aria-hidden': 'true' });
  const pixelText = h('span', { class: 'mono small' }, 'Hover the image to read pixel colours.');
  const pixelCopy = h('button', { type: 'button', class: 'btn sm', hidden: true, onclick: () => lastHex && copyText(lastHex) }, 'Copy colour');
  const pixelRow = h('div', { class: 'row dt-img-pixel', role: 'status', 'aria-live': 'off' }, swatch, pixelText, pixelCopy);

  /* ---------- transform controls ---------- */
  const applyOrient = checkbox('Apply EXIF orientation', opt(T, 'orient', true), (v) => { setOpt(T, 'orient', v); crop = null; update(); });
  const rotL = h('button', { type: 'button', class: 'btn sm', onclick: () => { rot = (rot + 270) % 360; crop = null; update(); } }, '⟲ 90°');
  const rotR = h('button', { type: 'button', class: 'btn sm', onclick: () => { rot = (rot + 90) % 360; crop = null; update(); } }, '⟳ 90°');
  const fH = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', onclick: () => { flipH = !flipH; crop = null; update(); } }, '⇋ Flip horizontal');
  const fV = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', onclick: () => { flipV = !flipV; crop = null; update(); } }, '⇵ Flip vertical');

  const cx = numInput('Crop x'), cy = numInput('Crop y'), cw = numInput('Crop width', { min: 1 }), ch = numInput('Crop height', { min: 1 });
  const cropOn = checkbox('Crop', false, (v) => {
    if (v && stage && !crop) crop = { x: 0, y: 0, w: stage.width, h: stage.height };
    if (!v) crop = null;
    syncCropFields(); scheduleOutput();
  });
  for (const el of [cx, cy, cw, ch]) el.addEventListener('input', debounce(() => {
    if (!stage) return;
    crop = L.clampCrop({ x: cx.value, y: cy.value, w: cw.value, h: ch.value }, stage.width, stage.height);
    cropOn.querySelector('input').checked = true;
    drawCropBox(); scheduleOutput();
  }, 300));
  const cropReset = h('button', { type: 'button', class: 'btn sm', onclick: () => { crop = null; syncCropFields(); scheduleOutput(); } }, 'No crop');

  const resizeOn = checkbox('Resize', false, () => { fillResize(); scheduleOutput(); });
  const resizeMode = segmented([{ value: 'px', label: 'Pixels' }, { value: 'pct', label: 'Percent' }], opt(T, 'resizeMode', 'px'),
    (v) => { setOpt(T, 'resizeMode', v); renderResizeMode(); scheduleOutput(); });
  const rw = numInput('Target width', { min: 1 }), rh = numInput('Target height', { min: 1 });
  const pct = numInput('Scale percent', { min: 1, max: 1000, value: 50 });
  const lock = checkbox('Lock aspect ratio', opt(T, 'lock', true), (v) => { setOpt(T, 'lock', v); scheduleOutput(); });
  let changedSide = 'width';
  rw.addEventListener('input', () => { changedSide = 'width'; resizeOn.querySelector('input').checked = true; liveResize(); });
  rh.addEventListener('input', () => { changedSide = 'height'; resizeOn.querySelector('input').checked = true; liveResize(); });
  pct.addEventListener('input', () => { resizeOn.querySelector('input').checked = true; scheduleOutput(); });
  const pxBox = h('div', { class: 'row' }, labelled('Width', rw), h('span', { 'aria-hidden': 'true' }, '×'), labelled('Height', rh), lock);
  const pctBox = h('div', { class: 'row' }, labelled('Scale %', pct));
  const renderResizeMode = () => { pxBox.hidden = resizeMode.value !== 'px'; pctBox.hidden = resizeMode.value !== 'pct'; };

  const format = segmented([{ value: 'image/png', label: 'PNG' }, { value: 'image/jpeg', label: 'JPEG' }, { value: 'image/webp', label: 'WebP' }],
    opt(T, 'format', 'image/png'), (v) => { setOpt(T, 'format', v); renderQuality(); scheduleOutput(); });
  const quality = h('input', { type: 'range', min: 1, max: 100, value: opt(T, 'quality', 90), 'aria-label': 'Quality' });
  const qLabel = h('span', { class: 'mono small' });
  quality.addEventListener('input', () => { qLabel.textContent = `${quality.value}%`; setOpt(T, 'quality', Number(quality.value)); scheduleOutput(); });
  const qBox = h('label', { class: 'row dt-img-quality' }, 'Quality', quality, qLabel);
  const renderQuality = () => { qBox.hidden = format.value === 'image/png'; qLabel.textContent = `${quality.value}%`; };

  /* ---------- result ---------- */
  const resultImg = h('img', { alt: 'Result preview', class: 'dt-img-result' });
  const resultInfo = h('div', { class: 'small' });
  const downloadBtn = h('button', { type: 'button', class: 'btn primary sm', onclick: () => result && download(result.blob, L.exportName(img.file.name, EXT[result.type] || 'png')) }, '⬇ Download');
  const copyResultUrl = h('button', { type: 'button', class: 'btn sm', onclick: () => result && copyData(result.blob, result.type, true) }, 'Copy as data URL');
  const copyResultB64 = h('button', { type: 'button', class: 'btn sm', onclick: () => result && copyData(result.blob, result.type, false) }, 'Copy base64');
  const copyOrigUrl = h('button', { type: 'button', class: 'btn sm', onclick: () => img && copyData(img.bytes, img.mime, true) }, 'Copy original as data URL');
  const stripBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => stripMetadata() }, '🧹 Strip metadata & download');

  const workArea = h('div', { class: 'stack', hidden: true },
    h('div', { class: 'dt-img-grid' },
      h('section', { class: 'stack', 'aria-label': 'Source' }, h('h3', { class: 'dt-img-h' }, 'Source'), stageWrap, pixelRow),
      h('section', { class: 'stack', 'aria-label': 'Result' }, h('h3', { class: 'dt-img-h' }, 'Result'),
        h('div', { class: 'dt-img-resultwrap' }, resultImg), resultInfo, outNotice,
        h('div', { class: 'row' }, downloadBtn, copyResultUrl, copyResultB64), copyNotice)),
    h('fieldset', { class: 'dt-img-fs' }, h('legend', {}, 'Rotate & flip'),
      h('div', { class: 'row' }, rotL, rotR, fH, fV, applyOrient)),
    h('fieldset', { class: 'dt-img-fs' }, h('legend', {}, 'Crop'),
      h('div', { class: 'row' }, cropOn, labelled('x', cx), labelled('y', cy), labelled('width', cw), labelled('height', ch), cropReset),
      h('p', { class: 'muted small' }, 'Or drag a rectangle on the source preview.')),
    h('fieldset', { class: 'dt-img-fs' }, h('legend', {}, 'Resize'), h('div', { class: 'row' }, resizeOn, resizeMode), pxBox, pctBox),
    h('fieldset', { class: 'dt-img-fs' }, h('legend', {}, 'Format'), h('div', { class: 'row' }, format, qBox)),
    h('div', { class: 'row' }, stripBtn, copyOrigUrl),
    h('p', { class: 'muted small' }, 'Every export is re-encoded through a canvas, so it never carries EXIF, GPS or text chunks. Animated GIFs keep only their first frame.'));

  /* ---------- helpers ---------- */
  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function copyData(src, type, asUrl) {
    try {
      const bytes = src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());
      const b64 = L.bytesToBase64(bytes);
      const text = asUrl ? `data:${type};base64,${b64}` : b64;
      await copyText(text, asUrl ? 'Data URL copied' : 'Base64 copied');
      if (text.length > L.DATA_URL_WARN) show(copyNotice, 'warn', `⚠ That was ${fmt.bytes(text.length)} of text — data URLs above 1 MB are slow in editors, HTML and CSS. Prefer a file.`);
      else show(copyNotice, '');
    } catch (e) { show(copyNotice, 'err', `✗ ${e.message || e}`); }
  }

  function syncCropFields() {
    cropOn.querySelector('input').checked = !!crop;
    for (const [el, k] of [[cx, 'x'], [cy, 'y'], [cw, 'w'], [ch, 'h']]) el.value = crop ? crop[k] : '';
    drawCropBox();
  }
  function drawCropBox() {
    if (!crop || !stage) { cropBox.hidden = true; return; }
    cropBox.hidden = false;
    Object.assign(cropBox.style, { left: `${(crop.x / stage.width) * 100}%`, top: `${(crop.y / stage.height) * 100}%`,
      width: `${(crop.w / stage.width) * 100}%`, height: `${(crop.h / stage.height) * 100}%` });
  }
  const srcDims = () => (crop ? [crop.w, crop.h] : stage ? [stage.width, stage.height] : [0, 0]);
  function fillResize() {
    const [w, hh] = srcDims();
    if (!resizeOn.querySelector('input').checked || !w) return;
    if (!rw.value) rw.value = w;
    if (!rh.value) rh.value = hh;
  }
  const liveResize = debounce(() => {
    const [w, hh] = srcDims();
    if (lock.querySelector('input').checked && w) {
      const r = L.resizeTo(w, hh, { mode: 'px', width: rw.value, height: rh.value, lock: true, changed: changedSide });
      if (!r.error) { if (changedSide === 'width') rh.value = r.height; else rw.value = r.width; }
    }
    scheduleOutput();
  }, 250);

  /* ---------- load ---------- */
  async function load(file) {
    const mine = ++seq;
    try {
      show(status, '');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mine !== seq) return;
      const mime = L.sniffMime(bytes);
      if (!mime) return fail(`“${file.name}” is not a JPEG, PNG, WebP or GIF image.`);
      const meta = L.readMetadata(bytes);
      // JPEG: decode without the EXIF block so we get raw pixels and apply the orientation ourselves (predictably)
      const exifSegs = mime === 'image/jpeg' ? L.jpegExifSegments(bytes) : [];
      const blob = new Blob([exifSegs.length ? L.stripJpegExif(bytes) : bytes], { type: mime });
      let bitmap;
      try { bitmap = await createImageBitmap(blob); } catch { return fail('The browser could not decode this image (it may be corrupt).'); }
      if (mine !== seq) { bitmap.close?.(); return; }
      img?.bitmap?.close?.();
      img = { file, bytes, mime, meta, bitmap, rawW: bitmap.width, rawH: bitmap.height,
        orientation: mime === 'image/jpeg' ? meta.exif?.orientation || 1 : 1 };
      rot = 0; flipH = false; flipV = false; crop = null; stageKey = '';
      rw.value = ''; rh.value = ''; resizeOn.querySelector('input').checked = false;
      if (!opt(T, 'formatChosen', false)) format.value = EXT[mime] ? mime : 'image/png';
      renderQuality();
      renderInfo();
      workArea.hidden = false;
      update();
    } catch (e) { fail(e.message || String(e)); }
  }
  function fail(msg) {
    show(status, 'err', `✗ ${msg}`);
    workArea.hidden = true; clear(infoBox); clear(metaBox);
  }

  function renderInfo() {
    const { file, bytes, mime, meta, orientation } = img;
    const upright = orientation >= 5 ? [img.rawH, img.rawW] : [img.rawW, img.rawH];
    const ar = L.aspectRatio(...upright);
    clear(infoBox, kvList([
      ['File', file.name || '(pasted)'],
      ['Type', `${LABEL[mime]} (${mime})${file.type && file.type !== mime ? ` — the file says ${file.type}` : ''}`],
      ['Dimensions', `${upright[0]} × ${upright[1]} px${orientation >= 5 ? ' (after EXIF rotation)' : ''}`],
      ['Megapixels', (upright[0] * upright[1] / 1e6).toFixed(2)],
      ['Aspect ratio', `${ar.ratio} (${ar.decimal})`],
      ['File size', `${fmt.bytes(bytes.length)} (${fmt.int(bytes.length)} bytes)`],
    ]));
    const parts = [];
    if (meta.exifError) parts.push(h('div', { class: 'notice warn' }, `⚠ Could not read all metadata: ${meta.exifError}`));
    if (meta.exif?.gps) {
      const { lat, lon } = meta.exif.gps;
      parts.push(h('div', { class: 'notice warn' }, `⚠ This image contains a GPS location (${lat.toFixed(5)}, ${lon.toFixed(5)}). Anyone you send the original to can see where it was taken — use “Strip metadata” first.`));
    }
    if (meta.exif?.rows.length) {
      parts.push(h('h3', { class: 'dt-img-h' }, `EXIF (${meta.exif.byteOrder})`), kvList(meta.exif.rows));
    } else if (mime === 'image/jpeg' || mime === 'image/png') {
      parts.push(h('p', { class: 'muted small' }, mime === 'image/jpeg' ? 'No EXIF metadata.' : 'No EXIF (eXIf) chunk.'));
    } else {
      parts.push(h('p', { class: 'muted small' }, `EXIF reading is only done for JPEG and PNG; ${LABEL[mime]} metadata is not shown.`));
    }
    if (meta.text.length) {
      parts.push(h('h3', { class: 'dt-img-h' }, 'PNG text chunks'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Chunk'), h('th', {}, 'Keyword'), h('th', {}, 'Text'))),
        h('tbody', {}, meta.text.map((t) => h('tr', {}, h('td', { class: 'mono' }, t.chunk), h('td', { class: 'mono' }, t.keyword),
          h('td', { class: 'mono dt-img-text' }, t.text.length > 4000 ? `${t.text.slice(0, 4000)}…` : t.text)))))));
    }
    clear(metaBox, ...parts);
  }

  /* ---------- pipeline ---------- */
  function buildStage() {
    const orient = applyOrient.querySelector('input').checked ? img.orientation : 1;
    const key = `${orient}|${rot}|${flipH}|${flipV}`;
    fH.setAttribute('aria-pressed', String(flipH)); fV.setAttribute('aria-pressed', String(flipV));
    if (stage && key === stageKey) return;
    const o = L.orientationMatrix(orient, img.rawW, img.rawH);
    const r = L.rotateMatrix(rot, flipH, flipV, o.width, o.height);
    const c = h('canvas', { width: r.width, height: r.height, class: 'dt-img-canvas', role: 'img', 'aria-label': `Source image, ${r.width} by ${r.height} pixels` });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(...L.multiply(r.matrix, o.matrix));
    ctx.drawImage(img.bitmap, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    stage = c; stageKey = key;
    clear(stageWrap, stage, cropBox);
  }

  function update() {
    if (!img) return;
    try { buildStage(); syncCropFields(); scheduleOutput.now(); } catch (e) { show(outNotice, 'err', `✗ ${e.message || e}`); }
  }

  let outSeq = 0;
  async function renderOutput() {
    if (!img || !stage) return;
    const mine = ++outSeq;
    try {
      const area = crop ? L.clampCrop(crop, stage.width, stage.height) : { x: 0, y: 0, w: stage.width, h: stage.height };
      let size = { width: area.w, height: area.h };
      if (resizeOn.querySelector('input').checked) {
        size = L.resizeTo(area.w, area.h, { mode: resizeMode.value, width: rw.value, height: rh.value, pct: pct.value,
          lock: lock.querySelector('input').checked, changed: changedSide });
        if (size.error) return show(outNotice, 'err', `✗ ${size.error}`);
      }
      const type = format.value;
      const out = h('canvas', { width: size.width, height: size.height });
      const ctx = out.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size.width, size.height); }  // JPEG has no alpha
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(stage, area.x, area.y, area.w, area.h, 0, 0, size.width, size.height);
      const blob = await canvasToBlob(out, type, Number(quality.value) / 100);
      if (mine !== outSeq) return;
      if (result) URL.revokeObjectURL(result.url);
      result = { blob, url: URL.createObjectURL(blob), width: size.width, height: size.height, type: blob.type };
      resultImg.src = result.url;
      const diff = Math.round((blob.size / img.bytes.length - 1) * 100);
      clear(resultInfo, h('strong', {}, `${size.width} × ${size.height} px`), ` · ${LABEL[blob.type] || blob.type} · `,
        h('strong', {}, `${(blob.size / 1024).toFixed(1)} KB`), h('span', { class: 'muted' }, ` (${diff >= 0 ? '+' : ''}${diff}% vs original ${fmt.bytes(img.bytes.length)})`));
      if (blob.type !== type) show(outNotice, 'warn', `⚠ This browser cannot encode ${LABEL[type]}; the result is ${LABEL[blob.type] || blob.type}.`);
      else show(outNotice, '');
    } catch (e) { if (mine === outSeq) show(outNotice, 'err', `✗ ${e.message || e}`); }
  }
  const scheduleOutput = debounce(renderOutput, 200);
  scheduleOutput.now = renderOutput;
  format.addEventListener('click', () => setOpt(T, 'formatChosen', true));

  async function stripMetadata() {
    if (!img) return;
    try {
      const o = L.orientationMatrix(img.orientation, img.rawW, img.rawH);
      const c = h('canvas', { width: o.width, height: o.height });
      const ctx = c.getContext('2d');
      const type = EXT[img.mime] ? img.mime : 'image/png';
      if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, o.width, o.height); }
      ctx.setTransform(...o.matrix);
      ctx.drawImage(img.bitmap, 0, 0);
      const blob = await canvasToBlob(c, type, 0.92);
      download(blob, L.exportName(img.file.name, EXT[blob.type] || 'png', 'clean'));
      show(status, 'ok', `✓ Saved a copy without metadata (${fmt.bytes(blob.size)}). EXIF — including any GPS location — and text chunks are gone; `
        + `the EXIF orientation was applied to the pixels first so it still displays upright${img.mime === 'image/gif' ? '; the GIF was saved as PNG (first frame)' : ''}.`);
    } catch (e) { show(status, 'err', `✗ ${e.message || e}`); }
  }

  /* ---------- pointer: crop drag + pixel inspector ---------- */
  let dragFrom = null;
  const toImage = (e) => {
    const r = stage.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * stage.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * stage.height);
    return [Math.min(Math.max(x, 0), stage.width - 1), Math.min(Math.max(y, 0), stage.height - 1), r];
  };
  function inspect(x, y) {
    try {
      const [r, g, b, a] = stage.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
      lastHex = L.toHex(r, g, b);
      swatch.style.background = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
      pixelText.textContent = `x ${x}, y ${y} · ${lastHex} · rgb(${r}, ${g}, ${b})${a < 255 ? ` · alpha ${(a / 255).toFixed(2)}` : ''}`;
      pixelCopy.hidden = false;
    } catch { pixelText.textContent = 'Pixel colours are unavailable for this image.'; }
  }
  stageWrap.addEventListener('pointerdown', (e) => {
    if (!stage || e.button !== 0) return;
    e.preventDefault();
    dragFrom = toImage(e).slice(0, 2);
    stageWrap.setPointerCapture(e.pointerId);
  });
  stageWrap.addEventListener('pointermove', (e) => {
    if (!stage) return;
    const [x, y] = toImage(e);
    inspect(x, y);
    if (!dragFrom) return;
    crop = L.rectFromPoints(dragFrom[0], dragFrom[1], x + 1, y + 1, stage.width, stage.height);
    drawCropBox();
  });
  stageWrap.addEventListener('pointerup', (e) => {
    if (!dragFrom || !stage) return;
    const [x, y] = toImage(e);
    const tiny = Math.abs(x - dragFrom[0]) < 3 && Math.abs(y - dragFrom[1]) < 3;
    dragFrom = null;
    if (tiny) { crop = crop && crop.w > 3 ? crop : null; inspect(x, y); }
    syncCropFields(); scheduleOutput();
  });
  stageWrap.addEventListener('pointercancel', () => { dragFrom = null; });

  /* ---------- paste an image ---------- */
  const el = h('div', { class: 'stack dt-tool dt-img' }, drop, status, infoBox, metaBox, workArea);
  el.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); load(f); }
  });

  renderResizeMode(); renderQuality();
  return {
    el,
    clear() {
      seq++; outSeq++;
      img?.bitmap?.close?.();
      if (result) URL.revokeObjectURL(result.url);
      img = null; stage = null; stageKey = ''; result = null; crop = null; rot = 0; flipH = false; flipV = false; lastHex = '';
      resultImg.removeAttribute('src'); clear(resultInfo); clear(stageWrap); clear(infoBox); clear(metaBox);
      rw.value = ''; rh.value = ''; resizeOn.querySelector('input').checked = false; cropOn.querySelector('input').checked = false;
      pixelText.textContent = 'Hover the image to read pixel colours.'; swatch.style.background = ''; pixelCopy.hidden = true;
      drop.querySelector('input').value = '';
      for (const n of [status, outNotice, copyNotice]) show(n, '');
      workArea.hidden = true;
    },
    focus() { drop.focus(); },
  };
}
