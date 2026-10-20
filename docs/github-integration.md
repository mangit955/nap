# GitHub repository integration

Nap connects a GitHub App installation to the signed-in Nap project owner. In Settings →
Connections, choose Connect GitHub, select a personal account or organization and the repositories
GitHub should grant. GitHub then asks for separate user authorization so Nap can verify who may
bind that installation. Signing in with GitHub alone does not grant repository access.

On New session, the composer's + menu contains Upload media and Repositories. Repositories
opens an inline `@repos:` autocomplete across every authorized installation and repository page,
including repositories never imported into Nap. The connected GitHub user must retain write,
maintain or admin access. Selecting a repository closes the list and updates the source chip;
switching it preserves the prompt, model and media. Source settings holds the branch, optional
setup/preview commands and draft-PR publication choice.

Sending creates an isolated project with its first queued task atomically. Workspace preparation
precedes that task. A repository without a task offers Open workspace, which does not call a model.
An owner-scoped operation ID and receipt recover a lost response without creating a second project
or task. Pending starts retain their original request until the server resolves it. Existing
workspaces keep their repository binding; start a new session to use another codebase.

Authorization stays in Settings → Connections. Before going there from the picker, Nap saves an
owner-bound draft in IndexedDB, including prepared media. The callback carries only its opaque ID
and returns to the allowlisted dashboard path. Success, cancellation and failure restore the draft.
Drafts expire after seven days and are removed on sign-out. A storage failure prevents leaving the
composer. Drafts are local to that browser; navigation metadata is stored on the server.

## Session organization

The shared dashboard/workspace sidebar groups sessions into Pinned, Active, Snoozed and Done.
Archived sessions are available through Filter sessions. Repository and workspace filters and
title search retain the selected session under Current session when it falls outside the result.
Pinning, manual order, read state, Done, archive and snooze survive refresh and other devices.
Revision checks reject stale changes and Undo instead of overwriting a newer action. Drag within
a section or use Move up/down; keyboard arrows and Home/End navigate rows.

Done and archive apply to idle work. Queued/working sessions cannot be parked, deleted or put away
through the row menu. New requests supersede an older Done/archive timestamp and make the row
active again. Snooze ends at its wake time without scheduling a task. None of these organization
actions stops a sandbox or merges a PR; Put away workspace and confirmed Delete project retain
their existing lifecycle behavior. A completed turn does not automatically mark a session Done.

Activity comes from queued/leased requests and terminal events; sandbox presence is displayed
separately. Read markers acknowledge only observed activity. Summaries include repository, branch,
PR state and pending feedback without opening transcripts or calling GitHub for each row. The list
loads pages of 100 sessions, refreshes every ten seconds while visible, and refreshes on focus and
same-browser navigation updates. Follow-up drafts show a local Draft marker.

The session list keeps scrolling with its scrollbar hidden; the account footer stays outside it.
Sidebar width/collapse preferences are saved locally. Small screens use the existing modal drawer.
Bulk actions, cross-section drag, message search, automatic settling, title regeneration and
existing-PR import remain deferred as specified in `docs/nap-navigation-plan.html`.

## Register the deployment's GitHub App

This checkout does not register an App or deploy anything. Registration requires a GitHub account
that will own the App, a public HTTPS API URL, and the web origin. Use your deployment's secret
manager to enter credentials. Do not commit a PEM file, put tokens in repository URLs, or enter
credentials in a Nap conversation.

1. Generate the registration settings, which contain no credentials:

   ```bash
   bun run github:manifest --api-url=https://api.example.com --web-origin=https://nap.example.com
   ```

   This prints the manifest-shaped settings for reference. Nap does not implement GitHub's
   manifest-code exchange. Register manually in GitHub Settings → Developer settings → GitHub
   Apps → New GitHub App using the fields below.

