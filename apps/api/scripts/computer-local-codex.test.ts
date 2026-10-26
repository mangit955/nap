import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import { TOOL_DEFINITIONS, TOOL_SCHEMAS } from "@nap/agent/tools/definitions";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMRequest, LLMTurnResult } from "@nap/shared/ports/llm-provider";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { openComputerLocalCodex } from "./computer-local-codex.ts";

const cleanupFault = vi.hoisted(() => {
  const state: { reject: ((path: unknown) => boolean) | null } = { reject: null };
  return state;
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (cleanupFault.reject?.(args[0])) throw new Error("Synthetic decision cleanup failure.");
      return actual.rm(...args);
    },
  };
});

const MODEL = { nativeModel: "gpt-5.6-sol", napModel: "openai/gpt-5.6-sol" };
const USAGE = { input_tokens: 120, cached_input_tokens: 90, output_tokens: 12 };
const COMPUTER = {
  kind: "message",
  text: "",
  toolCalls: [{ name: "computer", inputJson: '{"actions":[{"action":"screenshot"}]}' }],
};
type PeerSpec = {
  auth?: string;
  authStream?: "stderr";
  authExit?: number;
  decision?: unknown;
  raw?: string;
  builtin?: string;
  fault?: "failed" | "missing-usage" | "stdout" | "stderr" | "hang" | "hold";
  exitCode?: number;
};
type LaunchOptions = Parameters<
  NonNullable<Parameters<typeof openComputerLocalCodex>[0]["launch"]>
>[1];
type Child = {
  process: ChildProcessWithoutNullStreams;
  closed: boolean;
  done: Promise<void>;
  outputComplete: Promise<void>;
};
const disposers: (() => Promise<void>)[] = [];
const children: Child[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map((close) => close()));
  for (const child of children) if (!child.closed) child.process.kill("SIGKILL");
  await Promise.allSettled(children.splice(0).map((child) => child.done));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A local Node peer exercises pipes, files, and close without invoking Codex or any account.
const PEER = String.raw`
import { readFileSync, statSync, writeFileSync } from "node:fs";
const spec = JSON.parse(process.argv[2]);
const capturePath = process.argv[3];
const args = process.argv.slice(4);
if (args.includes("login") && args.includes("status")) {
  (spec.authStream === "stderr" ? process.stderr : process.stdout).write(spec.auth ?? "Logged in using ChatGPT\n");
  process.exitCode = spec.authExit ?? 0;
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (part) => { input += part; });
  process.stdin.on("end", () => {
    const images = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "--image") continue;
      for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) {
        images.push({ path: args[j], data: readFileSync(args[j]).toString("base64"), mode: statSync(args[j]).mode & 0o777 });
      }
    }
    const schemaPath = args[args.indexOf("--output-schema") + 1];
    writeFileSync(capturePath, JSON.stringify({
      args, input, cwd: process.cwd(), cwdMode: statSync(process.cwd()).mode & 0o777,
      images, schemaPath, schema: JSON.parse(readFileSync(schemaPath, "utf8")), env: process.env,
    }));
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
    if (spec.fault === "stdout") { process.stdout.write("x".repeat(16384)); setInterval(() => {}, 1000); return; }
    if (spec.fault === "stderr") { process.stderr.write("synthetic-secret-".repeat(2048)); setInterval(() => {}, 1000); return; }
    if (spec.fault === "hang") {
      setInterval(() => {}, 1000);
    } else {
      send({ type: "thread.started", thread_id: "fake-thread" });
      send({ type: "turn.started" });
      if (spec.builtin) send({ type: "item.started", item: { id: "builtin", type: spec.builtin } });
      if (spec.fault === "failed") {
        send({ type: "turn.failed", error: { message: "synthetic-secret-failure" } });
      } else {
        send({ type: "item.completed", item: { id: "answer", type: "agent_message", text: spec.raw ?? JSON.stringify(spec.decision ?? { kind: "message", text: "fixture response", toolCalls: [] }) } });
        if (spec.fault !== "missing-usage") send({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 90, output_tokens: 12 } });
      }
      if (spec.fault === "hold") setInterval(() => {}, 1000);
      else process.exitCode = spec.exitCode ?? 0;
    }
    process.once("SIGTERM", () => {
      writeFileSync(capturePath + ".term", "received");
      setTimeout(() => process.exit(0), 100);
    });
  });
}
`;

const Capture = z.object({
  args: z.array(z.string()),
  input: z.string(),
  cwd: z.string(),
  cwdMode: z.number(),
  images: z.array(z.object({ path: z.string(), data: z.string(), mode: z.number() })),
  schemaPath: z.string(),
  schema: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string()),
});

