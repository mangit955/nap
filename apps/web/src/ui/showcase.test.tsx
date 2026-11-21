import type { ProjectGitHub, PullRequestInspection } from "@nap/shared/github-protocol";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import type { ModelOption } from "../chat/model-options.ts";
import { ModelPicker } from "../chat/model-picker.tsx";
import type { TranscriptItem } from "../chat/transcript.ts";
import { SourceMark } from "../dashboard/session-row.tsx";
import { PullRequestsPanel } from "../github/pull-requests-panel.tsx";
import { SHOWCASE, ShowcaseContext } from "./showcase.ts";

/**
 * Each field of the showcase changes one thing, and only where the context is provided: every
 * case renders the component twice, bare and inside the context, so a reader that ignored the
 * context or applied it everywhere fails here.
 */
const inShowcase = (node: ReactNode) => <ShowcaseContext value={SHOWCASE}>{node}</ShowcaseContext>;

const ITEMS: TranscriptItem[] = [
  { kind: "message", key: 1, from: "agent", text: "Running your checks." },
  {
    kind: "step",
    key: 2,
    at: "2026-11-20T10:00:00.000Z",
    toolCallId: "c1",
    toolName: "run_command",
    input: { command: "bun test" },
    status: "failed",
    output: "1 failed",
    streamed: "✗ webhooks › retries send one email",
    files: [],
  },
  { kind: "message", key: 3, from: "agent", text: "Fixed." },
];

const OPUS: ModelOption = {
  id: "opus",
  label: "Opus",
  vendor: "anthropic",
  version: "claude-opus-5-5",
  isNew: false,
  images: true,
  efforts: [],
  available: true,
  free: false,
};

const ID = "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e";
const STATE: ProjectGitHub = {
  repository: null,
  jobs: [
    {
      jobId: ID,
      projectId: ID,
      sessionId: ID,
      baseBranch: "main",
      headBranch: "nap/change",
      baseSha: "base",
      headSha: "head",
      pushedSha: "head",
      pullRequestNumber: 5,
      pullRequestUrl: "https://github.com/acme/repo/pull/5",
      pullRequestState: "open",
      publishState: "published",
      checkState: "passed",
      reviewState: "unknown",
      error: null,
      updatedAt: "2026-10-19T10:00:00.000Z",
    },
  ],
  feedback: [],
  followUpPolicy: "owner_approval",
};
const PR: PullRequestInspection = {
  number: 5,
  title: "A change",
  body: "Description",
  url: "https://github.com/acme/repo/pull/5",
  state: "open",
  draft: false,
  author: "owner",
  base: { ref: "main", sha: "base" },
  head: { ref: "nap/change", sha: "head" },
  capturedAt: "2026-10-19T10:00:00.000Z",
  checks: [],
  timeline: [
    { id: "t1", kind: "comment", author: "mira", body: "Looks good.", state: null, at: null },
  ],
  comments: [],
  files: [],
};
const panel = (
  <PullRequestsPanel
    state={STATE}
    projectId={ID}
    baseUrl="https://api.example"
    refreshKey={0}
    active
    manage={null}
    fetchJson={async () => Response.json(PR)}
  />
);

describe("the showcase", () => {
  it("drops the copy button under each message", () => {
    const { unmount } = render(<ChatTranscript items={ITEMS} />);
    expect(screen.getAllByRole("button", { name: "Copy response" })).toHaveLength(2);
    unmount();
    render(inShowcase(<ChatTranscript items={ITEMS} />));
    expect(screen.queryByRole("button", { name: "Copy response" })).not.toBeInTheDocument();
  });

  it("draws the newest message whole rather than fading its words in", () => {
    const { container, unmount } = render(<ChatTranscript items={ITEMS} />);
    expect(container.querySelector("[data-streaming]")).not.toBeNull();
    unmount();
    const showcased = render(inShowcase(<ChatTranscript items={ITEMS} />));
    expect(showcased.container.querySelector("[data-streaming]")).toBeNull();
  });

  it("opens a failed command so its output shows", () => {
    const { unmount } = render(<ChatTranscript items={ITEMS} />);
    const closed = screen.getByRole("button", { name: /bun test, tool call failed/ });
    expect(closed).toHaveAttribute("aria-expanded", "false");
    unmount();
    render(inShowcase(<ChatTranscript items={ITEMS} />));
    const open = screen.getByRole("button", { name: /bun test, tool call failed/ });
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/retries send one email/)).toBeInTheDocument();
  });

  it("names the model without the vendor's mark", () => {
    const picker = (
      <ModelPicker
        models={[OPUS, { ...OPUS, id: "sonnet", label: "Sonnet" }]}
        model="opus"
        onChange={() => {}}
      />
    );
    const { unmount } = render(picker);
    expect(screen.getByRole("button", { name: /^Model/ }).querySelectorAll("svg")).toHaveLength(2);
    unmount();
    render(inShowcase(picker));
    const trigger = screen.getByRole("button", { name: /^Model/ });
    expect(trigger).toHaveTextContent("Opus");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  });

  it("marks a repository owner with a letter rather than fetching their avatar", () => {
    const source = { key: "acme/storefront", label: "storefront", owner: "acme" };
    const { container, unmount } = render(<SourceMark source={source} />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("github.com/acme.png");
    unmount();
    const showcased = render(inShowcase(<SourceMark source={source} />));
    expect(showcased.container.querySelector("img")).toBeNull();
    expect(showcased.container).toHaveTextContent("s");
  });

  it("opens a pull request on the tab it names", async () => {
    const { unmount } = render(panel);
    expect(await screen.findByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    unmount();
    render(
      <ShowcaseContext value={{ ...SHOWCASE, pullRequestView: "Timeline" }}>
        {panel}
      </ShowcaseContext>,
    );
    expect(await screen.findByRole("tab", { name: "Timeline" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Looks good.")).toBeVisible();
  });
});
