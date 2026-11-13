"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { NapLoader } from "../brand/nap-loader.tsx";
import { NapMark } from "../brand/nap-mark.tsx";
import { pickDifferent } from "../brand/nap-tricks.ts";
import { Spotlight } from "../chat/work-log-rows.tsx";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { AlertIcon } from "../ui/icons.tsx";
import { useElapsed } from "../ui/use-elapsed.ts";
import { previewUrlFor } from "../workspace/route-path.ts";
import { Pane } from "./pane.tsx";

/**
 * The user's app, running.
 *
 * **A reload here is a remount.** The frame is cross-origin, so nothing on this side can call
 * `location.reload()` on it — the only mechanism available is to discard the element and make
 * a new one. A frame's key carries the sequence number of the announcement that produced it, a
 * click counter and the page, so a restarted dev server, the reload button and the address bar
 * all take that path, and an ordinary event arriving does *not*. Remounting on every event would
 * reload the user's app each time the agent spoke.
 *
 * **A new frame is never shown before it has loaded.** A fresh frame is blank until its server
 * answers, which after a restore is seconds of white. So a new frame loads out of sight, and what
 * stands in front of it depends on who asked for it — see `useFrameSwap`.
 *
 * **The frame is sandboxed.** What runs in it was written by a model from whatever someone
 * typed into a chat box. It is served from its own origin, so `allow-same-origin` grants it
 * nothing on this page — it only lets the app keep storage and `fetch` of its own — while
 * `allow-scripts` is what makes a React app run at all.
 */

/** The frame's accessible name. An iframe has no implicit role, so this is how it is found. */
export const PREVIEW_TITLE = "App preview";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

/**
 * How long a new frame may take to load before it is shown anyway.
 *
 * A frame that never fires `load` would otherwise leave whatever stands in front of it up for
 * good — an old frame pointing at a sandbox that may be gone, or a picture of the app from the
 * last turn. Either is worse than a frame that is still loading, so past this the newest one wins.
 * `load` fires for an error page as well as for the app, so this is for the server that never
 * answers at all, not for the one that answers badly.
 */
export const SWAP_TIMEOUT_MS = 5000;

/**
 * What the ghost is up to while a project comes back.
 *
 * Flavour, and unmistakably so — nothing here claims a step has finished, because nothing in
 * the system reports one. The factual line sits underneath, unchanged, with a clock beside it.
 */
const WAITING_WORDS = [
  "Waking up",
  "Stretching",
  "Yawning",
  "Rummaging about",
  "Finding your files",
  "Putting the kettle on",
  "Tidying up",
] as const;

/** Long enough to read, short enough that the screen is never still for long. */
const WORD_MS = 2800;

export type PreviewPaneProps = {
  paneId?: string;
  /**
   * What the project is doing, decided in one place. See `projects/project-phase.ts` — this pane
   * used to fold the log itself and then apply two overrides of its own on top, which is how it
   * came to disagree with the file tree about whether a project was running.
   */
  phase: ProjectPhase;
  onResume?: (() => void) | undefined;
  resumeError?: string | undefined;
  /** The page the frame is being sent to. Owned above, since the bar that sets it is up there. */
  route?: string | undefined;
  /** Bumped by the bar's Reload button; the frame's key reads it. */
  reloads?: number | undefined;
  previewRequired?: boolean;
  /**
   * The project being shown. A frame or a picture belonging to any other is never put on screen —
   * the page switches projects without a document load, so the last one's is always close by.
   */
  projectId?: string | undefined;
  /** The project's last picture, shown under the start-up loader. Ignored unless it is this project's. */
  thumbnail?: { projectId: string; src: string } | undefined;
};

