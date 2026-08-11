import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { type Logger, setRootLogger, withLogContext } from "@nap/shared/logging";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

/**
 * The observability claim, asserted where it is actually made: grep one `turnId` and the turn
 * can be followed from the logs. Everything below the runtime — the sandbox manager, the
 * context engine, the agent loop — takes no logger, so the only thing that can put the ids on
 * their lines is the ambient context this opens.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

type Line = { level: string; fields: Record<string, unknown>; message: string };

function recorder(bindings: Record<string, unknown> = {}, lines: Line[] = []) {
  const at =
    (level: string) =>
    (first: object | string, second?: string): void => {
      lines.push(
        typeof first === "string"
          ? { level, fields: { ...bindings }, message: first }
          : { level, fields: { ...bindings, ...first }, message: second ?? "" },
      );
    };

  const logger: Logger = {
    child: (extra) => recorder({ ...bindings, ...extra }, lines).logger,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };

  return { logger, lines };
}

/** Every command `commitAll` issues, answered so a turn can commit without a real git. */
function scriptGit(manager: InMemorySandboxManager): InMemorySandboxManager {
  return manager
    .script(/git add -A/, { exitCode: 0 })
    .script(/git diff --cached --quiet/, { exitCode: 1 })
    .script(/git .*commit -m/, { exitCode: 0 })
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${COMMIT_SHA}\n` });
}

class StubContextEngine implements ContextEngine {
  async build(_request: ContextRequest) {
    return { systemPrompt: "", messages: [], estimatedTokens: 0 };
  }
}

/** Emits a scripted turn, including a failing tool call, so a whole shape can be asserted. */
class ScriptedAgent implements AgentService {
  constructor(private readonly script: () => { type: string; payload: unknown }[]) {}

  async runTurn(request: AgentTurnRequest): Promise<void> {
    for (const event of this.script()) {
      request.onEvent({
        ...event,
        sessionId: request.sessionId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as PendingEvent);
    }
  }
}

const A_WHOLE_TURN = () => [
  { type: "turn.started", payload: {} },
  {
    type: "tool.call",
    payload: { toolCallId: "c1", toolName: "run_command", input: { command: "bun run build" } },
  },
  { type: "command.output", payload: { toolCallId: "c1", stream: "stderr", chunk: "boom" } },
  {
    type: "tool.result",
    payload: { toolCallId: "c1", toolName: "run_command", ok: false, output: "exit 1" },
  },
  {
    type: "file.changed",
    payload: { path: "src/App.tsx", changeType: "modified", diff: "@@ -1 +1 @@" },
  },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 12480, outputTokens: 1340 },
      durationMs: 18400,
      commitSha: COMMIT_SHA,
    },
  },
];

let sink: ReturnType<typeof recorder>;

beforeEach(() => {
  sink = recorder();
  setRootLogger(sink.logger);
});

afterEach(() => {
  setRootLogger(recorder().logger);
});

function runTurn(script = A_WHOLE_TURN, sessionId = SESSION_ID) {
  return new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]),
    sandbox: scriptGit(new InMemorySandboxManager()),
    context: new StubContextEngine(),
    agent: new ScriptedAgent(script),
    events: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  }).runTurn({ sessionId, message: "make the build pass" });
}

describe("a turn's logs", () => {
  it("puts the turn's ids on every line it writes", async () => {
    await runTurn();

    expect(sink.lines.length).toBeGreaterThan(0);
    for (const line of sink.lines) {
      expect(line.fields).toMatchObject({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        turnId: expect.any(String),
      });
    }
  });

  it("uses one turn id for the whole turn, so grepping it finds all of it", async () => {
    await runTurn();

    const turnIds = new Set(sink.lines.map((line) => line.fields.turnId));
    expect(turnIds.size).toBe(1);
  });

  it("keeps two turns' lines apart", async () => {
    await runTurn();
    const first = sink.lines[0]?.fields.turnId;
    sink.lines.length = 0;

    await runTurn();
    expect(sink.lines[0]?.fields.turnId).not.toBe(first);
  });

  it("records the turn's shape: which tools ran, what changed, and how it ended", async () => {
    await runTurn();

    // The "Done when" in the plan, made concrete — this sequence is what someone holding only
    // a turn id gets back.
    expect(sink.lines.map((line) => line.fields.eventType ?? line.message)).toEqual([
      "turn started",
      "user.message",
      "turn.started",
      "tool.call",
      "command.output",
      "tool.result",
      "file.changed",
      "turn.completed",
    ]);
  });

  it("records what the turn cost and how long it took", async () => {
    await runTurn();

    const completed = sink.lines.find((line) => line.fields.eventType === "turn.completed");
    expect(completed?.fields).toMatchObject({
      durationMs: 18400,
      inputTokens: 12480,
      outputTokens: 1340,
      commitSha: COMMIT_SHA,
    });
  });

  it("says which tool failed, and at what level", async () => {
    await runTurn();

    const result = sink.lines.find((line) => line.fields.eventType === "tool.result");
    expect(result?.fields).toMatchObject({ toolName: "run_command", ok: false });
  });

  it("inherits the context of whatever started the turn", async () => {
    // A turn is started inside a request and runs on long after the 202 was sent. The request
    // id and the user are what tie the turn back to the person who asked for it.
    await withLogContext(sink.logger, { requestId: "r1", userId: "u1" }, () => runTurn());

    for (const line of sink.lines) {
      expect(line.fields).toMatchObject({ requestId: "r1", userId: "u1" });
    }
  });

  it("reports a turn that never started, which emits no events to be read later", async () => {
    // The one failure with nothing in the event log: there is no session for an event to
    // belong to, so the log line is the only trace it ever happened.
    await runTurn(A_WHOLE_TURN, "11111111-2222-4333-8444-555555555555");

    expect(sink.lines.map((line) => [line.level, line.message])).toContainEqual([
      "warn",
      "turn refused: no such session",
    ]);
  });
});
