# ADR-0001 — NapBench splits into a pure package and an app

**Status:** Accepted — 2026-08-14

## Context

NapBench evaluates Nap by running it: it composes a `Runtime` out of a real `E2BSandboxManager`
and a real model, sends a task's prompts through it, and then judges what came out. Judging means
two things that pull in opposite directions — running commands inside the sandbox, and driving a
real browser against the preview URL from outside it.

Three facts about this repository constrain where that code can live.

The dependency direction is a table, not a habit. `test/architecture.ts` enumerates what every
workspace package may depend on, and a new package fails the suite until it appears there. So
placement is a decision somebody has to make deliberately; there is no default to fall into. Apps
are the exception — they are `"*"`, because composing everything is what an app is for.

The browser is already spoken for. `EXCLUSIVE_EXTERNALS` assigns `puppeteer-core` to
`@nap/capture`, on the grounds that nothing above the `PageCapture` interface may know a thumbnail
is made by rendering a page. A second browser driver arriving with no owner would quietly undo
that reasoning.

The production image is the whole workspace. `Dockerfile` does `COPY . .` and one workspace-wide
`bun install`, so a dependency added anywhere is a dependency the API image carries. There is no
per-app pruning to hide behind.

Against that, the evaluation logic worth having is almost entirely pure: a task specification, a
check result, a score, a gate, a report, a comparison. None of it needs a browser or a sandbox, and
all of it is the part that must be trustworthy — a scoring bug is invisible, where a broken browser
adapter announces itself.

## Decision

Two units.

**`packages/bench` (`@nap/bench`)** — the pure core, depending on no workspace package but
`@nap/shared`.
The task schema, the check-result model, the `BrowserSession` port, scoring, the gate ladder,
metric derivation from an event stream, report serialisation, comparison, and the benchmark task
definitions themselves.

**`apps/napbench`** — the imperative shell. Composes the `Runtime`, holds the E2B and OpenRouter
wiring, executes command checks through `SandboxManager.exec`, implements `BrowserSession` against
Playwright, writes screenshots and reports, and is the CLI.

`playwright-core` is added to `EXCLUSIVE_EXTERNALS` in `test/architecture.ts`, owned by
`@nap/napbench`.

This mirrors a split the repository already made once: `packages/runtime/src/harness.ts` holds the
decisions — argument parsing, event formatting, the rule that decides whether a run spends money —
and is typechecked and tested, while `packages/runtime/scripts/harness.ts` is credentials, real
components and output. NapBench is that same shape one level up, and large enough to deserve the
boundary as a package rather than a file.

## Consequences

The rule "production must not depend on Playwright" is enforced by a test rather than by memory.
Adding `playwright-core` to any other package fails `bun run test` with a sentence explaining why,
in exactly the way `e2b` and `@anthropic-ai/sdk` already do.

Scoring, gates, metrics, serialisation and comparison are unit-testable in the `unit` project with
no browser, no sandbox and no network — the free, deterministic loop the repo's test strategy is
built around.

The `BrowserSession` port has to exist and has to be genuinely narrow, because it is the seam the
two halves meet at. That is a cost — it is one more interface to keep honest — and it is also what
makes every browser action and assertion testable against a scripted fake. See ADR-0003's reasoning
about ports for the same trade made elsewhere.

`playwright-core`'s JavaScript still lands in the API image, since the install is workspace-wide.
That is a couple of megabytes of code nothing imports, and no browser, because `--ignore-scripts`
suppresses the download. Accepted rather than solved: the alternatives are pruning devDependencies
in the image, which `Dockerfile` already explains is dangerous here, or a second lockfile.

Two `package.json` and two `tsconfig.json` to maintain instead of one, and both must be brought
inside `bun run typecheck` and `bun run lint` deliberately — a new directory is not automatically
inside either.

### `@nap/bench` devDepends on siblings, and that is on purpose

The evaluation runner lives in `@nap/bench` and is written against ports alone, which is what makes
it unit-testable. Testing it needs the in-memory `SandboxManager` and `EventStore`, and those live
in `@nap/sandbox` and `@nap/db` — so both appear in `@nap/bench`'s **devDependencies** while its
runtime `dependencies` stay `@nap/shared` alone.

This is recorded rather than left to be discovered, because `test/architecture.test.ts` reads only
`dependencies`, so the arrangement passes the check partly by not being looked at. It is the same
thing `@nap/runtime` already does with `@nap/agent`, and it is what `CLAUDE.md` means when it calls
the fakes in `packages/*/src/testing/` production-quality code that every downstream package's tests
depend on. The boundary that matters — what `@nap/bench` needs at runtime, and therefore what a
consumer of it pulls in — is unchanged.

The line to hold: a *runtime* dependency on a **workspace package** other than `@nap/shared` would
break this ADR. A devDependency on a sibling's published fake does not.

Third-party dependencies were never the subject, and the first one arrived immediately: the pure
core validates every task it loads and every report it reads back, so it depends on `zod` exactly
as `@nap/shared` does, and `CLAUDE.md` requires it at each of those boundaries. The guarding test
filters to `@nap/`-prefixed dependencies for that reason. What "pure" means here is *no
infrastructure* — no sandbox, no browser, no filesystem, no model — rather than no dependencies.

## Alternatives considered

**One `packages/eval` above `runtime`.** Fewer moving parts and a single entry in the `ALLOWED`
table. Rejected because the scoring engine would then share a unit with the E2B and Playwright
drivers, and `playwright-core` would sit in `packages/`, where the exclusivity rule protecting
`@nap/capture` starts to look arbitrary.

**One `apps/napbench`.** Simplest of all: apps are already `"*"`, so `test/architecture.ts` needs
no change whatsoever. Rejected precisely because of that — nothing would stop the scoring logic
from reaching into the `Runtime` later, and the boundary would exist only as an intention.