async function peer(spec: PeerSpec = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nap-codex-peer-test-"));
  directories.push(directory);
  const script = join(directory, "peer.mjs");
  await writeFile(script, PEER);
  const launches: { args: readonly string[]; options: LaunchOptions; child: Child }[] = [];
  const captures: string[] = [];
  const launch = (args: readonly string[], options: LaunchOptions) => {
    const capture = join(directory, `capture-${launches.length}.json`);
    const process = spawn(
      globalThis.process.execPath,
      [script, JSON.stringify(spec), capture, ...args],
      {
        ...options,
        stdio: "pipe",
      },
    );
    const outputComplete = new Promise<void>((resolve) => {
      let pending = "";
      process.stdout.on("data", (data: Buffer) => {
        pending = (pending + data.toString("utf8")).slice(-1024);
        if (pending.includes('"type":"turn.completed"')) resolve();
      });
    });
    const child: Child = { process, closed: false, done: Promise.resolve(), outputComplete };
    child.done = new Promise<void>((resolve) => {
      process.once("close", () => {
        child.closed = true;
        resolve();
      });
    });
    children.push(child);
    launches.push({ args, options, child });
    if (args.includes("exec")) captures.push(capture);
    return process;
  };
  const capture = async (index = 0) => {
    const path = captures[index];
    if (!path) throw new Error("No exec child was launched.");
    return Capture.parse(JSON.parse(await readFile(path, "utf8")));
  };
  const ready = async (index = 0) => {
    await vi.waitFor(async () => {
      const path = captures[index];
      expect(path).toBeDefined();
      if (path) await access(path);
    });
  };
  return { launch, launches, capture, captures, ready };
}

type OpenOptions = Parameters<typeof openComputerLocalCodex>[0];
async function opened(f: Awaited<ReturnType<typeof peer>>, options: Partial<OpenOptions> = {}) {
  const result = await openComputerLocalCodex({ ...MODEL, launch: f.launch, ...options });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  disposers.push(result.value.close);
  return result.value;
}

function request(): LLMRequest {
  return {
    systemPrompt: "trusted fixture instructions",
    messages: [{ role: "user", content: "fixture goal" }],
    tools: TOOL_DEFINITIONS.filter((tool) => tool.name === "computer"),
  };
}

function calls(result: LLMTurnResult) {
  expect(result.type).toBe("message");
  if (result.type !== "message") throw new Error("Expected a parsed decision.");
  return result.toolCalls;
}

