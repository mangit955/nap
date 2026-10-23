/**
 * What the settings page says about each provider: its name, the agent it runs, and the words
 * on its sign-in button. One table, so the list, the editor and the add dialog cannot name the
 * same provider two ways.
 */

import type { ProviderAccount, ProviderDriver } from "@nap/shared/provider-accounts-protocol";
import type { ReactNode } from "react";
import { ClaudeIcon, OpenAIIcon } from "./provider-icons.tsx";

export type DriverCopy = {
  name: string;
  /** The agent Nap runs on this account, shown where T3 shows a version. */
  runtime: string;
  /** Whose account it is, as the Account row titles it. */
  account: string;
  signIn: string;
  /** One line under the choice in the add dialog. */
  pitch: string;
  icon: (className?: string) => ReactNode;
};

export const DRIVERS: Record<ProviderDriver, DriverCopy> = {
  codex: {
    name: "Codex",
    runtime: "Codex",
    account: "ChatGPT account",
    signIn: "Continue with ChatGPT",
    pitch: "Use Codex with your ChatGPT subscription.",
    icon: (className) => <OpenAIIcon className={className} />,
  },
  claude: {
    name: "Claude",
    runtime: "Claude Code",
    account: "Claude account",
    signIn: "Sign in to Claude Code",
    pitch: "Use Claude Code with your Claude subscription.",
    icon: (className) => <ClaudeIcon className={className} />,
  },
};

/** In the order the add dialog offers them, which is T3's. */
export const DRIVER_ORDER: readonly ProviderDriver[] = ["codex", "claude"];

/** What the list calls an account: its label, or the provider's own name until it has one. */
export function accountName(account: Pick<ProviderAccount, "driver" | "label">): string {
  return account.label ?? DRIVERS[account.driver].name;
}
