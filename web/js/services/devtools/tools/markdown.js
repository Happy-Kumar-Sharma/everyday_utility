// 📝 Markdown preview — rendered in the browser by markdown.logic.js (a safe subset of CommonMark + GFM).
// The preview is built with h() from a tree of known tags: raw HTML in the input is shown as text, never parsed.

import { checkbox, segmented } from '../../../core/components.js';
import { clear, copyText, debounce, downloadText, fmt, h, loadCss, toast } from '../../../core/dom.js';
import { highlight } from '../../../core/highlight.js';
import { area, labelled, notice, opt, setOpt, show } from '../ui.js';
import { HIGHLIGHT_LANGS, headings, htmlDocument, parseMarkdown, plainText, stats, toHtml } from './markdown.logic.js';

const T = 'markdown';
const ID_PREFIX = 'md-';  // heading ids in the live preview are prefixed so they can't clash with the app's own ids

const SAMPLE = `# Release notes

Some **bold**, *italic*, ~~struck~~ and \`inline code\`. Raw <b>HTML</b> stays text.

## Checklist
- [x] Parse YAML safely
- [ ] Write the docs
  1. nested
  2. ordered

> Block quotes work too,
> and so do [links](https://example.com) and <https://autolinks.example>.

| Step | Status | Time |
|:-----|:------:|-----:|
| build | ✅ | 1m 20s |
| test  | ❌ | 4m 02s |

\`\`\`sql
SELECT id, name FROM users WHERE created_at > now() - interval '7 days';
\`\`\`

---
Line one with a hard break··
line two (two trailing spaces above).
`.replace('··', '  ');

