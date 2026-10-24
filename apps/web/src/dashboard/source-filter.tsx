"use client";
import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import { ListFilter } from "lucide-react";
import { useRef, useState } from "react";
import { SourceMark } from "./session-row.tsx";
import { sessionSource } from "./session-rows.ts";

export function SourceFilter({
  sessions,
  value,
  onChange,
}: {
  sessions: readonly SessionSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const now = Date.now();
  const sources = [
    ...new Set([
      null,
      ...sessions
        .filter((row) => sessionSection(row, now) !== "archived")
        .map((row) => row.repository),
    ]),
  ].map(sessionSource);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the popup when focus leaves its controls.
    <div
      className="shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Filter by source"
        title="Filter by source"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setQuery("");
        }}
        className={`grid size-8 place-items-center rounded-md hover:bg-hover ${value ? "text-accent-ink" : "text-muted"}`}
      >
        <ListFilter aria-hidden className="size-4" />
      </button>
      {open && (
        <div className="composer-surface nap-float absolute left-0 top-full z-40 mt-1 w-full rounded-[10px] p-1.5 [--float-origin:top]">
          <input
            aria-label="Search sources"
            placeholder="Find a source…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-1 w-full rounded border border-edge bg-field p-2 text-xs outline-none focus:border-accent"
          />
          <div className="max-h-64 overflow-y-auto">
            {[
              { key: "", label: "All sources", owner: null },
              ...sources.filter((source) => source.key.toLowerCase().includes(query.toLowerCase())),
            ].map((source) => (
              <button
                key={source.key}
                type="button"
                aria-pressed={value === source.key}
                onClick={() => {
                  onChange(source.key);
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className="flex w-full items-center gap-2 rounded p-2 text-left text-xs text-ink-2 hover:bg-hover"
              >
                <SourceMark source={source} />
                <span className="truncate">
                  {source.key && source.owner ? source.key : source.label}
                </span>
                {value === source.key && (
                  <span aria-hidden className="ml-auto">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
