// Command builders for docker run / compose YAML, common docker snippets and kubectl. Pure — no DOM.

/** POSIX shell quoting: bare when safe, else single quotes ('\'' for embedded quotes). */
export function shq(s) {
  s = String(s);
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Split a command line the user typed ("npm run dev -- --port 3000", quotes allowed) into words. */
export function splitWords(text) {
  const out = [];
  let cur = '', inTok = false, q = null;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === '\\' && '"\\$`'.includes(s[i + 1])) { cur += s[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; inTok = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inTok = true; continue; }
    if (/\s/.test(c)) { if (inTok) out.push(cur); cur = ''; inTok = false; continue; }
    cur += c; inTok = true;
  }
  if (q) throw new Error(`Unterminated ${q} quote in "${s.trim()}".`);
  if (inTok) out.push(cur);
  return out;
}

const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/**
 * Join argument groups (arrays of words, e.g. [['docker','run'], ['-p','80:80'], …]) into a shell command:
 * one line when short, else one group per line joined with " \\". A flat argv is accepted too.
 */
export function joinCmd(groups, { wrap = 90 } = {}) {
  const gs = groups.map((g) => (Array.isArray(g) ? g : [g])).filter((g) => g.length).map((g) => g.map(shq).join(' '));
  const one = gs.join(' ');
  return one.length <= wrap ? one : gs.join(' \\\n  ');
}