export default function build() {
  loadCss('/static/css/devtools-formats.css');
  let tree = [];
  let syncing = null;  // which pane is driving the scroll sync right now

  const input = area({ rows: 20, placeholder: '# Paste or write Markdown…', 'aria-label': 'Markdown source', class: 'dt-input mono dt-md-editor' });
  const preview = h('div', { class: 'dt-md-preview', role: 'region', 'aria-label': 'Rendered preview', tabindex: 0 });
  const status = notice();
  const counts = h('span', { class: 'muted small dt-md-stats', 'aria-live': 'polite' });
  const tocList = h('ol', { class: 'dt-md-toc-list' });
  const toc = h('details', { class: 'dt-md-toc', open: opt(T, 'tocOpen', false), ontoggle: () => setOpt(T, 'tocOpen', toc.open) },
    h('summary', {}, 'Contents'), tocList);

  const layout = h('div', { class: 'dt-md-split' });
  const view = segmented([{ value: 'split', label: 'Split' }, { value: 'edit', label: 'Editor' }, { value: 'preview', label: 'Preview' }],
    opt(T, 'view', 'split'), (v) => { setOpt(T, 'view', v); applyView(); });
  const syncScroll = checkbox('Sync scroll', opt(T, 'sync', true), (v) => setOpt(T, 'sync', v));
  const remoteImages = checkbox('Load remote images', opt(T, 'remoteImages', false), (v) => { setOpt(T, 'remoteImages', v); render(); },
    'Off: http(s) images show as a placeholder, so opening a document never contacts other servers');
  const isOn = (cb) => cb.querySelector('input').checked;

  function applyView() {
    layout.dataset.view = view.value;
  }

  /* ---------- tree → DOM (only tags/attributes produced by markdown.logic.js) */
  function toDom(node) {
    if (typeof node === 'string') return node;
    const attrs = { ...(node.attrs || {}) };
    if (node.tag === 'pre') {
      const code = node.children[0];
      const text = code.children.join('');
      const type = HIGHLIGHT_LANGS[(node.lang || '').toLowerCase()];
      return h('pre', { class: 'code dt-md-code', dataset: node.lang ? { lang: node.lang } : undefined },
        h('code', code.attrs || {}, type && text.length < 100_000 ? highlight(text, type) : text));
    }
    if (/^h[1-6]$/.test(node.tag) && attrs.id) attrs.id = ID_PREFIX + attrs.id;
    if (node.tag === 'a') {
      const href = attrs.href || '';
      if (href.startsWith('#')) {
        attrs.onclick = (e) => { e.preventDefault(); scrollToHeading(decodeURIComponent(href.slice(1))); };
      } else {
        attrs.target = '_blank';
        attrs.rel = 'noopener noreferrer';
      }
    }
    if (node.tag === 'img') {
      const remote = /^https?:/i.test(attrs.src || '');
      if (remote && !isOn(remoteImages)) {
        return h('span', { class: 'dt-md-img-blocked', title: attrs.src }, '🖼 ', attrs.alt || 'image', h('span', { class: 'muted' }, ' (remote image not loaded)'));
      }
      attrs.loading = 'lazy';
      attrs.referrerpolicy = 'no-referrer';
    }
    return h(node.tag, attrs, (node.children || []).map(toDom));
  }

  function scrollToHeading(id) {
    const target = preview.querySelector(`#${CSS.escape(ID_PREFIX + id)}`);
    if (!target) return;
    preview.scrollTop = target.offsetTop - preview.offsetTop - 8;
    target.classList.add('dt-md-flash');
    setTimeout(() => target.classList.remove('dt-md-flash'), 900);
  }

  function render() {
    const md = input.value;
    try {
      tree = parseMarkdown(md);
      clear(preview, md.trim() ? tree.map(toDom) : h('p', { class: 'muted' }, 'The preview appears here.'));
      const hs = headings(tree);
      clear(tocList, hs.map((x) => h('li', { class: `dt-md-toc-l${x.level}` },
        h('a', { href: `#${x.id}`, onclick: (e) => { e.preventDefault(); scrollToHeading(x.id); } }, x.text || '(empty heading)'))));
      toc.hidden = !hs.length;
      toc.querySelector('summary').textContent = `Contents (${hs.length})`;
      const st = stats(md, tree);
      counts.textContent = md ? `${fmt.int(st.words)} words · ${fmt.int(st.chars)} characters · ${fmt.int(st.lines)} lines · ~${st.readingMinutes} min read` : '';
      show(status, '');
    } catch (e) {
      tree = [];
      show(status, 'err', `✗ Could not render this document: ${e instanceof RangeError ? 'it is nested too deeply' : e.message}`);
    }
  }

  /* ---------- outputs */
  const html = () => toHtml(tree);
  const title = () => headings(tree)[0]?.text || 'Document';
  const fileBase = () => (title().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'document');

  async function copyRich() {
    if (!input.value.trim()) return;
    const htmlText = html();
    try {
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([htmlText], { type: 'text/html' }),
        'text/plain': new Blob([plainText(tree)], { type: 'text/plain' }),
      })]);
      toast('Copied as rich text', 'ok');
    } catch {
      await copyText(htmlText, 'Rich text copy is not supported here — copied the HTML instead');
    }
  }

  async function openFile(file) {
    try {
      if (file.size > 5 * 1024 * 1024) { show(status, 'err', `✗ ${file.name} is ${fmt.bytes(file.size)}; open files up to 5 MB.`); return; }
      input.value = await file.text();
      render();
    } catch (e) { show(status, 'err', `✗ Could not read ${file.name}: ${e.message}`); }
  }
  const fileInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: true,
    onchange: () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) openFile(f); } });

  /* ---------- scroll sync (proportional) */
  function follow(from, to) {
    if (!isOn(syncScroll) || view.value !== 'split') return;
    if (syncing && syncing !== from) return;  // this scroll was caused by us
    syncing = from;
    const max = from.scrollHeight - from.clientHeight;
    to.scrollTop = max > 0 ? (from.scrollTop / max) * (to.scrollHeight - to.clientHeight) : 0;
    clearTimeout(follow.t);
    follow.t = setTimeout(() => { syncing = null; }, 80);
  }
  input.addEventListener('scroll', () => follow(input, preview));
  preview.addEventListener('scroll', () => follow(preview, input));

  const live = debounce(render, 150);
  const liveBig = debounce(render, 500);
  input.addEventListener('input', () => (input.value.length > 200_000 ? liveBig() : live()));
  input.addEventListener('keydown', (e) => {  // Tab indents instead of leaving the editor; Esc then Tab still moves focus
    if (e.key === 'Escape') { input.dataset.tabOut = '1'; return; }
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || input.dataset.tabOut) { delete input.dataset.tabOut; return; }
    e.preventDefault();
    input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
    live();
  });
  input.addEventListener('blur', () => { delete input.dataset.tabOut; });

  clear(layout, labelled('Markdown', input), h('div', { class: 'field dt-md-pane' }, h('span', {}, 'Preview'), preview));
  applyView();
  render();

  const el = h('div', { class: 'stack dt-tool dt-md' },
    h('div', { class: 'row' }, view, syncScroll, remoteImages,
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { input.value = SAMPLE; render(); } }, 'Sample'),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => fileInput.click() }, '📂 Open .md'), fileInput),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn sm', title: 'Copy the rendered HTML source (escaped)', onclick: () => input.value.trim() && copyText(html(), 'HTML copied') }, 'Copy HTML'),
      h('button', { type: 'button', class: 'btn sm', title: 'Copy formatted text to paste into email, docs or chat', onclick: copyRich }, 'Copy rich text'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => input.value && downloadText(input.value, `${fileBase()}.md`) }, '⬇ .md'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => input.value.trim() && downloadText(htmlDocument(tree, title()), `${fileBase()}.html`) }, '⬇ .html'),
      counts),
    status, toc, layout,
    h('p', { class: 'muted small' }, 'Links open in a new tab and only http(s), mailto, relative and #anchor targets become links; javascript: and other schemes stay text. Tab indents in the editor — press Esc, then Tab, to move on.'));

  return {
    el,
    clear() { input.value = ''; render(); },
    focus() { input.focus(); },
  };
}
