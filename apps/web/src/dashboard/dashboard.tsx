"use client";

import { PanelLeft } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CommandPalette } from "../palette/command-palette.tsx";
import { CommandRegistryContext, createCommandRegistry, useCommands } from "../palette/registry.ts";
import { PanelIcon } from "../ui/icons.tsx";
import { Splitter } from "../ui/splitter.tsx";
import { Toaster } from "../ui/toast.tsx";
import { Tooltip, TooltipProvider } from "../ui/tooltip.tsx";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";

export function Dashboard({
  sidebar,
  hero,
  grid,
  fading = false,
  contentLandmark = true,
  contentRef,
  details,
  detailsCard,
}: {
  sidebar: ReactNode | ((controls: { closeNavigation: () => void }) => ReactNode);
  hero: ReactNode;
  grid?: ReactNode;
  fading?: boolean;
  contentLandmark?: boolean;
  /** Measures the content area, which decides whether the details card floats or pops over. */
  contentRef?: ((element: HTMLElement | null) => void) | undefined;
  /** The thread details card and its toggle, drawn over the content's top right. */
  details?: ReactNode;
  /** How the card is showing, so the composer's lane can keep clear of it. */
  detailsCard?: "inline" | "popover" | undefined;
}) {
  const Content = contentLandmark ? "main" : "div";
  useDocumentScrollLock();
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarMotion, setSidebarMotion] = useState(false);
  const [width, setWidth] = useState(256);
  const resize = useCallback((next: number) => {
    const value = Math.round(
      Math.max(208, Math.min(Math.max(208, Math.min(420, window.innerWidth - 400)), next)),
    );
    setWidth(value);
    try {
      localStorage.setItem("nap.sidebar.width", String(value));
    } catch {
      /* Width still applies for this page. */
    }
  }, []);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("nap.sidebar.width"));
      if (saved > 0 && Number.isFinite(saved)) resize(saved);
      setCollapsed(localStorage.getItem("nap.sidebar.collapsed") === "true");
    } catch {
      /* Storage is optional for layout. */
    }
  }, [resize]);
  useEffect(() => {
    const clamp = () => resize(width);
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [resize, width]);
  const frameStyle: CSSProperties & { "--sidebar-width": string } = {
    "--sidebar-width": `${width}px`,
  };
  const [navigationOpen, setNavigationOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const desktopTrigger = useRef<HTMLButtonElement>(null);
  const toggleCollapsed = () => {
    setSidebarMotion(true);
    setCollapsed(!collapsed);
    try {
      localStorage.setItem("nap.sidebar.collapsed", String(!collapsed));
    } catch {
      /* Optional preference. */
    }
  };
  // One palette for this frame, so the dashboard and every project's workspace share it, and
  // whatever is drawn inside offers its own commands to it.
  const [commands] = useState(createCommandRegistry);
  useCommands(
    () => [
      {
        id: "toggle-sidebar",
        group: "Actions",
        order: 1,
        label: "Toggle sidebar",
        icon: <PanelLeft className="size-4" aria-hidden />,
        // A narrow screen has no column to collapse; its sidebar is the drawer, which the palette
        // has already put away by the time this runs (`beforeRun` below) if it was open.
        run: () => {
          if (window.matchMedia("(max-width: 767px)").matches) {
            if (!navigationOpen) setNavigationOpen(true);
            return;
          }
          // Collapsing makes the column inert, which would drop focus held inside it to the body;
          // the toggle button keeps it, as clicking the button itself does.
          if (!collapsed && navigation.current?.contains(document.activeElement))
            desktopTrigger.current?.focus();
          toggleCollapsed();
        },
      },
    ],
    commands,
  );
  const closeNavigation = useCallback(() => {
    if (!navigationOpen) return;
    setNavigationOpen(false);
    mobileTrigger.current?.focus();
  }, [navigationOpen]);

  useEffect(() => {
    if (!navigationOpen) return;
    const drawer = navigation.current;
    drawer
      ?.querySelector<HTMLElement>("a[href], button:not([disabled]), input:not([disabled])")
      ?.focus();
    // Observe descendant activation after React's row handlers can cancel deferred clicks.
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        !drawer?.contains(event.target)
      )
        return;
      if (event.target.closest("[data-new-session]")) {
        closeNavigation();
        return;
      }
      const anchor = event.target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self") ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      // Recheck cancellation after synchronous dispatch of replayed clicks.
      // Native clicks may run this microtask before later document listeners.
      queueMicrotask(() => {
        if (!event.defaultPrevented) closeNavigation();
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Native rename/account dialogs keep their own Escape and Tab handling, and so do the toasts,
      // which sit outside the drawer: F6 is a keyboard's way to them, and the trap below would pull
      // focus from a toast's buttons straight back to the rows.
      if (
        event.target instanceof Element &&
        event.target.closest("dialog[open], [data-toast-viewport]")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
      } else if (event.key === "Tab" && drawer) {
        const targets = [
          mobileTrigger.current,
          ...drawer.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
          ),
        ].filter((node): node is HTMLElement => {
          if (
            !(node instanceof HTMLElement) ||
            node.matches(":disabled, [tabindex='-1']") ||
            node.closest("[hidden], [inert]") ||
            node.getClientRects().length === 0
          )
            return false;
          const closed = node.closest("details:not([open])");
          return !closed || node.closest("summary")?.parentElement === closed;
        });
        if (targets.length === 0) return;
        const focused = document.activeElement;
        const index = focused instanceof HTMLElement ? targets.indexOf(focused) : -1;
        const next = (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        event.preventDefault();
        targets[next]?.focus();
      }
    };
    const viewport = window.matchMedia("(max-width: 767px)");
    const onResize = () => {
      if (!viewport.matches) setNavigationOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("change", onResize);
    };
  }, [navigationOpen, closeNavigation]);

  return (
    // One tooltip group and one toast stack for the dashboard and each project's workspace, the
    // two pages drawn in this frame.
    <TooltipProvider>
      <CommandRegistryContext.Provider value={commands}>
        <Toaster />
        {/* Whatever a command shows is in the content the open drawer covers. */}
        <CommandPalette registry={commands} beforeRun={closeNavigation} />
        <div
          style={frameStyle}
          aria-busy={fading}
          className={`dashboard-frame relative grid h-dvh overflow-hidden bg-surface text-ink transition-opacity duration-200 ${fading ? "opacity-60" : "opacity-100"}`}
          data-signing-out={fading}
          data-sidebar-collapsed={collapsed}
          data-sidebar-motion={sidebarMotion}
          data-navigation-open={navigationOpen}
          data-details-card={detailsCard}
        >
          <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
            <button
              ref={desktopTrigger}
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              onClick={(event) => {
                event.currentTarget.focus();
                toggleCollapsed();
              }}
              className="sidebar-toggle desktop-sidebar-toggle"
            >
              <PanelIcon open={!collapsed} />
            </button>
          </Tooltip>
          <button
            ref={mobileTrigger}
            type="button"
            aria-label={navigationOpen ? "Close sessions" : "Open sessions"}
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen(!navigationOpen)}
            className="sidebar-toggle mobile-sidebar-toggle"
          >
            <PanelIcon open={navigationOpen} />
          </button>
          {navigationOpen && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={closeNavigation}
              className="sidebar-backdrop"
            />
          )}
          <div
            ref={navigation}
            inert={collapsed && !navigationOpen}
            className="dashboard-sidebar min-h-0"
          >
            {typeof sidebar === "function" ? sidebar({ closeNavigation }) : sidebar}
          </div>
          {!collapsed && (
            <div className="sidebar-resize">
              <Splitter
                label="Sidebar width"
                value={width}
                onGrab={(event) => {
                  event.preventDefault();
                  const target = event.currentTarget;
                  if (target instanceof HTMLElement) target.focus();
                  target.setPointerCapture(event.pointerId);
                  // Follow the drag distance, not the pointer's x: while the column is still
                  // animating open, the handle sits short of the saved width.
                  const from = { x: event.clientX, width };
                  const move = (next: Event) => {
                    if (next instanceof PointerEvent) resize(from.width + next.clientX - from.x);
                  };
                  const stop = () => {
                    target.removeEventListener("pointermove", move);
                    target.removeEventListener("lostpointercapture", stop);
                  };
                  target.addEventListener("pointermove", move);
                  target.addEventListener("lostpointercapture", stop, { once: true });
                }}
                onKeyDown={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    resize(
                      event.key === "Home"
                        ? 208
                        : event.key === "End"
                          ? 420
                          : width + (event.key === "ArrowLeft" ? -16 : 16),
                    );
                  }
                }}
              />
            </div>
          )}
          <Content
            ref={contentRef}
            inert={navigationOpen}
            className="dashboard-content nap-scroll-hidden relative min-h-0 min-w-0 overflow-y-auto"
          >
            {hero}
            {grid}
          </Content>
          <div inert={navigationOpen} style={{ display: navigationOpen ? "none" : "contents" }}>
            {details}
          </div>
        </div>
      </CommandRegistryContext.Provider>
    </TooltipProvider>
  );
}
