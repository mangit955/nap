"use client";

/*
 * The composer's model and effort control.
 *
 * Ported from T3 Code (github.com/pingdotgg/t3code), apps/web/src/components/chat/
 * ProviderModelPicker.tsx, ModelPickerContent.tsx, ModelPickerSidebar.tsx, ModelListRow.tsx,
 * ComposerModelEffort.tsx and TraitsPicker.tsx: the popup's three columns — a vendor rail, a
 * searchable list of lines with the "New" badge, and the effort column — and the trigger that names
 * the model with its effort bars. Rebuilt on Base UI in Nap's theme, with T3's favorites,
 * providers and settings left out. MIT License, Copyright (c) 2026 T3 Tools Inc. See
 * THIRD_PARTY_NOTICES.md.
 */

import { Popover } from "@base-ui/react/popover";
import { Toolbar } from "@base-ui/react/toolbar";
import { DEFAULT_EFFORT, type Effort, lineOf, type ModelVendor } from "@nap/shared/model-lines";
import { use, useEffect, useId, useRef, useState } from "react";
import { ShowcaseContext } from "../ui/showcase.ts";
import { type ModelOption, modelInUse } from "./model-options.ts";
import { EFFORT_LABELS, EffortGlyph, resolveEffortGlyph } from "./model-picker/effort-glyph.tsx";
import { VendorLogo } from "./model-picker/vendor-logo.tsx";

/** Ties a locked row to the words explaining why, for anyone not reading with their eyes. */
const LOCKED_HINT_ID = "model-locked";

/** A rail tab: one vendor, or the free tier's model. */
type Tab = ModelVendor | "free";

const TAB_LABELS: Record<Tab, string> = {
  free: "Free",
  openai: "OpenAI",
  anthropic: "Anthropic",
  meta: "Meta",
};

const tabOf = (option: ModelOption): Tab => option.vendor ?? "free";

function modelLabel(option: ModelOption): string {
  const id = option.free ? null : option.version;
  const version = id === null ? undefined : lineOf(id)?.pattern.exec(id)?.[1];
  return version === undefined ? option.label : `${option.label} ${version}`;
}

/** The model's name with its effort, as the trigger shows it: bars, or "Max" written out. */
function TriggerEffort(props: { option: ModelOption; effort: Effort }) {
  const glyph = resolveEffortGlyph(props.option.efforts, props.effort);
  if (glyph === null) return null;
  return (
    <span className="flex shrink-0 items-center text-muted group-hover/model-trigger:text-ink">
      {glyph.word === null ? (
        <EffortGlyph count={glyph.count} filled={glyph.filled} />
      ) : (
        <span className="text-[12px]">{glyph.word}</span>
      )}
    </span>
  );
}

