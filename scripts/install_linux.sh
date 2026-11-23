#!/usr/bin/env bash
# Install Everyday Utility as a desktop app: an "Everyday Utility" icon in the app grid / dock, no terminal needed.
#   bash scripts/install_linux.sh                    install or update (run it again after git pull or moving the folder)
#     --autostart          also start the server in the background at login (no window)
#     --desktop-shortcut   also put an icon on the desktop
#     --no-deps            skip pip (use the existing .venv, or python3 when there is none)
#     --wm-class NAME      StartupWMClass for dock grouping (default EverydayUtility, see install.md)
#     --dry-run            print what would happen, change nothing
#   bash scripts/install_linux.sh --uninstall [--purge-venv]   same as scripts/uninstall_linux.sh
# Writes only below $HOME (XDG_DATA_HOME / XDG_CONFIG_HOME) and <repo>/.venv; never touches data/ or private/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for arg in "$@"; do
  if [[ "$arg" == "--uninstall" ]]; then
    args=()
    for a in "$@"; do [[ "$a" == "--uninstall" ]] || args+=("$a"); done
    exec bash "$REPO/scripts/uninstall_linux.sh" ${args[@]+"${args[@]}"}
  fi
done

APP_ID="everyday-utility"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor"
DESKTOP_FILE="$APPS_DIR/$APP_ID.desktop"
AUTOSTART_FILE="$CONFIG_HOME/autostart/$APP_ID.desktop"
VENV="${EU_VENV:-$REPO/.venv}"
MARKER="X-EverydayUtility-Installer=true"  # uninstall_linux.sh only removes .desktop files carrying this line

DRY=0 AUTOSTART=0 SHORTCUT=0 DEPS=1 WM_CLASS="EverydayUtility"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --autostart) AUTOSTART=1 ;;
    --desktop-shortcut) SHORTCUT=1 ;;
    --no-deps) DEPS=0 ;;
    --wm-class) WM_CLASS="${2:?--wm-class needs a value}"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
run() {
  if (( DRY )); then say "[dry-run] $*"; else "$@"; fi
}
write_file() {  # write_file PATH MODE CONTENT
  if (( DRY )); then
    say "[dry-run] write $1:"
    printf '%s\n' "$3" | sed 's/^/    /'
    return
  fi
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$3" >"$1"
  chmod "$2" "$1"
}

# One Exec= argument per the Desktop Entry spec: reserved characters need double quotes, inside them " ` $ \
# are backslash-escaped, then the string-value rule doubles every backslash; a literal % is written %%.
exec_arg() {
  local s="$1" safe='^[A-Za-z0-9_./:@+,=-]+$'
  if [[ ! "$s" =~ $safe ]]; then
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//\`/\\\`}"; s="${s//\$/\\\$}"
    s="\"$s\""
    s="${s//\\/\\\\}"
  fi
  printf '%s' "${s//%/%%}"
}

desktop_dir() {
  local d=""
  command -v xdg-user-dir >/dev/null 2>&1 && d="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  [[ -n "$d" && "$d" != "$HOME" ]] || d="$HOME/Desktop"
  printf '%s' "$d"
}

# ---- python 3.10+ and the venv -------------------------------------------------------------------
PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  say "python3 was not found. Install it with:  sudo apt install python3 python3-venv" >&2
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  say "Python 3.10+ is needed, found $("$PY" --version 2>&1). On Ubuntu 22.04+ python3 is new enough." >&2
  exit 1
fi
PY="$("$PY" -c 'import sys; print(sys.executable)')"  # the real interpreter, not a pyenv shim
PYVER="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

(( DRY )) && say "Dry run: nothing is changed."
say "Everyday Utility in $REPO"
if [[ -x "$VENV/bin/python" ]]; then
  PYBIN="$VENV/bin/python"
elif (( DEPS )); then
  if ! "$PY" -c 'import ensurepip, venv' >/dev/null 2>&1; then
    say "Python's venv module is missing. Install it with:  sudo apt install python3-venv  (or python$PYVER-venv)" >&2
    exit 1
  fi
  say "Creating the virtual environment $VENV"
  run "$PY" -m venv "$VENV"
  PYBIN="$VENV/bin/python"
