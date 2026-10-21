import type { ReactNode } from "react";
import type { CompactionItem } from "./transcript.ts";
import { Spotlight } from "./work-log-rows.tsx";

export function CompactionRow({ item, recovery }: { item: CompactionItem; recovery?: ReactNode }) {
  const label =
    item.status === "running"
      ? "Compacting context…"
      : item.status === "completed"
        ? "Context compacted"
        : item.cancelled
          ? "Compaction stopped"
          : "Compaction failed";
  const failed = item.status === "failed" && !item.cancelled;
  const estimated = item.status === "completed" && item.result.kind === "api";
  const count = (value: number | null) =>
    value === null ? "Unknown" : `${estimated ? "~" : ""}${value.toLocaleString()}`;
  return (
    <div className="min-w-0 text-xs text-muted">
      <div className="flex items-center gap-3 py-1">
        <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-edge" />
        <div
          role="status"
          className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="size-3.5 shrink-0"
          >
            <path d="M4 4l6 6m0-6v6H4m16 10-6-6m0 6v-6h6" />
          </svg>
          {/* Waiting rather than doing, so it wears the spotlight the timeline's "Thinking" does. */}
          {item.status === "running" ? (
            <Spotlight label={label} />
          ) : (
            <span className={failed ? "text-danger" : undefined}>{label}</span>
          )}
          {item.trigger !== null && (
            <span className="text-[11px]">
              {item.trigger === "manual" ? "Manual" : "Automatic"}
            </span>
          )}
          {item.status === "completed" &&
            (item.beforeTokens !== null || item.afterTokens !== null) && (
              <span className="basis-full text-center font-mono text-[11px] tabular-nums">
                {count(item.beforeTokens)} → {count(item.afterTokens)}{" "}
                <span className="font-sans">
                  {estimated ? "estimated context tokens" : "reported context tokens"}
                </span>
              </span>
            )}
        </div>
        <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-edge" />
      </div>
      {item.status === "failed" && (
        <div
          className={`mt-2 space-y-1 rounded-chip border px-3 py-2 ${failed ? "border-danger/30 bg-danger/[0.06]" : "border-edge"}`}
        >
          {recovery ?? (
            <>
              <p className="break-words font-mono text-[11px]">{item.message}</p>
              <p>Your original conversation is still available.</p>
            </>
          )}
        </div>
      )}
      <details className="mt-1">
        <summary className="mx-auto w-fit rounded-chip px-2 py-1 text-[11px] hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
          Compaction details
        </summary>
        <div className="mt-2 space-y-2 rounded-lg border border-edge bg-panel p-3 leading-relaxed">
          {item.trigger === null && <p>Trigger not recorded</p>}
          {item.startedAt !== null && (
            <p>
              Started{" "}
              <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time>
            </p>
          )}
          {item.status !== "running" && (
            <p>
              {item.status === "completed" ? "Completed" : item.cancelled ? "Stopped" : "Failed"}{" "}
              <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString()}</time>
            </p>
          )}
          {item.status === "completed" &&
            item.beforeTokens === null &&
            item.afterTokens === null && <p>Context size not reported</p>}
          {item.status !== "running" && item.usage !== null && (
            <p>
              {item.status === "completed" && item.result.kind === "api"
                ? "Summary call"
                : "Compaction call"}
              : {item.usage.inputTokens.toLocaleString()} input /{" "}
              {item.usage.outputTokens.toLocaleString()} output tokens. This is call usage, not
              resulting context size.
            </p>
          )}
          {item.status === "completed" && item.result.kind === "api" && (
            <>
              <p className="font-medium text-ink-2">Summary</p>
              <div className="nap-scroll max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-ink-2">
                {item.result.checkpoint.summary}
              </div>
              <p>
                Original requests and retained recent exchange are kept separately. This summary is
                only part of the reconstructed context.
              </p>
              <p>
                Context sizes are estimates. Restoring previously pruned history can increase them.
              </p>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
