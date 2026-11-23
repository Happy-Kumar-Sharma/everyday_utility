#!/usr/bin/env bash
# Remove what scripts/install_linux.sh created: the app-grid entry, icons, desktop shortcut and autostart entry.
#   bash scripts/uninstall_linux.sh [--purge-venv] [--dry-run]
# --purge-venv also deletes <repo>/.venv. Your data (data/, private/) is never touched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="everyday-utility"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor"
VENV="${EU_VENV:-$REPO/.venv}"
MARKER="X-EverydayUtility-Installer=true"

DRY=0 PURGE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --purge-venv) PURGE=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

run() {
  if (( DRY )); then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}
remove_entry() {  # only .desktop files the installer wrote (they carry the marker line)
  if [[ -f "$1" ]] && grep -qx "$MARKER" "$1"; then
    run rm -f "$1"
    echo "Removed $1"
  fi
}

desktop_dir() {
  local d=""
  command -v xdg-user-dir >/dev/null 2>&1 && d="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  [[ -n "$d" && "$d" != "$HOME" ]] || d="$HOME/Desktop"
  printf '%s' "$d"
}

remove_entry "$APPS_DIR/$APP_ID.desktop"
remove_entry "$(desktop_dir)/$APP_ID.desktop"
remove_entry "$CONFIG_HOME/autostart/$APP_ID.desktop"
for icon in "48x48/apps/$APP_ID.png" "256x256/apps/$APP_ID.png" "scalable/apps/$APP_ID.svg"; do
  if [[ -f "$ICON_DIR/$icon" ]]; then
    run rm -f "$ICON_DIR/$icon"
    echo "Removed $ICON_DIR/$icon"
  fi
done

if (( PURGE )); then
  if [[ -f "$VENV/pyvenv.cfg" ]]; then
    run rm -rf "$VENV"
    echo "Removed the virtual environment $VENV"
  else
    echo "No virtual environment at $VENV"
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1 && [[ -d "$APPS_DIR" ]]; then
  run update-desktop-database -q "$APPS_DIR" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [[ -f "$ICON_DIR/icon-theme.cache" ]]; then
  run gtk-update-icon-cache -q -f -t "$ICON_DIR" || true
fi

echo "Kept your data (data/, private/). A running server keeps running: stop it with"
echo "  python3 \"$REPO/launcher.py\" --stop     (the systemd service, if used: bash scripts/install_service.sh --uninstall)"
