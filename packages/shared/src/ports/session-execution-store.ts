import type { ExecutionPreference, ExecutionSelection } from "../execution-target.ts";
/** User preference only. Every admitted request resolves a fresh, independently fenced target. */
export interface SessionExecutionStore {
  selection(userId: string, sessionId: string): Promise<ExecutionPreference | null>;
  select(userId: string, sessionId: string, selection: ExecutionSelection): Promise<boolean>;
}
