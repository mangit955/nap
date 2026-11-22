"use client";

import type { GitComparison } from "@nap/shared/git-protocol";
import type { SessionSummary } from "@nap/shared/session-navigation";
import { Files, GitPullRequest, Globe } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import type { TranscriptItem } from "../chat/transcript.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { SHOWCASE, type Showcase, ShowcaseContext } from "../ui/showcase.ts";
import { DiffFile } from "../workspace/changes-panel.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { DEMO_MODELS } from "./demo-sessions.ts";
import { type SpaceChoice, useSpaceScale } from "./use-space-scale.ts";
import "./demo.css";

/**
 * A window of the product, drawn by its own components at a fixed size and scaled to fit.
 *
 * **Fixed size, then scaled**, because the components lay out for a desktop and a demo has to be
 * the same picture at every width (`use-space-scale.ts`). **Cropped**, because a whole workspace
 * shrunk into a column has unreadable labels: each demo draws a space only as large as the part
 * of the window it is about, and `visible` cuts its height so the window runs off the bottom of
 * the backdrop. **A phone gets its own space** (`chooseSpace`): the sidebar and one pane go, and
 * the text stays the size it is in the product instead of shrinking with the screen. The hook
 * writes which space it chose to `data-space`, and `demo.css` lays the space out from that; the
 * frame's own height comes from the stylesheet alone, so it is right before any script runs.
 *
 * Everything inside is a picture. It is `inert` and hidden from assistive technology, and the
 * frame carries one accessible name saying what the picture shows.
 */

export type Space = {
  width: number;
  height: number;
  /** How much of the height shows; the rest runs off the bottom. Defaults to all of it. */
  visible?: number;
};

/**
 * The smallest scale a wide space is drawn at: the smallest text that tells a demo's story, the
 * plan's 11.5px "Plan · 3 of 4 done", at 9px. `scripts/check-landing.js` measures the rendered
 * text against the same 9px.
 */
const MIN_SCALE = 9 / 11.5;

/**
 * The column width below which a demo drawn `wide` pixels wide switches to its narrow space. The
 * stylesheet reserves each demo's height from the same numbers before any script runs (`demo.css`,
 * held to them by `demo-window.test.tsx`): the hero's 1280 switches below 1002, the rows' 900
 * below 705.
 */
export function narrowBelow(wide: number): number {
  return Math.ceil(wide * MIN_SCALE);
}

/**
 * The space a demo draws at a given column width: the wide one, or below `narrowBelow` the narrow
 * one, as wide as the column (never under `narrow.width`) so its text is never drawn larger than
 * the product draws it.
 */
export function chooseSpace(column: number, wide: Space, narrow: Space): SpaceChoice {
  return column >= narrowBelow(wide.width)
    ? { width: wide.width, layout: "wide" }
    : { width: Math.max(narrow.width, column), layout: "narrow" };
}

export function DemoFrame({
  label,
  wide,
  narrow,
  className = "",
  children,
  overlay,
  narrowShows = "chat",
  showcase = SHOWCASE,
}: {
  label: string;
  wide: Space;
  narrow: Space;
  className?: string;
  children: ReactNode;
  /** Drawn over the window's edge, at the same scale: a panel that floats over it. */
  overlay?: ReactNode;
  /** Which of a workspace's two panes a phone shows. */
  narrowShows?: "chat" | "pane";
  showcase?: Showcase;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSpaceScale(ref, (width) => chooseSpace(width, wide, narrow));
  const style: CSSProperties & Record<`--${string}`, number> = {
    "--wide-w": wide.width,
    "--wide-h": wide.height,
    "--wide-v": wide.visible ?? wide.height,
    "--narrow-w": narrow.width,
    "--narrow-h": narrow.height,
    "--narrow-v": narrow.visible ?? narrow.height,
  };
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      // `dashboard-preview` gives the product's dark tokens to everything inside, as the app has.
      className={`lp-demo dashboard-preview ${className}`}
      data-narrow={narrowShows}
      style={style}
    >
      <div className="lp-demo-crop" inert aria-hidden="true">
        <ShowcaseContext value={showcase}>
          <div className="lp-demo-space">{children}</div>
        </ShowcaseContext>
      </div>
      {overlay && (
        <div className="lp-demo-overlay" inert aria-hidden="true">
          <ShowcaseContext value={showcase}>{overlay}</ShowcaseContext>
        </div>
      )}
    </div>
  );
}

