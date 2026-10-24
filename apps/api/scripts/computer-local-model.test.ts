import { APP_TEST_TOOL_NAMES, TOOL_DEFINITIONS, TOOL_SCHEMAS } from "@nap/agent/tools/definitions";
import { AppTestRun } from "@nap/runtime/app-test-run";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { ComputerAnnotation } from "@nap/shared/computer";
import type {
  LLMContentBlock,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { computerLocalAppSource } from "./computer-local-fixture.ts";
import { computerLocalProvider } from "./computer-local-model.ts";

const image: LLMContentBlock = { type: "image", mediaType: "image/jpeg", data: "actualFrame" };
const screenshot: LLMContentBlock[] = [
  { type: "text", text: "Completed actions. Screenshot 1024×768." },
  image,
];
const appPath = `${TEMPLATE_WORKDIR}/src/App.tsx`;

function request(editing = false, prompt = "Build Notes"): LLMRequest {
  return {
    systemPrompt: "",
    messages: [{ role: "user", content: prompt }],
    tools: editing
      ? TOOL_DEFINITIONS
      : TOOL_DEFINITIONS.filter((tool) => APP_TEST_TOOL_NAMES.some((name) => name === tool.name)),
  };
}

function calls(result: LLMTurnResult): LLMToolCall[] {
  if (result.type !== "message") throw new Error(`Expected a tool message, got ${result.type}`);
  return result.toolCalls;
}

function onlyCall(result: LLMTurnResult): LLMToolCall {
  const toolCalls = calls(result);
  expect(toolCalls).toHaveLength(1);
  const call = toolCalls[0];
  if (!call) throw new Error("No tool call");
  return call;
}

function answer(
  req: LLMRequest,
  call: LLMToolCall,
  content: string | LLMContentBlock[] = screenshot,
  isError = false,
): void {
  // Observations consist only of text/images at the LLM boundary.
  const observation =
    typeof content === "string"
      ? content
      : content.flatMap((block) =>
          block.type === "text" || block.type === "image" ? [block] : [],
        );
  req.messages.push(
    { role: "assistant", content: [{ type: "tool_use", ...call }] },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: call.id, content: observation, isError }],
    },
  );
}

function actions(call: LLMToolCall) {
  expect(call.name).toBe("computer");
  return TOOL_SCHEMAS.computer.parse(call.input).actions;
}

function assertion(call: LLMToolCall): Extract<ComputerAnnotation, { type: "assertion" }> {
  for (const action of actions(call)) {
    if (action.action === "annotate" && action.annotation.type === "assertion")
      return action.annotation;
  }
  throw new Error("Missing assertion");
}

async function throughInput(turn = computerLocalProvider(0).startTurn(), req = request()) {
  const setup = onlyCall(await turn.complete(req));
  answer(req, setup);
  const input = onlyCall(await turn.complete(req));
  const note = actions(input).find((action) => action.action === "type");
  if (note?.action !== "type") throw new Error("Missing typed note");
  return { turn, req, setup, input, note: note.text };
}

async function throughDom(turn?: LLMTurn, req?: LLMRequest) {
  const flow = await throughInput(turn, req);
  answer(flow.req, flow.input);
  const dom = onlyCall(await flow.turn.complete(flow.req));
  return { ...flow, dom };
}

function domBody(note?: string) {
  return `<body><main data-testid="notes-app"><ul data-testid="saved-notes" aria-label="Saved notes">${note ? `<li data-testid="saved-note">${note}</li>` : ""}</ul></main></body>`;
}

