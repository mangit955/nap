"use client";

import type { GitComparison } from "@nap/shared/git-protocol";
import type { ProjectGitHub, PullRequestInspection } from "@nap/shared/github-protocol";
import { GitPullRequest } from "lucide-react";
import { NapMark } from "../brand/nap-mark.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import type { TranscriptItem } from "../chat/transcript.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { ProjectGitHubControl } from "../github/project-github.tsx";
import { SHOWCASE } from "../ui/showcase.ts";
import { STOREFRONT_ID } from "./demo-sessions.ts";
import { DemoFrame, DemoWorkspace, DrawnDiff, Panel, PaneTabs } from "./demo-window.tsx";

/**
 * The three feature rows' pictures, all one story: a change to somebody's existing repository,
 * from the task to a pull request, through a failing test it fixed itself, to a reviewer's comment
 * it answered. Each is cropped to the part of the window the row is about.
 */

/** Every row's window is drawn this wide, cropped to the part the row is about. */
export const ROW_WIDTH = 900;

const AT = "2026-11-20T10:00:00.000Z";
const VERIFIED: JobSummary = { phase: "verified", phaseLabel: "Verified", open: false };
const JOB_ID = "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const SESSION_ID = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const USER_ID = "2c3d4e5f-6071-4829-93a4-b5c6d7e8f90a";

const GITHUB: ProjectGitHub = {
  repository: {
    projectId: STOREFRONT_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    installationId: 4242,
    repository: { id: 9001, fullName: "acme/storefront", defaultBranch: "main", private: true },
    baseBranch: "main",
    environment: {
      setupCommand: "bun install --frozen-lockfile",
      devCommand: null,
      previewPort: null,
    },
    autoPublish: true,
  },
  runningPreviewPort: null,
  jobs: [
    {
      jobId: JOB_ID,
      projectId: STOREFRONT_ID,
      sessionId: SESSION_ID,
      baseBranch: "main",
      headBranch: "nap/failed-payment-emails",
      baseSha: "8c41f2e9b1a3",
      headSha: "3f9a1c0d2e4b",
      pushedSha: "3f9a1c0d2e4b",
      pullRequestNumber: 214,
      pullRequestUrl: "https://github.com/acme/storefront/pull/214",
      pullRequestState: "open",
      publishState: "published",
      checkState: "passed",
      reviewState: "changes_requested",
      error: null,
      updatedAt: AT,
    },
  ],
  feedback: [],
  followUpPolicy: "owner_approval",
};

/**
 * The review as GitHub has it: a teammate asks for a change, and the person who connected nap
 * passes it on with a `/nap` comment. Nap acts only on those, once its owner approves them in
 * nap; a review's own text is never sent to the agent (`project-github.tsx` says so in the app).
 * Nap does not comment on the pull request itself, and the sandbox does not push: a verified
 * commit is published to the same branch by the server, on its own when the repository is set to
 * publish automatically (as this one is) and otherwise when its owner says so.
 *
 * The review's timestamps are left out (`at: null`): the panel prints them in the reader's raw
 *  locale format, which on a page of prose reads as debug output. */
const PULL_REQUEST: PullRequestInspection = {
  number: 214,
  title: "Email customers when a payment fails",
  body: "When Stripe reports `invoice.payment_failed`, the order is marked **past due** and the customer gets one email.\n\n- Webhook handler in `server/webhooks.ts`\n- `past_due` order state with a migration\n- One email per customer per day; retries are logged instead",
  url: "https://github.com/acme/storefront/pull/214",
  state: "open",
  draft: true,
  author: "nap-agent[bot]",
  base: { ref: "main", sha: "8c41f2e9b1a3" },
  head: { ref: "nap/failed-payment-emails", sha: "3f9a1c0d2e4b" },
  capturedAt: AT,
  checks: [
    { name: "typecheck", status: "completed", conclusion: "success" },
    { name: "test", status: "completed", conclusion: "success" },
    { name: "build", status: "completed", conclusion: "success" },
  ],
  timeline: [
    {
      id: "t1",
      kind: "review",
      author: "mira",
      body: "The email tells them the payment failed but not what to do. Can it link straight to the billing page so they can update their card?",
      state: "CHANGES_REQUESTED",
      at: null,
    },
    {
      id: "t2",
      kind: "comment",
      author: "sam",
      body: "/nap link the past-due email to the billing page, as mira asked",
      state: null,
      at: null,
    },
  ],
  comments: [],
  files: [
    {
      path: "server/webhooks.ts",
      previousPath: null,
      status: "modified",
      additions: 41,
      deletions: 3,
      binary: false,
      truncated: false,
      patch:
        "@@ -1,5 +1,7 @@\n export async function onPaymentFailed(event) {\n   const order = await orders.byInvoice(event.invoice)\n+  if (await emails.sentToday(order.customer))\n+    return log.info('past due email throttled')\n   await sendPastDueEmail(order.customer)\n   await orders.markPastDue(order.id)\n }",
    },
    {
      path: "db/migrations/0014_past_due.sql",
      previousPath: null,
      status: "added",
      additions: 6,
      deletions: 0,
      binary: false,
      truncated: false,
      patch:
        "@@ -0,0 +1,6 @@\n+-- An order a failed payment has left unpaid.\n+ALTER TYPE order_status ADD VALUE 'past_due';\n+\n+-- One past-due email per customer per day.\n+CREATE INDEX emails_customer_day\n+  ON emails (customer_id, sent_on);",
    },
    {
      path: "emails/past-due.tsx",
      previousPath: null,
      status: "added",
      additions: 58,
      deletions: 0,
      binary: false,
      truncated: false,
      patch:
        "@@ -0,0 +1,3 @@\n+export function PastDueEmail({ order }: { order: Order }) {\n+  return <Email subject={`Payment failed for order ${order.number}`} />\n+}",
    },
  ],
};

