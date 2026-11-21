"use client";

import type { GitComparison } from "@nap/shared/git-protocol";
import { Files } from "lucide-react";
import { useState } from "react";
import type { JobSummary } from "../chat/job-summary.ts";
import type { TranscriptItem } from "../chat/transcript.ts";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { AppPreview } from "./app-preview.tsx";
import { demoSessions, LEDGER_ID } from "./demo-sessions.ts";
import { DemoFrame, DemoWorkspace, DrawnDiff, PaneTabs } from "./demo-window.tsx";
import type { DemoStage } from "./use-demo-stage.ts";
import "./ledger-app.css";
import "./ledger-night.css";

/**
 * The hero: a person's own Nap, coming back to a session that worked while they were away.
 *
 * Three beats, drawn from the states the app shows: working a minute in with the schema open in
 * Code; nine minutes in, verifying, with the app running in Preview; then verified, done, and the
 * Changes panel easing in over the corner. One liberty: the app enters Verifying once the agent's
 * turn has ended, and the second beat shows the agent's own checks still running beside it. Only what changes between beats moves
 * (`use-arrivals.ts`); the rest holds still so the eye goes to what is new.
 */

const AT = "2026-11-20T10:00:00.000Z";
const PROMPT: TranscriptItem = {
  kind: "message",
  key: 1,
  from: "user",
  text: "Build a personal finance dashboard with spending trends and recent transactions. Keep the transactions in Postgres, and let me import a CSV from my bank.",
};
const REPLY: TranscriptItem = {
  kind: "message",
  key: 2,
  from: "agent",
  text: "I'll start with a Postgres schema for accounts and transactions, add an import endpoint for the CSV, then build the dashboard on top of the API.",
};
const PLAN_STEPS = [
  "Postgres schema and first migration",
  "CSV import endpoint with validation",
  "Dashboard: balance, trend, recent activity",
  "Run migrations, tests and the build",
];
/** The plan with `done` steps finished and the next one under way. */
function plan(done: number): TranscriptItem {
  return {
    kind: "plan",
    key: 3,
    turnId: "hero-turn",
    items: PLAN_STEPS.map((content, index) => ({
      content,
      status: index < done ? "completed" : index === done ? "in_progress" : "pending",
    })),
  };
}
const SCHEMA_FILE = {
  path: "db/schema.ts",
  changeType: "created",
  diff: "+export const transactions = pgTable('transactions', {",
  added: 48,
  removed: 0,
} as const;
const ALL_FILES: TranscriptItem = {
  kind: "files",
  key: 4,
  files: [
    SCHEMA_FILE,
    {
      path: "server/routes/import.ts",
      changeType: "created",
      diff: "+app.post('/api/import', parseCsv, saveTransactions)",
      added: 96,
      removed: 0,
    },
    {
      path: "src/App.tsx",
      changeType: "created",
      diff: "+const { data } = useQuery(['transactions'], fetchTransactions)",
      added: 214,
      removed: 0,
    },
  ],
};
function checks(done: boolean): TranscriptItem {
  return {
    kind: "step",
    key: 5,
    at: AT,
    toolCallId: "hero-checks",
    toolName: "run_command",
    input: { command: "bun run db:migrate && bun run test && bun run build" },
    status: done ? "ok" : "running",
    output: done ? "Migrated. 18 tests passed. Build completed." : "",
    streamed: done
      ? "✓ Applied 0001_init.sql · 2 tables\n✓ 18 tests passed\n✓ Production build completed"
      : "✓ Applied 0001_init.sql · 2 tables\n✓ 18 tests passed\n  building for production…",
    files: [],
  };
}
const SUMMARY: TranscriptItem = {
  kind: "message",
  key: 6,
  from: "agent",
  text: "The ledger is running with a real database behind it. Import a CSV from the menu and the balance, trend and transactions update from Postgres. Migrations, tests and the build all passed.",
};