/* ------------------------------------------------------------------ docker run */
const PORT_RE = /^(?:(\[[0-9a-fA-F:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):)?(?:(\d{1,5}(?:-\d{1,5})?):)?(\d{1,5}(?:-\d{1,5})?)(?:\/(tcp|udp|sctp))?$/;

export function parsePort(line) {
  const m = line.replace(/\s+/g, '').match(PORT_RE);
  if (!m) return null;
  const nums = [m[2], m[3]].filter(Boolean).flatMap((x) => x.split('-')).map(Number);
  if (nums.some((n) => n < 1 || n > 65535)) return null;
  return { ip: m[1] || '', host: m[2] || '', container: m[3], proto: m[4] || '' };
}

const fmtPort = (p) => [p.ip, p.host, p.container].filter(Boolean).join(':') + (p.proto ? `/${p.proto}` : '');

export function parseVolume(line) {
  // host:container[:opts] — Windows drive letters (C:\x) kept together
  const m = line.match(/^([A-Za-z]:[\\/][^:]*|[^:]+):([^:]+)(?::([a-z,]+))?$/);
  if (!m) return null;
  const opts = m[3] ? m[3].split(',') : [];
  const bad = opts.filter((o) => !['ro', 'rw', 'z', 'Z', 'cached', 'delegated', 'consistent', 'nocopy', 'shared', 'slave', 'private', 'rshared', 'rslave', 'rprivate'].includes(o));
  if (bad.length) return null;
  const named = !/[\\/~.]/.test(m[1][0]) && !/^[A-Za-z]:/.test(m[1]) && !m[1].includes('/');
  return { source: m[1], target: m[2], opts, named, readOnly: opts.includes('ro') };
}

export function parseEnv(line) {
  const i = line.indexOf('=');
  const key = (i < 0 ? line : line.slice(0, i)).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return null;
  return { key, value: i < 0 ? null : line.slice(i + 1), passthrough: i < 0 };
}

export const RESTART = ['', 'no', 'always', 'unless-stopped', 'on-failure'];

/**
 * opts: {image, name, detach, rm, it, ports, volumes, env, envFile, network, restart, retries, user, workdir, entrypoint,
 *        command, labels, gpus}
 * → {argv, command, display (env values masked), errors[], warnings[], parsed}
 */
export function buildDockerRun(o) {
  const errors = [], warnings = [];
  const argv = [['docker', 'run']];
  const masked = [['docker', 'run']];
  const both = (...a) => { if (a.length) { argv.push(a); masked.push(a); } };
  if (o.detach) both('-d');
  if (o.it) both('-it');
  if (o.rm) both('--rm');
  if (o.name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(o.name)) errors.push(`Container name "${o.name}" may only use letters, digits, _ . - (not starting with _ . -).`);
    both('--name', o.name);
  }
  const ports = [];
  for (const l of lines(o.ports)) {
    const p = parsePort(l);
    if (!p) { errors.push(`Port "${l}" — use host:container[/tcp|udp], e.g. 8080:80 or 127.0.0.1:5432:5432.`); continue; }
    if (!p.host) warnings.push(`Port "${l}" has no host port — Docker picks a random one.`);
    if (p.host && !p.ip) warnings.push(`Port ${fmtPort(p)} listens on all interfaces; use 127.0.0.1:${fmtPort(p)} to keep it local.`);
    ports.push(p); both('-p', fmtPort(p));
  }
  const volumes = [];
  for (const l of lines(o.volumes)) {
    const v = parseVolume(l);
    if (!v) { errors.push(`Volume "${l}" — use host-path-or-name:/container/path[:ro].`); continue; }
    if (!v.target.startsWith('/') && !/^[A-Za-z]:/.test(v.target)) errors.push(`Volume "${l}": the container path must be absolute.`);
    if (/^\.\.?\//.test(v.source)) warnings.push(`Volume "${l}": relative host paths need docker 23+; use "$PWD/…" for older versions.`);
    volumes.push(v); both('-v', l);
  }
  const env = [];
  for (const l of lines(o.env)) {
    const e = parseEnv(l);
    if (!e) { errors.push(`Env "${l.slice(0, 40)}" — use KEY=value (or KEY to pass it through from your shell).`); continue; }
    env.push(e);
    argv.push(['-e', e.passthrough ? e.key : `${e.key}=${e.value}`]);
    masked.push(['-e', e.passthrough ? e.key : `${e.key}=${e.value === '' ? '' : '****'}`]);
  }
  if (o.envFile) both('--env-file', o.envFile);
  if (o.network) both('--network', o.network);
  if (o.restart) {
    const pol = o.restart === 'on-failure' && Number(o.retries) > 0 ? `on-failure:${Number(o.retries)}` : o.restart;
    both('--restart', pol);
    if (o.rm && o.restart !== 'no') errors.push('--rm cannot be combined with a restart policy (docker refuses "Conflicting options").');
  }
  if (o.user) both('-u', o.user);
  if (o.workdir) {
    if (!o.workdir.startsWith('/')) warnings.push('The working directory should be an absolute path.');
    both('-w', o.workdir);
  }
  const labels = [];
  for (const l of lines(o.labels)) {
    const i = l.indexOf('=');
    if (i <= 0) { errors.push(`Label "${l}" — use key=value.`); continue; }
    labels.push([l.slice(0, i), l.slice(i + 1)]); both('-l', l);
  }
  if (o.gpus) both('--gpus', 'all');
  let entry = [];
  if (o.entrypoint) {
    try { entry = splitWords(o.entrypoint); } catch (e) { errors.push(e.message); }
    if (entry.length) both('--entrypoint', entry[0]);
  }
  if (!o.image) errors.push('Image is required.');
  else {
    if (!/^[a-z0-9]+(?:[._\-/:@][a-zA-Z0-9_.\-]+)*$/.test(o.image) || /\s/.test(o.image)) errors.push(`Image "${o.image}" does not look like a valid reference (lowercase name[:tag] or name@sha256:…).`);
  }
  let cmd = [];
  try { cmd = splitWords(o.command); } catch (e) { errors.push(e.message); }
  const tail = [...entry.slice(1), ...cmd];  // extra entrypoint words become the first command args
  if (o.image) both(o.image, ...tail);
  if (o.it && o.detach) warnings.push('-d with -it: runs in the background with a TTY; attach with "docker attach".');
  if (env.some((e) => /pass|secret|token|key/i.test(e.key) && !e.passthrough)) warnings.push('Secrets passed with -e end up in your shell history and in "docker inspect" — prefer --env-file.');
  return {
    argv: argv.flat(), command: joinCmd(argv), display: joinCmd(masked), errors, warnings,
    parsed: { ports, volumes, env, labels, entry, cmd },
  };
}

/* ------------------------------------------------------------------ compose */
const y = (s) => JSON.stringify(String(s));  // double-quoted YAML scalars are JSON strings

/** Same options → docker-compose service YAML. mask hides env values. */
export function composeYaml(o, { mask = false } = {}) {
  const r = buildDockerRun(o);
  const { ports, volumes, env, labels, entry, cmd } = r.parsed;
  const svc = (o.name || (o.image || 'app').split('/').pop().split(/[:@]/)[0] || 'app').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const out = ['services:', `  ${svc}:`];
  const add = (s) => out.push(`    ${s}`);
  add(`image: ${y(o.image || '')}`);
  if (o.name) add(`container_name: ${y(o.name)}`);
  if (o.restart) add(`restart: ${y(o.restart === 'on-failure' && Number(o.retries) > 0 ? `on-failure:${Number(o.retries)}` : o.restart)}`);
  if (o.it) { add('stdin_open: true'); add('tty: true'); }
  if (o.user) add(`user: ${y(o.user)}`);
  if (o.workdir) add(`working_dir: ${y(o.workdir)}`);
  if (entry.length) add(`entrypoint: [${[entry[0]].map(y).join(', ')}]`);
  const command = [...entry.slice(1), ...cmd];
  if (command.length) add(`command: [${command.map(y).join(', ')}]`);
  if (ports.length) { add('ports:'); for (const p of ports) add(`  - ${y(fmtPort(p))}`); }
  if (volumes.length) { add('volumes:'); for (const v of volumes) add(`  - ${y([v.source, v.target, ...(v.opts.length ? [v.opts.join(',')] : [])].join(':'))}`); }
  if (o.envFile) { add('env_file:'); add(`  - ${y(o.envFile)}`); }
  if (env.length) {
    add('environment:');
    for (const e of env) add(`  ${e.key}:${e.passthrough ? '' : ` ${y(mask && e.value !== '' ? '****' : e.value)}`}`);
  }
  if (labels.length) { add('labels:'); for (const [k, v] of labels) add(`  ${y(k)}: ${y(v)}`); }
  if (['host', 'none', 'bridge'].includes(o.network)) add(`network_mode: ${y(o.network)}`);
  else if (o.network) add(`networks: [${y(o.network)}]`);
  if (o.gpus) {
    add('deploy:'); add('  resources:'); add('    reservations:'); add('      devices:');
    add('        - driver: nvidia'); add('          count: all'); add('          capabilities: [gpu]');
  }
  const named = volumes.filter((v) => v.named);
  if (named.length) { out.push('volumes:'); for (const v of named) out.push(`  ${v.source}: {}`); }
  if (o.network && !['host', 'none', 'bridge'].includes(o.network)) { out.push('networks:'); out.push(`  ${o.network}:`); out.push('    external: true'); }
  const notes = [];
  if (o.rm) notes.push('# --rm has no compose equivalent (use "docker compose run --rm").');
  if (o.detach) notes.push('# -d: run with "docker compose up -d".');
  return `${notes.length ? `${notes.join('\n')}\n` : ''}${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ docker snippets */
// fields: container, image, tail, shell, src, dest, service, volumes(bool)
export const SNIPPETS = [
  { key: 'logs', label: 'Logs (follow)', fields: ['container', 'tail'], build: (p) => ['docker', 'logs', '-f', '--tail', p.tail || '100', p.container] },
  { key: 'exec', label: 'Shell into container', fields: ['container', 'shell'], build: (p) => ['docker', 'exec', '-it', p.container, p.shell || 'sh'] },
  { key: 'cp-out', label: 'Copy file out', fields: ['container', 'src', 'dest'], build: (p) => ['docker', 'cp', `${p.container}:${p.src}`, p.dest || '.'] },
  { key: 'cp-in', label: 'Copy file in', fields: ['container', 'src', 'dest'], build: (p) => ['docker', 'cp', p.src, `${p.container}:${p.dest || '/tmp/'}`] },
  { key: 'ps', label: 'List containers', fields: [], build: () => ['docker', 'ps', '-a', '--format', 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'] },
  { key: 'stats', label: 'Live resource usage', fields: [], build: () => ['docker', 'stats', '--no-stream'] },
  { key: 'inspect', label: 'Inspect (IP / mounts)', fields: ['container'], build: (p) => ['docker', 'inspect', p.container] },
  { key: 'restart', label: 'Restart container', fields: ['container'], build: (p) => ['docker', 'restart', p.container] },
  { key: 'rm', label: 'Remove container', fields: ['container'], danger: 'Force-removes the container (stopping it first). Its writable layer is lost.', build: (p) => ['docker', 'rm', '-f', p.container] },
  { key: 'image-ls', label: 'List images', fields: [], build: () => ['docker', 'image', 'ls'] },
  { key: 'image-rm', label: 'Remove image', fields: ['image'], danger: 'Deletes the local image.', build: (p) => ['docker', 'image', 'rm', p.image] },
  { key: 'prune', label: 'System prune', fields: ['volumes'], danger: 'Deletes ALL stopped containers, unused networks, all unused images and build cache', build: (p) => ['docker', 'system', 'prune', '-af', ...(p.volumes ? ['--volumes'] : [])] },
  { key: 'df', label: 'Disk usage', fields: [], build: () => ['docker', 'system', 'df'] },
  { key: 'compose-up', label: 'compose up', fields: ['service'], build: (p) => ['docker', 'compose', 'up', '-d', '--build', ...(p.service ? [p.service] : [])] },
  { key: 'compose-down', label: 'compose down', fields: ['volumes'], danger: (p) => (p.volumes ? 'Stops the stack and DELETES its named volumes (data).' : null), build: (p) => ['docker', 'compose', 'down', ...(p.volumes ? ['-v'] : [])] },
  { key: 'compose-logs', label: 'compose logs', fields: ['service', 'tail'], build: (p) => ['docker', 'compose', 'logs', '-f', '--tail', p.tail || '100', ...(p.service ? [p.service] : [])] },
  { key: 'compose-ps', label: 'compose ps', fields: [], build: () => ['docker', 'compose', 'ps'] },
];

export function buildSnippet(key, params = {}) {
  const s = SNIPPETS.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown snippet ${key}`);
  const errors = [];
  for (const f of s.fields) {
    if (['container', 'image', 'src'].includes(f) && !String(params[f] || '').trim()) errors.push(`${f[0].toUpperCase()}${f.slice(1)} is required.`);
  }
  if (params.tail && !/^\d+$|^all$/.test(String(params.tail))) errors.push('Tail must be a number or "all".');
  const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const argv = s.build({ ...p, container: p.container || '<container>', image: p.image || '<image>', src: p.src || '<path>' });
  let danger = typeof s.danger === 'function' ? s.danger(p) : s.danger || null;
  if (key === 'prune' && danger) danger += p.volumes ? ', AND all unused volumes (data!).' : '.';
  return { argv, command: joinCmd([argv]), danger, errors };
}

/* ------------------------------------------------------------------ kubectl */
export const K_VERBS = [
  ['get', 'get'], ['describe', 'describe'], ['logs', 'logs'], ['exec', 'exec -it'], ['port-forward', 'port-forward'],
  ['rollout-status', 'rollout status'], ['rollout-restart', 'rollout restart'], ['rollout-undo', 'rollout undo'], ['rollout-history', 'rollout history'],
  ['scale', 'scale'], ['apply', 'apply -f'], ['delete', 'delete'], ['top', 'top'],
];
export const K_TYPES = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'services', 'ingresses', 'configmaps', 'secrets', 'jobs', 'cronjobs',
  'nodes', 'namespaces', 'persistentvolumeclaims', 'events', 'replicasets', 'horizontalpodautoscalers', 'all'];
