import type { GitComparison } from "@nap/shared/git-protocol";
import type { ProjectGitHub, RepositoryJob } from "@nap/shared/github-protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DraftThreadDetails, ThreadDetailsPanel, useThreadDetails } from "./thread-details.tsx";

/**
 * The card at the top right of the conversation: one row per thing about the thread's workspace
 * and branch. Queried by role and accessible name throughout — a card of icon rows is exactly
 * where an unlabelled control hides.
 */

const PROJECT = "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const SESSION = "b70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const JOB = "c70e2120-867c-4eb7-bdd6-cdd1c33bac1e";

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

function server(state: ProjectGitHub | null) {
  let current = state;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/changes?")) return Response.json(comparison);
    if (url.endsWith("/github/publish")) {
      if (current) current = { ...current, jobs: [job({ publishState: "publishing" })] };
      return Response.json({ requestId: "d70e2120-867c-4eb7-bdd6-cdd1c33bac1e" });
    }
    if (url.endsWith("/github/environment") && init?.method === "PATCH")
      return Response.json({ saved: true });
    if (url.endsWith("/github"))
      return current === null
        ? Response.json({ error: "No such project." }, { status: 404 })
        : Response.json(current);
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
  render(
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
  return handlers;
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

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the workspace section", () => {
  it("names the sandbox the thread runs in, and does not offer to change it", async () => {
    show(server(null));

    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getByText("Cloud sandbox")).toBeVisible();
    expect(within(workspace).getByText(/running/)).toBeInTheDocument();
    expect(within(workspace).queryByRole("button", { name: /run context/i })).toBeNull();
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
    show(server(github([job()])));

    fireEvent.click(await screen.findByRole("button", { name: "Choose where to open" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GitHub" }));
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

  it("publishes verified work, and shows the publication in flight", async () => {
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
