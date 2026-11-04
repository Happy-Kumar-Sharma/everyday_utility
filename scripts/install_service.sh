#!/usr/bin/env bash
# Start Everyday Utility on login as a systemd --user service.
#   scripts/install_service.sh              install (or update) and start it
#   scripts/install_service.sh --print      only print the unit file
#   scripts/install_service.sh --uninstall  stop and remove it (keeps ~/.config/everyday-utility.env)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="everyday-utility"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"
ENV_FILE="$HOME/.config/$NAME.env"

render_unit() {
  sed "s|@REPO@|$REPO|g" "$REPO/scripts/$NAME.service.template"
}

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

has_user_systemd() {
  [[ "$(ps -p 1 -o comm= 2>/dev/null)" == "systemd" ]] && systemctl --user show-environment >/dev/null 2>&1
}

explain_no_systemd() {
  echo "systemd --user is not available here, so the service can't be installed." >&2
  is_wsl || return 0
  local distro="${WSL_DISTRO_NAME:-Ubuntu}"
  cat >&2 <<MSG
This looks like WSL without systemd. Two options:

  1) Enable systemd in WSL (recommended), then run this script again:
       printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
     then from Windows (PowerShell):  wsl --shutdown   and reopen the WSL terminal.

  2) Windows Task Scheduler: a task triggered "At log on" that runs
       Program:   wsl.exe
       Arguments: -d $distro -- bash -lc '$REPO/run.sh'
     e.g. from PowerShell:
       schtasks /Create /TN "Everyday Utility" /SC ONLOGON /TR "wsl.exe -d $distro -- bash -lc '$REPO/run.sh'"
MSG
}

write_env_example() {
  [[ -e "$ENV_FILE" ]] && return 0
  mkdir -p "$(dirname "$ENV_FILE")"
  cat >"$ENV_FILE" <<'ENV'
# Environment for the everyday-utility service (systemd --user). Restart after editing:
#   systemctl --user restart everyday-utility
#
# Phone / remote access over Tailscale (see scripts/tailscale_remote.md). Also set a password, from the repo
# with this file loaded so the CLI sees the same EU_DATA_DIR as the service:
#   set -a; . ~/.config/everyday-utility.env; set +a; python3 -m app.core.auth set-password
#EU_REMOTE_HOSTS=mybox.tail1234.ts.net
#EU_SESSION_HOURS=12
#
#EU_PORT=8765
#EU_DATA_DIR=/path/to/data
ENV
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE (commented examples)."
}

case "${1:-}" in
  --print)
    render_unit
    ;;
  --uninstall)
    if ! has_user_systemd; then explain_no_systemd; exit 1; fi
    systemctl --user disable --now "$NAME.service" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    echo "Removed $UNIT (kept $ENV_FILE)."
    ;;
  "")
    if ! has_user_systemd; then explain_no_systemd; exit 1; fi
    mkdir -p "$UNIT_DIR"
    render_unit >"$UNIT"
    write_env_example
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.service"
    echo "Installed $UNIT and started it on http://127.0.0.1:8765 (or EU_PORT from $ENV_FILE)."
    echo "Logs: journalctl --user -u $NAME -f"
    echo "Keep it running while logged out: loginctl enable-linger \"\$USER\""
    ;;
  *)
    echo "usage: $0 [--print | --uninstall]" >&2
    exit 2
    ;;
esac
