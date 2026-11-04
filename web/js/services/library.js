// 📚 Library: saved queries / commands / links / notes as files, with card + list views, templates,
// favourites, usage stats, prod guard and runnable shell items.

import { api, get, post } from '../core/api.js';
import { checkbox, jobConsole, openSettings, segmented } from '../core/components.js';
import { clear, confirmDialog, copyText, debounce, fmt, h, modal, store, toast, toastError } from '../core/dom.js';
import { fillTemplate, highlight, placeholders } from '../core/highlight.js';

const API = '/api/library';
const ICONS = { sql: '🗄️', mongo: '🍃', shell: '💻', python: '🐍', json: '🧾', yaml: '📐', link: '🔗', note: '📝' };
const TYPE_LABEL = { sql: 'SQL', mongo: 'Mongo', shell: 'Shell', python: 'Python', json: 'JSON', yaml: 'YAML', link: 'Link', note: 'Note' };
const ENV_CLASS = { prod: 'err', staging: 'warn', local: 'ok' };
const DESTRUCTIVE = /\b(delete|update|drop|truncate|alter|insert|grant|revoke)\b|\.(deleteOne|deleteMany|updateOne|updateMany|replaceOne|drop|remove|insertOne|insertMany)\s*\(|\brm\s+-[a-z]*r/i;
const unreadable = (i) => i.truncated || i.binary;  // content not loaded into the browser
const SORTS = [
  { value: 'updated', label: 'Recently edited' },
  { value: 'used', label: 'Recently used' },
  { value: 'uses', label: 'Most used' },
  { value: 'name', label: 'Name' },
];

export async function mount(root, { service }) {
  let data = null;
  const st = {
    scope: store.get('eu.lib.scope', 'all'),
    view: store.get('eu.lib.view', 'card'),
    sort: store.get('eu.lib.sort', 'updated'),
    type: '', env: '', tag: '', query: '',
  };
  const expanded = new Set();
  const save = () => { store.set('eu.lib.scope', st.scope); store.set('eu.lib.view', st.view); store.set('eu.lib.sort', st.sort); };

  const side = h('nav', { class: 'card lib-side', 'aria-label': 'Collections' });
  const banner = h('div', {});
  const toolbar = h('div', { class: 'stack', style: { gap: '10px' } });
  const listEl = h('div', {});
  root.append(banner, h('div', { class: 'lib-layout' }, side, h('div', { class: 'stack', style: { gap: '14px', minWidth: 0 } }, toolbar, listEl)));

  async function load() {
    try { data = await get(`${API}/items`); render(); } catch (e) { toastError(e); }
  }

  const writable = () => data && !data.problem && data.git.safe;

  /* ------------------------------------------------------------------ filtering */
  function scoped() {
    let items = data.items;
    if (st.scope === 'fav') items = items.filter((i) => i.favorite);
    else if (st.scope === 'recent') items = items.filter((i) => i.last_used);
    else if (st.scope === 'top') items = items.filter((i) => i.uses > 0);
    else if (st.scope.startsWith('coll:')) {
      const c = st.scope.slice(5);
      items = items.filter((i) => i.collection === c || i.collection.startsWith(`${c}/`));
    }
    return items;
  }

  function visible() {
    const q = st.query.toLowerCase();
    let items = scoped().filter((i) => (!st.type || i.type === st.type) && (!st.env || i.env === st.env) && (!st.tag || i.tags.includes(st.tag)));
    if (q) {
      // every word must match somewhere (name, collection, description, tags, content)
      const words = q.split(/\s+/).filter(Boolean);
      items = items.filter((i) => {
        const hay = `${i.name} ${i.collection} ${i.description} ${i.tags.join(' ')} ${i.content}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const sorters = {
      updated: (a, b) => b.mtime - a.mtime,
      used: (a, b) => (b.last_used || 0) - (a.last_used || 0),
      uses: (a, b) => b.uses - a.uses || b.mtime - a.mtime,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    const sortKey = st.scope === 'recent' ? 'used' : st.scope === 'top' ? 'uses' : st.sort;
    return [...items].sort(sorters[sortKey]);
  }

  /* ------------------------------------------------------------------ render */
  function render() {
    renderBanner();
    renderSide();
    renderToolbar();
    renderItems();
  }

  function renderBanner() {
    const g = data.git;
    clear(banner,
      (data.problem || !g.safe) && h('div', { class: 'notice err', style: { marginBottom: '12px' } },
        data.problem || `The library folder ${data.root} is inside the git repo ${g.repo} and not ignored, so a push would upload your queries. Saving is blocked.`,
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', type: 'button', onclick: settings }, '⚙ Change library folder'))));
  }

  function sideItem(scope, icon, label, count, extra) {
    return h('div', { class: `lib-side-row ${st.scope === scope ? 'active' : ''}` },
      h('button', { type: 'button', class: 'nav-item', onclick: () => { st.scope = scope; save(); render(); } },
        h('span', { class: 'nav-icon' }, icon), h('span', { class: 'grow' }, label), h('span', { class: 'muted small' }, count)),
      extra);
  }

  function renderSide() {
    const items = data.items;
    const count = (c) => items.filter((i) => i.collection === c || i.collection.startsWith(`${c}/`)).length;
    clear(side,
      sideItem('all', '📚', 'All items', items.length),
      sideItem('fav', '⭐', 'Favourites', items.filter((i) => i.favorite).length),
      sideItem('recent', '🕘', 'Recently used', items.filter((i) => i.last_used).length),
      sideItem('top', '🔥', 'Most used', items.filter((i) => i.uses > 0).length),
      h('div', { class: 'row', style: { margin: '12px 6px 4px' } }, h('span', { class: 'muted small', style: { fontWeight: 600, letterSpacing: '.04em' } }, 'COLLECTIONS'),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'New collection', disabled: !writable(), onclick: newCollection }, '＋')),
      data.collections.map((c) => {
        const depth = c.split('/').length - 1;
        return sideItem(`coll:${c}`, depth ? '└' : '📁', c.split('/').pop(), count(c),
          h('span', { class: 'lib-side-actions' },
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Rename', disabled: !writable(), onclick: () => renameCollection(c) }, '✎'),
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Delete (must be empty)', disabled: !writable(), onclick: () => deleteCollection(c) }, '✕')));
      }).map((el, i) => { el.style.paddingLeft = `${(data.collections[i].split('/').length - 1) * 14}px`; return el; }),
      !data.collections.length && h('p', { class: 'muted small', style: { margin: '4px 8px' } }, 'No collections yet.'),
      h('div', { style: { borderTop: '1px solid var(--border)', marginTop: '10px', paddingTop: '8px' } },
        h('button', { type: 'button', class: 'nav-item', onclick: showTrash }, h('span', { class: 'nav-icon' }, '🗑'), 'Trash'),
        h('button', { type: 'button', class: 'nav-item', onclick: settings }, h('span', { class: 'nav-icon' }, '⚙'), 'Library folder'),
        h('div', { class: 'muted small mono', style: { padding: '2px 10px', wordBreak: 'break-all' }, title: data.root }, data.root)));
  }

  const search = h('input', { type: 'search', placeholder: 'Search name, tags, content…   ( / )', 'aria-label': 'Search library',
    oninput: debounce(() => { st.query = search.value.trim(); renderItems(); }, 120) });

  function renderToolbar() {
    const present = [...new Set(scoped().map((i) => i.type))].sort();
    const tags = [...new Set(scoped().flatMap((i) => i.tags))].sort();
    if (st.type && !present.includes(st.type)) st.type = '';
    if (st.tag && !tags.includes(st.tag)) st.tag = '';
    const sortSel = h('select', { style: { width: 'auto' }, value: st.sort, 'aria-label': 'Sort', onchange: () => { st.sort = sortSel.value; save(); renderItems(); } },
      SORTS.map((s) => h('option', { value: s.value }, s.label)));
    clear(toolbar,
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, search,
        Object.assign(segmented([{ value: 'card', label: '▦ Cards' }, { value: 'list', label: '☰ List' }], st.view, (v) => { st.view = v; save(); renderItems(); }),
          { style: 'flex: none; flex-wrap: nowrap' }),
        h('button', { class: 'btn primary', type: 'button', disabled: !writable(), onclick: () => editItem(null) }, '＋ New')),
      h('div', { class: 'row' },
        h('div', { class: 'chips' },
          h('button', { type: 'button', class: `chip ${!st.type ? 'on' : ''}`, onclick: () => { st.type = ''; render(); } }, 'All types'),
          present.map((t) => h('button', { type: 'button', class: `chip ${st.type === t ? 'on' : ''}`, onclick: () => { st.type = st.type === t ? '' : t; render(); } }, `${ICONS[t]} ${TYPE_LABEL[t] || t}`))),
        h('span', { style: { flex: 1 } }),
        segmented([{ value: '', label: 'Any env' }, { value: 'local', label: 'local' }, { value: 'staging', label: 'staging' }, { value: 'prod', label: 'prod' }], st.env,
          (v) => { st.env = v; renderItems(); }),
        sortSel),
      tags.length > 0 && h('div', { class: 'chips' }, tags.map((t) => h('button', { type: 'button', class: `chip ${st.tag === t ? 'on' : ''}`,
        onclick: () => { st.tag = st.tag === t ? '' : t; render(); } }, `#${t}`))));
  }

  function renderItems() {
    const items = visible();
    if (!data.items.length) {
      return clear(listEl, h('div', { class: 'card' }, h('div', { class: 'card-body', style: { alignItems: 'flex-start' } },
        h('h2', {}, 'Your library is empty'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Start with ready-made collections (Prod / Staging / Local / Mongo queries, Commands, Favourite apps) pre-filled with the pipeline queries and commands — or create your own.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', disabled: !writable(), onclick: seed }, '✨ Add starter collections'),
          h('button', { class: 'btn', type: 'button', disabled: !writable(), onclick: () => editItem(null) }, '＋ New item')))));
    }
    if (!items.length) return clear(listEl, h('div', { class: 'notice' }, 'Nothing matches these filters.'));
    clear(listEl, st.view === 'card'
      ? h('div', { class: 'lib-grid' }, items.map(card))
      : h('div', { class: 'card', style: { overflow: 'hidden' } }, items.map(row)));
  }

  /* ------------------------------------------------------------------ item views */
  const envPill = (i) => i.env && h('span', { class: `pill ${ENV_CLASS[i.env] || ''}` }, i.env);
  const preview = (i, lines = 8) => {
    const text = i.truncated ? `(${fmt.bytes(i.size)} — too large to preview)` : i.binary ? '(not UTF-8 text — open it in your editor)' : i.content.split('\n').slice(0, lines).join('\n');
    const pre = h('pre', { class: `lib-code ${i.content.split('\n').length > lines ? 'fade' : ''}` });
    pre.append(highlight(text, i.type));
    return pre;
  };
  const star = (i) => h('button', { class: `btn sm ghost lib-star ${i.favorite ? 'on' : ''}`, type: 'button', title: i.favorite ? 'Unfavourite' : 'Favourite',
    'aria-pressed': String(i.favorite), disabled: !writable(), onclick: (e) => { e.stopPropagation(); toggleFav(i); } }, i.favorite ? '★' : '☆');

  function actions(i, compact = false) {
    return h('div', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' }, onclick: (e) => e.stopPropagation() },
      i.type === 'link'
        ? h('button', { class: 'btn sm primary', type: 'button', disabled: unreadable(i), onclick: () => use(i, 'open') }, '↗ Open')
        : h('button', { class: 'btn sm primary', type: 'button', disabled: unreadable(i), title: unreadable(i) ? 'Too large / not text — open the file in your editor' : null, onclick: () => use(i, 'copy') }, '📋 Copy'),
      i.type === 'link' && h('button', { class: 'btn sm', type: 'button', title: 'Copy URL', onclick: () => use(i, 'copy') }, '📋'),
      i.type === 'shell' && h('button', { class: 'btn sm', type: 'button', title: 'Run as a background job', disabled: unreadable(i), onclick: () => use(i, 'run') }, '▶ Run'),
      h('button', { class: 'btn sm', type: 'button', disabled: !writable(), onclick: () => editItem(i) }, compact ? '✎' : 'Edit'),
      h('button', { class: 'btn sm ghost', type: 'button', title: 'More', onclick: () => more(i) }, '⋯'));
  }

  function card(i) {
    return h('article', { class: 'card lib-card', tabindex: 0, onclick: () => view(i), onkeydown: (e) => { if (e.key === 'Enter') view(i); } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'flex-start' } },
        h('span', { class: 'lib-icon', title: TYPE_LABEL[i.type] }, ICONS[i.type] || '📄'),
        h('div', { class: 'stack', style: { gap: '2px', flex: 1, minWidth: 0 } },
          h('b', { class: 'lib-title', title: i.path }, i.name),
          h('span', { class: 'muted small' }, i.collection || 'No collection', i.uses ? ` · used ${i.uses}×` : '')),
        envPill(i), star(i)),
      i.description && h('p', { class: 'muted small', style: { margin: 0 } }, i.description),
      i.type === 'link' ? h('div', { class: 'mono small lib-url' }, i.content.trim().split('\n')[0]) : preview(i),
      h('div', { class: 'row', style: { marginTop: 'auto' } },
        h('div', { class: 'chips', style: { flex: 1 } }, i.tags.map((t) => h('span', { class: 'pill' }, `#${t}`)),
          placeholders(i.content).length > 0 && h('span', { class: 'pill run', title: 'Has {{placeholders}} — you will be asked for values' }, `{{${placeholders(i.content).length}}}`)),
        actions(i, true)));
  }

  function row(i) {
    const open = expanded.has(i.path);
    const toggle = () => { open ? expanded.delete(i.path) : expanded.add(i.path); renderItems(); };
    return h('div', { class: 'lib-row' },
      h('div', { class: 'lib-row-main', role: 'button', tabindex: 0, 'aria-expanded': String(open), onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter') toggle(); } },
      star(i),
      h('span', { class: 'lib-icon sm' }, ICONS[i.type] || '📄'),
      h('div', { class: 'stack', style: { gap: 0, flex: '3 1 260px', minWidth: '180px' } },
        h('b', { class: 'lib-title' }, i.name), i.description && h('span', { class: 'muted small lib-title' }, i.description)),
      h('span', { class: 'muted small lib-col-coll' }, i.collection),
      h('span', { class: 'lib-col-env' }, envPill(i)),
      h('span', { class: 'lib-col-tags chips' }, i.tags.slice(0, 3).map((t) => h('span', { class: 'pill' }, `#${t}`))),
      h('span', { class: 'muted small lib-col-meta', title: `${i.uses} uses` }, i.uses ? `${i.uses}×` : '', ' ', fmt.ago(i.mtime)),
      actions(i, true)),
      open && h('div', { style: { padding: '0 14px 12px 50px' } }, i.type === 'link' ? h('div', { class: 'mono small' }, i.content) : preview(i, 40)));
  }

  // actions() stops propagation (so cards don't open the viewer); capture the click to close the viewer first
  const closeOnClick = (el, close) => { el.addEventListener('click', (e) => { if (e.target.closest('button')) close(); }, true); return el; };

  function view(i) {
    modal(i.name, (close) => {
      const pre = h('pre', { class: 'lib-code', style: { maxHeight: '60vh' } });
      pre.append(highlight(i.truncated ? `(${fmt.bytes(i.size)} — open the file directly)` : i.binary ? '(not UTF-8 text — open the file directly)' : i.content, i.type));
      return h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('span', {}, ICONS[i.type]), h('span', { class: 'muted small mono' }, i.path), envPill(i),
          i.tags.map((t) => h('span', { class: 'pill' }, `#${t}`)), h('span', { style: { flex: 1 } }), star(i)),
        i.description && h('p', { class: 'muted', style: { margin: 0 } }, i.description),
        pre,
        h('div', { class: 'row end' }, h('span', { class: 'muted small', style: { flex: 1 } }, `${i.uses} uses · edited ${fmt.ago(i.mtime)}`),
          closeOnClick(actions(i), close)));
    }, { drawer: true });
  }

  /* ------------------------------------------------------------------ use: copy / open / run */
  async function askValues(i, verb) {
    const vars = placeholders(i.content);
    if (!vars.length) return {};
    const key = `eu.lib.vals.${i.path}`;
    const remembered = store.get(key, {});
    const values = Object.fromEntries(vars.map((v) => [v.name, remembered[v.name] ?? '']));
    const result = await modal(`Fill in · ${i.name}`, (close) => {
      const out = h('pre', { class: 'lib-code', style: { maxHeight: '30vh' } });
      const update = () => clear(out).append(highlight(fillTemplate(i.content, values), i.type));
      const fields = vars.map((v) => {
        const big = /ids|list|values/i.test(v.name);
        const input = big
          ? h('textarea', { rows: 3, class: 'mono', placeholder: v.default ?? '', oninput: () => { values[v.name] = input.value; update(); } }, values[v.name])
          : h('input', { type: 'text', class: 'mono', value: values[v.name], placeholder: v.default ?? '', oninput: () => { values[v.name] = input.value; update(); } });
        return h('label', { class: 'field' }, h('span', {}, h('code', {}, `{{${v.name}}}`), v.default != null && h('span', { class: 'hint' }, `  default: ${v.default}`)), input);
      });
      update();
      return h('form', { class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        const missing = vars.filter((v) => !values[v.name] && v.default == null).map((v) => v.name);
        if (missing.length) return toastError(new Error(`Fill in: ${missing.join(', ')}`));
        close(true);
      } }, fields, h('b', {}, 'Preview'), out,
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Tip: for ids, paste a list from the Column Extractor (SQL IN (ids) preset without the brackets).'),
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, verb)));
    });
    if (!result) return null;
    store.set(key, values);
    return values;
  }

  async function use(i, action) {
    const verb = action === 'run' ? '▶ Run' : action === 'open' ? '↗ Open' : '📋 Copy';
    const values = await askValues(i, verb);
    if (values === null) return;
    const text = fillTemplate(i.content, values);
    if (i.env === 'prod' && DESTRUCTIVE.test(text) && action !== 'open') {
      const ok = await confirmDialog('⚠️ Prod item that changes data', h('div', { class: 'stack' },
        h('p', { style: { margin: 0 } }, `“${i.name}” is marked prod and contains a data-changing statement. Double-check before you use it.`),
        h('pre', { class: 'lib-code', style: { maxHeight: '30vh' } }, highlight(text, i.type))), { okLabel: action === 'run' ? 'Run on prod' : 'Copy anyway', danger: true });
      if (!ok) return;
    }
    if (action === 'copy') await copyText(i.type === 'link' ? text.trim().split('\n')[0] : text, `Copied “${i.name}”`);
    else if (action === 'open') window.open(text.trim().split('\n')[0], '_blank', 'noopener');
    else if (action === 'run') {
      const ok = await confirmDialog(`Run “${i.name}”?`, h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Runs in bash from your home folder as a background job:'),
        h('pre', { class: 'lib-code', style: { maxHeight: '40vh' } }, highlight(text, 'shell'))), { okLabel: '▶ Run' });
      if (!ok) return;
      try {
        const job = await post(`${API}/run`, { path: i.path, values });
        modal(`Job · ${i.name}`, () => jobConsole(job), { drawer: true });
        load();
      } catch (e) { toastError(e); }
      return;
    }
    if (writable()) post(`${API}/items/use`, { path: i.path }).then((m) => { Object.assign(i, m); }).catch(() => {});
  }

  /* ------------------------------------------------------------------ mutations */
  async function toggleFav(i) {
    try { await api(`${API}/items`, { method: 'PUT', body: { path: i.path, favorite: !i.favorite } }); await load(); } catch (e) { toastError(e); }
  }

  async function more(i) {
    const choice = await modal(i.name, (close) => h('div', { class: 'stack' },
      h('button', { class: 'btn', type: 'button', onclick: () => close('copypath') }, '📄 Copy file path'),
      h('button', { class: 'btn', type: 'button', disabled: !writable(), onclick: () => close('dup') }, '⧉ Duplicate'),
      h('button', { class: 'btn', type: 'button', disabled: unreadable(i), onclick: () => close('raw') }, '📋 Copy raw (keep {{placeholders}})'),
      h('button', { class: 'btn danger', type: 'button', disabled: !writable(), onclick: () => close('del') }, '🗑 Move to trash')));
    try {
      if (choice === 'copypath') copyText(`${data.root}/${i.path}`, 'Path copied');
      if (choice === 'raw') copyText(i.content, 'Copied');
      if (choice === 'dup') {
        await post(`${API}/items/duplicate`, { path: i.path });  // server-side copy: exact bytes, any size
        toast('Duplicated', 'ok'); load();
      }
      if (choice === 'del') {
        await post(`${API}/items/delete`, { path: i.path });
        toast(`Moved “${i.name}” to trash`); load();
      }
    } catch (e) { toastError(e); }
  }

  function editItem(i) {
    const types = Object.keys(TYPE_LABEL);
    const d = i ? { ...i, tags: i.tags.join(', ') }
      : { name: '', collection: st.scope.startsWith('coll:') ? st.scope.slice(5) : (data.collections[0] || ''), type: st.type || 'sql', ext: '', content: '', description: '', tags: '', env: st.env || '', favorite: false };
    modal(i ? `Edit · ${i.name}` : 'New item', (close) => {
      const name = h('input', { type: 'text', value: d.name, placeholder: 'e.g. daily_assessments_by_company', oninput: () => { d.name = name.value; } });
      const coll = h('input', { type: 'text', value: d.collection, list: 'lib-colls', placeholder: 'Prod queries  (type a new name to create it; a/b for nesting)', oninput: () => { d.collection = coll.value; } });
      const dl = h('datalist', { id: 'lib-colls' }, data.collections.map((c) => h('option', { value: c })));
      const ext = h('input', { type: 'text', value: i ? i.ext : (data.default_ext[d.type] || 'txt'), placeholder: '(none)', style: { maxWidth: '90px' }, 'aria-label': 'File extension', oninput: () => { d.ext = ext.value; } });
      const typeSel = h('select', { style: { width: 'auto' }, value: d.type, onchange: () => {
        d.type = typeSel.value; ext.value = d.ext = data.default_ext[d.type] || 'txt';
        content.placeholder = d.type === 'link' ? 'https://grafana.example.com/d/abc' : 'Paste your query / command…  {{name}} or {{name:default}} become fill-in fields';
      } }, types.map((t) => h('option', { value: t }, `${ICONS[t]} ${TYPE_LABEL[t]}`)));
      const tags = h('input', { type: 'text', value: d.tags, placeholder: 'reports, daily, billing', oninput: () => { d.tags = tags.value; } });
      const desc = h('input', { type: 'text', value: d.description, placeholder: 'What it does / when to use it', oninput: () => { d.description = desc.value; } });
      const hint = h('div', { class: 'muted small' });
      const content = h('textarea', { class: 'mono', rows: 16, spellcheck: false, readonly: !!(i && unreadable(i)),
        value: i && unreadable(i) ? `(${i.truncated ? `${fmt.bytes(i.size)} — too large` : 'not UTF-8 text'} to edit here; open ${data.root}/${i.path} in your editor. Name, tags and other fields can still be changed.)` : undefined,
        placeholder: 'Paste your query / command…  {{name}} or {{name:default}} become fill-in fields',
        oninput: () => { d.content = content.value; showVars(); },
        onkeydown: (e) => {
          if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = content.selectionStart; content.setRangeText('  ', s, content.selectionEnd, 'end'); d.content = content.value; }
        } }, d.content);
      const showVars = () => {
        const vars = placeholders(content.value);
        clear(hint, vars.length ? ['Fill-in fields: ', vars.map((v) => h('code', { style: { marginRight: '6px' } }, v.name))] : 'Tip: use {{ids}}, {{date:2026-01-01}} … for values you change each time; {{today}} / {{now}} fill in automatically.');
      };
      showVars();
      const submit = async (e) => {
        e?.preventDefault();
        const body = { name: d.name, collection: d.collection, ext: ext.value, type: d.type, content: content.value,
          description: d.description, tags: String(d.tags).split(',').map((t) => t.trim()).filter(Boolean), env: d.env, favorite: d.favorite };
        try {
          if (i) {
            // only send what changed: a tags-only edit never rewrites or renames the file
            if (unreadable(i) || body.content === i.content) delete body.content;
            if (body.name === i.name) delete body.name;
            if (body.collection === i.collection) delete body.collection;
            if (body.ext === i.ext) delete body.ext;
            await api(`${API}/items`, { method: 'PUT', body: { ...body, path: i.path, expected_mtime: i.mtime } });
          }
          else await post(`${API}/items`, body);
          toast(i ? 'Saved' : 'Created', 'ok'); close(); load();
        } catch (ex) { toastError(ex); }
      };
      const form = h('form', { class: 'stack', onsubmit: submit,
        onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') submit(e); } },
      h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } },
        h('label', { class: 'field', style: { flex: 1 } }, 'Name', name), h('label', { class: 'field' }, 'Type', typeSel), h('label', { class: 'field' }, 'Ext', ext)),
      h('label', { class: 'field' }, 'Collection', coll, dl),
      h('div', { class: 'row', style: { gap: '18px' } },
        h('div', { class: 'stack' }, h('b', {}, 'Environment'), segmented([{ value: '', label: 'none' }, { value: 'local', label: 'local' }, { value: 'staging', label: 'staging' }, { value: 'prod', label: 'prod' }], d.env, (v) => { d.env = v; })),
        checkbox('⭐ Favourite', d.favorite, (v) => { d.favorite = v; })),
      h('label', { class: 'field' }, 'Description', desc),
      h('label', { class: 'field' }, 'Tags', tags),
      h('label', { class: 'field' }, i?.type === 'link' || d.type === 'link' ? 'URL' : 'Content', content, hint),
      h('div', { class: 'row end' }, h('span', { class: 'muted small', style: { flex: 1 } }, 'Ctrl+S to save · saved as a real file you can also edit in your editor'),
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, i ? 'Save' : 'Create')));
      setTimeout(() => (i ? content : name).focus(), 0);
      return form;
    }, { drawer: true });
  }

  async function seed() {
    try { const r = await post(`${API}/seed`); toast(`Created collections + ${r.created} starter items`, 'ok'); load(); } catch (e) { toastError(e); }
  }

  async function newCollection() {
    const name = await modal('New collection', (close) => {
      const input = h('input', { type: 'text', placeholder: 'e.g. Prod queries/Reports' });
      return h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); close(input.value); } }, input,
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create')));
    });
    if (!name?.trim()) return;
    try { const r = await post(`${API}/collections`, { name }); st.scope = `coll:${r.name}`; save(); load(); } catch (e) { toastError(e); }
  }

  async function renameCollection(c) {
    const name = await modal(`Rename “${c}”`, (close) => {
      const input = h('input', { type: 'text', value: c });
      return h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); close(input.value); } }, input,
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Rename')));
    });
    if (!name?.trim() || name === c) return;
    try { const r = await post(`${API}/collections/rename`, { name: c, new_name: name }); st.scope = `coll:${r.name}`; save(); load(); } catch (e) { toastError(e); }
  }

  async function deleteCollection(c) {
    if (!(await confirmDialog(`Delete collection “${c}”?`, 'Only empty collections can be deleted (move or trash its items first).', { okLabel: 'Delete', danger: true }))) return;
    try { await post(`${API}/collections/delete`, { name: c }); if (st.scope === `coll:${c}`) st.scope = 'all'; save(); load(); } catch (e) { toastError(e); }
  }

  async function showTrash() {
    let items;
    try { items = await get(`${API}/trash`); } catch (e) { return toastError(e); }
    modal('Trash', (close) => h('div', { class: 'stack' },
      !items.length && h('p', { class: 'muted' }, 'Trash is empty.'),
      items.map((t) => h('div', { class: 'file-chip' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, t.path), h('div', { class: 'muted small' }, `deleted ${fmt.ago(t.deleted_at)}`)),
        h('button', { class: 'btn sm', type: 'button', disabled: !writable(), onclick: async () => {
          try { await post(`${API}/trash/restore`, { path: t.id }); toast('Restored', 'ok'); close(); load(); } catch (e) { toastError(e); }
        } }, 'Restore'))),
      h('p', { class: 'muted small', style: { margin: 0 } }, `Trashed files live in ${data.root}/.trash/ — delete them there to free space.`)), { drawer: true });
  }

  async function settings() {
    openSettings(service, await get(`/api/services/${service.id}/settings`), () => load());
  }

  // keyboard: "/" search, "n" new item (when not typing somewhere)
  document.addEventListener('keydown', (e) => {
    if (root.closest('[hidden]') || !root.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('.overlay')) return;
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    if (e.key === 'n' && writable()) { e.preventDefault(); editItem(null); }
  });

  // global search / palette: 'new' = new-item editor, anything else = an item path → its viewer
  async function open(ref) {
    await load();
    if (!data) return;
    if (ref === 'new') {
      if (!writable()) return toast('Saving is blocked for this library folder — see the notice above', 'err');
      return editItem(null);
    }
    const item = data.items.find((i) => i.path === ref);
    if (!item) return toast(`“${ref}” is no longer in the library`, 'err');
    view(item);
  }

  await load();
  return { onShow: load, open };
}
