/**
 * The examples offered under the box.
 *
 * Chosen to be *small and finishable* rather than impressive: each one is a single screen with
 * obvious state, so the first thing anybody sees the agent do is something it completes. A
 * prompt that reads well and takes twenty turns is a worse first impression than a dull one
 * that works, and these are what most people will press instead of typing.
 */
export const EXAMPLE_PROMPTS = [
  "a pomodoro timer with a circular countdown",
  "a markdown notes app with local storage",
  "a colour palette generator I can lock swatches in",
  "a habit tracker with a weekly grid",
] as const;
