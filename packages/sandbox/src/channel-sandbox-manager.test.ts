import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelSandboxManager, WRITE_CHUNK_CHARS } from "./channel-sandbox-manager.ts";
import type { ExecChannel } from "./exec-channel.ts";

const ID = "harbor-task";

/**
 * A channel to this host's own bash, run in a fresh directory.
 *
 * `timeout` is replaced by a function that runs its command and ignores the deadline: a host may
 * not have GNU's, and what a deadline does inside a real Linux machine is the container suite's
 * subject (`channel-sandbox-manager.computer.test.ts`). Everything else is the real shell, so a
 * file that round-trips here round-trips through real `base64`, `printf` and globs.
 */
function hostChannel(cwd: string) {
  const sent: { command: string; timeoutMs: number | undefined }[] = [];
  const channel: ExecChannel = (command, options) => {
    sent.push({ command, timeoutMs: options?.timeoutMs });
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", `timeout() { shift 3; "$@"; }\n${command}`], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      child.on("close", (code) =>
        resolve({ ok: true, value: { exitCode: code ?? 1, stdout, stderr } }),
      );
    });
  };
  return { channel, sent };
}

/** A channel answering every command the same way. */
function cannedChannel(answer: Result<ExecResult, SandboxError>): ExecChannel {
  return async () => answer;
}

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "nap-channel-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manager() {
  const { channel, sent } = hostChannel(dir);
  return { box: new ChannelSandboxManager({ sandboxId: ID, channel }), sent };
}

describe("files, through nothing but a shell", () => {
  it("reads back text exactly, quotes, newlines and all", async () => {
    const { box } = manager();
    const text = 'it\'s "quoted" $(not run) `nor this`\n\tünïcødé ✓\n';
    expect(await box.writeFile(ID, `${dir}/a/b/c.txt`, text)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await box.readFile(ID, `${dir}/a/b/c.txt`)).toEqual({ ok: true, value: text });
  });

  it("reads back every byte value exactly", async () => {
    const { box } = manager();
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await box.writeFileBytes(ID, `${dir}/bytes.bin`, bytes);
    expect(await box.readFileBytes(ID, `${dir}/bytes.bin`)).toEqual({ ok: true, value: bytes });
  });

  it("sends a file too large for one command line in pieces, and keeps it whole", async () => {
    const { box, sent } = manager();
    const text = "0123456789abcdef".repeat((WRITE_CHUNK_CHARS * 2) / 16);
    await box.writeFile(ID, `${dir}/big.txt`, text);
    // Three-quarters of a byte per base64 character, so this is three pieces.
    expect(sent).toHaveLength(3);
    for (const { command } of sent) expect(command.length).toBeLessThan(WRITE_CHUNK_CHARS + 1_000);
    expect(await box.readFile(ID, `${dir}/big.txt`)).toEqual({ ok: true, value: text });
  });

  it("overwrites rather than appending, and writes an empty file", async () => {
    const { box } = manager();
    await box.writeFile(ID, `${dir}/f`, "a longer first version\n");
    await box.writeFile(ID, `${dir}/f`, "short\n");
    expect(await box.readFile(ID, `${dir}/f`)).toEqual({ ok: true, value: "short\n" });
    await box.writeFile(ID, `${dir}/f`, "");
    expect(await box.readFile(ID, `${dir}/f`)).toEqual({ ok: true, value: "" });
  });

  it("reports a missing file, and a directory read as a file, as file_not_found", async () => {
    const { box } = manager();
    expect(await box.readFile(ID, `${dir}/nope`)).toMatchObject({
      ok: false,
      error: { code: "file_not_found" },
    });
    expect(await box.readFileBytes(ID, dir)).toMatchObject({
      ok: false,
      error: { code: "file_not_found" },
    });
  });

  it("lists one level, dotfiles and awkward names included", async () => {
    const { box } = manager();
    await box.writeFile(ID, `${dir}/src/main.py`, "");
    await box.writeFile(ID, `${dir}/.hidden`, "");
    await box.writeFile(ID, `${dir}/with space.txt`, "");
    await box.writeFile(ID, `${dir}/..dots`, "");
    const listed = await box.listFiles(ID, `${dir}/`);
    expect(listed.ok ? [...listed.value].sort((a, b) => a.path.localeCompare(b.path)) : []).toEqual(
      [
        { path: `${dir}/..dots`, type: "file" },
        { path: `${dir}/.hidden`, type: "file" },
        { path: `${dir}/src`, type: "directory" },
        { path: `${dir}/with space.txt`, type: "file" },
      ],
    );
    expect(await box.listFiles(ID, `${dir}/missing`)).toMatchObject({
      ok: false,
      error: { code: "file_not_found" },
    });
  });

  it("lists a whole tree in one command, leaving excluded folders out", async () => {
    const { box, sent } = manager();
    await box.writeFile(ID, `${dir}/src/deep/a.py`, "");
    await box.writeFile(ID, `${dir}/node_modules/x/index.js`, "");
    const before = sent.length;
    const tree = await box.listTree(ID, dir, { exclude: ["node_modules"], timeoutMs: 5_000 });
    expect(sent.length - before).toBe(1);
    expect(tree).toEqual({ ok: true, value: [`${dir}/src/deep/a.py`] });
  });
});

