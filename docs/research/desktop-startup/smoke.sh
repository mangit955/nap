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
const startScript = '/repo/packages/sandbox/desktop/start-desktop.sh';
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
const launches = () => fs.readFileSync(process.env.fixture + '/launches', 'utf8').trim().split('\n').map(JSON.parse);
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
  await start();
  const first = await info('/state?set=typed-form-and-scroll');
  const xvfb = fs.readFileSync('/tmp/.X99-lock', 'utf8');
  await start();
  assert.equal((await info()).pid, first.pid);
  assert.equal((await info()).state, 'typed-form-and-scroll');
  assert.equal(launches().length, 1);
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
  assert.equal(launches().length, 2);
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
  assert.equal(launches().length, 2);
  assert.equal(spawnSync('flock', ['-n', state + '/start.lock', 'true']).status, 0);
  assert.ok(unrelated.exitCode === null);
  console.log(JSON.stringify({passed: true, actualChrome: false, browserLaunches: launches().length,
    samePortStatePreserved: true, changedPortRestarted: true, unknownEndpointRejected: true,
    ticksMismatchRejected: true, lockReleasedAndSerialized: true, vncFailureRetried: true,
    xvfbReused: true, unrelatedProcessPreserved: true}, null, 2));
} finally {
  unrelated.kill();
  vnc.close();
}
JS
