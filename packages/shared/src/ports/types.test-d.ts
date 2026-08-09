import { expectTypeOf } from "vitest";
import type { NapEvent, NapEventType, ToolName } from "../events.ts";
import type { Result } from "../result.ts";
import type { AgentService, AgentTurnRequest } from "./agent-service.ts";
import type { BuiltContext, ContextEngine, ContextRequest } from "./context-engine.ts";
import type { EventBus, Unsubscribe } from "./event-bus.ts";
import type { EventStore, PendingEvent, StoredEvent } from "./event-store.ts";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMToolDefinition,
  LLMTurn,
  LLMTurnResult,
  TokenUsage,
} from "./llm-provider.ts";
import type { Memory, MemoryProvider } from "./memory-provider.ts";
import type { Runtime, TurnOutcome } from "./runtime.ts";
import type {
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "./sandbox-manager.ts";

/**
 * Contract tests for the ports. These are the seams that keep v2 additive, so the
 * shape of each one is asserted rather than left to whatever an implementation
 * happens to compile against.
 *
 * Two things are checked per port: the declared shape, and that a hand-written stub
 * satisfies it. The stub half is the one that catches a signature nobody can actually
 * implement — an interface with no implementor is not yet known to be implementable.
 */

// ---------------------------------------------------------------------------
// Result — the shared shape for expected failures
// ---------------------------------------------------------------------------

expectTypeOf<Result<number, string>>().toEqualTypeOf<
  { ok: true; value: number } | { ok: false; error: string }
>();

// Narrowing on `ok` must work, or every call site needs a cast.
declare const someResult: Result<number, SandboxError>;
if (someResult.ok) {
  expectTypeOf(someResult.value).toEqualTypeOf<number>();
} else {
  expectTypeOf(someResult.error).toEqualTypeOf<SandboxError>();
}

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

expectTypeOf<SandboxManager["create"]>().toBeCallableWith("project_1");
expectTypeOf<SandboxManager["resume"]>().toBeCallableWith("sandbox_1");
expectTypeOf<SandboxManager["destroy"]>().toBeCallableWith("sandbox_1");

// A missing file is an expected failure, so it is a Result — never a throw.
expectTypeOf<SandboxManager["readFile"]>().returns.resolves.toEqualTypeOf<
  Result<string, SandboxError>
>();

// exec streams output through a callback and resolves with an exit code.
expectTypeOf<SandboxManager["exec"]>().returns.resolves.toEqualTypeOf<
  Result<ExecResult, SandboxError>
>();
expectTypeOf<ExecResult["exitCode"]>().toEqualTypeOf<number>();

expectTypeOf<SandboxManager["listFiles"]>().returns.resolves.toEqualTypeOf<
  Result<FileNode[], SandboxError>
>();

const sandboxStub: SandboxManager = {
  create: async () => ({ ok: true, value: { id: "sandbox_1", projectId: "project_1" } }),
  resume: async () => ({ ok: true, value: { id: "sandbox_1", projectId: "project_1" } }),
  destroy: async () => ({ ok: true, value: undefined }),
  writeFile: async () => ({ ok: true, value: undefined }),
  readFile: async () => ({ ok: true, value: "contents" }),
  listFiles: async () => ({ ok: true, value: [] }),
  exec: async () => ({ ok: true, value: { exitCode: 0, stdout: "", stderr: "" } }),
  getPreviewUrl: async () => ({ ok: true, value: "https://5173-abc.e2b.dev" }),
  waitForPreview: async () => ({ ok: true, value: "https://5173-abc.e2b.dev" }),
};
expectTypeOf(sandboxStub).toExtend<SandboxManager>();
expectTypeOf<Sandbox>().toHaveProperty("id");

// ---------------------------------------------------------------------------
// EventStore / EventBus
// ---------------------------------------------------------------------------

// append assigns the seq, so it takes an event without one and returns the stored form.
expectTypeOf<EventStore["append"]>().returns.resolves.toEqualTypeOf<StoredEvent>();
expectTypeOf<StoredEvent>().toEqualTypeOf<NapEvent>();
expectTypeOf<EventStore["readFrom"]>().returns.resolves.toEqualTypeOf<NapEvent[]>();

const storeStub: EventStore = {
  append: async (event) => ({ ...event, seq: 0 }),
  readFrom: async () => [],
};
expectTypeOf(storeStub).toExtend<EventStore>();

// subscribe hands back an unsubscribe function; nothing else is a valid return.
expectTypeOf<EventBus["subscribe"]>().returns.toEqualTypeOf<Unsubscribe>();
expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>();

const busStub: EventBus = {
  publish: () => {},
  subscribe: () => () => {},
};
expectTypeOf(busStub).toExtend<EventBus>();

// ---------------------------------------------------------------------------
// MemoryProvider — inert in v1, but the call sites are real
// ---------------------------------------------------------------------------

expectTypeOf<MemoryProvider["retrieve"]>().returns.resolves.toEqualTypeOf<Memory[]>();
expectTypeOf<MemoryProvider["write"]>().returns.resolves.toEqualTypeOf<void>();

const noopMemoryStub: MemoryProvider = {
  retrieve: async () => [],
  write: async () => {},
};
expectTypeOf(noopMemoryStub).toExtend<MemoryProvider>();

// ---------------------------------------------------------------------------
// ContextEngine
// ---------------------------------------------------------------------------

expectTypeOf<ContextEngine["build"]>().returns.resolves.toEqualTypeOf<BuiltContext>();
expectTypeOf<BuiltContext["systemPrompt"]>().toEqualTypeOf<string>();

// Conversation history arrives as data, not as a store to read from — see the note on
// `ContextRequest`. Pinned here because the difference is what keeps assembly free of I/O.
expectTypeOf<ContextRequest["history"]>().toEqualTypeOf<StoredEvent[]>();

const contextStub: ContextEngine = {
  build: async () => ({ systemPrompt: "", messages: [], estimatedTokens: 0 }),
};
expectTypeOf(contextStub).toExtend<ContextEngine>();

// ---------------------------------------------------------------------------
// LLMProvider — model config and policy, deliberately not a cross-vendor swap
// ---------------------------------------------------------------------------

// A turn is a handle, not a mode you switch on and off: usage cannot leak between turns
// because a fresh handle has nowhere to leak from.
expectTypeOf<LLMProvider["startTurn"]>().returns.toEqualTypeOf<LLMTurn>();
expectTypeOf<LLMTurn["complete"]>().returns.resolves.toEqualTypeOf<LLMTurnResult>();
expectTypeOf<LLMTurn["usage"]>().returns.toEqualTypeOf<TokenUsage>();
expectTypeOf<TokenUsage>().toEqualTypeOf<{ inputTokens: number; outputTokens: number }>();

// A refusal is an expected outcome with its own branch, not an exception and not
// something a caller can reach by indexing into content.
declare const llmResult: LLMTurnResult;
if (llmResult.type === "refusal") {
  expectTypeOf(llmResult.usage).toEqualTypeOf<TokenUsage>();
}

// Message content is either plain prose or a block list. The block list is what carries a
// tool loop: without it there is no way to send back what a tool returned, and the
// `toolCalls` on a result would be unanswerable.
expectTypeOf<LLMMessage["content"]>().toEqualTypeOf<string | LLMContentBlock[]>();
expectTypeOf<Extract<LLMContentBlock, { type: "tool_result" }>>().toEqualTypeOf<{
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}>();

// Tools have to reach the model for a tool call to ever come back.
expectTypeOf<LLMRequest["tools"]>().toEqualTypeOf<LLMToolDefinition[]>();

// ---------------------------------------------------------------------------
// AgentService
// ---------------------------------------------------------------------------

// onEvent receives events that have not been persisted yet, so they carry no seq.
expectTypeOf<AgentTurnRequest["onEvent"]>().parameter(0).toEqualTypeOf<PendingEvent>();
expectTypeOf<AgentTurnRequest>().toHaveProperty("signal");

// Dropping `seq` must not flatten the union. If it does, `type` and `payload` stop being
// correlated — a `tool.call` would accept a `turn.failed` payload — and the bug is
// invisible until something tries to reconstruct a NapEvent. Both directions are asserted.
declare const pending: Extract<PendingEvent, { type: "tool.call" }>;
expectTypeOf(pending.payload).toEqualTypeOf<{
  toolCallId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
}>();
expectTypeOf<PendingEvent & { seq: number }>().toExtend<NapEvent>();

const agentStub: AgentService = {
  runTurn: async () => {},
};
expectTypeOf(agentStub).toExtend<AgentService>();

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

expectTypeOf<Runtime["runTurn"]>().returns.resolves.toEqualTypeOf<TurnOutcome>();

// A turn either completed or failed; a failure names a reason from the event union
// rather than inventing a parallel vocabulary.
declare const outcome: TurnOutcome;
if (!outcome.ok) {
  expectTypeOf(outcome.reason).toExtend<string>();
}

const runtimeStub: Runtime = {
  runTurn: async () => ({ ok: true, turnId: "turn_1", commitSha: null }),
};
expectTypeOf(runtimeStub).toExtend<Runtime>();

// ---------------------------------------------------------------------------
// The ports must not drift from the event contract
// ---------------------------------------------------------------------------

expectTypeOf<NapEventType>().toExtend<string>();
