"use client";

/**
 * The right-hand panel: the running app, or the code behind it.
 *
 * **Both halves stay mounted and one is hidden.** Unmounting the preview to show the files would
 * reload the user's app every time they glanced at a file — losing whatever state it was in, and
 * paying a dev-server round trip for a look at twelve filenames. `hidden` is what a tab pattern
 * is supposed to do anyway: the panel stays in the accessibility tree's structure and out of the
 * reading order.
 *
 * The panel is inset with a rounded face rather than filling its corner of the window, which is
 * what makes it read as *a thing being shown* rather than as the page continuing.
 */

import type { ReactNode } from "react";
import type { WorkbenchTab } from "./tabs.ts";

export function Workbench({
  tab,
  preview,
  code,
}: {
  tab: WorkbenchTab;
  preview: ReactNode;
  code: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col p-2 pt-0">
      <Panel id="preview" label="Preview" hidden={tab !== "preview"}>
        {preview}
      </Panel>
      <Panel id="code" label="Code" hidden={tab !== "code"}>
        {code}
      </Panel>
    </div>
  );
}

/**
 * One half, named after the tab that opens it.
 *
 * `aria-labelledby` points at the tab's own id — a tabpanel with no association is a region a
 * reader cannot reach from the tablist it belongs to.
 */
function Panel({
  id,
  label,
  hidden,
  children,
}: {
  id: WorkbenchTab;
  label: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <section
      role="tabpanel"
      id={`workbench-${id}`}
      aria-label={label}
      aria-labelledby={`workbench-tab-${id}`}
      hidden={hidden}
      // `hidden` alone would leave the flex child taking part in layout in some browsers, so the
      // display is set here too and the visible one is told to grow.
      className={
        hidden
          ? "hidden"
          : "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-edge bg-panel"
      }
    >
      {children}
    </section>
  );
}
