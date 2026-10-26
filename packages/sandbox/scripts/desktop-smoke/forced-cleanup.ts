// Reproduce an unresponsive watchdog while the X11 source is stalled.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";
import { DesktopReplySchema } from "../../src/desktop-protocol.ts";

const xvfb = z.coerce.number().int().min(2).parse(process.argv[2]);
const recordingId = "65956985-30b9-49ba-a719-6fc9a3d46ef6";
const path = `/home/user/.nap-desktop/recordings/${recordingId}`;
let monitor: number | undefined;
let encoder: number | undefined;
const fields = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ");
  } catch {
    return undefined;
  }
};
const running = (pid: number) => {
  const state = fields(pid)?.[0];
  return state !== undefined && state !== "Z" && state !== "X";
};
function request(op: string) {
  const data = Buffer.from(JSON.stringify({ id: randomUUID(), op, recordingId })).toString(
    "base64",
  );
  try {
    return DesktopReplySchema.parse(
      JSON.parse(
        execFileSync("node", ["/usr/local/lib/nap-desktop/driver.mjs", data], {
          encoding: "utf8",
          timeout: 20000,
        }),
      ),
    );
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error)
      return DesktopReplySchema.parse(JSON.parse(String(error.stdout)));
    throw error;
  }
}
try {
  assert.equal(request("recording_begin").ok, true);
  const recordedPid = z
    .object({ pid: z.int().positive(), startTicks: z.string() })
    .parse(JSON.parse(readFileSync(`${path}/process.json`, "utf8"))).pid;
  if (readFileSync(`/proc/${recordedPid}/comm`, "utf8").trim() === "timeout") {
    monitor = recordedPid;
    encoder = Number(readFileSync(`/proc/${monitor}/task/${monitor}/children`, "utf8").trim());
  } else {
    encoder = recordedPid;
    monitor = Number(fields(encoder)?.[1]);
  }
  assert.ok(monitor && encoder && monitor > 1 && encoder > 1 && xvfb > 1);
  process.kill(xvfb, "SIGSTOP");
  process.kill(monitor, "SIGSTOP");
  assert.equal(request("recording_finish").ok, false);
  assert.equal(running(encoder), false, "Forced cleanup left the encoder alive.");
  assert.equal(request("recording_discard").ok, true);
  assert.equal(existsSync(path), false);
  const report = { forcedCleanupNoEncoder: true, discardAfterDrain: true };
  writeFileSync("/tmp/forced-report.json", JSON.stringify(report));
  console.log(JSON.stringify(report));
} finally {
  for (const pid of [xvfb, monitor])
    if (pid) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {}
    }
  for (const pid of [encoder, monitor])
    if (pid && running(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
}
