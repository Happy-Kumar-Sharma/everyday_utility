# Install Everyday Utility as a desktop app

After a one-time install you start Everyday Utility like any other app: click its icon in the Ubuntu app grid /
dock or the Windows Start menu. No terminal, no `./run.sh`.

What you get:

- an **Everyday Utility** icon (app grid + dock on Ubuntu, Start menu + Desktop on Windows);
- one click starts the local server in the background (only if it isn't running yet) and opens the app in its
  **own window** (a Chrome / Edge "app window": no tabs, no address bar);
- clicking the icon again just brings up another window: there is only ever one server;
- **Stop server** (right-click the dock icon on Ubuntu, Start menu → *Stop Everyday Utility* on Windows);
- optional: start the server automatically when you log in.

Everything still runs only on your computer (`127.0.0.1:8765`). Developers can keep using `./run.sh --reload`.

---

## Requirements

| | Ubuntu (22.04 or newer) | Windows 10 / 11 |
|---|---|---|
| Python 3.10+ | `python3` + `python3-venv` | Python 3.12 from winget or python.org |
| App window | Google Chrome, Chromium, Brave or Edge (Firefox works, but opens a normal tab) | Edge (built in) or Chrome |
| Git | to clone / update (or copy the folder) | Git for Windows: also provides the `bash` some features need |
| Optional | `psql` (PostgreSQL client) for the SQL steps | `psql` for the SQL steps |

---

## Ubuntu

1. **Prerequisites** (once):
   ```bash
   sudo apt update
   sudo apt install -y python3 python3-venv git
   ```
2. **Get the app** — clone it (or copy the folder from your other computer):
   ```bash
   cd ~/workspace
   git clone <your-repo-url> everyday_utility
   cd everyday_utility
   ```
3. **Install** (creates `.venv`, installs the Python packages, adds the icon and the app-grid entry):
   ```bash
   bash scripts/install_linux.sh
   ```
4. **Start it**: press the Super key, type **Everyday**, click **Everyday Utility**. The first start takes a
   few seconds.
5. **Pin it to the dock**: right-click the icon in the dock → **Pin to Dash**.

Right-click the icon for **Stop server** and **Server status**.

### Options

```bash
bash scripts/install_linux.sh --autostart          # also start the server (no window) when you log in
bash scripts/install_linux.sh --desktop-shortcut   # also put an icon on the desktop
bash scripts/install_linux.sh --dry-run            # only show what it would do
bash scripts/install_linux.sh --no-deps            # skip pip (offline; uses the existing .venv)
```

The installer is safe to run again at any time (after an update, or after moving the folder).

**Alternative to `--autostart`:** the systemd user service keeps the server running and restarts it if it
crashes: `bash scripts/install_service.sh` (see the README). The app icon works with it too: it sees the
server is already running and just opens the window. Use one of the two, not both.

---

## Windows (native)

1. **Prerequisites** (once). Open *Command Prompt* or *PowerShell* and run:
   ```bat
   winget install -e --id Python.Python.3.12
   winget install -e --id Git.Git
   ```
   No winget? Download Python from <https://www.python.org/downloads/windows/> (tick **Add python.exe to
   PATH**) and Git from <https://git-scm.com/download/win>. Close and reopen the terminal afterwards.
2. **Get the app** — clone it (or copy the folder):
   ```bat
   cd %USERPROFILE%
   git clone <your-repo-url> everyday_utility
   ```
3. **Install**: in File Explorer open `everyday_utility\scripts` and **double-click `install_windows.bat`**
   (or run `scripts\install_windows.bat` in Command Prompt). It creates `.venv`, installs the packages and adds
   the shortcuts. If Git for Windows is missing it tells you which features need it.
4. **Start it**: Start menu → **Everyday Utility** (or the Desktop icon). Right-click it → **Pin to taskbar**.

Stop the server: Start menu → **Stop Everyday Utility**.

### Options

Pass them to the `.bat` from Command Prompt:

```bat
scripts\install_windows.bat -Autostart            :: also start the server when you log in
scripts\install_windows.bat -NoDesktopShortcut    :: Start menu entries only
scripts\install_windows.bat -DryRun               :: only show what it would do
scripts\install_windows.bat -NoDeps               :: skip pip
```

