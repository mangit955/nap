/**
 * Opening a put-away project, and then either pressing Resume or sending a message.
 *
 * Opening asks for nothing. The page shows the last snapshot and the chat, and the workspace
 * starts only when somebody does one of those two things: a project opened just to look at it
 * holds none of the person's sandbox slots, and is not moved to the top of their list as if
 * somebody had worked on it.
 *
 * The Resume test also pins the bug this file was first written for: the pane sat on
 * "Starting the dev server…" forever, because the flag that says a restore is under way was set
 * on the request and cleared by nothing. A page reload fixed it only because reloading threw the
 * flag away — the announcement had been in the log the whole time.
 *
 * It goes through `AppShell` rather than through either half alone on purpose. Both halves were
 * individually correct: the hook did not know about events, the pane did not know about the
 * request, and the fault lived exactly in the gap between them.
 *
 * Nothing is mocked. The shell takes its socket factory and its `fetchJson` as arguments, so the
 * real subscription runs against a fake socket — which means this test also holds the rule that
 * a workspace opens *one* connection, since the socket is a countable thing here.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { AppShell } from "./app-shell.tsx";
import { PREVIEW_TITLE } from "./preview-pane.tsx";

/** Every open request the page made, so "exactly once" — and "never" — is a countable thing. */
let opens: number;
/** Every turn the page asked for. */
let turns: number;
/** What the server says to an open request. A 202 unless a test wants a refusal. */
let openWith: () => Response;
let net: ReturnType<typeof sockets>;

