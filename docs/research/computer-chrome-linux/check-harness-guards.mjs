import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "nap-smoke-guards-")));
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "nap-smoke-guard-stubs-"));
const report = { dockerIsStubbed: true, actualDockerCalls: 0 };
report.ffmpegVersion = execFileSync("ffmpeg", ["-version"], {
  encoding: "utf8",
  timeout: 10000,
}).split("\n")[0];
const execute = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 4_000_000, ...options });
try {
  const capture = join(root, "docs/research/computer-chrome-linux/positive/capture.mp4");
  const original = readFileSync(capture);
  const packets = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_packets",
        "-show_entries",
        "packet=pts_time,pos,size",
        "-of",
        "json",
        capture,
      ],
      { encoding: "utf8", timeout: 10000 },
    ),
  ).packets;
  const packet = packets.find((packet) => Number(packet.pts_time) === 30);
  assert(packet);
  const damaged = Buffer.from(original);
  damaged.fill(0, Number(packet.pos), Number(packet.pos) + Number(packet.size));
  const corrupt = join(temporary, "corrupt.mp4");
  writeFileSync(corrupt, damaged);
  const metadata = (path) =>
    JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,width,height,nb_frames",
          "-show_entries",
          "format=duration,size",
          "-of",
          "json",
          path,
        ],
        { encoding: "utf8", timeout: 10000 },
      ),
    );
  assert.deepEqual(metadata(corrupt), metadata(capture));
  const old = execute("ffmpeg", ["-v", "error", "-i", corrupt, "-f", "null", "-"]);
  assert.equal(old.status, 0, "The old guard must demonstrate its false pass.");
  assert.match(old.stderr, /invalid|error/i);
  const strict = execute("ffmpeg", [
    "-v",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    corrupt,
    "-f",
    "null",
    "-",
  ]);
  assert.notEqual(strict.status, 0);
  const clean = execute("ffmpeg", [
    "-v",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    capture,
    "-f",
    "null",
    "-",
  ]);
  assert.equal(clean.status, 0);
  assert.equal(clean.stderr, "");
  writeFileSync(join(output, "decoder-old-false-pass.txt"), old.stderr);
  writeFileSync(join(output, "decoder-strict-rejection.txt"), strict.stderr);
  report.decoder = {
    packetTimeSeconds: 30,
    offset: Number(packet.pos),
    damagedBytes: Number(packet.size),
    metadataUnchanged: true,
    oldExit: old.status,
    strictExit: strict.status,
    cleanStrictExit: clean.status,
  };
  const cleanup = readFileSync(
    new URL("./guard-repairs/old-cleanup.js.txt", import.meta.url),
    "utf8",
  );
  const oldCalls = [];
  runInNewContext(
    `${cleanup};cleanup();`,
    {
      name: "owned-fixture",
      image: "owned-fixture:local",
      context: "owned-temp-fixture",
      run: (...args) => {
        oldCalls.push(args);
        throw new Error("Simulated Docker unavailable.");
      },
      rmSync: () => {},
    },
    { timeout: 1000 },
  );
  assert.equal(oldCalls.length, 2);
  report.oldCleanup = { returnedNormallyDespiteBothRemovalFailures: true, calls: oldCalls };
  const stub = join(temporary, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const mode=process.env.NAP_GUARD_MODE;const path=process.env.NAP_GUARD_STATE;const state=fs.existsSync(path)?JSON.parse(fs.readFileSync(path)):{calls:[],counts:{}};state.calls.push(args);
const save=()=>fs.writeFileSync(path,JSON.stringify(state));const end=(status=0,text='')=>{save();(status?process.stderr:process.stdout).write(text);process.exit(status);};
if(args[0]==='build')end();
if(args[0]==='image'&&args[1]==='inspect')end(0,JSON.stringify([{Id:'stub-only',RepoTags:[args[2]]}]));
if(args[0]==='run')end(mode==='both'?19:0,mode==='both'?'simulated smoke failure':'');
if(args[0]==='cp')end();if(args[0]==='inspect')end(0,'[]');
const removal=args[0]==='rm'||(args[0]==='image'&&args[1]==='rm');
const listing=(args[0]==='container'||args[0]==='image')&&args[1]==='ls';
const kind=args[0]==='image'?'image':'container';
if(removal){state.counts[kind]=(state.counts[kind]??0)+1;if(mode==='absent')end(1,'No such owned resource');if(mode==='transient'&&state.counts[kind]>=2)end();end(1,'simulated Docker removal unavailable');}
if(listing){if(mode==='absent'||(mode==='transient'&&state.counts[kind]>=2))end();if(mode==='transient')end(0,'owned-stub-id');end(1,'simulated Docker verification unavailable');}
end(2,'unexpected stub command');`,
  );
  chmodSync(stub, 0o755);
  report.cleanupCases = [];
  for (const mode of ["permanent", "absent", "transient", "both"]) {
    const directory = join(output, `cleanup-${mode}`);
    const state = join(temporary, `${mode}.json`);
    const result = execute(
      "bun",
      [join(root, "packages/sandbox/scripts/desktop-chrome-smoke/run.ts"), directory],
      {
        cwd: root,
        timeout: 60000,
        env: {
          ...process.env,
          PATH: `${temporary}:${process.env.PATH}`,
          NAP_GUARD_MODE: mode,
          NAP_GUARD_STATE: state,
        },
      },
    );
    const cleanup = JSON.parse(readFileSync(join(directory, "cleanup.json")));
    const expectedSuccess = ["absent", "transient"].includes(mode);
    assert.equal(
      result.status === 0,
      expectedSuccess,
      `Cleanup case ${mode} had an unexpected exit status.`,
    );
    assert.equal(cleanup.ok, expectedSuccess);
    assert(cleanup.attempts.some((attempt) => attempt.resource.endsWith(":local")));
    assert(cleanup.attempts.some((attempt) => !attempt.resource.endsWith(":local")));
    if (mode === "permanent" || mode === "both") assert.equal(cleanup.attempts.length, 4);
    if (mode === "transient") assert.equal(cleanup.attempts.length, 4);
    if (mode === "both") {
      assert.match(result.stderr, /Could not verify removal of owned Docker resource/);
      assert.match(result.stderr, /Docker smoke failed/);
    }
    writeFileSync(join(directory, "runner-result.txt"), result.stdout + result.stderr);
    report.cleanupCases.push({
      mode,
      exit: result.status,
      cleanupOk: cleanup.ok,
      attempts: cleanup.attempts.length,
    });
  }
  report.ok = true;
  console.log(
    "PASS: corrupt-but-probeable MP4 rejected strictly; actual CLI fails permanent cleanup and preserves combined errors, accepts absent resources and retries transient failures. Docker stub only.",
  );
} finally {
  writeFileSync(join(output, "guard-report.json"), JSON.stringify(report, null, 2));
  rmSync(temporary, { recursive: true, force: true });
}
