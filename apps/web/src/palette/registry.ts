"use client";

import { createContext, type RefObject, use, useEffect, useLayoutEffect, useRef } from "react";
import type { Command } from "./commands.ts";

/**
 * Where components offer their commands to the palette.
 *
 * A source is a function the palette calls when it draws, held in a ref, not a list copied into
 * state: a handler is a fresh closure on every render of its owner, and pushing each one through
 * state would re-render the palette, closed or not, every time the workspace's event log moved.
 * Being a function, nothing is built until somebody opens the palette. Each commit still says that
 * something changed, so an open palette draws again rather than show a session that has since
 * finished or run a handler its owner has replaced; a closed one ignores it.
 */
export type CommandRegistry = {
  add: (source: RefObject<CommandSource>) => () => void;
  list: () => Command[];
  changed: () => void;
  subscribe: (listener: () => void) => () => void;
};

export type CommandSource = () => readonly Command[];

export function createCommandRegistry(): CommandRegistry {
  const sources = new Set<RefObject<CommandSource>>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    add(source) {
      sources.add(source);
      changed();
      return () => {
        sources.delete(source);
        changed();
      };
    },
    list: () => [...sources].flatMap((source) => source.current()),
    changed,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const CommandRegistryContext = createContext<CommandRegistry | null>(null);

/**
 * Offers what `commands` returns for as long as the caller is mounted. Outside a palette (the
 * landing page's demos, a replay) there is nowhere to offer them, and this does nothing.
 */
export function useCommands(commands: CommandSource, registry?: CommandRegistry): void {
  const fromContext = use(CommandRegistryContext);
  const target = registry ?? fromContext;
  const latest = useRef(commands);
  // After the commit rather than during render, so a render React throws away leaves no handler.
  useLayoutEffect(() => {
    latest.current = commands;
    target?.changed();
  });
  useEffect(() => target?.add(latest), [target]);
}
