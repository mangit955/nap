import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { APP_TEST_TASKS } from "@nap/bench/app-test";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ComputerAction } from "@nap/shared/computer";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAppTestFixture } from "../src/app-test-fixture.ts";
import { type AppTestFactories, runAppTestCommand } from "./app-test-command.ts";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const env = { E2B_API_KEY: "injected-e2b-only", OPENROUTER_API_KEY: "injected-model-only" };
const flags = [
  "--real",
  "--model=anthropic/claude-sonnet-5",
  "--max-steps=8",
  "--max-tokens=40000",
  "--budget-tokens=20000",
  "--max-output-tokens=2000",
];
function output() {
  const dir = mkdtempSync(join(tmpdir(), "nap-real-path-"));
  dirs.push(dir);
  return join(dir, "report.json");
}

function apparatus(failure = "") {
  const trace: string[] = [];
  const sandboxes: InMemorySandboxManager[] = [];
  const providers: ScriptedLLMProvider[] = [];
  const bases: string[] = [];
  const localFixtures: ReturnType<typeof prepareAppTestFixture>[] = [];
  const append = InMemoryEventStore.prototype.append;
  vi.spyOn(InMemoryEventStore.prototype, "append").mockImplementation(function (
    this: InMemoryEventStore,
    event,
    options,
  ) {
    trace.push(event.type);
    return append.call(this, event, options);
  });
  const factories: AppTestFactories = {
    sandbox: vi.fn(() => {
      const fixture = prepareAppTestFixture(APP_TEST_TASKS[0]!);
      cleanups.push(fixture.dispose);
      localFixtures.push(fixture);
      fixture.git(["reset", "--hard", fixture.baseSha]);
      writeFileSync(
        join(fixture.directory, "template-only.txt"),
        "Installed template files stay here\n",
      );
      fixture.git(["add", "template-only.txt"]);
      fixture.git(["commit", "--quiet", "-m", "Template baseline"]);
      bases.push(fixture.git(["rev-parse", "HEAD"]).trim());
      const sandbox = new InMemorySandboxManager({
        seed: {
          [`${PROJECT_ROOT_PATH}/index.html`]: readFileSync(
            join(fixture.directory, "index.html"),
            "utf8",
          ),
          [`${PROJECT_ROOT_PATH}/src/app.js`]: readFileSync(
            join(fixture.directory, "src/app.js"),
            "utf8",
          ),
        },
        serves: [5173],
        defaultExec: (command) => {
          trace.push(`exec:${command}`);
          if (failure === "syntax" && command.includes("node --check"))
            return { exitCode: 1, stderr: "SyntaxError" };
          if (failure === "diff" && command.includes("git diff --no-ext-diff"))
            return { exitCode: 0, stdout: "" };
          if (failure === "paths" && command.includes("git diff --name-only"))
            return { exitCode: 0, stdout: "index.html\nsrc/app.js\nsrc/Other.js" };
          if (failure === "blob" && command.includes("git show"))
            return { exitCode: 0, stdout: "Different committed source" };
          if (failure === "parent" && command.includes("git rev-parse") && command.includes("^"))
            return { exitCode: 0, stdout: "0".repeat(40) };
          if (failure === "dirty" && command.includes("git status"))
            return { exitCode: 0, stdout: " M src/app.js" };
          const local = command.replace(/^cd (?:'\/home\/user\/app'|\/home\/user\/app) && /, "");
          if (local === command) throw new Error(`Unexpected remote command: ${command}`);
          if (local.startsWith("curl "))
            return {
              exitCode: 0,
              stdout:
                failure === "serving"
                  ? "<h1>Another app</h1>"
                  : readFileSync(join(fixture.directory, "index.html"), "utf8"),
            };
          try {
            return {
              exitCode: 0,
              stdout: execFileSync("/bin/sh", ["-c", local], {
                cwd: fixture.directory,
                encoding: "utf8",
                env: Object.fromEntries(
                  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
                ),
              }),
            };
          } catch {
            return { exitCode: 1, stderr: "Remote command failed" };
          }
        },
      });
      const write = sandbox.writeFile.bind(sandbox);
      vi.spyOn(sandbox, "writeFile").mockImplementation(async (id, path, contents) => {
        trace.push(`write:${path}`);
        if (failure === "write")
          return { ok: false, error: { code: "unavailable", message: "write failed" } };
        const target = join(fixture.directory, relative(PROJECT_ROOT_PATH, path));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
        return write(id, path, contents);
      });
      const create = sandbox.create.bind(sandbox);
      vi.spyOn(sandbox, "create").mockImplementation(async (id) => {
        trace.push("create");
        if (failure === "create")
          return { ok: false, error: { code: "unavailable", message: "create failed" } };
        return create(id);
      });
      const destroy = sandbox.destroy.bind(sandbox);
      vi.spyOn(sandbox, "destroy").mockImplementation(async (id) => {
        trace.push("destroy");
        if (failure === "destroy-throws") throw new Error("destroy threw");
        if (failure === "destroy")
          return { ok: false, error: { code: "unavailable", message: "destroy failed" } };
        return destroy(id);
      });
      const wait = sandbox.waitForPreview.bind(sandbox);
      vi.spyOn(sandbox, "waitForPreview").mockImplementation(async (...args) => {
        trace.push("preview");
        if (failure === "preview")
          return { ok: false, error: { code: "timeout", message: "preview failed" } };
        return wait(...args);
      });
      if (failure === "post-source") {
        const read = sandbox.readFile.bind(sandbox);
        vi.spyOn(sandbox, "readFile").mockImplementation((id, path) =>
          trace.includes("provider")
            ? Promise.resolve({ ok: true, value: "changed" })
            : read(id, path),
        );
      }
      if (failure === "read")
        vi.spyOn(sandbox, "readFile").mockResolvedValue({
          ok: false,
          error: { code: "file_not_found", message: "read failed" },
        });
      sandboxes.push(sandbox);
      return sandbox;
    }),
    desktop: vi.fn(() => {
      trace.push("desktop");
      if (failure === "desktop-construction") throw new Error("desktop construction failed");
      const desktop = new FakeSandboxDesktop({
        bytes: new Uint8Array([255, 216, 255, 217]),
        width: 1024,
        height: 768,
      }).observe({
        kind: "text",
        text: failure === "dom" ? "Another page" : "<h1>Notes</h1><h1>Notebook cart</h1>",
      });
      if (failure === "desktop")
        desktop.failWith({ code: "unavailable", message: "desktop failed" });
      if (failure === "capture")
        vi.spyOn(desktop, "screenshot").mockResolvedValue({
          ok: false,
          error: { code: "unavailable", message: "capture failed" },
        });
      return desktop;
    }),
    provider: vi.fn(() => {
      trace.push("provider");
      if (failure === "provider-construction") throw new Error("provider construction failed");
      const cart = sandboxes.length > 2;
      const annotation = {
        type: "assertion",
        id: cart ? "quantity-total" : "saved-note-persists",
        expectation: "The requested flow works",
      } as const;
      const batch = (id: string, actions: ComputerAction[]) => ({
        toolCalls: [{ id, name: "computer", input: { actions } }],
      });
      const provider = new ScriptedLLMProvider([
        failure === "runtime"
          ? [{ error: { message: "model failed", retryable: false } }]
          : [
              batch("input", [
                {
                  action: "annotate",
                  annotation: {
                    type: "test_start",
                    id: cart ? "change-quantity" : "save-note",
                    description: "Flow",
                  },
                },
                { action: "annotate", annotation: { ...annotation, result: "untested" } },
                { action: "left_click", coordinate: [100, 100] },
              ]),
              batch("result", [
                { action: "annotate", annotation: { ...annotation, result: "passed" } },
              ]),
              {},
            ],
      ]);
      providers.push(provider);
      return provider;
    }),
  };
  return { factories, sandboxes, providers, trace, bases, localFixtures };
}

