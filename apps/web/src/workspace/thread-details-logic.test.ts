import type { RepositoryJob } from "@nap/shared/github-protocol";
import { describe, expect, it } from "vitest";
import {
  branchUrl,
  canPublish,
  currentJob,
  detailsPresentation,
  diffTotals,
  formatDiffCount,
  quickAction,
} from "./thread-details-logic.ts";

function job(overrides: Partial<RepositoryJob> = {}): RepositoryJob {
  return {
    jobId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    sessionId: "00000000-0000-4000-8000-000000000004",
    baseBranch: "main",
    headBranch: "nap/todo",
    baseSha: "a9c430e",
    headSha: "6b84c21",
    pushedSha: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    pullRequestState: "none",
    publishState: "ready",
    checkState: "unknown",
    reviewState: "unknown",
    error: null,
    updatedAt: "2026-10-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("where the card sits", () => {
  it("floats beside the conversation when a readable lane is left beside it", () => {
    expect(detailsPresentation({ width: 1200, height: 800 })).toBe("inline");
  });

  it("becomes a popover once the lane it leaves would be narrower than a readable chat", () => {
    // 280 wide, 12 from the edge, 32 of clearance and 48 of lane padding leave 640 at 1012.
    expect(detailsPresentation({ width: 1012, height: 800 })).toBe("inline");
    expect(detailsPresentation({ width: 1011, height: 800 })).toBe("popover");
  });

  it("becomes a popover when there is too little height to show a card at all", () => {
    expect(detailsPresentation({ width: 1400, height: 183 })).toBe("popover");
    expect(detailsPresentation({ width: 1400, height: 184 })).toBe("inline");
  });
});

describe("which job the card describes", () => {
  it("is the one touched last, whatever order the server listed them in", () => {
    const older = job({ jobId: "00000000-0000-4000-8000-00000000000a" });
    const newer = job({
      jobId: "00000000-0000-4000-8000-00000000000b",
      updatedAt: "2026-10-24T11:00:00.000Z",
    });

    expect(currentJob([newer, older])?.jobId).toBe(newer.jobId);
    expect(currentJob([older, newer])?.jobId).toBe(newer.jobId);
  });

  it("is none before the first task", () => {
    expect(currentJob([])).toBeNull();
  });
});

describe("the git action", () => {
  it("commits, pushes and opens a pull request for verified work with none open", () => {
    expect(quickAction(job(), false)).toEqual({
      kind: "publish",
      label: "Commit, push & PR",
    });
  });

  it("only commits and pushes once a pull request is open for the branch", () => {
    const open = job({
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/nap/workspace/pull/12",
      pullRequestState: "open",
    });

    expect(quickAction(open, false)).toEqual({ kind: "publish", label: "Commit & push" });
  });

  it("retries a publication that failed", () => {
    expect(quickAction(job({ publishState: "failed" }), false)).toMatchObject({
      kind: "publish",
    });
  });

  it("views the pull request once the work is published", () => {
    const published = job({
      publishState: "published",
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/nap/workspace/pull/12",
      pullRequestState: "open",
    });

    expect(quickAction(published, false)).toEqual({
      kind: "open",
      label: "View PR",
      url: "https://github.com/nap/workspace/pull/12",
    });
  });

  it("views rather than updates a pull request that was merged or closed", () => {
    const merged = job({
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/nap/workspace/pull/12",
      pullRequestState: "merged",
    });

    expect(quickAction(merged, false)).toMatchObject({ kind: "open", label: "View PR" });
  });

  it("shows progress while a publication is in flight, asked here or anywhere else", () => {
    expect(quickAction(job(), true)).toEqual({ kind: "progress", label: "Publishing…" });
    expect(quickAction(job({ publishState: "publishing" }), false)).toEqual({
      kind: "progress",
      label: "Publishing…",
    });
  });

  it("says why it is unavailable while nap is still working", () => {
    expect(quickAction(job({ publishState: "working" }), false)).toEqual({
      kind: "hint",
      label: "Commit, push & PR",
      hint: "nap is still working on this branch.",
    });
  });

  it("says what starts a branch before there is one", () => {
    expect(quickAction(null, false)).toEqual({
      kind: "hint",
      label: "Commit, push & PR",
      hint: "Send a task in chat to start work on a dedicated branch.",
    });
  });
});

describe("whether a job can be published", () => {
  it("can be while its pull request is open or not yet made", () => {
    expect(canPublish(job())).toBe(true);
    expect(canPublish(job({ publishState: "published", pullRequestState: "open" }))).toBe(true);
  });

  it("cannot be while nap is working, or once its pull request is closed", () => {
    expect(canPublish(job({ publishState: "working" }))).toBe(false);
    expect(canPublish(job({ pullRequestState: "closed" }))).toBe(false);
    expect(canPublish(job({ pullRequestState: "merged" }))).toBe(false);
  });
});

describe("the change totals", () => {
  it("adds up every file's lines", () => {
    expect(
      diffTotals([
        { additions: 1000, deletions: 80 },
        { additions: 71, deletions: 5 },
      ]),
    ).toEqual({ additions: 1071, deletions: 85 });
  });

  it("formats with grouping, the way the card in T3 Code does", () => {
    expect(formatDiffCount(1071)).toBe((1071).toLocaleString());
    expect(formatDiffCount(0)).toBe("0");
  });
});

describe("a branch on GitHub", () => {
  it("links to the branch's tree, escaping what a URL cannot carry", () => {
    expect(branchUrl("nap/workspace", "feat/a#b")).toBe(
      "https://github.com/nap/workspace/tree/feat/a%23b",
    );
  });
});
