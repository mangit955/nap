"use client";

/**
 * A name you can change by clicking it.
 *
 * Two places need this — the workspace bar, where you are when a name starts feeling wrong, and
 * the dashboard card, where you are when you are triaging a list of them — so it is one control
 * rather than two that drift apart.
 *
 * **The resting state is a button, not an input.** A field that always looks like a field puts a
 * box around a name that is almost never being edited, and makes the bar read as a form. The
 * button carries a real label ("Rename this project"), so the affordance survives for anybody who
 * cannot see the hover — a pencil that only appears under the cursor is not an affordance, it is
 * a secret.
 *
 * Enter commits, Escape reverts, blur commits. Blur rather than revert because the common way to
 * finish typing and look away is to click elsewhere, and losing the edit there is the behaviour
 * people find infuriating; Escape is the deliberate way out and it is the one that discards.
 *
 * **An unchanged or empty value sends nothing.** Clicking in and out of a name should not write
 * to the database, and an empty name is refused by the server anyway — reverting to what was
 * there is a better answer than a round trip that fails.
 */

import { useEffect, useRef, useState } from "react";
import { PencilIcon } from "./icons.tsx";

export function EditableTitle({
  name,
  onRename,
  className = "",
  inputClassName = "",
}: {
  name: string;
  /** Resolves to the name that was stored, or `undefined` if the server refused it. */
  onRename: (name: string) => Promise<string | undefined> | undefined;
  className?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  /** Set while committing, so a blur fired *by* the commit cannot start a second one. */
  const committing = useRef(false);

  // Whatever changed the name elsewhere — another tab, the agent naming it on the first turn —
  // is what this should be showing once it is not being typed in.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  const open = () => {
    setDraft(name);
    setEditing(true);
    // After the input exists. Selecting rather than placing a caret: the usual intent is to
    // replace a machine-chosen name outright, not to edit one word of it.
    queueMicrotask(() => field.current?.select());
  };

  const commit = () => {
    if (committing.current) return;
    committing.current = true;
    setEditing(false);

    const next = draft.trim();
    // Nothing to do, and deliberately not a request: clicking in and out of a name should not
    // write to the database, and an empty one would only be refused.
    if (next !== "" && next !== name) void onRename(next);
    else setDraft(name);

    committing.current = false;
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`Rename this project. Currently called ${name}`}
        onClick={open}
        className={`group flex min-w-0 items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${className}`}
      >
        <span className="min-w-0 truncate">{name}</span>
        <PencilIcon className="size-3 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }

  return (
    <input
      ref={field}
      // The same name the button carries, so the control does not change identity when it opens.
      aria-label="Project name"
      value={draft}
      maxLength={60}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // A composing IME owns Enter — taking it here commits a half-written word.
        if (event.nativeEvent.isComposing) return;

        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          // Reverted *before* the blur that follows, or `commit` would run on the way out and
          // save the very edit Escape was pressed to discard.
          setDraft(name);
          setEditing(false);
        }
      }}
      className={`min-w-0 rounded-chip border border-line-strong bg-field px-1.5 py-0.5 text-ink outline-none focus-visible:border-accent ${inputClassName}`}
    />
  );
}
