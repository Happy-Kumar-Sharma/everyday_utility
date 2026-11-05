# Everyday Utility

A local web app for the things I keep re-searching: one tab per utility, each runnable with a click.

```bash
./run.sh            # http://127.0.0.1:8765
./run.sh --reload   # auto-reload while developing
```

Needs Python 3.10+ with `pip install -r requirements.txt` (fastapi, uvicorn, pandas, openpyxl,
python-multipart), plus `psql` on PATH for the SQL steps. It binds to 127.0.0.1 only.

## Tabs

### 🏠 Home
The start page: today's tasks, focus timer, next reminder, jobs, backup age, favourite library items, recent
activity — plus **🖥 screen time today** (from GNOME idle time; minute counts only), **💧 water** tracking with
reminders, and a **🗣 standup** reminder with a summary built from the Planner. Press **Ctrl+K** anywhere to search
tasks, notes, library items, logins (never passwords), env files (names only), dev tools and activity.

### ✅ Planner
Daily tasks, reminders and notes.
- **Quick add**: `Renew SSL cert #ops !high @tomorrow ^monthly` sets tags (`#`), priority (`!high` / `!low`),
  due date (`@today`, `@tomorrow`, `@fri`, `@+3`, `@2026-12-01`) and repeat (`^daily`, `^weekdays`, `^weekly`,
  `^monthly`). A preview under the box shows how it was parsed.
- **Views**: Today (overdue, due today, in progress, inbox, done today) · Upcoming (by day) · All open · Done
  (log grouped by completion day) · Daily notes. Search and tag chips filter every view; the stat cards jump to a view.
- **Tasks**: to do / in progress / done, priority, due date, tags, notes, a **checklist** you can tick straight from
  the list, and **repeat**. Completing a repeating task schedules the next one with the checklist reset.
- **Reminders**: set "Remind me at" (or +30 min / +1 h / tomorrow). They pop up in the app whichever tab is
  open (Done / snooze 10 min, 1 h, tomorrow / Dismiss), plus a desktop notification if you allow it.
- **Daily notes**: one note per day, autosaved, with a list of the days that have notes.
- **⬇ Export .txt**: open tasks, the done log and all daily notes in one text file.
  Data lives in `data/planner/planner.json` (the previous version is kept as `.json.bak`).

### 📚 Library
Saved queries (prod / staging / local / Mongo), commands, favourite app links and notes — as **real files**:
collections are folders, items are files (`.sql`, `.js`, `.sh`, `.url`, `.md`, …) in `private/library/`
(git-ignored; configurable, saving is blocked anywhere git could commit it). Files you create by hand show up too.
- **▦ Cards / ☰ List** views (remembered), sidebar with All / ⭐ Favourites / 🕘 Recently used / 🔥 Most used / collections
  (nestable), search across name, tags and content (`/`), type / environment / tag filters, 4 sort orders, `n` for new.
- **Templates**: `{{ids}}`, `{{days:30}}` become fill-in fields with a live preview when you Copy or Run (values remembered
  per item); `{{today}}` / `{{now}}` fill in automatically.
- **Prod guard**: `prod` items that change data (UPDATE / DELETE / DROP / deleteMany …) ask for confirmation.
- **▶ Run** for `.sh` items (background job with live logs, after showing the exact command); **↗ Open** for links.
- Built-in syntax highlighting (offline), usage counts, duplicate, trash with restore, **✨ starter collections**
  pre-filled with the pipeline queries and commands.

### 📋 Column Extractor
Upload or browse to a CSV / TSV / Excel file, click a column, and get every value joined in the format you pick.
- Delimiters: comma, comma + space, new line, tab, dot, pipe, semicolon, space, or custom (`\n` and `\t` work).
- Quote each value (`'a'`, `"a"`), wrap everything (`( )`, `[ ]`, `{ }`), unique only, skip blanks, sort, and a line break every N items.
- Presets: `SQL IN (ids)`, `SQL IN ('text')`, Python list, one per line.
- Copy to the clipboard or download as `.txt`. The last file, column and options are remembered.

