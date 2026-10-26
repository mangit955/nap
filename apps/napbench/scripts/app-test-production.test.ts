import { expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  manager: vi.fn(
    class {
      readonly kind = "sandbox";
    },
  ),
  desktop: vi.fn(
    class {
      readonly kind = "desktop";
    },
  ),
  provider: vi.fn(
    class {
      readonly kind = "provider";
    },
  ),
  client: vi.fn(() => ({
    messages: {
      stream: vi.fn(() => {
        throw new Error("No network in factory tests");
      }),
    },
  })),
}));
vi.mock("@nap/sandbox/e2b-sandbox-manager", () => ({ E2BSandboxManager: mocked.manager }));
vi.mock("@nap/sandbox/e2b-sandbox-desktop", () => ({ E2BSandboxDesktop: mocked.desktop }));
vi.mock("@nap/agent/claude-provider", () => ({ ClaudeProvider: mocked.provider }));
vi.mock("@nap/agent/openrouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nap/agent/openrouter")>()),
  createOpenRouterClient: mocked.client,
}));

import { appTestProductionFactories } from "./app-test-production.ts";

it("constructs only the existing production adapters with the requested template, mapper and output limit", () => {
  expect(mocked.manager).not.toHaveBeenCalled();
  expect(mocked.client).not.toHaveBeenCalled();
  const sandbox = appTestProductionFactories.sandbox({
    template: "approved-template",
    timeoutMs: 12345,
  });
  expect(mocked.manager).toHaveBeenCalledExactlyOnceWith({
    template: "approved-template",
    timeoutMs: 12345,
  });
  appTestProductionFactories.desktop(sandbox);
  expect(mocked.desktop).toHaveBeenCalledExactlyOnceWith({ sandbox });
  appTestProductionFactories.provider({
    apiKey: "injected-construction-only",
    model: "claude-sonnet-5",
    effort: "low",
    maxOutputTokens: 2048,
  });
  expect(mocked.client).toHaveBeenCalledExactlyOnceWith({ apiKey: "injected-construction-only" });
  expect(mocked.provider).toHaveBeenCalledExactlyOnceWith({
    model: "anthropic/claude-sonnet-5",
    effort: "low",
    maxTokens: 2048,
    client: mocked.client.mock.results[0]?.value,
  });
});
