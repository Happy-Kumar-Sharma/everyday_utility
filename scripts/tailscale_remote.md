# Phone access over Tailscale

The app always binds to `127.0.0.1`. `tailscale serve` proxies HTTPS from your tailnet to it, so only
devices signed in to *your* tailnet can reach it, and every remote request needs a login. Remote users get
the full app (jobs run shell commands), which is why a password is mandatory.

## Turn it on

1. **Install Tailscale** on the computer and the phone, and sign both in to the same account:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   Install the Tailscale app on the phone from its app store.
2. **Enable HTTPS** for the tailnet once: admin console → DNS → enable MagicDNS and HTTPS certificates.
3. **Proxy the app** (runs in the background and survives reboots):
   ```bash
   tailscale serve --bg 8765
   tailscale serve status     # shows https://<machine>.<tailnet>.ts.net
   ```
4. **Allow that hostname** in `~/.config/everyday-utility.env` (created by `scripts/install_service.sh`):
   ```bash
   EU_REMOTE_HOSTS=<machine>.<tailnet>.ts.net
   EU_SESSION_HOURS=12        # optional, how long a login lasts
   ```
   Not using the service? Export the same variables before `./run.sh`.
5. **Set the password** (at least 10 characters; stored as an scrypt hash in `<data dir>/auth/password.json`).
   Run it from the repo with the same environment as the app, so it writes where the app reads (`EU_DATA_DIR`)
   and `status` shows your `EU_REMOTE_HOSTS`:
   ```bash
   set -a; . ~/.config/everyday-utility.env; set +a   # skip if you export the variables yourself
   python3 -m app.core.auth set-password
   python3 -m app.core.auth status                    # prints the password file path it used
   ```
6. **Restart** the app: `systemctl --user restart everyday-utility` (or stop and re-run `./run.sh`).
7. On the phone open **`https://<machine>.<tailnet>.ts.net`**, log in, and add it to the home screen.

On the computer, `http://127.0.0.1:8765` keeps working without a login. Logins, failed attempts and
logouts appear in the audit log (kind `auth`). After 5 wrong passwords in 10 minutes, logins are refused
for a while. Sessions live in memory: restarting the app or changing the password logs everyone out.
Use **🚪 Log out** in the sidebar to end a session on the phone.

## Turn it off

- Stop the proxy: `tailscale serve --https=443 off` (or `tailscale serve reset`).
- Refuse remote logins straight away: `python3 -m app.core.auth disable`.
- Remove `EU_REMOTE_HOSTS` from `~/.config/everyday-utility.env` and restart the app, so other hostnames
  are rejected outright.

## Troubleshooting

- **"Invalid host header"**: the hostname isn't in `EU_REMOTE_HOSTS` (check spelling, no `https://`), or the
  app wasn't restarted after editing the env file.
- **"remote access needs a password"**: run step 5. If you did, check that `status` prints the same data
  directory the app uses (load the env file first, as in step 5).
- **Can't connect at all**: is Tailscale on the phone connected? Does `tailscale serve status` list port 8765?
