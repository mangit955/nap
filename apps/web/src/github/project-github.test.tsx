import { type ProjectGitHub, RepositoryEnvironmentSchema } from "@nap/shared/github-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectGitHubControl } from "./project-github.tsx";

const id = "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const state: ProjectGitHub = {
  repository: {
    projectId: id,
    sessionId: id,
    userId: id,
    installationId: 42,
    repository: { id: 101, fullName: "nap-team/site", defaultBranch: "main", private: true },
    baseBranch: "main",
    environment: { setupCommand: "npm ci", devCommand: null, previewPort: null },
    autoPublish: true,
  },
  jobs: [
    {
      jobId: id,
      projectId: id,
      sessionId: id,
      baseBranch: "main",
      headBranch: "nap/fix",
      baseSha: "aabbcc",
      headSha: "bbccdd",
      pushedSha: "bbccdd",
      pullRequestNumber: null,
      pullRequestUrl: null,
      pullRequestState: "none",
      publishState: "failed",
      checkState: "failed",
      reviewState: "changes_requested",
      error: "GitHub is temporarily unavailable.",
      updatedAt: "2026-10-19T10:00:00.000Z",
    },
  ],
  feedback: [
    {
      id: "delivery-1",
      projectId: id,
      jobId: id,
      kind: "checks",
      summary: "CI failed on the pull request.",
      requestId: null,
      createdAt: "2026-10-19T10:00:00.000Z",
    },
  ],
  followUpPolicy: "owner_approval",
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("project GitHub controls", () => {
  it("saves an environment change and reads it back after reopening the project", async () => {
    let persisted = RepositoryEnvironmentSchema.parse({
      setupCommand: "npm ci",
      devCommand: null,
      previewPort: null,
    });
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(url).toMatch(`/projects/${id}/github/environment`);
        persisted = RepositoryEnvironmentSchema.parse(JSON.parse(String(init.body)));
        return Response.json({ saved: true });
      }
      return Response.json({
        ...state,
        repository: { ...state.repository, environment: persisted },
      });
    });
    const view = render(
      <ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Environment setup" }));
    fireEvent.change(screen.getByLabelText("Setup command"), {
      target: { value: "bun install --frozen-lockfile" },
    });
    fireEvent.change(screen.getByLabelText("Development command"), {
      target: { value: "bun run dev --host 0.0.0.0" },
    });
    fireEvent.change(screen.getByLabelText("Preview port"), { target: { value: "5173" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("status", { name: "GitHub action" })).toHaveTextContent(
      "Put the project away and reopen it to apply",
    );
    expect(persisted).toEqual({
      setupCommand: "bun install --frozen-lockfile",
      devCommand: "bun run dev --host 0.0.0.0",
      previewPort: 5173,
    });
    view.unmount();
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Environment setup" }));
    expect(screen.getByLabelText("Setup command")).toHaveValue("bun install --frozen-lockfile");
    expect(screen.getByLabelText("Development command")).toHaveValue("bun run dev --host 0.0.0.0");
    expect(screen.getByLabelText("Preview port")).toHaveValue(5173);
  });

  it("rejects an incomplete preview configuration without saving it", async () => {
    const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(state));
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Environment setup" }));
    fireEvent.change(screen.getByLabelText("Development command"), {
      target: { value: "npm run dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Set both the development command and preview port",
    );
    expect(fetchJson.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
  });

  it("offers an idempotent retry when an interrupted worker left publication in progress", async () => {
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === "POST"
          ? { requestId: id }
          : {
              ...state,
              jobs: state.jobs.map((job) => ({ ...job, publishState: "publishing", error: null })),
            },
      ),
    );
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check or retry publication" }));
    await waitFor(() =>
      expect(
        fetchJson.mock.calls.some(
          ([url, init]) =>
            url.endsWith("/github/publish") && init?.body === JSON.stringify({ jobId: id }),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check or retry publication" })).toBeEnabled(),
    );
  });

  it("shows review decisions without treating review bodies as pending instructions", async () => {
    const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        ...state,
        feedback: state.feedback.map((item) => ({
          ...item,
          kind: "review",
          summary: "Please change this",
        })),
      }),
    );
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    const control = await screen.findByRole("button", { name: "GitHub pull requests" });
    expect(control).not.toHaveTextContent("pending");
    fireEvent.click(control);
    expect(await screen.findByText(/Changes requested/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ask nap to address feedback" })).toBeNull();
    expect(screen.getByText(/Only.*\/nap.*comments/)).toBeVisible();
  });

  it("offers another retry when a queued publication later fails", async () => {
    let update = state.jobs[0]?.updatedAt;
    const fetchJson = async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === "POST"
          ? { requestId: id }
          : { ...state, jobs: state.jobs.map((job) => ({ ...job, updatedAt: update })) },
      );
    const view = render(
      <ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry publishing" }));
    await screen.findByText("Publication queued. Refresh to check progress.");
    update = "2026-10-19T10:01:00.000Z";
    view.rerender(<ProjectGitHubControl projectId={id} refreshKey={1} fetchJson={fetchJson} />);
    expect(await screen.findByRole("button", { name: "Retry publishing" })).toBeEnabled();
  });

  it("keeps successful pushes visible and retries PR publication through the durable request", async () => {
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(init?.method === "POST" ? { requestId: id } : state),
    );
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    expect(await screen.findByText(/Pushed bbccdd/)).toBeVisible();
    expect(screen.getByText("GitHub is temporarily unavailable.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry publishing" }));
    await waitFor(() =>
      expect(
        fetchJson.mock.calls.some(
          ([url, init]) =>
            url.endsWith("/github/publish") && init?.body === JSON.stringify({ jobId: id }),
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole("status", { name: "GitHub action" })).toHaveTextContent(
      "Publishing queued",
    );
  });

  it("requires an owner click before accepting feedback and hides the action after acceptance", async () => {
    let accepted = false;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        accepted = true;
        return Response.json({ requestId: id });
      }
      return Response.json({
        ...state,
        feedback: state.feedback.map((item) => ({ ...item, requestId: accepted ? id : null })),
      });
    });
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitHub pull requests" }));
    expect(await screen.findByText("CI failed on the pull request.")).toBeVisible();
    expect(fetchJson.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ask nap to address feedback" }));
    await waitFor(() =>
      expect(
        fetchJson.mock.calls.some(
          ([url, init]) => url.endsWith("/github/feedback/delivery-1") && init?.method === "POST",
        ),
      ).toBe(true),
    );
    await screen.findByText("Follow-up queued");
    expect(screen.queryByRole("button", { name: "Ask nap to address feedback" })).toBeNull();
  });

  it("does not display a PR control on a template project", async () => {
    const fetchJson = vi.fn(async () =>
      Response.json({ repository: null, jobs: [], feedback: [], followUpPolicy: "owner_approval" }),
    );
    render(<ProjectGitHubControl projectId={id} refreshKey={0} fetchJson={fetchJson} />);
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "GitHub pull requests" })).toBeNull();
  });
});