it("validates all arguments, credentials, models and limits before touching any factory", async () => {
  const f = apparatus();
  const out = output();
  for (const [args, keys] of [
    [["--real"], env],
    [[...flags, "--keep"], env],
    [flags, {}],
    [flags, { E2B_API_KEY: " ", OPENROUTER_API_KEY: "injected-only" }],
    [flags, { E2B_API_KEY: "injected-only" }],
    [flags.map((arg) => (arg.startsWith("--budget-tokens=") ? "--budget-tokens=1" : arg)), env],
    [flags.map((arg) => (arg.startsWith("--model=") ? "--model=unknown" : arg)), env],
  ] as const) {
    await expect(
      runAppTestCommand({ args: [...args, `--out=${out}`], env: keys, factories: f.factories }),
    ).rejects.toThrow();
  }
  expect(f.factories.sandbox).not.toHaveBeenCalled();
  expect(f.factories.desktop).not.toHaveBeenCalled();
  expect(f.factories.provider).not.toHaveBeenCalled();
  await expect(
    runAppTestCommand({ args: [...flags, `--out=${out}`], env: {}, factories: f.factories }),
  ).rejects.toThrow("E2B_API_KEY");
});

it("rejects an unwritable report destination before factory construction", async () => {
  const f = apparatus();
  const path = dirname(output());
  await expect(
    runAppTestCommand({ args: [...flags, `--out=${path}`], env, factories: f.factories }),
  ).rejects.toThrow();
  expect(f.factories.sandbox).not.toHaveBeenCalled();
});