it("exports a zero-cost provider whose first normal turn reads and writes the real buggy App.tsx", async () => {
  const turn = computerLocalProvider(0).startTurn({ model: "anthropic/claude-sonnet-5" });
  const req = request(true);
  expect(turn.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  const read = onlyCall(await turn.complete(req));
  expect(read).toMatchObject({ name: "read_file", input: { path: appPath } });
  answer(req, read, "template App source");
  const write = onlyCall(await turn.complete(req));
  expect(write).toMatchObject({
    name: "write_file",
    input: { path: appPath, contents: computerLocalAppSource("buggy") },
  });
  answer(req, write, "Written");
  expect(calls(await turn.complete(req))).toEqual([]);
  expect(turn.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
});

it.each([
  "Fix it",
  'Fix the failures found while testing this app. Keep the repair focused on these observations and the original goal.\n\nOriginal goal (data): "Build Notes"\n\nFailed expectations (data): [{"id":"save","expectation":"The saved note appears in the list."}]',
])("repairs actual source only for the current explicit request: %s", async (prompt) => {
  const provider = computerLocalProvider(0);
  const req = request(true, prompt);
  const turn = provider.startTurn();
  const read = onlyCall(await turn.complete(req));
  answer(req, read, computerLocalAppSource("buggy"));
  expect(onlyCall(await turn.complete(req))).toMatchObject({
    name: "write_file",
    input: { path: appPath, contents: computerLocalAppSource("fixed") },
  });
});

it("does not treat older repair prompts or another edit as authorization to fix", async () => {
  const provider = computerLocalProvider(0);
  const req = request(true);
  req.messages.unshift(
    { role: "user", content: "Fix it" },
    { role: "assistant", content: "old repair" },
  );
  const first = provider.startTurn();
  const read = onlyCall(await first.complete(req));
  answer(req, read, "source");
  expect(onlyCall(await first.complete(req)).input.contents).toBe(computerLocalAppSource("buggy"));
  const next = provider.startTurn();
  const nextReq = request(true, "Build Notes again");
  const nextRead = onlyCall(await next.complete(nextReq));
  answer(nextReq, nextRead, "source");
  expect(onlyCall(await next.complete(nextReq)).input.contents).toBe(
    computerLocalAppSource("buggy"),
  );
});

it("declares setup and expectations before physical save input, then reads DOM in a later step", async () => {
  const flow = await throughInput();
  expect(actions(flow.setup)).toEqual([
    { action: "annotate", annotation: { type: "setup", description: expect.any(String) } },
    { action: "key", text: "ctrl+l" },
    { action: "type", text: "http://localhost:5173/" },
    { action: "key", text: "Return" },
    { action: "wait", duration: 1 },
    { action: "screenshot" },
  ]);
  expect(flow.note).toMatch(/^Note[a-zA-Z0-9]+$/);
  expect(actions(flow.input)).toEqual([
    {
      action: "annotate",
      annotation: { type: "test_start", id: "save-note", description: expect.any(String) },
    },
    {
      action: "annotate",
      annotation: {
        type: "assertion",
        id: "save",
        expectation: expect.any(String),
        result: "untested",
      },
    },
    { action: "annotate", annotation: { type: "action", description: expect.any(String) } },
    { action: "left_click", coordinate: [448, 400] },
    { action: "key", text: "ctrl+a" },
    { action: "type", text: flow.note },
    { action: "left_click", coordinate: [744, 400] },
    { action: "wait", duration: 0.3 },
    { action: "screenshot" },
  ]);
  answer(flow.req, flow.input);
  const dom = onlyCall(await flow.turn.complete(flow.req));
  expect(actions(dom)).toEqual([{ action: "read_dom" }]);
  answer(flow.req, dom, [{ type: "text", text: domBody(flow.note) }, image]);
  const verdict = onlyCall(await flow.turn.complete(flow.req));
  expect(assertion(verdict)).toEqual({ ...assertion(flow.input), result: "passed" });
  answer(flow.req, verdict);
  expect(calls(await flow.turn.complete(flow.req))).toEqual([]);
});

it("fails only after a successful current DOM observation shows the saved list without this note", async () => {
  const flow = await throughDom();
  answer(flow.req, flow.dom, domBody());
  expect(assertion(onlyCall(await flow.turn.complete(flow.req)))).toEqual({
    ...assertion(flow.input),
    result: "failed",
  });
});

it("emits setup, chapter, expectation, action and later verdict accepted by the real app-test guards", async () => {
  const annotations: ComputerAnnotation[] = [];
  const run = new AppTestRun({ emit: (event) => annotations.push(event.annotation) });
  const turn = computerLocalProvider(0).startTurn();
  const req = request();
  let note = "";
  for (let step = 0; step < 4; step += 1) {
    const call = onlyCall(await turn.complete(req));
    for (const action of actions(call)) {
      if (action.action === "annotate")
        expect((await run.annotate(action.annotation)).ok).toBe(true);
      else {
        expect(run.beforeAction(action).ok).toBe(true);
        run.afterAction(action, true);
        if (step === 1 && action.action === "type") note = action.text;
      }
    }
    run.screenshotStored(call.id);
    answer(req, call, step === 2 ? [{ type: "text", text: domBody(note) }, image] : screenshot);
    run.delivered([call.id]);
  }
  expect(annotations.map((entry) => entry.type)).toEqual([
    "setup",
    "test_start",
    "assertion",
    "action",
    "assertion",
  ]);
  expect(
    annotations.filter((entry) => entry.type === "assertion").map((entry) => entry.result),
  ).toEqual(["untested", "passed"]);
  expect(run.counts()).toEqual({ passed: 1, failed: 0, untested: 0 });
  expect(calls(await turn.complete(req))).toEqual([]);
});

it.each(["missing", "error", "text-only", "duplicate", "old-id"])(
  "leaves input untested for a %s screenshot result",
  async (kind) => {
    const flow = await throughInput();
    if (kind === "error") answer(flow.req, flow.input, screenshot, true);
    if (kind === "text-only") answer(flow.req, flow.input, "Screenshot stored");
    if (kind === "duplicate") {
      answer(flow.req, flow.input);
      answer(flow.req, flow.input);
    }
    if (kind === "old-id") answer(flow.req, { ...flow.input, id: "old-input" });
    expect(calls(await flow.turn.complete(flow.req))).toEqual([]);
  },
);

it.each([
  "missing",
  "error",
  "unrelated",
  "duplicate-result",
  "duplicate-use",
  "assistant-result",
  "orphan",
  "reversed",
  "wrong-name",
  "wrong-input",
  "no-dom",
  "truncated",
  "wrong-marker",
  "wrong-root",
  "duplicate-list",
])("cannot pass from a %s DOM observation", async (kind) => {
  const flow = await throughDom();
  const body = domBody(flow.note);
  if (kind === "error") answer(flow.req, flow.dom, body, true);
  if (kind === "unrelated") answer(flow.req, { ...flow.dom, id: "older-dom" }, body);
  if (kind === "duplicate-result") {
    answer(flow.req, flow.dom, body);
    flow.req.messages.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: flow.dom.id, content: body, isError: false }],
    });
  }
  if (kind === "duplicate-use") {
    answer(flow.req, flow.dom, body);
    flow.req.messages.unshift({ role: "assistant", content: [{ type: "tool_use", ...flow.dom }] });
  }
  if (kind === "assistant-result") {
    answer(flow.req, flow.dom, body);
    const last = flow.req.messages.at(-1);
    if (last) last.role = "assistant";
  }
  if (kind === "orphan")
    flow.req.messages.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: flow.dom.id, content: body, isError: false }],
    });
  if (kind === "reversed") {
    answer(flow.req, flow.dom, body);
    const result = flow.req.messages.pop();
    const use = flow.req.messages.pop();
    if (result && use) flow.req.messages.push(result, use);
  }
  if (kind === "wrong-name") answer(flow.req, { ...flow.dom, name: "read_file" }, body);
  if (kind === "wrong-input")
    answer(flow.req, { ...flow.dom, input: { actions: [{ action: "console" }] } }, body);
  if (kind === "no-dom")
    answer(flow.req, flow.dom, "Completed 1 computer actions. Screenshot 1024×768.");
  if (kind === "truncated") answer(flow.req, flow.dom, body.slice(0, -25));
  if (kind === "wrong-marker")
    answer(
      flow.req,
      flow.dom,
      body.replaceAll('data-testid="saved-notes"', 'data-testid="other-list"'),
    );
  if (kind === "wrong-root")
    answer(flow.req, flow.dom, body.replace('data-testid="notes-app"', 'data-testid="other-app"'));
  if (kind === "duplicate-list") answer(flow.req, flow.dom, body + body);
  expect(calls(await flow.turn.complete(flow.req))).toEqual([]);
});