### 🧠 AI Inference Pipeline
The local YoloV11 prediction run, one card per step. Each card shows the exact command or SQL (with a Copy
button) and a **Run** button that starts a background job with live logs.

| # | Step | What runs |
|---|------|-----------|
| 1 | Image ids | writes the ids from a file column (or pasted text) to `var/prod_to_local_image_ids.txt`; the old file is kept as `.bak` |
| 2 | Load images | `python var/prod_to_local_images_migration.py --ids-file …` in the aicdb venv |
| 3 | Export images CSV | the `ImageData ⨝ AssessmentData` query on local ai_cdb → `20k_images_latest_for_pred.csv` |
| 4 | Predictions | `predict_from_csv_batched.py` (or single-model `predict_from_csv.py`) with `LD_LIBRARY_PATH=/usr/lib/wsl/lib` |
| 5 | Load predictions | `python var/load_local_predictions_jsonl.py <jsonl>` |
| 6 | Query predictions | the predictions query (damage types filter) → CSV in `data/outputs/`, previewed in the page |

- All paths, the bucket, worker counts, FP16, the model name/version and the damage type ids are in **⚙ Settings**
  (saved to `data/settings/inference-pipeline.json`).
- SQL steps read `POSTGRES_*` from `var/local_credentials.sh` and run in a **read-only** psql session.
- Prediction progress (JSONL lines vs CSV rows) updates live. The prediction scripts skip images already
  in the JSONL, so a run can be cancelled and started again.
- Jobs keep running when you switch tabs or reload the page; the cards reconnect to them. Full logs are in `data/jobs/`.

