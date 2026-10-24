/** Manual paid transport proof. Dry-run is the default; no provider authentication or inference. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProcessEvent } from "@nap/shared/ports/sandbox-process";
import { Sandbox } from "e2b";
import { z } from "zod";
import { E2BProcessHost } from "../src/e2b-process-host.ts";

if (!process.argv.includes("--real")) {
  console.log(
    JSON.stringify({
      dryRun: true,
      sandboxes: 1,
      maximumLifetimeSeconds: 60,
      checks: [
        "cgroup v2",
        "no-new-privs",
        "sudo refused",
        "cgroup escape refused",
        "detached child termination",
      ],
      requirements:
        "Explicit approval for paid E2B and E2B_API_KEY. No subscription or model call is made.",
    }),
  );
} else {
  if (!process.env.E2B_API_KEY)
    throw new Error("E2B_API_KEY must be configured privately before the approved probe.");
  const artifact = fileURLToPath(new URL("../dist/native-process-host.mjs", import.meta.url));
  const bundle = await readFile(artifact, "utf8");
  const sandbox = await Sandbox.create({ timeoutMs: 60_000 });
  try {
    await sandbox.commands.run("install -d -m 0700 /opt/nap", { user: "root" });
    await sandbox.files.write("/opt/nap/native-process-host.mjs", bundle, { user: "root" });
    await sandbox.commands.run("chmod 0700 /opt/nap/native-process-host.mjs", { user: "root" });
    const node = z
      .string()
      .regex(/^\/[a-zA-Z0-9_./-]+$/)
      .parse((await sandbox.commands.run("command -v node", { user: "root" })).stdout.trim());
    const host = new E2BProcessHost({ executablePath: "/opt/nap/native-process-host.mjs" });
    const events: ProcessEvent[] = [];
    let firstOutput: () => void = () => {};
    const observed = new Promise<void>((resolve) => {
      firstOutput = resolve;
    });
    const program = `
      const fs = require("node:fs"); const cp = require("node:child_process");
      const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      child.unref();
      let escaped = false; try { fs.writeFileSync("/sys/fs/cgroup/cgroup.procs", String(child.pid)); escaped = true; } catch {}
      const sudo = cp.spawnSync("/usr/bin/sudo", ["-n", "true"], { stdio: "ignore" });
      const status = fs.readFileSync("/proc/self/status", "utf8");
      console.log(JSON.stringify({ pid: child.pid, uid: process.getuid(), escaped,
        noNewPrivs: /NoNewPrivs:\\s+1/.test(status), sudoRefused: sudo.status !== 0 }));
      setInterval(() => {}, 1000);
    `;
    const running = await host.start(
      {
        sandboxId: sandbox.sandboxId,
        executable: node,
        args: ["-e", program],
        cwd: "/tmp",
        env: {},
        leaseMs: 10_000,
        maxOutputBytes: 65536,
        maxReplayBytes: 65536,
      },
      async (event) => {
        events.push(event);
        if (event.kind === "output") firstOutput();
      },
    );
    if (!running.ok) throw new Error(`Native host refused to start: ${running.error.code}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        observed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("No containment proof arrived.")), 8000);
        }),
      ]);
      const stdout = Buffer.concat(
        events.flatMap((event) =>
          event.kind === "output" && event.stream === "stdout" ? [Buffer.from(event.data)] : [],
        ),
      ).toString();
      const proof = z
        .strictObject({
          pid: z.int().positive(),
          uid: z.literal(1000),
          escaped: z.literal(false),
          noNewPrivs: z.literal(true),
          sudoRefused: z.literal(true),
        })
        .parse(JSON.parse(stdout.trim()));
      await running.value.stop();
      const stopped = await running.value.closed;
      if (!stopped.ok || stopped.value.containment !== "cgroup")
        throw new Error("Complete process termination was not confirmed.");
      const inspection = await sandbox.commands.run(
        `${node} -e 'try { const s = require("fs").readFileSync("/proc/${proof.pid}/stat", "utf8"); if (!s.split(") ")[1].startsWith("Z")) process.exit(1); } catch (e) { if (e.code !== "ENOENT") throw e; }'`,
        { user: "root" },
      );
      if (inspection.exitCode !== 0) throw new Error("A detached child survived cancellation.");
      console.log(
        JSON.stringify({
          passed: true,
          containment: stopped.value.containment,
          noNewPrivs: proof.noNewPrivs,
          sudoRefused: proof.sudoRefused,
          detachedChildStopped: true,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await sandbox.kill();
  }
}
