import { randomUUID } from "node:crypto";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  NativeWorkspaceCall,
  NativeWorkspaceTools,
} from "@nap/shared/ports/native-workspace-tools";
import { expect, it } from "vitest";
import { createNativeWorkspaceTools } from "./native-workspace-tools.ts";

async function fixture(remote: NativeWorkspaceTools, onUncertain: () => void = () => {}) {
  const tools = await createNativeWorkspaceTools({
    runId: randomUUID(),
    remote,
    signal: new AbortController().signal,
    onUncertain,
  });
  const server = createSdkMcpServer({ name: "nap", version: "1.0.0", tools });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "offline-native-fixture", version: "1.0.0" });
  await server.instance.connect(right);
  await client.connect(left);
  return {
    client,
    close: async () => {
      await client.close();
      await server.instance.close();
    },
  };
}

it("routes the existing project tools through the bound client over the real MCP protocol", async () => {
  const calls: NativeWorkspaceCall[] = [];
  const f = await fixture({
    execute: async (call) => {
      calls.push(call);
      return { ok: true, value: { ok: true, output: "/home/user/app" } };
    },
  });
  try {
    expect((await f.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "edit_file",
      "list_files",
      "read_file",
      "run_command",
      "search_files",
      "write_file",
    ]);
    const result = await f.client.callTool({ name: "run_command", arguments: { command: "pwd" } });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "/home/user/app" }],
      isError: false,
    });
    expect(calls).toMatchObject([
      {
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        tool: "run_command",
        input: { command: "pwd" },
      },
    ]);
    await f.client.callTool({ name: "run_command", arguments: { command: "pwd" } });
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  } finally {
    await f.close();
  }
});

it("rejects malformed tool arguments before dispatching any project operation", async () => {
  let calls = 0;
  const f = await fixture({
    execute: async () => {
      calls++;
      return { ok: true, value: { ok: true, output: "unexpected" } };
    },
  });
  try {
    expect(
      await f.client.callTool({ name: "run_command", arguments: { command: "" } }),
    ).toMatchObject({ isError: true });
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

it("poisons all tools after an unknown receipt and redacts transport exceptions", async () => {
  let calls = 0;
  let stopped = 0;
  const f = await fixture(
    {
      execute: async () => {
        calls++;
        throw new Error("Bearer private-fixture-token");
      },
    },
    () => {
      stopped++;
    },
  );
  try {
    const result = await f.client.callTool({
      name: "run_command",
      arguments: { command: "write something" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
    expect(stopped).toBe(1);
    expect(
      await f.client.callTool({ name: "read_file", arguments: { path: "/home/user/app/a.txt" } }),
    ).toMatchObject({ isError: true });
    expect(calls).toBe(1);
    expect(stopped).toBe(1);
  } finally {
    await f.close();
  }
});