it("runs the real selection through injected ports, authentic remote commits and production test turns", async () => {
  const f = apparatus();
  const out = output();
  const result = await runAppTestCommand({
    args: [...flags, `--out=${out}`],
    env,
    factories: f.factories,
  });
  expect(result.exitCode).toBe(0);
  expect(result.report).toMatchObject({
    mode: "real",
    execution: "injected",
    modelCapability: null,
    outcomes: { bugsCaught: 0, bugsTested: 2, correctAccepted: 2, correctTested: 2, unmeasured: 0 },
  });
  expect(f.sandboxes).toHaveLength(4);
  const projects = f.sandboxes.map((s) => vi.mocked(s.create).mock.calls[0]?.[0]);
  expect(new Set(projects).size).toBe(4);
  for (const [index, run] of result.report.runs.entries()) {
    expect(run.fixture?.baseSha).toBe(f.bases[index]);
    expect(run.fixture?.commitSha).not.toBe(f.localFixtures[index]?.commitSha);
    expect(run.fixture?.diff).toContain("diff --git a/src/app.js b/src/app.js");
    expect(run.fixture?.diff).not.toContain("template-only.txt");
    expect(f.localFixtures[index]?.git(["show", "HEAD:template-only.txt"])).toContain(
      "Installed template",
    );
    expect(run.events.find((e) => e.type === "test.started")?.payload).toMatchObject({
      commitSha: run.fixture?.commitSha,
    });
    expect(
      run.events.filter((e) => e.type === "turn.started").map((e) => e.payload.source),
    ).toEqual(["test"]);
    expect(run.events.filter((e) => e.type === "job.started")).toHaveLength(1);
    expect(run.cleanup).toMatchObject({ ok: true });
    expect(run.seedOrigin).toBe("harness");
    expect(run.events.find((e) => e.type === "context.usage")?.payload.budgetTokens).toBe(20000);
    expect(f.sandboxes[index]?.destroy).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(f.providers[index]?.requests);
    expect(input).not.toContain(APP_TEST_TASKS[index]?.id);
    expect(input).not.toContain(env.OPENROUTER_API_KEY);
    expect(run.screenshots.length).toBeGreaterThan(0);
    for (const shot of run.screenshots)
      expect(readFileSync(join(dirname(out), shot.path))).toEqual(
        Buffer.from([255, 216, 255, 217]),
      );
  }
  expect(f.trace.indexOf("preview")).toBeLessThan(f.trace.indexOf("job.checkpointed"));
  expect(f.trace.indexOf("job.checkpointed")).toBeLessThan(f.trace.indexOf("provider"));
  expect(JSON.stringify(result.report)).not.toContain(env.OPENROUTER_API_KEY);
  expect(f.factories.provider).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "anthropic/claude-sonnet-5",
      maxOutputTokens: 2000,
      effort: "medium",
    }),
  );
}, 30_000);

