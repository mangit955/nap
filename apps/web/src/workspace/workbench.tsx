"use client";

import {
  Earth,
  FileCode2,
  Files,
  GitCompareArrows,
  GitPullRequest,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PhaseDot } from "../chat/job-marks.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import { tabId, tabLabel, WORKBENCH_TABS, type WorkbenchTab } from "./tabs.ts";
import type { PanelController } from "./use-panel-layout.ts";

export function TabIcon({ tab }: { tab: WorkbenchTab }) {
  switch (tab.kind) {
    case "computer":
      return <Monitor />;
    case "preview":
      return <Earth />;
    case "code":
      return <Files />;
    case "diff":
      return <GitCompareArrows />;
    case "pr":
      return <GitPullRequest />;
    case "file":
      return <FileCode2 />;
  }
}

export function Workbench({
  controller,
  maximized,
  onMaximize,
  preview,
  computer,
  code,
  diff,
  pullRequests,
  file,
  job = null,
  chatHidden = false,
  narrow = false,
}: {
  job?: JobSummary | null;
  chatHidden?: boolean;
  narrow?: boolean;
  controller: PanelController;
  maximized: boolean;
  onMaximize: () => void;
  preview: ReactNode;
  computer: ReactNode;
  code: ReactNode;
  diff: ReactNode;
  pullRequests: ReactNode;
  file: (path: string) => ReactNode;
}) {
  const { layout } = controller;
  const launcher = useRef<HTMLDetailsElement>(null);
  const root = useRef<HTMLElement>(null);
  const [context, setContext] = useState<string | null>(null);
  const focusAfterClose = useRef(false);
  const close = (removed: string[], action: () => void) => {
    const focused = document.activeElement;
    focusAfterClose.current =
      focused instanceof Element &&
      (removed.some((id) =>
        document.getElementById(`workbench-tab-${id}`)?.parentElement?.contains(focused),
      ) ||
        !!root.current?.querySelector('[aria-label="Tab actions"]')?.contains(focused));
    action();
    setContext(null);
  };
  useLayoutEffect(() => {
    if (!focusAfterClose.current) return;
    focusAfterClose.current = false;
    root.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], summary')
      ?.focus();
  });
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        launcher.current &&
        event.target instanceof Node &&
        !launcher.current.contains(event.target)
      )
        launcher.current.open = false;
      setContext(null);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    if (!layout.open || !narrow) return;
    const previous = document.activeElement;
    root.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], summary')
      ?.focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        root.current
          ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], summary')
          ?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [layout.open, narrow]);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (context) setContext(null);
      else if (launcher.current?.open) launcher.current.open = false;
      else controller.hide();
      event.stopPropagation();
    }
    if (event.key === "Tab" && narrow) {
      const focusable = [
        ...(root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, summary, [tabindex="0"]',
        ) ?? []),
      ].filter((item) => item.tabIndex >= 0 && item.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const body = (tab: WorkbenchTab) => {
    switch (tab.kind) {
      case "computer":
        return computer;
      case "preview":
        return preview;
      case "code":
        return code;
      case "diff":
        return diff;
      case "pr":
        return pullRequests;
      case "file":
        return file(tab.path);
    }
  };
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is only present with the dialog role on narrow screens.
    <section
      ref={root}
      role={narrow ? "dialog" : "region"}
      aria-modal={narrow ? true : undefined}
      aria-label="Right panel"
      className="t3-workbench"
      hidden={!layout.open}
      onKeyDown={keyboard}
    >
      <div className="t3-panel-header">
        <div
          role="tablist"
          aria-label="Workbench"
          className="t3-tabs"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const index = layout.tabs.findIndex((tab) => tabId(tab) === layout.active);
            const offset = event.key === "ArrowRight" ? 1 : -1;
            if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              const next = layout.tabs[index + offset];
              if (next && layout.active) controller.move(layout.active, tabId(next));
              return;
            }
            const next =
              event.key === "Home"
                ? layout.tabs[0]
                : event.key === "End"
                  ? layout.tabs.at(-1)
                  : layout.tabs[
                      (index + (event.key === "ArrowRight" ? 1 : -1) + layout.tabs.length) %
                        layout.tabs.length
                    ];
            if (!next) return;
            event.preventDefault();
            if (event.altKey && layout.active) controller.move(layout.active, tabId(next));
            else {
              controller.select(tabId(next));
              document.getElementById(`workbench-tab-${tabId(next)}`)?.focus();
            }
          }}
        >
          {layout.tabs.map((tab) => {
            const id = tabId(tab);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: wrapper owns drag/drop; its tab button handles selection and keyboard actions.
              <div
                key={id}
                role="presentation"
                className="t3-tab-wrap"
                data-active={layout.active === id}
                draggable
                onDragStart={(event) => {
                  setDragging(id);
                  event.dataTransfer.setData("text/plain", id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => {
                  if (dragging) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging) controller.move(dragging, id);
                  setDragging(null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContext(id);
                }}
              >
                <button
                  type="button"
                  className="t3-tab"
                  role="tab"
                  id={`workbench-tab-${id}`}
                  aria-selected={layout.active === id}
                  aria-controls={`workbench-${id}`}
                  tabIndex={layout.active === id ? 0 : -1}
                  title={tab.kind === "file" ? tab.path : tabLabel(tab)}
                  onClick={() => controller.select(id)}
                  onKeyDown={(event) => {
                    if (event.key === "Delete") {
                      event.preventDefault();
                      close([id], () => controller.close(id));
                    }
                    if (event.key === "F10" && event.shiftKey) {
                      event.preventDefault();
                      setContext(id);
                    }
                  }}
                >
                  <span className="t3-tab-symbol">
                    <TabIcon tab={tab} />
                  </span>
                  <span className="truncate">{tabLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${tabLabel(tab)}`}
                  title={`Close ${tabLabel(tab)}`}
                  className="t3-tab-close"
                  onClick={() => close([id], () => controller.close(id))}
                >
                  <X />
                </button>
              </div>
            );
          })}
        </div>
        <details ref={launcher} className="t3-launcher">
          <summary className="t3-icon-button" aria-label="Add panel" title="Add panel">
            <Plus />
          </summary>
          <div className="t3-launcher-menu" role="menu" aria-label="Open a panel">
            {WORKBENCH_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  controller.open({ kind: item.id });
                  if (launcher.current) launcher.current.open = false;
                }}
              >
                <TabIcon tab={{ kind: item.id }} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </details>
        {chatHidden && (
          <p role="status" aria-label="Job phase" className="t3-panel-job">
            {job && (
              <>
                <PhaseDot job={job} />
                <span>{job.phaseLabel}</span>
              </>
            )}
          </p>
        )}
        <button
          type="button"
          className="t3-icon-button t3-maximize"
          aria-label={maximized ? "Show chat" : "Hide chat"}
          title={maximized ? "Restore panel" : "Maximize panel"}
          onClick={onMaximize}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button
          type="button"
          className="t3-icon-button"
          aria-label="Close right panel"
          title="Close right panel"
          onClick={controller.hide}
        >
          <X />
        </button>
        {context && (
          <div
            className="t3-tab-context t3-launcher-menu"
            role="menu"
            aria-label="Tab actions"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close([context], () => controller.close(context));
              }}
            >
              Close tab
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(
                  layout.tabs.map(tabId).filter((id) => id !== context),
                  () => controller.closeOthers(context),
                );
              }}
            >
              Close other tabs
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(layout.tabs.map(tabId), controller.closeAll);
              }}
            >
              Close all tabs
            </button>
          </div>
        )}
      </div>
      <div className="t3-panel-content">
        {/* Preview and GitHub state outlive tab selection and closure. */}
        {([{ kind: "preview" }, { kind: "pr" }] satisfies WorkbenchTab[]).map((tab) => (
          <Panel
            key={tab.kind}
            tab={tab}
            active={
              layout.active === tab.kind && layout.tabs.some((item) => item.kind === tab.kind)
            }
          >
            {body(tab)}
          </Panel>
        ))}
        {layout.tabs
          .filter((tab) => tab.kind !== "preview" && tab.kind !== "pr")
          .map((tab) => (
            <Panel key={tabId(tab)} tab={tab} active={layout.active === tabId(tab)}>
              {body(tab)}
            </Panel>
          ))}
        {layout.tabs.length === 0 && (
          <div className="t3-panel-empty t3-panel-launcher">
            <p>Open a panel</p>
            <div>
              {WORKBENCH_TABS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => controller.open({ kind: item.id })}
                >
                  <TabIcon tab={{ kind: item.id }} />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
function Panel({
  tab,
  active,
  children,
}: {
  tab: WorkbenchTab;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section
      role="tabpanel"
      id={`workbench-${tabId(tab)}`}
      aria-label={tabLabel(tab)}
      aria-labelledby={`workbench-tab-${tabId(tab)}`}
      hidden={!active}
      className="t3-panel-body"
    >
      {children}
    </section>
  );
}
