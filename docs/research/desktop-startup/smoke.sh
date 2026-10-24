#!/bin/bash
# Run only inside a disposable container. See README.md for the free invocation.
set -euo pipefail
[[ -f /.dockerenv && "$(id -u)" == 0 && "${NAP_DESKTOP_START_SMOKE:-}" == 1 ]] || exit 2
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
curl() {
  if [[ "${FAULT_MODE:-}" == 'killed after launch' && "$*" == *9222* && -f "$state/chrome-owner" ]] && command curl "$@" >/dev/null 2>&1; then
    save_identity
    builtin kill -KILL "$$"
  fi
  command curl "$@"
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
import fs from 'node:fs';
import http from 'node:http';
let state = '';
const launch = {
  pid: process.pid,
  args: process.argv.slice(2),
  policy: JSON.parse(fs.readFileSync('/etc/opt/chrome/policies/managed/nap.json', 'utf8')),
};
fs.appendFileSync(process.env.fixture + '/launches', JSON.stringify(launch) + '\n');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.searchParams.has('set')) state = url.searchParams.get('set');
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({...launch, state}));
});
server.listen(9222, '127.0.0.1');
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.fixture + '/stops', String(process.pid) + '\n');
  // Keep the listener alive briefly: startup must wait before replacing policy/browser.
  setTimeout(() => server.close(() => process.exit(0)), 200);
});
JS
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {execFile, spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const startScript = process.env.NAP_DESKTOP_START_SCRIPT ?? '/repo/packages/sandbox/desktop/start-desktop.sh';
const state = '/home/user/.nap-desktop';
const record = state + '/chrome-owner';
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
    const listener = await fetch('http://127.0.0.1:9222/json/version').then(response => response.json()).catch(() => null);
    console.error(JSON.stringify({survivingChild: pid, listener}));
  }
  assert.equal(runningIdentity(pid, ticks), false, 'child must exit, including after parent SIGKILL');
};
const info = async (path = '/json/version') => (await fetch('http://127.0.0.1:9222' + path)).json();
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
    await assert.rejects(fetch('http://127.0.0.1:9222/json/version'));
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
  const first = await info('/state?set=typed-form-and-scroll');
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

  vncReady = false;
  await fails('4321', 22);
  vncReady = true;
  await start('4321');
  assert.equal((await info()).pid, second.pid);
  assert.equal(launches().length, priorLaunches + 2);
  assert.equal(spawnSync('flock', ['-n', state + '/start.lock', 'true']).status, 0);
  assert.ok(unrelated.exitCode === null);
  console.log(JSON.stringify({passed: true, actualChrome: false, browserLaunches: launches().length,
    faults, noBrowserBeforeOwnershipCommit: true, pipeEofExitsWaitingChild: true,
    publicationFailureRetried: true, durableOwnershipDeathRetried: true,
    samePortStatePreserved: true, changedPortRestarted: true, unknownEndpointRejected: true,
    ticksMismatchRejected: true, lockReleasedAndSerialized: true, vncFailureRetried: true,
    xvfbReused: true, unrelatedProcessPreserved: true}, null, 2));
} finally {
  unrelated.kill();
  vnc.close();
}
JS
