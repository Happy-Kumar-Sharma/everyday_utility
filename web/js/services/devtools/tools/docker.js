// Docker / kubectl builder: docker run (+ compose YAML), common docker snippets and kubectl commands,
// each with Copy and "Save to Library" (Commands collection, .sh).

import { post } from '../../../core/api.js';
import { checkbox, segmented } from '../../../core/components.js';
import { clear, confirmDialog, copyText, debounce, h, loadCss } from '../../../core/dom.js';
import { labelled, notice, opt, setOpt, show } from '../ui.js';
import * as L from './docker.logic.js';

const T = 'docker';

const text = (placeholder, props = {}) => h('input', { type: 'text', class: 'mono', placeholder, spellcheck: false, autocomplete: 'off', ...props });
const lines = (placeholder, rows = 3) => h('textarea', { class: 'mono dt-docker-lines', rows, placeholder, spellcheck: false });
const select = (options, value) => h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
const field = (label, el, hint) => labelled(label, el, hint ? h('span', { class: 'hint' }, hint) : null);
const boxVal = (box) => box.querySelector('input').checked;
const setBox = (box, v) => { box.querySelector('input').checked = v; };

/** Output panel shared by the three builders: preview, danger badge, Copy, Save to Library. */
function resultPanel() {
  const status = notice();
  const warn = h('ul', { class: 'dt-docker-warnings', hidden: true });
  const dangerBox = h('div', { class: 'dt-docker-danger', hidden: true, role: 'alert' });
  const pre = h('pre', { class: 'code dt-docker-cmd', 'aria-label': 'Built command', tabindex: '0' });
  const nameInput = text('Name in Library', { 'aria-label': 'Library item name', class: 'dt-docker-libname' });
  const saveNotice = notice();
  let current = null;
  let nameTouched = false;
  nameInput.addEventListener('input', () => { nameTouched = true; });

  async function confirmed() {
    if (!current?.confirm) return true;
    return confirmDialog('Dangerous command', current.confirm, { okLabel: 'Yes, I understand', danger: true });
  }

  const copyB = h('button', { type: 'button', class: 'btn sm primary', onclick: async () => {
    if (current && (await confirmed())) copyText(current.command);
  } }, 'Copy');
  const saveB = h('button', { type: 'button', class: 'btn sm', onclick: save }, 'Save to Library');

  async function save() {
    if (!current) return;
    const name = nameInput.value.trim();
    if (!name) { show(saveNotice, 'err', 'Give the command a name first.'); nameInput.focus(); return; }
    if (/[/\\]/.test(name)) { show(saveNotice, 'err', 'The name cannot contain / or \\.'); return; }
    if (!(await confirmed())) return;
    saveB.disabled = true;
    show(saveNotice, '');
    try {
      const item = await post('/api/library/items', { collection: 'Commands', name, type: 'shell', content: `${current.command}\n` });
      show(saveNotice, 'ok', `✓ Saved to Library › Commands › ${item?.name || name}`);
    } catch (e) {
      // 409: the library folder is not git-safe (or misconfigured) — the server explains why
      show(saveNotice, 'err', e.status === 409 ? `Not saved: ${e.message}` : `Could not save: ${e.message}`);
    } finally {
      saveB.disabled = !current || current.errors.length > 0;
    }
  }

  const el = h('div', { class: 'stack dt-docker-result' },
    dangerBox, pre, status, warn,
    h('div', { class: 'row dt-docker-actions' }, copyB, nameInput, saveB),
    saveNotice);

  return {
    el,
    /** r: {command, display?, errors, warnings, danger?, confirm?}, suggestion: default library name */
    set(r, suggestion) {
      current = r;
      pre.textContent = r.display ?? r.command;
      const hasErr = r.errors.length > 0;
      show(status, hasErr ? 'err' : '', ...(hasErr ? [r.errors.join(' ')] : []));
      clear(warn, (r.warnings || []).map((w) => h('li', { class: 'small' }, w)));
      warn.hidden = !r.warnings?.length;
      dangerBox.hidden = !r.danger;
      clear(dangerBox, r.danger ? [h('span', { class: 'pill err' }, '⚠ danger'), ' ', r.danger] : []);
      copyB.disabled = hasErr; saveB.disabled = hasErr;
      if (!nameTouched && suggestion) nameInput.value = suggestion;
    },
    reset() { nameTouched = false; nameInput.value = ''; show(saveNotice, ''); },
  };
}

