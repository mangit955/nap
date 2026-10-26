import { ProjectPathSchema } from "@nap/shared/files-protocol";
import { z } from "zod";

export const WorkbenchTabSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview") }),
  z.object({ kind: z.literal("computer") }),
  z.object({ kind: z.literal("code") }),
  z.object({ kind: z.literal("diff") }),
  z.object({ kind: z.literal("pr") }),
  z.object({ kind: z.literal("file"), path: ProjectPathSchema.max(4096) }),
]);
export type WorkbenchTab = z.infer<typeof WorkbenchTabSchema>;
export type PanelKind = Exclude<WorkbenchTab["kind"], "file">;
export const WORKBENCH_TABS: readonly { id: PanelKind; label: string }[] = [
  { id: "preview", label: "Browser" },
  { id: "computer", label: "Computer" },
  { id: "code", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "pr", label: "Pull requests" },
];
export function tabId(tab: WorkbenchTab): string {
  return tab.kind === "file" ? `file:${tab.path}` : tab.kind;
}
export function tabLabel(tab: WorkbenchTab): string {
  if (tab.kind === "file") return tab.path.split("/").at(-1) ?? tab.path;
  return WORKBENCH_TABS.find((item) => item.id === tab.kind)?.label ?? tab.kind;
}
export const PanelLayoutSchema = z.object({
  version: z.literal(1),
  tabs: z.array(WorkbenchTabSchema).max(40),
  active: z.string().nullable(),
  open: z.boolean(),
});
export type PanelLayout = z.infer<typeof PanelLayoutSchema>;
export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  version: 1,
  tabs: [{ kind: "preview" }, { kind: "code" }],
  active: "preview",
  open: true,
};
export function restorePanelLayout(raw: string | null): PanelLayout {
  try {
    const parsed = PanelLayoutSchema.safeParse(JSON.parse(raw ?? "null"));
    if (!parsed.success) return DEFAULT_PANEL_LAYOUT;
    const ids = new Set<string>();
    const tabs = parsed.data.tabs.filter((tab) => {
      const id = tabId(tab);
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    return {
      ...parsed.data,
      tabs,
      active: tabs.find((tab) => tabId(tab) === parsed.data.active)
        ? parsed.data.active
        : tabs[0]
          ? tabId(tabs[0])
          : null,
    };
  } catch {
    return DEFAULT_PANEL_LAYOUT;
  }
}
export function openPanelTab(layout: PanelLayout, tab: WorkbenchTab): PanelLayout {
  const id = tabId(tab);
  return {
    ...layout,
    tabs: layout.tabs.some((item) => tabId(item) === id)
      ? layout.tabs
      : [...layout.tabs, tab].slice(-40),
    active: id,
    open: true,
  };
}
export function closePanelTab(layout: PanelLayout, id: string): PanelLayout {
  const index = layout.tabs.findIndex((tab) => tabId(tab) === id);
  const tabs = layout.tabs.filter((tab) => tabId(tab) !== id);
  const next = tabs[Math.max(0, index - 1)] ?? tabs[0];
  return {
    ...layout,
    tabs,
    active: layout.active === id ? (next ? tabId(next) : null) : layout.active,
  };
}
