// Manifest of Dev Tools that live in their own module (loaded only when first opened).
//
// Tool module contract — ./<key>.js:
//   export default function build() -> { el: HTMLElement, clear(): void, focus?(): void }   (may be async)
// Use the shared helpers in ../ui.js (area, labelled, notice, show, copyBtn, dropZone, kvList, opt, setOpt) and
// put pure, testable logic in ./<key>.logic.js (no DOM). CSS goes in /static/css/devtools.css under .dt-<key>.
// Keys here must match app/services/devtools/__init__.py TOOLS (global search).

// group order of the sidebar; built-in tools in devtools.js use the same group names
export const GROUP_ORDER = ['Pipeline & data', 'Formats', 'Encode & secrets', 'Time & numbers', 'Generate', 'Web & ops'];

export const TOOL_GROUPS = [
  // pipeline & data work
  { key: 'bbox', icon: '🔲', name: 'Box / polygon viewer', group: 'Pipeline & data', load: () => import('./bbox.js') },
  { key: 'jsonl', icon: '📜', name: 'JSONL inspector', group: 'Pipeline & data', load: () => import('./jsonl.js') },
  { key: 'sql', icon: '🗄️', name: 'SQL format + IN list', group: 'Pipeline & data', load: () => import('./sql.js') },
  { key: 'csv', icon: '📊', name: 'CSV ⇄ JSON / INSERT', group: 'Pipeline & data', load: () => import('./csv.js') },
  { key: 's3', icon: '🪣', name: 'S3 path', group: 'Pipeline & data', load: () => import('./s3.js') },
  { key: 'cron', icon: '⏰', name: 'Cron helper', group: 'Pipeline & data', load: () => import('./cron.js') },
  { key: 'env', icon: '🧾', name: '.env converter', group: 'Pipeline & data', load: () => import('./env.js') },
  // formats
  { key: 'yaml', icon: '📐', name: 'YAML ⇄ JSON', group: 'Formats', load: () => import('./yaml.js') },
  { key: 'markdown', icon: '📝', name: 'Markdown preview', group: 'Formats', load: () => import('./markdown.js') },
  // encode & secrets
  { key: 'password', icon: '🔑', name: 'Password generator', group: 'Encode & secrets', load: () => import('./password.js') },
  { key: 'unicode', icon: '🔍', name: 'Unicode inspector', group: 'Encode & secrets', load: () => import('./unicode.js') },
  // time & numbers
  { key: 'duration', icon: '⏳', name: 'Duration calculator', group: 'Time & numbers', load: () => import('./duration.js') },
  { key: 'units', icon: '🔢', name: 'Number & unit converter', group: 'Time & numbers', load: () => import('./units.js') },
  { key: 'chmod', icon: '🛡️', name: 'chmod calculator', group: 'Time & numbers', load: () => import('./chmod.js') },
  // generate
  { key: 'fake', icon: '🎲', name: 'Fake data', group: 'Generate', load: () => import('./fake.js') },
  { key: 'qr', icon: '▦', name: 'QR code', group: 'Generate', load: () => import('./qr.js') },
  { key: 'color', icon: '🎨', name: 'Color', group: 'Generate', load: () => import('./color.js') },
  // web & ops
  { key: 'http', icon: '📖', name: 'HTTP reference', group: 'Web & ops', load: () => import('./http.js') },
  { key: 'curl', icon: '🌀', name: 'curl converter', group: 'Web & ops', load: () => import('./curl.js') },
  { key: 'api', icon: '📡', name: 'API tester', group: 'Web & ops', load: () => import('./api.js') },
  { key: 'docker', icon: '🐳', name: 'Docker / kubectl builder', group: 'Web & ops', load: () => import('./docker.js') },
  { key: 'image', icon: '🖼️', name: 'Image tool', group: 'Web & ops', load: () => import('./image.js') },
];
