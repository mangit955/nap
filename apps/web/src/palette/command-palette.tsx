"use client";

import { Search } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isMacPlatform, opensPalette } from "../dashboard/sidebar-keys.ts";
import { type Command, groupCommands, stepIndex } from "./commands.ts";
import type { CommandRegistry } from "./registry.ts";

/**
 * The command palette, on the platform modifier and K: a search field over the commands the page
 * has offered (see `registry.ts`), drawn as T3 Code draws its own.
 *
 * A native modal `<dialog>`, like the repo's other dialogs, for its focus trap, Escape and inert
 * page. It stays mounted while closed so the way out can fade too; see `.command-palette` in
 * `globals.css`. The field is a combobox and the rows a listbox it points into, so the field
 * keeps focus while arrows move the highlight — the pattern the sidebar's search uses.
 */
export function CommandPalette({ registry }: { registry: CommandRegistry }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Bumped on each opening, so a reopening with the same empty query still reads the commands
  // afresh: sessions may have arrived since the last time.
  const [, setOpenings] = useState(0);
  const mac = useMemo(isMacPlatform, []);

  const sections = groupCommands(registry.list(), query);
  const rows = sections.flatMap((section) => section.commands);
  const current = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !opensPalette(event, mac)) return;
    const element = dialog.current;
    if (!element) return;
    event.preventDefault();
    if (element.open) {
      dismiss();
      return;
    }
    // Another modal — a delete confirmation, the API key panel — owns the page until it closes.
    if (document.querySelector("dialog[open]")) return;
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    setOpenings((count) => count + 1);
    element.showModal();
    field.current?.focus();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the highlight, not every render.
  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  /** Closes and gives focus back at once, before a command that might want it runs. */
  function dismiss() {
    dialog.current?.close();
    restoreFocus();
  }

  function restoreFocus() {
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function run(command: Command | undefined) {
    if (!command) return;
    dismiss();
    command.run();
  }

  let index = 0;
  return (
    <dialog
      ref={dialog}
      aria-label="Command palette"
      closedby="any"
      // Escape and a click outside close the dialog without going through `dismiss`; a browser
      // that restores focus itself has already done so, and one that does not left it on the body.
      onClose={() => {
        if (
          document.activeElement === document.body ||
          dialog.current?.contains(document.activeElement)
        )
          restoreFocus();
        else returnTo.current = null;
      }}
      className="command-palette dialog-glass text-ink"
    >
      <div className="command-palette-search">
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <input
          ref={field}
          role="combobox"
          aria-label="Search commands and sessions"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search commands and sessions…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(stepIndex(current, event.key === "ArrowDown" ? 1 : -1, rows.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(rows[current]);
            }
          }}
        />
      </div>
      {rows.length > 0 ? (
        <div id={listId} role="listbox" aria-label="Commands" className="command-palette-list">
          {sections.map((section) => {
            const headingId = `${listId}-${section.name}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a listbox's groups are `group`; a fieldset is a form's.
              <div key={section.name} role="group" aria-labelledby={headingId}>
                <div id={headingId} role="presentation" className="command-palette-group">
                  {section.name}
                </div>
                {section.commands.map((command) => {
                  const at = index++;
                  return (
                    <Row
                      key={command.id}
                      id={optionId(at)}
                      highlighted={at === current}
                      icon={command.icon}
                      meta={command.meta}
                      onPoint={() => setActive(at)}
                      onRun={() => run(command)}
                    >
                      {command.label}
                    </Row>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="command-palette-empty">No matching commands or sessions.</p>
      )}
      <div className="command-palette-footer" aria-hidden>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Select
        </span>
        <span>
          <kbd>esc</kbd> Close
        </span>
      </div>
    </dialog>
  );
}

function Row({
  id,
  highlighted,
  icon,
  meta,
  onPoint,
  onRun,
  children,
}: {
  id: string;
  highlighted: boolean;
  icon: ReactNode;
  meta: ReactNode;
  onPoint: () => void;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    // Not focusable on purpose: focus stays in the field, which names this row as its active
    // descendant, and the field's own keys run it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles Enter for the highlighted row.
    // biome-ignore lint/a11y/useFocusableInteractive: see above — combobox options are not tab stops.
    <div
      id={id}
      role="option"
      aria-selected={highlighted}
      data-highlighted={highlighted || undefined}
      // Moving rather than entering, so a list that scrolls under a still pointer keeps the
      // keyboard's highlight.
      onPointerMove={highlighted ? undefined : onPoint}
      onClick={onRun}
      className="command-palette-row"
    >
      <span className="command-palette-icon">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta !== undefined && <span className="command-palette-meta">{meta}</span>}
    </div>
  );
}
