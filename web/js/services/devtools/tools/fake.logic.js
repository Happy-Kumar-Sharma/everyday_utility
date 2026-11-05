// Fake data generator: seeded PRNG, column types, and output formatters. No DOM, so node can test it.
//
// const g = createGenerator(columns, seed); g.next(20) -> rows (arrays of JS values, null for NULL)
// formatRows(format, columns, rows, {table, first, last}) -> string piece (concatenate the pieces of a chunked run)

/* ------------------------------------------------------------------ seeded PRNG */
/** 32-bit seed from any string (cyrb53-style mix, truncated). Numeric strings hash too, so "42" ≠ 42 is not an issue. */
export function hashSeed(seed) {
  const s = String(seed ?? '');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

/** mulberry32: small, fast, good enough for test data. Returns () => float in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ word lists */
export const FIRST_NAMES = ['Aarav', 'Aditi', 'Ananya', 'Arjun', 'Diya', 'Ishaan', 'Kavya', 'Meera', 'Neha', 'Priya', 'Rahul', 'Rohan',
  'Saanvi', 'Vikram', 'Zara', 'Alice', 'Ben', 'Carla', 'Daniel', 'Elena', 'Felix', 'Grace', 'Hugo', 'Isla', 'James', 'Kenji', 'Laura',
  'Mateo', 'Nina', 'Oliver', 'Paula', 'Quinn', 'Ravi', 'Sofia', 'Tom', 'Uma', 'Victor', 'Wen', 'Xavier', 'Yara', 'Zoe', 'Amir',
  'Chloe', 'Diego', 'Emma', 'Farah', 'Hana', 'Ivan', 'Leo', 'Maya', 'Noah', 'Omar', 'Lena', 'Sam', 'Tara', 'Yusuf'];
export const LAST_NAMES = ['Sharma', 'Patel', 'Iyer', 'Reddy', 'Gupta', 'Nair', 'Singh', 'Kapoor', 'Mehta', 'Rao', 'Das', 'Joshi',
  'Smith', 'Johnson', 'Brown', 'Garcia', 'Miller', 'Davis', 'Lopez', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Martin', 'Lee',
  'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Hill', 'Campbell',
  'Mitchell', 'Roberts', 'Carter', 'Tanaka', 'Kim', 'Chen', 'Wang', 'Novak', 'Rossi', 'Muller', 'Dubois', 'Silva', 'Costa'];
export const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Jaipur', 'Kochi', 'Ahmedabad',
  'London', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Lisbon', 'Amsterdam', 'Dublin', 'Vienna', 'Prague', 'New York', 'Chicago',
  'Austin', 'Seattle', 'Denver', 'Boston', 'Toronto', 'Vancouver', 'Mexico City', 'São Paulo', 'Buenos Aires', 'Tokyo', 'Osaka',
  'Seoul', 'Singapore', 'Sydney', 'Melbourne', 'Auckland', 'Dubai', 'Cairo', 'Nairobi', 'Cape Town', 'Istanbul', 'Stockholm'];
export const COUNTRIES = ['India', 'United States', 'United Kingdom', 'Germany', 'France', 'Spain', 'Italy', 'Portugal',
  'Netherlands', 'Ireland', 'Austria', 'Czechia', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Japan', 'South Korea', 'Singapore',
  'Australia', 'New Zealand', 'United Arab Emirates', 'Egypt', 'Kenya', 'South Africa', 'Turkey', 'Sweden', 'Norway', 'Finland',
  'Poland', 'Switzerland', 'Belgium', 'Denmark', 'Chile', 'Colombia', 'Vietnam', 'Thailand', 'Indonesia', 'Philippines', 'Nepal'];
