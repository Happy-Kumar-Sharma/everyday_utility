// 📖 Guide tab: instructions + live paths + one-click backup.

import { get, post } from '../core/api.js';
import { browseFiles, checkbox, codeBlock } from '../core/components.js';
import { clear, fmt, h, store, toast, toastError } from '../core/dom.js';

const p = (...children) => h('p', { style: { margin: 0 } }, ...children);
const ul = (...items) => h('ul', { style: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px' } }, items.map((i) => h('li', {}, i)));
const code = (t) => h('code', {}, t);
const b = (t) => h('b', {}, t);
const tab = (id, label) => h('a', { href: `#/${id}` }, label);

export async function mount(root) {
  let info;
  try { info = await get('/api/guide/paths'); } catch (e) { toastError(e); return; }
  const R = info.app_root;

  const sections = [
    ['start', '🚀 Quick start', () => [
      p(b('Desktop app'), ': after a one-time install, start it from the ', b('Everyday Utility'), ' icon (Ubuntu app grid / dock, Windows Start menu) — it starts the server in the background and opens its own window; right-click the icon to stop it. Steps for Ubuntu, Windows and WSL: ', code('install.md'), '.'),
      codeBlock(`cd ${R}\nbash scripts/install_linux.sh      # Windows: double-click scripts\\install_windows.bat`),
      p('Everything runs locally on ', code(info.url), ' — nothing is sent anywhere. Or start it from a terminal:'),
      codeBlock(`cd ${R}\n./run.sh`),
      p('Then open ', h('a', { href: info.url }, info.url), '. Stop it with ', b('Ctrl+C'), '. Background jobs stop with the server.'),
      p(b('First time on a machine'), ' (Python 3.10+; ', code('psql'), ' is only needed for the pipeline SQL steps):'),
      codeBlock(`cd ${R}\npython3 -m venv .venv\nsource .venv/bin/activate\npip install -r requirements.txt\n./run.sh`),
      p('run.sh activates ', code('.venv'), ' automatically when it exists.'),
      ul(
        [code('./run.sh --reload'), ' restarts the server whenever you edit code (development).'],
        [code('EU_PORT=9000 ./run.sh'), ' uses another port if 8765 is taken.'],
        [code('python3 -m pytest -q'), ' runs the tests.'],
      ),
    ]],

    ['home', '🏠 Home & Ctrl+K', () => [
      p(b('Home'), ' is the start page: today’s tasks (tick them off), the running focus timer, the next reminder, jobs, backup age, favourite / recent library items and recent activity — plus ',
        b('🖥 screen time today'), ', ', b('💧 water'), ' and the ', b('🗣 standup'), ' card. It refreshes on its own.'),
      ul(
        [b('Screen time'), ' counts minutes you are actually active at the computer (GNOME idle time; locked / idle screens don’t count). Only minute counts are stored — nothing about what you do. Hour-by-hour bars, vs yesterday, and a break nudge after a long session.'],
        [b('Water'), ' — “+1 glass” (− to undo), daily goal, 7-day history, and a reminder during work hours when it’s been a while.'],
        [b('Standup'), ' — at your standup time a reminder pops up with a ready summary built from the Planner (yesterday’s done tasks, today’s plan, blockers incl. failed jobs): 📋 Copy, Done, Skip or Snooze.'],
        ['Goals, intervals, work hours, standup time/days and the idle threshold: Home → ⚙ Settings. Reminders also pop up on other tabs.'],
      ),
      p(b('🔎 Search everything'), ' — press ', code('Ctrl K'), ' (', code('⌘ K'), ' on Mac) or click Search in the sidebar:'),
      ul(
        ['Finds tasks, daily notes, library items, logins (title / URL / username — never passwords), env repos and files (variable names only), dev tools and recent activity.'],
        ['Also tabs and actions: New task, New library item, Add login, Create backup, Show jobs, Toggle theme.'],
        ['↑ ↓ to move, Enter to open (it jumps straight to the item), Esc to close. Recent picks show when the box is empty.'],
      ),
    ]],

    ['planner', '✅ Planner', () => [
      p('Your daily list: tasks, reminders, checklists, repeating chores, a done log and daily notes.'),
      ul(
        [b('Quick add'), ' — type and press Enter: ', code('Renew SSL cert #ops !high @tomorrow ^monthly'), '. ',
          code('#tag'), ', ', code('!high'), '/', code('!low'), ', ', code('@today @tomorrow @fri @+3 @2026-12-01'), ', ',
          code('^daily ^weekdays ^weekly ^monthly'), '. The line under the box shows how it was understood.'],
        [b('Click a task'), ' to edit everything: status, priority, due date, reminder, repeat, tags, checklist, notes. ',
          'The ⋯ button next to Add opens the full form for a new task.'],
        [b('Row buttons'), ': ☐ done · ▶ start (in progress) · ☀️ move to today · 🗑 delete. Checklist items tick straight from the list.'],
        [b('Repeating tasks'), ': completing one creates the next occurrence with the checklist reset.'],
        [b('Reminders'), ' pop up in the app on whichever tab is open (Done / 10 min / 1 h / Tomorrow / Dismiss). ',
          'Click “🔔 Enable desktop notifications” once to also get system notifications. The app must be running and open in a browser tab.'],
        [b('Views'), ': Today · Upcoming · All open · Done (grouped by day, “Clear done > 30 days”) · Daily notes (autosaved, one per day).'],
        [b('⬇ Export .txt'), ' — all open tasks, the done log and daily notes as one text file.'],
        [b('⏱ Time tracking'), ' — ▶ on a task starts its timer (only one runs at a time); the focus bar on top shows it ticking. Time spent shows on the task and in the export.'],
        [b('🍅 Pomodoro'), ' — toggle it in the focus bar (default 25 / 5 min, editable); you get a notification when a work block ends and the timer stops on its own.'],
        [b('📊 Week'), ' — weekly review: done per day, created vs completed, time focused per tag, slipped tasks (overdue or postponed) with quick fixes, and “Copy as text” for a retro.'],
        [b('Failed job → task'), ' — when a background job fails, its log panel has “➕ Create task” (high priority, due today, with the log link).'],
      ),
    ]],

    ['devtools', '🛠 Dev Tools', () => [
      p('32 developer utilities in six groups. They run in your browser and inputs are never saved (they may hold tokens). Use the filter box at the top of the list, or Ctrl K (e.g. “cron”, “iou”, “curl”).'),
      ul(
        [b('Pipeline & data'), ' — ', b('Box / polygon viewer'), ' (paste bounding_box / polygon values or rows from the predictions query, draw them on an image, convert xyxy / xywh / YOLO / COCO, IoU) · ',
          b('JSONL inspector'), ' (streams even 1 GB prediction files: keys, bad lines, extract a field, filter) · ', b('SQL format + IN list'), ' (pretty / minify, ids → IN (...) in batches) · ',
          b('CSV ⇄ JSON / INSERT / COPY'), ' · ', b('S3 path'), ' (s3:// ⇄ URLs, console link, aws cli) · ', b('Cron helper'), ' (explain, next runs, builder) · ', b('.env converter'), ' (.env ⇄ export ⇄ JSON ⇄ docker ⇄ k8s, values masked).'],
        [b('Formats'), ' — JSON, text diff, ', b('YAML ⇄ JSON'), ' (converted by this app’s own server, nothing leaves the machine), ', b('Markdown preview'), ', text utilities.'],
        [b('Encode & secrets'), ' — Base64, JWT, hashes, ', b('password / passphrase generator'), ' with strength meter, ', b('Unicode inspector'), ' (hidden characters, BOM, CRLF, look-alike letters, clean-up).'],
        [b('Time & numbers'), ' — epoch time, ', b('duration calculator'), ' (between dates, date ± “3d 4h”, gaps in a pasted log), ', b('number & unit converter'), ' (hex / bin, KB vs KiB, time units), ', b('chmod calculator'), '.'],
        [b('Generate'), ' — UUID, ', b('fake data'), ' (schema → CSV / JSON / SQL, seedable), ', b('QR code'), ' (URL, Wi-Fi, vCard → PNG / SVG), ', b('color'), ' (formats, WCAG contrast, shades).'],
        [b('Web & ops'), ' — URL, regex, ', b('HTTP reference'), ' (status codes, headers, “explain this response”), ', b('curl converter'), ' (curl ⇄ fetch / requests / httpx / axios), ',
          b('API tester'), ' (requests are sent by this app’s server; {{variables}}; save requests to the Library “API requests” collection), ', b('Docker / kubectl builder'), ' (save commands to the Library), ', b('image tool'), ' (EXIF incl. GPS warning, strip metadata, resize / crop / convert).'],
      ),
    ]],

    ['activity', '🧾 Activity (audit log)', () => [
      p('A record of what ran and what changed: background jobs (start / finish with exit code), pipeline steps and the database they used, library runs and edits, logins-file and env-file actions, backups, settings changes, remote logins.'),
      ul(
        ['Names, paths, titles and counts only — never passwords, env values or file contents.'],
        ['Filter by kind, status, environment (prod / staging / local) and time range; search; expand an event for details.'],
        ['Export as text or JSONL. Stored in ', code(`${info.data_dir}/audit/audit.jsonl`), ' (included in data backups).'],
      ),
    ]],

    ['library', '📚 Library', () => [
      p('Saved queries, commands, links and notes. Every item is a real file: collections are folders inside ',
        code(info.library_dir || 'private/library'), ', so you can also edit them in VS Code or grep them.'),
      ul(
        [b('✨ Add starter collections'), ' (empty library) creates Prod / Staging / Local / Mongo queries, Commands and Favourite apps, pre-filled with the pipeline queries and commands.'],
        [b('▦ Cards / ☰ List'), ' toggle (remembered). Sidebar: All, ⭐ Favourites, 🕘 Recently used, 🔥 Most used, and your collections (nest with ', code('Reports/Daily'), ').'],
        [b('Search'), ' matches name, tags, description and content (press ', code('/'), '). Filter by type, environment and tag; sort by edited / used / most used / name. Press ', code('n'), ' for a new item.'],
        [b('Templates'), ': write ', code('WHERE id IN ({{ids}})'), ' or ', code('{{date:2026-01-01}}'), '. Copy / Run asks for the values (remembered per item) and shows a preview. ', code('{{today}}'), ' and ', code('{{now}}'), ' fill in automatically.'],
        [b('Prod guard'), ': items with environment ', code('prod'), ' that change data (UPDATE / DELETE / DROP / deleteMany …) ask for confirmation before Copy or Run.'],
        [b('Shell items'), ' (', code('.sh'), ') have ▶ Run: a background job with live logs, after a confirmation that shows the exact command.'],
        [b('Links'), ' (', code('.url'), ', for favourite apps) have ↗ Open.'],
        ['Delete moves an item to ', b('Trash'), ' (restorable). Copy counts as a “use” for the Recently / Most used views.'],
        ['Like Logins, the library folder must be outside git or git-ignored — saving is blocked otherwise.'],
      ),
    ]],

    ['column', '📋 Column Extractor', () => [
      p('Get every value of a column from a CSV / Excel file joined the way you need — e.g. ids for a SQL ', code('IN (...)'), '.'),
      ul(
        ['Drop a file, click to upload, type a path + Enter, or ', b('Browse…'), ' (newest files first).'],
        ['Click the column chip. Output updates live as you change options.'],
        [b('Presets'), ': SQL IN (ids), SQL IN (\'text\'), Python list, One per line, Plain CSV.'],
        ['Delimiter (comma, comma+space, new line, tab, dot, pipe, semicolon, space, custom — ', code('\\n'), ' / ', code('\\t'), ' work), quote each value, wrap all, unique, skip blanks, trim, sort, line break every N items.'],
        [b('📋 Copy'), ' or ', b('⬇ .txt'), '. The last file, column and options are remembered.'],
      ),
    ]],

    ['pipeline', '🧠 AI Inference Pipeline', () => [
      p('The local YoloV11 prediction run as six cards. Each card shows the exact command / SQL (Copy button) and a ', b('▶ Run'),
        ' button that starts a background job with live logs, Cancel and the full log.'),
      ul(
        [b('1 · Image ids'), ' — pick a column from a file (or paste ids) → “Write ids file”. The old file is kept as ', code('.bak'), '.'],
        [b('2 · Load images'), ' — prod → local ai_cdb migration (asks for confirmation; Dry run / Replace / Batch size).'],
        [b('3 · Export images CSV'), ' — runs the ImageData query on the local DB (read-only session) into the prediction input CSV.'],
        [b('4 · Predictions'), ' — batched (parallel) or single-model. The status card shows progress; safe to cancel and re-run, done images are skipped.'],
        [b('5 · Load predictions'), ' — JSONL → local DB (asks for confirmation).'],
        [b('6 · Query predictions'), ' — results into a CSV with preview and download.'],
        [b('⚙ Settings'), ': repo / venv / file paths, bucket, workers, FP16, model name/version, damage type ids.'],
        ['Jobs keep running when you switch tabs or reload; the cards reconnect. All jobs: ', b('⚙️ Jobs'), ' in the sidebar.'],
      ),
    ]],

    ['manager', '🔐 Manager', () => [
      p(b('🔑 Logins'), ' — login URL, username, password, tags and notes saved to a plain-text file ', b('you choose'), '.'),
      ul(
        ['First visit: pick the file location. The suggested ', code(`${R}/private/credentials.txt`), ' is git-ignored; anywhere outside a git repo is fine too.'],
        ['The badge says whether git could pick the file up. ', b('Saving is blocked'), ' while it could — use “Add to .gitignore” or choose another location.'],
        ['Each save keeps the previous version as ', code('credentials.txt.bak'), ' and sets the file to owner-only (600).'],
        ['You can also edit the file by hand: blocks start with ', code('=== Title ==='), ', then ', code('URL : …'), ', ', code('Username : …'), ', ', code('Password : …'), ', ', code('Tags : …'), ', ', code('Notes :'), ' + indented lines.'],
        ['It is plain text: anyone who can read your home folder can read it. Keep it off shared drives.'],
      ),
      p(b('🧾 Env files'), ' — every repo\'s ', code('.env'), ', ', code('dev.env'), ', ', code('*credentials*.sh'), '…'),
      ul(
        ['Add repos by path / Browse, or ', b('🔎 Scan workspace'), ' to tick several at once.'],
        ['View a file as KEY / value (masked until “Reveal”) or raw; copy single values.'],
        ['“＋ Add file manually” for files the patterns miss (patterns and depth in ⚙ Settings).'],
        [b('⬇ Export'), ' one repo or all repos into one text file (goes to your browser’s Downloads folder).'],
      ),
    ]],

    ['autostart', '⚡ Start on login', () => [
      p('Run the app as a user service so it is always up (and reminders always fire):'),
      codeBlock(`cd ${R}\nbash scripts/install_service.sh --print     # preview the unit\nbash scripts/install_service.sh             # install + start\nsystemctl --user status everyday-utility\njournalctl --user -u everyday-utility -f    # logs`),
      p('Remove it with ', code('bash scripts/install_service.sh --uninstall'), '. Settings for the service (port, data dir, remote hosts) go in ', code('~/.config/everyday-utility.env'), '.'),
      p('To keep it running after you log out: ', code('loginctl enable-linger $USER'), ' (optional).'),
    ]],

    ['remote', '📱 Phone access (Tailscale)', () => [
      p('Off by default. When enabled, the app stays bound to 127.0.0.1 and ', code('tailscale serve'), ' gives your own devices an HTTPS address; every remote request needs a password. On this computer nothing changes.'),
      ul(
        ['Install Tailscale on the computer and phone (same account), enable MagicDNS + HTTPS certificates in the admin console.'],
        [code('tailscale serve --bg 8765'), ' → note the ', code('https://<machine>.<tailnet>.ts.net'), ' address.'],
        ['Put ', code('EU_REMOTE_HOSTS=<machine>.<tailnet>.ts.net'), ' in ', code('~/.config/everyday-utility.env'), '.'],
        ['Set a password (10+ chars): ', code('set -a; . ~/.config/everyday-utility.env; set +a; python3 -m app.core.auth set-password'), ', then restart the app.'],
        ['Open the address on the phone, log in, add it to the home screen. 🚪 Log out is in the sidebar.'],
        ['Turn off: ', code('tailscale serve reset'), ' and ', code('python3 -m app.core.auth disable'), '. Full walkthrough: ', code('scripts/tailscale_remote.md'), '.'],
      ),
      h('div', { class: 'notice warn' }, 'Remote users get the whole app, including running shell commands — use a strong password and only your own tailnet.'),
    ]],

    ['data', '📁 Where your data lives', () => [
      p('All app data is in ', code(info.data_dir), ' (git-ignored). Your logins file: ',
        info.credentials_file ? code(info.credentials_file) : h('span', { class: 'muted' }, 'not chosen yet'), '.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'What'), h('th', {}, 'Folder'), h('th', {}, 'Size'))),
        h('tbody', {}, info.parts.map((x) => h('tr', {}, h('td', {}, x.label), h('td', { class: 'mono' }, x.path), h('td', {}, fmt.bytes(x.size))))))),
      p('Env files themselves are never copied by the app — they stay in their repos; only the list of repos is stored.'),
    ]],

    ['backup', '💾 Backup & restore', () => backupSection(info)],

    ['git', '🐙 Pushing to GitHub safely', () => [
      p('The repo’s ', code('.gitignore'), ' excludes ', code('data/'), ', ', code('private/'), ', ', code('.env*'), ', ', code('*credentials*'),
        ', keys and export dumps. Before the first push, check what git would take:'),
      codeBlock(`cd ${R}\ngit init -b main            # first time only\ngit add -A\ngit status                  # review the list: only code, no data/ private/ .env\ngit status --ignored        # what is being kept out`),
      p('If something private shows up in ', code('git status'), ', unstage it and ignore it:'),
      codeBlock('git rm -r --cached <path>\necho "<path>" >> .gitignore'),
      p('Then commit and push:'),
      codeBlock('git commit -m "Everyday Utility"\ngit remote add origin git@github.com:<you>/everyday_utility.git\ngit push -u origin main'),
      p(b('If a secret was ever pushed'), ', deleting it in a new commit is not enough (it stays in history): rotate the secret first, then rewrite history (e.g. ',
        code('git filter-repo'), ').'),
    ]],

    ['trouble', '🛠 Troubleshooting', () => [
      ul(
        [b('Port in use'), ' — another copy is running (open it), or use ', code('EU_PORT=9000 ./run.sh'), '.'],
        [b('A tab shows “(failed)” in the sidebar'), ' — its Python code raised on import; hover it for the error.'],
        [b('A job says “lost: the server restarted”'), ' — jobs live in memory; its full log is still in ', code(`${info.data_dir}/jobs/`), '. The prediction step can simply be started again.'],
        [b('SQL steps fail to connect'), ' — check “Local DB credentials” in the pipeline ⚙ Settings and that Postgres is running; ', code('psql'), ' must be installed.'],
        [b('Logins: “file changed since it was loaded”'), ' — the file was edited elsewhere; the list reloads, try again.'],
        [b('Old .xls files'), ' need ', code('pip install xlrd'), '.'],
        [b('Changes not showing after editing code'), ' — run with ', code('--reload'), ' and refresh the page.'],
      ),
    ]],

    ['extend', '🧩 Adding a new tab', () => [
      p('Each tab is one Python package + one JS module; nothing else needs registering:'),
      ul(
        [code('app/services/<name>/__init__.py'), ' defines ', code('SERVICE = Service(id="my-tool", title=…, router=…, settings=(…))'), ' — routes are served at ', code('/api/my-tool/…'), '.'],
        [code('web/js/services/my-tool.js'), ' exports ', code('mount(container, { service })'), ' built from ', code('web/js/core/components.js'), '.'],
        ['Long-running commands: ', code('context.jobs.start(...)'), ' + ', code('jobConsole(job)'), '. Settings: ', code('context.service_settings("my-tool")'), '.'],
      ),
      p('README.md has a full template.'),
    ]],
  ];

  const toc = h('nav', { class: 'card', style: { padding: '10px', position: 'sticky', top: '16px', alignSelf: 'start' }, 'aria-label': 'Guide sections' },
    h('div', { class: 'stack', style: { gap: '2px' } }, sections.map(([id, title]) => h('a', { class: 'nav-item', href: `#/guide`, onclick: (e) => {
      e.preventDefault(); root.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } }, title))));
  const body = h('div', { class: 'stack', style: { gap: '16px', minWidth: 0 } }, sections.map(([id, title, build]) =>
    h('section', { class: 'card', dataset: { sec: id } }, h('div', { class: 'card-head' }, h('h2', {}, title)),
      h('div', { class: 'card-body', style: { gap: '10px' } }, build()))));
  root.append(h('div', { class: 'guide-layout' }, toc, body));
  // open(ref) from Ctrl+K / Home / deep links: ref is a section id, e.g. 'backup'
  return {
    open(ref) {
      const sec = root.querySelector(`[data-sec="${CSS.escape(ref)}"]`);
      sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sec?.querySelector('input, button')?.focus({ preventScroll: true });
    },
  };
}

function backupSection(info) {
  const dest = h('input', { type: 'text', class: 'mono', value: store.get('eu.guide.backupDir', info.default_backup_dir) });
  const parts = new Set(info.parts.filter((x) => x.default).map((x) => x.key));
  let includeCreds = true;
  let includeLibrary = true;
  let includeEnv = false;
  const result = h('div', {});
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    btn.disabled = true;
    try {
      store.set('eu.guide.backupDir', dest.value);
      const r = await post('/api/guide/backup', { dest_dir: dest.value, parts: [...parts], include_credentials: includeCreds, include_library: includeLibrary, include_env_files: includeEnv });
      clear(result, h('div', { class: 'notice ok' }, `✓ ${r.path} (${fmt.bytes(r.size)}) — ${r.contents.join(', ')}`));
      toast('Backup created', 'ok');
    } catch (e) { toastError(e); } finally { btn.disabled = false; }
  } }, '💾 Create backup now');

  return [
    p(b('What to back up'), ': your planner, settings and repo list (', code('data/'), '), and your logins file. ',
      'The code itself is on GitHub; the job logs, uploads and query outputs can be re-created.'),
    h('div', { class: 'card', style: { padding: '14px', background: 'var(--surface-2)' } }, h('div', { class: 'stack', style: { gap: '10px' } },
      h('label', { class: 'field' }, 'Backup folder (outside the app folder — a USB drive or synced folder is ideal)',
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, dest,
          h('button', { class: 'btn', type: 'button', onclick: async () => { const x = await browseFiles(dest.value, { mode: 'dir' }); if (x) dest.value = x; } }, 'Browse…'))),
      h('div', { class: 'row', style: { gap: '16px' } },
        info.parts.map((x) => checkbox(`${x.label} (${fmt.bytes(x.size)})`, parts.has(x.key), (v) => (v ? parts.add(x.key) : parts.delete(x.key))))),
      h('div', { class: 'row', style: { gap: '16px' } },
        checkbox(h('span', {}, 'Logins file ', info.credentials_file ? code(info.credentials_file.split('/').pop()) : h('span', { class: 'muted' }, '(not set)')), includeCreds, (v) => { includeCreds = v; }),
        checkbox(`📚 Library (${fmt.bytes(info.library_size)})`, includeLibrary, (v) => { includeLibrary = v; }),
        checkbox('Text export of all registered repos’ env files', includeEnv, (v) => { includeEnv = v; })),
      h('div', { class: 'row' }, btn, h('span', { class: 'muted small' }, 'Creates everyday_utility_backup_<date>.zip (owner-only) with a RESTORE.txt inside.')),
      result)),
    h('div', { class: 'notice warn' }, 'The zip holds your passwords (and env secrets if ticked) in plain text. Keep it off GitHub and shared drives; delete old ones you no longer need.'),
    p(b('Without the app'), ' (same result from a terminal):'),
    codeBlock(`mkdir -p ~/everyday_utility_backups\ncd ${info.app_root}\nzip -r ~/everyday_utility_backups/eu_$(date +%F).zip data/planner data/settings data/manager${info.credentials_file ? ` "${info.credentials_file}"` : ''}`),
    p(b('Automatic daily backup'), ' — add to ', code('crontab -e'), ' (runs at 21:00 every day):'),
    codeBlock(`0 21 * * * cd ${info.app_root} && zip -qr ~/everyday_utility_backups/eu_$(date +\\%F).zip data/planner data/settings data/manager${info.credentials_file ? ` "${info.credentials_file}"` : ''}`),
    p(b('Restore / new machine')),
    ul(
      ['Clone your repo from GitHub and do the first-time setup (Quick start).'],
      ['Unzip the backup’s ', code('data/'), ' into the app folder: ', code(`unzip -o <backup.zip> 'data/*' -d ${info.app_root}`), '.'],
      ['Put ', code('credentials/<file>'), ' back (e.g. into ', code(`${info.app_root}/private/`), ') and point Manager → Logins → Change location at it.'],
      ['Paths inside the pipeline settings are machine-specific: re-check ⚙ Settings if your home folder or repos moved.'],
      ['Start with ', code('./run.sh'), '. Every backup also contains these steps in RESTORE.txt.'],
    ),
  ];
}