describe("commands", () => {
  it("reports a non-zero exit as data, and hands over stdout then stderr", async () => {
    const { box } = manager();
    const chunks: { stream: string; data: string }[] = [];
    const ran = await box.exec(ID, "echo out; echo err >&2; exit 3", (chunk) => chunks.push(chunk));
    expect(ran).toEqual({ ok: true, value: { exitCode: 3, stdout: "out\n", stderr: "err\n" } });
    expect(chunks).toEqual([
      { stream: "stdout", data: "out\n" },
      { stream: "stderr", data: "err\n" },
    ]);
  });

  it("bounds a command inside the machine, and gives the channel longer than that", async () => {
    const { box, sent } = manager();
    await box.exec(ID, "true", undefined, { timeoutMs: 1_500 });
    expect(sent[0]?.command).toBe("timeout -k 5 2 bash -c 'true'");
    expect(sent[0]?.timeoutMs).toBe(17_000);

    await box.exec(ID, "true");
    expect(sent[1]?.command.startsWith("timeout -k 5 60 ")).toBe(true);
  });

  it("reads timeout's own exit status as a command stopped at its deadline", async () => {
    const box = new ChannelSandboxManager({
      sandboxId: ID,
      channel: cannedChannel({ ok: true, value: { exitCode: 124, stdout: "", stderr: "" } }),
    });
    expect(await box.exec(ID, "sleep 999")).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("passes a channel that cannot reach the machine through as its error", async () => {
    const box = new ChannelSandboxManager({
      sandboxId: ID,
      channel: cannedChannel({ ok: false, error: { code: "unavailable", message: "gone" } }),
    });
    expect(await box.exec(ID, "true")).toEqual({
      ok: false,
      error: { code: "unavailable", message: "gone" },
    });
    expect(await box.readFile(ID, "/x")).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});

describe("one machine, owned by somebody else", () => {
  it("adopts the machine as the sandbox it creates", async () => {
    const { box } = manager();
    expect(await box.create("project")).toEqual({
      ok: true,
      value: { id: ID, projectId: "project" },
    });
    expect(await box.resume(ID)).toEqual({ ok: true, value: { id: ID } });
    expect(await box.extendTimeout(ID, 60_000)).toEqual({ ok: true, value: undefined });
  });

  it("knows no other sandbox", async () => {
    const { box } = manager();
    for (const result of [
      await box.resume("other"),
      await box.readFile("other", "/x"),
      await box.exec("other", "true"),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("stops using the machine once destroyed, without being able to remove it", async () => {
    const { box, sent } = manager();
    await box.destroy(ID);
    expect(sent).toHaveLength(0);
    for (const result of [
      await box.create("project"),
      await box.exec(ID, "true"),
      await box.writeFile(ID, `${dir}/x`, ""),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: "destroyed" } });
  });

  it("serves no preview: nothing outside the machine can reach it", async () => {
    const { box } = manager();
    expect(await box.getPreviewUrl(ID, 5173)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(await box.waitForPreview(ID, 5173)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});
