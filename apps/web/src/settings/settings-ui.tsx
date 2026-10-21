/**
 * The pieces every settings page is built from, so the overview, the GitHub page and its drawer
 * cannot drift apart in spacing or weight.
 *
 * The layout follows Devin's settings: a section is a heading, one muted line, then a card of
 * rows, and each row puts what it is on the left and the one thing you can do about it on the
 * right. The colours are Nap's own tokens — the reference supplied the shape, not the palette.
 */

import type { ReactNode } from "react";
import { ArrowLeftIcon, InfoIcon } from "../ui/icons.tsx";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BASE_BUTTON = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export const BUTTON = `${BASE_BUTTON} border border-edge bg-field text-ink-2 hover:bg-hover hover:text-ink`;
/** The one filled control on a page. `ink` as a fill rather than the accent, which means "in progress" here. */
export const PRIMARY_BUTTON = `${BASE_BUTTON} bg-ink text-surface hover:bg-ink-2`;
export const DANGER_BUTTON = `${BASE_BUTTON} border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20`;
/** A whole row that opens something. */
export const ROW_BUTTON = `flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-hover ${FOCUS} focus-visible:-outline-offset-2`;

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-2 rounded-md text-[13px] text-muted transition-colors hover:text-ink ${FOCUS}`}
    >
      <ArrowLeftIcon className="size-3.5" />
      {children}
    </a>
  );
}

export function Section({
  title,
  description,
  action,
  level = 2,
  className = "mt-10",
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 3 inside the drawer, whose own title is the h2. */
  level?: 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section className={className}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Heading className="text-[15px] font-medium text-ink">{title}</Heading>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-edge bg-panel">{children}</div>;
}

/** A setting: what it is on the left, its control or value on the right. */
export function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm text-ink">{title}</p>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md border border-edge bg-field px-1.5 py-px text-[11px] text-muted">
      {children}
    </span>
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
      className="relative mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 overflow-hidden rounded-xl border border-edge bg-panel py-4 pl-6 pr-4"
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
