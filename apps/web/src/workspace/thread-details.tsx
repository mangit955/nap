"use client";

/**
 * The thread details card: the workspace a thread runs in and the branch its work is on, one row
 * each, floating at the top right of the conversation.
 *
 * A clone of T3 Code's thread details panel — the card, its two sections, and the select, split
 * and plain rows — with each row answering for what nap has rather than what a desktop app has.
 * The workspace is always a cloud sandbox, so its row is locked; "Open in" opens the running app
 * or the branch on GitHub rather than a local editor; a project's scripts are the repository's
 * setup and development commands; and the git row publishes the branch nap verified rather than
 * committing a working tree, because nap has already committed every turn.
 *
 * Adapted from T3 Code's `ThreadDetailsPanel.tsx`, `ThreadDetailsCard.tsx`,
 * `ThreadDetailsSection.tsx`, `ThreadDetailsControl.tsx` and `threadDetailsPanelStyles.ts` (MIT —
 * see apps/web/THIRD_PARTY_NOTICES.md).
 */

import { GitComparisonSchema } from "@nap/shared/git-protocol";
import {
  type ProjectGitHub,
  ProjectGitHubSchema,
  type RepositoryEnvironment,
} from "@nap/shared/github-protocol";
import {
  Check,
  ChevronDown,
  Cloud,
  Copy,
  FileDiff,
  Folder,
  GitBranch,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  LoaderCircle,
  Plus,
  SquareMenu,
  Wrench,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { EnvironmentSettings } from "../github/environment-settings.tsx";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { CloseIcon, GithubIcon } from "../ui/icons.tsx";
import {
  branchUrl,
  canPublish,
  currentJob,
  detailsPresentation,
  diffTotals,
  formatDiffCount,
  quickAction,
} from "./thread-details-logic.ts";
import { usePublicationAdmission } from "./use-publication-admission.ts";

/** The chat header's height: the card is placed in the canvas below it. */
const HEADER_HEIGHT = 52;
const environmentSavedSchema = z.object({ saved: z.literal(true) });

export type DetailsPresentation = "inline" | "popover";

/**
 * Whether the card shows, and how. Inline it stays open until its toggle closes it, and that
 * choice is remembered per project; as a popover it opens only when asked and closes on any
 * press outside it, the way T3 Code's does.
 */
export function useThreadDetails(key: string) {
  const id = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [presentation, setPresentation] = useState<DetailsPresentation>("popover");
  const [inlineOpen, setInlineOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const storageKey = `nap:thread-details:${key}`;

  useLayoutEffect(() => {
    setInlineOpen(readStoredOpen(storageKey));
    setPopoverOpen(false);
  }, [storageKey]);

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setPresentation(
        detailsPresentation({
          width: element.clientWidth,
          height: element.clientHeight - HEADER_HEIGHT,
        }),
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  useEffect(() => {
    if (presentation === "inline") setPopoverOpen(false);
  }, [presentation]);

  const toggle = useCallback(() => {
    if (presentation === "popover") {
      setPopoverOpen((open) => !open);
      return;
    }
    setInlineOpen((open) => {
      writeStoredOpen(storageKey, !open);
      return !open;
    });
  }, [presentation, storageKey]);
  const dismiss = useCallback(() => setPopoverOpen(false), []);

  return {
    id,
    ref: setElement,
    presentation,
    open: presentation === "inline" ? inlineOpen : popoverOpen,
    toggle,
    dismiss,
  };
}

function readStoredOpen(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) !== "closed";
  } catch {
    return true;
  }
}

function writeStoredOpen(key: string, open: boolean) {
  try {
    if (open) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, "closed");
  } catch {
    // A browser refusing storage costs the remembered choice, nothing more.
  }
}

