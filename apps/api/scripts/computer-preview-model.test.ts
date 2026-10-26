import { expect, it } from "vitest";
import { computerPreviewProvider } from "./computer-preview-model.ts";

const request = (editing: boolean) => ({
  systemPrompt: "",
  messages: [{ role: "user" as const, content: "local fixture" }],
  tools: editing
    ? [{ name: "write_file", description: "", inputSchema: {} }]
    : [{ name: "computer", description: "", inputSchema: {} }],
});
it("scripts real tool calls and a failed test, then passes after an explicit repair turn", async () => {
  const provider = computerPreviewProvider();
  const edit = provider.startTurn({});
  expect((await edit.complete(request(true))).type).toBe("message");
  const test = provider.startTurn({});
  const first = await test.complete(request(false));
  expect(first.type === "message" && first.toolCalls[0]?.name).toBe("computer");
  const failed = await test.complete(request(false));
  expect(failed.type === "message" && failed.toolCalls[0]?.input).toMatchObject({
    actions: [{ action: "annotate", annotation: { result: "failed" } }],
  });
  await provider.startTurn({}).complete(request(true));
  const retry = provider.startTurn({});
  await retry.complete(request(false));
  const passed = await retry.complete(request(false));
  expect(passed.type === "message" && passed.toolCalls[0]?.input).toMatchObject({
    actions: [{ action: "annotate", annotation: { result: "passed" } }],
  });
});
