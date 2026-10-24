import type { GitComparison } from "@nap/shared/git-protocol";
import type { ProjectGitHub, RepositoryJob } from "@nap/shared/github-protocol";
import type { TurnRequestStatus } from "@nap/shared/ports/turn-queue";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DraftThreadDetails,
  ThreadDetailsPanel,
  ThreadDetailsToggle,
  useThreadDetails,
} from "./thread-details.tsx";

/**
 * The card at the top right of the conversation: one row per thing about the thread's workspace
 * and branch. Queried by role and accessible name throughout — a card of icon rows is exactly
 * where an unlabelled control hides.
 */

const PROJECT = "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const SESSION = "b70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const JOB = "c70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const REQUEST = "d70e2120-867c-4eb7-bdd6-cdd1c33bac1e";

const comparison: GitComparison = {
  ready: true,
  scope: "branch",
  base: "a9c430e",
  head: "6b84c21",
  baseLabel: "main",
  branch: "nap/todo",
  revision: "fixture",
  capturedAt: "2026-10-24T10:00:00.000Z",
  truncated: false,
  files: [
    {
      path: "src/app.tsx",
      previousPath: null,
      status: "modified",
      additions: 1000,
      deletions: 80,
      binary: false,
      truncated: false,
      patch: "",
    },
    {
      path: "src/app.css",
      previousPath: null,
      status: "modified",
      additions: 71,
      deletions: 5,
      binary: false,
      truncated: false,
      patch: "",
    },
  ],
};