async function inputsRemoved(capture: z.infer<typeof Capture>) {
  for (const path of [
    capture.cwd,
    capture.schemaPath,
    ...capture.images.map((image) => image.path),
  ]) {
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

it("uses subscription preflight and the installed safe argv with only an allowlisted environment", async () => {
  const f = await peer({ authStream: "stderr" });
  const local = await opened(f, {
    environment: {
      PATH: process.env.PATH,
      HOME: "/synthetic/home",
      OPENAI_API_KEY: "synthetic-secret-openai",
      CODEX_API_KEY: "synthetic-secret-codex",
      OPENROUTER_API_KEY: "synthetic-secret-router",
      ANTHROPIC_API_KEY: "synthetic-secret-anthropic",
      OPENAI_BASE_URL: "https://invalid.test",
      CODEX_HOME: "/untrusted/auth-override",
      DATABASE_URL: "synthetic-secret-db",
      AWS_ACCESS_KEY_ID: "synthetic-secret-aws",
    },
  });
  expect(f.launches.some(({ args }) => args.includes("exec"))).toBe(false);
  await local.provider.startTurn().complete(request());
  const captured = await f.capture();
  const login = f.launches.find(({ args }) => args.includes("login"));
  expect(login?.args).toContain("status");
  expect(captured.args).toEqual(
    expect.arrayContaining([
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--output-schema",
      "--cd",
      "--model",
      "gpt-5.6-sol",
      "read-only",
      "never",
      "-",
    ]),
  );
  for (const value of [
    'forced_login_method="chatgpt"',
    'model_provider="openai"',
    'web_search="disabled"',
    "mcp_servers={}",
  ])
    expect(captured.args).toContain(value);
  for (const flag of [
    "shell_tool",
    "unified_exec",
    "view_image",
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "code_mode",
    "multi_agent",
  ]) {
    expect(
      captured.args.some((arg, i) => arg === "--disable" && captured.args[i + 1] === flag),
    ).toBe(true);
  }
  expect(captured.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(captured.args).not.toContain("fixture goal");
  expect(captured.cwd).not.toContain("/worktrees/nap/");
  expect(captured.cwdMode).toBe(0o700);
  for (const { options } of f.launches) {
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.env.HOME).toBe("/synthetic/home");
    expect(JSON.stringify(options.env)).not.toContain("synthetic-secret");
    for (const key of ["OPENAI_BASE_URL", "CODEX_HOME", "DATABASE_URL", "AWS_ACCESS_KEY_ID"])
      expect(options.env).not.toHaveProperty(key);
    expect(options.detached).toBe(true);
  }
  expect(f.launches.every(({ child }) => child.closed)).toBe(true);
});

it("fails closed on API-key, absent, unrecognized, or failing login status without starting exec", async () => {
  for (const spec of [
    { auth: "Logged in using an API key\n" },
    { auth: "Not logged in\n", authExit: 1 },
    { auth: "unexpected authentication mode\n" },
    { auth: "Logged in using ChatGPT\n", authExit: 1 },
  ]) {
    const f = await peer(spec);
    const result = await openComputerLocalCodex({ ...MODEL, launch: f.launch });
    if (result.ok) disposers.push(result.value.close);
    expect(result).toMatchObject({ ok: false, error: { code: "auth" } });
    expect(f.launches.some(({ args }) => args.includes("exec"))).toBe(false);
    expect(f.launches.every(({ child }) => child.closed)).toBe(true);
  }
});

it("refuses credentials, a different Nap model, unsupported summary bounds, and an already aborted call", async () => {
  const f = await peer();
  const local = await opened(f);
  for (const options of [
    { model: "anthropic/claude-sonnet-5" },
    { credentials: { platform: "openrouter" as const, apiKey: "synthetic-secret" } },
  ]) {
    const result = await local.provider.startTurn(options).complete(request());
    expect(result).toMatchObject({ type: "error", retryable: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  }
  const turn = local.provider.startTurn({ model: MODEL.napModel });
  expect(turn.compact).toBeUndefined();
  expect(
    await turn.complete({ ...request(), purpose: "compaction", tools: [], maxOutputTokens: 64 }),
  ).toMatchObject({ type: "error", retryable: false });
  expect(await turn.complete({ ...request(), signal: AbortSignal.abort() })).toMatchObject({
    type: "error",
    retryable: false,
  });
  expect(f.launches.some(({ args }) => args.includes("exec"))).toBe(false);
});

it("delivers actual nested JPEG bytes in order, preserves tool-result identity, then deletes inputs", async () => {
  const f = await peer({ decision: COMPUTER });
  const local = await opened(f);
  const jpeg = await readFile(
    new URL("../../../docs/assets/computer-use/panel-review/fixture-desktop.jpg", import.meta.url),
  );
  const other = await readFile(
    new URL("../../../docs/research/computer-use-spike/after-input.jpg", import.meta.url),
  );
  expect(jpeg.equals(other)).toBe(false);
  const req = request();
  req.messages.push(
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "observation-1",
          name: "computer",
          input: { actions: [{ action: "screenshot" }] },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "observation-1",
          isError: false,
          content: [
            { type: "text", text: "before-first-frame" },
            { type: "image", mediaType: "image/jpeg", data: jpeg.toString("base64") },
            { type: "text", text: "between-frames" },
            { type: "image", mediaType: "image/jpeg", data: other.toString("base64") },
            { type: "text", text: "after-second-frame" },
          ],
        },
      ],
    },
  );
  expect(calls(await local.provider.startTurn().complete(req))).toHaveLength(1);
  const captured = await f.capture();
  expect(captured.images.map((image) => image.data)).toEqual([
    jpeg.toString("base64"),
    other.toString("base64"),
  ]);
  expect(captured.images.every((image) => image.mode === 0o600 && isAbsolute(image.path))).toBe(
    true,
  );
  expect(captured.input).toContain("observation-1");
  expect(captured.input).toContain("tool_result");
  const positions = [
    "before-first-frame",
    "[attached JPEG 1]",
    "between-frames",
    "[attached JPEG 2]",
    "after-second-frame",
  ].map((part) => captured.input.indexOf(part));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(captured.input).not.toContain(jpeg.toString("base64"));
  expect(captured.input).not.toContain(other.toString("base64"));
  await inputsRemoved(captured);
});

it("describes declared tools, parses inputJson into Nap calls, and counts cached input only once", async () => {
  const f = await peer({ decision: COMPUTER });
  const local = await opened(f);
  const turn = local.provider.startTurn();
  const delta = vi.fn();
  const result = await turn.complete({ ...request(), onTextDelta: delta });
  const selected = calls(result);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.id).toEqual(expect.any(String));
  expect(selected[0]?.name).toBe("computer");
  expect(TOOL_SCHEMAS.computer.parse(selected[0]?.input)).toEqual({
    actions: [{ action: "screenshot" }],
  });
  expect(result.usage).toEqual({
    inputTokens: USAGE.input_tokens,
    outputTokens: USAGE.output_tokens,
  });
  expect(turn.usage()).toEqual(result.usage);
  expect(delta).not.toHaveBeenCalled();
  const captured = await f.capture();
  expect(captured.schema).toMatchObject({ type: "object", additionalProperties: false });
  expect(captured.schema).toMatchObject({
    properties: { toolCalls: { items: { properties: { name: { enum: ["computer"] } } } } },
  });
  expect(JSON.stringify(captured.schema)).toContain("inputJson");
  expect(captured.input).toContain("trusted fixture instructions");
  expect(captured.input).toContain("fixture goal");
  expect(captured.input).toContain("computer");
});

