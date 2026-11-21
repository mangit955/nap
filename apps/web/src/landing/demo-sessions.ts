import { type SessionSummary, SessionSummarySchema } from "@nap/shared/session-navigation";
import type { ModelOption } from "../chat/model-options.ts";

/**
 * The sessions the landing page's sidebar lists: one person's week of work, half of it in their
 * own GitHub repositories. Every owner is made up (`acme`), which is why the demos draw letter
 * marks rather than avatars (`ui/showcase.ts`).
 */

const AT = "2026-11-20T10:00:00.000Z";

export const LEDGER_ID = "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e01";
export const STOREFRONT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e02";

type Extra = Partial<Pick<SessionSummary, "repository" | "branch" | "pullRequest" | "diff">> & {
  pendingFeedback?: number;
};

function session(projectId: string, name: string, extra: Extra = {}): SessionSummary {
  return SessionSummarySchema.parse({
    projectId,
    name,
    status: "ready",
    sandboxId: null,
    updatedAt: AT,
    sessionIds: [],
    createdAt: AT,
    navigation: {},
    revision: 0,
    activity: "ready",
    activityAt: AT,
    requestedAt: null,
    turnFinishedAt: AT,
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
    ...extra,
  });
}

/** Running for `minutes`, counted from the reader's clock, which is what the row's timer reads. */
function working(row: SessionSummary, minutes: number, now: number): SessionSummary {
  return {
    ...row,
    activity: "working",
    diff: null,
    turnFinishedAt: null,
    runStartedAt: new Date(now - minutes * 60_000).toISOString(),
  };
}

const LEDGER = session(LEDGER_ID, "Personal ledger", { diff: { added: 358, removed: 0 } });
const PAYMENT_EMAILS = session(STOREFRONT_ID, "Email customers when a payment fails", {
  repository: "acme/storefront",
  branch: "nap/failed-payment-emails",
  pullRequest: { number: 214, url: "https://github.com/acme/storefront/pull/214", state: "open" },
  diff: { added: 105, removed: 3 },
});
const DOCS_SEARCH = session("6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e03", "Add search to the docs", {
  repository: "acme/docs-site",
  branch: "nap/docs-search",
});
const REST = [
  session("6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e04", "Fix the flaky cart test", {
    repository: "acme/storefront",
    branch: "nap/flaky-cart-test",
    pullRequest: {
      number: 211,
      url: "https://github.com/acme/storefront/pull/211",
      state: "merged",
    },
    diff: { added: 12, removed: 9 },
  }),
  session("6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e05", "Upgrade to Next 16", {
    repository: "acme/web",
    branch: "nap/next-16",
    pullRequest: { number: 88, url: "https://github.com/acme/web/pull/88", state: "open" },
    pendingFeedback: 2,
    diff: { added: 214, removed: 187 },
  }),
  session("6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e06", "Recipe planner", {
    diff: { added: 1204, removed: 0 },
  }),
  session("6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e07", "Dark mode for settings", {
    repository: "acme/web",
    branch: "nap/settings-dark-mode",
    pullRequest: { number: 85, url: "https://github.com/acme/web/pull/85", state: "merged" },
    diff: { added: 96, removed: 41 },
  }),
];

/**
 * The list with the ledger at the top, running for `ledgerMinutes`, or finished when that is
 * null. The docs search is always mid-run: somebody's work carries on in another sandbox while
 * this one is watched.
 */
export function demoSessions(ledgerMinutes: number | null, now: number): SessionSummary[] {
  return [
    ledgerMinutes === null ? LEDGER : working(LEDGER, ledgerMinutes, now),
    PAYMENT_EMAILS,
    working(DOCS_SEARCH, 14, now),
    ...REST,
  ];
}

/** Two lines, because a picker with one choice draws nothing (`model-picker.tsx`). */
export const DEMO_MODELS: ModelOption[] = ["Opus", "Sonnet"].map((label) => ({
  id: label.toLowerCase(),
  label,
  vendor: "anthropic",
  version: null,
  isNew: false,
  images: true,
  efforts: ["low", "medium", "high"],
  available: true,
  free: false,
}));
