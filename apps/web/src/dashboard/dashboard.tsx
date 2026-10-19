"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PanelIcon } from "../ui/icons.tsx";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";

export function Dashboard({
  sidebar,
  hero,
  grid,
  fading = false,
  contentLandmark = true,
}: {
  sidebar: ReactNode;
  hero: ReactNode;
  grid?: ReactNode;
  fading?: boolean;
  contentLandmark?: boolean;
}) {
  const Content = contentLandmark ? "main" : "div";
  useDocumentScrollLock();
  const [collapsed, setCollapsed] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
    mobileTrigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    const drawer = navigation.current;
    drawer
      ?.querySelector<HTMLElement>("a[href], button:not([disabled]), input:not([disabled])")
      ?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // Native rename/account dialogs keep their own Escape and Tab handling.
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
      } else if (event.key === "Tab" && drawer) {
        const targets = [
          mobileTrigger.current,
          ...drawer.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
          ),
        ].filter(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.getClientRects().length > 0,
        );
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
    document.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("change", onResize);
    };
  }, [navigationOpen, closeNavigation]);

  return (
    <div
      aria-busy={fading}
      className={`dashboard-frame relative grid h-dvh overflow-hidden bg-surface text-ink transition-opacity duration-200 ${fading ? "opacity-60" : "opacity-100"}`}
      data-signing-out={fading}
      data-sidebar-collapsed={collapsed}
      data-navigation-open={navigationOpen}
    >
      <button
        type="button"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="sidebar-toggle desktop-sidebar-toggle"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <PanelIcon open={!collapsed} />
      </button>
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
        className="dashboard-sidebar min-h-0"
        onClickCapture={(event) => {
          if (
            navigationOpen &&
            event.target instanceof Element &&
            event.target.closest("a, [data-new-session]")
          )
            closeNavigation();
        }}
      >
        {sidebar}
      </div>
      <Content
        inert={navigationOpen}
        className="dashboard-content nap-scroll-hidden relative min-h-0 min-w-0 overflow-y-auto"
      >
        {hero}
        {grid}
      </Content>
    </div>
  );
}
