import type { ProjectGitHub, PullRequestInspection } from "@nap/shared/github-protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullRequestsPanel } from "./pull-requests-panel.tsx";

const id = "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const state: ProjectGitHub = {
  repository: null,
  jobs: [5, 6].map((number) => ({
    jobId: id,
    projectId: id,
    sessionId: id,
    baseBranch: "main",
    headBranch: `task-${number}`,
    baseSha: "base",
    headSha: "head",
    pushedSha: "head",
    pullRequestNumber: number,
    pullRequestUrl: `https://github.com/org/repo/pull/${number}`,
    pullRequestState: "open",
    publishState: "published",
    checkState: "pending",
    reviewState: "unknown",
    error: null,
    updatedAt: "2026-10-19T10:00:00.000Z",
  })),
  feedback: [],
  followUpPolicy: "owner_approval",
};
function inspection(number = 5): PullRequestInspection {
  return {
    number,
    title: `Panel change ${number}`,
    body: "Description",
    url: `https://github.com/org/repo/pull/${number}`,
    state: "open",
    draft: false,
    author: "owner",
    base: { ref: "main", sha: "base" },
    head: { ref: `task-${number}`, sha: "head" },
    capturedAt: "2026-10-19T10:00:00.000Z",
    checks: [{ name: "Tests", status: "in_progress", conclusion: null }],
    timeline: [],
    comments: [],
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        truncated: true,
        patch: "",
      },
    ],
  };
}
const props = {
  state,
  projectId: id,
  baseUrl: "https://api.example",
  refreshKey: 0,
  active: true,
  manage: <p>Repository settings</p>,
};
function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("pull request panel", () => {
  it("explains an unmatched outdated comment and links directly to its discussion", async () => {
    const pr = inspection();
    pr.comments = [
      {
        id: 4,
        author: "reviewer",
        body: "Keep the deleted path review accessible.",
        path: "old/app.ts",
        line: null,
        originalLine: 8,
        side: "RIGHT",
        commitId: "old-head",
        outdated: true,
        url: "https://github.com/org/repo/pull/5#discussion_r4",
      },
    ];
    // A substring match is not the original file or a valid comment anchor.
    pr.files[0]!.path = "archive/old/app.ts.backup";
    const fetchJson = vi.fn(async () => Response.json(pr));
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: pr.title });
    const summary = within(screen.getByRole("tabpanel", { name: "Summary" }));
    expect(summary.getByText(/not in the current comparison/i)).toBeVisible();
    const link = summary.getByRole("link", { name: /discussion/i });
    expect(link).toHaveAttribute("href", pr.comments[0]!.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(summary.getByText(pr.comments[0]!.body)).toBeVisible();
  });
  it("still opens the matching file and its anchored comment", async () => {
    const pr = inspection();
    pr.comments = [
      {
        id: 4,
        author: "reviewer",
        body: "Review this line",
        path: "src/app.ts",
        line: 2,
        originalLine: 2,
        side: "RIGHT",
        commitId: "head",
        outdated: false,
        url: "https://github.com/org/repo/pull/5#discussion_r4",
      },
    ];
    render(<PullRequestsPanel {...props} fetchJson={async () => Response.json(pr)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Review this line/ }));
    const code = screen.getByRole("tabpanel", { name: /Code/ });
    expect(within(code).getByRole("textbox", { name: "Filter pull request files" })).toHaveValue(
      "src/app.ts",
    );
    expect(within(code).getByRole("link", { name: "After line 2" })).toHaveAttribute(
      "href",
      pr.comments[0]!.url,
    );
  });
  it("refreshes the selected PR on focus while preserving loaded content and navigation", async () => {
    const pending = deferredResponse();
    const fetchJson = vi.fn(async (url: string) =>
      Response.json(inspection(url.endsWith("/6") ? 6 : 5)),
    );
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
      target: { value: "6" },
    });
    await screen.findByRole("heading", { name: "Panel change 6" });
    fireEvent.click(screen.getByRole("tab", { name: /Code/ }));
    const filter = screen.getByRole("textbox", { name: "Filter pull request files" });
    fireEvent.change(filter, { target: { value: "src/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Split PR diff" }));
    filter.focus();
    fetchJson.mockImplementationOnce(() => pending.promise);
    fireEvent.focus(window);
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(3));
    expect(fetchJson.mock.calls[2]?.[0]).toBe(
      `${props.baseUrl}/projects/${id}/github/pull-requests/6`,
    );
    expect(screen.getByRole("heading", { name: "Panel change 6" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Filter pull request files" })).toBe(filter);
    expect(filter).toHaveFocus();
    const updated = {
      ...inspection(6),
      title: "Updated on GitHub",
      head: { ref: "task-6", sha: "new-head" },
      checks: [{ name: "Tests", status: "completed", conclusion: "success" }],
    };
    await act(async () => pending.resolve(Response.json(updated)));
    expect(await screen.findByRole("heading", { name: "Updated on GitHub" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Pull request" })).toHaveValue("6");
    expect(screen.getByRole("tab", { name: /Code/ })).toHaveAttribute("aria-selected", "true");
    expect(filter).toHaveValue("src/app");
    expect(screen.getByRole("button", { name: "Split PR diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("tabpanel", { name: /Code/ })).toHaveTextContent("new-hea");
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      within(screen.getByRole("tabpanel", { name: "Summary" })).getByText("success"),
    ).toBeVisible();
  });
  it("keeps loaded content mounted during an explicit refresh and unrelated metadata rerenders", async () => {
    const pending = deferredResponse();
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    const { rerender } = render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fireEvent.click(screen.getByRole("tab", { name: /Code/ }));
    const filter = screen.getByRole("textbox", { name: "Filter pull request files" });
    fireEvent.change(filter, { target: { value: "src" } });
    rerender(
      <PullRequestsPanel
        {...props}
        state={{ ...state, jobs: [...state.jobs] }}
        fetchJson={fetchJson}
      />,
    );
    expect(fetchJson).toHaveBeenCalledTimes(1);
    fetchJson.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Filter pull request files" })).toBe(filter);
    await act(async () => pending.resolve(Response.json({ ...inspection(), title: "Refreshed" })));
    await screen.findByRole("heading", { name: "Refreshed" });
    expect(filter).toHaveValue("src");
  });
  it.each(["server", "network"])(
    "preserves Code DOM, focus and navigation after a background %s failure and retries",
    async (failure) => {
      const pending = deferredResponse();
      const retry = deferredResponse();
      const fetchJson = vi.fn(async () => Response.json(inspection()));
      render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
      await screen.findByRole("heading", { name: "Panel change 5" });
      fireEvent.click(screen.getByRole("tab", { name: /Code/ }));
      const code = screen.getByRole("tabpanel", { name: /Code/ });
      const filter = within(code).getByRole("textbox", { name: "Filter pull request files" });
      fireEvent.change(filter, { target: { value: "src/app" } });
      fireEvent.click(screen.getByRole("button", { name: "Split PR diff" }));
      filter.focus();
      fetchJson.mockImplementationOnce(() => pending.promise);
      fireEvent.focus(window);
      expect(fetchJson).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("tabpanel", { name: /Code/ })).toBe(code);
      expect(filter).toHaveFocus();
      await act(async () => {
        if (failure === "network") pending.reject(new Error("Connection lost"));
        else pending.resolve(Response.json({ error: "GitHub is unavailable" }, { status: 503 }));
      });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Could not refresh pull request");
      expect(alert).toHaveTextContent("Showing previously loaded data");
      expect(screen.getByRole("heading", { name: "Panel change 5" })).toBeVisible();
      expect(screen.getByRole("tabpanel", { name: /Code/ })).toBe(code);
      expect(within(code).getByRole("textbox", { name: "Filter pull request files" })).toBe(filter);
      expect(filter).toHaveFocus();
      expect(filter).toHaveValue("src/app");
      expect(screen.getByRole("button", { name: "Split PR diff" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(code).toHaveTextContent("src/app.ts");

      fetchJson.mockImplementationOnce(() => retry.promise);
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(fetchJson).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("tabpanel", { name: /Code/ })).toBe(code);
      expect(filter).toHaveValue("src/app");
      filter.focus();
      await act(async () =>
        retry.resolve(Response.json({ ...inspection(), title: "Recovered pull request" })),
      );
      await screen.findByRole("heading", { name: "Recovered pull request" });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("tabpanel", { name: /Code/ })).toBe(code);
      expect(within(code).getByRole("textbox", { name: "Filter pull request files" })).toBe(filter);
      expect(filter).toHaveFocus();
      expect(filter).toHaveValue("src/app");
      expect(screen.getByRole("button", { name: "Split PR diff" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    },
  );
  it("shows the full error on first load and can retry", async () => {
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    fetchJson.mockRejectedValueOnce(new Error("Offline"));
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load pull request");
    expect(screen.queryByRole("heading", { name: "Panel change 5" })).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Panel change 5" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["pull request", "project", "API"])(
    "shows the full error after a failed %s identity change without restoring old data",
    async (identity) => {
      const oldRefresh = deferredResponse();
      const next = deferredResponse();
      const fetchJson = vi.fn(async () => Response.json(inspection()));
      const { rerender } = render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
      await screen.findByRole("heading", { name: "Panel change 5" });
      fetchJson
        .mockImplementationOnce(() => oldRefresh.promise)
        .mockImplementationOnce(() => next.promise);
      fireEvent.focus(window);
      if (identity === "pull request") {
        fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
          target: { value: "6" },
        });
      } else {
        rerender(
          <PullRequestsPanel
            {...props}
            projectId={identity === "project" ? "another-project" : id}
            baseUrl={identity === "API" ? "https://other-api.example" : props.baseUrl}
            fetchJson={fetchJson}
          />,
        );
      }
      expect(fetchJson).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("heading", { name: "Panel change 5" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open pull request on GitHub" })).toBeNull();
      await act(async () => next.reject(new Error("New identity is unavailable")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load pull request");
      await act(async () => oldRefresh.reject(new Error("Old refresh failed late")));
      expect(screen.getByRole("alert")).toHaveTextContent("Could not load pull request");
      expect(screen.queryByRole("heading", { name: "Panel change 5" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open pull request on GitHub" })).toBeNull();
      expect(screen.queryByRole("tabpanel", { name: /Code/ })).not.toBeInTheDocument();
    },
  );
  it("explains an unmatched Code filter and clears it", async () => {
    render(<PullRequestsPanel {...props} fetchJson={async () => Response.json(inspection())} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fireEvent.click(screen.getByRole("tab", { name: /Code/ }));
    const code = within(screen.getByRole("tabpanel", { name: /Code/ }));
    const filter = code.getByRole("textbox", { name: "Filter pull request files" });
    fireEvent.change(filter, { target: { value: "missing.ts" } });
    expect(code.getByRole("status")).toHaveTextContent("No matching files");
    fireEvent.click(code.getByRole("button", { name: "Clear filter" }));
    expect(filter).toHaveValue("");
    expect(code.queryByRole("status")).not.toBeInTheDocument();
    expect(code.getByText("src/app.ts")).toBeVisible();
  });
  it("keeps the Code filter when its path disappears on refresh and offers to clear it", async () => {
    const pending = deferredResponse();
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fireEvent.click(screen.getByRole("tab", { name: /Code/ }));
    const code = screen.getByRole("tabpanel", { name: /Code/ });
    const filter = within(code).getByRole("textbox", { name: "Filter pull request files" });
    fireEvent.change(filter, { target: { value: "src/app.ts" } });
    filter.focus();
    fetchJson.mockImplementationOnce(() => pending.promise);
    fireEvent.focus(window);
    expect(filter).toHaveFocus();
    expect(code).toHaveTextContent("src/app.ts");
    const updated = inspection();
    updated.files = updated.files.map((file) => ({ ...file, path: "src/renamed.ts" }));
    await act(async () => pending.resolve(Response.json(updated)));
    expect(await within(code).findByRole("status")).toHaveTextContent("No matching files");
    expect(screen.getByRole("tabpanel", { name: /Code/ })).toBe(code);
    expect(filter).toHaveFocus();
    expect(filter).toHaveValue("src/app.ts");
    fireEvent.click(within(code).getByRole("button", { name: "Clear filter" }));
    expect(filter).toHaveValue("");
    expect(within(code).getByText("src/renamed.ts")).toBeVisible();
    expect(within(code).queryByRole("status")).not.toBeInTheDocument();
  });
  it("does not replace a newer refresh with an older response", async () => {
    const older = deferredResponse();
    const newer = deferredResponse();
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fetchJson
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    await act(async () => newer.resolve(Response.json({ ...inspection(), title: "Newest" })));
    await screen.findByRole("heading", { name: "Newest" });
    await act(async () => older.resolve(Response.json({ ...inspection(), title: "Stale" })));
    expect(screen.getByRole("heading", { name: "Newest" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Stale" })).not.toBeInTheDocument();
  });
  it("ignores a late response from the previously selected PR", async () => {
    const old = deferredResponse();
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith("/5") ? old.promise : Response.json(inspection(6)),
    );
    render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
      target: { value: "6" },
    });
    await screen.findByRole("heading", { name: "Panel change 6" });
    await act(async () => old.resolve(Response.json(inspection(5))));
    expect(screen.getByRole("heading", { name: "Panel change 6" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Panel change 5" })).not.toBeInTheDocument();
  });
  it("does not show the previous project's same-number PR while the new project loads", async () => {
    const pending = deferredResponse();
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    const { rerender } = render(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    fetchJson.mockImplementationOnce(() => pending.promise);
    rerender(<PullRequestsPanel {...props} projectId="another-project" fetchJson={fetchJson} />);
    expect(screen.queryByRole("heading", { name: "Panel change 5" })).not.toBeInTheDocument();
    await act(async () =>
      pending.resolve(Response.json({ ...inspection(), title: "Other project" })),
    );
    expect(await screen.findByRole("heading", { name: "Other project" })).toBeVisible();
  });
  it("does not refresh an inactive or unmounted panel on focus and refreshes on activation", async () => {
    const fetchJson = vi.fn(async () => Response.json(inspection()));
    const { rerender, unmount } = render(
      <PullRequestsPanel {...props} active={false} fetchJson={fetchJson} />,
    );
    fireEvent.focus(window);
    expect(fetchJson).not.toHaveBeenCalled();
    rerender(<PullRequestsPanel {...props} fetchJson={fetchJson} />);
    await screen.findByRole("heading", { name: "Panel change 5" });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    rerender(<PullRequestsPanel {...props} active={false} fetchJson={fetchJson} />);
    fireEvent.focus(window);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.focus(window);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});
