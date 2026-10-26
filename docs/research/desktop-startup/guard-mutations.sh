#!/bin/bash
# Run from a quiet checkout: mutations are sequential and restored even after a failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 - <<'PY'
from pathlib import Path
import subprocess
import tempfile

path = Path("packages/sandbox/desktop/start-desktop.sh")
original = path.read_text()
branch = 'if [[ "$chrome_port" != "$port" ]] || ! chrome_ready; then'
identity = '"$(start_ticks "$chrome_pid")" == "$chrome_ticks"'
profile = 'grep -Fzxq -- "--user-data-dir=$state/chrome" "/proc/$chrome_pid/cmdline" &&'
socket = '"$found" || fail \'The browser debugger socket is not owned by this desktop.\''
pipe = 'grep -Fzxq -- \'--remote-debugging-pipe\' "/proc/$chrome_pid/cmdline" &&'
bridge = 'grep -Fzxq -- \'--cdp-bridge\' "/proc/$chrome_pid/cmdline" &&'
bridge_socket = 'grep -Fzxq -- "$cdp_socket" "/proc/$chrome_pid/cmdline" &&'
listener = '$4 == "00010000" && '
exact_path = ' && $8 == ENVIRON["CDP_SOCKET"]'
answered = 'if cdp_probe; then'
launch = 'exec node "$driver" --cdp-bridge "$cdp_socket" -- google-chrome-stable '
for anchor in (socket, pipe, bridge, bridge_socket, listener, exact_path, answered, launch):
    assert original.count(anchor) == 1, anchor
ready = "chrome_ready || fail 'Owned Chrome is not ready.'"
last_ready = original.rfind(ready)
assert last_ready >= 0
barrier = 'IFS= read -r launch && [[ "$launch" == GO ]] || exit 1'
publish = 'mv "$state/chrome-owner.tmp" "$state/chrome-owner" 8>&-\n  printf \'GO\\n\' >&8'
assert barrier in original and publish in original
mutations = [
    ("ignore changed port", original.replace(branch, 'if ! chrome_ready; then'), "preserves a healthy same-port browser"),
    ("restart every batch", original.replace(branch, 'if true; then'), "preserves a healthy same-port browser"),
    ("ignore start ticks", original.replace(identity, '1 == 1'), "fails closed for wrong ticks"),
    ("ignore profile", original.replace(profile, 'true &&'), "fails closed for wrong profile"),
    ("trust foreign socket", original.replace(socket, 'true'), "fails closed for different listener"),
    ("skip startup lock", original.replace('flock -w 45 9', ':'), "does no desktop work if the startup lock"),
    ("trust browser health", original.replace('chrome_ready() {', 'chrome_ready() { return 0;'), "never accepts an unready browser"),
    ("skip final readiness", original[:last_ready] + ':' + original[last_ready + len(ready):], "checks browser readiness again"),
    ("allow localhost subdomains", original.replace('http://.localhost:%s', 'http://localhost:%s'), "can print exact loopback policy"),
    ("skip port validation", original.replace('[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || exit 2', ':'), "rejects invalid port"),
    ("launch without waiting", original.replace(barrier, ':'), "does not launch a browser before ownership"),
    ("ignore launch pipe EOF", original.replace(barrier, 'IFS= read -r launch || :'), "does not launch a browser before ownership"),
    ("release browser before rename", original.replace(publish, 'printf \'GO\\n\' >&8\n  mv "$state/chrome-owner.tmp" "$state/chrome-owner" 8>&-'), "does not launch a browser before ownership"),
    ("lose browser PID at exec", original.replace(launch, launch[len('exec '):]), "preserves a healthy same-port browser"),
    ("ignore debugging pipe identity", original.replace(pipe, ''), "fails closed for no debugging pipe"),
    ("ignore bridge identity", original.replace(bridge, ''), "fails closed for no bridge"),
    ("ignore bridge socket identity", original.replace(bridge_socket, ''), "fails closed for other bridge socket"),
    ("count non-listening sockets", original.replace(listener, ''), "ignores sockets that are not a listener"),
    ("count sockets at any path", original.replace(exact_path, ''), "ignores sockets that are not a listener"),
    ("trust an answer from an unplaced listener", original.replace(answered, 'if false; then'), "refuses a browser answering through the debugger path"),
    ("launch with a debugging port", original.replace('--remote-debugging-pipe "http', '--remote-debugging-pipe --remote-debugging-port=9222 "http'), "runs the browser behind the bridge"),
    ("launch without the bridge", original.replace(launch, 'exec google-chrome-stable '), "runs the browser behind the bridge"),
]
try:
    with tempfile.TemporaryDirectory(prefix="nap-startup-mutations-") as logs:
        for index, (name, mutated, test) in enumerate(mutations):
            assert mutated != original, name
            path.write_text(mutated)
            result = subprocess.run([
                "bunx", "vitest", "run", "--project", "unit",
                "packages/sandbox/src/desktop-start.test.ts", "-t", test,
            ], capture_output=True, text=True, timeout=90)
            output = result.stdout + result.stderr
            Path(logs, str(index) + ".log").write_text(output)
            path.write_text(original)
            if result.returncode != 1 or "AssertionError" not in output:
                raise RuntimeError(name + " did not produce the expected assertion failure:\n" + output)
            print(name + "\tobserved assertion failure", flush=True)
finally:
    path.write_text(original)
PY
