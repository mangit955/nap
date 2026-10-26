import { ClaudeProvider } from "@nap/agent/claude-provider";
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import type { AppTestFactories } from "./app-test-command.ts";

/** Only imported after CLI and credential validation. No resource is created on import. */
export const appTestProductionFactories: AppTestFactories = {
  sandbox: (options) => new E2BSandboxManager(options),
  desktop: (sandbox) => new E2BSandboxDesktop({ sandbox }),
  provider: (options) =>
    new ClaudeProvider({
      model: toOpenRouterModel(options.model),
      effort: options.effort,
      maxTokens: options.maxOutputTokens,
      client: createOpenRouterClient({ apiKey: options.apiKey }),
    }),
};
