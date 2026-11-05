// HTTP reference: searchable status codes + headers, and an "explain this response" box.

import { clear, debounce, h, loadCss } from '../../../core/dom.js';
import { area, copyBtn, labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './http.logic.js';

const T = 'http';
const MAX_SHOWN = 200;

function statusPillClass(cls) {
  return { '1xx': '', '2xx': 'ok', '3xx': 'run', '4xx': 'warn', '5xx': 'err' }[cls] ?? '';
}

function entryView(e) {
  if (e.type === 'status') {
    return h('details', { class: 'dt-http-item' },
      h('summary', {},
        h('span', { class: `pill ${statusPillClass(e.cls)} mono dt-http-code` }, String(e.code)),
        h('span', { class: 'dt-http-name' }, e.name),
        e.nonStandard ? h('span', { class: 'pill', title: 'Not in the IANA registry' }, `non-standard · ${e.nonStandard}`) : null,
        h('span', { class: 'muted small dt-http-short' }, e.desc)),
      h('div', { class: 'dt-http-body stack' },
        h('p', {}, e.desc),
        h('div', {}, h('strong', {}, 'Typical causes: '), e.causes),
        h('div', {}, h('strong', {}, 'What to check: '), e.check),
        h('div', { class: 'row' }, copyBtn(() => `${e.code} ${e.name}`, 'Copy "code name"'))));
  }
  return h('details', { class: 'dt-http-item' },
    h('summary', {},
      h('span', { class: 'pill mono dt-http-code' }, e.kind === 'both' ? 'req/res' : e.kind === 'request' ? 'req' : 'res'),
      h('span', { class: 'dt-http-name mono' }, e.name),
      e.tags.filter((t) => ['security', 'cors', 'caching'].includes(t)).map((t) => h('span', { class: 'pill' }, t)),
      h('span', { class: 'muted small dt-http-short' }, e.desc)),
    h('div', { class: 'dt-http-body stack' },
      h('p', {}, e.desc),
      h('div', { class: 'dt-http-example row' }, h('code', { class: 'mono' }, e.example), copyBtn(() => e.example, 'Copy example')),
      e.gotchas ? h('div', {}, h('strong', {}, 'Gotchas: '), e.gotchas) : null));
}

export default function build() {
  loadCss('/static/css/devtools-web.css');
  const search = h('input', { type: 'search', placeholder: 'Search: 404, cors, cache, "rate limit", Set-Cookie…', 'aria-label': 'Search status codes and headers' });
  let filter = opt(T, 'filter', 'all');
  const count = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const list = h('div', { class: 'dt-http-list' });

  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  const renderChips = () => clear(chips, L.FILTERS.map(([v, label]) => h('button', {
    type: 'button', class: `chip ${v === filter ? 'on' : ''}`, 'aria-pressed': String(v === filter),
    onclick: () => { filter = v; setOpt(T, 'filter', v); renderChips(); render(); },
  }, label)));

  function render() {
    try {
      const results = L.searchReference(search.value, filter);
      count.textContent = results.length > MAX_SHOWN ? `${results.length} matches (first ${MAX_SHOWN} shown)` : `${results.length} match${results.length === 1 ? '' : 'es'}`;
      clear(list, results.length ? results.slice(0, MAX_SHOWN).map(entryView) : h('p', { class: 'muted' }, 'Nothing matches — try fewer words or the "All" filter.'));
      if (results.length === 1) list.querySelector('details').open = true;
    } catch (e) {
      clear(list, h('div', { class: 'notice err' }, `Search failed: ${e.message}`));
    }
  }

  // ---- explain this response
  const raw = area({ rows: 8, placeholder: 'HTTP/1.1 200 OK\ncontent-type: text/html\ncache-control: no-store, max-age=600\naccess-control-allow-origin: *\naccess-control-allow-credentials: true' });
  const exStatus = notice();
  const exOut = h('div', { class: 'stack' });

  function explain() {
    clear(exOut);
    if (!raw.value.trim()) return show(exStatus, '');
    try {
      const r = L.explainResponse(raw.value);
      if (!r.headers.length && !r.status) return show(exStatus, 'warn', 'No headers recognised — paste lines like "Name: value" (copy "Response Headers" from DevTools, or curl -I output).');
      const errs = r.warnings.filter((x) => x.level === 'err').length;
      const warns = r.warnings.filter((x) => x.level === 'warn').length;
      show(exStatus, errs ? 'err' : warns ? 'warn' : 'ok',
        `${r.headers.length} header${r.headers.length === 1 ? '' : 's'} · ${r.headers.filter((x) => x.info).length} recognised · ${errs} problem${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`);
      clear(exOut,
        r.status ? h('div', { class: 'row' },
          h('span', { class: `pill mono ${statusPillClass(r.statusInfo?.cls ?? '')}` }, String(r.status)),
          h('strong', {}, r.statusInfo ? r.statusInfo.name : 'Unknown status code'),
          r.statusInfo ? h('span', { class: 'muted small' }, r.statusInfo.desc) : null) : null,
        r.warnings.length ? h('ul', { class: 'dt-http-warnings' }, r.warnings.map((x) => h('li', { class: `dt-http-w-${x.level}` },
          h('span', { class: `pill ${x.level === 'info' ? '' : x.level}` }, x.level === 'err' ? 'problem' : x.level === 'warn' ? 'warning' : 'info'), ' ', x.text))) : null,
        r.headers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data dt-http-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Header'), h('th', {}, 'Value'), h('th', {}, 'Meaning'))),
          h('tbody', {}, r.headers.map((x) => h('tr', {},
            h('td', { class: 'mono' }, x.name),
            h('td', { class: 'mono dt-http-val' }, x.value),
            h('td', {}, x.info ? x.info.desc : h('span', { class: 'muted' }, 'Not in this reference (custom or rare header).'),
              x.notes.map((n) => h('div', { class: 'small dt-http-note' }, '→ ', n)))))))) : null,
        r.unparsed.length ? h('p', { class: 'muted small' }, `Skipped ${r.unparsed.length} line${r.unparsed.length === 1 ? '' : 's'} that are not "Name: value".`) : null);
    } catch (e) {
      show(exStatus, 'err', `Could not analyse: ${e.message}`);
    }
  }

  const liveSearch = debounce(render, 120);
  search.addEventListener('input', liveSearch);
  raw.addEventListener('input', debounce(explain, 200));
  renderChips(); render();

  return {
    el: h('div', { class: 'stack dt-tool dt-http' },
      h('div', { class: 'row dt-http-search' }, search, count),
      chips, list,
      h('h3', { class: 'dt-http-h' }, 'Explain this response'),
      h('p', { class: 'muted small' }, 'Paste raw response headers (DevTools → Network → Response Headers → Raw, or curl -sI). Nothing is sent anywhere.'),
      labelled('Response headers', raw), exStatus, exOut),
    clear() { search.value = ''; raw.value = ''; render(); explain(); },
    focus() { search.focus(); },
  };
}