it("rejects the entire decision when any selected tool or input is invalid or undeclared", async () => {
  for (const tool of [
    { name: "exec", inputJson: "{}" },
    { name: "write_file", inputJson: '{"path":"/home/user/app/x","contents":"x"}' },
    { name: "computer", inputJson: '{"actions":[{"action":"left_click","coordinate":[-1,4]}]}' },
    { name: "computer", inputJson: "[]" },
    { name: "computer", inputJson: "{broken" },
  ]) {
    const f = await peer({ decision: { ...COMPUTER, toolCalls: [...COMPUTER.toolCalls, tool] } });
    const local = await opened(f);
    expect(await local.provider.startTurn().complete(request())).toMatchObject({
      type: "error",
      retryable: false,
    });
  }
  const f = await peer({ decision: COMPUTER });
  const local = await opened(f);
  expect(calls(await local.provider.startTurn().complete(request()))).toHaveLength(1);
});

it("lets the real Nap loop execute selected tools and returns their results on the next exec", async () => {
  const f = await peer({
    decision: {
      ...COMPUTER,
      toolCalls: [{ name: "read_file", inputJson: '{"path":"/home/user/app/proof.txt"}' }],
    },
  });
  const local = await opened(f);
  const sandbox = new InMemorySandboxManager({
    seed: { "/home/user/app/proof.txt": "sandbox-only-result" },
  });
  const created = await sandbox.create("local-codex-test");
  if (!created.ok) throw new Error(created.error.message);
  const events: PendingEvent[] = [];
  const agent = new NapAgentService({ provider: local.provider, budget: { maxSteps: 2 } });
  await agent.runTurn({
    sessionId: "session",
    turnId: "turn",
    sandboxId: created.value.id,
    sandbox,
    model: MODEL.napModel,
    context: {
      systemPrompt: "fixture",
      messages: [{ role: "user", content: "read proof" }],
      estimatedTokens: 4,
    },
    onEvent: (event) => events.push(event),
  });
  expect(
    events.filter((event) => event.type === "tool.call").map((event) => event.payload.toolName),
  ).toEqual(["read_file", "read_file"]);
  expect(
    events.filter((event) => event.type === "tool.result").every((event) => event.payload.ok),
  ).toBe(true);
  expect((await f.capture(1)).input).toContain("sandbox-only-result");
});

it("distinguishes refusal from malformed output, failed turns, missing usage, and partial decisions", async () => {
  const refusal = await peer({ decision: { kind: "refusal", text: "", toolCalls: [] } });
  const refused = await opened(refusal);
  expect(await refused.provider.startTurn().complete(request())).toMatchObject({
    type: "refusal",
    usage: { inputTokens: 120, outputTokens: 12 },
  });
  for (const spec of [
    { raw: "not structured JSON" },
    { raw: '{"kind":"message"' },
    { fault: "failed" as const },
    { fault: "missing-usage" as const },
  ]) {
    const f = await peer(spec);
    const local = await opened(f);
    const result = await local.provider.startTurn().complete(request());
    expect(result.type).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    await inputsRemoved(await f.capture());
  }
});

it("invalidates an attempt with unexpected builtin activity even when a valid answer follows", async () => {
  for (const builtin of [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "browser_use",
    "computer_use",
  ]) {
    const f = await peer({ builtin, decision: COMPUTER });
    const local = await opened(f);
    expect((await local.provider.startTurn().complete(request())).type).toBe("error");
    expect(f.launches.every(({ child }) => child.closed)).toBe(true);
  }
});