export function PreviewPane({
  paneId = "preview",
  phase,
  onResume,
  resumeError,
  route = "/",
  reloads = 0,
  previewRequired = true,
  projectId = "",
  thumbnail,
}: PreviewPaneProps) {
  const target =
    phase.kind === "running"
      ? {
          // Three things remount the frame and nothing else may: a new announcement, the reload
          // button, and being sent to another page. **The tab is deliberately absent** — the
          // panel is hidden rather than unmounted, so glancing at the code cannot reload
          // somebody's app.
          key: `${projectId}:${phase.seq}:${reloads}:${route}`,
          src: previewUrlFor(phase.url, route),
          projectId,
          reloads,
          route,
        }
      : undefined;
  const { shown, incoming, loaded } = useFrameSwap(target);

  // Each thing below sits in a fixed slot, so moving between the waiting phases and the first frame
  // of a running one does not remount the start-up screen: its clock keeps counting from when the
  // wait began instead of dropping to zero the moment the address is announced.
  const startingUp =
    phase.kind === "starting" ||
    phase.kind === "opening" ||
    (shown === undefined && incoming?.reveal === "startup");
  const reloading = shown === undefined && incoming?.reveal === "reload";
  const replacing = shown !== undefined && incoming !== undefined;
  const picture = thumbnail?.projectId === projectId ? thumbnail.src : undefined;

  return (
    // No title bar: the workbench's tabs say which half this is, and the controls that used to
    // sit here — the host, Reload, Open — are in the one bar across the top, where they stay
    // reachable while somebody is looking at the code.
    <Pane id={paneId} title="Preview" chrome="none">
      {/*
        The waiting frame first, so the one on screen paints over it. Each is keyed by its own
        identity, never by its role: the frame that takes over must stay the same element. Keyed
        "shown" and "incoming", the takeover would reuse the *old* element and point it at the new
        address — a second load of the app the user has just waited for.
      */}
      {[incoming, shown].map(
        (frame) =>
          frame !== undefined && (
            <iframe
              key={frame.key}
              src={frame.src}
              title={PREVIEW_TITLE}
              sandbox={SANDBOX}
              onLoad={() => loaded(frame.key)}
              // Out of reach while it is not the live app: the waiting frame because nobody can see
              // it, and the old one because it may be the address of a sandbox that has gone.
              {...(frame === incoming || replacing ? { inert: true, "aria-hidden": true } : {})}
              // White only once the app has loaded, because that is what an app that sets no
              // background of its own has always rendered on. Until then the pane shows through.
              style={frame === incoming ? HIDDEN : frame.loaded ? LOADED : undefined}
              className="absolute inset-0 h-full w-full border-0"
            />
          ),
      )}
      {startingUp && (
        <StartingUp previewRequired={previewRequired} {...(picture ? { picture } : {})} />
      )}
      {reloading && <Notice label="Loading the preview…" />}
      {replacing && <Notice label="Updating the preview…" corner />}
      {phase.kind !== "running" && phase.kind !== "starting" && phase.kind !== "opening" && (
        <Waiting
          phase={phase}
          {...(onResume === undefined ? {} : { onResume })}
          {...(resumeError === undefined ? {} : { resumeError })}
        />
      )}
    </Pane>
  );
}

/**
 * Hidden by opacity rather than `visibility` or `display`: a frame hidden either of those ways may
 * have its rendering throttled, and would then paint for the first time *after* the swap.
 * Both styles are inline rather than classes so that a test can read them — jsdom applies no
 * stylesheet, and a white background that silently went missing once is what that buys.
 */
const HIDDEN: CSSProperties = { opacity: 0, pointerEvents: "none" };
const LOADED: CSSProperties = { backgroundColor: "white" };

type Target = { key: string; src: string; projectId: string; reloads: number; route: string };
type Frame = Target & { loaded: boolean };
/**
 * What stands in front of a frame that has not loaded yet.
 *
 * - `swap` — the frame it replaces. Nobody asked for this remount: the system announced a new
 *   address, and the old app is the least jarring thing to look at until the new one is up.
 * - `reload` — a loading state. The user pressed Reload or picked a page, so the old frame goes at
 *   once and the pane visibly reloads; holding the old page up would make the button look dead.
 * - `startup` — the start-up screen. Nothing was showing, or the last thing was another project's.
 *
 * Route changes take the reload path rather than the swap, which keeps the rule to one sentence:
 * **what the user asked for shows itself happening; what the system did quietly is hidden until
 * it is ready.** It also means a frame is only ever held up behind its own sandbox's newer self.
 */