const noop = () => {};

/** The workspace: an optional sidebar, the bar, the transcript and composer, and a right pane. */
export function DemoWorkspace({
  sessions,
  activeProjectId,
  title,
  job,
  items,
  right,
}: {
  /** Absent draws no sidebar. */
  sessions?: readonly SessionSummary[] | undefined;
  activeProjectId?: string | undefined;
  title: string;
  job: JobSummary;
  items: readonly TranscriptItem[];
  right: ReactNode;
}) {
  return (
    <div className="lp-window" data-sidebar={sessions !== undefined}>
      <WindowDots />
      {sessions && (
        <div className="lp-window-sidebar">
          <Sidebar
            persistScroll={false}
            name="You"
            email={undefined}
            recents={[]}
            sessions={sessions}
            activeProjectId={activeProjectId}
            keyHint={undefined}
            onNewProject={noop}
            onApiKey={noop}
            onSignOut={noop}
          />
        </div>
      )}
      <div className="lp-window-main">
        <div className="lp-window-header">
          <WorkspaceHeader projectName={title} job={job} panelOpen onTogglePanel={noop} />
        </div>
        <div className="lp-window-panes">
          <div className="lp-window-chat">
            <div className="lp-window-transcript">
              <ChatTranscript items={items} />
            </div>
            <div className="lp-window-composer">
              <ChatInput
                running={false}
                error={undefined}
                onSubmit={noop}
                onCancel={noop}
                models={DEMO_MODELS}
                model="opus"
                onModelChange={noop}
                effort="high"
                defaultEffort="high"
                onEffortChange={noop}
              />
            </div>
          </div>
          <div className="lp-window-right">{right}</div>
        </div>
      </div>
    </div>
  );
}

function WindowDots() {
  return (
    <span className="lp-window-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

const TABS = {
  Preview: <Globe className="size-3.5" />,
  Code: <Files className="size-3.5" />,
  "Pull request": <GitPullRequest className="size-3.5" />,
};

/** The right pane's tab strip, as the workspace draws it. */
export function PaneTabs({
  tabs,
  active,
}: {
  tabs: readonly (keyof typeof TABS)[];
  active: keyof typeof TABS;
}) {
  return (
    <div className="lp-pane-tabs">
      {tabs.map((tab) => (
        <span key={tab} data-active={tab === active}>
          {TABS[tab]}
          {tab}
        </span>
      ))}
    </div>
  );
}

/** A small window with a title bar, for a panel shown on its own or floating over another. */
export function Panel({
  icon,
  title,
  aside,
  className = "",
  children,
}: {
  icon: ReactNode;
  title: string;
  aside?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`lp-panel ${className}`} data-arrive>
      <div className="lp-panel-head">
        <WindowDots />
        {icon}
        <span>{title}</span>
        {aside && <span className="lp-panel-aside">{aside}</span>}
      </div>
      <div className="lp-panel-body">{children}</div>
    </div>
  );
}

/**
 * Whether a diff under `root` has drawn: anything but the product's "Loading diff…" placeholder.
 * Its other notices (a binary file, a raw patch shown because highlighting failed) are finished
 * states and are shown. The text is the product's, in `changes-panel.tsx` and `pierre-patch.tsx`.
 */
export function isDrawn(root: Element): boolean {
  return ![...root.querySelectorAll(".t3-diff-notice")].some(
    (notice) => notice.textContent === "Loading diff…",
  );
}

/**
 * A diff that stays invisible until it has drawn, then fades in.
 *
 * The product draws a diff on the client only, after its highlighter loads, and says "Loading
 * diff…" until then: honest in the app, but on the landing page it is the first thing the hero
 * shows and then a hard cut (`isDrawn`). `onDrawn` lets the hero start its clock from here.
 */
export function DrawnDiff({
  file,
  onDrawn,
}: {
  file: GitComparison["files"][number];
  onDrawn?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new MutationObserver(() => check());
    const check = () => {
      if (!isDrawn(element)) return;
      setDrawn(true);
      observer.disconnect();
    };
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    check();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (drawn) onDrawn?.();
  }, [drawn, onDrawn]);
  return (
    <div ref={ref} className="lp-drawn-diff" data-drawn={drawn}>
      <DiffFile file={file} split={false} />
    </div>
  );
}
