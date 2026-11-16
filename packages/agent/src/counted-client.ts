/**
 * Counts the HTTP requests a provider sends, below its own retries.
 *
 * `ClaudeProvider` retries a throttled, failed or stalled request itself, up to `MAX_ATTEMPTS`
 * times inside one `complete()`, and the SDK's own retries are off. So one model call can be
 * several requests, and a free model's daily quota counts requests. Wrapping the client is the
 * one place every attempt passes through.
 */

import type { AnthropicClient } from "./claude-provider.ts";

export function countRequests(inner: AnthropicClient): {
  client: AnthropicClient;
  requests(): number;
} {
  let requests = 0;
  return {
    client: {
      messages: {
        stream: (body, options) => {
          requests += 1;
          return inner.messages.stream(body, options);
        },
      },
    },
    requests: () => requests,
  };
}