function job(overrides: Partial<RepositoryJob> = {}): RepositoryJob {
  return {
    jobId: JOB,
    projectId: PROJECT,
    sessionId: SESSION,
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

function github(jobs: RepositoryJob[], devCommand: string | null = null): ProjectGitHub {
  return {
    repository: {
      projectId: PROJECT,
      sessionId: SESSION,
      userId: PROJECT,
      installationId: 42,
      repository: { id: 101, fullName: "nap-team/site", defaultBranch: "main", private: true },
      baseBranch: "main",
      environment: {
        setupCommand: "npm ci",
        devCommand,
        previewPort: devCommand === null ? null : 5173,
      },
      autoPublish: false,
    },
    jobs,
    feedback: [],
    followUpPolicy: "owner_approval",
  };
}

function server(
  state: ProjectGitHub | null | (() => ProjectGitHub | null),
  requestStatus: () => TurnRequestStatus = () => ({ id: REQUEST, state: "queued" }),
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/turns/")) return Response.json(requestStatus());
    if (url.includes("/changes?")) return Response.json(comparison);
    if (url.endsWith("/github/publish")) {
      // Admission does not change the job. Only a worker claiming the request does that.
      return Response.json({ requestId: "d70e2120-867c-4eb7-bdd6-cdd1c33bac1e" }, { status: 202 });
    }
    if (url.endsWith("/github/environment") && init?.method === "PATCH")
      return Response.json({ saved: true });
    if (url.endsWith("/github")) {
      const current = typeof state === "function" ? state() : state;
      return current === null
        ? Response.json({ error: "No such project." }, { status: 404 })
        : Response.json(current);
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
}

function show(
  fetchJson: ReturnType<typeof server>,
  props: Partial<Parameters<typeof ThreadDetailsPanel>[0]> = {},
) {
  const handlers = {
    onDismiss: vi.fn(),
    onOpenChanges: vi.fn(),
    onOpenPullRequests: vi.fn(),
  };
  const view = render(
    <ThreadDetailsPanel
      projectId={PROJECT}
      sessionId={SESSION}
      phase={{ kind: "running", url: "https://preview.example", seq: 4 }}
      previewUrl="https://preview.example"
      revision={0}
      presentation="inline"
      fetchJson={fetchJson}
      baseUrl="http://api.test"
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(async () => {
  // Unmount and flush owned continuations before removing their persisted state.
  cleanup();
  await act(async () => {});
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the workspace section", () => {
  it("names the sandbox the thread runs in, and does not offer to change it", async () => {
    show(server(null));

    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getByText("Cloud sandbox")).toBeVisible();
    expect(within(workspace).getByText(/running/)).toBeInTheDocument();
    expect(within(workspace).queryByRole("button", { name: /cloud sandbox/i })).toBeNull();
  });

  it("opens the running app in a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    show(server(null));

    fireEvent.click(screen.getByRole("button", { name: "Open in Browser" }));

    expect(open).toHaveBeenCalledWith("https://preview.example", "_blank", "noopener,noreferrer");
  });

  it("cannot open the app before anything is serving", () => {
    show(server(null), { previewUrl: undefined, phase: { kind: "starting" } });

    expect(screen.getByRole("button", { name: "Open in Browser" })).toBeDisabled();
  });

  it("remembers choosing GitHub, and then opens the branch there", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    show(server(github([job({ pushedSha: "6b84c21" })])));

    await screen.findByRole("button", { name: "Add project script" });
    fireEvent.click(screen.getByRole("button", { name: "Choose where to open" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in GitHub" }));

    expect(open).toHaveBeenCalledWith(
      "https://github.com/nap-team/site/tree/nap/todo",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("nap:open-in")).toBe("github");
  });

  it("offers to add a project script to a repository that serves nothing yet", async () => {
    show(server(github([])));

    fireEvent.click(await screen.findByRole("button", { name: "Add project script" }));

    const dialog = screen.getByRole("dialog", { name: "Project scripts" });
    expect(within(dialog).getByRole("textbox", { name: "Development command" })).toBeVisible();
  });

  it("calls them project scripts once there is a development command", async () => {
    show(server(github([], "npm run dev")));

    expect(await screen.findByRole("button", { name: "Project scripts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add project script" })).toBeNull();
  });

  it("has no scripts row for a project with no repository", async () => {
    const fetchJson = server(null);
    show(fetchJson);

    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /project script/i })).toBeNull();
  });
});

describe("the version control section", () => {
  it("shows the branch the sandbox has checked out, and how far it is from its base", async () => {
    show(server(null));

    expect(await screen.findByRole("button", { name: "Branch nap/todo" })).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Changes, ${(1071).toLocaleString()} lines added, 85 removed`,
      }),
    ).toBeVisible();
  });

  it("opens the diff from the changes row", async () => {
    const { onOpenChanges } = show(server(null));

    fireEvent.click(await screen.findByRole("button", { name: /^Changes/ }));

    expect(onOpenChanges).toHaveBeenCalled();
  });

  it("compares the branch with its base from the branch menu", async () => {
    const { onOpenChanges } = show(server(null));

    fireEvent.click(await screen.findByRole("button", { name: "Branch nap/todo" }));
    const menu = screen.getByRole("menu", { name: "Branch" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Compare with main" }));

    expect(onOpenChanges).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes a menu on Escape and hands focus back to the row", async () => {
    show(server(null));
    const trigger = await screen.findByRole("button", { name: "Branch nap/todo" });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Branch" }), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("has no git actions for a project with no repository to publish to", async () => {
    show(server(null));

    await screen.findByRole("button", { name: "Branch nap/todo" });
    expect(screen.queryByRole("group", { name: "Git actions" })).toBeNull();
  });

  it("keeps a realistic admitted publication queued without allowing duplicate publication", async () => {
    const fetchJson = server(github([job()]));
    show(fetchJson);

    const actions = await screen.findByRole("group", { name: "Git actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Commit, push & PR" }));

    await waitFor(() =>
      expect(fetchJson).toHaveBeenCalledWith(
        "http://api.test/projects/a70e2120-867c-4eb7-bdd6-cdd1c33bac1e/github/publish",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ jobId: JOB }) }),
      ),
    );
    expect(await within(actions).findByRole("button", { name: "Publishing…" })).toBeDisabled();
    await waitFor(() =>
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(2),
    );
    expect(within(actions).getByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Publication queued.");
    fireEvent.click(within(actions).getByRole("button", { name: "Publishing…" }));
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    expect(screen.queryByRole("menuitem", { name: "Commit, push & PR" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    await waitFor(() =>
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(3),
    );
    expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
    expect(within(actions).getByRole("button", { name: "Publishing…" })).toBeDisabled();
  });

  it("only pushes once the branch has an open pull request, and links to it", async () => {
    show(
      server(
        github([
          job({
            pullRequestNumber: 12,
            pullRequestUrl: "https://github.com/nap-team/site/pull/12",
            pullRequestState: "open",
          }),
        ]),
      ),
    );

    const actions = await screen.findByRole("group", { name: "Git actions" });
    expect(within(actions).getByRole("button", { name: "Commit & push" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Pull request #12, open" })).toHaveAttribute(
      "href",
      "https://github.com/nap-team/site/pull/12",
    );
  });

  it("explains, rather than does nothing, while nap is still working", async () => {
    const fetchJson = server(github([job({ publishState: "working" })]));
    show(fetchJson);

    const actions = await screen.findByRole("group", { name: "Git actions" });
    const primary = within(actions).getByRole("button", { name: "Commit, push & PR" });
    fireEvent.click(primary);

    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).toHaveAttribute("title", "nap is still working on this branch.");
    expect(screen.getByRole("status")).toHaveTextContent("nap is still working on this branch.");
    expect(fetchJson).not.toHaveBeenCalledWith(
      expect.stringContaining("/publish"),
      expect.anything(),
    );
  });

  it("opens the pull requests panel from the git menu", async () => {
    const { onOpenPullRequests } = show(server(github([job()])));

    fireEvent.click(await screen.findByRole("button", { name: "Git action options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pull requests" }));

    expect(onOpenPullRequests).toHaveBeenCalled();
  });
});

describe("as a popover", () => {
  it("is a dialog, and closes on Escape", async () => {
    const { onDismiss } = show(server(null), { presentation: "popover" });

    const card = screen.getByRole("dialog", { name: "Thread details" });
    fireEvent.keyDown(within(card).getByRole("button", { name: "Open in Browser" }), {
      key: "Escape",
    });

    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes on a press outside it, but not on one inside", () => {
    const { onDismiss } = show(server(null), { presentation: "popover" });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open in Browser" }));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes once it has sent the reader to the diff", async () => {
    const { onDismiss, onOpenChanges } = show(server(null), { presentation: "popover" });

    fireEvent.click(await screen.findByRole("button", { name: /^Changes/ }));

    expect(onOpenChanges).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("is a landmark beside the conversation when inline, and ignores outside presses", () => {
    const { onDismiss } = show(server(null));

    expect(screen.getByRole("complementary", { name: "Thread details" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

function Harness({ storageKey }: { storageKey: string }) {
  const details = useThreadDetails(storageKey);
  return (
    <div ref={details.ref}>
      <p>{`${details.presentation}:${details.open}`}</p>
      <button type="button" onClick={details.toggle}>
        toggle
      </button>
    </div>
  );
}

describe("whether the card shows", () => {
  it("opens only when asked while it is a popover", () => {
    // jsdom lays nothing out, so the canvas measures zero wide: a popover.
    render(<Harness storageKey="p" />);

    expect(screen.getByText("popover:false")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByText("popover:true")).toBeVisible();
  });

  it("is open by default inline, and remembers being closed", () => {
    const widths = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
    const { unmount } = render(<Harness storageKey="p" />);

    expect(screen.getByText("inline:true")).toBeVisible();
    act(() => fireEvent.click(screen.getByRole("button", { name: "toggle" })));
    expect(screen.getByText("inline:false")).toBeVisible();
    unmount();

    render(<Harness storageKey="p" />);
    expect(screen.getByText("inline:false")).toBeVisible();
    expect(widths).toHaveBeenCalled();
  });
});

describe("before a session exists", () => {
  function draft(source: Parameters<typeof DraftThreadDetails>[0]["source"]) {
    const handlers = { onDismiss: vi.fn(), onEditSource: vi.fn() };
    render(<DraftThreadDetails source={source} presentation="inline" {...handlers} />);
    return handlers;
  }

  it("shows the sandbox the first message will start, with nothing to open yet", () => {
    draft(null);

    expect(screen.getByRole("complementary", { name: "Thread details" })).toBeVisible();
    expect(screen.getByText("Cloud sandbox")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open in Browser" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Version Control" })).toBeNull();
  });

  it("shows the branch a chosen repository will start from", () => {
    draft({ fullName: "nap-team/site", baseBranch: "develop", devCommand: null });

    expect(screen.getByRole("button", { name: "Branch develop" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Changes/ })).toBeDisabled();
    const primary = within(screen.getByRole("group", { name: "Git actions" })).getByRole("button", {
      name: "Commit, push & PR",
    });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Git action options" })).toBeDisabled();
  });

  it("hands script and branch edits back to the composer's source settings", () => {
    const { onEditSource } = draft({
      fullName: "nap-team/site",
      baseBranch: "develop",
      devCommand: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add project script" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch develop" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change base branch" }));

    expect(onEditSource).toHaveBeenCalledTimes(2);
  });
});

function PopoverHarness({ fetchJson = server(null) }: { fetchJson?: ReturnType<typeof server> }) {
  const details = useThreadDetails("popover-test");
  return (
    <div ref={details.ref}>
      <ThreadDetailsToggle
        open={details.open}
        onToggle={details.toggle}
        presentation={details.presentation}
        controls={details.id}
      />
      <button type="button">After toggle</button>
      {details.open && (
        <ThreadDetailsPanel
          id={details.id}
          projectId={PROJECT}
          sessionId={SESSION}
          phase={{ kind: "idle" }}
          previewUrl={undefined}
          revision={0}
          presentation={details.presentation}
          onDismiss={details.dismiss}
          onOpenChanges={vi.fn()}
          onOpenPullRequests={vi.fn()}
          fetchJson={fetchJson}
          baseUrl="http://api.test"
        />
      )}
    </div>
  );
}

describe("publication recovery", () => {
  it("retains admission across remounts when session storage is refused", async () => {
    let requestState: TurnRequestStatus["state"] = "queued";
    const fetchJson = server(github([job()]), () => ({ id: REQUEST, state: requestState }));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage refused");
    });
    const view = show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
    );
    view.unmount();
    show(fetchJson);
    await screen.findByRole("button", { name: "Add project script" });
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
    storage.mockRestore();
    requestState = "done";
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    });
    expect(screen.getByRole("button", { name: "Commit, push & PR" })).toBeEnabled();
  });

  it("keeps the receipt until a terminal request's job refresh succeeds", async () => {
    let requestState: TurnRequestStatus["state"] = "queued";
    const backing = server(github([job()]), () => ({ id: REQUEST, state: requestState }));
    let unavailable = false;
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/github") && unavailable
        ? Response.json({ error: "Job unavailable" }, { status: 503 })
        : backing(url, init),
    );
    show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
    );
    requestState = "done";
    unavailable = true;
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    });
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Job unavailable");
    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    });
    expect(screen.getByRole("button", { name: "Commit, push & PR" })).toBeEnabled();
  });

  it("retains admission when terminal refresh A is discarded and newer refresh B fails", async () => {
    let requestState: TurnRequestStatus["state"] = "queued";
    const published = github([
      job({
        publishState: "published",
        pushedSha: "6b84c21",
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/nap-team/site/pull/12",
        pullRequestState: "open",
        updatedAt: "2026-10-24T10:01:00.000Z",
      }),
    ]);
    let state = github([job()]);
    const backing = server(
      () => state,
      () => ({ id: REQUEST, state: requestState }),
    );
    let phase: "initial" | "A" | "B" | "recovery" = "initial";
    let callsA = 0;
    let callsB = 0;
    let resolveA: (response: Response) => void = () => {
      throw new Error("A not started");
    };
    let resolveB: (response: Response) => void = () => {
      throw new Error("B not started");
    };
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/github") && phase === "A") {
        callsA++;
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      }
      if (url.endsWith("/github") && phase === "B") {
        callsB++;
        return new Promise<Response>((resolve) => {
          resolveB = resolve;
        });
      }
      return backing(url, init);
    });
    const view = show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
    );
    await act(async () => {});
    requestState = "done";
    phase = "A";
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    await waitFor(() => expect(callsA).toBe(1));
    phase = "B";
    view.rerender(
      <ThreadDetailsPanel
        projectId={PROJECT}
        sessionId={SESSION}
        phase={{ kind: "running", url: "https://preview.example", seq: 4 }}
        previewUrl="https://preview.example"
        revision={1}
        presentation="inline"
        fetchJson={fetchJson}
        baseUrl="http://api.test"
        onDismiss={view.onDismiss}
        onOpenChanges={view.onOpenChanges}
        onOpenPullRequests={view.onOpenPullRequests}
      />,
    );
    await waitFor(() => expect(callsB).toBe(1));
    await act(async () => {
      resolveA(Response.json(published));
    });
    expect(screen.queryByRole("button", { name: "View PR" })).toBeNull();
    await act(async () => {
      resolveB(Response.json({ error: "Job unavailable" }, { status: 503 }));
    });
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
    expect(fetchJson.mock.calls.filter(([url]) => url.includes("/turns/"))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Commit, push & PR" })).toBeNull();
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();

    phase = "recovery";
    state = published;
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    });
    expect(screen.getByRole("button", { name: "View PR" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Publishing…" })).toBeNull();
    expect(fetchJson.mock.calls.filter(([url]) => url.includes("/turns/"))).toHaveLength(2);
    expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
    view.unmount();
    show(fetchJson);
    expect(await screen.findByRole("button", { name: "View PR" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Publishing…" })).toBeNull();
  });

  it.each(["project", "session", "owner", "api"] as const)(
    "keeps admission scoped when changing %s and restores it on return",
    async (changed) => {
      const original = github([job()]);
      const fetchJson = server(original);
      const view = show(fetchJson);
      fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
      );
      view.unmount();
      const other = "e70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
      const projectId = changed === "project" ? other : PROJECT;
      const sessionId = changed === "session" ? other : SESSION;
      const state = {
        ...original,
        repository: original.repository && {
          ...original.repository,
          projectId,
          sessionId,
          userId: changed === "owner" ? other : original.repository.userId,
        },
        jobs: [job({ projectId, sessionId })],
      };
      const next = show(server(state), {
        projectId,
        sessionId,
        baseUrl: changed === "api" ? "http://other-api.test" : "http://api.test",
      });
      expect(await screen.findByRole("button", { name: "Commit, push & PR" })).toBeEnabled();
      next.unmount();
      show(fetchJson);
      await screen.findByRole("button", { name: "Add project script" });
      expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
    },
  );

  it("polls the admitted request until terminal and stops on unmount", async () => {
    const state = github([job()]);
    let requestState: TurnRequestStatus["state"] = "queued";
    const fetchJson = server(state, () => ({ id: REQUEST, state: requestState }));
    const view = show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
    );
    view.unmount();
    vi.useFakeTimers();
    // Remount installs the polling clock under fake timers, with the persisted receipt.
    const reopened = show(fetchJson);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchJson).toHaveBeenCalledWith(
      `http://api.test/sessions/${SESSION}/turns/${REQUEST}`,
      expect.anything(),
    );
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
    reopened.unmount();
    const unmountedCount = fetchJson.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchJson.mock.calls).toHaveLength(unmountedCount);
    requestState = "done";
    const completed = show(fetchJson);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("button", { name: "Commit, push & PR" })).toBeEnabled();
    const count = fetchJson.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchJson.mock.calls).toHaveLength(count);
    completed.unmount();
  });

  it.each(["malformed receipt", "disconnect", "server error"])(
    "retains explicit PR-panel recovery after %s instead of offering duplicate admission",
    async (problem) => {
      const backing = server(github([job()]));
      const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.endsWith("/publish")) return backing(url, init);
        if (problem === "disconnect") throw new Error("lost response");
        return Response.json(
          { error: "Unconfirmed" },
          { status: problem === "server error" ? 503 : 202 },
        );
      });
      const view = show(fetchJson);
      const publishButton = await screen.findByRole("button", { name: "Commit, push & PR" });
      await act(async () => {
        fireEvent.click(publishButton);
      });
      view.unmount();
      const { onOpenPullRequests } = show(fetchJson);
      await screen.findByRole("button", { name: "Add project script" });
      expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      expect(screen.queryByRole("menuitem", { name: "Commit, push & PR" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: "Pull requests" }));
      expect(onOpenPullRequests).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retains admission when unmounted before the POST response, reopen while waiting=%s",
    async (reopenWhileWaiting) => {
      let finish: (response: Response) => void = () => {
        throw new Error("No pending POST");
      };
      const response = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const backing = server(github([job()]));
      const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith("/publish") ? response : backing(url, init),
      );
      const view = show(fetchJson);
      fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
      view.unmount();
      if (reopenWhileWaiting) {
        show(fetchJson);
        await screen.findByRole("button", { name: "Add project script" });
        expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Commit, push & PR" })).toBeNull();
      }
      await act(async () => {
        finish(Response.json({ requestId: REQUEST }, { status: 202 }));
        await response;
      });
      if (!reopenWhileWaiting) show(fetchJson);
      await screen.findByRole("button", { name: "Add project script" });
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
      );
      expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
      });
      expect(fetchJson).toHaveBeenCalledWith(
        `http://api.test/sessions/${SESSION}/turns/${REQUEST}`,
        expect.anything(),
      );
      expect(screen.queryByRole("button", { name: "Commit, push & PR" })).toBeNull();
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
    },
  );

  it.each(["published", "failed"] as const)(
    "does not settle an admitted %s job after an unrelated webhook changes updatedAt",
    async (publishState) => {
      const old = job({
        publishState,
        pullRequestState: "open",
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/nap-team/site/pull/12",
        error: publishState === "failed" ? "Old failure" : null,
      });
      let state = github([old]);
      let requestState: TurnRequestStatus["state"] = "queued";
      const fetchJson = server(
        () => state,
        () => ({ id: REQUEST, state: requestState }),
      );
      show(fetchJson);
      await screen.findByRole("button", { name: "Add project script" });
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
      );
      state = github([{ ...old, checkState: "passed", updatedAt: "2026-10-24T11:00:00.000Z" }]);
      for (const pending of ["queued", "leased"] as const) {
        requestState = pending;
        fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
        await act(async () => {
          fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
        });
        fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
        expect(screen.queryByRole("menuitem", { name: "Commit & push" })).toBeNull();
        expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      }
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
    },
  );

  it.each(["wrong id", "malformed", "404", "503", "disconnect"])(
    "keeps accepted ownership through a %s status read, then recovers on a valid terminal read",
    async (problem) => {
      const backing = server(github([job()]));
      let invalid = true;
      const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.includes("/turns/")) return backing(url, init);
        if (!invalid) return Response.json({ id: REQUEST, state: "done" });
        if (problem === "disconnect") throw new Error("offline");
        if (problem === "404" || problem === "503")
          return Response.json({ error: "Unavailable" }, { status: Number(problem) });
        return Response.json(
          problem === "wrong id" ? { id: JOB, state: "done" } : { state: "done" },
        );
      });
      show(fetchJson);
      fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Publication queued."),
      );
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
      });
      expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Could not confirm publication status");
      invalid = false;
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
      });
      expect(screen.getByRole("button", { name: "Commit, push & PR" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("keeps an admitted publication queued when the card is closed and reopened", async () => {
    const fetchJson = server(github([job()]));
    const view = show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(2),
    );
    view.unmount();
    show(fetchJson);
    expect(await screen.findByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Commit, push & PR" })).toBeNull();
    expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
  });
  it("keeps the PR panel reachable when a worker left a job publishing", async () => {
    const { onOpenPullRequests } = show(server(github([job({ publishState: "publishing" })])));
    await screen.findByRole("button", { name: "Publishing…" });
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    expect(screen.getByRole("menuitem", { name: "Check publication status" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pull requests" }));
    expect(onOpenPullRequests).toHaveBeenCalledOnce();
  });

  it.each(["done", "failed", "orphaned"] as const)(
    "settles only the admitted request after %s and refreshes the job",
    async (terminalState) => {
      let state = github([job()]);
      let requestState: TurnRequestStatus["state"] = "queued";
      const fetchJson = server(
        () => state,
        () => ({ id: REQUEST, state: requestState }),
      );
      show(fetchJson);
      fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
      await waitFor(() =>
        expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(2),
      );
      const publishState = terminalState === "done" ? "published" : "failed";
      requestState = terminalState;
      state = github([
        job({
          publishState,
          error: publishState === "failed" ? "Push failed" : null,
          updatedAt: "2026-10-24T11:00:00.000Z",
          pullRequestUrl: "https://github.com/nap-team/site/pull/12",
          pullRequestNumber: 12,
          pullRequestState: "open",
        }),
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
      expect(
        await screen.findByRole("button", {
          name: publishState === "published" ? "View PR" : "Commit & push",
        }),
      ).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Publishing…" })).toBeNull();
      if (publishState === "failed")
        expect(screen.getByRole("alert")).toHaveTextContent("Push failed");
    },
  );

  it("does not mistake the old published state for completion of a new push", async () => {
    const fetchJson = server(
      github([
        job({
          publishState: "published",
          pullRequestState: "open",
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/nap-team/site/pull/12",
        }),
      ]),
    );
    show(fetchJson);
    await screen.findByRole("button", { name: "View PR" });
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));
    await waitFor(() =>
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(2),
    );
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  });

  it("shows admission failure, allows retry, and clears the old error on success", async () => {
    const backing = server(github([job()]));
    let refuse = true;
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/publish") && refuse
        ? Response.json({ error: "Publication refused" }, { status: 409 })
        : backing(url, init),
    );
    show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Publication refused");
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Commit, push & PR" }));
    expect(await screen.findByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows status-check failure without enabling duplicate publication", async () => {
    const backing = server(github([job()]));
    let unavailable = false;
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/github") && unavailable
        ? Response.json({ error: "Status unavailable" }, { status: 503 })
        : backing(url, init),
    );
    show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Commit, push & PR" }));
    await waitFor(() =>
      expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(2),
    );
    unavailable = true;
    fireEvent.click(screen.getByRole("button", { name: "Git action options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Check publication status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  });
});

describe("comparison lifecycle", () => {
  it("waits for replay and repository metadata, then requests the configured base once", async () => {
    const fetchJson = server(github([]));
    const view = show(fetchJson, { replayed: false });
    expect(fetchJson).not.toHaveBeenCalled();
    view.rerender(
      <ThreadDetailsPanel
        projectId={PROJECT}
        sessionId={SESSION}
        phase={{ kind: "idle" }}
        previewUrl={undefined}
        revision={7}
        replayed
        presentation="inline"
        onDismiss={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenPullRequests={vi.fn()}
        fetchJson={fetchJson}
        baseUrl="http://api.test"
      />,
    );
    await screen.findByRole("button", { name: "Branch nap/todo" });
    const requests = fetchJson.mock.calls.filter(([url]) => url.includes("/changes?"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[0]).toBe(
      `http://api.test/sessions/${SESSION}/changes?scope=branch&base=main`,
    );
  });

  it.each(["revision", "sandboxId"] as const)(
    "retries an unavailable sandbox comparison after %s changes",
    async (changed) => {
      const backing = server(null);
      let ready = false;
      const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
        url.includes("/changes?") && !ready
          ? Response.json({ error: "Put away" }, { status: 409 })
          : backing(url, init),
      );
      const props = {
        projectId: PROJECT,
        sessionId: SESSION,
        phase: { kind: "idle" } as const,
        previewUrl: undefined,
        revision: 0,
        sandboxId: "old",
        presentation: "inline" as const,
        onDismiss: vi.fn(),
        onOpenChanges: vi.fn(),
        onOpenPullRequests: vi.fn(),
        fetchJson,
        baseUrl: "http://api.test",
      };
      const view = render(<ThreadDetailsPanel {...props} />);
      await waitFor(() =>
        expect(fetchJson.mock.calls.some(([url]) => url.includes("/changes?"))).toBe(true),
      );
      expect(screen.getByRole("button", { name: "Changes, not counted yet" })).toHaveTextContent(
        "Not counted yet",
      );
      ready = true;
      view.rerender(
        <ThreadDetailsPanel
          {...props}
          {...(changed === "revision" ? { revision: 1 } : { sandboxId: "new" })}
        />,
      );
      expect(await screen.findByRole("button", { name: "Branch nap/todo" })).toBeVisible();
      expect(fetchJson.mock.calls.filter(([url]) => url.includes("/changes?"))).toHaveLength(2);
    },
  );

  it("marks partial totals and discards them when a later comparison fails", async () => {
    const backing = server(null);
    let ready = true;
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("/changes?")
        ? ready
          ? Response.json({ ...comparison, truncated: true })
          : Response.json({ error: "Put away" }, { status: 409 })
        : backing(url, init),
    );
    const props = {
      projectId: PROJECT,
      sessionId: SESSION,
      phase: { kind: "idle" } as const,
      previewUrl: undefined,
      revision: 0,
      presentation: "inline" as const,
      onDismiss: vi.fn(),
      onOpenChanges: vi.fn(),
      onOpenPullRequests: vi.fn(),
      fetchJson,
      baseUrl: "http://api.test",
    };
    const view = render(<ThreadDetailsPanel {...props} />);
    expect(
      await screen.findByRole("button", { name: /Changes, .*partial totals/ }),
    ).toHaveTextContent("Partial");
    ready = false;
    view.rerender(<ThreadDetailsPanel {...props} revision={1} />);
    expect(
      await screen.findByRole("button", { name: "Changes, not counted yet" }),
    ).toHaveTextContent("Not counted yet");
    expect(screen.queryByRole("button", { name: /Changes, .*lines added/ })).toBeNull();
  });
});

describe("keyboard and layered controls", () => {
  it("focuses the popover on opening and returns to its toggle on Escape", async () => {
    render(<PopoverHarness />);
    const toggle = screen.getByRole("button", { name: "Toggle thread details panel" });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "Thread details" });
    expect(dialog).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", dialog.id);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("excludes its own toggle from outside dismissal so a pointer click closes it", () => {
    render(<PopoverHarness />);
    const toggle = screen.getByRole("button", { name: "Toggle thread details panel" });
    fireEvent.click(toggle);
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
  });

  it("leaves focus on an outside control when a pointer dismisses the popover", () => {
    render(<PopoverHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle thread details panel" }));
    const outside = screen.getByRole("button", { name: "After toggle" });
    fireEvent.pointerDown(outside);
    outside.focus();
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("moves through menu items with arrows, Home and End, and restores focus on activation and Tab", async () => {
    show(server(null));
    const trigger = await screen.findByRole("button", { name: "Branch nap/todo" });
    fireEvent.click(trigger);
    const selected = screen.getByRole("menuitemradio", { name: "nap/todo" });
    const compare = screen.getByRole("menuitem", { name: "Compare with main" });
    const copy = screen.getByRole("menuitem", { name: "Copy branch name" });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: "ArrowDown" });
    expect(compare).toHaveFocus();
    fireEvent.keyDown(compare, { key: "End" });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(copy, { key: "ArrowDown" });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: "ArrowUp" });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(copy, { key: "Home" });
    expect(selected).toHaveFocus();
    fireEvent.click(selected);
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    const first = screen.getByRole("menuitemradio", { name: "nap/todo" });
    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps menus open during unrelated transcript scrolling, but closes when their card scrolls", async () => {
    show(server(null));
    const trigger = await screen.findByRole("button", { name: "Branch nap/todo" });
    fireEvent.click(trigger);
    const transcript = document.body.appendChild(document.createElement("div"));
    fireEvent.scroll(transcript);
    transcript.remove();
    expect(screen.getByRole("menu", { name: "Branch" })).toBeVisible();
    fireEvent.scroll(screen.getByRole("region", { name: "Version Control" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("handles rejected clipboard access with a visible error", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    try {
      show(server(null));
      fireEvent.click(await screen.findByRole("button", { name: "Branch nap/todo" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy branch name" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the branch name.");
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("project scripts", () => {
  it.each([true, false])("saves scripts with success=%s and shows the result", async (success) => {
    const backing = server(github([]));
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/environment") && !success
        ? Response.json({ error: "Scripts refused" }, { status: 409 })
        : backing(url, init),
    );
    show(fetchJson);
    fireEvent.click(await screen.findByRole("button", { name: "Add project script" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Development command" }), {
      target: { value: "npm run dev" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Preview port" }), {
      target: { value: "5173" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole(success ? "status" : "alert")).toHaveTextContent(
      success ? "Saved." : "Scripts refused",
    );
    expect(fetchJson).toHaveBeenCalledWith(
      `http://api.test/projects/${PROJECT}/github/environment`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          setupCommand: "npm ci",
          devCommand: "npm run dev",
          previewPort: 5173,
        }),
      }),
    );
    expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("/github"))).toHaveLength(
      success ? 2 : 1,
    );
  });

  it("leaves the underlying popover open when Escape is handled by the scripts dialog", async () => {
    const { onDismiss } = show(server(github([])), { presentation: "popover" });
    fireEvent.click(await screen.findByRole("button", { name: "Add project script" }));
    const input = screen.getByRole("textbox", { name: "Development command" });
    fireEvent.change(input, { target: { value: "npm run dev" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    const scripts = screen.getByRole("dialog", { name: "Project scripts" });
    if (!(scripts instanceof HTMLDialogElement)) throw new Error("Expected native scripts dialog");
    act(() => scripts.close());
    expect(screen.getByRole("dialog", { name: "Thread details" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Project scripts" })).toBeNull();
  });

  it("opens the base branch on GitHub until the sandbox branch is pushed", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    show(server(github([job()])));
    await screen.findByRole("button", { name: "Add project script" });
    fireEvent.click(screen.getByRole("button", { name: "Choose where to open" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/nap-team/site/tree/main",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