export function ModelPicker({
  models,
  model,
  effort,
  defaultEffort = DEFAULT_EFFORT,
  disabled = false,
  loading = false,
  onChange,
  onEffortChange,
  onPick,
  onAddKey,
  closeWhen,
}: {
  models: readonly ModelOption[];
  /** The caller's choice, or the server's default for them when none has been made. */
  model: string | undefined;
  /** The effort chosen. Absent is `defaultEffort`. */
  effort?: Effort | undefined;
  /** What a turn runs at when nobody chose: the server's answer for this caller. */
  defaultEffort?: Effort | undefined;
  disabled?: boolean;
  /** True while the model list is still being fetched from the server. */
  loading?: boolean;
  onChange: (model: string) => void;
  /** Absent hides the effort column: the caller cannot send one. */
  onEffortChange?: ((effort: Effort) => void) | undefined;
  /** Returns focus to the composer after a choice, where one was supplied. */
  onPick?: (() => void) | undefined;
  /**
   * Opening the place where a key is pasted, for a line this caller cannot reach.
   *
   * Absent leaves the locked entries inert but still visible. They are *shown* either way and
   * never filtered out: a menu that silently omits Opus makes the product look smaller than it
   * is, and gives nobody a way to find out that one key is all it takes.
   */
  onAddKey?: (() => void) | undefined;
  /** A changing composer token closes the menu before a competing suggestion menu opens. */
  closeWhen?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.length > 1 ? modelInUse(models, model) : undefined;
  const [tab, setTab] = useState<Tab>(selected === undefined ? "openai" : tabOf(selected));
  const search = useRef<HTMLInputElement>(null);
  const effortColumn = useRef<HTMLDivElement>(null);
  const chosenEffort = effort ?? defaultEffort;
  const describedBy = useId();
  const vendorLogos = use(ShowcaseContext)?.vendorLogos ?? true;

  useEffect(() => {
    // Reading the token is intentional: a new value means the composer is now serving a
    // different interaction, so this menu must yield to it.
    if (closeWhen !== undefined) setOpen(false);
  }, [closeWhen]);

  // While models are loading, show a placeholder that reserves the space the real picker will
  // occupy, so it does not pop in after the fetch and shift the composer.
  if (selected === undefined) {
    if (loading) {
      return (
        <div
          aria-hidden="true"
          className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5"
        >
          <span className="inline-block h-3 w-16 animate-pulse rounded bg-hover" />
        </div>
      );
    }
    return null;
  }

  const selectedLabel = modelLabel(selected);
  const tabs = (["free", "openai", "anthropic", "meta"] as const).filter((each) =>
    models.some((option) => tabOf(option) === each),
  );
  const needle = query.trim().toLowerCase();
  // Searching looks across every vendor, as T3's does; otherwise the rail decides.
  const shown =
    needle === ""
      ? models.filter((option) => tabOf(option) === tab)
      : models.filter((option) =>
          `${modelLabel(option)} ${option.version ?? ""} ${TAB_LABELS[tabOf(option)]}`
            .toLowerCase()
            .includes(needle),
        );
  const showEffort = onEffortChange !== undefined;

  const choose = (option: ModelOption) => {
    // A locked entry is a doorway rather than a dead end: pressing it opens the key form, which
    // is the only thing that would make it selectable.
    if (!option.available) {
      setOpen(false);
      onAddKey?.();
      return;
    }
    onChange(option.id);
    // With an effort column the next choice is the level, so focus goes there; without one, the
    // choice is made.
    if (showEffort && option.efforts.length > 0) {
      requestAnimationFrame(() =>
        effortColumn.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
      );
      return;
    }
    setOpen(false);
    onPick?.();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setTab(tabOf(selected));
        }
      }}
    >
      <Popover.Trigger
        aria-label="Model"
        // The name stays "Model", the control's job; what it is set to is read as its description.
        aria-describedby={describedBy}
        disabled={disabled}
        className="group/model-trigger flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2 font-normal text-[13px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:text-muted data-[popup-open]:bg-hover data-[popup-open]:text-ink"
      >
        {vendorLogos && <VendorLogo vendor={selected.vendor} className="size-3.5" />}
        <span className="truncate">{selectedLabel}</span>
        {showEffort && <TriggerEffort option={selected} effort={chosenEffort} />}
        <span id={describedBy} className="sr-only">
          {showEffort && selected.efforts.length > 0
            ? `${selectedLabel}, ${EFFORT_LABELS[chosenEffort]} effort`
            : selectedLabel}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50"
        >
          <Popover.Popup
            initialFocus={search}
            // On a phone the effort column goes under the list, as T3's does, rather than off the
            // screen to its side.
            className="composer-surface quiet-popover nap-float flex max-h-[min(360px,var(--available-height))] overflow-hidden rounded-[12px] text-ink outline-none max-sm:max-h-[var(--available-height)] max-sm:max-w-[calc(100vw-16px)] max-sm:flex-col"
            data-model-picker
          >
            <div className="flex min-h-0 max-sm:max-h-[240px]">
              <Toolbar.Root
                orientation="vertical"
                aria-label="Vendors"
                className="w-11 shrink-0 p-1"
                data-model-picker-sidebar
              >
                <div className="flex flex-col gap-1">
                  {tabs.map((each) => (
                    <Toolbar.Button
                      key={each}
                      type="button"
                      aria-label={TAB_LABELS[each]}
                      aria-pressed={each === tab && needle === ""}
                      title={TAB_LABELS[each]}
                      onClick={() => {
                        setTab(each);
                        setQuery("");
                        search.current?.focus();
                      }}
                      className="relative flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                    >
                      <VendorLogo vendor={each === "free" ? null : each} className="size-5" />
                      {each === tab && needle === "" && (
                        // T3's selection mark: a short bar on the rail's inner edge.
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute top-1/2 right-0 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent"
                        />
                      )}
                    </Toolbar.Button>
                  ))}
                </div>
              </Toolbar.Root>

              <div className="flex w-[232px] min-w-0 flex-col border-edge/45 border-l max-sm:w-[min(232px,calc(100vw-62px))]">
                <div className="shrink-0 px-3 pt-2.5">
                  <input
                    ref={search}
                    type="search"
                    aria-label="Search models"
                    placeholder="Search models…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-[33px] w-full border-edge/45 border-b bg-transparent pb-1.5 text-[13px] text-ink outline-none focus-visible:border-accent placeholder:text-muted"
                  />
                </div>
                <ul
                  aria-label="Model"
                  className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5"
                >
                  {shown.length === 0 && (
                    <li className="px-2 py-1.5 text-[12.5px] text-muted">No models match.</li>
                  )}
                  {shown.map((option) => {
                    const isSelected = option.id === selected.id;
                    return (
                      <li key={option.id}>
                        <button
                          type="button"
                          onClick={() => choose(option)}
                          aria-current={isSelected}
                          // Not `disabled`: a disabled control is unreachable by keyboard and
                          // unannounced by a screen reader, so the one explanation of why this
                          // line is out of reach would be visible only to people using a mouse.
                          aria-describedby={
                            option.available ? undefined : `${LOCKED_HINT_ID}-${option.id}`
                          }
                          className="group flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                        >
                          <VendorLogo vendor={option.vendor} className="size-4" />
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span
                              className={`min-w-0 truncate text-[13px] ${option.available ? "text-ink" : "text-muted"}`}
                              title={option.version ?? undefined}
                            >
                              {modelLabel(option)}
                              <span className="sr-only">
                                {`, ${TAB_LABELS[tabOf(option)]}${isSelected ? ", in use" : ""}`}
                              </span>
                            </span>
                            {isSelected && option.available && (
                              <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="size-3.5 shrink-0"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            )}
                            {option.isNew && (
                              <span className="shrink-0 rounded border border-accent/35 bg-accent-tint px-0.5 py-px font-bold text-[9px] text-accent-ink uppercase leading-none tracking-wide">
                                New<span className="sr-only"> model</span>
                              </span>
                            )}
                            {option.free && (
                              <span className="shrink-0 rounded-[4px] bg-hover px-1 py-px font-medium text-[10px] text-muted uppercase tracking-wide">
                                Free
                              </span>
                            )}
                          </span>
                          {!option.images && (
                            <span className="shrink-0 text-[10px] text-muted">Text only</span>
                          )}
                          {!option.available && (
                            <span
                              id={`${LOCKED_HINT_ID}-${option.id}`}
                              className="shrink-0 text-[11px] text-muted"
                            >
                              {option.version === null ? "unavailable" : "needs your key"}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            {showEffort && (
              <div
                ref={effortColumn}
                className="flex w-44 shrink-0 flex-col border-edge/45 border-l max-sm:min-h-0 max-sm:w-full max-sm:shrink max-sm:border-t max-sm:border-l-0"
                data-model-picker-effort
              >
                {/* Matches the search row's box, so one rule runs across the top of the popup. */}
                <div className="shrink-0 px-3 pt-2.5">
                  <div className="flex h-[33px] items-center gap-2 border-edge/45 border-b pb-1.5 text-[13px]">
                    <span className="text-muted">Effort</span>
                    <span className="ms-auto min-w-0 truncate text-[11.5px] text-muted">
                      {selectedLabel}
                    </span>
                  </div>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Effort"
                  className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5"
                >
                  {selected.efforts.length === 0 ? (
                    <p className="px-2 py-1.5 text-[12.5px] text-muted">Set by this deployment</p>
                  ) : (
                    selected.efforts.map((level) => (
                      // biome-ignore lint/a11y/useSemanticElements: T3's column — buttons in a radio group, so a level is one click and the arrow keys move between rows.
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={level === chosenEffort}
                        tabIndex={level === chosenEffort ? 0 : -1}
                        onClick={() => {
                          onEffortChange?.(level);
                          setOpen(false);
                          onPick?.();
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                          event.preventDefault();
                          const rows = [
                            ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                              '[role="radio"]',
                            ) ?? []),
                          ];
                          const at = rows.indexOf(event.currentTarget);
                          rows[
                            (at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
                          ]?.focus();
                        }}
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                      >
                        <span className="min-w-0 flex-1 truncate">{EFFORT_LABELS[level]}</span>
                        {level === chosenEffort ? (
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="size-3.5 shrink-0"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        ) : level === defaultEffort ? (
                          <span className="text-[11px] text-muted">Default</span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