export const COMPANIES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Labs', 'Hooli', 'Stark Analytics', 'Wayne Logistics',
  'Pied Piper', 'Vandelay Imports', 'Soylent Foods', 'Cyberdyne Systems', 'Tyrell Works', 'Wonka Industries', 'Oceanic Air',
  'Blue Sun', 'Massive Dynamic', 'Nakatomi Trading', 'Gringotts Finance', 'Monarch Paper', 'Dunder Mifflin', 'Prestige Worldwide',
  'Aperture Science', 'Black Mesa', 'Virtucon', 'Bluth Company', 'Sterling Cooper', 'Kramerica', 'Los Pollos Foods',
  'Duff Beverages', 'Krusty Brands', 'Spacely Sprockets', 'Cogswell Cogs', 'Ollivanders', 'Zorg Industries', 'Weyland Freight'];
const STREETS = ['MG Road', 'Park Street', 'Linking Road', 'Church Street', 'Brigade Road', 'Main Street', 'Oak Avenue',
  'Maple Drive', 'Cedar Lane', 'Elm Street', 'High Street', 'Station Road', 'Mill Lane', 'King Street', 'Queen Street',
  'Lake View Road', 'Hill Road', 'River Walk', 'Sunset Boulevard', 'Market Square', 'Garden Lane', 'Harbour Road'];
export const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore '
  + 'magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute '
  + 'irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt '
  + 'culpa qui officia deserunt mollit anim id est laborum').split(' ');
const URL_WORDS = ['blog', 'docs', 'shop', 'news', 'help', 'api', 'about', 'products', 'images', 'users', 'posts', 'events'];
const TAGS = ['alpha', 'beta', 'gamma', 'delta', 'red', 'green', 'blue', 'new', 'sale', 'archived', 'draft', 'featured'];

/* ------------------------------------------------------------------ column types */
// params: [{key, label, type: 'number'|'text'|'date'|'select', default, options?}]
const RANGE_DATES = [{ key: 'from', label: 'From', type: 'date', default: '2024-01-01' }, { key: 'to', label: 'To', type: 'date', default: '2025-12-31' }];
export const TYPES = [
  { value: 'first_name', label: 'First name', group: 'Person' },
  { value: 'last_name', label: 'Last name', group: 'Person' },
  { value: 'full_name', label: 'Full name', group: 'Person' },
  { value: 'email', label: 'Email', group: 'Person', params: [{ key: 'domains', label: 'Domains', type: 'text', default: 'example.com, test.local' }] },
  { value: 'username', label: 'Username', group: 'Person' },
  { value: 'phone', label: 'Phone', group: 'Person', params: [{ key: 'format', label: 'Format', type: 'select', default: 'in', options: [['in', '+91 (India)'], ['us', 'US (555)']] }] },
  { value: 'uuid', label: 'UUID v4', group: 'IDs' },
  { value: 'sequence', label: 'Sequential int (image_id)', group: 'IDs', params: [{ key: 'start', label: 'Start', type: 'number', default: 1 }] },
  { value: 's3_key', label: 'S3 key pattern', group: 'IDs', params: [{ key: 'pattern', label: 'Pattern', type: 'text', default: 'images/{uuid}.jpg' }] },
  { value: 'int', label: 'Integer range', group: 'Numbers', params: [{ key: 'min', label: 'Min', type: 'number', default: 1 }, { key: 'max', label: 'Max', type: 'number', default: 100 }] },
  { value: 'float', label: 'Float range', group: 'Numbers', params: [{ key: 'min', label: 'Min', type: 'number', default: 0 }, { key: 'max', label: 'Max', type: 'number', default: 1 }, { key: 'decimals', label: 'Decimals', type: 'number', default: 2 }] },
  { value: 'bool', label: 'Boolean', group: 'Numbers' },
  { value: 'enum', label: 'Enum (one of)', group: 'Numbers', params: [{ key: 'values', label: 'Values (comma list)', type: 'text', default: 'pending, done, failed' }] },
  { value: 'date', label: 'Date', group: 'Time', params: RANGE_DATES },
  { value: 'datetime', label: 'Datetime', group: 'Time', params: RANGE_DATES },
  { value: 'iso', label: 'ISO timestamp', group: 'Time', params: RANGE_DATES },
  { value: 'epoch', label: 'Epoch seconds', group: 'Time', params: RANGE_DATES },
  { value: 'lorem_words', label: 'Lorem words', group: 'Text', params: [{ key: 'count', label: 'Words', type: 'number', default: 3 }] },
  { value: 'lorem_sentence', label: 'Lorem sentence', group: 'Text' },
  { value: 'lorem_paragraph', label: 'Lorem paragraph', group: 'Text' },
  { value: 'city', label: 'City', group: 'Place' },
  { value: 'country', label: 'Country', group: 'Place' },
  { value: 'company', label: 'Company', group: 'Place' },
  { value: 'street', label: 'Street address', group: 'Place' },
  { value: 'ipv4', label: 'IPv4', group: 'Web' },
  { value: 'ipv6', label: 'IPv6 (2001:db8::/32)', group: 'Web' },
  { value: 'url', label: 'URL (example.com)', group: 'Web' },
  { value: 'hex_color', label: 'Hex color', group: 'Web' },
  { value: 'json', label: 'JSON object', group: 'Web' },
];
export const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.value, t]));

