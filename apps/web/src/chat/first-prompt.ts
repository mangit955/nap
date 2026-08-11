/**
 * The sentence someone typed on the landing page, carried across a navigation.
 *
 * Two hand-offs use this, and they differ in one way that matters. One carries a prompt into a
 * project that has just been created — that one names the project, and the workspace sends it
 * as the first turn. The other carries a prompt across sign-in, before any project exists — it
 * names nothing, and comes back into the box for the user to send themselves. **A prompt is
 * never sent on the strength of a stash alone**: a stale entry, or a tab the browser restored,
 * would otherwise start a sandbox and a model call that nobody asked for right then.
 *
 * `sessionStorage` rather than a query parameter: a prompt is a paragraph, it ends up in
 * browser history and server logs as a URL, and it is nobody's business but the person who
 * typed it. Per-tab rather than per-browser for the same reason a second tab should not
 * inherit the first one's half-finished thought.
 *
 * The storage is an argument so every branch is testable without a DOM, and every read is a
 * *take* — it removes what it returns, so nothing can be replayed by going back.
 */

/** The subset of `Storage` this needs; `window.sessionStorage` satisfies it. */
export type PromptStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const PROJECT_KEY = "nap.first-prompt";
const PENDING_KEY = "nap.pending-prompt";

/** The prompt to send as a new project's first turn. */
export function stashFirstPrompt(
  projectId: string,
  text: string,
  storage: PromptStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined || text.trim() === "") return;
  storage.setItem(PROJECT_KEY, JSON.stringify({ projectId, text }));
}

/**
 * Reads it back exactly once, and only for the project it was written for. A stash belonging
 * to a different project is left where it is: it is another workspace's first turn, and
 * consuming it here would silently lose it.
 */
export function takeFirstPrompt(
  projectId: string,
  storage: PromptStorage | undefined = defaultStorage(),
): string | undefined {
  if (storage === undefined) return undefined;

  const raw = storage.getItem(PROJECT_KEY);
  if (raw === null) return undefined;

  const stash = parse(raw);
  if (stash === undefined) {
    // Unreadable is not another project's — nobody will ever want it, so it goes.
    storage.removeItem(PROJECT_KEY);
    return undefined;
  }
  if (stash.projectId !== projectId) return undefined;

  storage.removeItem(PROJECT_KEY);
  return stash.text;
}

/** The prompt someone typed before signing in, kept so the box is not empty when they return. */
export function stashPendingPrompt(
  text: string,
  storage: PromptStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined || text.trim() === "") return;
  storage.setItem(PENDING_KEY, text);
}

export function takePendingPrompt(
  storage: PromptStorage | undefined = defaultStorage(),
): string | undefined {
  if (storage === undefined) return undefined;

  const text = storage.getItem(PENDING_KEY);
  if (text === null) return undefined;

  storage.removeItem(PENDING_KEY);
  return text;
}

function parse(raw: string): { projectId: string; text: string } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { projectId, text } = value as Record<string, unknown>;
    return typeof projectId === "string" && typeof text === "string"
      ? { projectId, text }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Absent during server rendering, and in a browser that has disabled storage entirely. */
function defaultStorage(): PromptStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
