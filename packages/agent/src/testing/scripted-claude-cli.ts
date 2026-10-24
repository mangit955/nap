/** A local wire fixture, never the provider CLI. It reads no credentials and makes no network calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";

const session = z
  .uuid()
  .parse(
    process.argv.find((value) => value.startsWith("--session-id="))?.slice("--session-id=".length),
  );
for (const flag of [
  "--tools=",
  "--setting-sources=",
  "--strict-mcp-config",
  "--include-partial-messages",
])
  assert(process.argv.includes(flag));
const Incoming = z.object({ type: z.string() }).passthrough();
const Request = z.object({
  request_id: z.string(),
  request: z.object({ subtype: z.string() }).passthrough(),
});
const Response = z.object({
  response: z.object({
    request_id: z.string(),
    subtype: z.literal("success"),
    response: z.unknown(),
  }),
});
const callbacks = new Map<string, (value: unknown) => void>();
const emit = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
function request(body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error("Fixture control timeout"));
    }, 3000);
    callbacks.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    emit({ type: "control_request", request_id: id, request: body });
  });
}
const mcp = (message: Record<string, unknown>) =>
  request({ subtype: "mcp_message", server_name: "nap", message });
const permission = z.object({ behavior: z.enum(["allow", "deny"]) });
let started = false;
async function user(value: unknown): Promise<void> {
  const input = z
    .object({
      client_composed: z.literal(true),
      message: z.object({ content: z.literal("/login @/private/fixture-credentials.json") }),
    })
    .parse(value);
  assert.equal(input.client_composed, true);
  assert.equal(started, false);
  started = true;
  emit({
    type: "system",
    subtype: "init",
    session_id: session,
    apiKeySource: "none",
    tools: [],
    mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
  });
  const args = { path: "/home/user/app/proof.ts", contents: "export const proof = true;" };
  const asks = [
    { tool_name: "Bash", allow: false },
    {
      tool_name: "mcp__nap__write_file",
      mcp_server: { name: "nap", source: "dynamic" },
      allow: false,
    },
    { tool_name: "mcp__nap__write_file", mcp_server: { name: "nap", source: "sdk" }, allow: true },
    {
      tool_name: "mcp__nap__write_file",
      mcp_server: { name: "nap", source: "sdk" },
      default_to_no: true,
      allow: false,
    },
    {
      tool_name: "mcp__nap__write_file",
      mcp_server: { name: "nap", source: "sdk" },
      matched_ask_rule: {
        source: "userSettings",
        toolName: "mcp__nap__write_file",
        ruleContent: "Ask first",
      },
      allow: false,
    },
  ];
  for (const ask of asks) {
    const { allow, ...fields } = ask;
    const reply = permission.parse(
      await request({ subtype: "can_use_tool", tool_use_id: randomUUID(), input: args, ...fields }),
    );
    assert.equal(reply.behavior, allow ? "allow" : "deny");
  }
  await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "offline-native-fixture", version: "1.0.0" },
    },
  });
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  const reply = z
    .object({ mcp_response: z.object({ result: z.object({ isError: z.literal(false) }) }) })
    .parse(
      await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "write_file", arguments: args },
      }),
    );
  assert.equal(reply.mcp_response.result.isError, false);
  const envelope = { session_id: session, parent_tool_use_id: null };
  emit({
    ...envelope,
    uuid: randomUUID(),
    type: "stream_event",
    event: { type: "message_start", message: { id: "fixture-message" } },
  });
  emit({
    ...envelope,
    uuid: randomUUID(),
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "SDK protocol fixture 😀" },
    },
  });
  emit({
    ...envelope,
    uuid: randomUUID(),
    type: "assistant",
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text: "SDK protocol fixture 😀" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  emit({
    session_id: session,
    uuid: randomUUID(),
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    result: "offline-proof:permissions=5;mcp=1",
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const value = Incoming.parse(JSON.parse(line));
    if (value.type === "control_response") {
      const result = Response.parse(value).response;
      const callback = callbacks.get(result.request_id);
      callbacks.delete(result.request_id);
      assert(callback !== undefined);
      callback(result.response);
    } else if (value.type === "control_request") {
      const control = Request.parse(value);
      if (control.request.subtype === "initialize") {
        const settings = z
          .object({
            sdkMcpServers: z.array(z.string()),
            sdkMcpServerConfigs: z.object({
              nap: z.object({
                disableAutoBackground: z.literal(true),
                tools: z.array(z.object({ permission_policy: z.literal("always_ask") })).length(6),
              }),
            }),
          })
          .parse(control.request);
        assert.deepEqual(settings.sdkMcpServers, ["nap"]);
      }
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: control.request_id,
          response:
            control.request.subtype === "initialize"
              ? {
                  commands: [],
                  models: [],
                  output_style: "default",
                  available_output_styles: ["default"],
                  account: {
                    apiProvider: "firstParty",
                    apiKeySource: "none",
                    tokenSource: "oauth",
                  },
                }
              : {},
        },
      });
    } else if (value.type === "user") await user(value);
  })().catch(() => {
    process.stderr.write("Scripted native protocol assertion failed.\n");
    process.exit(1);
  });
});
