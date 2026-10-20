import type {
  NavigationChange,
  SessionList,
  SessionNavigation,
  SessionReorder,
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
}