/** Fill in defaults so every column has all its params. */
export function normalizeColumn(c = {}) {
  const t = TYPE_MAP[c.type] ? c.type : 'first_name';
  const out = { name: String(c.name ?? ''), type: t, nullPct: clampNum(c.nullPct, 0, 100, 0) };
  for (const p of TYPE_MAP[t].params || []) out[p.key] = c[p.key] ?? p.default;
  return out;
}
function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export const EXAMPLE_SCHEMA = [
  { name: 'id', type: 'sequence', start: 1 },
  { name: 'name', type: 'full_name' },
  { name: 'email', type: 'email', domains: 'example.com, test.local' },
  { name: 'city', type: 'city' },
  { name: 'status', type: 'enum', values: 'active, invited, disabled' },
  { name: 'score', type: 'float', min: 0, max: 100, decimals: 1, nullPct: 10 },
  { name: 'created_at', type: 'datetime', from: '2024-01-01', to: '2025-12-31' },
].map(normalizeColumn);

/** Problems with a schema (empty/duplicate names, bad ranges) as strings; empty when fine. */
export function validateSchema(columns) {
  const errs = [];
  const seen = new Set();
  if (!columns.length) errs.push('Add at least one column.');
  columns.forEach((c, i) => {
    const label = c.name || `column ${i + 1}`;
    if (!c.name.trim()) errs.push(`Column ${i + 1} has no name.`);
    else if (seen.has(c.name)) errs.push(`Duplicate column name “${c.name}”.`);
    seen.add(c.name);
    if ((c.type === 'int' || c.type === 'float') && !(Number(c.min) <= Number(c.max))) errs.push(`${label}: min must be ≤ max.`);
    if (c.type === 'int' && !(Number.isFinite(Number(c.min)) && Number.isFinite(Number(c.max)))) errs.push(`${label}: min/max must be numbers.`);
    if (['date', 'datetime', 'iso', 'epoch'].includes(c.type)) {
      const a = Date.parse(`${c.from}T00:00:00Z`), b = Date.parse(`${c.to}T00:00:00Z`);
      if (Number.isNaN(a) || Number.isNaN(b)) errs.push(`${label}: dates must be YYYY-MM-DD.`);
      else if (a > b) errs.push(`${label}: “from” must be on or before “to”.`);
    }
    if (c.type === 'enum' && !splitList(c.values).length) errs.push(`${label}: give at least one enum value.`);
  });
  return errs;
}

export const splitList = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Domains that are reserved for docs/testing (RFC 2606 / 6761) — anything else may be a real mailbox. */
export const isSafeDomain = (d) => /^(example\.(com|net|org)|.+\.(test|example|invalid|localhost|local))$/i.test(d) || /^(test|example|invalid|localhost|local)$/i.test(d);

/* ------------------------------------------------------------------ generator */
const pad2 = (n) => String(n).padStart(2, '0');
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

function randTools(rnd) {
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
  return { rnd, int, pick, hex };
}

/**
 * Each column draws from its own stream (seed + column name) and names come from a shared per-row "person"
 * stream, so adding, removing or editing one column leaves the values of the other columns unchanged.
 */
