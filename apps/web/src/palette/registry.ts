"use client";

import { createContext, type RefObject, use, useEffect, useRef } from "react";
import type { Command } from "./commands.ts";

/**
 * Where components offer their commands to the palette.
 *
 * A source is a function the palette calls when it draws, held in a ref, not a list copied into
 * state: a handler is a fresh closure on every render of its owner, and pushing each one through
 * state would re-render the palette — closed or not — every time the workspace's event log moved.
 * Being a function, nothing is built until somebody opens the palette.
 */
export type CommandRegistry = {
  add: (source: RefObject<CommandSource>) => () => void;
  list: () => Command[];
};

export function createCommandRegistry(): CommandRegistry {
  const sources = new Set<RefObject<CommandSource>>();
  return {
    add(source) {
      sources.add(source);
      return () => {
        sources.delete(source);
      };
    },
    list: () => [...sources].flatMap((source) => source.current()),
  };
}

export type CommandSource = () => readonly Command[];

export const CommandRegistryContext = createContext<CommandRegistry | null>(null);

/**
 * Offers what `commands` returns for as long as the caller is mounted. Outside a palette — the
 * landing page's demos, a replay — there is nowhere to offer them, and this does nothing.
 */
export function useCommands(commands: CommandSource, registry?: CommandRegistry): void {
  const fromContext = use(CommandRegistryContext);
  const target = registry ?? fromContext;
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => target?.add(latest), [target]);
}
