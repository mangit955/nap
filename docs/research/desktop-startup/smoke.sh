#!/bin/bash
# Run only inside a disposable container. See README.md for the free invocation.
set -euo pipefail
[[ -f /.dockerenv && "$(id -u)" == 0 && "${NAP_DESKTOP_START_SMOKE:-}" == 1 ]] || exit 2
# The real bridge: the freshly bundled driver, mounted where the image installs it.
[[ -f /usr/local/lib/nap-desktop/driver.mjs ]] || exit 2
export fixture=$(mktemp -d /tmp/nap-startup.XXXXXX)
mkdir -p "$fixture/bin" /home/user/.nap-desktop/chrome /etc/opt/chrome/policies/managed
printf 'fixture-password\n' > /home/user/.nap-desktop/password
printf 'keep profile\n' > /home/user/.nap-desktop/chrome/keep
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/pgrep" <<'SH'
#!/bin/bash
# This image has neither openbox nor VNC; simulate their reuse only.
exit 0
SH
cat > "$fixture/bin/google-chrome-stable" <<'SH'
#!/bin/bash
exec node "$fixture/browser.mjs" "$@"
SH
cat > "$fixture/bin/curl" <<'SH'
#!/bin/bash
exec node "$fixture/curl.mjs" "$@"
SH
chmod +x "$fixture/bin/"*
cat > "$fixture/fault.sh" <<'SH'
# Inject faults at the real shell's ownership publication and readiness boundaries.
save_identity() { builtin printf '%s %s\n' "$chrome_pid" "$chrome_ticks" > "$fixture/fault-identity"; }
printf() {
  if [[ "${FAULT_MODE:-}" == 'write failure' && "${1:-}" == '%s %s %s\n' ]]; then
    save_identity
    return 1
  fi
  builtin printf "$@"
}
mv() {
  save_identity
  case "${FAULT_MODE:-}" in
    'killed before rename') builtin kill -KILL "$$" ;;
    'killed after rename') command mv "$@"; builtin kill -KILL "$$" ;;
    'rename failure') return 1 ;;
    *) command mv "$@" ;;
  esac
}
node() {
  if [[ "${FAULT_MODE:-}" == 'killed after launch' && "${2:-}" == --cdp-probe && -f "$state/chrome-owner" ]] && command node "$@" >/dev/null 2>&1; then
    save_identity
    builtin kill -KILL "$$"
  fi
  command node "$@"
}
SH
cat > "$fixture/curl.mjs" <<'JS'
import http from 'node:http';
const request = http.get(process.argv.at(-1), response => {
  if (response.statusCode < 200 || response.statusCode >= 300) process.exit(22);
  response.pipe(process.stdout);
});
request.setTimeout(1000, () => request.destroy());
request.on('error', () => process.exit(7));
JS
cat > "$fixture/browser.mjs" <<'JS'
// Speaks Chrome's pipe contract: NUL-terminated JSON in on descriptor 3, out on 4.
import fs from 'node:fs';
import net from 'node:net';
let state = '';
// The recorded identity is the bridge's: this stand-in runs as its child.
const launch = {
  pid: process.ppid,
  browserPid: process.pid,
  args: process.argv.slice(2),
  policy: JSON.parse(fs.readFileSync('/etc/opt/chrome/policies/managed/nap.json', 'utf8')),
};
fs.appendFileSync(process.env.fixture + '/launches', JSON.stringify(launch) + '\n');
const input = new net.Socket({fd: 3, readable: true, writable: false});
const output = new net.Socket({fd: 4, readable: false, writable: true});
let buffer = '';
input.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(end + 1)) {
    const {id, method, params = {}} = JSON.parse(buffer.slice(0, end));
    if (method === 'Fixture.setState') state = params.state;
    const result = method === 'Browser.getVersion' ? {product: 'Stand-in/1'} : {...launch, state};
    output.write(JSON.stringify({id, result}) + '\0');
  }
});
// Chrome exits when its command pipe closes, so a bridge's death takes its browser with it.
input.on('end', () => process.exit(0));
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.fixture + '/stops', String(process.ppid) + '\n');
  // Exit late: startup must wait for the bridge, which waits for its browser.
  setTimeout(() => process.exit(0), 200);
});
JS
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {execFile, spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const startScript = process.env.NAP_DESKTOP_START_SCRIPT ?? '/repo/packages/sandbox/desktop/start-desktop.sh';
const state = '/home/user/.nap-desktop';
const record = state + '/chrome-owner';
const socketPath = state + '/cdp.sock';
// One request through the bridge's socket, as any desktop client makes it.
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const connection = net.createConnection(socketPath);
  let buffer = '';
  const timer = setTimeout(() => { connection.destroy(); reject(new Error('timed out')); }, 2000);
  connection.on('connect', () => connection.write(JSON.stringify({id: 1, method, params}) + '\0'));
  connection.on('data', chunk => {
    buffer += chunk;
    const end = buffer.indexOf('\0');
    if (end < 0) return;
    clearTimeout(timer);
    connection.destroy();
    resolve(JSON.parse(buffer.slice(0, end)).result);
  });
  connection.on('error', error => { clearTimeout(timer); reject(error); });
});
const debuggerTcpListeners = () => ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(path =>
  fs.readFileSync(path, 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(row => row[1]?.endsWith(':2406') && row[3] === '0A'));
const policy = '/etc/opt/chrome/policies/managed/nap.json';
let vncReady = true;
const vnc = http.createServer((_request, response) => {
  response.statusCode = vncReady ? 200 : 503;
  response.end('VNC fixture');
});
vnc.listen(6080, '127.0.0.1');
await once(vnc, 'listening');
const unrelated = spawn('sleep', ['300']);
const launches = () => fs.existsSync(process.env.fixture + '/launches')
  ? fs.readFileSync(process.env.fixture + '/launches', 'utf8').trim().split('\n').map(JSON.parse) : [];
const runningIdentity = (pid, ticks) => {
  try {
    const fields = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').replace(/^.*\) /, '').split(' ');
    return fields[0] !== 'Z' && fields[19] === ticks;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const stopped = async (pid, ticks) => {
  for (let attempt = 0; attempt < 100 && runningIdentity(pid, ticks); attempt++)
    await new Promise(resolve => setTimeout(resolve, 20));
  if (runningIdentity(pid, ticks)) {
    const listener = await cdp('Fixture.info').catch(() => null);
    console.error(JSON.stringify({survivingChild: pid, listener}));
  }
  assert.equal(runningIdentity(pid, ticks), false, 'child must exit, including after parent SIGKILL');
};
const info = async (set) => cdp(set === undefined ? 'Fixture.info' : 'Fixture.setState', {state: set});
const start = async (port = '5173') => {
  const result = await exec('bash', [startScript, port], {timeout: 25000});
  assert.deepEqual(JSON.parse(result.stdout), {width: 1024, height: 768});
};
const fails = async (port = '5173', code = 1) => {
  await assert.rejects(exec('bash', [startScript, port], {timeout: 25000}), error => {
    assert.equal(error.code, code);
    assert.equal(error.stdout, '');
    return true;
  });
};
try {
  const faults = ['killed before rename', 'killed after rename', 'rename failure', 'write failure'];
  for (const mode of faults) {
    const before = launches().length;
    await assert.rejects(exec('bash', [startScript, '5173'], {
      timeout: 25000,
      env: {...process.env, BASH_ENV: process.env.fixture + '/fault.sh', FAULT_MODE: mode},
    }), error => {
      if (mode.startsWith('killed')) assert.equal(error.signal, 'SIGKILL');
      else assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      return true;
    });
    const [pid, ticks] = fs.readFileSync(process.env.fixture + '/fault-identity', 'utf8').trim().split(' ');
    await stopped(pid, ticks);
    assert.equal(launches().length, before, mode + ' must not exec the browser');
    await assert.rejects(cdp('Fixture.info'));
    assert.equal(fs.existsSync(record), mode === 'killed after rename');
    assert.equal(spawnSync('flock', ['-n', state + '/start.lock', 'true']).status, 0);
    await start();
    const recovered = await info();
    const owner = fs.readFileSync(record, 'utf8').trim().split(' ');
    assert.equal(String(recovered.pid), owner[0]);
    await start();
    assert.equal(launches().length, before + 1);
    process.kill(recovered.pid, 'SIGTERM');
    await stopped(owner[0], owner[1]);
    fs.unlinkSync(record);
  }

  const beforeDeath = launches().length;
  await assert.rejects(exec('bash', [startScript, '5173'], {
    timeout: 25000,
    env: {...process.env, BASH_ENV: process.env.fixture + '/fault.sh', FAULT_MODE: 'killed after launch'},
  }), error => error.signal === 'SIGKILL' && error.stdout === '');
  const surviving = await info();
  const survivorOwner = fs.readFileSync(record, 'utf8').trim().split(' ');
  assert.equal(String(surviving.pid), survivorOwner[0]);
  assert.ok(runningIdentity(survivorOwner[0], survivorOwner[1]));
  await start();
  assert.equal((await info()).pid, surviving.pid);
  assert.equal(launches().length, beforeDeath + 1);
  await start('4321');
  assert.notEqual((await info()).pid, surviving.pid);
  const replacementOwner = fs.readFileSync(record, 'utf8').trim().split(' ');
  process.kill(Number(replacementOwner[0]), 'SIGTERM');
  await stopped(replacementOwner[0], replacementOwner[1]);
  fs.unlinkSync(record);
  fs.unlinkSync(process.env.fixture + '/stops');
  const priorLaunches = launches().length;

  await start();
  const first = await info('typed-form-and-scroll');
  assert.equal((fs.statSync(socketPath).mode & 0o777).toString(8), '600');
  assert.ok(fs.statSync(socketPath).isSocket());
  assert.deepEqual(debuggerTcpListeners(), []);
  assert.ok(first.args.includes('--remote-debugging-pipe'));
  assert.ok(!first.args.some(arg => arg.startsWith('--remote-debugging-port')));
  const xvfb = fs.readFileSync('/tmp/.X99-lock', 'utf8');
  await start();
  assert.equal((await info()).pid, first.pid);
  assert.equal((await info()).state, 'typed-form-and-scroll');
  assert.equal(launches().length, priorLaunches + 1);
  assert.equal(spawnSync('flock', ['-n', state + '/start.lock', 'true']).status, 0);

  const holder = spawn('flock', ['-x', state + '/start.lock', 'sh', '-c', 'echo held; sleep 1']);
  await once(holder.stdout, 'data');
  const began = Date.now();
  await start();
  assert.ok(Date.now() - began >= 800);

  await start('4321');
  const second = await info();
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second.policy.URLAllowlist, ['http://.localhost:4321', 'http://127.0.0.1:4321']);
  assert.ok(second.args.includes('http://localhost:4321'));
  assert.equal(fs.readFileSync(process.env.fixture + '/stops', 'utf8').trim(), String(first.pid));
  assert.equal(fs.readFileSync('/tmp/.X99-lock', 'utf8'), xvfb);
  assert.equal(fs.readFileSync(state + '/chrome/keep', 'utf8'), 'keep profile\n');
  assert.ok(unrelated.exitCode === null);

  await Promise.all([start('4321'), start('4321')]);
  assert.equal(launches().length, priorLaunches + 2);
  assert.equal((await info()).pid, second.pid);

  const ownership = fs.readFileSync(record, 'utf8');
  const beforePolicy = fs.readFileSync(policy, 'utf8');
  fs.unlinkSync(record);
  await fails('5173');
  assert.equal((await info()).pid, second.pid);
  assert.equal(fs.readFileSync(policy, 'utf8'), beforePolicy);
  fs.writeFileSync(record, ownership.replace(/^(\d+) \d+ /, '$1 0 '));
  await fails('5173');
  assert.equal((await info()).pid, second.pid);
  fs.writeFileSync(record, ownership);

  // A bridge killed outright takes its browser with it and leaves a stale socket file.
  const killed = fs.readFileSync(record, 'utf8').trim().split(' ');
  process.kill(Number(killed[0]), 'SIGKILL');
  await stopped(killed[0], killed[1]);
  for (let attempt = 0; attempt < 100 && launches().some(entry => {
    try { process.kill(entry.browserPid, 0); return true; } catch { return false; }
  }); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(launches().filter(entry => {
    try { process.kill(entry.browserPid, 0); return true; } catch { return false; }
  }).length, 0, 'no stand-in browser may outlive its bridge');
  assert.ok(fs.statSync(socketPath).isSocket());
  await start('4321');
  const third = await info();
  assert.notEqual(third.pid, second.pid);
  assert.equal(launches().length, priorLaunches + 3);

  vncReady = false;
  await fails('4321', 22);
  vncReady = true;
  await start('4321');
  assert.equal((await info()).pid, third.pid);
  assert.equal(launches().length, priorLaunches + 3);
  assert.equal(spawnSync('flock', ['-n', state + '/start.lock', 'true']).status, 0);
  assert.ok(unrelated.exitCode === null);
  console.log(JSON.stringify({passed: true, actualChrome: false, browserLaunches: launches().length,
    faults, noBrowserBeforeOwnershipCommit: true, pipeEofExitsWaitingChild: true,
    publicationFailureRetried: true, durableOwnershipDeathRetried: true,
    samePortStatePreserved: true, changedPortRestarted: true, unknownEndpointRejected: true,
    ticksMismatchRejected: true, lockReleasedAndSerialized: true, vncFailureRetried: true,
    xvfbReused: true, unrelatedProcessPreserved: true, debuggerTcpListeners: 0,
    debuggerSocketMode: '600', killedBridgeTookBrowser: true, staleSocketReplaced: true}, null, 2));
} finally {
  unrelated.kill();
  vnc.close();
}
JS
