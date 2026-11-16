import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The three correct apps "Test the app" is run against, lightest to heaviest.
 *
 * Every one is correct, so a run passes only when every assertion it records passes. The goal
 * is what the job that built the app was asked for — the runtime hands it to the test as the
 * job's goal — and names concrete outcomes, so a run has something it can be judged on.
 *
 * The two vanilla apps are NapBench's correct app-test specimens, read in place so there is one
 * copy of each. The kanban board is React on the template's own components, the shape of an app
 * Nap actually builds.
 */
export type ReliabilityApp = {
  id: "cart" | "notes" | "kanban";
  weight: "light" | "medium" | "heavy";
  goal: string;
  /** Written over the template, relative to the project root, then committed as the job. */
  files: Record<string, string>;
  /** The job's deterministic checks, run in the sandbox before the checkpoint is recorded. */
  checks: Record<string, string>;
  /** Served on the dev server's first page, and read back from the desktop's DOM. */
  heading: string;
};

export const RELIABILITY_APP_IDS = ["cart", "notes", "kanban"] as const;

export function reliabilityApps(repositoryRoot: string): ReliabilityApp[] {
  const specimen = (name: string, file: string) =>
    readFileSync(join(repositoryRoot, "apps/napbench/fixtures/app-test", name, file), "utf8");
  return [
    {
      id: "cart",
      weight: "light",
      goal: "A cart for a $12 notebook. Changing the quantity updates the total to price times quantity: setting the quantity to 3 shows a total of $36.00.",
      files: {
        "index.html": specimen("cart", "index.html"),
        "src/app.js": specimen("cart", "app.js"),
      },
      checks: { syntax: "node --check src/app.js" },
      heading: "Notebook cart",
    },
    {
      id: "notes",
      weight: "medium",
      goal: "A notes app. Saving a note adds it to the list, and the saved note is still listed after the page is reloaded.",
      files: {
        "index.html": specimen("notes", "index.html"),
        "src/app.js": specimen("notes", "app.js"),
      },
      checks: { syntax: "node --check src/app.js" },
      heading: "Notes",
    },
    {
      id: "kanban",
      weight: "heavy",
      goal: "A kanban board called Launch board with To do, Doing and Done columns, each showing how many tasks it holds. Adding a task puts it at the bottom of To do and raises the To do count by one. The arrow button on a task moves it to the next column and updates both columns' counts. The trash button deletes a task.",
      files: {
        "src/App.tsx": readFileSync(
          join(repositoryRoot, "apps/api/fixtures/computer-reliability/kanban/App.tsx"),
          "utf8",
        ),
      },
      checks: { typecheck: "bun run typecheck", build: "bun run build" },
      heading: "Launch board",
    },
  ];
}
