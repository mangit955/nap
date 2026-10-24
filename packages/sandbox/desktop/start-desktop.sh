#!/bin/bash
set -euo pipefail
port="${1:-5173}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || exit 2
policy_json() {
  printf '{"URLBlocklist":["*","chrome://*","file://*"],"URLAllowlist":["http://.localhost:%s","http://127.0.0.1:%s"],"BrowserSignin":0,"PasswordManagerEnabled":false,"DeveloperToolsAvailability":1}\n' "$port" "$port"
}
if [[ "${2:-}" == "--print-policy" ]]; then policy_json; exit; fi
state=/home/user/.nap-desktop
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/start.lock"
flock -w 45 9
export DISPLAY=:99
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >"$state/xvfb.log" 2>&1 9>&- &
  for attempt in {1..100}; do xdpyinfo >/dev/null 2>&1 9>&- && break; sleep .1; done
fi
xdpyinfo >/dev/null
if ! pgrep -u "$(id -u)" -x openbox >/dev/null; then
  openbox >"$state/openbox.log" 2>&1 9>&- &
fi
policy=/etc/opt/chrome/policies/managed/nap.json
policy_json > "$policy"
if ! curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  google-chrome-stable --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --password-store=basic --disable-sync --disable-breakpad --window-size=1024,768 --start-maximized --user-data-dir="$state/chrome" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "http://localhost:$port" >"$state/chrome.log" 2>&1 9>&- &
fi
for attempt in {1..150}; do curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 9>&- && break; sleep .1; done
curl -fsS http://127.0.0.1:9222/json/version >/dev/null
if [[ ! -f "$state/password" ]]; then
  openssl rand -base64 6 > "$state/password"
  chmod 600 "$state/password"
  x11vnc -storepasswd "$(cat "$state/password")" "$state/vnc-passwd" > /dev/null 2>&1
fi
if ! pgrep -u "$(id -u)" -x x11vnc >/dev/null; then
  x11vnc -display :99 -forever -shared -localhost -rfbauth "$state/vnc-passwd" -rfbport 5900 -viewonly >"$state/vnc.log" 2>&1 9>&- &
fi
if ! curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null 2>&1; then
  websockify --web=/usr/share/novnc --heartbeat=30 6080 127.0.0.1:5900 >"$state/websockify.log" 2>&1 9>&- &
fi
for attempt in {1..50}; do curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 9>&- && break; sleep .1; done
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
printf '{"width":1024,"height":768}\n'
