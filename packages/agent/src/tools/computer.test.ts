import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NapEventSchema } from "@nap/shared/events";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it, vi } from "vitest";
import { NapAgentService } from "../agent-service.ts";
import { ScriptedLLMProvider } from "../testing/scripted-llm-provider.ts";
import { executeTool, type ToolContext } from "./execute.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const turnId = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
function fixture() {
  const desktop = new FakeSandboxDesktop({
    bytes: new Uint8Array([255, 216, 255, 217]),
    width: 1024,
    height: 768,
  });
  const objects = new InMemoryObjectStore();
  const events: PendingEvent[] = [];
  const context: ToolContext = {
    sessionId,
    turnId,
    sandboxId: "sandbox",
    sandbox: new InMemorySandboxManager(),
    emit: (event) => events.push(event),
    computer: { desktop, objects, projectId: "project", devServerUrl: "http://localhost:5173" },
  };
  return { desktop, objects, events, context };
}
const call = (actions: unknown[]) => ({ id: "screen", name: "computer", input: { actions } });

describe("computer tool", () => {
  it("executes a whole batch in order and stores one final JPEG before emitting its key", async () => {
    const { desktop, objects, events, context } = fixture();
    const actions: DesktopAction[] = [
      { action: "key", text: "ctrl+l" },
      { action: "type", text: "private typed value" },
      { action: "wait", duration: 3 },
      { action: "screenshot" },
    ];
    const journal: string[] = [];
    const put = objects.put.bind(objects);
    vi.spyOn(objects, "put").mockImplementation(async (...args) => {
      const stored = await put(...args);
      journal.push("stored");
      return stored;
    });
    const emit = context.emit;
    context.emit = (event) => {
      if (event.type === "computer.screenshot") journal.push("screenshot");
      emit(event);
    };
    const result = await executeTool(call(actions), context);
    expect(journal).toEqual(["stored", "screenshot"]);
    expect(result.ok).toBe(true);
    expect(desktop.actions.map((entry) => entry.action)).toEqual(
      actions.filter((action) => action.action !== "screenshot"),
    );
    expect(desktop.screenshots).toEqual(["sandbox"]);
    expect(events.map((event) => event.type)).toEqual([
      "tool.call",
      "computer.status",
      "computer.status",
      "computer.screenshot",
      "tool.result",
    ]);
    const screenshot = events.find((event) => event.type === "computer.screenshot");
    expect(screenshot?.type).toBe("computer.screenshot");
    if (screenshot?.type !== "computer.screenshot") throw new Error("Missing screenshot");
    expect(await objects.get(screenshot.payload.key)).toEqual({
      ok: true,
      value: new Uint8Array([255, 216, 255, 217]),
    });
    expect(result.content).toContainEqual({
      type: "image",
      mediaType: "image/jpeg",
      data: "/9j/2Q==",
    });
    expect(JSON.stringify(events)).not.toContain("/9j/2Q==");
    expect(result.output).not.toContain("private typed value");
    for (const event of events)
      expect(NapEventSchema.safeParse({ ...event, seq: 1 }).success).toBe(true);
  });

  it.each([
    [
      { action: "left_click", coordinate: [1, 2] },
      { action: "left_click", coordinate: [1024, 2] },
    ],
    [{ action: "javascript", text: "document.body.remove()" }],
    [],
    Array.from({ length: 33 }, () => ({ action: "screenshot" })),
  ])("rejects an invalid batch before starting the machine", async (...actions) => {
    const { desktop, events, context } = fixture();
    const result = await executeTool(
      call(actions.length === 1 && Array.isArray(actions[0]) ? actions[0] : actions),
      context,
    );
    expect(result.ok).toBe(false);
    expect(desktop.starts).toEqual([]);
    expect(desktop.screenshots).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["tool.call", "tool.result"]);
  });

  it("does not publish a screenshot when object storage refuses the upload", async () => {
    const { objects, events, context } = fixture();
    vi.spyOn(objects, "put").mockResolvedValue({
      ok: false,
      error: { code: "unavailable", message: "offline" },
    });
    const result = await executeTool(call([{ action: "screenshot" }]), context);
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    expect(events.some((event) => event.type === "computer.screenshot")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "tool.result", payload: { ok: false } });
  });

  it("stops a cancelled batch before the next action or screenshot", async () => {
    const { desktop, context } = fixture();
    const controller = new AbortController();
    const act = desktop.act.bind(desktop);
    vi.spyOn(desktop, "act").mockImplementation(async (...args) => {
      const result = await act(...args);
      controller.abort();
      return result;
    });
    const result = await executeTool(
      call([
        { action: "left_click", coordinate: [1, 2] },
        { action: "type", text: "later" },
      ]),
      { ...context, signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(desktop.actions).toHaveLength(1);
    expect(desktop.screenshots).toEqual([]);
  });

  it.each(["anthropic/claude-sonnet-5", "unknown-text-model"])(
    "gates model tools and image results for %s",
    async (model) => {
      const { desktop, context, events } = fixture();
      const provider = new ScriptedLLMProvider([
        [{ toolCalls: [call([{ action: "screenshot" }])] }, {}],
      ]);
      await new NapAgentService({ provider }).runTurn({
        sessionId,
        turnId,
        sandboxId: "sandbox",
        sandbox: context.sandbox,
        computer: context.computer,
        model,
        context: { systemPrompt: "Build", messages: [], estimatedTokens: 1 },
        onEvent: (event) => events.push(event),
      });
      const enabled = model === "anthropic/claude-sonnet-5";
      expect(provider.requests[0]?.tools.some((tool) => tool.name === "computer")).toBe(enabled);
      expect(desktop.screenshots).toHaveLength(enabled ? 1 : 0);
      const result = provider.requests[1]?.messages.at(-1);
      expect(JSON.stringify(result)).toContain(enabled ? '"type":"image"' : '"isError":true');
    },
  );
});

it("admits annotations only through a test-mode handler and keeps them in batch order", async () => {
  const { context, desktop } = fixture();
  const actions = [
    {
      action: "annotate",
      annotation: {
        type: "assertion",
        id: "sign-in",
        expectation: "Project list appears",
        result: "untested",
      },
    },
    { action: "left_click", coordinate: [100, 200] },
  ];
  expect((await executeTool(call(actions), context)).ok).toBe(false);
  expect(desktop.starts).toEqual([]);
  const annotate = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const result = await executeTool(call(actions), {
    ...context,
    computer: { ...context.computer!, annotate },
  });
  expect(result.ok).toBe(true);
  expect(annotate).toHaveBeenCalledWith(actions[0]?.annotation);
  expect(desktop.actions).toHaveLength(1);
});