2. Set the homepage to the web origin. Set the user authorization callback to
   `https://api.example.com/github/callback`, setup URL to
   `https://api.example.com/github/setup`, and webhook URL to
   `https://api.example.com/github/webhook`. Enable redirect on installation updates: after an
   owner changes the repository selection under Manage access, GitHub sends them back through the
   setup URL, which returns them to Connections without binding or granting anything. Leave
   **Request user authorization during installation** off. Nap's setup callback starts the
   separate authorization step with fresh owner-bound state. Allow installation on **Any account**
   for a cloud deployment serving other users. A private App is suitable only for an installation
   restricted to its owning account.

3. Generate a webhook secret, set the same secret in GitHub and the server secret manager, and
   enable webhooks. Request these repository permissions:

   | Permission | Access | Used for |
   | --- | --- | --- |
   | Metadata | Read | Repository identity, selection and collaborator authority |
   | Contents | Read and write | History import, branches and non-forced Git push |
   | Pull requests | Read and write | Draft PR creation, comments and review status |
   | Checks | Read | CI check conclusions |
   | Commit statuses | Read | Legacy CI status contexts |

   Subscribe to repository, pull request, pull request review, pull request review comment,
   issue comment, check run, check suite and status events. GitHub supplies installation and
   installation repository selection events to Apps. No organization, account, workflow,
   administration or merge permission is needed.

