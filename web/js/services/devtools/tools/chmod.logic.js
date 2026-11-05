// chmod calculator logic (no DOM). A mode is an integer 0..0o7777: special bits (setuid 4, setgid 2, sticky 1)
// followed by owner / group / other rwx triplets.

export const WHO = [
  { key: 'u', label: 'Owner', shift: 6, special: 0o4000, specialName: 'setuid' },
  { key: 'g', label: 'Group', shift: 3, special: 0o2000, specialName: 'setgid' },
  { key: 'o', label: 'Other', shift: 0, special: 0o1000, specialName: 'sticky' },
];
export const PERMS = [{ key: 'r', label: 'Read', bit: 4 }, { key: 'w', label: 'Write', bit: 2 }, { key: 'x', label: 'Execute', bit: 1 }];
export const SPECIAL = [
  { key: 'setuid', bit: 0o4000, help: 'Executables run as the file’s owner.' },
  { key: 'setgid', bit: 0o2000, help: 'Executables run as the file’s group; new files in a directory inherit its group.' },
  { key: 'sticky', bit: 0o1000, help: 'In a directory, only a file’s owner can delete or rename it (like /tmp).' },
];

export const has = (mode, who, perm) => Boolean(mode & (perm << who.shift));

/** "755", "0755", "4755", "0o755" → integer. Throws on anything else. */
export function parseOctal(str) {
  const s = String(str ?? '').trim().replace(/^0o/i, '');
  if (!/^[0-7]{1,4}$/.test(s)) throw new Error('Octal modes have 3 or 4 digits from 0 to 7, e.g. 755 or 2775.');
  return parseInt(s, 8);
}

/** 4 digits when a special bit is set (or forced), else 3. */
export const toOctal = (mode, digits) => mode.toString(8).padStart(digits || (mode > 0o777 ? 4 : 3), '0');

/** "rwxr-sr-t": s/t when the special bit and x are set, S/T when the special bit is set without x. */
export function toSymbolic(mode) {
  return WHO.map((w) => {
    const r = has(mode, w, 4) ? 'r' : '-';
    const wr = has(mode, w, 2) ? 'w' : '-';
    const x = has(mode, w, 1);
    const sp = mode & w.special;
    const mark = w.key === 'o' ? 't' : 's';
    return r + wr + (sp ? (x ? mark : mark.toUpperCase()) : (x ? 'x' : '-'));
  }).join('');
}

const FILE_TYPES = { '-': 'regular file', d: 'directory', l: 'symbolic link', c: 'character device', b: 'block device', p: 'named pipe', s: 'socket' };

/**
 * Parses "rwxr-xr-x" or an `ls -l` string ("drwxrwsr-t", "-rw-r--r--.", "-rw-r--r--@ 1 me staff …").
 * Returns { mode, type } where type is the file type letter or ''.
 */
export function parseSymbolic(str) {
  let s = String(str ?? '').trim().split(/\s+/)[0] || '';
  let type = '';
  if (s.length >= 10 && FILE_TYPES[s[0]] !== undefined) { type = s[0]; s = s.slice(1); }
  s = s.replace(/[.+@]$/, '');  // SELinux context, ACL, extended attributes markers
  if (!/^([r-][w-][xsS-])([r-][w-][xsS-])([r-][w-][xtT-])$/.test(s)) {
    throw new Error('Symbolic modes look like rwxr-x--- (9 characters), optionally with a type letter: drwxr-xr-x.');
  }
  let mode = 0;
  WHO.forEach((w, i) => {
    const [r, wr, x] = s.slice(i * 3, i * 3 + 3);
    if (r === 'r') mode |= 4 << w.shift;
    if (wr === 'w') mode |= 2 << w.shift;
    if ('xst'.includes(x)) mode |= 1 << w.shift;
    if ('sStT'.includes(x)) mode |= w.special;
  });
  return { mode, type, typeName: FILE_TYPES[type] || '' };
}

/** chmod clause form: "u=rwx,g=rx,o=" (+ s on u/g, t on o for special bits). */
export function toChmodSymbolic(mode) {
  return WHO.map((w) => {
    let p = PERMS.filter((p) => has(mode, w, p.bit)).map((p) => p.key).join('');
    if (mode & w.special) p += w.key === 'o' ? 't' : 's';
    return `${w.key}=${p}`;
  }).join(',');
}

/**
 * Applies a symbolic chmod expression ("u+x,go-w", "a=r", "+x", "u=rwx,g=rx,o=") to `base`.
 * Supports who [ugoa], ops [+-=], perms [rwxXst] and copying from u/g/o (g=u). An empty "who" means a
 * (the real chmod would also respect the umask there). `isDir` decides X.
 */
