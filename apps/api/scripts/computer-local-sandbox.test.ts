import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { LocalDockerSandboxManager } from "./computer-local-sandbox.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const originalPath = process.env.PATH;
const originalState = process.env.NAP_LOCAL_DOCKER_FAKE_STATE;
const originalFault = process.env.NAP_LOCAL_DOCKER_FAKE_FAULT;
let directory = "";

const fakeDocker = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.NAP_LOCAL_DOCKER_FAKE_STATE;
if (!root) process.exit(70);
fs.mkdirSync(root, { recursive: true });
fs.appendFileSync(path.join(root, "calls.ndjson"), JSON.stringify({ args }) + "\n");
const containers = path.join(root, "containers");
const files = path.join(root, "files");
const operations = path.join(root, "operations");
for (const item of [containers, files, operations]) fs.mkdirSync(item, { recursive: true });
const fail = (message) => { process.stderr.write(message + "\n"); process.exitCode = 1; };
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const labels = () => {
  const found = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const pair = args[index + 1] || "";
    const cut = pair.indexOf("=");
    found[pair.slice(0, cut)] = pair.slice(cut + 1);
  }
  return found;
};
const containerPath = (id) => path.join(containers, id + ".json");
const readContainer = (id) => JSON.parse(fs.readFileSync(containerPath(id), "utf8"));
const input = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const fileName = (id, sandboxPath) => path.join(files, id, Buffer.from(sandboxPath).toString("base64url"));
const helperReply = (value) => process.stdout.write(JSON.stringify(value));
async function main() {
  if (args[0] === "version") {
    process.stdout.write("27.4.0\n");
    return;
  }
  if (args[0] === "image" && args[1] === "inspect") {
    const imageFile = path.join(root, "image.json");
    if (!fs.existsSync(imageFile)) return fail("No such image");
    process.stdout.write("[" + fs.readFileSync(imageFile, "utf8") + "]");
    return;
  }
  if (args[0] === "build") {
    if (process.env.NAP_LOCAL_DOCKER_FAKE_FAULT === "build_block") {
      await new Promise(() => {});
      return;
    }
    const tag = option("--tag");
    const imageLabels = labels();
    fs.writeFileSync(path.join(root, "image.json"), JSON.stringify({
      Id: "sha256:" + "f".repeat(64),
      Config: { Labels: imageLabels },
      RepoTags: [tag],
    }));
    process.stdout.write("fake build\n");
    return;
  }
  if (args[0] === "container" && args[1] === "run") {
    const countFile = path.join(root, "container-count");
    const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) + 1 : 1;
    fs.writeFileSync(countFile, String(count));
    const id = count.toString(16).padStart(64, String(count));
    const value = {
      Id: id,
      Name: "/" + option("--name"),
      State: { Running: true },
      Config: { Labels: labels(), Image: args.at(-1) },
    };
    if (process.env.NAP_LOCAL_DOCKER_FAKE_FAULT === "label_mismatch") {
      value.Config.Labels["dev.nap.local.project"] = "another-project";
    }
    fs.writeFileSync(containerPath(id), JSON.stringify(value));
    const cidfile = option("--cidfile");
    if (cidfile) {
      fs.mkdirSync(path.dirname(cidfile), { recursive: true });
      fs.writeFileSync(cidfile, id + "\n");
    }
    process.stdout.write(id + "\n");
    return;
  }
  if (args[0] === "container" && args[1] === "inspect") {
    const id = args[2];
    if (!id || !fs.existsSync(containerPath(id))) return fail("No such object");
    process.stdout.write("[" + fs.readFileSync(containerPath(id), "utf8") + "]");
    return;
  }
  if (args[0] === "container" && args[1] === "rm") {
    const id = args.at(-1);
    if (!id) return fail("missing id");
    fs.rmSync(containerPath(id), { force: true });
    process.stdout.write(id + "\n");
    return;
  }
  if (args[0] !== "container" || args[1] !== "exec") return fail("unsupported fake Docker call");
  const idIndex = args.findIndex((value) => /^[0-9a-f]{64}$/.test(value));
  const id = args[idIndex];
  if (!id || !fs.existsSync(containerPath(id))) return fail("No such object");
  const script = args[idIndex + 2];
  const operation = args[idIndex + 3];
  if (script === "/usr/local/lib/nap-local/file-helper.mjs") {
    const encodedPath = args[idIndex + 4];
    if (operation === "exec-result") {
      const resultPath = path.join(operations, id, encodedPath + ".json");
      if (!fs.existsSync(resultPath)) return helperReply({ ok: false, code: "unavailable" });
      return helperReply({ ok: true, value: JSON.parse(fs.readFileSync(resultPath, "utf8")) });
    }
    const sandboxPath = Buffer.from(encodedPath || "", "base64url").toString();
    const target = fileName(id, sandboxPath);
    if (operation === "write") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await input());
      return helperReply({ ok: true, value: null });
    }
    if (operation === "read") {
      if (!fs.existsSync(target)) return helperReply({ ok: false, code: "file_not_found" });
      return helperReply({ ok: true, value: fs.readFileSync(target).toString("base64") });
    }
    if (operation === "list") {
      const base = sandboxPath.endsWith("/") ? sandboxPath : sandboxPath + "/";
      const entries = new Map();
      const ownDirectory = path.join(files, id);
      for (const name of fs.existsSync(ownDirectory) ? fs.readdirSync(ownDirectory) : []) {
        const candidate = Buffer.from(name, "base64url").toString();
        if (!candidate.startsWith(base)) continue;
        const rest = candidate.slice(base.length);
        if (!rest) continue;
        const child = rest.split("/")[0];
        entries.set(base + child, rest.includes("/") ? "directory" : "file");
      }
      return helperReply({ ok: true, value: [...entries].map(([entryPath, type]) => ({ path: entryPath, type })) });
    }
    return fail("unsupported file helper operation");
  }
  if (script === "/usr/local/lib/nap-local/exec.mjs") {
    const operationId = operation;
    const command = Buffer.from(args[idIndex + 4] || "", "base64url").toString();
    if (command === "FAKE_DOCKER_LOSS") return fail("daemon connection lost");
    if (command === "FAKE_BLOCK") {
      const release = path.join(root, "release-block");
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(release) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.stdout.write("block released\n");
    } else if (command === "FAKE_CANCEL") {
      fs.writeFileSync(path.join(root, "release-block"), "released");
      process.stdout.write("cancelled peer\n");
    } else if (command === "FAKE_STREAM_NONZERO") {
      process.stdout.write("one\n");
      process.stderr.write("two\n");
    } else {
      process.stdout.write("ok\n");
    }
    const operationDirectory = path.join(operations, id);
    fs.mkdirSync(operationDirectory, { recursive: true });
    fs.writeFileSync(path.join(operationDirectory, operationId + ".json"), JSON.stringify({
      exitCode: command === "FAKE_STREAM_NONZERO" ? 3 : 0,
    }));
    return;
  }
  if (script === "/usr/local/lib/nap-local/tcp-forward.mjs") {
    process.stdin.pipe(process.stdout);
    await new Promise((resolve) => process.stdin.on("end", resolve));
    return;
  }
  return fail("unsupported fake exec helper");
}
main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
`;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function calls(): string[][] {
  const path = join(directory, "state/calls.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("args" in parsed) ||
        !Array.isArray(parsed.args) ||
        !parsed.args.every((part) => typeof part === "string")
      )
        throw new Error("Fake Docker wrote an invalid call record.");
      return parsed.args;
    });
}

async function openManager(
  options: { memoryMB?: number; ttlMs?: number; signal?: AbortSignal } = {},
): Promise<LocalDockerSandboxManager> {
  const opened = await LocalDockerSandboxManager.open({
    repositoryRoot,
    evidenceDirectory: join(directory, "evidence"),
    ...options,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

function roundTrip(url: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const chunks: Buffer[] = [];
    const socket = createConnection(Number(parsed.port), parsed.hostname);
    socket.on("connect", () => socket.end(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nap-local-sandbox-unit-"));
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "docker");
  writeFileSync(executable, fakeDocker);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.NAP_LOCAL_DOCKER_FAKE_STATE = state;
  delete process.env.NAP_LOCAL_DOCKER_FAKE_FAULT;
});

afterEach(() => {
  restoreEnv("PATH", originalPath);
  restoreEnv("NAP_LOCAL_DOCKER_FAKE_STATE", originalState);
  restoreEnv("NAP_LOCAL_DOCKER_FAKE_FAULT", originalFault);
  rmSync(directory, { recursive: true, force: true });
});

it("exports only the local Docker SandboxManager port and its owned close operation", async () => {
  const module = await import("./computer-local-sandbox.ts");

  expect(Object.keys(module)).toEqual(["LocalDockerSandboxManager"]);
  expectTypeOf<LocalDockerSandboxManager>().toMatchTypeOf<SandboxManager>();
  expectTypeOf<
    Exclude<keyof LocalDockerSandboxManager, keyof SandboxManager | "close">
  >().toEqualTypeOf<never>();
  expectTypeOf<Parameters<typeof LocalDockerSandboxManager.open>[0]>().toEqualTypeOf<{
    repositoryRoot: string;
    memoryMB?: number;
    ttlMs?: number;
    evidenceDirectory?: string;
    signal?: AbortSignal;
  }>();
  expectTypeOf<ReturnType<typeof LocalDockerSandboxManager.open>>().toEqualTypeOf<
    Promise<Result<LocalDockerSandboxManager, { message: string }>>
  >();
  expectTypeOf<ReturnType<LocalDockerSandboxManager["close"]>>().toEqualTypeOf<
    Promise<Result<void, { message: string }>>
  >();
});

describe.sequential("LocalDockerSandboxManager boundaries", () => {
  it("returns a typed cancellation before invoking a build tool", async () => {
    const controller = new AbortController();
    controller.abort();

    const opened = await LocalDockerSandboxManager.open({
      repositoryRoot,
      signal: controller.signal,
    });

    expect(opened).toEqual({
      ok: false,
      error: { message: "Local Docker startup was cancelled." },
    });
    expect(calls()).toEqual([]);
  });

  it("builds a content-addressed image and creates a labeled 2 GiB network-none sandbox", async () => {
    const manager = await openManager();
    const created = await manager.create("project-local");

    expect(created).toMatchObject({ ok: true, value: { projectId: "project-local" } });
    const build = calls().find((args) => args[0] === "build");
    const run = calls().find((args) => args[0] === "container" && args[1] === "run");
    expect(build).toEqual(
      expect.arrayContaining([
        "--platform",
        "linux/amd64",
        "--label",
        expect.stringMatching(/^dev\.nap\.local\.image-digest=[0-9a-f]{64}$/),
      ]),
    );
    expect(run).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "2048m",
        "--memory-swap",
        "2048m",
        "--label",
        "dev.nap.local.project=project-local",
      ]),
    );
    expect(run).not.toContain("--publish");
    expect(run?.join(" ")).not.toContain("9222");

    const firstClose = manager.close();
    const secondClose = manager.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toEqual({ ok: true, value: undefined });
    const removals = calls().filter(
      (args) => args[0] === "container" && args[1] === "rm" && args[2] === "--force",
    );
    expect(removals).toHaveLength(1);
  });

  it("removes the exact container when startup labels do not match", async () => {
    process.env.NAP_LOCAL_DOCKER_FAKE_FAULT = "label_mismatch";
    const manager = await openManager();

    const created = await manager.create("project-local");

    expect(created).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const run = calls().find((args) => args[0] === "container" && args[1] === "run");
    const removal = calls().find((args) => args[0] === "container" && args[1] === "rm");
    const containerId = run === undefined ? undefined : "1".repeat(64);
    expect(removal?.at(-1)).toBe(containerId);
    await expect(manager.close()).resolves.toEqual({ ok: true, value: undefined });
  });

  it("resets TTL and makes destroy repeatable while tombstoning later operations", async () => {
    const manager = await openManager({ ttlMs: 80 });
    const created = await manager.create("project-ttl");
    if (!created.ok) throw new Error(created.error.message);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await manager.extendTimeout(created.value.id, 140)).toEqual({
      ok: true,
      value: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(await manager.resume(created.value.id)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await manager.resume(created.value.id)).toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
    expect(await manager.destroy(created.value.id)).toEqual({ ok: true, value: undefined });
    expect(await manager.destroy(created.value.id)).toEqual({ ok: true, value: undefined });
    await manager.close();
  });

  it("validates file paths, preserves quoted names and streams nonzero command results", async () => {
    const manager = await openManager();
    const created = await manager.create("project-files");
    if (!created.ok) throw new Error(created.error.message);
    const sandboxId = created.value.id;
    const path = "/home/user/app/dir with space/quote-'file.ts";
    expect(await manager.writeFile(sandboxId, path, "const value = 'real';\n")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await manager.readFile(sandboxId, path)).toEqual({
      ok: true,
      value: "const value = 'real';\n",
    });
    expect(await manager.listFiles(sandboxId, "/home/user/app")).toEqual({
      ok: true,
      value: [{ path: "/home/user/app/dir with space", type: "directory" }],
    });
    const beforeInvalid = calls().length;
    expect(await manager.readFile(sandboxId, "/etc/passwd")).toMatchObject({
      ok: false,
      error: { code: "exec_failed" },
    });
    expect(calls()).toHaveLength(beforeInvalid);

    const chunks: Array<{ stream: "stdout" | "stderr"; data: string }> = [];
    const result = await manager.exec(sandboxId, "FAKE_STREAM_NONZERO", (chunk) =>
      chunks.push(chunk),
    );
    expect(result).toEqual({
      ok: true,
      value: { exitCode: 3, stdout: "one\n", stderr: "two\n" },
    });
    expect(
      chunks
        .filter((chunk) => chunk.stream === "stdout")
        .map((chunk) => chunk.data)
        .join(""),
    ).toBe("one\n");
    expect(
      chunks
        .filter((chunk) => chunk.stream === "stderr")
        .map((chunk) => chunk.data)
        .join(""),
    ).toBe("two\n");
    await manager.close();
  });

  it("keeps exec calls independent so a cancellation command can finish beside a blocked action", async () => {
    const manager = await openManager();
    const created = await manager.create("project-concurrency");
    if (!created.ok) throw new Error(created.error.message);

    const blocked = manager.exec(created.value.id, "FAKE_BLOCK");
    await expect(manager.exec(created.value.id, "FAKE_CANCEL")).resolves.toMatchObject({
      ok: true,
    });
    await expect(blocked).resolves.toMatchObject({ ok: true });
    const helpers = calls().filter((args) => args.includes("/usr/local/lib/nap-local/exec.mjs"));
    expect(helpers).toHaveLength(2);
    await manager.close();
  });

  it("bridges only Vite and VNC over raw loopback TCP with binary half-close intact", async () => {
    const manager = await openManager();
    const created = await manager.create("project-bridges");
    if (!created.ok) throw new Error(created.error.message);
    const vite = await manager.getPreviewUrl(created.value.id, 5173);
    const vnc = await manager.getPreviewUrl(created.value.id, 6080);
    const repeated = await manager.getPreviewUrl(created.value.id, 5173);
    if (!vite.ok || !vnc.ok || !repeated.ok) throw new Error("Could not create test bridges.");

    expect(new URL(vite.value).hostname).toBe("127.0.0.1");
    expect(new URL(vnc.value).hostname).toBe("127.0.0.1");
    expect(repeated.value).toBe(vite.value);
    expect(new URL(vite.value).port).not.toBe(new URL(vnc.value).port);
    const bytes = Buffer.from([0, 255, 1, 2, 13, 10, 128, 64]);
    await expect(roundTrip(vite.value, bytes)).resolves.toEqual(bytes);
    await expect(manager.getPreviewUrl(created.value.id, 9222)).resolves.toMatchObject({
      ok: false,
      error: { code: "exec_failed" },
    });
    await manager.close();
    expect(
      calls().filter((args) => args.includes("/usr/local/lib/nap-local/tcp-forward.mjs")),
    ).toHaveLength(1);
  });

  it("fails closed by removing the container before returning a Docker exec loss", async () => {
    const manager = await openManager();
    const created = await manager.create("project-loss");
    if (!created.ok) throw new Error(created.error.message);

    const result = await manager.exec(created.value.id, "FAKE_DOCKER_LOSS");

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await manager.resume(created.value.id)).toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
    const records = calls();
    const failedExec = records.findIndex((args) =>
      args.includes("/usr/local/lib/nap-local/exec.mjs"),
    );
    const removal = records.findIndex((args) => args[0] === "container" && args[1] === "rm");
    expect(removal).toBeGreaterThan(failedExec);
    await manager.close();
  });

  it("aborts a pending image build and removes its registered context before returning", async () => {
    process.env.NAP_LOCAL_DOCKER_FAKE_FAULT = "build_block";
    const controller = new AbortController();
    const opening = LocalDockerSandboxManager.open({ repositoryRoot, signal: controller.signal });
    await expect.poll(() => calls().some((args) => args[0] === "build")).toBe(true);
    const build = calls().find((args) => args[0] === "build");
    const context = build?.at(-1);

    controller.abort();

    await expect(opening).resolves.toEqual({
      ok: false,
      error: { message: "Local Docker startup was cancelled." },
    });
    expect(context).toBeDefined();
    if (context !== undefined) expect(existsSync(context)).toBe(false);
    expect(calls().some((args) => args[0] === "container" && args[1] === "run")).toBe(false);
  });
});
