/**
 * Claiming, applying and abandoning a model-written session title (docs/adr/0031).
 *
 * Every write is conditional, and the conditions are the whole of the safety: a claim is refused
 * while another title is in flight, and an answer is applied only while its claim still stands,
 * which a rename by the person ends.
 */

/**
 * `automatic` is the one title a new project gets after its first prompt: only over a seed name,
 * and only once. `manual` is the person pressing Regenerate title, which may replace any name.
 */
export type TitleMode = "automatic" | "manual";

/**
 * How soon after one title request another may be made, so clicks cannot run up a bill. Here
 * rather than beside the store's SQL because the route tells the person how long to wait.
 */
export const TITLE_COOLDOWN_SECONDS = 10;

export type TitleClaim = {
  /** The claim's identity; the answer is applied only while the project still holds it. */
  generation: string;
  /** The name now, which a regenerate prompt shows the model and a failure leaves in place. */
  currentName: string;
  /** The project's newest session, where `project.renamed` is written. */
  sessionId: string;
  /** The person's own messages in that session: the first, then up to the three latest. */
  messages: string[];
  /** The repository the session came from, which a title must not repeat. */
  sourceName: string | null;
};

/**
 * Why a title could not be started: one is being written now, one was asked for moments ago, or
 * this caller may not start one (not theirs, no session yet, or the automatic one was had).
 */
export type TitleRefusal = "in_flight" | "cooldown" | "refused";

export interface ProjectTitleStore {
  claim(projectId: string, userId: string, mode: TitleMode): Promise<TitleClaim | TitleRefusal>;
  /** Writes the name as the model's, if the claim still stands. Answers whether it did. */
  apply(projectId: string, generation: string, name: string, mode: TitleMode): Promise<boolean>;
  /** Gives the claim back without a name, so the next request need not wait it out. */
  release(projectId: string, generation: string): Promise<void>;
}