/* ------------------------------------------------------------------ docker run */
function runBuilder() {
  const f = {
    image: text('nginx:1.27 or ghcr.io/org/app:tag', { 'aria-required': 'true' }), name: text('my-container'),
    ports: lines('8080:80\n127.0.0.1:5432:5432\n53:53/udp'), volumes: lines('./data:/data\npgdata:/var/lib/postgresql/data\n/etc/ssl:/etc/ssl:ro'),
    env: lines('NODE_ENV=production\nAPI_TOKEN=…\nHOME   (no "=" passes it from your shell)'), envFile: text('.env'),
    network: text('bridge / host / my-net'), restart: select(L.RESTART.map((r) => [r, r || '(none)']), ''),
    retries: h('input', { type: 'number', min: 0, placeholder: 'max', 'aria-label': 'Max retries' }),
    user: text('1000:1000'), workdir: text('/app'), entrypoint: text('/bin/sh -c'), command: text('npm run start -- --port 3000'),
    labels: lines('com.example.team=data', 2),
  };
  const flags = {
    detach: checkbox('Detach (-d)', true, () => update()), rm: checkbox('Remove when stopped (--rm)', false, () => update()),
    it: checkbox('Interactive TTY (-it)', false, () => update()), gpus: checkbox('All GPUs (--gpus all)', false, () => update()),
  };
  const reveal = checkbox('Show env values', false, () => update(), 'Env values are masked in the preview; Copy and Save always use the real values');
  const panel = resultPanel();
  const compose = h('pre', { class: 'code dt-docker-cmd', 'aria-label': 'docker-compose YAML', tabindex: '0' });  // own pre: Copy must use real env values
  const composeCopy = h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(L.composeYaml(values())) }, 'Copy YAML');
  const retriesWrap = h('span', { hidden: true }, f.retries);

  const values = () => ({
    image: f.image.value.trim(), name: f.name.value.trim(), ports: f.ports.value, volumes: f.volumes.value, env: f.env.value,
    envFile: f.envFile.value.trim(), network: f.network.value.trim(), restart: f.restart.value, retries: f.retries.value,
    user: f.user.value.trim(), workdir: f.workdir.value.trim(), entrypoint: f.entrypoint.value.trim(), command: f.command.value,
    labels: f.labels.value, detach: boxVal(flags.detach), rm: boxVal(flags.rm), it: boxVal(flags.it), gpus: boxVal(flags.gpus),
  });

  function update() {
    try {
      retriesWrap.hidden = f.restart.value !== 'on-failure';
      const v = values();
      const r = L.buildDockerRun(v);
      const showVals = boxVal(reveal);
      panel.set({ ...r, display: showVals ? r.command : r.display }, `docker run ${v.name || v.image.split('/').pop() || ''}`.trim());
      compose.textContent = L.composeYaml(v, { mask: !showVals });
    } catch (e) {
      panel.set({ command: '', errors: [`Could not build: ${e.message}`], warnings: [] });
    }
  }
  const live = debounce(update, 150);
  for (const el of Object.values(f)) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', live);

  const el = h('div', { class: 'stack' },
    h('div', { class: 'dt-docker-grid' },
      field('Image', f.image), field('Container name', f.name),
      field('Network', f.network), labelled('Restart policy', h('span', { class: 'row' }, f.restart, retriesWrap)),
      field('User', f.user), field('Working dir', f.workdir),
      field('Entrypoint', f.entrypoint), field('Command / args', f.command),
      field('Env file', f.envFile)),
    h('div', { class: 'row dt-docker-flags' }, Object.values(flags)),
    h('div', { class: 'dt-docker-grid' },
      field('Ports', f.ports, 'one per line'), field('Volumes / binds', f.volumes, 'one per line, :ro for read-only'),
      field('Environment', f.env, 'KEY=value per line'), field('Labels', f.labels, 'key=value per line')),
    h('div', { class: 'row' }, h('strong', {}, 'docker run'), h('span', { class: 'spacer' }), reveal),
    panel.el,
    h('div', { class: 'row' }, h('strong', {}, 'docker-compose service'), h('span', { class: 'spacer' }), composeCopy),
    compose);
  update();
  return {
    el,
    clear() {
      for (const x of Object.values(f)) x.value = '';
      setBox(flags.detach, true); setBox(flags.rm, false); setBox(flags.it, false); setBox(flags.gpus, false); setBox(reveal, false);
      panel.reset(); update();
    },
    focus() { f.image.focus(); },
  };
}

