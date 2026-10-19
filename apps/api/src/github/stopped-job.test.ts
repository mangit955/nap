import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryGitHubStore } from "@nap/db/testing/in-memory-github-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import type { GitHubInstallation } from "@nap/shared/github-protocol";
import { foldJobs } from "@nap/shared/job-state";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it } from "vitest";
import { GitHubIntegration } from "./integration.ts";

/**
 * Stopping a repository turn halfway leaves its edits in the workspace, uncommitted. That is the
 * right thing to keep — and it must not then stop every later message from running, which is
 * what refusing a dirty workspace at the start of a job did.
 *
 * The real runtime and the real integration; only the sandbox, the model and GitHub are fakes,
 * and GitHub is never reached because the session's access is stubbed as granted.
 */
async function fixture(options: { startOn?: "job" | "base" } = {}) {
  const sessionId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0 }),
      seed: { "/home/user/app/package.json": '{"scripts":{"typecheck":"tsc"}}' },
    }),
  );
  const created = await sandbox.create(projectId);
  if (!created.ok) throw new Error("fixture sandbox");
  const sandboxId = created.value.id;
  const sessions = new InMemorySessionStore([{ sessionId, projectId, userId, sandboxId }]);
  const events = new InMemoryEventStore();
  const store = new InMemoryGitHubStore();
  const repository = { id: 123, fullName: "org/app", defaultBranch: "main", private: true };
  const installation: GitHubInstallation = {
    installationId: 99,
    userId,
    githubUserId: 7,
    githubLogin: "owner",
    accountLogin: "org",
    accountType: "Organization",
    status: "active",
  };
  await store.bindInstallation(installation);
  store.putRepository({
    projectId,
    sessionId,
    userId,
    installationId: 99,
    repository,
    baseBranch: "main",
    autoPublish: false,
    environment: { setupCommand: null, devCommand: null, previewPort: null },
  });
  const integration = new GitHubIntegration({
    store,
    app: null,
    broker: {
      fetch: async () => {
        throw new Error("Unexpected remote fetch");
      },
      push: async () => {
        throw new Error("Unexpected remote push");
      },
    },
    sandbox,
    sessions,
    objects: new InMemoryObjectStore(),
    snapshots: new InMemorySnapshotStore(),
    events,
    bus: new InMemoryEventBus(),
  });
  integration.authorize = async () => ({ ok: true, value: { installation, repository } });

  // Just enough Git to tell a dirty tree and the checked-out branch apart.
  const git = { dirty: false, branch: "main", checkouts: [] as string[] };
  sandbox.script(/status --porcelain/, () => ({
    exitCode: 0,
    stdout: git.dirty ? " M src/app.ts" : "",
  }));
  sandbox.script(/rev-parse HEAD/, () => ({ exitCode: 0, stdout: FAKE_COMMIT_SHA }));
  sandbox.script(/symbolic-ref --short HEAD/, () => ({ exitCode: 0, stdout: git.branch }));
  sandbox.script(/checkout -b/, (command) => {
    git.branch = command.match(/checkout -b '([^']+)'/)?.[1] ?? "missing-branch";
    git.checkouts.push(git.branch);
    return { exitCode: 0 };
  });

  const stop = new AbortController();
  const agent = new ScriptedAgent((request) =>
    request.signal?.aborted
      ? [
          { type: "turn.started", payload: {} },
          {
            type: "turn.failed",
            payload: { reason: "cancelled", message: "Stopped by the user." },
          },
        ]
      : completedTurn(FAKE_COMMIT_SHA),
  );
  agent.before = async () => {
    if (agent.calls !== 1) return;
    await sandbox.writeFile(sandboxId, "/home/user/app/src/app.ts", "partially edited work\n");
    git.dirty = true;
    if (options.startOn === "base") git.branch = "main";
    stop.abort();
  };
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    events,
    objects: new InMemoryObjectStore(),
    snapshots: new InMemorySnapshotStore(),
    repository: integration,
    agent,
    context: new StubContextEngine(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
  return {
    sessionId,
    projectId,
    userId,
    sandbox,
    sandboxId,
    events,
    store,
    git,
    agent,
    runtime,
    stop,
  };
}

it("continues a stopped job's unfinished edits on its branch with the next message", async () => {
  const f = await fixture();

  const first = await f.runtime.runTurn({
    sessionId: f.sessionId,
    turnId: crypto.randomUUID(),
    message: "Change the app",
    signal: f.stop.signal,
  });
  expect(first).toMatchObject({ ok: false, reason: "cancelled" });
  const stoppedBranch = f.git.branch;

  const second = await f.runtime.runTurn({
    sessionId: f.sessionId,
    turnId: crypto.randomUUID(),
    message: "Continue the unfinished changes",
  });

  expect(second.ok).toBe(true);
  expect(f.agent.calls).toBe(2);
  // The edits were neither discarded nor moved: the same branch, no second checkout.
  expect(f.git.branch).toBe(stoppedBranch);
  expect(f.git.checkouts).toEqual([stoppedBranch]);
  expect(await f.sandbox.readFile(f.sandboxId, "/home/user/app/src/app.ts")).toMatchObject({
    ok: true,
    value: "partially edited work\n",
  });
  const jobs = await f.store.jobs(f.projectId, f.userId);
  expect(jobs.map((job) => job.headBranch)).toEqual([stoppedBranch, stoppedBranch]);
  expect(foldJobs(await f.events.readFrom(f.sessionId, 0)).jobs.map((job) => job.phase)).toEqual([
    "abandoned",
    "verified",
  ]);
});

it("carries unfinished edits on the base branch onto a fresh job branch", async () => {
  // Edits made before any job branch existed belong to no earlier job; a new branch from the
  // same commit takes them along without touching the working tree.
  const f = await fixture({ startOn: "base" });
  f.git.dirty = true;
  f.agent.before = async () => {};

  const turn = await f.runtime.runTurn({
    sessionId: f.sessionId,
    turnId: crypto.randomUUID(),
    message: "Finish what I started",
  });

  expect(turn.ok).toBe(true);
  expect(f.git.checkouts).toHaveLength(1);
  expect(f.git.branch).toMatch(/^nap\//);
});
