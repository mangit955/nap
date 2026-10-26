"use client";

import { use } from "react";
import type { TranscriptItem } from "../chat/transcript.ts";
import { useElapsed } from "../ui/use-elapsed.ts";
import { computerActionLabel, computerActions } from "./action-labels.ts";
import { ComputerNavigation } from "./navigation.tsx";

export function ComputerActions({ entry }: { entry: Extract<TranscriptItem, { kind: "step" }> }) {
  const seek = use(ComputerNavigation);
  return (
    <div className="ms-7 space-y-1 text-xs text-muted">
      {entry.status === "running" && entry.desktop?.state === "starting" && (
        <DesktopStarting at={entry.desktop.at} />
      )}
      {computerActions(entry.input).map((action, index) => (
        // Actions are append-only within one immutable tool call.
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: an action's position identifies it within its immutable batch.
          key={`${entry.toolCallId}:${index}`}
          type="button"
          className="block rounded px-1 py-0.5 text-left hover:bg-panel disabled:cursor-default focus-visible:outline-accent"
          disabled={!seek || !entry.frame}
          onClick={() => {
            if (entry.frame) seek?.(entry.frame.seq);
          }}
        >
          {computerActionLabel(action)}
        </button>
      ))}
      {entry.status === "failed" && <p className="text-danger">Computer action failed.</p>}
    </div>
  );
}

function DesktopStarting({ at }: { at: string }) {
  const elapsed = useElapsed({ startedAt: at, precision: 0 });
  return <p role="status">Waiting for desktop to be ready ({elapsed})</p>;
}
