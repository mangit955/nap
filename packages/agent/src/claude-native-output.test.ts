import { expect, it } from "vitest";
import { ClaudeNativeOutput } from "./claude-native-output.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const encode = (frame: unknown) => new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
const message = (value: unknown) => ({ type: "message", message: value });
const assistant = (id: string, text: string) =>
  message({
    type: "assistant",
    session_id: sessionId,
    uuid: id,
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });
function stream(event: unknown) {
  return message({ type: "stream_event", session_id: sessionId, event });
}
function feed(decoder: ClaudeNativeOutput, frame: unknown) {
  return decoder.accept({ kind: "output", stream: "stdout", sequence: 1, data: encode(frame) });
}
it("streams UTF-8 text once and suppresses the complete-message duplicate", () => {
  const decoder = new ClaudeNativeOutput(sessionId);
  feed(decoder, stream({ type: "message_start", message: { id: "message-1" } }));
  const bytes = encode(
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo" } }),
  );
  const at = bytes.indexOf(0xc3) + 1;
  expect(
    decoder.accept({ kind: "output", stream: "stdout", sequence: 2, data: bytes.slice(0, at) }),
  ).toEqual([]);
  expect(
    decoder.accept({ kind: "output", stream: "stdout", sequence: 3, data: bytes.slice(at) }),
  ).toEqual([{ type: "agent.message", payload: { text: "héllo" } }]);
  expect(feed(decoder, assistant("message-1", "héllo"))).toEqual([]);
  expect(feed(decoder, assistant("message-2", "Another answer"))).toEqual([
    { type: "agent.message", payload: { text: "Another answer" } },
  ]);
  expect(feed(decoder, assistant("message-2", "Another answer"))).toEqual([]);
});
it("retains private tool calls for dispatch and never publishes credentials, raw SDK errors or stderr", () => {
  const decoder = new ClaudeNativeOutput(sessionId);
  const call = {
    id: "a".repeat(64),
    tool: "write_file",
    input: { path: "/home/user/app/a", contents: "Hello" },
  };
  expect(feed(decoder, { type: "tool_call", call })).toEqual([]);
  expect(decoder.takeControl()).toEqual([{ type: "tool_call", call }]);
  expect(decoder.takeControl()).toEqual([]);
  expect(
    feed(decoder, message({ type: "system", session_id: sessionId, private: "private-token" })),
  ).toEqual([]);
  expect(
    decoder.accept({
      kind: "output",
      stream: "stderr",
      sequence: 2,
      data: new TextEncoder().encode("private-token"),
    }),
  ).toEqual([]);
});
it.each([
  message({ type: "assistant", session_id: "wrong", message: { id: "a", content: [] } }),
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "out of order" },
  }),
  { type: "finished", result: { ok: true, value: { usage: null, usageIncomplete: false } } },
])("rejects mismatched or malformed native frames: %j", (frame) => {
  expect(() => feed(new ClaudeNativeOutput(sessionId), frame)).toThrow();
});
it("requires one completion receipt and complete framing before accepting process exit", () => {
  const decoder = new ClaudeNativeOutput(sessionId);
  const done = {
    type: "finished",
    result: { ok: true, value: { usage: null, usageIncomplete: true } },
  };
  feed(decoder, done);
  expect(decoder.result).toEqual(done.result);
  expect(() => feed(decoder, done)).toThrow();
  const truncated = new ClaudeNativeOutput(sessionId);
  truncated.accept({
    kind: "output",
    stream: "stdout",
    sequence: 1,
    data: new TextEncoder().encode('{"type":'),
  });
  expect(() =>
    truncated.accept({
      kind: "exit",
      sequence: 2,
      code: 0,
      reason: "exited",
      containment: "cgroup",
    }),
  ).toThrow();
});
