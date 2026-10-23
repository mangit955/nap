"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useCallback, useEffect, useId, useRef } from "react";

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 100) / 10}k`;
}

export function ContextControl({
  events,
  running,
  modelLabel,
  onCompact,
}: {
  events: readonly StoredEvent[];
  running: boolean;
  /** The model the next message runs on, said by name; absent until the list arrives. */
  modelLabel?: string | undefined;
  onCompact: () => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const usage = events.findLast((event) => event.type === "context.usage");
  const canCompact = events.some(
    (event) => event.type === "agent.message" || event.type === "tool.result",
  );
  const tokens = usage?.type === "context.usage" ? usage.payload : undefined;
  const percentage = tokens === undefined ? null : (tokens.inputTokens / tokens.budgetTokens) * 100;
  const percentageLabel =
    percentage === null
      ? null
      : `${percentage < 10 ? Number(percentage.toFixed(1)) : Math.round(percentage)}%`;
  const fill = Math.min(100, percentage ?? 0);
  const circumference = 2 * Math.PI * 9.75;
  const color = fill > 90 ? "var(--color-danger)" : "var(--color-muted)";
  const disabledReason = running
    ? "Available when the current operation finishes."
    : !canCompact
      ? "Start a conversation first."
      : undefined;

  const sizePopup = useCallback(() => {
    const details = disclosure.current;
    const panel = popup.current;
    if (!details?.open || !panel) return;
    let top = window.visualViewport?.offsetTop ?? 0;
    let left = window.visualViewport?.offsetLeft ?? 0;
    for (let parent = details.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, parent.getBoundingClientRect().top + parent.clientTop);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, parent.getBoundingClientRect().left + parent.clientLeft);
      }
    }
    const anchor = details.getBoundingClientRect();
    panel.style.maxHeight = `${Math.max(0, anchor.top - top - 4)}px`;
    panel.style.maxWidth = `${Math.max(0, anchor.right - left - 4)}px`;
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(sizePopup);
    for (
      let element: HTMLElement | null = disclosure.current;
      element;
      element = element.parentElement
    ) {
      observer.observe(element);
    }
    window.addEventListener("resize", sizePopup);
    document.addEventListener("scroll", sizePopup, true);
    window.visualViewport?.addEventListener("resize", sizePopup);
    window.visualViewport?.addEventListener("scroll", sizePopup);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sizePopup);
      document.removeEventListener("scroll", sizePopup, true);
      window.visualViewport?.removeEventListener("resize", sizePopup);
      window.visualViewport?.removeEventListener("scroll", sizePopup);
    };
  }, [sizePopup]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target)) {
        disclosure.current?.removeAttribute("open");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !disclosure.current?.open) return;
      event.preventDefault();
      disclosure.current.open = false;
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details
      ref={disclosure}
      onToggle={sizePopup}
      className="context-control relative shrink-0 text-xs text-muted"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary
        ref={trigger}
        className="grid size-8 cursor-pointer list-none place-items-center rounded-[8px] transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
        aria-label={
          percentageLabel === null
            ? "Context, usage not reported"
            : `Context, ${tokens?.source === "estimated" ? "estimated" : "reported"} ${percentageLabel} of Nap input budget`
        }
      >
        <span
          className="relative flex size-5 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="absolute inset-0 size-full -rotate-90"
          >
            <circle
              cx="12"
              cy="12"
              r="9.75"
              fill="none"
              className="stroke-muted/40"
              strokeWidth="3"
            />
            {percentage !== null && (
              <circle
                cx="12"
                cy="12"
                r="9.75"
                fill="none"
                stroke={color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - fill / 100)}
                className="transition-[stroke-dashoffset,stroke] duration-500 motion-reduce:transition-none"
              />
            )}
          </svg>
          {percentage === null && <span className="text-[10px]">?</span>}
        </span>
      </summary>
      <div
        ref={popup}
        className="composer-surface nap-float nap-scroll absolute right-0 bottom-full z-20 mb-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto rounded-[10px] p-3 [--float-origin:bottom_right]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-ink-2">Input budget</span>
          {tokens !== undefined && (
            <span
              className="text-[11px] tabular-nums"
              title={`${tokens.inputTokens.toLocaleString()} / ${tokens.budgetTokens.toLocaleString()} tokens`}
            >
              {percentageLabel} · {tokens.source === "estimated" ? "~" : ""}
              {formatTokens(tokens.inputTokens)}/{formatTokens(tokens.budgetTokens)}
            </span>
          )}
        </div>
        {tokens !== undefined && (
          <div
            role="progressbar"
            aria-label="Nap input budget usage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fill)}
            aria-valuetext={`${tokens.source === "estimated" ? "Estimated" : "Reported"} ${percentageLabel} of input budget`}
            className="h-1.5 shrink-0 overflow-hidden rounded-full bg-edge"
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-500 motion-reduce:transition-none"
              style={{ width: `${fill}%`, backgroundColor: color }}
            />
          </div>
        )}
        {tokens === undefined && <p>Usage not reported yet</p>}
        {tokens?.windowTokens != null && (
          <p>Model window: {tokens.windowTokens.toLocaleString()} tokens</p>
        )}
        {tokens !== undefined && (
          <p>
            {tokens.source === "estimated"
              ? "Estimated input usage."
              : "Last reported input usage."}
          </p>
        )}
        {/* T3 Code's line, worded as theirs is: whose context, and that nobody has to manage it. */}
        <p className="text-pretty font-medium text-[11px] text-ink-2">
          {modelLabel === undefined
            ? "Context compacts automatically when needed."
            : `Context for ${modelLabel} compacts automatically when needed.`}
        </p>
        <button
          type="button"
          disabled={disabledReason !== undefined}
          aria-describedby={disabledReason === undefined ? undefined : reasonId}
          onClick={() => {
            if (disclosure.current) disclosure.current.open = false;
            trigger.current?.focus();
            onCompact();
          }}
          className="mt-1 flex min-h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-chip border border-edge bg-field px-2 py-1 font-medium text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-field)_92%,white)] hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-40 motion-reduce:transition-none"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5"
          >
            <path d="m4 20 6-6m4-4 6-6M4 14h6v6M14 4v6h6" />
          </svg>
          Compact context
        </button>
        {disabledReason !== undefined && <p id={reasonId}>{disabledReason}</p>}
      </div>
    </details>
  );
}
