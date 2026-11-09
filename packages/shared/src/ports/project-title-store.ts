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

export interface ProjectTitleStore {
  /** Null when this caller may not start a title now: not theirs, in flight, too soon, or done. */
  claim(projectId: string, userId: string, mode: TitleMode): Promise<TitleClaim | null>;
  /** Writes the name as the model's, if the claim still stands. Answers whether it did. */
  apply(projectId: string, generation: string, name: string, mode: TitleMode): Promise<boolean>;
  /** Gives the claim back without a name, so the next request need not wait it out. */
  release(projectId: string, generation: string): Promise<void>;
}