export function createGenerator(columns, seed) {
  const cols = columns.map(normalizeColumn);
  const people = randTools(mulberry32(hashSeed(`${seed}\u0000person`)));
  const streams = cols.map((c, i) => randTools(mulberry32(hashSeed(`${seed}\u0000col\u0000${c.name || i}`))));
  let rowIndex = 0;

  function value(c, R, person, idx) {
    const { rnd, int, pick, hex } = R;
    const uuid = () => {
      const h = hex(32).split('');
      h[12] = '4';
      h[16] = '89ab'[Math.floor(rnd() * 4)];
      const s = h.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    };
    const words = (n) => Array.from({ length: n }, () => pick(LOREM)).join(' ');
    const sentence = () => { const w = words(int(6, 14)); return `${w[0].toUpperCase()}${w.slice(1)}.`; };
    const timeIn = (withTime) => {
      const a = Date.parse(`${c.from}T00:00:00Z`), b = Date.parse(`${c.to}T00:00:00Z`) + (withTime ? 86400000 - 1000 : 0);
      if (!withTime) return a + int(0, Math.round((b - a) / 86400000)) * 86400000;
      return a + int(0, Math.floor((b - a) / 1000)) * 1000;
    };
    switch (c.type) {
      case 'first_name': return person().first;
      case 'last_name': return person().last;
      case 'full_name': return `${person().first} ${person().last}`;
      case 'email': {
        const p = person();
        const domains = splitList(c.domains);
        const n = int(0, 3) === 0 ? '' : String(int(1, 99));
        return `${ascii(p.first)}.${ascii(p.last)}${n}@${domains.length ? pick(domains) : 'example.com'}`;
      }
      case 'username': { const p = person(); return `${ascii(p.first)}${pick(['', '_', '.'])}${ascii(p.last).slice(0, int(1, 6))}${int(1, 999)}`; }
      case 'phone': return c.format === 'us'
        ? `+1 (${int(2, 9)}${int(0, 9)}${int(0, 9)}) 555-01${pad2(int(0, 99))}`  // 555-0100..0199: reserved for fiction
        : `+91 ${int(6, 9)}${String(int(0, 9999)).padStart(4, '0')} ${String(int(0, 99999)).padStart(5, '0')}`;
      case 'uuid': return uuid();
      case 'sequence': return Math.trunc(Number(c.start) || 0) + idx;
      case 's3_key': return String(c.pattern || '{uuid}').replace(/\{(uuid|seq|n|date|rand|hex)\}/g, (_, k) => (
        k === 'uuid' ? uuid() : k === 'seq' || k === 'n' ? String(idx + 1) : k === 'date'
          ? new Date(Date.parse('2024-01-01T00:00:00Z') + int(0, 730) * 86400000).toISOString().slice(0, 10).replace(/-/g, '/')
          : k === 'hex' ? hex(8) : String(int(0, 999999))));
      case 'int': { const lo = Math.ceil(Number(c.min)), hi = Math.floor(Number(c.max)); return hi < lo ? lo : int(lo, hi); }
      case 'float': {
        const d = Math.max(0, Math.min(10, Math.trunc(Number(c.decimals) || 0)));
        return Number((Number(c.min) + rnd() * (Number(c.max) - Number(c.min))).toFixed(d));
      }
      case 'bool': return rnd() < 0.5;
      case 'enum': { const v = splitList(c.values); return v.length ? pick(v) : null; }
      case 'date': return new Date(timeIn(false)).toISOString().slice(0, 10);
      case 'datetime': return new Date(timeIn(true)).toISOString().slice(0, 19).replace('T', ' ');
      case 'iso': return new Date(timeIn(true) + int(0, 999)).toISOString();
      case 'epoch': return Math.floor(timeIn(true) / 1000);
      case 'lorem_words': return words(Math.max(1, Math.min(200, Math.trunc(Number(c.count) || 1))));
      case 'lorem_sentence': return sentence();
      case 'lorem_paragraph': return Array.from({ length: int(3, 6) }, sentence).join(' ');
      case 'city': return pick(CITIES);
      case 'country': return pick(COUNTRIES);
      case 'company': return pick(COMPANIES);
      case 'street': return `${int(1, 999)} ${pick(STREETS)}`;
      case 'ipv4': return `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
      case 'ipv6': return `2001:db8:${Array.from({ length: 6 }, () => hex(4).replace(/^0+(?=.)/, '')).join(':')}`;
      case 'url': return `https://example.com/${pick(URL_WORDS)}/${pick(LOREM)}-${int(1, 9999)}`;
      case 'hex_color': return `#${hex(6)}`;
      case 'json': return { id: int(1, 100000), tag: pick(TAGS), active: rnd() < 0.5, score: Number((rnd() * 100).toFixed(2)) };
      default: return null;
    }
  }

  return {
    columns: cols,
    /** The next n rows; calling next(a) then next(b) gives the same rows as next(a + b). */
    next(n) {
      const rows = [];
      for (let r = 0; r < n; r++) {
        const p = { first: people.pick(FIRST_NAMES), last: people.pick(LAST_NAMES) };  // always drawn: stable rows
        const idx = rowIndex++;
        rows.push(cols.map((c, i) => {
          const R = streams[i];
          const isNull = R.rnd() * 100 < c.nullPct;  // always drawn, so changing null % keeps the other values
          const v = value(c, R, () => p, idx);
          return isNull ? null : v;
        }));
      }
      return rows;
    },
  };
}

