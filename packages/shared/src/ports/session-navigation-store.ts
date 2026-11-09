import type {
  AutoSettleSettings,
  NavigationChange,
  SessionList,
  SessionNavigation,
  SessionReorder,
  SessionSearch,
} from "../session-navigation.ts";

export type NavigationResult =
  | { kind: "saved"; navigation: SessionNavigation; revision: number }
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "busy" };
export interface SessionNavigationStore {
  list(userId: string, after?: string): Promise<SessionList>;
  change(userId: string, projectId: string, input: NavigationChange): Promise<NavigationResult>;
  reorder(
    userId: string,
    input: SessionReorder,
  ): Promise<{ kind: "saved" | "missing" | "conflict" }>;
  /** The caller's own sessions whose name or messages contain `query`, newest first. */
  search(userId: string, query: string): Promise<SessionSearch>;
  autoSettleSettings(userId: string): Promise<AutoSettleSettings>;
  saveAutoSettleSettings(userId: string, settings: AutoSettleSettings): Promise<void>;
}

/**
 * The reaper's half: settling every session whose owner's rules say so, in one bounded statement.
 * Safe to call on every tick — a session it settled, or one its owner took back out of Settled, is
 * not settled again until something new happens in it. Answers the projects it settled.
 */
export interface SessionAutoSettler {
  autoSettle(limit?: number): Promise<string[]>;
}
