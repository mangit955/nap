"use client";

import { type ReactNode, useRef, useState } from "react";
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
  const closeNavigation = () => {
    setNavigationOpen(false);
    mobileTrigger.current?.focus();
  };

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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates Escape and navigation from interactive descendants. */}
      <div
        className="dashboard-sidebar min-h-0"
        onKeyDown={(event) => {
          if (event.key === "Escape" && navigationOpen) closeNavigation();
        }}
        onClickCapture={(event) => {
          if (navigationOpen && event.target instanceof Element && event.target.closest("a"))
            closeNavigation();
        }}
      >
        {sidebar}
      </div>
      <Content className="dashboard-content nap-scroll-hidden relative min-h-0 min-w-0 overflow-y-auto">
        {hero}
        {grid}
      </Content>
    </div>
  );
}