/* ------------------------------------------------------------------ snippets */
function snippetBuilder() {
  let key = opt(T, 'snippet', 'logs');
  if (!L.SNIPPETS.some((s) => s.key === key)) key = 'logs';
  const f = {
    container: text('container name or id'), image: text('image:tag or id'), tail: text('100', { inputmode: 'numeric' }),
    shell: select([['sh', 'sh'], ['bash', 'bash'], ['ash', 'ash']], 'sh'), src: text('/path/in/source'), dest: text('./destination'),
    service: text('service (optional)'),
  };
  const vol = checkbox('Include volumes', false, () => update());
  const labels = { container: 'Container', image: 'Image', tail: 'Tail lines', shell: 'Shell', src: 'Source path', dest: 'Destination', service: 'Compose service' };
  const wraps = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, field(labels[k], el)]));
  const panel = resultPanel();
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Snippet' });
  const renderChips = () => clear(chips, L.SNIPPETS.map((s) => h('button', {
    type: 'button', class: `chip ${s.key === key ? 'on' : ''}`, 'aria-pressed': String(s.key === key),
    onclick: () => { key = s.key; setOpt(T, 'snippet', key); renderChips(); update(); },
  }, s.label, s.danger ? ' ⚠' : '')));

  function update() {
    try {
      const s = L.SNIPPETS.find((x) => x.key === key);
      for (const [k, w] of Object.entries(wraps)) w.hidden = !s.fields.includes(k);
      vol.hidden = !s.fields.includes('volumes');
      const params = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      params.volumes = boxVal(vol);
      const r = L.buildSnippet(key, params);
      panel.set({ ...r, warnings: [], confirm: r.danger ? `${r.danger} Continue?` : null }, `${s.label}${params.container ? ` ${params.container}` : ''}`);
    } catch (e) {
      panel.set({ command: '', errors: [e.message], warnings: [] });
    }
  }
  const live = debounce(update, 150);
  for (const el of Object.values(f)) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', live);
  renderChips(); update();
  return {
    el: h('div', { class: 'stack' }, chips, h('div', { class: 'dt-docker-grid' }, Object.values(wraps)), vol, panel.el),
    clear() { for (const x of Object.values(f)) x.value = x.tagName === 'SELECT' ? 'sh' : ''; setBox(vol, false); panel.reset(); update(); },
    focus() { chips.querySelector('.chip.on')?.focus(); },
  };
}

/* ------------------------------------------------------------------ kubectl */
const K_FIELDS = {
  get: ['type', 'name', 'selector', 'output', 'watch', 'allNs'],
  describe: ['type', 'name', 'selector', 'allNs'],
  logs: ['type', 'name', 'selector', 'follow', 'tail', 'container', 'previous', 'since'],
  exec: ['type', 'name', 'container', 'cmd'],
  'port-forward': ['type', 'name', 'ports', 'address'],
  'rollout-status': ['type', 'name'], 'rollout-restart': ['type', 'name'], 'rollout-history': ['type', 'name'], 'rollout-undo': ['type', 'name', 'revision'],
  scale: ['type', 'name', 'replicas'],
  apply: ['file', 'dryRun'],
  delete: ['type', 'name', 'selector', 'file', 'dryRun', 'allNs'],
  top: ['type', 'name', 'selector', 'allNs'],
};
const K_DEFAULT_TYPE = { 'rollout-status': 'deployments', 'rollout-restart': 'deployments', 'rollout-undo': 'deployments', 'rollout-history': 'deployments', scale: 'deployments' };

