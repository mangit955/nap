/**
 * The docs home's own words: the one place the docs speak about themselves rather than about a
 * mechanism. Kept apart so the search index can carry them without importing the page.
 */
export const HOME_INTRO = {
  eyebrow: "Documentation",
  // The one joke in the docs, told once, where no term is at stake.
  title: "How it keeps working while you don’t.",
  body: "Nap is an open-source cloud coding agent. You describe a change; an agent builds it on a machine of its own, checks it, and leaves a verified commit. These pages explain how.",
} as const;
