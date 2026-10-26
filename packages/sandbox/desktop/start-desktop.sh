#!/bin/bash
set -euo pipefail
port="${1:-5173}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || exit 2
policy_json() {
  printf '{"URLBlocklist":["*","chrome://*","file://*"],"URLAllowlist":["http://.localhost:%s","http://127.0.0.1:%s"],"BrowserSignin":0,"PasswordManagerEnabled":false,"DeveloperToolsAvailability":1}\n' "$port" "$port"
}
if [[ "${2:-}" == "--print-policy" ]]; then policy_json; exit; fi
state=/home/user/.nap-desktop
# The browser has no debugger port. E2B forwards loopback TCP listeners to the sandbox's
# public hosts, so Chrome speaks CDP over a pipe to a bridge whose only endpoint is this
# socket inside the private state directory. See docs/adr/0019.
cdp_socket="$state/cdp.sock"
driver=/usr/local/lib/nap-desktop/driver.mjs
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/start.lock"
flock -w 45 9
# A fresh VM pages programs in from a lazily loaded disk while its CPU is idle, so attempts
# pass quickly there. The browser's waits share one elapsed-time bound instead, and VNC keeps
# its own few seconds after it, all inside the driver's 45-second kill.
ready_by=$((SECONDS + 35))

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
    grep -Fzxq -- '--remote-debugging-pipe' "/proc/$chrome_pid/cmdline" &&
    grep -Fzxq -- '--cdp-bridge' "/proc/$chrome_pid/cmdline" &&
    grep -Fzxq -- "$cdp_socket" "/proc/$chrome_pid/cmdline" &&
    [[ "$(start_ticks "$chrome_pid")" == "$chrome_ticks" ]]
}
# Listening Unix sockets bound to exactly the debugger path. /proc/net/unix columns are
# Num RefCount Protocol Flags Type St Inode Path; flag 00010000 marks a listener.
debug_sockets() {
  CDP_SOCKET="$cdp_socket" awk 'NF == 8 && $4 == "00010000" && $8 == ENVIRON["CDP_SOCKET"] {print $7}' /proc/net/unix
}
check_debug_owner() {
  local sockets inode fd found
  sockets=$(debug_sockets) || fail 'Cannot inspect the browser debugger socket.'
  for inode in $sockets; do
    owned_chrome || fail 'The browser debugger socket is not owned by this desktop.'
    found=false
    for fd in /proc/"$chrome_pid"/fd/*; do
      if [[ "$(readlink "$fd" 2>/dev/null)" == "socket:[$inode]" ]]; then found=true; break; fi
    done
    "$found" || fail 'The browser debugger socket is not owned by this desktop.'
  done
}
cdp_probe() { node "$driver" --cdp-probe "$cdp_socket" >/dev/null 2>&1 8>&- 9>&-; }
chrome_ready() {
  owned_chrome && [[ -n "$(debug_sockets)" ]] && cdp_probe
}
if [[ -f "$state/chrome-owner" ]]; then
  read -r chrome_pid chrome_ticks chrome_port extra < "$state/chrome-owner" || fail 'Invalid Chrome ownership record.'
  [[ "$chrome_pid" =~ ^[1-9][0-9]*$ && "$chrome_pid" != 1 && "$chrome_ticks" =~ ^[0-9]+$ && "$chrome_port" =~ ^[0-9]+$ && -z "$extra" ]] || fail 'Invalid Chrome ownership record.'
  if start_ticks "$chrome_pid" >/dev/null; then
    owned_chrome || fail 'Chrome process identity changed; refusing to signal it.'
  fi
fi
check_debug_owner
if cdp_probe; then
  chrome_ready || fail 'The browser debugger socket is not owned by this desktop.'
fi

export DISPLAY=:99
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >"$state/xvfb.log" 2>&1 9>&- &
  until xdpyinfo >/dev/null 2>&1 9>&- || ((SECONDS >= ready_by)); do sleep .1; done
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
    until [[ "$(start_ticks "$chrome_pid")" != "$chrome_ticks" ]] || ((SECONDS >= ready_by)); do
      sleep .1
    done
    [[ "$(start_ticks "$chrome_pid")" != "$chrome_ticks" ]] || fail 'Owned Chrome did not stop.'
  fi
  chrome_pid= chrome_ticks=
  check_debug_owner
  policy_json > "$policy"
  # Only this parent holds the pipe writer. EOF aborts an unpublished launch even on SIGKILL.
  # Exec keeps the waiting child's PID/start ticks as the recorded identity: the bridge's,
  # which runs the browser as its child and exits only once the browser has.
  # --test-type hides the warning bar --no-sandbox raises, which a real VM showed taking the
  # top of every screenshot, live view and recording. It is a test switch Chrome does not
  # document, and it also drops the other startup bars (API keys, default browser); none of
  # those help an agent. If a Chrome update brings the bar back, the managed policy
  # CommandLineFlagSecurityWarningsEnabled=false is the documented route.
  exec 8> >(
    exec >"$state/chrome.log" 2>&1 9>&-
    IFS= read -r launch && [[ "$launch" == GO ]] || exit 1
    exec node "$driver" --cdp-bridge "$cdp_socket" -- google-chrome-stable --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --password-store=basic --disable-sync --disable-breakpad --window-size=1024,768 --start-maximized --user-data-dir="$state/chrome" --remote-debugging-pipe "http://localhost:$port" </dev/null
  )
  chrome_pid=$!
  until chrome_ticks=$(start_ticks "$chrome_pid" 8>&-) || ((SECONDS >= ready_by)); do
    sleep .1 8>&-
  done
  [[ -n "$chrome_ticks" ]] || fail 'Cannot identify launched Chrome.'
  chrome_port=$port
  printf '%s %s %s\n' "$chrome_pid" "$chrome_ticks" "$chrome_port" > "$state/chrome-owner.tmp"
  mv "$state/chrome-owner.tmp" "$state/chrome-owner" 8>&-
  printf 'GO\n' >&8
  exec 8>&-
fi
until check_debug_owner; chrome_ready || ((SECONDS >= ready_by)); do sleep .1; done
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
vnc_by=$((SECONDS + 5))
until curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 9>&- || ((SECONDS >= vnc_by)); do sleep .1; done
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
check_debug_owner
chrome_ready || fail 'Owned Chrome is not ready.'
printf '{"width":1024,"height":768}\n'