function kubectlBuilder() {
  let verb = opt(T, 'kverb', 'get');
  if (!K_FIELDS[verb]) verb = 'get';
  const f = {
    context: text('kube context (optional)'), namespace: text('default'),
    verb: select(L.K_VERBS, verb), type: select(L.K_TYPES.map((t) => [t, t]), K_DEFAULT_TYPE[verb] || 'pods'),
    name: text('resource name'), selector: text('app=web,tier!=cache'),
    output: select([['', '(default)'], ['wide', 'wide'], ['yaml', 'yaml'], ['json', 'json'], ['name', 'name'], ['jsonpath', 'jsonpath=…']], opt(T, 'koutput', '')),
    jsonpath: text('{.items[*].metadata.name}'), tail: text('100', { inputmode: 'numeric' }), container: text('container (optional)'),
    since: text('10m'), cmd: text('sh'), ports: text('8080:80'), address: text('127.0.0.1 (default)'),
    replicas: h('input', { type: 'number', min: 0, placeholder: '3' }), file: text('k8s/deployment.yaml or ./k8s/'), revision: text('previous', { inputmode: 'numeric' }),
  };
  const boxes = {
    allNs: checkbox('All namespaces (-A)', false, () => update()), follow: checkbox('Follow (-f)', true, () => update()),
    previous: checkbox('Previous container (--previous)', false, () => update()), watch: checkbox('Watch (-w)', false, () => update()),
    dryRun: checkbox('Dry run (--dry-run=server)', false, () => update()),
  };
  const labels = { context: 'Context', namespace: 'Namespace', verb: 'Action', type: 'Resource type', name: 'Name', selector: 'Label selector (-l)',
    output: 'Output (-o)', jsonpath: 'JSONPath', tail: 'Tail lines', container: 'Container (-c)', since: 'Since', cmd: 'Command', ports: 'Ports (local:remote)',
    address: 'Listen address', replicas: 'Replicas', file: 'File / folder / URL (-f)', revision: 'To revision' };
  const wraps = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, field(labels[k], el)]));
  const panel = resultPanel();

  function values() {
    return {
      context: f.context.value.trim(), namespace: f.namespace.value.trim(), allNamespaces: boxVal(boxes.allNs), verb: f.verb.value, type: f.type.value,
      name: f.name.value.trim(), selector: f.selector.value.trim(), output: f.output.value, jsonpath: f.jsonpath.value.trim(), follow: boxVal(boxes.follow),
      tail: f.tail.value.trim(), container: f.container.value.trim(), previous: boxVal(boxes.previous), since: f.since.value.trim(), cmd: f.cmd.value,
      ports: f.ports.value, address: f.address.value.trim(), replicas: f.replicas.value, file: f.file.value.trim(), revision: f.revision.value.trim(),
      watch: boxVal(boxes.watch), dryRun: boxVal(boxes.dryRun),
    };
  }

  function update() {
    try {
      const v = values();
      const shown = new Set(['context', 'namespace', 'verb', ...K_FIELDS[v.verb]]);
      for (const [k, w] of Object.entries(wraps)) w.hidden = !shown.has(k) && !(k === 'jsonpath' && shown.has('output') && v.output === 'jsonpath');
      for (const [k, b] of Object.entries(boxes)) b.hidden = !shown.has(k);
      wraps.namespace.hidden = v.allNamespaces && shown.has('allNs');
      const r = L.buildKubectl(v);
      const label = L.K_VERBS.find(([k]) => k === v.verb)?.[1] || v.verb;
      panel.set(r, `kubectl ${label} ${v.name || v.type}${v.namespace ? ` (${v.namespace})` : ''}`.replace(/\s+/g, ' ').trim());
    } catch (e) {
      panel.set({ command: '', errors: [`Could not build: ${e.message}`], warnings: [] });
    }
  }
  f.verb.addEventListener('change', () => {
    setOpt(T, 'kverb', f.verb.value);
    const want = K_DEFAULT_TYPE[f.verb.value];
    if (want && !['deployments', 'statefulsets', 'daemonsets', 'replicasets'].includes(f.type.value)) f.type.value = want;
  });
  f.output.addEventListener('change', () => setOpt(T, 'koutput', f.output.value));
  const live = debounce(update, 150);
  for (const el of Object.values(f)) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', el.tagName === 'SELECT' ? update : live);
  update();

  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'dt-docker-grid' }, Object.values(wraps)),
      h('div', { class: 'row dt-docker-flags' }, Object.values(boxes)),
      panel.el),
    clear() {
      for (const [k, x] of Object.entries(f)) if (x.tagName !== 'SELECT') x.value = ''; else if (k === 'type') x.value = K_DEFAULT_TYPE[f.verb.value] || 'pods';
      setBox(boxes.allNs, false); setBox(boxes.follow, true); setBox(boxes.previous, false); setBox(boxes.watch, false); setBox(boxes.dryRun, false);
      panel.reset(); update();
    },
    focus() { f.verb.focus(); },
  };
}

/* ------------------------------------------------------------------ shell */
export default function build() {
  loadCss('/static/css/devtools-web.css');
  const parts = { run: runBuilder(), snippets: snippetBuilder(), kubectl: kubectlBuilder() };
  let mode = opt(T, 'mode', 'run');
  if (!parts[mode]) mode = 'run';
  const body = h('div', {});
  const render = () => clear(body, parts[mode].el);
  const seg = segmented([{ value: 'run', label: '🐳 docker run' }, { value: 'snippets', label: '📋 docker snippets' }, { value: 'kubectl', label: '☸ kubectl' }], mode,
    (v) => { mode = v; setOpt(T, 'mode', v); render(); });
  seg.setAttribute('aria-label', 'Builder');
  render();
  return {
    el: h('div', { class: 'stack dt-tool dt-docker' }, seg,
      h('p', { class: 'muted small' }, 'Builds commands only — nothing is run. Values are quoted for bash/zsh.'), body),
    clear() { Object.values(parts).forEach((p) => p.clear()); },
    focus() { parts[mode].focus(); },
  };
}
