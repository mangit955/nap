/**
 * The shape of a conversation, before the conversation arrives.
 *
 * **It exists to stop the pane lying.** With nothing but "are there events", a project whose log
 * is still in flight looked exactly like a project nobody had typed into — so opening a
 * conversation with forty turns in it began with "Describe the app you want" and four example
 * prompts, and then snapped to the real thing. That is a worse first frame than a blank pane:
 * it is a confident, wrong statement about somebody's project.
 *
 * The blocks are laid out as the transcript lays out its items — a short bubble on the right, a
 * few prose lines on the left, one card for the machinery — so the real content lands roughly
 * where the placeholder was instead of jumping. They are deliberately *not* a faithful copy:
 * a placeholder that mimics content too closely reads as content that failed to load.
 *
 * One `status` for the whole thing, and every block hidden. A reader is told once that the
 * conversation is loading; being read a list of five grey rectangles is worse than silence.
 */

/** Widths that do not line up, because a conversation does not. */
const PROSE = ["w-[92%]", "w-[78%]", "w-[85%]", "w-[46%]"] as const;

export function TranscriptSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this conversation"
      className="flex flex-col gap-5 px-4 py-4"
    >
      <div aria-hidden="true" className="flex flex-col gap-5">
        <div className="flex justify-end">
          <span className="nap-skeleton h-8 w-[55%] rounded-2xl rounded-br-md" />
        </div>

        <div className="flex flex-col gap-2">
          {PROSE.slice(0, 3).map((width) => (
            <span key={width} className={`nap-skeleton h-3 rounded-md ${width}`} />
          ))}
        </div>

        {/* Where the folded run of tool calls sits — the one block with a border, since that
            card is the only bordered thing in the transcript. */}
        <span className="nap-skeleton h-11 w-full rounded-xl border border-edge" />

        <div className="flex justify-end">
          <span className="nap-skeleton h-8 w-[38%] rounded-2xl rounded-br-md" />
        </div>

        <div className="flex flex-col gap-2">
          {PROSE.slice(1).map((width) => (
            <span key={width} className={`nap-skeleton h-3 rounded-md ${width}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