4. Generate an RSA private key and client secret in the App settings. Configure all six variables
   on the API, worker and reaper, along with the existing `NAP_API_URL` and `NAP_WEB_ORIGIN`:

   | Variable | Value |
   | --- | --- |
   | `NAP_GITHUB_APP_ID` | Numeric App ID |
   | `NAP_GITHUB_APP_SLUG` | Slug from `github.com/apps/<slug>` |
   | `NAP_GITHUB_CLIENT_ID` | App client ID |
   | `NAP_GITHUB_CLIENT_SECRET` | App client secret |
   | `NAP_GITHUB_PRIVATE_KEY` | Entire RSA PEM, with real newlines or literal `\n` separators |
   | `NAP_GITHUB_WEBHOOK_SECRET` | Matching random signing secret, at least 20 characters |

   Omit all six to disable new connections. Partial configuration fails at boot. The old
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` variables belong to Nap sign-in and remain separate.
   Model API keys also remain separate. No Claude or Codex subscription authentication is added.

5. Run `bun run db:migrate`. Migration 0009 adds installations, callback states, repository
   bindings, repository jobs, feedback and a webhook inbox; 0010 records when each job was created,
   which is how the newest job on a pull request is told apart from earlier ones. Migrations 0011
   and 0012 add start receipts, callback draft IDs, navigation metadata and a queue-summary index.
   Apply migrations before deploying the new API/web. Stop old workers before enabling the
   new UI: old workers do not understand queue requests with kind `publish`. Deploy API, workers,
   reaper and web from the same version. Run one reaper with the existing leader lease. Its GitHub
   sweep runs every 15 seconds separately from sandbox cleanup; each sweep processes new webhook
   deliveries, and rereads an open pull request only when nothing has refreshed it for five minutes.

6. Sign into a permanent Nap account and connect from Settings → Connections. Use GitHub's
   selected-repositories option. On the Connections page, Manage access opens GitHub settings;
   Reconnect revalidates authority; Disconnect revokes Nap's binding without uninstalling the App
   or deleting saved projects. An installation remains reserved to its original Nap owner across
   disconnects. There is no organization sharing or installation-transfer workflow in this release.

## Repository environments and snapshots

The workspace uses Nap's existing Linux sandbox at `/home/user/app`. Choose a dependency command
appropriate to the repository, for example `bun install --frozen-lockfile` for a committed Bun
lockfile or `npm ci` for npm. A blank setup command skips installation. Setup has a ten-minute
deadline and must leave Git clean. Keep generated dependencies and build output in `.gitignore`;
do not use setup to rewrite tracked lockfiles. Setup errors keep the saved snapshot intact.

Optionally set a development command and a port together. The server must listen on `0.0.0.0`.
Without them, the workspace supports chat and files and says no preview is configured. Edit the
environment in the project's GitHub panel; it applies on the next workspace start. Close and
reopen an active workspace to apply a change.

The first open imports full branch and tag history. Later opens restore Nap's saved Git bundle,
including its exact branch or detached HEAD, then run setup again. A missing or unreadable imported
snapshot fails visibly instead of replacing saved work with the remote repository. Nap does not
fetch and reset over local work. Branch history stays in Git bundles; dependencies are rebuilt.
Normal sandbox capacity, idle teardown, cancellation and durable queue rules apply. The capacity
slot is renewed from the moment it is reserved until the workspace is ready, so a first download
that waits for a transfer slot, or a long setup, does not lose it.

## Jobs, pull requests and follow-ups

A new job gets `nap/<job-id>` from the workspace's current commit. It targets the branch chosen at
import. This preserves the current workspace, so a second job may include earlier unmerged work.
Nap does not automatically rebase, merge, force-push or update the upstream base. Stopping a job
keeps its uncommitted edits in the workspace. The next message continues them as a new job on the
same branch, and that branch's pull request if it has one. Edits made outside any job branch move
onto the new job's branch unchanged. Approved PR feedback is the exception: it refuses to start
while unfinished edits from other work are present, so they cannot reach the wrong pull request.

Existing verification checks the configured package scripts. A verified commit can be pushed and
proposed as a draft PR, automatically if selected at import. The panel records the base/head,
successful pushed SHA, PR link, checks and reviews. Publication retries reuse the branch and find
the exact repository/head/base PR before creating one. A failed PR request retains a successful
push; a lost creation response is found by exact head and base lookup before retry. Once the
verified commit is pushed and the job's branch on GitHub still points at it, a retry needs nothing
from the workspace, so later work does not block it. Before that push, a verified job publishes only
while the workspace (or, with no live workspace, the latest saved snapshot) is still at its verified
commit. Cancellation does not automatically publish, even when verification has just passed; publish
it before sending another message, or publish the later job, whose branch contains the earlier
commits. Use Check or retry publication after an interrupted worker. Normal GitHub branch
protections apply.

Follow-up policy is **owner approval**. Webhooks never start an LLM job or spend a user's model
budget. Failed checks and `/nap <instruction>` comments from the connected GitHub user become
pending feedback. Nap verifies that user's stable GitHub ID and current write authority. Other
comments and review bodies are not instructions; review decisions appear as status. The owner must
click Ask nap to address feedback. Nap rereads the PR, checks, comment version and current authority
before admission. Deleted or edited comments, closed PRs and a remote head changed by someone else
cannot queue stale instructions. Each PR refresh removes stale pending feedback and keeps approved
requests for retry identity. Approved feedback uses the linked branch/PR and the existing rate,
credential, quota, repair and Stop controls. If the workspace has moved to other work, feedback
refuses to reset it.

Webhook signatures cover the raw request body. The inbox deduplicates delivery IDs and fences worker
leases; transient failures retry up to five attempts. Each sweep handles at most ten deliveries,
plus a PR refresh of at most ten open pull requests that nothing has refreshed for five minutes. A
delivery refreshes up to five open pull requests in its repository, the one it names first; a closed
or merged one is read only when the delivery names it, which is how a reopen is noticed. Deliveries
in one sweep that name the same pull request share one refresh, and only the newest job on a pull
request is refreshed; earlier jobs learn its closed or merged state from it. Each delivery is
acknowledged as soon as its own refreshes finish, and the leases of those still waiting are renewed
before each refresh, so a slow sweep does not redeliver finished work. GitHub API collections stop
at 1,000 records and fail visibly rather than infer a passing status from incomplete data. Missed
installation revocations are also checked before each repository operation. Repository renames
recover by numeric ID in the App's current selected repositories, without following authenticated
redirects. Only a 404 from GitHub's installation endpoint marks an installation removed. Rate
limiting (a 403 or 429 carrying GitHub's rate-limit headers) and failures of the App's own
credentials are reported as temporary and change no stored state.

## Credential boundary

App keys and client secrets stay in server configuration. Callback state is single-use, expires
after ten minutes and is tied to the Nap owner and stage. The callback verifies the supplied
installation against GitHub's user-authorized installation list before binding it. The temporary
user token is used only for that validation and then revoked; Nap does not store it or author PRs
as that user. Installation tokens are cached only in server memory, narrowed to one repository
and needed permissions, and refreshed before expiry or once after an HTTP 401.

Git runs in a temporary bare repository on the server, with an isolated environment and no global
credential helpers, hooks or worktree execution. The GitHub header exists only in the Git child
process environment, never a URL or persisted config. The sandbox receives a credential-free Git
bundle. Neither prompts nor tool logs receive GitHub tokens. Git errors are sanitized. This
implementation does not reuse `gh login`, `GH_TOKEN`, host SSH keys or a user's local credentials.
The server still requires normal process isolation from untrusted workloads on that host.

## Current limits and verification

GitHub.com is supported. Optional personal PR authorship, GitHub Enterprise Server, shared team
ownership, repository indexing and automatic follow-ups are later work. Git LFS payloads, submodule
checkout, private package registry authentication and arbitrary repository secret injection are
not implemented. The App does not request workflow-write permission, so GitHub may reject a push
that changes `.github/workflows`. Git operations have a two-minute deadline and bundles are capped at 64 MiB.
Each transfer may use at most 256 MiB of server temporary disk, checked while Git runs and after
each step; at most two transfers run at once per process. A repository over either limit is
refused as too large. Raising the bundle cap needs a matching review of those bounds.

The repository picker checks the connected user's permission on every selected repository, one at
a time, at about two GitHub API calls each. On an installation granting hundreds of repositories it
is slow, and repeated loads spend the installation's hourly API allowance (5,000 calls for most
installations); when that runs out, every operation on the installation is refused as temporarily
unavailable until it resets. Prefer **Only
select repositories**. Import checks only the repository being imported.

The verifier retains Nap's Bun/package-script checks and optional preview probe. There is no
language-specific verifier for arbitrary non-JavaScript repositories. Absent checks retain the
existing verifier semantics, so inspect the reported checks and review draft PRs before merging.
CI feedback includes failing check names, not authenticated CI log downloads. External branch
updates are detected but not imported automatically. Expired callback rows and processed inbox
payloads currently follow database retention and backups; no separate retention sweeper is added.

Automated coverage includes real local Git clone/import, complete refs and HEAD restoration,
idempotent push and divergence refusal; real Postgres owner isolation, atomic import/approval and
inbox retry; controlled GitHub HTTP for callback authority, token refresh, PR retries, revocation,
rename and feedback. A composed test drives the real API/queue/runtime with simulated sandbox and
GitHub transports. Component tests (jsdom) exercise the Connections page, import, PR publication
retry and feedback approval; no browser session was recorded for this change.
No registered GitHub App, live GitHub push/webhook or E2B import was exercised in this checkout.

For live acceptance, use a disposable repository and selected-only installation: connect, import,
run a task with a real check, inspect the draft PR, close/reopen the workspace, add an owner `/nap`
comment and approve it, then remove repository access and confirm new work/publication is refused.
Inspect GitHub's webhook deliveries and the panel's errors. Do this only after configuring the
deployment above; the automated tests do not establish live GitHub or E2B behavior.

The protocol follows GitHub's current documentation for
[installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user),
[setup callbacks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
and [webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
The user flow is adapted from [Devin's documented GitHub connection](https://docs.devin.ai/integrations/gh).
No Devin or T3 source code is copied.