export function applySymbolic(base, expr, { isDir = false } = {}) {
  let mode = base;
  const clauses = String(expr ?? '').trim().split(',');
  for (const clause of clauses) {
    const m = clause.trim().match(/^([ugoa]*)(([+=-][rwxXst]*|[+=-][ugo])+)$/);
    if (!m) throw new Error(`Cannot read “${clause.trim() || expr}” — use clauses like u+x, go-w or u=rwx,g=rx,o=.`);
    const whoKeys = !m[1] || m[1].includes('a') ? ['u', 'g', 'o'] : [...new Set(m[1])];
    const who = WHO.filter((w) => whoKeys.includes(w.key));
    for (const [, op, perms] of m[2].matchAll(/([+=-])([rwxXstugo]*)/g)) {
      for (const w of who) {
        let bits = 0, special = 0;
        if (/^[ugo]$/.test(perms)) {
          const src = WHO.find((x) => x.key === perms);
          bits = (mode >> src.shift) & 7;
        } else {
          for (const p of perms) {
            if (p === 'r') bits |= 4;
            else if (p === 'w') bits |= 2;
            else if (p === 'x') bits |= 1;
            else if (p === 'X') { if (isDir || (mode & 0o111)) bits |= 1; }
            else if (p === 's' && w.key !== 'o') special |= w.special;
            else if (p === 't' && w.key === 'o') special |= w.special;
          }
        }
        const mask = 7 << w.shift;
        if (op === '=') mode = (mode & ~mask & ~w.special) | (bits << w.shift) | special;  // = also resets this who's s/t bit
        if (op === '+') mode |= (bits << w.shift) | special;
        if (op === '-') mode &= ~((bits << w.shift) | special);
      }
    }
  }
  return mode & 0o7777;
}

/**
 * Parses a whole chmod command or argument: "chmod 755 file", "chmod -R u=rwx,g=rx,o= dir", "644", "g+w".
 * Symbolic relative clauses are applied to `base`. Returns the new mode.
 */
export function parseChmodCommand(str, base = 0, opts) {
  const parts = String(str ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts[0] === 'sudo') parts.shift();
  if (parts[0] === 'chmod') parts.shift();
  while (parts[0] && /^-[a-zA-Z]+$/.test(parts[0]) && !/^-[rwxXst]+$/.test(parts[0])) parts.shift();  // -R, -v, -c
  while (parts[0]?.startsWith('--')) parts.shift();
  const arg = parts[0];
  if (!arg) throw new Error('Type a mode, e.g. chmod 755 file or chmod u=rwx,g=rx,o= file.');
  if (/^[0-7]{1,4}$/.test(arg)) return parseOctal(arg);
  return applySymbolic(base, arg, opts);
}

export const chmodNumeric = (mode, target = 'file') => `chmod ${toOctal(mode)} ${target}`;
export const chmodSymbolic = (mode, target = 'file') => `chmod ${toChmodSymbolic(mode)} ${target}`;

/** umask → default modes for new files (from 666) and directories (from 777). */
export function umask(str) {
  const mask = parseOctal(str) & 0o777;
  return { mask, file: 0o666 & ~mask, dir: 0o777 & ~mask };
}

/** Plain-English description of a mode. */
export function describe(mode) {
  const lines = WHO.map((w) => {
    const can = PERMS.filter((p) => has(mode, w, p.bit)).map((p) => p.label.toLowerCase());
    const who = { u: 'The owner', g: 'The group', o: 'Everyone else' }[w.key];
    return `${who} can ${can.length ? can.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'do nothing'}.`;
  });
  for (const s of SPECIAL) if (mode & s.bit) lines.push(`${s.key}: ${s.help}`);
  if ((mode & 0o4000) && !(mode & 0o100)) lines.push('Note: setuid without owner execute (S) has no effect.');
  if ((mode & 0o2000) && !(mode & 0o010)) lines.push('Note: setgid without group execute (S) on a file means mandatory locking on some systems.');
  if (mode & 0o002) lines.push('Warning: anyone can modify this — world-writable.');
  return lines;
}

export const PRESETS = [
  { mode: 0o644, title: 'Regular file', help: 'Owner reads and writes; everyone else can read. The usual default for files.' },
  { mode: 0o600, title: 'Private file', help: 'Only the owner can read and write — SSH keys, .env files, credentials.' },
  { mode: 0o755, title: 'Program / directory', help: 'Owner has full access; others can read and execute (or enter the directory).' },
  { mode: 0o700, title: 'Private directory / script', help: 'Only the owner can read, write and execute — ~/.ssh, private scripts.' },
  { mode: 0o640, title: 'Group-readable file', help: 'Owner reads and writes, the group can read, others get nothing — log or config files.' },
  { mode: 0o2775, title: 'Shared team directory', help: 'setgid: new files inherit the directory’s group; owner and group can write.' },
  { mode: 0o1777, title: 'Shared temp directory', help: 'Everyone can create files, but the sticky bit stops people deleting others’ files (/tmp).' },
];