const SHORT_TYPE = { pods: 'pod', deployments: 'deployment', statefulsets: 'statefulset', daemonsets: 'daemonset', services: 'service',
  ingresses: 'ingress', configmaps: 'configmap', secrets: 'secret', jobs: 'job', cronjobs: 'cronjob', nodes: 'node', namespaces: 'namespace',
  persistentvolumeclaims: 'pvc', events: 'event', replicasets: 'replicaset', horizontalpodautoscalers: 'hpa' };
const CLUSTER_SCOPED = new Set(['nodes', 'namespaces']);
const ROLLOUT_TYPES = new Set(['deployments', 'statefulsets', 'daemonsets']);
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * o: {context, namespace, allNamespaces, verb, type, name, selector, output, jsonpath, follow, tail, container, previous,
 *     since, cmd, ports, replicas, file, revision, watch, dryRun}
 * → {argv, command, errors, warnings, danger, confirm}
 */
export function buildKubectl(o) {
  const errors = [], warnings = [];
  let danger = null, confirm = null;
  const argv = ['kubectl'];
  if (o.context) argv.push('--context', o.context);
  const type = o.type || 'pods';
  const sing = SHORT_TYPE[type] || type;
  const name = (o.name || '').trim();
  if (name && !NAME_RE.test(name)) warnings.push(`"${name}" is not a valid Kubernetes object name (lowercase letters, digits, - and .).`);
  if (o.allNamespaces && ['get', 'describe', 'delete', 'top'].includes(o.verb)) argv.push('-A');
  else if (o.namespace && !CLUSTER_SCOPED.has(type)) argv.push('-n', o.namespace);
  const sel = (o.selector || '').trim();
  const ref = () => (name ? `${sing}/${name}` : null);
  const needName = (what) => { if (!name) errors.push(`${what} needs a name.`); };
  const output = () => {
    if (!o.output) return;
    if (o.output === 'jsonpath') {
      if (!o.jsonpath) { errors.push('Enter a JSONPath expression, e.g. {.items[*].metadata.name}'); return; }
      argv.push('-o', `jsonpath=${o.jsonpath}`);
    } else argv.push('-o', o.output);
  };
  switch (o.verb) {
    case 'get':
      argv.push('get', type); if (name) argv.push(name); if (sel) argv.push('-l', sel); output();
      if (o.watch) argv.push('-w');
      if (type === 'secrets' && ['yaml', 'json'].includes(o.output)) warnings.push('Secret values in yaml/json output are only base64-encoded — treat the output as sensitive.');
      break;
    case 'describe':
      argv.push('describe', type); if (name) argv.push(name); if (sel) argv.push('-l', sel); break;
    case 'logs': {
      argv.push('logs');
      if (name) argv.push(type === 'pods' ? name : `${sing}/${name}`);
      else if (sel) argv.push('-l', sel);
      else errors.push('Logs need a pod name (or a label selector).');
      if (o.follow) argv.push('-f');
      if (o.tail) { if (!/^-?\d+$/.test(String(o.tail))) errors.push('Tail must be a number.'); else argv.push(`--tail=${o.tail}`); }
      if (o.container) argv.push('-c', o.container);
      else if (sel && !name) argv.push('--all-containers=true');
      if (o.previous) argv.push('--previous');
      if (o.since) { if (!/^\d+[smh]$/.test(o.since)) errors.push('Since must look like 10m, 2h or 30s.'); else argv.push(`--since=${o.since}`); }
      if (o.previous && o.follow) warnings.push('--previous with -f: the previous container has exited, so there is nothing to follow.');
      break;
    }
    case 'exec': {
      needName('exec');
      argv.push('exec', '-it', type === 'pods' || !name ? name || '<pod>' : `${sing}/${name}`);
      if (o.container) argv.push('-c', o.container);
      let cmd = ['sh'];
      try { const w = splitWords(o.cmd || ''); if (w.length) cmd = w; } catch (e) { errors.push(e.message); }
      argv.push('--', ...cmd);
      break;
    }
    case 'port-forward': {
      needName('port-forward');
      argv.push('port-forward', type === 'pods' ? name || '<pod>' : `${sing}/${name || '<name>'}`);
      const ps = String(o.ports || '').split(/[\s,]+/).filter(Boolean);
      if (!ps.length) errors.push('Enter ports as local:remote, e.g. 8080:80.');
      for (const p of ps) {
        if (!/^(\d{1,5})?:?\d{1,5}$/.test(p)) errors.push(`Port "${p}" — use local:remote, e.g. 8080:80.`);
        argv.push(p);
      }
      if (o.address) argv.push('--address', o.address);
      break;
    }
    case 'rollout-status': case 'rollout-restart': case 'rollout-undo': case 'rollout-history': {
      if (!ROLLOUT_TYPES.has(type)) errors.push('Rollouts work on deployments, statefulsets or daemonsets.');
      needName('rollout');
      argv.push('rollout', o.verb.slice(8), ref() || `${sing}/<name>`);
      if (o.verb === 'rollout-undo') {
        if (o.revision) { if (!/^\d+$/.test(String(o.revision))) errors.push('Revision must be a number.'); else argv.push(`--to-revision=${o.revision}`); }
        danger = `Rolls ${sing}/${name || '<name>'} back to ${o.revision ? `revision ${o.revision}` : 'the previous revision'}.`;
      }
      if (o.verb === 'rollout-restart') warnings.push('Restarts every pod of the workload (rolling).');
      break;
    }
    case 'scale': {
      if (!['deployments', 'statefulsets', 'replicasets'].includes(type)) errors.push('Scale works on deployments, statefulsets or replicasets.');
      needName('scale');
      const n = String(o.replicas ?? '').trim();
      if (!/^\d+$/.test(n)) errors.push('Replicas must be a whole number.');
      argv.push('scale', ref() || `${sing}/<name>`, `--replicas=${n || '<n>'}`);
      if (n === '0') danger = `Scales ${sing}/${name || '<name>'} to zero — the workload stops serving.`;
      break;
    }
    case 'apply':
      if (!o.file) errors.push('apply needs a file, folder or URL (-f).');
      argv.push('apply', '-f', o.file || '<file.yaml>');
      if (o.dryRun) argv.push('--dry-run=server'); else warnings.push('Tip: run with "Dry run" first, or "kubectl diff -f" to preview.');
      break;
    case 'delete': {
      argv.push('delete');
      if (o.file) argv.push('-f', o.file);
      else {
        argv.push(type);
        if (name) argv.push(name);
        else if (sel) argv.push('-l', sel);
        else errors.push('delete needs a name, a label selector or a file — refusing to build a delete of everything.');
      }
      if (o.dryRun) argv.push('--dry-run=server');
      const what = o.file ? `everything defined in ${o.file}` : name ? `${sing} "${name}"` : sel ? `every ${sing} matching ${sel}` : `${type}`;
      const where = o.allNamespaces ? 'in ALL namespaces' : CLUSTER_SCOPED.has(type) ? 'cluster-wide' : `in namespace ${o.namespace ? `"${o.namespace}"` : '(current default)'}`;
      danger = `Permanently deletes ${what} ${where}${o.context ? ` on context "${o.context}"` : ' on the current context'}.${type === 'namespaces' ? ' Deleting a namespace deletes everything inside it.' : ''}${type === 'persistentvolumeclaims' ? ' The volume data may be deleted too (reclaim policy).' : ''}`;
      confirm = o.dryRun ? null : `Double-check the context and namespace: ${danger}`;
      if (o.dryRun) danger = null;
      break;
    }
    case 'top':
      if (!['pods', 'nodes'].includes(type)) errors.push('top works on pods or nodes.');
      argv.push('top', type === 'nodes' ? 'nodes' : 'pods'); if (name) argv.push(name); if (sel) argv.push('-l', sel);
      break;
    default:
      errors.push(`Unknown action ${o.verb}`);
  }
  if (!o.context) warnings.push('No --context: the command runs against whatever context is current.');
  return { argv, command: joinCmd([argv]), errors, warnings, danger, confirm };
}