it.each([
  "write",
  "syntax",
  "diff",
  "paths",
  "blob",
  "parent",
  "dirty",
  "read",
  "preview",
  "serving",
  "desktop",
  "desktop-construction",
  "dom",
  "capture",
])(
  "destroys its owned VM and makes no model call after %s preparation failure",
  async (failure) => {
    const f = apparatus(failure);
    const result = await runAppTestCommand({
      args: [...flags, "--task=notes-correct", `--out=${output()}`],
      env,
      factories: f.factories,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.runs[0]?.assessment).toMatchObject({ status: "unmeasured", score: null });
    expect(f.factories.provider).not.toHaveBeenCalled();
    expect(f.sandboxes[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(result.report.runs[0]?.events.some((event) => event.type === "job.checkpointed")).toBe(
      false,
    );
  },
);

it.each(["runtime", "provider-construction", "destroy", "destroy-throws", "create", "post-source"])(
  "never treats %s failure as a successful result",
  async (failure) => {
    const f = apparatus(failure);
    const result = await runAppTestCommand({
      args: [...flags, "--task=notes-correct", `--out=${output()}`],
      env,
      factories: f.factories,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.runs[0]?.assessment).toMatchObject({ status: "unmeasured", score: null });
    expect(f.sandboxes[0]?.destroy).toHaveBeenCalledTimes(failure === "create" ? 0 : 1);
  },
);

it("enforces the separately configured production test-step budget", async () => {
  const f = apparatus();
  const result = await runAppTestCommand({
    args: [
      ...flags.filter((flag) => !flag.startsWith("--max-steps=")),
      "--max-steps=1",
      "--task=notes-correct",
      `--out=${output()}`,
    ],
    env,
    factories: f.factories,
  });
  expect(result.report.runs[0]?.assessment).toMatchObject({ status: "unmeasured", score: null });
  expect(result.report.runs[0]?.events.find((e) => e.type === "turn.failed")?.payload.reason).toBe(
    "budget_exceeded",
  );
  expect(f.sandboxes[0]?.destroy).toHaveBeenCalledTimes(1);
});

it("enforces the separately configured production test-token budget", async () => {
  const f = apparatus();
  f.factories.provider = vi.fn(
    () => new ScriptedLLMProvider([[{ usage: { inputTokens: 40001, outputTokens: 0 } }]]),
  );
  const result = await runAppTestCommand({
    args: [...flags, "--task=notes-correct", `--out=${output()}`],
    env,
    factories: f.factories,
  });
  expect(result.report.runs[0]?.events.find((e) => e.type === "turn.failed")?.payload.reason).toBe(
    "budget_exceeded",
  );
  expect(result.report.runs[0]?.assessment).toMatchObject({ status: "unmeasured", score: null });
  expect(f.sandboxes[0]?.destroy).toHaveBeenCalledTimes(1);
});

it("destroys the VM even when screenshot archiving fails after the test", async () => {
  const f = apparatus();
  const out = output();
  writeFileSync(join(dirname(out), "app-test-artifacts"), "Blocked destination");
  const result = await runAppTestCommand({
    args: [...flags, "--task=notes-correct", `--out=${out}`],
    env,
    factories: f.factories,
  });
  expect(result.report.runs[0]?.assessment).toMatchObject({ status: "unmeasured", score: null });
  expect(f.sandboxes[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(result.exitCode).toBe(1);
});
