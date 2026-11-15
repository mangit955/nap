import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { verifyNapProvider } from "./verify-nap-model.ts";

const request = (messages: LLMRequest["messages"], purpose?: LLMRequest["purpose"]) => ({
  systemPrompt: "",
  messages,
  tools: [{ name: "write_file", description: "", inputSchema: {} }],
  ...(purpose === undefined ? {} : { purpose }),
});

it("answers title requests without tools, never twice with the same title", async () => {
  const provider = verifyNapProvider({ stepDelayMs: 0 });
  const title = () =>
    provider.startTurn({}).complete(request([{ role: "user", content: "a notes app" }], "title"));
  const first = await title();
  const second = await title();
  expect(first.type === "message" && first.toolCalls).toEqual([]);
  expect(first.type === "message" && first.text).toBe("Fixture title 001");
  expect(second.type === "message" && second.text).toBe("Fixture title 002");
});

it("writes files over several steps, then answers naming the newest user message", async () => {
  const turn = verifyNapProvider({ stepDelayMs: 0 }).startTurn({});
  const first = await turn.complete(request([{ role: "user", content: "build notes" }]));
  const second = await turn.complete(request([{ role: "user", content: "build notes" }]));
  expect(first.type === "message" && first.toolCalls.map((call) => call.name)).toEqual([
    "write_file",
  ]);
  expect(second.type === "message" && second.toolCalls.map((call) => call.name)).toEqual([
    "write_file",
  ]);
  const last = await turn.complete(
    request([
      { role: "user", content: "build notes" },
      { role: "user", content: [{ type: "text", text: "make the button blue" }] },
    ]),
  );
  expect(last.type === "message" && last.toolCalls).toEqual([]);
  expect(last.type === "message" && last.text).toContain("make the button blue");
});

it("quotes the person's words, not the context wrapped around them", async () => {
  const turn = verifyNapProvider({ stepDelayMs: 0 }).startTurn({});
  await turn.complete(request([{ role: "user", content: "x" }]));
  await turn.complete(request([{ role: "user", content: "x" }]));
  const last = await turn.complete(
    request([
      {
        role: "user",
        content:
          '<message_from_user sent_while_you_worked="true">\nUse a blue button\n</message_from_user>\nThe person sent this while you were working.',
      },
    ]),
  );
  expect(last.type === "message" && last.text).toBe(
    'Done. The newest message I read was: "Use a blue button"',
  );
});

it("writes new files on later turns, since overwriting needs a read first", async () => {
  const provider = verifyNapProvider({ stepDelayMs: 0 });
  const paths = async () => {
    const turn = provider.startTurn({});
    const written: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await turn.complete(request([{ role: "user", content: "go" }]));
      if (result.type === "message") written.push(...result.toolCalls.map((c) => c.input.path));
    }
    return written;
  };
  const first = await paths();
  const second = await paths();
  expect(second.filter((path) => first.includes(path))).toEqual([]);
});

it("numbers files by agent turns alone, so titling does not shift them", async () => {
  const provider = verifyNapProvider({ stepDelayMs: 0 });
  await provider.startTurn({}).complete(request([{ role: "user", content: "x" }], "title"));
  const first = await provider.startTurn({}).complete(request([{ role: "user", content: "go" }]));
  await provider.startTurn({}).complete(request([{ role: "user", content: "x" }], "title"));
  const second = await provider.startTurn({}).complete(request([{ role: "user", content: "go" }]));
  expect(first.type === "message" && first.toolCalls[0]?.input.path).toMatch(/App\.tsx$/);
  expect(second.type === "message" && second.toolCalls[0]?.input.path).toMatch(/Change2\.tsx$/);
});

it("waits its step delay before answering, so a turn lasts long enough to steer", async () => {
  const turn = verifyNapProvider({ stepDelayMs: 60 }).startTurn({});
  const started = Date.now();
  await turn.complete(request([{ role: "user", content: "build notes" }]));
  expect(Date.now() - started).toBeGreaterThanOrEqual(55);
});

it("stops waiting when the turn is aborted", async () => {
  const turn = verifyNapProvider({ stepDelayMs: 10_000 }).startTurn({});
  const controller = new AbortController();
  const pending = turn.complete({
    ...request([{ role: "user", content: "build notes" }]),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
});
