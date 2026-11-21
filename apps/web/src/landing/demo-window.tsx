"use client";

import type { SessionSummary } from "@nap/shared/session-navigation";
import { Files, GitPullRequest, Globe } from "lucide-react";
import { type CSSProperties, type ReactNode, type RefObject, useRef } from "react";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import type { TranscriptItem } from "../chat/transcript.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { SHOWCASE, type Showcase, ShowcaseContext } from "../ui/showcase.ts";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { DEMO_MODELS } from "./demo-sessions.ts";
import { useSpaceScale } from "./use-space-scale.ts";
import "./demo.css";

/**
 * A window of the product, drawn by its own components at a fixed size and scaled to fit.
 *
 * **Fixed size, then scaled**, because the components lay out for a desktop and a demo has to be
 * the same picture at every width (`use-space-scale.ts`). **Cropped**, because a whole workspace
 * shrunk into a column has unreadable labels: each demo draws a space only as large as the part
 * of the window it is about, and `visible` cuts its height so the window runs off the bottom of
 * the backdrop. **A phone gets its own space**: below `NARROW` the stylesheet drops the sidebar
 * and one pane, and the space is as wide as the column (never under `narrow.width`), so the text
 * stays the size it is in the product instead of shrinking with the screen.
 *
 * Everything inside is a picture. It is `inert` and hidden from assistive technology, and the
 * frame carries one accessible name saying what the picture shows.
 */

/** Below this width, in CSS pixels, a demo draws its narrow space. Matches the container query
 *  in `demo.css`. */
export const NARROW = 700;

export type Space = {
  width: number;
  height: number;
  /** How much of the height shows; the rest runs off the bottom. Defaults to all of it. */
  visible?: number;
};

export function DemoFrame({
  label,
  wide,
  narrow,
  className = "",
  frameRef,
  children,
  overlay,
  narrowShows = "chat",
  showcase = SHOWCASE,
}: {
  label: string;
  wide: Space;
  narrow: Space;
  className?: string;
  frameRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  /** Drawn over the window's edge, at the same scale: a panel that floats over it. */
  overlay?: ReactNode;
  /** Which of a workspace's two panes a phone shows. */
  narrowShows?: "chat" | "pane";
  showcase?: Showcase;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = frameRef ?? own;
  // The narrow space is at least `narrow.width` and otherwise as wide as the column, so its text
  // is never drawn larger than the product draws it.
  useSpaceScale(ref, (width) => (width < NARROW ? Math.max(narrow.width, width) : wide.width));
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

export function WindowDots() {
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