/* ------------------------------------------------------------------ output formats */
export const FORMATS = [
  { value: 'csv', label: 'CSV', ext: 'csv' }, { value: 'json', label: 'JSON', ext: 'json' }, { value: 'jsonl', label: 'JSONL', ext: 'jsonl' },
  { value: 'sql', label: 'SQL INSERT', ext: 'sql' }, { value: 'md', label: 'Markdown', ext: 'md' },
];

const scalar = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
export const csvCell = (v) => { const s = scalar(v); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const sqlIdent = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`);
export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${scalar(v).replace(/'/g, "''")}'`;
}
export const mdCell = (v) => (v === null ? '' : scalar(v)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

const SQL_BATCH = 500;

/**
 * One piece of output. For a chunked run pass first: true on the first chunk and last: true on the final one;
 * concatenating the pieces gives the same text as one call over all rows.
 */
export function formatRows(format, columns, rows, { table = 'fake_data', first = true, last = true } = {}) {
  const names = columns.map((c) => c.name);
  const out = [];
  if (format === 'csv') {
    if (first) out.push(names.map(csvCell).join(','));
    for (const r of rows) out.push(r.map(csvCell).join(','));
    return out.join('\n') + (out.length ? '\n' : '');
  }
  if (format === 'json') {
    const items = rows.map((r) => `  ${JSON.stringify(Object.fromEntries(names.map((n, i) => [n, r[i]])))}`);
    let s = first ? '[' : '';
    if (items.length) s += `${first ? '' : ','}\n${items.join(',\n')}`;
    if (last) s += first && !items.length ? ']\n' : '\n]\n';
    return s;
  }
  if (format === 'jsonl') return rows.map((r) => `${JSON.stringify(Object.fromEntries(names.map((n, i) => [n, r[i]])))}\n`).join('');
  if (format === 'sql') {
    const head = `INSERT INTO ${sqlIdent(table || 'fake_data')} (${names.map(sqlIdent).join(', ')}) VALUES\n`;
    for (let i = 0; i < rows.length; i += SQL_BATCH) {
      out.push(head + rows.slice(i, i + SQL_BATCH).map((r) => `  (${r.map(sqlValue).join(', ')})`).join(',\n') + ';\n');
    }
    return out.join('');
  }
  if (format === 'md') {
    if (first) out.push(`| ${names.map(mdCell).join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`);
    for (const r of rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
    return out.join('\n') + (out.length ? '\n' : '');
  }
  throw new Error(`Unknown format: ${format}`);
}

/** Convenience: generate n rows and format them in one go (tests, small runs). */
export function generate(columns, { rows = 10, seed = '1', format = 'json', table } = {}) {
  const g = createGenerator(columns, seed);
  return formatRows(format, g.columns, g.next(rows), { table });
}
