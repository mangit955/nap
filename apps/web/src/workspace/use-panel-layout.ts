"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  closePanelTab,
  DEFAULT_PANEL_LAYOUT,
  openPanelTab,
  type PanelLayout,
  restorePanelLayout,
  tabId,
  type WorkbenchTab,
} from "./tabs.ts";

/**
 * The panel as the starting view last drew it, for the project's workspace that replaces it.
 *
 * A start draws `StartingWorkspace` until the server names the project, then `AppShell`, in one
 * commit. The two keep their layouts under different scopes — the project's does not exist while
 * it starts — so without this the panel would snap to the new project's default at the swap, and
 * the composer gliding in from the dashboard with it. Module state, so a second tab has its own.
 * It lives only until that commit's layout effects have run: a start that fails or is left leaves
 * nothing for a later workspace to pick up.
 */
let handedOver: PanelLayout | undefined;

export function handOverPanelLayout(layout: PanelLayout): void {
  handedOver = layout;
  queueMicrotask(() => {
    if (handedOver === layout) handedOver = undefined;
  });
}

function read(key: string): PanelLayout | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : restorePanelLayout(raw);
  } catch {
    /* Storage is optional. */
    return undefined;
  }
}

/**
 * The right panel's layout, saved per scope.
 *
 * A scope with nothing saved starts from what was on screen before it: the layout handed over by
 * the starting view when `takesHandOver`, or this hook's own layout when only its scope changed
 * (a project's session arriving). Restored in a layout effect, so no frame paints a layout that
 * is replaced at once.
 */
export function usePanelLayout(scope: string, { takesHandOver = false } = {}) {
  const key = `nap.right-panel.v1:${scope}`;
  const [saved, setSaved] = useState({ key, ready: false, layout: DEFAULT_PANEL_LAYOUT });
  const layout = saved.layout;
  useLayoutEffect(() => {
    const own = read(key);
    const given = takesHandOver ? handedOver : undefined;
    if (given) handedOver = undefined;
    setSaved((current) => ({
      key,
      ready: true,
      layout: own ?? (current.ready ? current.layout : (given ?? DEFAULT_PANEL_LAYOUT)),
    }));
  }, [key, takesHandOver]);
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
        layout: change(current.layout),
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
        const index = current.tabs.findIndex((item) => tabId(item) === to);
        if (index < 0) return current;
        const tabs = current.tabs.filter((item) => tabId(item) !== from);
        tabs.splice(index, 0, tab);
        return { ...current, tabs };
      }),
  };
}
export type PanelController = ReturnType<typeof usePanelLayout>;
