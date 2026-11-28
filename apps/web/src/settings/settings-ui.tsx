import type { ReactNode } from "react";
import { InfoIcon } from "../ui/icons.tsx";

export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BASE_BUTTON = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export const BUTTON = `${BASE_BUTTON} border border-edge bg-field text-ink-2 hover:bg-hover hover:text-ink`;
/** The one filled control on a page. `ink` as a fill rather than the accent, which means "in progress" here. */
export const PRIMARY_BUTTON = `${BASE_BUTTON} bg-ink text-surface hover:bg-ink-2`;
/**
 * A whole row that opens something. Its ring is drawn inside the row rather than through `FOCUS`:
 * the row fills a `Card`, which clips anything outside it, and the two offsets cannot be stacked
 * in one class list — whichever rule comes later in the stylesheet wins, not the later class.
 */
export const ROW_BUTTON =
  "flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-edge/55 bg-panel">{children}</div>
  );
}

/**
 * A note pinned above a page's sections, marked by a bar down its left edge.
 *
 * `danger` is for something that went wrong; anything else carries the accent, which is the
 * palette's "look here" rather than a success colour — success stays unmarked.
 */
export function Callout({
  title,
  children,
  action,
  tone = "info",
  role,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: "info" | "danger";
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className="relative mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 overflow-hidden rounded-xl border border-edge/55 bg-panel py-4 pl-6 pr-4"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${tone === "danger" ? "bg-danger" : "bg-accent"}`}
      />
      <div className="flex min-w-0 flex-1 basis-64 gap-3">
        <InfoIcon
          className={`mt-0.5 size-4 shrink-0 ${tone === "danger" ? "text-danger" : "text-accent-ink"}`}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
        </div>
      </div>
      {action}
    </div>
  );
}
