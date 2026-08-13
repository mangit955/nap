/**
 * The sentence someone typed on the landing page, carried into the project it created.
 *
 * `sessionStorage` rather than a query parameter: a prompt is a paragraph, it ends up in
 * browser history and server logs as a URL, and it is nobody's business but the person who
 * typed it. Per-tab rather than per-browser, for the same reason a second tab should not
 * inherit the first one's half-finished thought.
 *
 * The storage is an argument so every branch is testable without a DOM, and every read is a
 * *take* — it removes what it returns, so nothing can be replayed by going back. It is also
 * addressed to one project: a stash written for another is left alone rather than consumed,
 * because consuming it here would silently lose that project's first turn.
 */

/** The subset of `Storage` this needs; `window.sessionStorage` satisfies it. */
export type PromptStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const PROJECT_KEY = "nap.first-prompt";

/** The prompt to send as a new project's first turn. */
export type FirstPrompt = {
  text: string;
  /** Absent means the server's fallback, rather than a browser guess at what that is. */
  model?: string | undefined;
};

export function stashFirstPrompt(
  projectId: string,
  prompt: FirstPrompt,
  storage: PromptStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined || prompt.text.trim() === "") return;
  storage.setItem(PROJECT_KEY, JSON.stringify({ projectId, ...prompt }));
}

/**
 * Reads it back exactly once, and only for the project it was written for. A stash belonging
 * to a different project is left where it is: it is another workspace's first turn, and
 * consuming it here would silently lose it.
 */
export function takeFirstPrompt(
  projectId: string,
  storage: PromptStorage | undefined = defaultStorage(),
): FirstPrompt | undefined {
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
  return { text: stash.text, ...(stash.model === undefined ? {} : { model: stash.model }) };
}

function parse(raw: string): ({ projectId: string } & FirstPrompt) | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { projectId, text, model } = value as Record<string, unknown>;
    return typeof projectId === "string" &&
      typeof text === "string" &&
      (model === undefined || typeof model === "string")
      ? { projectId, text, ...(typeof model === "string" ? { model } : {}) }
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
