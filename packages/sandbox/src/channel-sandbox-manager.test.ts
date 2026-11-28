import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelSandboxManager, unframe, WRITE_CHUNK_CHARS } from "./channel-sandbox-manager.ts";
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
function hostChannel(cwd: string, options: { likeHarborDocker?: boolean; prelude?: string } = {}) {
  const sent: { command: string; timeoutMs: number | undefined }[] = [];
  // Harbor's Docker environment hands back stderr folded into stdout, and a shell started with a
  // locale the machine lacks warns on stderr before it runs anything. Both, when asked for.
  const noise = options.likeHarborDocker
    ? "echo 'bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)' >&2\nexec 2>&1\n"
    : "";
  const channel: ExecChannel = (command, execOptions) => {
    sent.push({ command, timeoutMs: execOptions?.timeoutMs });
    return new Promise((resolve) => {
      const script = `${noise}${options.prelude ?? ""}\ntimeout() { shift 3; "$@"; }\n${command}`;
      const child = spawn(
        "bash",
        ["-c", options.likeHarborDocker ? `{ ${script}\n} 2>&1` : script],
        {
          cwd,
        },
      );
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

/**
 * A channel answering every command the same way, inside the command's own frame, as a machine
 * running it would. An error is returned as it is: it never reached a machine.
 */
function cannedChannel(answer: Result<ExecResult, SandboxError>): ExecChannel {
  return async (command) => {
    if (!answer.ok) return answer;
    const nonce = command.match(/' out (\w+);/)?.[1] ?? "";
    const open = `@@nap-out-${nonce}@@`;
    const split = `@@nap-err-${nonce}@@`;
    return {
      ok: true,
      value: {
        exitCode: answer.value.exitCode,
        stdout: `${open}${answer.value.stdout}${split}${answer.value.stderr}`,
        stderr: "",
      },
    };
  };
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

  it("fails a listing that stops part-way rather than return it shorter", async () => {
    const { box } = manager();
    await box.writeFile(ID, `${dir}/a`, "");
    // The shell listing the entries is killed at the first one, as an out-of-memory kill would,
    // while whatever reads its output carries on and exits zero. Only the command's own `bash -c`
    // reads BASH_ENV, so the frame around it is untouched.
    const env = join(dir, ".bash-env");
    // A child's `$PPID`, since macOS's bash 3.2 has no `$BASHPID`.
    await writeFile(env, "printf() { sh -c 'kill -9 $PPID'; }\n");
    const { channel } = hostChannel(dir, { prelude: `export BASH_ENV=${env}` });
    const failing = new ChannelSandboxManager({ sandboxId: ID, channel });
    expect(await failing.listFiles(ID, dir)).toMatchObject({
      ok: false,
      error: { code: "exec_failed" },
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
    expect(sent[0]?.command).toContain("timeout -k 5 2 bash -c 'true' ");
    expect(sent[0]?.timeoutMs).toBe(17_000);

    await box.exec(ID, "true");
    expect(sent[1]?.command).toContain("timeout -k 5 60 bash -c 'true' ");
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

describe("a channel that folds stderr into stdout, as Harbor's Docker environment does", () => {
  function harborLike() {
    const { channel } = hostChannel(dir, { likeHarborDocker: true });
    return new ChannelSandboxManager({ sandboxId: ID, channel });
  }

  it("reads a file back exactly, whatever the shell printed around it", async () => {
    const box = harborLike();
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await box.writeFileBytes(ID, `${dir}/b.bin`, bytes);
    expect(await box.readFileBytes(ID, `${dir}/b.bin`)).toEqual({ ok: true, value: bytes });
  });

  it("lists only what is there", async () => {
    const box = harborLike();
    await box.writeFile(ID, `${dir}/only.txt`, "");
    expect(await box.listFiles(ID, dir)).toEqual({
      ok: true,
      value: [{ path: `${dir}/only.txt`, type: "file" }],
    });
  });

  it("keeps a command's stdout and stderr apart", async () => {
    const box = harborLike();
    const ran = await box.exec(ID, "echo out; echo err >&2");
    expect(ran.ok ? ran.value.stdout : "").toBe("out\n");
    expect(ran.ok ? ran.value.stderr : "").toContain("err\n");
    expect(ran.ok ? ran.value.stderr : "").toContain("setlocale");
  });
});

describe("the frame", () => {
  it("survives a command that prints the frame's own command line", async () => {
    // `ps` of the shell running the frame: the command line that would carry the markers.
    const { channel } = hostChannel(dir, { likeHarborDocker: true });
    const box = new ChannelSandboxManager({ sandboxId: ID, channel });
    const ran = await box.exec(ID, "ps -o args= -p $PPID; echo done");
    expect(ran.ok ? ran.value.stdout : "").toContain("nap_status");
    expect(ran.ok ? ran.value.stdout : "").toMatch(/done\n$/);
    expect(ran.ok ? ran.value.stderr : "").not.toContain("@@nap-");
  });

  it("still runs commands on a machine that cannot make a temporary file", async () => {
    const { channel } = hostChannel(dir, { prelude: "mktemp() { return 1; }" });
    const box = new ChannelSandboxManager({ sandboxId: ID, channel });
    expect(await box.exec(ID, "echo out; echo err >&2")).toEqual({
      ok: true,
      value: { exitCode: 0, stdout: "out\n", stderr: "" },
    });
    await box.writeFile(ID, `${dir}/f`, "kept\n");
    expect(await box.readFile(ID, `${dir}/f`)).toEqual({ ok: true, value: "kept\n" });
  });
});

describe("a read whose output is not base64", () => {
  /** Answers each command with `outputs[n]` inside its frame, as a machine would. */
  function scripted(outputs: string[]): ExecChannel {
    let call = 0;
    return async (command) => {
      const nonce = command.match(/' out (\w+);/)?.[1] ?? "";
      const stdout = outputs[Math.min(call, outputs.length - 1)] ?? "";
      call += 1;
      return {
        ok: true,
        value: {
          exitCode: 0,
          stdout: `@@nap-out-${nonce}@@${stdout}@@nap-err-${nonce}@@`,
          stderr: "",
        },
      };
    };
  }
  const noisy = "aGVs\nbash: warning: setlocale: LC_ALL: cannot change locale\nbG8=\n";

  it("is tried again, since a stray warning can land inside it", async () => {
    const box = new ChannelSandboxManager({
      sandboxId: ID,
      channel: scripted([noisy, "aGVsbG8=\n"]),
    });
    expect(await box.readFile(ID, "/app/f")).toEqual({ ok: true, value: "hello" });
  });

  it("fails rather than hand over garbage when it never comes back clean", async () => {
    const box = new ChannelSandboxManager({ sandboxId: ID, channel: scripted([noisy]) });
    expect(await box.readFile(ID, "/app/f")).toMatchObject({
      ok: false,
      error: { code: "exec_failed", message: expect.stringContaining("not base64") },
    });
  });
});

describe("a listing a stray warning lands inside", () => {
  const WARNING = "bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)\n";

  /**
   * The host's real shell, with the warning moved inside the frame's stdout on the first `noisy`
   * commands: the reordering a channel that reads stderr and stdout separately can produce.
   */
  function interleaving(noisy: number): ExecChannel {
    const { channel } = hostChannel(dir);
    let calls = 0;
    return async (command, options) => {
      const ran = await channel(command, options);
      calls += 1;
      if (!ran.ok || calls > noisy) return ran;
      const open = ran.value.stdout.match(/@@nap-out-\w+@@/)?.[0] ?? "";
      const at = ran.value.stdout.indexOf(open) + open.length;
      const { stdout } = ran.value;
      return {
        ok: true,
        value: { ...ran.value, stdout: stdout.slice(0, at) + WARNING + stdout.slice(at) },
      };
    };
  }

  it("is tried again rather than handing the warning back as a path", async () => {
    await new ChannelSandboxManager({ sandboxId: ID, channel: hostChannel(dir).channel }).writeFile(
      ID,
      `${dir}/blob.bin`,
      "",
    );
    const box = new ChannelSandboxManager({ sandboxId: ID, channel: interleaving(1) });
    expect(await box.listFiles(ID, dir)).toEqual({
      ok: true,
      value: [{ path: `${dir}/blob.bin`, type: "file" }],
    });
  });

  it("fails rather than list a name nobody created when it never comes back clean", async () => {
    await new ChannelSandboxManager({ sandboxId: ID, channel: hostChannel(dir).channel }).writeFile(
      ID,
      `${dir}/blob.bin`,
      "",
    );
    const box = new ChannelSandboxManager({ sandboxId: ID, channel: interleaving(Infinity) });
    expect(await box.listFiles(ID, dir)).toMatchObject({
      ok: false,
      error: { code: "exec_failed", message: expect.stringContaining("not base64") },
    });
  });
});

describe("unframe", () => {
  it("refuses output from a machine that never ran the frame", () => {
    expect(
      unframe({ exitCode: 126, stdout: "permission denied", stderr: "" }, "@@o@@", "@@e@@"),
    ).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });

  it("keeps what was printed before the frame as stderr", () => {
    expect(
      unframe({ exitCode: 0, stdout: "warning\n@@o@@data@@e@@oops", stderr: "" }, "@@o@@", "@@e@@"),
    ).toEqual({ ok: true, value: { exitCode: 0, stdout: "data", stderr: "oopswarning\n" } });
  });
});

describe("a write in several pieces", () => {
  it("leaves the file as it was when a piece fails", async () => {
    const { channel } = hostChannel(dir);
    let calls = 0;
    const failingSecond: ExecChannel = (command, options) => {
      calls += 1;
      return calls === 2
        ? Promise.resolve({ ok: false, error: { code: "unavailable", message: "gone" } })
        : channel(command, options);
    };
    const box = new ChannelSandboxManager({ sandboxId: ID, channel: failingSecond });
    await new ChannelSandboxManager({ sandboxId: ID, channel }).writeFile(ID, `${dir}/f`, "old\n");

    const big = "x".repeat(WRITE_CHUNK_CHARS * 2);
    expect((await box.writeFile(ID, `${dir}/f`, big)).ok).toBe(false);
    expect(
      await new ChannelSandboxManager({ sandboxId: ID, channel }).readFile(ID, `${dir}/f`),
    ).toEqual({ ok: true, value: "old\n" });
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
