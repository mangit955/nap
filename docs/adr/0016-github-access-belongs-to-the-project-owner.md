# ADR-0016: GitHub access belongs to the project owner

**Status:** Accepted, 2026-10-19

## Context

Nap projects have one user owner and at most one active sandbox. A cloud repository connection
must survive worker restarts without borrowing the operator's Git credentials. Model providers
and sign-in identities have different authorization lifetimes from repository installations.

## Decision

A separate GitHub App grants platform repository access. Single-use owner-bound state and a
temporary user authorization verify installation authority. Installation ownership remains with
the same Nap user across disconnects. Current installation status, selected repository ID and
that GitHub user's write authority gate repository operations. Numeric repository identity
survives renames; names alone cannot grant access.

The API owns GitHub protocol and a small server Git broker. Installation tokens are narrowed by
repository and permission. Bare Git processes exchange bundles with the sandbox and keep tokens
out of agent-readable environments, prompts, URLs and Git configuration. The shared
`RepositoryWorkspace` port gives the runtime source, branch-preparation and completion hooks;
the runtime has no GitHub SDK or provider-auth dependency.

Imports, publication and approved feedback use the existing durable session queue. Snapshots
carry complete Git refs plus exact HEAD identity. Setup must leave the tree clean; snapshot
restore does not overwrite work with a fresh remote clone. New jobs have dedicated branches.
Only verified checkpoints can publish draft PRs. Persisted pushed SHAs and exact PR lookup make
retries recover successful remote work without creating a second PR. GitHub remains responsible
for branch protections and human merge review.

Signed webhooks enter a durable inbox. Bounded reconciliation repairs missed PR deliveries.
They update product state and pending feedback, not model instructions. Only the connected
GitHub user's explicit `/nap` commands and failed checks can propose follow-ups. The Nap owner
approves each through ordinary model, rate and quota admission. Approval rechecks the current
head and feedback version. Review bodies and other commenters are status data in this release.

## Consequences

Existing template projects and the current coding provider remain available. This adds no shared
organization hierarchy, general Git proxy, parallel VM platform, auto-merge or credential store.
The broker's temporary disk usage is not bounded by the final bundle-size limit. Repository
setup and verification use the existing sandbox toolchain; arbitrary languages, private package
credentials, LFS and submodules require separate support. Registration and operational details
are in [GitHub integration](../github-integration.md).

Migration 0009 is additive, but old workers cannot interpret `publish` queue requests. Roll out
the new API, workers and reaper together before the UI. GitHub installation remains a manual
operator step. Local Git, Postgres and simulated API tests establish the implementation's state
transitions; they do not establish live App configuration or provider behavior.
