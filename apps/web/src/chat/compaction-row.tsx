import type { ReactNode } from "react";
import { ArrowRightIcon, MinimizeIcon } from "../ui/icons.tsx";
import type { CompactionItem } from "./transcript.ts";
import { Spotlight } from "./work-log-rows.tsx";

/**
 * A count short enough for a divider: `294K`, `12.6K`, `1.2K`. At most three significant
 * figures, the way T3 Code writes the same row (MIT — see `apps/web/THIRD_PARTY_NOTICES.md`),
 * less the trailing zero T3 keeps in `1.20K`.
 */
function shortCount(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value));
  const [scaled, unit] = Math.abs(value) >= 1e6 ? [value / 1e6, "M"] : [value / 1000, "K"];
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(digits))}${unit}`;
}

/**
 * Compaction as a divider in the conversation, drawn as T3 Code draws it: a rule either side of
 * one muted line, which wears the timeline's spotlight while the summary is being written. What a
 * row used to explain underneath — the trigger, the call's usage, the summary itself — is no
 * longer drawn; the line says what happened to the context and nothing else.
 */
export function CompactionRow({ item, recovery }: { item: CompactionItem; recovery?: ReactNode }) {
  const label =
    item.status === "running"
      ? "Compacting context"
      : item.status === "completed"
        ? "Context compacted"
        : item.cancelled
          ? "Context compaction stopped"
          : "Context compaction failed";
  const failed = item.status === "failed" && !item.cancelled;
  const icon = <MinimizeIcon className="size-3 shrink-0" />;
  return (
    <div className="min-w-0 text-xs text-muted">
      <div className="flex items-center gap-3 py-1">
        <span aria-hidden="true" className="h-px flex-1 bg-edge" />
        <span role="status" className="relative shrink-0 overflow-hidden">
          {item.status === "running" ? (
            <Spotlight label={label} icon={icon} />
          ) : (
            <span className={`flex items-center gap-1.5 ${failed ? "text-danger" : ""}`}>
              {icon}
              {label}
              {item.status === "completed" &&
                item.beforeTokens !== null &&
                item.afterTokens !== null && (
                  <>
                    {" "}
                    {shortCount(item.beforeTokens)}
                    <ArrowRightIcon className="size-3 shrink-0" />
                    <span className="sr-only">to</span>
                    {shortCount(item.afterTokens)} tokens
                  </>
                )}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-edge" />
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
    </div>
  );
}