else
  PYBIN="$PY"  # --no-deps without a venv: the packages must already be installed for python3
fi
if (( DEPS )); then
  say "Installing the Python packages (requirements.txt) into $VENV"
  run "$PYBIN" -m pip install --quiet --upgrade pip
  run "$PYBIN" -m pip install --quiet -r "$REPO/requirements.txt"
fi
if (( ! DRY )) && ! "$PYBIN" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  say "WARNING: fastapi / uvicorn are not importable by $PYBIN: run this script without --no-deps." >&2
fi

# ---- icons ----------------------------------------------------------------------------------------
ASSETS="$REPO/assets"
if [[ ! -f "$ASSETS/icon.png" || ! -f "$ASSETS/icon-48.png" ]]; then
  say "Generating the icons"
  run "$PYBIN" "$REPO/scripts/make_icons.py" || say "WARNING: could not draw the icons (needs Pillow); a generic icon is used." >&2
fi
for pair in "icon-48.png:48x48/apps/$APP_ID.png" "icon.png:256x256/apps/$APP_ID.png" "icon.svg:scalable/apps/$APP_ID.svg"; do
  src="$ASSETS/${pair%%:*}" dst="$ICON_DIR/${pair#*:}"
  if [[ -f "$src" ]] || (( DRY )); then
    run install -D -m 644 "$src" "$dst"
  fi
done

# ---- .desktop entries -----------------------------------------------------------------------------
LAUNCH="$(exec_arg "$PYBIN") $(exec_arg "$REPO/launcher.py")"
DESKTOP="[Desktop Entry]
Type=Application
Version=1.5
Name=Everyday Utility
GenericName=Utility toolbox
Comment=Planner, library, file tools and pipelines - runs locally
Exec=$LAUNCH
Icon=$APP_ID
Terminal=false
Categories=Development;Utility;
Keywords=planner;tasks;library;sql;csv;tools;
StartupNotify=false
StartupWMClass=$WM_CLASS
Actions=stop;status;
$MARKER

[Desktop Action stop]
Name=Stop server
Exec=$LAUNCH --stop

[Desktop Action status]
Name=Server status
Exec=$LAUNCH --status"
write_file "$DESKTOP_FILE" 644 "$DESKTOP"

SHORTCUT_FILE="$(desktop_dir)/$APP_ID.desktop"
if (( SHORTCUT )) || { [[ -f "$SHORTCUT_FILE" ]] && grep -qx "$MARKER" "$SHORTCUT_FILE"; }; then
  write_file "$SHORTCUT_FILE" 755 "$DESKTOP"
  if command -v gio >/dev/null 2>&1; then  # GNOME desktop icons only launch "trusted" files
    run gio set "$SHORTCUT_FILE" metadata::trusted true 2>/dev/null || true
  fi
fi

if (( AUTOSTART )) || { [[ -f "$AUTOSTART_FILE" ]] && grep -qx "$MARKER" "$AUTOSTART_FILE"; }; then
  write_file "$AUTOSTART_FILE" 644 "[Desktop Entry]
Type=Application
Name=Everyday Utility (server)
Comment=Starts the Everyday Utility server in the background at login
Exec=$LAUNCH --server-only --no-window
Icon=$APP_ID
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
$MARKER"
fi

if command -v update-desktop-database >/dev/null 2>&1; then run update-desktop-database -q "$APPS_DIR" || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then run gtk-update-icon-cache -q -f -t "$ICON_DIR" || true; fi

say ""
say "Done. Open \"Everyday Utility\" from the app grid (Super key, type Everyday), then right-click its dock icon"
say "-> Pin to Dash. The first start takes a few seconds; right-click the icon for Stop server / Server status."
[[ -f "$AUTOSTART_FILE" ]] && say "The server also starts at login (remove with: bash scripts/uninstall_linux.sh)."
(( AUTOSTART )) || say "Start the server at login: --autostart, or the systemd user service scripts/install_service.sh."
say "Logs: data/logs/launcher.log and data/logs/server.log. Remove: bash scripts/uninstall_linux.sh"
