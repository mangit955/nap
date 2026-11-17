/**
 * The replay the front page sends a visitor to.
 *
 * A module of its own, apart from `replays.ts`, because the hero is a client component: importing
 * the path from beside the recordings would put every recording in the front page's bundle.
 */
export const FEATURED_REPLAY_PATH = "/replay/reading-list";