(`set EU_NO_PAUSE=1` first if you don't want the "Press any key" at the end.)

---

## Windows with WSL (repo inside Ubuntu-on-Windows)

Use this if you keep the repo **inside WSL** (e.g. `/home/you/everyday_utility`) and want the Linux tools
(bash, psql, the pipeline scripts) to run there. The server runs in WSL; the window opens in Edge on Windows
(WSL 2 forwards `localhost`).

1. **Inside WSL** (Ubuntu terminal) do the Ubuntu steps 1–3 above. You can skip the app-grid part; the
   important result is `.venv` with the packages installed.
2. **On Windows**, run the installer in WSL mode from Command Prompt. The easiest way is straight from the WSL
   folder, which fills in the distro and path for you:
   ```bat
   \\wsl$\Ubuntu\home\you\everyday_utility\scripts\install_windows.bat -Wsl
   ```
   or name them explicitly:
   ```bat
   scripts\install_windows.bat -Wsl -Distro Ubuntu -RepoPath /home/you/everyday_utility
   ```
3. Start menu → **Everyday Utility**. It starts the server inside WSL (hidden, no console window) and opens the
   app window on `http://localhost:8765`. **Stop Everyday Utility** stops it; `-Autostart` works here too.

The shortcuts run a small helper, `%LOCALAPPDATA%\EverydayUtility\everyday-utility-wsl.vbs`. A hidden `wsl.exe`
stays open while the server runs (that keeps WSL from shutting the distro down).

---

## What works where

| Feature | Ubuntu | Windows (native) | Windows + WSL |
|---|---|---|---|
| Planner, Library (copy / open), Column Extractor, Dev Tools, Manager, Activity | ✓ | ✓ | ✓ |
| App window with its own icon | ✓ Chrome / Chromium / Brave / Edge | ✓ Edge / Chrome | ✓ Edge / Chrome |
| 🖥 Screen time | ✓ GNOME idle time | limited: Windows idle time where your version supports it, otherwise only activity in the app window | limited: no GNOME in WSL, activity in the app window |
| Desktop notifications (reminders, water, standup) | ✓ (allow them once in the window) | ✓ | ✓ |
| Library ▶ Run (.sh), AI pipeline steps, Remote Jupyter, Prod → Staging sync | ✓ | needs Git for Windows (bash) | ✓ |
| SQL export / SQL steps | needs `psql` | needs `psql` + Git bash | needs `psql` in WSL |
| Start at login | `--autostart` or systemd service | `-Autostart` | `-Autostart` |

---

## Your data

Everything you create lives in the app folder: `data/` (planner, settings, job logs, uploads) and `private/`
(library files, credentials file). Both are in `.gitignore` and are **never pushed**. Installing, updating and
uninstalling never touch them. To move to a new computer use **💾 Create backup now** in the Guide tab and the
restore steps there.

Logs of the desktop launcher: `data/logs/launcher.log` (clicks, starts, stops) and `data/logs/server.log`
(the server's output).

---

## Updating

```bash
cd ~/workspace/everyday_utility        # Windows: cd %USERPROFILE%\everyday_utility
git pull
bash scripts/install_linux.sh          # Windows: scripts\install_windows.bat
```

Then stop the server (right-click → Stop server / Start menu → Stop Everyday Utility) and click the icon again,
so the new code is loaded.

---

## Stop and uninstall

- **Stop the server**: dock icon → right-click → **Stop server** · Start menu → **Stop Everyday Utility** ·
  or `python3 launcher.py --stop`. Status: `python3 launcher.py --status`.
  It only stops a server the launcher started (checked by pid, port and folder); one started by `./run.sh` or
  the systemd service is stopped where it runs. On Windows, Stop ends the server immediately (`taskkill /F`:
  a window-less server can't be asked to close); your data is saved as you work, so nothing is lost.
- **Uninstall on Ubuntu**:
  ```bash
  bash scripts/uninstall_linux.sh                 # icon, app-grid entry, desktop icon, autostart
  bash scripts/uninstall_linux.sh --purge-venv    # ... and delete .venv
  ```
- **Uninstall on Windows**: double-click `scripts\uninstall_windows.bat` (add `-PurgeVenv` from Command Prompt
  to delete `.venv` too).

Uninstalling only removes what the installer created. Your `data/` and `private/` folders stay; delete the
app folder yourself if you want everything gone.

---

## Troubleshooting

**"Port 8765 is used by another program"** — another app has the port. Pick another one:
- Ubuntu: put `EU_PORT=8766` in `~/.config/everyday-utility.env` (the launcher and the systemd service both read
  it), then click the icon again.
- Windows: `scripts\install_windows.bat -Port 8766` (the shortcuts then use that port).

**The app opens in a normal browser tab instead of its own window** — no Chrome / Chromium / Edge was found.
Install Google Chrome (Ubuntu) — Windows always has Edge. Firefox has no app-window mode.

**Nothing happens when I click the icon** — look at `data/logs/launcher.log` and `data/logs/server.log` in the
app folder. Usually the Python packages are missing: run the installer again (without `--no-deps`). You can also
run the launcher in a terminal to see its messages: `.venv/bin/python launcher.py` (Windows:
`.venv\Scripts\python.exe launcher.py`).

**Ubuntu: the window shows up as a second Chrome icon in the dock** — the dock groups the window with the
Everyday Utility icon by its window class. That works when Chrome is started fresh by the icon; when Chrome is
already running it may give the window its own class. Check the class with `xprop WM_CLASS` (click the window)
or Looking Glass (Alt+F2, `lg`, Windows tab), then reinstall with it:
`bash scripts/install_linux.sh --wm-class '<the class>'`. On Wayland this mostly affects Chrome running natively
on Wayland; the default (XWayland) is fine.

**Windows: "Windows protected your PC" (SmartScreen) on the .bat** — the file came from a download / zip.
Click **More info → Run anyway**, or unblock the folder once in PowerShell:
`Get-ChildItem -Recurse $env:USERPROFILE\everyday_utility | Unblock-File`. Cloning with git avoids this.

**Windows: "running scripts is disabled on this system"** — use the `.bat` files: they run the PowerShell
script with `-ExecutionPolicy Bypass` for that one run, without changing your system policy.

**Windows: "Python was not found; run without arguments to install from the Microsoft Store"** — that is the
Store placeholder, not Python. Install Python (step 1) and reopen the terminal; the installer ignores the
placeholder.

**Windows + WSL: the window opens but shows "can't reach this page"** — make sure the server runs in WSL
(`./.venv/bin/python launcher.py --status` inside WSL) and that `localhostForwarding` is not disabled in
`%USERPROFILE%\.wslconfig`.

---

## Remote / phone access

Optional and off by default: reach the app from your phone over Tailscale, behind a password. See
[scripts/tailscale_remote.md](scripts/tailscale_remote.md).