/** What the panel asks the API, answered from the fixtures above. Nothing leaves the page. */
const fetchJson: FetchJson = async (url) => {
  if (url.endsWith("/github")) return Response.json(GITHUB);
  if (url.includes("/pull-requests/")) return Response.json(PULL_REQUEST);
  return Response.json({}, { status: 404 });
};

function PullRequest() {
  return (
    <ProjectGitHubControl
      presentation="panel"
      projectId={STOREFRONT_ID}
      refreshKey={0}
      fetchJson={fetchJson}
      baseUrl="https://demo.invalid"
    />
  );
}

const TASK: TranscriptItem[] = [
  {
    kind: "message",
    key: 1,
    from: "user",
    text: "When a Stripe payment fails, email the customer and mark the order past due. No more than one email a day.",
  },
  {
    kind: "plan",
    key: 2,
    turnId: "repo-turn",
    items: [
      { content: "Find where Stripe webhooks are handled", status: "completed" },
      { content: "Add a past_due order state and migration", status: "completed" },
      { content: "Send one templated email per customer per day", status: "completed" },
      { content: "Run typecheck, tests and build", status: "completed" },
    ],
  },
  {
    kind: "files",
    key: 3,
    files: [
      {
        path: "server/webhooks.ts",
        changeType: "modified",
        diff: "+if (await emails.sentToday(order.customer))",
        added: 41,
        removed: 3,
      },
      {
        path: "db/migrations/0014_past_due.sql",
        changeType: "created",
        diff: "+ALTER TYPE order_status ADD VALUE 'past_due';",
        added: 6,
        removed: 0,
      },
      {
        path: "emails/past-due.tsx",
        changeType: "created",
        diff: "+export function PastDueEmail()",
        added: 58,
        removed: 0,
      },
    ],
  },
  {
    kind: "step",
    key: 4,
    at: AT,
    toolCallId: "repo-check",
    toolName: "run_command",
    input: { command: "bun run typecheck && bun test && bun run build" },
    status: "ok",
    output: "All passed",
    streamed: "✓ Typecheck passed\n✓ 212 tests passed\n✓ Production build completed",
    files: [],
  },
  {
    kind: "message",
    key: 5,
    from: "agent",
    text: "Opened a draft pull request against `main`. A failed payment now marks the order past due and sends one email per customer per day. Retries after that are logged.",
  },
];

export function RepoArt() {
  return (
    <DemoFrame
      label="A task on the acme/storefront repository ending in a draft pull request with its checks passing"
      className="lp-repo-demo"
      narrowShows="pane"
      wide={{ width: ROW_WIDTH, height: 840, visible: 640 }}
      narrow={{ width: 360, height: 760, visible: 600 }}
    >
      <DemoWorkspace
        title="acme/storefront"
        job={VERIFIED}
        items={TASK}
        right={
          <div className="lp-pane" data-arrive>
            <PaneTabs tabs={["Preview", "Code", "Pull request"]} active="Pull request" />
            <div className="lp-pane-pr">
              <PullRequest />
            </div>
          </div>
        }
      />
    </DemoFrame>
  );
}

const CHECKS: TranscriptItem[] = [
  {
    kind: "message",
    key: 1,
    from: "agent",
    text: "The handler and the migration are in. Running your checks before I open the pull request.",
  },
  {
    kind: "step",
    key: 2,
    at: AT,
    toolCallId: "checks-failed",
    toolName: "run_command",
    input: { command: "bun test" },
    status: "failed",
    output: "1 failed",
    streamed:
      "✓ 211 passed\n✗ webhooks › sends one email per customer per day\n  expected 1 email, received 4\n  at server/webhooks.test.ts:8",
    files: [],
  },
  {
    kind: "message",
    key: 3,
    from: "agent",
    text: "The retry test fails: every Stripe retry sends another email. I'll check whether one was already sent today before sending.",
  },
  {
    kind: "files",
    key: 4,
    files: [
      {
        path: "server/webhooks.ts",
        changeType: "modified",
        diff: "+if (await emails.sentToday(order.customer))",
        added: 2,
        removed: 0,
      },
    ],
  },
  {
    kind: "step",
    key: 5,
    at: AT,
    toolCallId: "checks-passed",
    toolName: "run_command",
    input: { command: "bun run typecheck && bun test && bun run build" },
    status: "ok",
    output: "passed",
    streamed: "✓ Typecheck passed\n✓ 212 tests passed\n✓ Production build completed",
    files: [],
  },
  {
    kind: "message",
    key: 6,
    from: "agent",
    text: "Fixed. Typecheck, all 212 tests and the production build pass.",
  },
];