/** A project the server says is put away, and whatever `openWith` answers to an open. */
const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === "POST" && url.endsWith("/open")) {
    opens += 1;
    return openWith();
  }

  if (init?.method === "POST" && url.endsWith("/turns")) {
    turns += 1;
    return Response.json(
      { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
      { status: 202 },
    );
  }

  if (url.includes("/files")) {
    return new Response(JSON.stringify({ files: [], ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      projectId: PROJECT_ID,
      name: "Todo app",
      status: "idle",
      sandboxId: null,
      updatedAt: "2026-08-09T12:30:00.000Z",
      sessionIds: [SESSION_ID],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

function open() {
  return render(
    <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />,
  );
}

/**
 * The log of a project that ran, then was put away — which is what makes this the hard case:
 * there is already a `preview.ready` in it, belonging to a sandbox that no longer exists.
 */
async function replayPutAway() {
  await act(async () => {
    net.latest.open();
    net.latest.deliver({
      type: "event",
      event: ev("preview.ready", { url: "https://5173-old.e2b.app", port: 5173 }, 7),
    });
    net.latest.deliver({ type: "event", event: ev("preview.stopped", {}, 8) });
    net.latest.deliver({ type: "ready" });
  });
}

/** Presses the put-away screen's Resume, once it is on screen. */
async function pressResume() {
  const resume = await screen.findByRole("button", { name: /^resume$/i });
  await act(async () => {
    fireEvent.click(resume);
  });
}

beforeEach(() => {
  localStorage.clear();
  opens = 0;
  turns = 0;
  net = sockets();
  net.countGlobalToo(vi.stubGlobal);
  openWith = () =>
    new Response(JSON.stringify({ opened: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
});

describe("opening a project", () => {
  it("retains the exact preview iframe through compaction start and completion", async () => {
    // A project whose sandbox is serving: the record names it, so nothing here is put away.
    const running = async (url: string, init?: RequestInit) =>
      url.endsWith(`/projects/${PROJECT_ID}`)
        ? Response.json({
            projectId: PROJECT_ID,
            name: "Todo app",
            status: "ready",
            sandboxId: "running-sandbox",
            updatedAt: "2026-08-09T12:30:00.000Z",
            sessionIds: [SESSION_ID],
          })
        : fetchJson(url, init);
    render(<AppShell projectId={PROJECT_ID} fetchJson={running} createSocket={net.createSocket} />);
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({
        type: "event",
        event: ev("preview.ready", { url: "https://5173-existing.e2b.app", port: 5173 }, 1),
      });
      net.latest.deliver({ type: "ready" });
    });
    const frame = await screen.findByTitle(PREVIEW_TITLE);
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev(
          "compaction.started",
          { id: "4e4a0f05-f15f-45bc-9a9b-2e8049eb951b", trigger: "manual" },
          2,
        ),
      });
    });
    // Live events are committed a frame later, in a batch, so these wait for it.
    expect(
      await within(screen.getByRole("region", { name: "Conversation" })).findByText(
        "Compacting context",
      ),
    ).toBeVisible();
    expect(screen.getByTitle(PREVIEW_TITLE)).toBe(frame);
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev(
          "compaction.completed",
          {
            id: "4e4a0f05-f15f-45bc-9a9b-2e8049eb951b",
            beforeTokens: 4000,
            afterTokens: 2000,
            usage: null,
            result: {
              kind: "api",
              checkpoint: { summary: "Keep the form", coveredThrough: 1, tail: [] },
            },
          },
          3,
        ),
      });
    });
    expect(
      await within(screen.getByRole("region", { name: "Conversation" })).findByText(
        /^Context compacted/,
      ),
    ).toBeVisible();
    expect(screen.getByTitle(PREVIEW_TITLE)).toBe(frame);
    expect(frame).toHaveAttribute("src", "https://5173-existing.e2b.app");
  });

  it.each([null, 5173])(
    "uses the running sandbox's preview port %s after a full page load",
    async (runningPreviewPort) => {
      const read = async (url: string, init?: RequestInit) => {
        if (url.endsWith("/github"))
          return Response.json({
            repository: {
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              userId: PROJECT_ID,
              installationId: 42,
              repository: {
                id: 101,
                fullName: "owner/repository",
                defaultBranch: "main",
                private: true,
              },
              baseBranch: "main",
              environment: {
                setupCommand: null,
                devCommand: runningPreviewPort === null ? "npm run dev" : null,
                previewPort: runningPreviewPort === null ? 5173 : null,
              },
              autoPublish: true,
            },
            runningPreviewPort,
            jobs: [],
            feedback: [],
            followUpPolicy: "owner_approval",
          });
        if (url.endsWith(`/projects/${PROJECT_ID}`))
          return Response.json({
            projectId: PROJECT_ID,
            name: "Repository",
            status: "ready",
            sandboxId: "existing-repository-sandbox",
            updatedAt: "2026-08-09T12:30:00.000Z",
            sessionIds: [SESSION_ID],
          });
        return fetchJson(url, init);
      };
      render(<AppShell projectId={PROJECT_ID} fetchJson={read} createSocket={net.createSocket} />);
      await waitFor(() => expect(net.opened).toHaveLength(1));
      await act(async () => {
        net.latest.open();
        net.latest.deliver({
          type: "event",
          event: ev("user.message", { text: "Work on the repository" }, 1),
        });
        if (runningPreviewPort !== null)
          net.latest.deliver({
            type: "event",
            event: ev(
              "preview.ready",
              { url: "https://5173-existing.e2b.app", port: runningPreviewPort },
              2,
            ),
          });
        net.latest.deliver({ type: "ready" });
      });
      if (runningPreviewPort === null)
        expect(await screen.findByText("No preview configured")).toBeVisible();
      else
        expect(await screen.findByTitle(PREVIEW_TITLE)).toHaveAttribute(
          "src",
          "https://5173-existing.e2b.app",
        );
    },
  );

  it("applies a saved preview configuration only after the sandbox changes", async () => {
    let previewPort: number | null = null;
    let sandboxId = "first-repository-sandbox";
    let repositoryReads = 0;
    const read = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/github")) {
        repositoryReads += 1;
        return Response.json({
          repository: {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            userId: PROJECT_ID,
            installationId: 42,
            repository: {
              id: 101,
              fullName: "owner/repository",
              defaultBranch: "main",
              private: true,
            },
            baseBranch: "main",
            environment: {
              setupCommand: null,
              devCommand: previewPort === null ? null : "npm run dev",
              previewPort,
            },
            autoPublish: true,
          },
          jobs: [],
          feedback: [],
          followUpPolicy: "owner_approval",
        });
      }
      if (url.endsWith(`/projects/${PROJECT_ID}`))
        return Response.json({
          projectId: PROJECT_ID,
          name: "Repository",
          status: "ready",
          sandboxId,
          updatedAt: "2026-08-09T12:30:00.000Z",
          sessionIds: [SESSION_ID],
        });
      return fetchJson(url, init);
    };
    render(<AppShell projectId={PROJECT_ID} fetchJson={read} createSocket={net.createSocket} />);
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({
        type: "event",
        event: ev("user.message", { text: "Work on the repository" }, 1),
      });
      net.latest.deliver({ type: "ready" });
    });
    expect(await screen.findByText("No preview configured")).toBeVisible();
    const previousReads = repositoryReads;
    previewPort = 5173;
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("system.notice", { level: "info", text: "Environment settings saved." }, 2),
      });
    });
    await waitFor(() => expect(repositoryReads).toBeGreaterThan(previousReads));
    expect(screen.getByText("No preview configured")).toBeVisible();
    sandboxId = "second-repository-sandbox";
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("system.notice", { level: "info", text: "Repository workspace ready." }, 3),
      });
    });
    await waitFor(() => expect(screen.queryByText("No preview configured")).toBeNull());
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 4),
      });
    });
    expect(await screen.findByTitle(PREVIEW_TITLE)).toHaveAttribute(
      "src",
      "https://5173-new.e2b.app",
    );
  });

  it("restores a repository with no preview and refreshes its files from a workspace notice", async () => {
    let ready = false;
    const repository = {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      userId: PROJECT_ID,
      installationId: 42,
      repository: { id: 101, fullName: "owner/repository", defaultBranch: "main", private: true },
      baseBranch: "main",
      environment: { setupCommand: null, devCommand: null, previewPort: null },
      autoPublish: true,
    };
    const read = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/github"))
        return Response.json({
          repository,
          jobs: [],
          feedback: [],
          followUpPolicy: "owner_approval",
        });
      if (url.includes("/files"))
        return Response.json({ files: ready ? ["README.md"] : [], ready, truncated: false });
      if (url.endsWith("/open")) {
        opens += 1;
        return Response.json({}, { status: 202 });
      }
      if (url.endsWith(`/projects/${PROJECT_ID}`))
        return Response.json({
          projectId: PROJECT_ID,
          name: "Repository",
          status: ready ? "ready" : "idle",
          sandboxId: ready ? "repository-sandbox" : null,
          updatedAt: "2026-08-09T12:30:00.000Z",
          sessionIds: [SESSION_ID],
        });
      return fetchJson(url, init);
    };
    render(<AppShell projectId={PROJECT_ID} fetchJson={read} createSocket={net.createSocket} />);
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "ready" });
    });
    await pressResume();
    expect(opens).toBe(1);
    expect(screen.queryByText("No preview configured")).toBeNull();
    ready = true;
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("system.notice", { level: "info", text: "Repository workspace ready." }, 9),
      });
    });
    expect(await screen.findByText("No preview configured")).toBeVisible();
    expect(screen.queryByText(/starting the dev server/i)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(await screen.findByRole("button", { name: /README.md/ })).toBeVisible();
    expect(net.opened).toHaveLength(1);
    expect(opens).toBe(1);
  });

  it("asks for nothing, and lands on the snapshot with its Resume button", async () => {
    // Under `StrictMode` because that is how Next runs it in development: mounted, unmounted and
    // mounted again, which is where an effect that starts something would fire twice.
    render(
      <StrictMode>
        <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />
      </StrictMode>,
    );
    await waitFor(() => expect(net.opened.length).toBeGreaterThan(0));
    await replayPutAway();

    expect(await screen.findByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.getByText(/this project is put away/i)).toBeVisible();
    expect(screen.getByRole("img", { name: /last snapshot/i })).toHaveAttribute(
      "src",
      expect.stringContaining(`/projects/${PROJECT_ID}/thumbnail`),
    );
    expect(screen.queryByText(/starting the dev server/i)).toBeNull();
    expect(opens).toBe(0);
  });

  it("subscribes once for the whole workspace", async () => {
    // Three panes used to call the subscription hook for themselves, which was three connections
    // carrying identical frames — and two panes free to sit at different sequence numbers in the
    // same frame, one offering the address of a sandbox the other had watched stop.
    open();
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await replayPutAway();

    expect(net.opened).toHaveLength(1);
  });

  it("sends a message without asking to open the project first", async () => {
    // The turn brings the sandbox back up itself — its acquire step restores the snapshot — so
    // the composer needs no start of its own, and a separate open would be a second request
    // racing the turn for the same sandbox.
    open();
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await replayPutAway();

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Add a dark mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(turns).toBe(1));

    // The prompt lands in the log, after the record was read: the project is now starting, so the
    // put-away screen and its Resume button give way to the start-up screen. Left up, Resume would
    // offer a second start of a project the turn is already restoring.
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("user.message", { text: "Add a dark mode" }, 9, {
          createdAt: "2026-08-09T12:31:00.000Z",
        }),
      });
    });
    expect(await screen.findByText(/starting the dev server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
    // Read after the screen has settled, so an open sent a tick after the turn is counted too.
    expect(opens).toBe(0);
  });

  it("starts it when Resume is pressed, and shows the app with no reload", async () => {
    open();
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await replayPutAway();

    await pressResume();
    expect(opens).toBe(1);
    expect(screen.getByText(/starting the dev server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();

    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9),
      });
    });

    await waitFor(() => expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
    expect(screen.getByTitle(PREVIEW_TITLE)).toHaveAttribute(
      "src",
      expect.stringContaining("5173-new"),
    );
  });

  it("shows a refusal beside the button, and asks again only when pressed again", async () => {
    // A refusal leaves the record still saying the project is put away — it *is* put away, the
    // request was turned down — so the button stays, and nothing retries on its own.
    openWith = () =>
      new Response(JSON.stringify({ error: "You already have 2 projects running." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });

    open();
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await replayPutAway();

    await pressResume();
    expect(await screen.findByRole("alert")).toHaveTextContent(/2 projects running/);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(opens).toBe(1);

    await pressResume();
    expect(opens).toBe(2);
  });

  it("shows the next project put away too, after resuming the one before it", async () => {
    // Resuming marks the open record out of date, which hides the put-away screen for that
    // project. Carried over to the next project, it would hide the screen — and its button —
    // for a project nobody has started.
    const { rerender } = open();
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await replayPutAway();
    await pressResume();
    expect(opens).toBe(1);

    rerender(
      <AppShell
        projectId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
        fetchJson={fetchJson}
        createSocket={net.createSocket}
      />,
    );

    expect(await screen.findByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(opens).toBe(1);
  });
});