### 🔐 Manager
- **🔑 Logins**: login URL, username, password, tags and notes saved to a **plain-text file whose location you
  choose** (suggested: `private/credentials.txt`, which `.gitignore` excludes). The tab shows whether git could pick
  the file up and **refuses to save while it could** (one click adds it to that repo's `.gitignore`). Each save keeps
  `credentials.txt.bak` and sets owner-only permissions. The file is readable and hand-editable:

  ```
  === GitHub (personal) ===
  URL      : https://github.com/login
  Username : me@example.com
  Password : ********
  Tags     : personal
  Notes    :
    indented lines
  ```
- **🧾 Env files**: register repositories (by path, Browse, or **Scan workspace**). Each repo lists the env-like
  files found in it (`.env`, `.env.*`, `*.env`, `*credentials*.sh`, … — patterns and depth in ⚙ Settings;
  venv / node_modules / .git are skipped), and you can add any other file by hand. View a file as a
  KEY / value table or the raw file, with values masked until you reveal them. **⬇ Export** writes one text
  file with every file of one repo or of all repos. Only the list of repos is stored; file contents are
  always read live from disk.

### ✅ Planner extras
Per-task time tracking with a 🍅 Pomodoro focus bar, a 📊 weekly review (done per day, time per tag, slipped
tasks, copy as text), and “➕ Create task” on failed jobs.

### 🛠 Dev Tools
32 tools in six groups, almost all running in the browser: **pipeline & data** (box / polygon viewer with IoU,
JSONL inspector, SQL formatter + IN-list builder, CSV ⇄ JSON / INSERT / COPY, S3 paths, cron, .env converter),
**formats** (JSON, diff, YAML ⇄ JSON, Markdown, text), **encode & secrets** (Base64, JWT, hashes, passwords,
Unicode inspector), **time & numbers** (epoch, durations, bases / units, chmod), **generate** (UUID, fake data,
QR, color) and **web & ops** (URL, regex, HTTP reference, curl converter, API tester, docker / kubectl builder,
image tool). Each new tool is its own module in `web/js/services/devtools/tools/` (registered in `index.js`).

### 🧾 Activity
Audit log of what ran and changed (jobs, pipeline steps, library runs, logins/env-file actions, backups, settings,
remote logins) — names and counts only, never secrets. Filter, search, export.

### ⚡ Start on login / 📱 phone access
`bash scripts/install_service.sh` installs a systemd user service. Optional remote access over Tailscale behind a
password: see `scripts/tailscale_remote.md` (off unless `EU_REMOTE_HOSTS` and a password are set).

### 📖 Guide
In-app instructions: running the app, every tab, where data lives, **💾 Create backup now** (zip of planner,
settings, repo list, logins file and optionally an env export, into a folder outside the app, with a RESTORE.txt),
manual/cron backup commands, restoring on a new machine, and pushing to GitHub safely.

## Private data & git
Nothing private lives in tracked files: `data/` (planner, settings, uploads, job logs, outputs), `private/`, `.env*`,
`*credentials*`, keys and `*_export*.txt` are all in `.gitignore`. Before pushing, review `git status`.

## Layout

```
app/
  main.py                    FastAPI app: core API + auto-discovered services + static files
  core/
    registry.py              Service / SettingField definitions, service discovery
    gitsafety.py             “would git commit this path?” — asked of git itself (used by Logins, Library, Backup)
    api.py                   shared endpoints: services, settings, jobs (+ SSE log stream), files, folder browser
    jobs.py                  background bash jobs: process groups, cancel, \r-aware log capture
    tabular.py               CSV/TSV/Excel → string DataFrame (BOM-safe, delimiter sniffing)
    postgres.py              credentials-file parsing, psql CSV export
    settings_store.py        per-service JSON settings
  services/
    column_extractor/        logic.py (pure formatting) + router.py
    inference_pipeline/      settings.py, ids.py, sql.py, commands.py (pure builders) + router.py
    library/                 store.py (files + .library.json metadata + trash), starters.py + router.py
    planner/                 store.py (tasks, recurrence, reminders, notes, export) + router.py
    manager/                 credfile.py (logins text file + git safety), envfiles.py (discovery/parse/export) + router.py
    guide/                   instructions page backend: data paths + backup zip
web/
  index.html, css/app.css
  js/app.js                  shell: sidebar, hash routing, lazy tab loading, jobs drawer, theme
  js/core/                   api.js (fetch), dom.js (h(), toasts, modal), components.js (file picker, job console, …),
                             highlight.js (offline syntax highlighting + {{template}} helpers)
  js/services/<id>.js        one module per tab, exports mount(container, ctx)
tests/                       pytest
```

## Adding a new tab

1. Create `app/services/<name>/__init__.py`:

   ```python
   from fastapi import APIRouter
   from app.core.registry import Service, SettingField

   router = APIRouter()

   @router.post("/do-thing")
   def do_thing(payload: dict): ...

   SERVICE = Service(id="my-tool", title="My Tool", description="…", icon="🔧", order=30, router=router,
                     settings=(SettingField("some_path", "Some path", "~/x", "path"),))
   ```

   Its routes are served under `/api/my-tool/…`. Read the tab's settings with
   `app.core.context.service_settings("my-tool")` (defaults + saved values). For long-running commands use
   `app.core.context.jobs.start(...)` and return `job.to_dict()`; the frontend `jobConsole(job)` streams it.
   Optional hooks: `search=` (Ctrl+K provider returning `{title, subtitle, icon, ref}`; the JS module's
   `mount()` may return `open(ref)` to jump to a result), `startup=` / `shutdown=` (server lifecycle).
   Ship CSS in your own `web/css/<tab>.css` and load it with `loadCss()`.
   Set `background=True` and export `background(ctx)` from the JS module to run something from page load (the
   Planner's reminders work this way). If the package raises on import, the other tabs still load and the sidebar
   shows it as "(failed)" with the traceback on hover.

2. Create `web/js/services/my-tool.js` exporting `mount(container, { service })`, built from the
   components in `web/js/core/components.js` (`filePicker`, `columnPicker`, `codeBlock`, `jobConsole`, `openSettings`, …).

3. Restart. The tab appears in the sidebar.

## Tests

```bash
python3 -m pytest -q
```

`tests/conftest.py` points every test run at a throwaway data folder, so tests never touch your real `data/`.