/** Both hunks start at line 1, so the diff draws no "unmodified lines" bar above them: in a picture
 *  that bar is a heavy grey band saying only that something is not shown. */
const FIX_DIFF: GitComparison["files"][number] = {
  path: "server/webhooks.ts",
  previousPath: null,
  status: "modified",
  additions: 2,
  deletions: 0,
  binary: false,
  truncated: false,
  patch: [
    "@@ -1,5 +1,7 @@",
    " export async function onPaymentFailed(event) {",
    "   const order = await orders.byInvoice(event.invoice)",
    "+  if (await emails.sentToday(order.customer))",
    "+    return log.info('past due email throttled')",
    "   await sendPastDueEmail(order.customer)",
    "   await orders.markPastDue(order.id)",
    " }",
  ].join("\n"),
};
const TEST_DIFF: GitComparison["files"][number] = {
  path: "server/webhooks.test.ts",
  previousPath: null,
  status: "modified",
  additions: 7,
  deletions: 0,
  binary: false,
  truncated: false,
  patch: [
    "@@ -1,3 +1,10 @@",
    " import { onPaymentFailed } from './webhooks'",
    " import { failedInvoice, log, mailer } from './fixtures'",
    " ",
    "+it('sends one email per customer per day', async () => {",
    "+  for (let retry = 0; retry < 4; retry++)",
    "+    await onPaymentFailed(failedInvoice)",
    "+",
    "+  expect(mailer.sent).toHaveLength(1)",
    "+  expect(log.lines).toContain('past due email throttled')",
    "+})",
  ].join("\n"),
};

export function ChecksArt() {
  return (
    <DemoFrame
      label="A failing test caught by the project's own checks, fixed, and passing"
      className="lp-checks-demo"
      wide={{ width: ROW_WIDTH, height: 860, visible: 660 }}
      narrow={{ width: 360, height: 900, visible: 660 }}
    >
      <DemoWorkspace
        title="acme/storefront"
        job={VERIFIED}
        items={CHECKS}
        right={
          <div className="lp-pane" data-arrive>
            <PaneTabs tabs={["Preview", "Code"]} active="Code" />
            <div className="lp-pane-code">
              <DrawnDiff file={FIX_DIFF} />
              <DrawnDiff file={TEST_DIFF} />
            </div>
          </div>
        }
      />
    </DemoFrame>
  );
}

const ANSWER: TranscriptItem[] = [
  {
    kind: "message",
    key: 1,
    from: "agent",
    text: "Following sam's /nap comment on #214: adding a link to the billing page in the past-due email, so the customer can update their card from it.",
  },
  {
    kind: "files",
    key: 2,
    files: [
      {
        path: "emails/past-due.tsx",
        changeType: "modified",
        diff: "+<Button href={billingUrl(order.customer)}>Update your card</Button>",
        added: 4,
        removed: 1,
      },
      {
        path: "emails/past-due.test.tsx",
        changeType: "created",
        diff: "+it('links to the billing page', async () => {",
        added: 12,
        removed: 0,
      },
    ],
  },
  {
    kind: "step",
    key: 3,
    at: AT,
    toolCallId: "review-checks",
    toolName: "run_command",
    input: { command: "bun run typecheck && bun test && bun run build" },
    status: "ok",
    output: "passed",
    streamed: "✓ Typecheck passed\n✓ 213 tests passed\n✓ Production build completed",
    files: [],
  },
  {
    kind: "message",
    key: 4,
    from: "agent",
    text: "Done. The email now has an Update your card button that opens the billing page, and a new test checks the link. Typecheck, all 213 tests and the build pass.",
  },
];

export function ReviewArt() {
  return (
    <DemoFrame
      label="A reviewer's comment on the pull request, passed to nap with a /nap comment, and nap's checked fix"
      className="lp-review-demo"
      wide={{ width: ROW_WIDTH, height: 700 }}
      narrow={{ width: 360, height: 880 }}
      showcase={{ ...SHOWCASE, pullRequestView: "Timeline" }}
    >
      <div className="lp-review">
        <Panel
          icon={<GitPullRequest className="size-3.5" />}
          title="Pull request"
          aside="acme/storefront"
          className="lp-review-pr"
        >
          <PullRequest />
        </Panel>
        <Panel
          icon={<NapMark className="size-3.5" />}
          title="nap"
          aside="Follow-up approved"
          className="lp-review-chat"
        >
          <ChatTranscript items={ANSWER} />
        </Panel>
      </div>
    </DemoFrame>
  );
}
