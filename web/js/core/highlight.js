// Small offline syntax highlighter (SQL, Mongo/JS, shell, Python, JSON, YAML) + {{placeholder}} marking.
// Returns a DocumentFragment of text nodes and <span class="tk-*"> — no innerHTML, so content is never executed.

const KEYWORDS = {
  sql: 'select from where and or not in is null as on join left right inner outer full cross group by order having limit offset insert into values update set delete create table alter drop truncate index view distinct case when then else end union all exists between like ilike returning with asc desc coalesce count sum avg min max cast true false begin commit rollback grant',
  mongo: 'db find findOne aggregate insertOne insertMany updateOne updateMany deleteOne deleteMany replaceOne countDocuments distinct sort limit skip project match group lookup unwind const let var function return true false null new ObjectId ISODate',
  shell: 'cd source export echo if then else fi for do done while in case esac function return exit sudo cat grep sed awk ls cp mv rm mkdir python python3 pip git docker kubectl psql mongosh curl ssh scp',
  python: 'def class return if elif else for while in not and or import from as with try except finally raise None True False lambda yield pass break continue print',
  json: 'true false null',
  yaml: 'true false null yes no',
};
const COMMENT = {
  sql: /^(--[^\n]*|\/\*[\s\S]*?\*\/)/,
  mongo: /^(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/,
  shell: /^#[^\n]*/,
  python: /^#[^\n]*/,
  yaml: /^#[^\n]*/,
};
// SQL keywords match in any case; the others are case-sensitive as written
const sets = Object.fromEntries(Object.entries(KEYWORDS).map(([k, v]) => [k, new Set(v.split(' ').map((w) => (k === 'sql' ? w.toLowerCase() : w)))]));

export function highlight(text, type) {
  const frag = document.createDocumentFragment();
  const kw = sets[type];
  const comment = COMMENT[type];
  const caseInsensitive = type === 'sql';
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { frag.append(plain); plain = ''; } };
  const span = (cls, t) => { flush(); const s = document.createElement('span'); s.className = `tk-${cls}`; s.textContent = t; frag.append(s); };

  while (i < text.length) {
    const rest = text.slice(i, i + 4000);
    let m;
    if ((m = rest.match(/^\{\{\s*[A-Za-z_]\w*\s*(?::[^}]*)?\}\}/))) span('var', m[0]);
    else if (comment && (m = rest.match(comment)) && !(type === 'shell' && i > 0 && /\S/.test(text[i - 1]))) span('comment', m[0]);
    else if (type !== 'note' && type !== 'link' && (m = rest.match(/^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/))) span('string', m[0]);
    else if (type === 'shell' && (m = rest.match(/^\$\{?[A-Za-z_]\w*\}?/))) span('var', m[0]);
    else if ((m = rest.match(/^\b\d+(?:\.\d+)?\b/)) && type !== 'note') span('number', m[0]);
    else if ((m = rest.match(/^[A-Za-z_$][\w$]*/))) {
      const w = m[0];
      if (kw && kw.has(caseInsensitive ? w.toLowerCase() : w)) span('keyword', w);
      else if (type === 'mongo' && w.startsWith('$')) span('keyword', w);
      else plain += w;
    } else { plain += text[i]; i += 1; continue; }
    i += m[0].length;
  }
  flush();
  return frag;
}

/** Placeholder names in order of first appearance, with defaults: [{name, default}] (builtins excluded). */
export function placeholders(text) {
  const seen = new Map();
  for (const m of text.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*(?::([^}]*))?\}\}/g)) {
    if (['today', 'now'].includes(m[1]) || seen.has(m[1])) continue;
    seen.set(m[1], m[2] ?? null);
  }
  return [...seen].map(([name, def]) => ({ name, default: def }));
}

export function fillTemplate(text, values) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const builtins = { today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, now: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
  return text.replace(/\{\{\s*([A-Za-z_]\w*)\s*(?::([^}]*))?\}\}/g, (all, name, def) => {
    if (values[name] !== undefined && values[name] !== '') return values[name];
    if (name in builtins) return builtins[name];
    return def ?? all;
  });
}
