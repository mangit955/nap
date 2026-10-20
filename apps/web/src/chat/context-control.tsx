"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useCallback, useEffect, useId, useRef } from "react";

export function ContextControl({
  events,
  running,
  onCompact,
}: {
  events: readonly StoredEvent[];
  running: boolean;
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
    for (let parent = details.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        top = Math.max(top, parent.getBoundingClientRect().top + parent.clientTop);
      }
    }
    panel.style.maxHeight = `${Math.max(0, details.getBoundingClientRect().top - top - 4)}px`;
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
      className="pointer-events-auto relative mx-4 mb-1 text-xs text-muted"
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
        className="flex min-h-9 w-fit list-none items-center gap-2 rounded-chip bg-panel px-2 py-1 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
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
            <circle cx="12" cy="12" r="9.75" fill="none" className="stroke-edge" strokeWidth="3" />
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
        <span>
          Context
          {tokens === undefined
            ? ""
            : ` · ${tokens.source === "estimated" ? "~" : ""}${tokens.inputTokens < 1000 ? tokens.inputTokens : `${Math.round(tokens.inputTokens / 100) / 10}k`}`}
        </span>
      </summary>
      <div
        ref={popup}
        className="nap-scroll absolute bottom-full left-0 z-20 mb-1 flex w-80 max-w-full flex-col gap-2 overflow-y-auto rounded-xl border border-edge bg-panel p-3 shadow-raised"
      >
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="font-medium text-ink-2">Input budget</span>
          {percentageLabel !== null && (
            <span className="tabular-nums">{percentageLabel} of input budget</span>
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
        <p>
          {tokens === undefined
            ? "Usage not reported yet"
            : `${tokens.source === "estimated" ? "Estimated input" : "Last reported input"}: ${tokens.inputTokens.toLocaleString()} tokens`}
        </p>
        {tokens !== undefined && <p>Input budget: {tokens.budgetTokens.toLocaleString()} tokens</p>}
        {tokens?.windowTokens != null && (
          <p>Model window: {tokens.windowTokens.toLocaleString()} tokens</p>
        )}
        <p className="leading-relaxed">
          Nap compacts automatically when needed, based on input budget, response headroom and turn
          spending. Your original conversation stays available.
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
          className="mt-1 min-h-9 w-full rounded-chip border border-edge px-2 py-1.5 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-40 motion-reduce:transition-none"
        >
          Compact context
        </button>
        {disabledReason !== undefined && <p id={reasonId}>{disabledReason}</p>}
      </div>
    </details>
  );
}
