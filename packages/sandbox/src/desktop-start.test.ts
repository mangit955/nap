import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../desktop/start-desktop.sh", import.meta.url)),
  "utf8",
);
const cleanups: (() => void)[] = [];
const UNIX_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path\n";

// Only fixed filesystem roots change. Bash still executes the complete startup script;
// the command fixtures model Linux /proc and services without touching the host desktop.
function fixture(deadline = 5) {
  const root = mkdtempSync(join(tmpdir(), "nap-desktop-start-"));
  const state = join(root, "state");
  const proc = join(root, "proc");
  const bin = join(root, "bin");
  const bashEnv = join(root, "commands.sh");
  writeFileSync(bashEnv, "");
  for (const directory of [state, bin, join(proc, "net")])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(proc, "net/tcp"), "");
  writeFileSync(join(proc, "net/tcp6"), "");
  writeFileSync(join(proc, "net/unix"), UNIX_HEADER);
  writeFileSync(join(state, "password"), "fixture-password");
  const script = join(root, "start.sh");
  const contents = source
    .replaceAll("/home/user/.nap-desktop", state)
    .replaceAll("/etc/opt/chrome/policies/managed/nap.json", join(root, "policy.json"))
    .replaceAll("/proc/", `${proc}/`)
    .replaceAll("SECONDS + 35", `SECONDS + ${deadline}`);
  expect(contents).toContain(`ready_by=$((SECONDS + ${deadline}))`);
  expect(contents).not.toContain("/home/user/");
  expect(contents).not.toContain("/etc/");
  writeFileSync(script, contents);
  function command(name: string, body: string) {
    appendFileSync(bashEnv, `${name}() {\n${body}\n}\n`);
  }
  command("xdpyinfo", "return 0");
  command("pgrep", "return 0");
  command("flock", '[[ ! -f "$FIXTURE/lock-fail" ]]');
  command("sleep", "/bin/sleep .01");
  command("kill", 'echo "$*" >> "$FIXTURE/signals"; builtin kill "$@"');
  // The waiting shell has a Linux identity before it execs the browser. macOS has no /proc.
  writeFileSync(
    join(root, "waiting.cjs"),
    `const fs = require('node:fs');
const root = process.env.FIXTURE;
const pid = process.ppid;
fs.mkdirSync(root + '/proc/' + pid, {recursive: true});
fs.writeFileSync(root + '/proc/' + pid + '/stat', pid + ' (waiting shell) S ' + Array(18).fill('0').join(' ') + ' 12345 0\\n');
fs.writeFileSync(root + '/waiting-pid', String(pid));
`,
  );
  command(
    "read",
    `if [[ "$#" == 2 && "$1" == -r && "$2" == launch ]]; then
  "${process.execPath}" "$FIXTURE/waiting.cjs"
  if builtin read "$@"; then return 0; fi
  rm -rf "$FIXTURE/proc/$(cat "$FIXTURE/waiting-pid")"
  return 1
fi
builtin read "$@"`,
  );
  // The readiness probe is the driver's: one round trip through the bridge's socket.
  command(
    "node",
    `if [[ "\${2:-}" == --cdp-probe ]]; then
  echo "$*" >> "$FIXTURE/probes"
  [[ -f "$FIXTURE/endpoint" ]] || return 1
  [[ ! -f "$FIXTURE/ready-after-probes" ]] ||
    (( $(wc -l < "$FIXTURE/probes") > $(cat "$FIXTURE/ready-after-probes") ))
else
  command node "$@"
fi`,
  );
  command(
    "curl",
    `if [[ -f "$FIXTURE/lose-browser" ]]; then
  touch "$FIXTURE/not-ready"
  rm -f "$FIXTURE/endpoint"
fi
[[ ! -f "$FIXTURE/vnc-fail" ]]`,
  );
  command("websockify", 'echo "$*" >> "$FIXTURE/websockify"');
  // The startup script execs the driver's bridge, which serves the debugger socket and runs
  // the browser as its child. This stand-in is both, under the bridge's PID.
  writeFileSync(
    join(bin, "node"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FIXTURE;
const proc = path.join(root, 'proc', String(process.pid));
fs.mkdirSync(path.join(proc, 'fd'), {recursive: true});
fs.writeFileSync(path.join(proc, 'stat'), process.pid + ' (fixture bridge) S ' + Array(18).fill('0').join(' ') + ' 12345 0\\n');
fs.writeFileSync(path.join(proc, 'cmdline'), ['node', ...process.argv.slice(2)].join('\\0') + '\\0');
fs.symlinkSync('socket:[1234]', path.join(proc, 'fd/5'));
fs.appendFileSync(path.join(root, 'proc/net/unix'), '0000000000000000: 00000002 00000000 00010000 0001 01 1234 ' + process.argv[4] + '\\n');
fs.appendFileSync(path.join(root, 'launches'), JSON.stringify({pid: process.pid, args: process.argv.slice(2), policy: JSON.parse(fs.readFileSync(path.join(root, 'policy.json'), 'utf8'))}) + '\\n');
function ready() { if (!fs.existsSync(path.join(root, 'not-ready'))) fs.writeFileSync(path.join(root, 'endpoint'), String(process.pid)); }
ready();
setInterval(ready, 20);
process.on('SIGTERM', () => {
  fs.appendFileSync(path.join(root, 'stops'), String(process.pid) + '\\n');
  if (fs.existsSync(path.join(root, 'stubborn'))) return;
  fs.rmSync(proc, {recursive: true, force: true});
  fs.rmSync(path.join(root, 'endpoint'), {force: true});
  const unix = path.join(root, 'proc/net/unix');
  fs.writeFileSync(unix, fs.readFileSync(unix, 'utf8').split('\\n').filter((line) => !line.includes(' 1234 ')).join('\\n'));
  process.exit(0);
});
`,
    { mode: 0o755 },
  );
  function launches(): { pid: number; args: string[]; policy: unknown }[] {
    const path = join(root, "launches");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  }
  const result = {
    root,
    state,
    proc,
    command,
    launches,
    run(port = "5173", extra: string[] = []) {
      return spawnSync("bash", [script, port, ...extra], {
        encoding: "utf8",
        timeout: 45_000,
        env: { PATH: `${bin}:${process.env.PATH}`, FIXTURE: root, BASH_ENV: bashEnv },
      });
    },
  };
  cleanups.push(() => {
    const waiting = join(root, "waiting-pid");
    const pids = launches().map((launch) => launch.pid);
    if (existsSync(waiting)) pids.push(Number(readFileSync(waiting, "utf8")));
    for (const pid of new Set(pids)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The fixture browser may already have exited during a restart.
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return result;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("preserves a healthy same-port browser, then restarts it with the changed port policy", () => {
  const item = fixture();
  expect(item.run().status).toBe(0);
  expect(item.run().status).toBe(0);
  expect(item.launches()).toHaveLength(1);
  expect(item.run("4321").status).toBe(0);
  const launches = item.launches();
  expect(launches).toHaveLength(2);
  expect(launches[1]?.args).toContain("http://localhost:4321");
  expect(launches[1]?.policy).toMatchObject({
    URLAllowlist: ["http://.localhost:4321", "http://127.0.0.1:4321"],
  });
  expect(readFileSync(join(item.root, "stops"), "utf8").trim()).toBe(String(launches[0]?.pid));
}, 30_000);

it.each([
  "no record",
  "different listener",
  "wrong ticks",
  "wrong profile",
  "no debugging pipe",
  "no bridge",
  "other bridge socket",
  "invalid record",
])(
  "fails closed for %s without signalling or rewriting policy",
  (mode) => {
    const item = fixture();
    expect(item.run().status).toBe(0);
    const launch = item.launches()[0]!;
    const record = join(item.state, "chrome-owner");
    const policy = readFileSync(join(item.root, "policy.json"), "utf8");
    if (mode === "no record") rmSync(record);
    if (mode === "different listener") {
      rmSync(join(item.proc, String(launch.pid), "fd/5"));
      symlinkSync("socket:[9999]", join(item.proc, String(launch.pid), "fd/5"));
    }
    if (mode === "wrong ticks") writeFileSync(record, `${launch.pid} 99999 5173\n`);
    const cmdline = join(item.proc, String(launch.pid), "cmdline");
    const replace = (from: string, to: string) => {
      const before = readFileSync(cmdline, "utf8");
      expect(before).toContain(`\0${from}\0`);
      writeFileSync(cmdline, before.replace(`\0${from}\0`, `\0${to}\0`));
    };
    if (mode === "wrong profile")
      replace(`--user-data-dir=${item.state}/chrome`, "--user-data-dir=/elsewhere");
    if (mode === "no debugging pipe")
      replace("--remote-debugging-pipe", "--remote-debugging-port=9222");
    if (mode === "no bridge") replace("--cdp-bridge", "--no-bridge");
    if (mode === "other bridge socket") replace(`${item.state}/cdp.sock`, "/tmp/elsewhere.sock");
    if (mode === "invalid record") writeFileSync(record, "1 0 5173 extra\n");
    const retry = item.run("4321");
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain("Desktop startup:");
    expect(item.launches()).toHaveLength(1);
    expect(existsSync(join(item.root, "signals"))).toBe(false);
    expect(existsSync(join(item.root, "stops"))).toBe(false);
    expect(readFileSync(join(item.root, "policy.json"), "utf8")).toBe(policy);
  },
  30_000,
);

it("retries a downstream failure without restarting a healthy browser", () => {
  const item = fixture();
  writeFileSync(join(item.root, "vnc-fail"), "");
  expect(item.run().status).toBe(1);
  expect(item.launches()).toHaveLength(1);
  rmSync(join(item.root, "vnc-fail"));
  expect(item.run().status).toBe(0);
  expect(item.launches()).toHaveLength(1);
}, 30_000);

it.each(["killed before rename", "killed after rename", "rename failure", "write failure"])(
  "does not launch a browser before ownership commits: %s, then recovers on retry",
  async (mode) => {
    const item = fixture();
    if (mode === "write failure") mkdirSync(join(item.state, "chrome-owner.tmp"));
    else
      item.command(
        "mv",
        `if [[ ! -f "$FIXTURE/fault-done" ]]; then
  touch "$FIXTURE/fault-done"
  ${mode === "killed after rename" ? 'command mv "$@"' : ":"}
  ${mode === "rename failure" ? "return 1" : "builtin kill -KILL $$"}
fi
command mv "$@"`,
      );
    const interrupted = item.run();
    if (mode.startsWith("killed")) expect(interrupted.signal).toBe("SIGKILL");
    else expect(interrupted.status).toBe(1);
    expect(item.launches()).toHaveLength(0);
    await expect.poll(() => existsSync(join(item.root, "waiting-pid"))).toBe(true);
    const pid = readFileSync(join(item.root, "waiting-pid"), "utf8");
    await expect
      .poll(() => spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).stdout.trim())
      .toMatch(/^(Z.*)?$/);
    await expect.poll(() => existsSync(join(item.proc, pid, "stat"))).toBe(false);
    expect(item.launches()).toHaveLength(0);
    expect(existsSync(join(item.root, "endpoint"))).toBe(false);
    if (mode !== "killed after rename")
      expect(existsSync(join(item.state, "chrome-owner"))).toBe(false);
    if (mode === "write failure") rmSync(join(item.state, "chrome-owner.tmp"), { recursive: true });
    expect(item.run().status).toBe(0);
    expect(item.run().status).toBe(0);
    expect(item.launches()).toHaveLength(1);
  },
  30_000,
);

it("recovers the owned browser after SIGKILL following ownership commit and launch", () => {
  const item = fixture();
  item.command(
    "node",
    `if [[ -f "$FIXTURE/endpoint" && ! -f "$FIXTURE/fault-done" ]]; then
  touch "$FIXTURE/fault-done"
  builtin kill -KILL $$
fi
[[ -f "$FIXTURE/endpoint" ]]`,
  );
  expect(item.run().signal).toBe("SIGKILL");
  const launch = item.launches()[0]!;
  expect(readFileSync(join(item.state, "chrome-owner"), "utf8")).toBe(`${launch.pid} 12345 5173\n`);
  expect(item.run().status).toBe(0);
  expect(item.launches()).toHaveLength(1);
  expect(item.run("4321").status).toBe(0);
  expect(item.launches()).toHaveLength(2);
  expect(readFileSync(join(item.root, "stops"), "utf8").trim()).toBe(String(launch.pid));
}, 30_000);

it("checks browser readiness again after waiting for VNC", () => {
  const item = fixture();
  writeFileSync(join(item.root, "lose-browser"), "");
  const result = item.run();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it("replaces a dead ownership record when no debugging listener remains", () => {
  const item = fixture();
  writeFileSync(join(item.state, "chrome-owner"), "999999 12345 5173\n");
  expect(item.run("4321").status).toBe(0);
  expect(item.launches()).toHaveLength(1);
  expect(existsSync(join(item.root, "stops"))).toBe(false);
});

it("refuses an unrelated listener on the debugger socket even when it does not answer", () => {
  const item = fixture();
  appendFileSync(
    join(item.proc, "net/unix"),
    `0000000000000000: 00000002 00000000 00010000 0001 01 9999 ${item.state}/cdp.sock\n`,
  );
  const result = item.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("The browser debugger socket is not owned by this desktop.");
  expect(item.launches()).toHaveLength(0);
  expect(existsSync(join(item.root, "policy.json"))).toBe(false);
});

it("refuses a browser answering through the debugger path whose listener it cannot place", () => {
  const item = fixture();
  writeFileSync(join(item.root, "endpoint"), "unknown");
  const result = item.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("not owned");
  expect(item.launches()).toHaveLength(0);
});

it("ignores sockets that are not a listener on exactly the debugger path", () => {
  const item = fixture();
  appendFileSync(
    join(item.proc, "net/unix"),
    [
      `0000000000000000: 00000002 00000000 00010000 0001 01 9997 ${item.state}/cdp.sock.old`,
      `0000000000000000: 00000003 00000000 00000000 0001 03 9998 ${item.state}/cdp.sock`,
      "0000000000000000: 00000002 00000000 00010000 0001 01 9999 /tmp/.X11-unix/X99",
      "",
    ].join("\n"),
  );
  expect(item.run().status).toBe(0);
  expect(item.launches()).toHaveLength(1);
});

// E2B's guest agent opens its own listener beside each loopback TCP service, including the
// old debugging port. The desktop must start beside one, because it no longer has a port.
it("starts beside a listener on TCP port 9222 that no desktop process holds", () => {
  const item = fixture();
  const forwarded = "0: 00000000:2406 00000000:0000 0A 0 0 0 0 0 7777\n";
  writeFileSync(join(item.proc, "net/tcp"), forwarded);
  writeFileSync(join(item.proc, "net/tcp6"), forwarded);
  const result = item.run();
  expect(result.stderr).not.toContain("Desktop startup:");
  expect(result.status).toBe(0);
  expect(item.run().status).toBe(0);
  expect(item.launches()).toHaveLength(1);
});

it("runs the browser behind the bridge with a debugging pipe and no debugging port", () => {
  const item = fixture();
  expect(item.run().status).toBe(0);
  const [launch] = item.launches();
  const socket = `${item.state}/cdp.sock`;
  expect(launch?.args.slice(0, 5)).toEqual([
    "/usr/local/lib/nap-desktop/driver.mjs",
    "--cdp-bridge",
    socket,
    "--",
    "google-chrome-stable",
  ]);
  expect(launch?.args).toContain("--remote-debugging-pipe");
  expect(launch?.args.filter((arg) => /^--remote-debugging-(?:port|address)/.test(arg))).toEqual(
    [],
  );
  const probes = readFileSync(join(item.root, "probes"), "utf8").trim().split("\n");
  expect(new Set(probes)).toEqual(
    new Set([`/usr/local/lib/nap-desktop/driver.mjs --cdp-probe ${socket}`]),
  );
});

it("never accepts an unready browser and can restart that owned process on retry", () => {
  const item = fixture();
  writeFileSync(join(item.root, "not-ready"), "");
  expect(item.run().status).toBe(1);
  expect(item.launches()).toHaveLength(1);
  rmSync(join(item.root, "not-ready"));
  const retry = item.run("4321");
  expect(retry.status).toBe(0);
  expect(item.launches()).toHaveLength(2);
  expect(readFileSync(join(item.root, "policy.json"), "utf8")).toContain("4321");
}, 60_000);

// A fresh cloud VM pages the browser in from a lazily loaded disk: the CPU is idle, so
// waiting attempts pass quickly while the browser is still far from listening. Readiness
// here takes more probes than any fixed count of attempts allowed.
it("waits for a slow browser by elapsed time, however quickly attempts pass", () => {
  const item = fixture(30);
  item.command("sleep", "return 0");
  writeFileSync(join(item.root, "ready-after-probes"), "200");
  const result = item.run();
  expect(result.stderr).not.toContain("Desktop startup:");
  expect(result.status).toBe(0);
  expect(item.launches()).toHaveLength(1);
}, 60_000);

it("refuses to replace an owned browser that does not stop", () => {
  const item = fixture();
  expect(item.run().status).toBe(0);
  writeFileSync(join(item.root, "stubborn"), "");
  const retry = item.run("4321");
  expect(retry.status).toBe(1);
  expect(retry.stderr).toContain("did not stop");
  expect(item.launches()).toHaveLength(1);
  expect(readFileSync(join(item.root, "policy.json"), "utf8")).toContain("5173");
}, 30_000);

it("does no desktop work if the startup lock is unavailable", () => {
  const item = fixture();
  writeFileSync(join(item.root, "lock-fail"), "");
  expect(item.run().status).toBe(1);
  expect(item.launches()).toHaveLength(0);
  expect(existsSync(join(item.root, "policy.json"))).toBe(false);
});

it.each(["0", "65536", "not-a-port", "5173;exit 0"])(
  "rejects invalid port %s before writing",
  (port) => {
    const item = fixture();
    expect(item.run(port).status).toBe(2);
    expect(item.launches()).toHaveLength(0);
    expect(existsSync(join(item.state, "start.lock"))).toBe(false);
  },
);

it("can print exact loopback policy without starting or writing desktop state", () => {
  const item = fixture();
  const result = item.run("4321", ["--print-policy"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    URLBlocklist: ["*", "chrome://*", "file://*"],
    URLAllowlist: ["http://.localhost:4321", "http://127.0.0.1:4321"],
    BrowserSignin: 0,
    PasswordManagerEnabled: false,
    DeveloperToolsAvailability: 1,
  });
  expect(existsSync(join(item.state, "start.lock"))).toBe(false);
  expect(existsSync(join(item.root, "policy.json"))).toBe(false);
});
