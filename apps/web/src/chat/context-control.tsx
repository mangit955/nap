"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";

export function ContextControl({
  events,
  running,
  onCompact,
}: {
  events: readonly StoredEvent[];
  running: boolean;
  onCompact: () => void;
}) {
  const usage = events.findLast((event) => event.type === "context.usage");
  const canCompact = events.some(
    (event) => event.type === "agent.message" || event.type === "tool.result",
  );
  const tokens = usage?.type === "context.usage" ? usage.payload : undefined;
  return (
    <details className="pointer-events-auto relative mx-4 mb-1 text-xs text-muted">
      <summary className="w-fit cursor-pointer rounded bg-panel px-2 py-1 hover:text-ink">
        Context
        {tokens === undefined
          ? ""
          : ` · ${tokens.source === "estimated" ? "~" : ""}${tokens.inputTokens < 1000 ? tokens.inputTokens : `${Math.round(tokens.inputTokens / 100) / 10}k`}`}
      </summary>
      <div className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-xl border border-white/10 bg-panel p-3 shadow-xl">
        <p>
          {tokens === undefined
            ? "Usage not reported yet"
            : `${tokens.source === "estimated" ? "Estimated input" : "Last reported input"}: ${tokens.inputTokens.toLocaleString()} tokens`}
        </p>
        {tokens !== undefined && (
          <p className="mt-1">Input budget: {tokens.budgetTokens.toLocaleString()} tokens</p>
        )}
        {tokens?.windowTokens != null && (
          <p>Model window: {tokens.windowTokens.toLocaleString()} tokens</p>
        )}
        <p className="my-2">Summarize working context. Your transcript stays available.</p>
        <button
          type="button"
          disabled={running || !canCompact}
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onCompact();
          }}
          className="rounded-md border border-white/15 px-2 py-1.5 text-ink disabled:opacity-40"
        >
          Compact context
        </button>
      </div>
    </details>
  );
}
