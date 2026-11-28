import type { ReactNode } from "react";

/**
 * One thing the command palette can do. Commands are offered by whatever owns the handler — the
 * frame owns the sidebar, the sidebar owns new sessions and the session list, the workspace owns
 * its right pane — so the palette never reaches into a component to find out what is possible.
 */
export type Command = {
  id: string;
  group: CommandGroup;
  /** Place within its group; registration order depends on mount order, which is not a design. */
  order: number;
  label: string;
  icon: ReactNode;
  /** Drawn at the row's end in muted text, such as how long ago a session moved. */
  meta?: ReactNode;
  run: () => void;
};

export type CommandGroup = (typeof GROUPS)[number];

const GROUPS = ["Actions", "Sessions"] as const;

export type CommandSection = { name: CommandGroup; commands: Command[] };

/** What the palette draws for a query: matching commands by group, empty groups left out. */
export function groupCommands(commands: readonly Command[], query: string): CommandSection[] {
  const needle = query.trim().toLowerCase();
  return GROUPS.map((name) => ({
    name,
    commands: commands
      .filter((item) => item.group === name && item.label.toLowerCase().includes(needle))
      .sort((a, b) => a.order - b.order),
  })).filter((section) => section.commands.length > 0);
}

/** The highlighted row one step on, wrapping at both ends, as the sidebar's search does. */
export function stepIndex(index: number, direction: 1 | -1, count: number): number {
  if (count === 0) return 0;
  return (index + direction + count) % count;
}
