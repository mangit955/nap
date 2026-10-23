/**
 * The section and row the Providers page is built from — T3 Code's `SettingsSection` and
 * `SettingsRow`, in Nap's palette.
 *
 * The rest of Nap's settings follow Devin's layout (`settings/settings-ui.tsx`). This page follows
 * T3 Code's instead, because the provider list beside its editor is the experience being cloned,
 * and that layout depends on T3's denser rows: a muted section title outside the card, rows whose
 * control drops beneath the text when the editor is narrow.
 *
 * Adapted from T3 Code (MIT); see `THIRD_PARTY_NOTICES.md`.
 */

import type { ReactNode } from "react";

export const T3_BUTTON =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const OUTLINE_BUTTON = `${T3_BUTTON} border border-edge bg-field text-ink hover:bg-hover`;
export const GHOST_BUTTON = `${T3_BUTTON} text-muted hover:bg-hover hover:text-ink`;
/** The accent fill, as T3's primary buttons — kept to the one action a step is about. */
export const ACCENT_BUTTON = `${T3_BUTTON} bg-accent text-white hover:bg-accent/90`;
export const ICON_BUTTON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const INPUT =
  "h-7 min-w-0 rounded-md border border-edge bg-field px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-muted focus:border-accent";

export function ProviderSection({
  title,
  icon,
  titleAction,
  headerAction,
  level = 3,
  children,
}: {
  title: string;
  icon?: ReactNode;
  titleAction?: ReactNode;
  headerAction?: ReactNode;
  level?: 1 | 2 | 3;
  children: ReactNode;
}) {
  const Heading = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <Heading className="flex min-h-7 items-center gap-2 text-sm font-normal text-ink-2">
            {icon}
            {title}
          </Heading>
          {titleAction}
        </div>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <div className="rounded-xl border border-edge bg-panel [&>*+*]:border-t [&>*+*]:border-edge">
        {children}
      </div>
    </section>
  );
}

export function ProviderRow({
  title,
  description,
  status,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`@container/settings-row px-3 sm:px-4 ${children ? "pt-3 pb-1" : "py-3"}`}>
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h4 className="text-sm font-medium text-ink">{title}</h4>
          </div>
          {description ? (
            <div className="max-w-xl text-xs leading-normal text-muted">{description}</div>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1.5 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
