"use client";

import { useCallback, useEffect, useState } from "react";
import {
  closePanelTab,
  DEFAULT_PANEL_LAYOUT,
  openPanelTab,
  type PanelLayout,
  restorePanelLayout,
  tabId,
  type WorkbenchTab,
} from "./tabs.ts";

export function usePanelLayout(scope: string) {
  const key = `nap.right-panel.v1:${scope}`;
  const [saved, setSaved] = useState({ key, ready: false, layout: DEFAULT_PANEL_LAYOUT });
  const layout = saved.key === key ? saved.layout : DEFAULT_PANEL_LAYOUT;
  useEffect(() => {
    let restored = {
      ...DEFAULT_PANEL_LAYOUT,
      open: !window.matchMedia("(max-width: 980px)").matches,
    };
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) restored = restorePanelLayout(raw);
    } catch {
      /* Storage is optional. */
    }
    setSaved({ key, ready: true, layout: restored });
  }, [key]);
  useEffect(() => {
    if (!saved.ready || saved.key !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(saved.layout));
    } catch {
      /* Storage is optional. */
    }
  }, [key, saved]);
  const update = useCallback(
    (change: (current: PanelLayout) => PanelLayout) => {
      setSaved((current) => ({
        key,
        ready: true,
        layout: change(current.key === key ? current.layout : DEFAULT_PANEL_LAYOUT),
      }));
    },
    [key],
  );
  return {
    layout,
    open: (tab: WorkbenchTab) => update((current) => openPanelTab(current, tab)),
    select: (id: string) => update((current) => ({ ...current, active: id, open: true })),
    close: (id: string) => update((current) => closePanelTab(current, id)),
    toggle: () => update((current) => ({ ...current, open: !current.open })),
    hide: () => update((current) => ({ ...current, open: false })),
    closeOthers: (id: string) =>
      update((current) => ({
        ...current,
        tabs: current.tabs.filter((tab) => tabId(tab) === id),
        active: id,
      })),
    closeAll: () => update((current) => ({ ...current, tabs: [], active: null })),
    move: (from: string, to: string) =>
      update((current) => {
        const tab = current.tabs.find((item) => tabId(item) === from);
        if (!tab || from === to) return current;
        const tabs = current.tabs.filter((item) => tabId(item) !== from);
        const index = tabs.findIndex((item) => tabId(item) === to);
        tabs.splice(Math.max(0, index), 0, tab);
        return { ...current, tabs };
      }),
  };
}
export type PanelController = ReturnType<typeof usePanelLayout>;
