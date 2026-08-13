/**
 * The three pictures beside the story.
 *
 * They are drawings of *this* product, not of software in general: the same six tool icons the
 * transcript uses, a path that looks like a path, a preview frame with a project URL in it.
 * Generic panels would say only that somebody wanted a picture there.
 *
 * **All three are `aria-hidden`, and the copy beside them carries the meaning.** A screen reader
 * getting "pencil, src/app/page.tsx, check" out of an illustration is being read the set dressing
 * rather than the point, and none of it is anything to operate.
 *
 * They follow the rules `glow/variants.tsx` set for a fake surface: `--s-*` ink only, no accent
 * colour, a dark face only where the real thing is dark, and a fixed inner width so a panel is a
 * stable box rather than something that reflows into an odd shape at some in-between size.
 */

import {
  CheckIcon,
  EyeIcon,
  FileIcon,
  PencilIcon,
  SpinnerIcon,
  TerminalIcon,
} from "../ui/icons.tsx";

/** The shared frame: a white face, a hairline, and the same lift the hero's card has. */
const FACE =
  "rounded-2xl border border-[var(--s-border-1)] bg-[var(--s-surface-1)] shadow-[0_1px_2px_rgba(12,38,77,0.04),0_12px_28px_-18px_rgba(12,38,77,0.22)]";

/** A sentence somebody typed, and the button that sends it. */
export function PromptPanel() {
  return (
    <div aria-hidden="true" className={`${FACE} w-[300px] py-2.5 pr-2.5 pl-5`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--s-text-muted)]">
          build me a habit tracker
        </span>
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[var(--s-text-primary)]">
          <svg
            viewBox="0 0 12 12"
            className="size-4 fill-none stroke-[var(--s-text-inverse)]"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
          </svg>
        </span>
      </div>
    </div>
  );
}

type Step = {
  Icon: typeof PencilIcon;
  verb: string;
  target: string;
  state: "done" | "live";
};

const STEPS: readonly Step[] = [
  { Icon: TerminalIcon, verb: "Ran", target: "bun add zustand", state: "done" },
  { Icon: FileIcon, verb: "Created", target: "src/lib/store.ts", state: "done" },
  { Icon: PencilIcon, verb: "Edited", target: "src/app/page.tsx", state: "done" },
  { Icon: EyeIcon, verb: "Reading", target: "src/app/layout.tsx", state: "live" },
];

/** What the transcript looks like while nobody is watching it. */
export function TranscriptPanel() {
  return (
    <div aria-hidden="true" className={`${FACE} w-[300px] px-4 py-3.5`}>
      <p className="mb-3 text-[11px] text-[var(--s-text-subtle)] uppercase tracking-[0.14em]">
        12 actions
      </p>

      <ul className="space-y-2.5">
        {STEPS.map((step) => (
          <li key={step.target} className="flex items-center gap-2.5">
            <step.Icon className="size-3.5 shrink-0 text-[var(--s-text-subtle)]" />
            <span className="shrink-0 text-[13px] text-[var(--s-text-body)]">{step.verb}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--s-text-muted)]">
              {step.target}
            </span>
            {step.state === "done" ? (
              <CheckIcon className="size-3.5 shrink-0 text-[var(--s-text-subtle)]" />
            ) : (
              <SpinnerIcon className="size-3.5 shrink-0 text-[var(--s-text-body)]" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The app itself, up and serving. Drawn from the same greys as everything else. */
export function PreviewPanel() {
  return (
    <div aria-hidden="true" className={`${FACE} w-[300px] overflow-hidden`}>
      <div className="flex items-center gap-2 border-[var(--s-border-1)] border-b px-3 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2 rounded-full bg-[var(--s-border-1)]" />
          <span className="size-2 rounded-full bg-[var(--s-border-1)]" />
          <span className="size-2 rounded-full bg-[var(--s-border-1)]" />
        </span>
        <span className="ml-1 flex-1 truncate rounded-full bg-[var(--s-surface-3)] px-2.5 py-1 text-[11px] text-[var(--s-text-subtle)]">
          habit-tracker.nap.run
        </span>
      </div>

      <div className="space-y-2.5 p-4">
        <span className="block h-2.5 w-24 rounded-full bg-[var(--s-text-subtle)]/60" />
        <div className="flex gap-2.5">
          <span className="h-12 flex-1 rounded-lg bg-[var(--s-surface-3)]" />
          <span className="h-12 flex-1 rounded-lg bg-[var(--s-surface-3)]" />
        </div>
        <div className="space-y-1.5 pt-1">
          {["82%", "64%", "45%"].map((width) => (
            <span
              key={width}
              className="block h-2 rounded-full bg-[var(--s-surface-3)]"
              style={{ width }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
