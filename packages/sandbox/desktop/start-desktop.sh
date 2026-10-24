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

fail() { echo "Desktop startup: $*" >&2; exit 1; }
chrome_pid= chrome_ticks= chrome_port=
start_ticks() {
  local stat
  local -a fields
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && [[ -r "/proc/$1/stat" ]] || return 1
  IFS= read -r stat < "/proc/$1/stat" || return 1
  # comm can contain spaces and closing parentheses; fields after its last ')' are fixed.
  read -r -a fields <<< "${stat##*) }"
  [[ "${fields[0]:-Z}" != Z && "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${fields[19]}"
}
owned_chrome() {
  [[ -n "$chrome_ticks" && "$(start_ticks "$chrome_pid")" == "$chrome_ticks" ]] &&
    grep -Fzxq -- "--user-data-dir=$state/chrome" "/proc/$chrome_pid/cmdline" &&
    grep -Fzxq -- '--remote-debugging-port=9222' "/proc/$chrome_pid/cmdline" &&
    [[ "$(start_ticks "$chrome_pid")" == "$chrome_ticks" ]]
}
debug_sockets() {
  awk '$2 ~ /:2406$/ && $4 == "0A" {print $10}' /proc/net/tcp /proc/net/tcp6
}
check_debug_owner() {
  local sockets inode fd found
  sockets=$(debug_sockets) || fail 'Cannot inspect the debugging listener.'
  for inode in $sockets; do
    owned_chrome || fail 'Port 9222 is not owned by this desktop.'
    found=false
    for fd in /proc/"$chrome_pid"/fd/*; do
      if [[ "$(readlink "$fd" 2>/dev/null)" == "socket:[$inode]" ]]; then found=true; break; fi
    done
    "$found" || fail 'Port 9222 is not owned by this desktop.'
  done
}
chrome_ready() {
  owned_chrome && [[ -n "$(debug_sockets)" ]] &&
    curl --max-time 1 -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1
}
if [[ -f "$state/chrome-owner" ]]; then
  read -r chrome_pid chrome_ticks chrome_port extra < "$state/chrome-owner" || fail 'Invalid Chrome ownership record.'
  [[ "$chrome_pid" =~ ^[1-9][0-9]*$ && "$chrome_pid" != 1 && "$chrome_ticks" =~ ^[0-9]+$ && "$chrome_port" =~ ^[0-9]+$ && -z "$extra" ]] || fail 'Invalid Chrome ownership record.'
  if start_ticks "$chrome_pid" >/dev/null; then
    owned_chrome || fail 'Chrome process identity changed; refusing to signal it.'
  fi
fi
check_debug_owner
if curl --max-time 1 -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  chrome_ready || fail 'Port 9222 is not owned by this desktop.'
fi

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
if [[ "$chrome_port" != "$port" ]] || ! chrome_ready; then
  if owned_chrome; then
    # Recheck identity immediately before signalling only the browser we launched.
    owned_chrome && kill -TERM "$chrome_pid"
    for attempt in {1..100}; do
      [[ "$(start_ticks "$chrome_pid")" != "$chrome_ticks" ]] && break
      sleep .1
    done
    [[ "$(start_ticks "$chrome_pid")" != "$chrome_ticks" ]] || fail 'Owned Chrome did not stop.'
  fi
  chrome_pid= chrome_ticks=
  check_debug_owner
  policy_json > "$policy"
  # Only this parent holds the pipe writer. EOF aborts an unpublished launch even on SIGKILL.
  # Exec keeps the waiting child's PID/start ticks as the browser's recorded identity.
  exec 8> >(
    exec >"$state/chrome.log" 2>&1 9>&-
    IFS= read -r launch && [[ "$launch" == GO ]] || exit 1
    exec google-chrome-stable --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --password-store=basic --disable-sync --disable-breakpad --window-size=1024,768 --start-maximized --user-data-dir="$state/chrome" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "http://localhost:$port" </dev/null
  )
  chrome_pid=$!
  for attempt in {1..100}; do
    chrome_ticks=$(start_ticks "$chrome_pid" 8>&-) && break
    sleep .1 8>&-
  done
  [[ -n "$chrome_ticks" ]] || fail 'Cannot identify launched Chrome.'
  chrome_port=$port
  printf '%s %s %s\n' "$chrome_pid" "$chrome_ticks" "$chrome_port" > "$state/chrome-owner.tmp"
  mv "$state/chrome-owner.tmp" "$state/chrome-owner" 8>&-
  printf 'GO\n' >&8
  exec 8>&-
fi
for attempt in {1..150}; do
  check_debug_owner
  chrome_ready && break
  sleep .1
done
check_debug_owner
chrome_ready || fail 'Owned Chrome is not ready.'
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
check_debug_owner
chrome_ready || fail 'Owned Chrome is not ready.'
printf '{"width":1024,"height":768}\n'