it("rejects nonzero child exit and spawn failure without returning otherwise valid tool calls", async () => {
  const f = await peer({ decision: COMPUTER, exitCode: 9 });
  const local = await opened(f);
  expect((await local.provider.startTurn().complete(request())).type).toBe("error");
  expect(f.launches.every(({ child }) => child.closed)).toBe(true);
  const failed = await openComputerLocalCodex({
    ...MODEL,
    launch: () => spawn("/nonexistent/nap-codex-test-binary", [], { stdio: "pipe" }),
  });
  if (failed.ok) disposers.push(failed.value.close);
  expect(failed).toMatchObject({ ok: false, error: { code: "process" } });
});

it("times out an owned child, waits for its actual delayed close, and removes temporary inputs", async () => {
  const f = await peer({ fault: "hang" });
  const local = await opened(f, { limits: { timeoutMs: 1000, termGraceMs: 500 } });
  expect((await local.provider.startTurn().complete(request())).type).toBe("error");
  expect(f.launches.every(({ child }) => child.closed)).toBe(true);
  await inputsRemoved(await f.capture());
});

it("cancels after complete output without settling before the owned child actually closes", async () => {
  const f = await peer({ decision: COMPUTER, fault: "hold" });
  const local = await opened(f, { limits: { termGraceMs: 500 } });
  const controller = new AbortController();
  const completion = local.provider
    .startTurn()
    .complete({ ...request(), signal: controller.signal });
  await f.ready();
  const child = f.launches.find(({ args }) => args.includes("exec"))?.child;
  if (!child) throw new Error("No owned exec child.");
  await child.outputComplete;
  expect(child?.closed).toBe(false);
  controller.abort();
  expect(await completion).toMatchObject({ type: "error", retryable: false });
  expect(child?.closed).toBe(true);
  await inputsRemoved(await f.capture());
});

it("bounds both output pipes and redacts stderr instead of retaining unbounded child data", async () => {
  for (const fault of ["stdout", "stderr"] as const) {
    const f = await peer({ fault });
    const local = await opened(f, { limits: { stdoutBytes: 1024, stderrBytes: 1024 } });
    const result = await local.provider.startTurn().complete(request());
    expect(result.type).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(f.launches.every(({ child }) => child.closed)).toBe(true);
    await inputsRemoved(await f.capture());
  }
});

it("isolates handle usage, generates fresh call IDs, and closes idempotently without another exec", async () => {
  const f = await peer({ decision: COMPUTER });
  const local = await opened(f);
  const a = local.provider.startTurn();
  const b = local.provider.startTurn();
  const first = await a.complete(request());
  const second = await a.complete(request());
  expect(calls(first)[0]?.id).not.toBe(calls(second)[0]?.id);
  expect(a.usage()).toEqual({ inputTokens: 240, outputTokens: 24 });
  expect(b.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  await b.complete(request());
  expect(b.usage()).toEqual({ inputTokens: 120, outputTokens: 12 });
  await Promise.all([local.close(), local.close()]);
  const count = f.launches.length;
  expect((await a.complete(request())).type).toBe("error");
  expect(f.launches).toHaveLength(count);
});

it("retains measured usage when private input cleanup fails after the owned child closes", async () => {
  const f = await peer({ decision: COMPUTER });
  const local = await opened(f);
  const turn = local.provider.startTurn();
  const faulted: string[] = [];
  cleanupFault.reject = (path) => {
    const execution = f.launches.find(({ args }) => args.includes("exec"));
    if (
      typeof path !== "string" ||
      execution === undefined ||
      path !== dirname(execution.options.cwd) ||
      !execution.child.closed
    ) {
      return false;
    }
    faulted.push(path);
    return true;
  };
  try {
    const result = await turn.complete(request());
    expect(faulted).toHaveLength(1);
    const execution = f.launches.find(({ args }) => args.includes("exec"));
    if (!execution) throw new Error("No owned exec child.");
    await execution.child.outputComplete;
    expect(execution.child.closed).toBe(true);
    expect(result).toMatchObject({ type: "error", retryable: false });
    expect(result).not.toHaveProperty("toolCalls");
    await expect(local.close()).rejects.toThrow("Local Codex private input cleanup failed.");
    expect({ returned: result.usage, total: turn.usage() }).toEqual({
      returned: { inputTokens: 120, outputTokens: 12 },
      total: { inputTokens: 120, outputTokens: 12 },
    });
  } finally {
    cleanupFault.reject = null;
    for (const directory of faulted) await rm(directory, { recursive: true, force: true });
  }
});