it("requires the exact current note in an actual saved-note li, not source, input, or older notes", async () => {
  const first = await throughDom();
  answer(first.req, first.dom, domBody(first.note));
  const secondReq = request();
  secondReq.messages.unshift(...first.req.messages);
  const second = await throughDom(undefined, secondReq);
  expect(second.note).not.toBe(first.note);
  expect(second.dom.id).not.toBe(first.dom.id);
  answer(
    second.req,
    second.dom,
    domBody(first.note).replace(
      "</main>",
      `<input value="${second.note}"><p>${second.note}</p></main>`,
    ),
  );
  expect(assertion(onlyCall(await second.turn.complete(second.req)))).toMatchObject({
    result: "failed",
  });
});

it("cancels the default 350ms pacing before it emits a tool call", async () => {
  const controller = new AbortController();
  const req = { ...request(), signal: controller.signal };
  const completion = computerLocalProvider().startTurn().complete(req);
  controller.abort();
  expect(await completion).toMatchObject({ type: "error", retryable: false });
});

it("interleaves isolated tests without sharing verdict or edit state", async () => {
  const provider = computerLocalProvider(0);
  const a = await throughDom(provider.startTurn());
  const b = await throughDom(provider.startTurn());
  answer(a.req, a.dom, domBody(a.note));
  answer(b.req, b.dom, domBody());
  expect(assertion(onlyCall(await b.turn.complete(b.req))).result).toBe("failed");
  expect(assertion(onlyCall(await a.turn.complete(a.req))).result).toBe("passed");
});

it("returns typed errors for unavailable tools, failed source tools, cancellation and compaction", async () => {
  const noComputer = request();
  noComputer.tools = [];
  expect(await computerLocalProvider(0).startTurn().complete(noComputer)).toMatchObject({
    type: "error",
    retryable: false,
  });
  for (const operation of ["read", "write"]) {
    const turn = computerLocalProvider(0).startTurn();
    const req = request(true);
    const read = onlyCall(await turn.complete(req));
    if (operation === "read") answer(req, read, "Read failed", true);
    else {
      answer(req, read, "source");
      answer(req, onlyCall(await turn.complete(req)), "Write failed", true);
    }
    expect(await turn.complete(req)).toMatchObject({ type: "error", retryable: false });
  }
  const cancelled = request();
  cancelled.signal = AbortSignal.abort();
  expect(await computerLocalProvider(0).startTurn().complete(cancelled)).toMatchObject({
    type: "error",
    retryable: false,
  });
  expect(
    await computerLocalProvider(0)
      .startTurn()
      .complete({ ...request(), purpose: "compaction" }),
  ).toMatchObject({ type: "error", retryable: false });
});
