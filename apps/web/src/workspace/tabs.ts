/** The two halves of the workbench. Named once, so the tab and its panel cannot drift apart. */
export type WorkbenchTab = "preview" | "code";

export const WORKBENCH_TABS: readonly { id: WorkbenchTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "code", label: "Code" },
];