type Reveal = "swap" | "reload" | "startup";
type Stack = { shown?: Frame; incoming?: Frame & { reveal: Reveal } };

/**
 * At most two frames: the one on screen and the newest one loading behind it.
 *
 * A change of target makes the new frame the waiting one, **dropping whichever was waiting
 * before** — so a burst of announcements loads only the last of them. The waiting frame takes
 * over when it loads, or after `SWAP_TIMEOUT_MS` whether it has or not; one timer, armed per
 * waiting frame and cleared when that frame is replaced, taken over or unmounted.
 */
function useFrameSwap(target: Target | undefined) {
  const [stack, setStack] = useState<Stack>({});
  const latest = stack.incoming ?? stack.shown;

  // Adjusted during render rather than in an effect, so no frame is ever committed showing a stack
  // that disagrees with the phase — a running project with no frame, or a put-away one with one.
  let current = stack;
  if (target?.key !== latest?.key) {
    current = advance(stack, target);
    setStack(current);
  }

  const waiting = current.incoming?.key;
  useEffect(() => {
    if (waiting === undefined) return;
    const timer = setTimeout(
      () => setStack((now) => takeOver(now, waiting, false)),
      SWAP_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [waiting]);

  const loaded = (key: string) =>
    setStack((now) => {
      if (now.incoming?.key === key) return takeOver(now, key, true);
      if (now.shown?.key === key && !now.shown.loaded) {
        return { ...now, shown: { ...now.shown, loaded: true } };
      }
      return now;
    });

  return { shown: current.shown, incoming: current.incoming, loaded };
}

function advance(stack: Stack, target: Target | undefined): Stack {
  if (target === undefined) return {};
  const { shown } = stack;
  const latest = stack.incoming ?? shown;
  if (shown?.key === target.key) return { shown };

  const fresh = (reveal: Reveal) => ({ incoming: { ...target, loaded: false, reveal } });
  if (latest === undefined || latest.projectId !== target.projectId) return fresh("startup");
  if (latest.reloads !== target.reloads || latest.route !== target.route) return fresh("reload");
  // Still waiting on a first frame, or a reload: the newer address keeps the same screen in front.
  if (shown === undefined) return fresh(stack.incoming?.reveal ?? "startup");
  return { shown, ...fresh("swap") };
}

/**
 * The waiting frame becomes the one on screen, and the frame it replaced is dropped. `loaded` is
 * false when the timeout forced it, and the frame's own `load` sets it later.
 */
function takeOver(stack: Stack, key: string, loaded: boolean): Stack {
  const { incoming } = stack;
  if (incoming?.key !== key) return stack;
  const { reveal: _, ...frame } = incoming;
  return { shown: { ...frame, loaded } };
}

/**
 * A line over the pane saying a frame is on its way.
 *
 * In a corner when the old app is still up behind it, so it marks that app as not live without
 * covering it; in the middle when there is nothing else on screen.
 */
function Notice({ label, corner = false }: { label: string; corner?: boolean }) {
  return (
    <div
      className={
        corner
          ? "pointer-events-none absolute top-3 right-3 flex items-center gap-2 rounded-chip border border-edge bg-panel/90 px-2.5 py-1 shadow-sm"
          : "absolute inset-0 flex flex-col items-center justify-center gap-3"
      }
    >
      <NapLoader className={corner ? "size-4 text-ink-2" : "size-10 text-ink-2"} />
      <p role="status" className="font-mono text-[11px] text-muted">
        {label}
      </p>
    </div>
  );
}

/** Everything that is neither the app nor its start-up: nothing asked for yet, put away, or broken. */
function Waiting({
  phase,
  onResume,
  resumeError,
}: {
  phase: Exclude<ProjectPhase, { kind: "running" | "starting" | "opening" }>;
  onResume?: (() => void) | undefined;
  resumeError?: string | undefined;
}) {
  return (
    // No box. The workbench already draws a bordered panel around this, so a second frame two
    // pixels inside it was a box in a box — and it was *dashed*, which reads as a drop zone
    // waiting for content rather than as a state the project is in.
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {phase.kind === "no-preview" && (
          <>
            <p className="font-display font-semibold text-[15px] text-ink">No preview configured</p>
            <p className="text-[12.5px] text-muted leading-relaxed">
              This repository is ready to work on. Browse its files in Code and send a task in chat.
            </p>
          </>
        )}
        {phase.kind === "idle" && (
          <>
            {/*
              Deliberately no mark here. The chat pane's empty state is showing one a few
              hundred pixels to the left, and two of them side by side reads as a mistake.
            */}
            <p className="font-display font-semibold text-[15px] text-ink">Nothing running yet</p>
            <p className="text-[12.5px] text-muted leading-relaxed">
              Describe an app in the chat and it appears here.
            </p>
          </>
        )}

        {phase.kind === "put-away" && <PutAway onResume={onResume} error={resumeError} />}

        {phase.kind === "failed" && <PreviewFailure message={phase.message} />}
      </div>
    </div>
  );
}

/**
 * The wait while a sandbox comes up, which is tens of seconds in an otherwise empty pane.
 *
 * Three things, and each says something the others cannot. The **ghost** says the page is
 * alive. The **word above the line** changes every few seconds, which is what stops a static
 * screen reading as a stalled one — and it is deliberately whimsy rather than a phase, because
 * **nothing reports the real phase**: a restore emits no progress events, so "Installing
 * dependencies…" would be a number invented to look informative. The **elapsed count** is the
 * one hard fact available, and it is the thing that distinguishes slow from stuck.
 *
 * Only the fixed line is announced. A reader gets "Starting the dev server" once rather than a
 * new word every three seconds, and a clock that would be read out on every tick.
 */
function StartingUp({ previewRequired, picture }: { previewRequired: boolean; picture?: string }) {
  const word = useRotating(WAITING_WORDS, WORD_MS);
  const elapsed = useElapsed({ precision: 0 });
  /**
   * Which picture loaded, and which one failed — addresses rather than flags, so a new picture is
   * tried afresh. Failing is the ordinary case for a project that has never finished a turn.
   */
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showPicture = picture !== undefined && failedSrc !== picture;
  const pictureUp = showPicture && loadedSrc === picture;

  return (
    // Over everything, including a first frame loading behind it, and opaque so that frame cannot
    // show through. `relative` children, because the picture is positioned against this box.
    <div className="absolute inset-0 overflow-hidden bg-panel">
      {showPicture && (
        // The app as the last turn left it — **never mistakable for the app itself**: dimmed and
        // blurred so it reads as a backdrop, unclickable, and named as a snapshot for a reader.
        // Invisible until it has loaded, so a slow picture never shows its alt text and a missing
        // one never shows the browser's broken-image icon before it is taken away.
        //
        // `crossOrigin` and a plain `<img>` for the same reasons as the dashboard's card: the API
        // is another origin, the route asks who is calling, and `next/image` would fetch it from a
        // server holding none of this user's cookies.
        // biome-ignore lint/performance/noImgElement: a private image cannot be optimized by a shared server
        <img
          src={picture}
          alt="Last snapshot of this app, not live"
          crossOrigin="use-credentials"
          draggable={false}
          onLoad={() => setLoadedSrc(picture)}
          onError={() => setFailedSrc(picture)}
          className={`pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-top blur-[2px] grayscale-[40%] transition-opacity duration-300 motion-reduce:transition-none ${pictureUp ? "opacity-30" : "opacity-0"}`}
        />
      )}
      <div className="relative flex h-full items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          {/*
            The ghost rather than a spinner, and big enough to be a character rather than an icon:
            a 20px spinner in a pane this size stops reading as progress about two seconds in.
          */}
          <NapLoader className="size-14 text-ink-2" />

          <div className="flex flex-col items-center gap-1">
            {/* The spotlight the transcript's "Thinking" row wears, so waiting looks like one thing
                wherever it happens. */}
            <p aria-hidden="true" className="text-[13px] text-muted">
              <Spotlight label={`${word}…`} />
            </p>
            <p className="font-mono text-[11px] text-muted tabular-nums">
              {previewRequired ? "Starting the dev server" : "Starting the workspace"} ·{" "}
              <span aria-hidden="true">{elapsed}</span>
            </p>
          </div>
        </div>
      </div>
      {pictureUp && (
        // Said in words as well as by the dimming, because a dimmed picture of an app also looks
        // like an app that is merely disabled.
        <p className="absolute top-3 left-3 rounded-chip border border-edge bg-panel/90 px-2.5 py-1 font-mono text-[11px] text-muted">
          Last snapshot · not live
        </p>
      )}
    </div>
  );
}

/**
 * A different word every `everyMs`, and never the one before it.
 *
 * The same pick the ghost's own tricks use, for the same reason: a fixed rotation is learned in
 * one cycle, after which the screen may as well be static again.
 */
function useRotating(words: readonly string[], everyMs: number): string {
  const [word, setWord] = useState(() => words[0] ?? "");

  useEffect(() => {
    const timer = setInterval(() => {
      setWord((previous) => pickDifferent(words, previous, Math.random()));
    }, everyMs);

    return () => clearInterval(timer);
  }, [words, everyMs]);

  return word;
}

/**
 * The pane for a project nobody is paying for right now.
 *
 * **It says the files are safe before it says anything else**, because that is the question
 * somebody has on finding their app gone. It is also true: the work is in a snapshot, and the
 * only thing that was destroyed is the machine that was serving it.
 *
 * Sending a message also brings a project back, so this is a shortcut rather than the only way
 * through — which is why the button is offered rather than demanded, and why a refusal leaves
 * it on screen instead of replacing it.
 */
function PutAway({
  onResume,
  error,
}: {
  onResume?: (() => void) | undefined;
  error?: string | undefined;
}) {
  return (
    <>
      {/*
        The sleeping mark, which is the one place in the app where the brand's own metaphor is
        literally the state being described: the project is having a nap.
      */}
      <NapMark className="size-8 text-muted" />

      <p className="font-display font-semibold text-[15px] text-ink">This project is put away.</p>
      <p className="text-[12.5px] text-muted leading-relaxed">
        Its files are still saved. Starting it back up takes a few seconds.
      </p>

      {/*
        Solid, matching the composer's send button. The outlined accent version here was the
        only button of its kind in the app — and resuming is the primary action of this screen,
        so it should look like one.
      */}
      <button
        type="button"
        onClick={() => onResume?.()}
        className="mt-1 rounded-chip bg-ink px-3.5 py-1.5 font-medium text-[12.5px] text-surface transition-transform duration-150 hover:bg-white active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        Resume
      </button>

      {error !== undefined && (
        // A live region: it appears in response to a press, and a message that only changes
        // visually is one a screen reader never mentions.
        <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The pane's failure state, in the same words the transcript uses for the same event.
 *
 * Both are downstream of one `turn.failed{sandbox_unavailable}`, and this pane used to have its
 * own wording for it — so a single failure read as two different problems depending on which
 * half of the screen you looked at. The copy comes from one place now; no retry button here,
 * because the transcript already offers one and two controls for one action is a question about
 * which of them is the real one.
 */
function PreviewFailure({ message }: { message: string }) {
  const copy = turnFailureCopy("sandbox_unavailable", message);

  return (
    // The same danger-tinted card the transcript gives a failed turn, so one failure looks like
    // one thing wherever somebody happens to be looking.
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-danger/30 bg-danger/[0.06] px-5 py-4">
      <AlertIcon className="size-5 text-danger" />
      <p className="font-medium text-[13px] text-danger">{copy.title}</p>
      <p className="font-mono text-[11px] text-muted">{copy.detail}</p>
      <p className="text-[12px] text-muted leading-relaxed">{copy.action}</p>
    </div>
  );
}