export function ThreadDetailsPanel({
  projectId,
  sessionId,
  phase,
  previewUrl,
  revision,
  replayed = true,
  sandboxId,
  id,
  presentation,
  onDismiss,
  onOpenChanges,
  onOpenPullRequests,
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
}: {
  projectId: string;
  sessionId: string | undefined;
  phase: ProjectPhase;
  previewUrl: string | undefined;
  /** Bumped by every event that may have moved the branch or a pull request. */
  revision: number;
  replayed?: boolean;
  sandboxId?: string | null | undefined;
  id?: string;
  presentation: DetailsPresentation;
  onDismiss: () => void;
  onOpenChanges: () => void;
  onOpenPullRequests: () => void;
  fetchJson?: FetchJson | undefined;
  baseUrl?: string;
}) {
  const github = useProjectGitHub(projectId, revision, fetchJson, baseUrl, replayed);
  const repository = github.state?.repository ?? null;
  const job = currentJob(github.state?.jobs ?? []);
  const comparison = useBranchComparison(
    replayed && github.state !== undefined ? sessionId : undefined,
    repository?.baseBranch,
    revision,
    fetchJson,
    baseUrl,
    sandboxId,
  );
  const branch = comparison?.branch || job?.headBranch || repository?.baseBranch;
  const publication = usePublicationAdmission({
    baseUrl,
    projectId,
    sessionId: job?.sessionId,
    userId: repository?.userId,
    jobId: job?.projectId === projectId && job.sessionId === sessionId ? job.jobId : undefined,
    fetchJson,
    reload: github.reload,
  });
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const action = quickAction(job, publication.pending);
  const publicationError =
    publication.error ??
    (!publication.pending && job?.publishState === "failed" ? job.error : undefined);
  const clearPublicationError = publication.clearError;
  useEffect(() => {
    void job?.jobId;
    void job?.updatedAt;
    void revision;
    clearPublicationError();
  }, [job?.jobId, job?.updatedAt, revision, clearPublicationError]);

  const publish = () => {
    if (job && action.kind !== "progress" && canPublish(job)) void publication.publish();
  };

  const leave = (then: () => void) => () => {
    then();
    if (presentation === "popover") onDismiss();
  };

  const body = (
    <>
      <div className="t3-thread-details-card composer-surface nap-scroll">
        <DetailsSection title="Workspace">
          <SandboxRow state={sandboxState(phase)} />
          <OpenInRow
            targets={[
              { id: "browser", label: "Browser", url: previewUrl ?? null },
              ...(repository && branch
                ? [
                    {
                      id: "github" as const,
                      label: "GitHub",
                      url: branchUrl(
                        repository.repository.fullName,
                        job?.pushedSha !== null && job?.headBranch === branch
                          ? branch
                          : repository.baseBranch,
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {repository && (
            <button type="button" className="t3-td-row" onClick={() => setScriptsOpen(true)}>
              {repository.environment.devCommand === null ? (
                <Plus aria-hidden="true" />
              ) : (
                <Wrench aria-hidden="true" />
              )}
              <span className="t3-td-label">
                {repository.environment.devCommand === null
                  ? "Add project script"
                  : "Project scripts"}
              </span>
            </button>
          )}
        </DetailsSection>

        {sessionId !== undefined && (
          <DetailsSection title="Version Control" separated>
            {branch && (
              <BranchRow
                branch={branch}
                baseLabel={comparison?.baseLabel ?? repository?.baseBranch}
                onCompare={leave(onOpenChanges)}
              />
            )}
            {job?.pullRequestUrl && job.pullRequestNumber !== null && (
              <a
                className="t3-td-row"
                href={job.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Pull request #${job.pullRequestNumber}${job.pullRequestState === "none" ? "" : `, ${PULL_REQUEST_STATE[job.pullRequestState].toLowerCase()}`}`}
              >
                <GitPullRequest aria-hidden="true" />
                <span className="t3-td-label">#{job.pullRequestNumber}</span>
                <span className="t3-td-meta">{PULL_REQUEST_STATE[job.pullRequestState]}</span>
              </a>
            )}
            {repository && (
              <GitActionsRow
                action={action}
                publishLabel={
                  job === null || !canPublish(job)
                    ? null
                    : job.pullRequestState === "open"
                      ? "Commit & push"
                      : "Commit, push & PR"
                }
                pullRequestUrl={job?.pullRequestUrl ?? null}
                onPublish={publish}
                onCheckPublication={publication.checkPublication}
                onOpenPullRequests={leave(onOpenPullRequests)}
              />
            )}
            {action.kind === "progress" && (
              <p role="status" className="t3-td-note">
                {publication.queued
                  ? "Publication queued. "
                  : publication.pending
                    ? "Publication awaiting confirmation. "
                    : "Publication in progress. "}
                Use Git action options to check status or open Pull requests to retry if
                interrupted.
              </p>
            )}
            {publicationError && (
              <p role="alert" className="t3-td-error">
                {publicationError}
              </p>
            )}
            <ChangesRow
              totals={comparison?.totals}
              partial={comparison?.partial}
              onOpen={leave(onOpenChanges)}
            />
          </DetailsSection>
        )}
      </div>
      {repository && (
        <ScriptsDialog
          open={scriptsOpen}
          environment={repository.environment}
          onClose={() => setScriptsOpen(false)}
          onSave={async (environment) => {
            const result = await githubRequest(
              fetchJson,
              `${baseUrl}/projects/${projectId}/github/environment`,
              environmentSavedSchema,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(environment),
              },
            );
            if (result.ok) await github.reload();
            return result;
          }}
        />
      )}
    </>
  );
  return (
    <DetailsFrame id={id} presentation={presentation} onDismiss={onDismiss}>
      {body}
    </DetailsFrame>
  );
}

export type DraftSource = {
  fullName: string;
  baseBranch: string;
  devCommand: string | null;
};

/**
 * The card before a session exists: what the first message will start, as T3 Code shows it on a
 * new thread. A cloud sandbox, nothing serving yet, and — with a repository chosen — the branch
 * the work will start from. Every repository setting is still the composer's, so the rows that
 * would edit one hand back to it rather than saving anything themselves.
 */
export function DraftThreadDetails({
  id,
  source,
  presentation,
  onDismiss,
  onEditSource,
}: {
  id?: string;
  source: DraftSource | null;
  presentation: DetailsPresentation;
  onDismiss: () => void;
  onEditSource: () => void;
}) {
  const edit = () => {
    onEditSource();
    if (presentation === "popover") onDismiss();
  };
  return (
    <DetailsFrame id={id} presentation={presentation} onDismiss={onDismiss}>
      <div className="t3-thread-details-card composer-surface nap-scroll">
        <DetailsSection title="Workspace">
          <SandboxRow state="starts with your first message" />
          <OpenInRow
            targets={[
              { id: "browser", label: "Browser", url: null },
              ...(source
                ? [
                    {
                      id: "github" as const,
                      label: "GitHub",
                      url: branchUrl(source.fullName, source.baseBranch),
                    },
                  ]
                : []),
            ]}
          />
          {source && (
            <button type="button" className="t3-td-row" onClick={edit}>
              {source.devCommand === null ? (
                <Plus aria-hidden="true" />
              ) : (
                <Wrench aria-hidden="true" />
              )}
              <span className="t3-td-label">
                {source.devCommand === null ? "Add project script" : "Project scripts"}
              </span>
            </button>
          )}
        </DetailsSection>
        {source && (
          <DetailsSection title="Version Control" separated>
            <BranchRow branch={source.baseBranch} baseLabel={undefined} onChangeBase={edit} />
            <GitActionsRow
              action={quickAction(null, false)}
              publishLabel={null}
              pullRequestUrl={null}
              onPublish={() => {}}
            />
            <ChangesRow totals={{ additions: 0, deletions: 0 }} />
          </DetailsSection>
        )}
      </div>
    </DetailsFrame>
  );
}

/**
 * The card's outer box. A non-modal dialog when it opens over the conversation, which closes on
 * Escape from inside it or a press anywhere but itself, its toggle, or a menu it opened; beside
 * the conversation, a complementary landmark that stays until its toggle closes it.
 */
function DetailsFrame({
  id,
  presentation,
  onDismiss,
  children,
}: {
  id?: string | undefined;
  presentation: DetailsPresentation;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement | null>(null);
  const setCard = useCallback((element: HTMLElement | null) => {
    card.current = element;
  }, []);
  useLayoutEffect(() => {
    if (presentation !== "popover") return;
    const element = card.current;
    const trigger = element?.parentElement?.querySelector<HTMLElement>(
      "[data-thread-details-toggle]",
    );
    element?.focus();
    return () => {
      if (element?.contains(document.activeElement) || document.activeElement === document.body)
        trigger?.focus();
    };
  }, [presentation]);
  useEffect(() => {
    if (presentation !== "popover") return;
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (card.current?.contains(event.target)) return;
      if (event.target.closest("[data-thread-details-toggle], [data-thread-details-menu]")) return;
      onDismiss();
    };
    const escapeKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || event.target.closest("dialog") !== card.current)
        return;
      event.preventDefault();
      onDismiss();
      card.current?.parentElement
        ?.querySelector<HTMLElement>("[data-thread-details-toggle]")
        ?.focus();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", escapeKey);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", escapeKey);
    };
  }, [presentation, onDismiss]);
  return presentation === "popover" ? (
    <dialog
      id={id}
      ref={setCard}
      tabIndex={-1}
      open
      aria-label="Thread details"
      className="t3-thread-details"
      data-presentation={presentation}
    >
      {children}
    </dialog>
  ) : (
    <aside
      id={id}
      ref={setCard}
      aria-label="Thread details"
      className="t3-thread-details"
      data-presentation={presentation}
    >
      {children}
    </aside>
  );
}

/** The header button that shows and hides the card: T3 Code's thread panel toggle. */
export function ThreadDetailsToggle({
  open,
  onToggle,
  className = "t3-icon-button",
  presentation = "inline",
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  presentation?: DetailsPresentation | undefined;
  controls?: string | undefined;
}) {
  return (
    <button
      type="button"
      className={className}
      title="Toggle thread details"
      aria-label="Toggle thread details panel"
      aria-pressed={open}
      aria-expanded={open}
      aria-haspopup={presentation === "popover" ? "dialog" : undefined}
      aria-controls={open ? controls : undefined}
      data-thread-details-toggle=""
      onClick={onToggle}
    >
      <SquareMenu />
    </button>
  );
}

/** Locked, as T3 Code locks a thread's workspace once it has started: nap has only the one. */
function SandboxRow({ state }: { state: string }) {
  return (
    <p className="t3-td-row" data-locked="" title={`Cloud sandbox · ${state}`}>
      <span className="t3-td-icons">
        <Cloud aria-hidden="true" />
        <Folder aria-hidden="true" />
      </span>
      <span className="t3-td-label">Cloud sandbox</span>
      <span className="sr-only">, {state}</span>
    </p>
  );
}

function ChangesRow({
  totals,
  partial = false,
  onOpen,
}: {
  totals: { additions: number; deletions: number } | undefined;
  partial?: boolean | undefined;
  onOpen?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="t3-td-row"
      aria-label={`Changes, ${countsLabel(totals)}${partial ? ", partial totals" : ""}`}
      disabled={onOpen === undefined}
      onClick={onOpen}
    >
      <FileDiff aria-hidden="true" />
      <span className="t3-td-label">Changes</span>
      <span className="t3-td-counts" aria-hidden="true">
        {totals ? (
          <>
            {partial && <span>Partial</span>}
            <span className="t3-additions">+{formatDiffCount(totals.additions)}</span>
            <span className="t3-deletions">-{formatDiffCount(totals.deletions)}</span>
          </>
        ) : (
          <span>Not counted yet</span>
        )}
      </span>
    </button>
  );
}

const PULL_REQUEST_STATE = { none: "", open: "Open", closed: "Closed", merged: "Merged" };

function sandboxState(phase: ProjectPhase): string {
  switch (phase.kind) {
    case "running":
    case "no-preview":
      return "running";
    case "starting":
    case "opening":
      return "starting";
    case "put-away":
      return "put away";
    case "failed":
      return "failed to start";
    case "idle":
      return "not started";
  }
}

function countsLabel(totals: { additions: number; deletions: number } | undefined): string {
  if (totals === undefined) return "not counted yet";
  const { additions, deletions } = totals;
  return `${formatDiffCount(additions)} lines added, ${formatDiffCount(deletions)} removed`;
}

/** T3 Code's section: a padded block, ruled off from the one above it. */
function DetailsSection({
  title,
  separated = false,
  children,
}: {
  title: string;
  separated?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="t3-td-section" data-separated={separated || undefined}>
      {children}
    </section>
  );
}

type OpenInTarget = { id: "browser" | "github"; label: string; url: string | null };
const OPEN_IN_KEY = "nap:open-in";

/**
 * T3 Code's "Open in" split: the primary half opens the preferred target, the chevron chooses
 * which target is preferred. Choosing does not open anything, as in T3 Code.
 */
function OpenInRow({ targets }: { targets: OpenInTarget[] }) {
  const [preferred, setPreferred] = useState<OpenInTarget["id"]>("browser");
  useEffect(() => {
    try {
      const stored = globalThis.localStorage?.getItem(OPEN_IN_KEY);
      if (stored === "browser" || stored === "github") setPreferred(stored);
    } catch {
      // Unreadable storage leaves the default.
    }
  }, []);
  const target = targets.find((item) => item.id === preferred) ?? targets[0];
  const choose = (id: OpenInTarget["id"]) => {
    setPreferred(id);
    try {
      globalThis.localStorage?.setItem(OPEN_IN_KEY, id);
    } catch {
      // As above.
    }
  };
  if (target === undefined) return null;
  return (
    <SplitRow
      label="Open in"
      primary={
        <button
          type="button"
          className="t3-td-split-primary"
          disabled={target.url === null}
          title={target.url === null ? "Nothing is serving yet" : target.url}
          onClick={() => {
            if (target.url) window.open(target.url, "_blank", "noopener,noreferrer");
          }}
        >
          <TargetIcon id={target.id} />
          <span className="t3-td-label">Open in {target.label}</span>
        </button>
      }
      menuLabel="Choose where to open"
      menu={(close) =>
        targets.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={item.id === target.id}
            onClick={() => {
              choose(item.id);
              close();
            }}
          >
            <TargetIcon id={item.id} />
            <span className="t3-td-menu-label">{item.label}</span>
            {item.id === target.id && <Check aria-hidden="true" className="t3-td-menu-check" />}
          </button>
        ))
      }
    />
  );
}

function TargetIcon({ id }: { id: OpenInTarget["id"] }) {
  return id === "github" ? <GithubIcon className="t3-td-brand" /> : <Globe aria-hidden="true" />;
}

/** The branch as T3 Code's select row; nap does not switch branches, so its menu does not offer to. */
function BranchRow({
  branch,
  baseLabel,
  onCompare,
  onChangeBase,
}: {
  branch: string;
  baseLabel: string | undefined;
  /** Absent before there is a sandbox to compare in. */
  onCompare?: (() => void) | undefined;
  /** Present before a session starts, while its base branch is still the composer's to choose. */
  onChangeBase?: (() => void) | undefined;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const [copyError, setCopyError] = useState<string>();
  return (
    <div ref={anchor} className="t3-td-anchor">
      <button
        type="button"
        className="t3-td-row"
        data-select=""
        aria-label={`Branch ${branch}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="t3-td-select-label">
          <GitBranch aria-hidden="true" />
          <span className="t3-td-label">{branch}</span>
        </span>
        <span className="t3-td-select-icon">
          <ChevronDown aria-hidden="true" />
        </span>
      </button>
      <DetailsMenu
        id={menuId}
        label="Branch"
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked="true"
          onClick={() => setOpen(false)}
        >
          <GitBranch aria-hidden="true" />
          <span className="t3-td-menu-label">{branch}</span>
          <Check aria-hidden="true" className="t3-td-menu-check" />
        </button>
        {onCompare && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCompare();
            }}
          >
            <GitCompareArrows aria-hidden="true" />
            <span className="t3-td-menu-label">
              {baseLabel ? `Compare with ${baseLabel}` : "View changes"}
            </span>
          </button>
        )}
        {onChangeBase && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onChangeBase();
            }}
          >
            <GitBranch aria-hidden="true" />
            <span className="t3-td-menu-label">Change base branch</span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={async () => {
            setOpen(false);
            setCopyError(undefined);
            const failure = "Could not copy the branch name. Copy it from the branch row.";
            if (!navigator.clipboard) {
              setCopyError(failure);
              return;
            }
            try {
              await navigator.clipboard.writeText(branch);
            } catch {
              setCopyError(failure);
            }
          }}
        >
          <Copy aria-hidden="true" />
          <span className="t3-td-menu-label">Copy branch name</span>
        </button>
      </DetailsMenu>
      {copyError && (
        <p role="alert" className="t3-td-error">
          {copyError}
        </p>
      )}
    </div>
  );
}

function GitActionsRow({
  action,
  publishLabel,
  pullRequestUrl,
  onPublish,
  onOpenPullRequests,
  onCheckPublication,
}: {
  action: ReturnType<typeof quickAction>;
  publishLabel: string | null;
  pullRequestUrl: string | null;
  onPublish: () => void;
  /** Absent before a session starts: there is no project for the panel to list them for. */
  onOpenPullRequests?: (() => void) | undefined;
  onCheckPublication?: (() => void) | undefined;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  const hintId = useId();
  const primary =
    action.kind === "progress" ? (
      <button type="button" className="t3-td-split-primary" disabled aria-busy="true">
        <LoaderCircle aria-hidden="true" className="t3-td-spin" />
        <span className="t3-td-label">{action.label}</span>
      </button>
    ) : (
      <button
        type="button"
        className="t3-td-split-primary"
        aria-disabled={action.kind === "hint" || undefined}
        title={action.kind === "hint" ? action.hint : undefined}
        aria-describedby={action.kind === "hint" && hintOpen ? hintId : undefined}
        onClick={() => {
          if (action.kind === "hint") setHintOpen(true);
          if (action.kind === "publish") onPublish();
          if (action.kind === "open") window.open(action.url, "_blank", "noopener,noreferrer");
        }}
      >
        <GithubIcon className="t3-td-brand" />
        <span className="t3-td-label">{action.label}</span>
      </button>
    );
  return (
    <>
      <SplitRow
        label="Git actions"
        busy={action.kind === "progress"}
        primary={primary}
        menuLabel="Git action options"
        menuEmpty={publishLabel === null && pullRequestUrl === null && !onOpenPullRequests}
        menu={(close) => (
          <>
            {publishLabel !== null && action.kind !== "progress" && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onPublish();
                }}
              >
                <GithubIcon className="t3-td-brand" />
                <span className="t3-td-menu-label">{publishLabel}</span>
              </button>
            )}
            {action.kind === "progress" && onCheckPublication && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onCheckPublication();
                }}
              >
                <GitCompareArrows aria-hidden="true" />
                <span className="t3-td-menu-label">Check publication status</span>
              </button>
            )}
            {pullRequestUrl !== null && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  window.open(pullRequestUrl, "_blank", "noopener,noreferrer");
                }}
              >
                <GitPullRequest aria-hidden="true" />
                <span className="t3-td-menu-label">View PR</span>
              </button>
            )}
            {onOpenPullRequests && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onOpenPullRequests();
                }}
              >
                <GitCompareArrows aria-hidden="true" />
                <span className="t3-td-menu-label">Pull requests</span>
              </button>
            )}
          </>
        )}
      />
      {action.kind === "hint" && hintOpen && (
        <p id={hintId} role="status" className="t3-td-note">
          {action.hint}
        </p>
      )}
    </>
  );
}

/** T3 Code's split control: a primary action and a chevron, one rounded group with a rule between. */
function SplitRow({
  label,
  primary,
  menuLabel,
  menu,
  busy = false,
  menuEmpty = false,
}: {
  label: string;
  primary: ReactNode;
  menuLabel: string;
  menu: (close: () => void) => ReactNode;
  busy?: boolean;
  /** Keeps the chevron, as T3 Code does, but disabled rather than opening nothing. */
  menuEmpty?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: one control split in two, not a form section; a fieldset brings its own border and form semantics
    <div
      ref={anchor}
      role="group"
      aria-label={label}
      className="t3-td-split t3-td-anchor"
      data-busy={busy || undefined}
      data-open={open || undefined}
    >
      {primary}
      <span aria-hidden="true" className="t3-td-split-rule" />
      <button
        type="button"
        className="t3-td-split-secondary"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={menuEmpty}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <DetailsMenu
        id={menuId}
        label={menuLabel}
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
      >
        {menu(() => setOpen(false))}
      </DetailsMenu>
    </div>
  );
}

/**
 * A row's menu, as wide as the row and opening below it.
 *
 * Portalled to the body and placed against the row's box: the card scrolls and is glass, and
 * both an overflow and a backdrop filter would clip a menu drawn inside it.
 */
function DetailsMenu({
  id,
  label,
  anchor,
  open,
  onClose,
  children,
}: {
  id: string;
  label: string;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number }>();

  useLayoutEffect(() => {
    if (!open) return;
    const box = anchor.current?.getBoundingClientRect();
    if (box) setPlace({ top: box.bottom + 4, left: box.left, width: box.width });
    menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (menu.current?.contains(event.target) || anchor.current?.contains(event.target)) return;
      onClose();
    };
    // The row it hangs from moves with the card, so the menu closes rather than float away.
    const away = (event: Event) => {
      if (
        event.type === "scroll" &&
        (!(event.target instanceof Node) || !event.target.contains(anchor.current))
      )
        return;
      onClose();
    };
    document.addEventListener("pointerdown", press);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("pointerdown", press);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      anchor.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      return;
    }
    if (event.key === "Tab") {
      anchor.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      onClose();
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    const index =
      document.activeElement instanceof HTMLButtonElement
        ? items.indexOf(document.activeElement)
        : -1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return createPortal(
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      data-open="true"
      data-thread-details-menu=""
      className="t3-td-menu composer-surface nap-float"
      style={place}
      onKeyDown={keys}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("button:not([disabled])"))
          anchor.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function ScriptsDialog({
  open,
  environment,
  onClose,
  onSave,
}: {
  open: boolean;
  environment: RepositoryEnvironment;
  onClose: () => void;
  onSave: (
    environment: RepositoryEnvironment,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setMessage(undefined);
      element.showModal?.();
      element.focus();
    }
    if (!open && element.open) element.close?.();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      tabIndex={-1}
      closedby="any"
      onClose={onClose}
      className="nap-dialog m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto dialog-glass rounded-[18px] border p-0 text-ink outline-none"
    >
      {open && (
        <>
          <div className="flex items-start gap-4 px-6 pt-6 pb-2">
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 id={titleId} className="text-[15px] font-medium text-ink">
                Project scripts
              </h2>
              <p className="mt-0.5 text-[13px] text-muted">
                The commands that set up this repository and serve its preview.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close project scripts"
              onClick={onClose}
              className="-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink"
            >
              <CloseIcon className="size-4" />
            </button>
          </div>
          <div className="px-6 pb-6">
            <EnvironmentSettings
              environment={environment}
              busy={busy}
              defaultExpanded
              onSave={async (next) => {
                setBusy(true);
                const result = await onSave(next);
                setBusy(false);
                setMessage(
                  result.ok
                    ? {
                        error: false,
                        text: "Saved. Put the project away and reopen it to apply these scripts.",
                      }
                    : { error: true, text: result.error },
                );
                return result.ok;
              }}
            />
            {message && (
              <p
                role={message.error ? "alert" : "status"}
                className={`mt-4 text-xs ${message.error ? "text-danger" : "text-muted"}`}
              >
                {message.text}
              </p>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

/**
 * The project's repository and jobs, for the card alone.
 *
 * Its own request rather than the pull requests panel's state: that panel is mounted only while
 * its tab is open, and the card is open far more often than the tab. A failure, or a guest the
 * server will not answer, reads as no repository — the card then shows what every project has.
 */
function useProjectGitHub(
  projectId: string,
  revision: number,
  fetchJson: FetchJson,
  baseUrl: string,
  enabled: boolean,
) {
  const [state, setState] = useState<ProjectGitHub | null>();
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/projects/${projectId}/github`,
      ProjectGitHubSchema,
    );
    if (request === latest.current)
      setState((current) => (result.ok ? result.value : (current ?? null)));
    return { ...result, applied: result.ok && request === latest.current };
  }, [projectId, fetchJson, baseUrl]);
  useEffect(() => {
    void revision;
    if (!enabled) return;
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload, revision, enabled]);
  return { state, reload };
}

type BranchComparison = {
  branch: string;
  baseLabel: string;
  totals: { additions: number; deletions: number };
  partial: boolean;
};

/** The branch the sandbox has checked out, and how far it is from its base. */
function useBranchComparison(
  sessionId: string | undefined,
  baseBranch: string | undefined,
  revision: number,
  fetchJson: FetchJson,
  baseUrl: string,
  sandboxId: string | null | undefined,
): BranchComparison | undefined {
  const [comparison, setComparison] = useState<BranchComparison>();
  useEffect(() => {
    void revision;
    void sandboxId;
    setComparison(undefined);
    if (sessionId === undefined) return;
    let cancelled = false;
    const query = new URLSearchParams({ scope: "branch" });
    if (baseBranch) query.set("base", baseBranch);
    void githubRequest(
      fetchJson,
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/changes?${query}`,
      GitComparisonSchema,
    ).then((result) => {
      if (cancelled || !result.ok || !result.value.ready) return;
      setComparison({
        branch: result.value.branch,
        baseLabel: result.value.baseLabel,
        totals: diffTotals(result.value.files),
        partial: result.value.truncated || result.value.files.some((file) => file.truncated),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, baseBranch, revision, fetchJson, baseUrl, sandboxId]);
  return comparison;
}
