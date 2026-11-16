/**
 * A Messages endpoint on loopback that records every request and answers with one short message.
 *
 * For proving where a composed model client sends a turn — the host, the path the SDK builds from
 * a base URL, the model id and the key — without reaching any vendor. A stub client cannot show
 * those: they are decided inside the SDK, and only a real request carries them. Nothing leaves the
 * machine, so a suite using it stays deterministic and free.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** What the endpoint saw of one request. */
export type SeenRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: { model: string } & Record<string, unknown>;
};

export type MessagesEndpoint = {
  /** `http://127.0.0.1:<port>`, an API root a client can be pointed at. */
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
};

/** The smallest stream the SDK assembles into a finished message. */
const MESSAGE_STREAM = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "echo",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

export async function messagesEndpoint(): Promise<MessagesEndpoint> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(raw) as SeenRequest["body"],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(MESSAGE_STREAM);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