const ITEMS: Record<DemoStage, TranscriptItem[]> = {
  working: [PROMPT, REPLY, plan(0), { kind: "files", key: 4, files: [SCHEMA_FILE] }],
  verifying: [PROMPT, REPLY, plan(3), ALL_FILES, checks(false)],
  verified: [PROMPT, REPLY, plan(4), ALL_FILES, checks(true), SUMMARY],
};
const JOBS: Record<DemoStage, JobSummary> = {
  working: { phase: "working", phaseLabel: "Working", open: true },
  verifying: { phase: "verifying", phaseLabel: "Verifying", open: true },
  verified: { phase: "verified", phaseLabel: "Verified", open: false },
};
/** How long the ledger's row has been running at each beat; null once it is done. */
const MINUTES: Record<DemoStage, number | null> = { working: 1, verifying: 9, verified: null };

const SCHEMA_DIFF: GitComparison["files"][number] = {
  path: "db/schema.ts",
  previousPath: null,
  status: "added",
  additions: 48,
  deletions: 0,
  binary: false,
  truncated: false,
  patch: [
    "@@ -0,0 +1,13 @@",
    "+export const accounts = pgTable('accounts', {",
    "+  id: uuid('id').primaryKey().defaultRandom(),",
    "+  name: text('name').notNull(),",
    "+});",
    "+",
    "+export const transactions = pgTable('transactions', {",
    "+  id: uuid('id').primaryKey().defaultRandom(),",
    "+  accountId: uuid('account_id').references(() => accounts.id),",
    "+  postedAt: date('posted_at').notNull(),",
    "+  merchant: text('merchant').notNull(),",
    "+  amount: numeric('amount', { precision: 12, scale: 2 }),",
    "+  category: text('category'),",
    "+});",
  ].join("\n"),
};

const noop = () => {};

export function HeroDemo({
  stage,
  onFirstFrame,
}: {
  stage: DemoStage;
  /** The first beat has drawn: its schema is on screen. */
  onFirstFrame?: (() => void) | undefined;
}) {
  // The reader's clock, read again at each beat, so "Working 9m" is nine minutes however long
  // the page was open before the hero played. Updated during render, React's way of deriving
  // state from a prop, so no frame draws a beat against the previous beat's clock.
  const [clock, setClock] = useState(() => ({ stage, now: Date.now() }));
  if (clock.stage !== stage) setClock({ stage, now: Date.now() });
  const now = clock.now;
  return (
    <DemoFrame
      label="Nap's workspace: a personal finance app built from a prompt, checked, and verified"
      className="lp-hero-demo"
      // A phone shows the pane, where the run is seen: the schema, the app, then the Changes.
      narrowShows="pane"
      wide={{ width: 1280, height: 800 }}
      narrow={{ width: 380, height: 720, visible: 640 }}
      overlay={
        stage === "verified" && (
          <div className="lp-hero-changes" data-arrive>
            <div className="lp-panel-head">
              <Files className="size-3.5" />
              <span>Changes</span>
              <span className="lp-panel-aside">3 files · +358</span>
            </div>
            <div className="lp-hero-changes-body">
              <DrawnDiff file={SCHEMA_DIFF} />
            </div>
          </div>
        )
      }
    >
      <DemoWorkspace
        sessions={demoSessions(MINUTES[stage], now)}
        activeProjectId={LEDGER_ID}
        title="Personal ledger"
        job={JOBS[stage]}
        items={ITEMS[stage]}
        right={
          // Both panes are drawn so the switch can ease (`demo.css`): unmounting one and mounting
          // the other leaves the pane empty for as long as the arrival takes to fade in.
          <div className="lp-pane-stack">
            <div className="lp-pane" data-shown={stage === "working"}>
              <PaneTabs tabs={["Preview", "Code"]} active="Code" />
              <div className="lp-pane-code">
                <DrawnDiff file={SCHEMA_DIFF} onDrawn={onFirstFrame} />
              </div>
            </div>
            <div className="lp-pane" data-shown={stage !== "working"}>
              <PaneTabs tabs={["Preview", "Code"]} active="Preview" />
              <BrowserToolbar
                route="/"
                previewUrl={undefined}
                onRouteChange={noop}
                onReload={noop}
              />
              <div className="lp-pane-app ps-generated-app">
                <AppPreview />
              </div>
            </div>
          </div>
        }
      />
    </DemoFrame>
  );
}
