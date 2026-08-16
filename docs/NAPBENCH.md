# NapBench

An evaluation harness for Nap's agent. It runs the real product end to end against a fixed set of
tasks and produces, for each one, a score, a report and the trajectory the score was derived from.

The point is not the number. It is that the number is **explainable** — every score decomposes into
individual checks — and that it is **withheld** when it would be misleading: an agent that refused
and an E2B outage both produce no score, and NapBench keeps them apart, because a benchmark that
quietly attributes infrastructure noise to a model is worse than no benchmark.

Vocabulary is in [`CONTEXT.md`](../CONTEXT.md). The decisions that were expensive to reverse are in
[`docs/adr/0001`](adr/0001-napbench-splits-into-a-pure-package-and-an-app.md) (the two units),
[`0002`](adr/0002-absent-scoring-categories-renormalise.md) (renormalisation, error attribution,
comparison) and [`0003`](adr/0003-metrics-derive-from-the-existing-event-stream.md) (metrics come
from the existing event stream).

---

## Running it

```bash
bun run napbench landing-page              # one task, on fakes — free, offline, scores meaningless
bun run napbench --suite=all               # the four benchmark tasks, serially, same fakes
bun run napbench --suite=smoke             # the tracer task alone: "is the machinery joined up?"

bun run napbench --real --suite=all        # real E2B, a real model, a real browser. Spends money.
bun run napbench --real todo-crud --model=anthropic/claude-opus-5 --effort=high

bun run napbench --baseline=<ref> --candidate=<ref>   # what moved between two finished runs
```

**Fakes by default; `--real` is the only way to spend.** A dry run drives every stage — seeding,
turns, the preview probe, the checks, the report and trajectory files, the suite aggregation —
against a scripted model, an in-memory sandbox and a scripted browser. It costs nothing and needs
no network. Its scores mean nothing: the scripted model does not attempt the task, so what a dry run
proves is that the apparatus works, not that an agent does.

Unknown flags are refused rather than ignored. A forgiving parser would let `--budget-tokens` be
mistyped on a paid run and silently use the default.

| Flag | Meaning |
|---|---|
| `--suite=<name>` | Run a named suite serially. `all` (the four tasks) or `smoke` (the tracer). |
| `--real` | Real E2B, real model, real Chrome. Also requires `NAP_CHROME_PATH`. |
| `--platform=<name>` | `openrouter` (default), `anthropic` or `bedrock` — which account pays. |
| `--model=<id>` | Model for a real run. Also what the cost estimate is priced against. |
| `--effort=<level>` | `low` … `max`. |
| `--max-steps=<n>` | Model calls allowed within one turn. |
| `--budget-tokens=<n>` | Context budget per turn. |
| `--keep` | Leave each sandbox running instead of destroying it. Billed until destroyed. |
| `--baseline=` / `--candidate=` | Compare two finished runs. Reads reports; runs nothing. |

Exit code answers *did the benchmark run*, not *did the agent do well*: a low score exits 0, and a
run that produced no score at all exits 1.

Everything a run produces — reports, trajectories, screenshots and their sidecars — is written to
`napbench-results/`, which is gitignored. Running the benchmark never dirties the tree.

---

## Architecture

Two units, per [ADR-0001](adr/0001-napbench-splits-into-a-pure-package-and-an-app.md).

**`packages/bench`** is the pure half: tasks, checks, gates, scoring, metrics, reports,
trajectories, the CLI's argument parsing, suite aggregation and comparison. Its only runtime
workspace dependency is `@nap/shared`. It is written against ports — `Runtime`, `SandboxManager`,
`SessionStore`, `EventStore`, `BrowserSession` — which is what lets the whole evaluation be driven
by a unit test with no network, no model and no database.

**`apps/napbench`** is the composition root: the Playwright adapter, the real sandbox manager, the
real model provider, everything that touches a filesystem, and the CLI script. `playwright-core` is
an *exclusive external* owned by this app, enforced by `test/architecture.ts`, so the production API
can never depend on a browser driver.

A run never reimplements the agent loop. It calls the same `Runtime.runTurn` the product calls, and
reads the same event stream the product writes — see [ADR-0003](adr/0003-metrics-derive-from-the-existing-event-stream.md).
No event exists to serve evaluation, and none may.

### What one run does, in order

1. Create a fresh session with in-memory stores of its own. Isolation between runs is structural.
2. Seed any files the task declares, creating the sandbox first so the first turn *resumes* it.
3. Send each prompt through `Runtime.runTurn`, in order, stopping at the first that does not
   complete. A follow-up prompt is written against what the previous one was supposed to produce.
4. Confirm the preview actually serves, and disambiguate when it does not (below).
5. Run the task's checks: commands inside the sandbox, browser checks against the preview from the
   host, each in a browser session of its own.
6. Photograph the page each browser check and each audit left behind.
7. Ask the visual evaluator, which today always answers "not run".
8. Apply the gate ladder, score what is left, read the trajectory back out of the event store, and
   write the report and the trajectory beside each other.

---

## Adding a task

One declarative file under `packages/bench/src/tasks/`, then two lines to register it. Nothing in
the evaluator changes.

```ts
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

export const MY_TASK = defineTask({
  id: "my-task",
  name: "What it is measuring, in a sentence",
  // One turn each, in order. A second prompt is how "does the agent break what it already
  // built?" becomes expressible.
  prompts: ["Build X.", "Now add Y."],
  // Optional. The starting state for "debug this" and "modify this" tasks. Paths are relative
  // to the project root, and constrained to stay inside it.
  environment: { files: [{ path: "src/App.tsx", contents: "…" }] },
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  checks: [
    {
      id: "build",
      kind: "command",
      // Commands run wherever the sandbox drops you, so a task says where it means.
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      build: true,
      required: true,
    },
    {
      id: "typecheck",
      kind: "command",
      // The binary, not a package script: the template has no `lint` or `typecheck` script,
      // and a check that cannot pass on an untouched template measures the harness rather
      // than the agent. See docs/napbench-first-real-run.md — this cost a funded run to learn.
      command: `cd ${PROJECT_ROOT_PATH} && bunx tsc --noEmit`,
      category: "code",
    },
    {
      id: "shows-the-heading",
      kind: "browser",
      viewport: "mobile",
      steps: [
        { step: "navigate", path: "/" },
        { step: "expectVisible", selector: { by: "role", role: "heading", name: "Hello" } },
        { step: "expectNoConsoleErrors" },
      ],
    },
    {
      id: "is-accessible",
      kind: "accessibility",
      // Audited by axe against the rendered page. Findings at this grade or worse fail the
      // check; `serious` is the default and is the bar that separates applications rather
      // than failing all of them.
      failOn: "serious",
    },
  ],
});
```

**Three kinds of check.** `command` runs inside the sandbox and is judged on its exit code.
`browser` drives the running application through a sequence of steps. `accessibility` audits one
rendered page with axe and fails on findings at or above the grade the task sets — measured by an
established tool rather than by our judgement, which is why it is a kind of its own rather than an
assertion somebody writes by hand.

A fourth kind, `custom`, appears in the specification and was deliberately not built: a task is
data, validated as its module loads, and a custom check would be code that no schema can validate
and no sandbox can be handed. Adding a kind is a schema, a branch in the executor's dispatch and a
default category — which is what `accessibility` cost — so the union is the extension point.

**A task declaring a browser or accessibility check must declare a `preview`.** Both need an
address to point at, and the schema refuses a task without one: left to runtime, the checks would
be recorded as *failed* — "the application was not serving" — which reads as the agent having built
something that does not start when it is really a missing field.

The steps are `navigate`, `click`, `fill`, `press`, `reload`, `select` and `viewport`, and the
assertions are `expectText`, `expectNoText`, `expectVisible`, `expectCount`, `expectUrl`,
`expectUrlContains`, `expectAttribute`, `expectInputValue`, `expectNoHorizontalOverflow` and
`expectNoConsoleErrors`. Selectors are `{ by: "role", role, name? }`, `{ by: "label", text }`,
`{ by: "text", text }` or `{ by: "testId", id }`.

Then add it to `BENCH_TASKS` in `packages/bench/src/suite.ts`, and to a suite if it belongs in one.

`defineTask` validates at **import**, so a malformed task throws before a sandbox exists rather than
after one has been paid for. The schema is strict: a mistyped field name is refused rather than
ignored, because silently ignoring it produces a run that looks complete and measured something else.

Things worth knowing when writing one:

- **A check's category defaults from its kind and is overridable.** `bun run build` and
  `bunx tsc --noEmit` are both commands and only the first is functional. An accessibility audit
  defaults to `code` rather than `browser`: it needs a browser to run, but what it measures is
  the quality of the markup that was written, not whether the application behaves when driven.
- **Run your command against an untouched template before trusting it.** The template's scripts
  are `dev`, `build` and `preview` — there is no `lint` and no `typecheck`, so `bun run lint`
  fails on every run for every model while looking like a code-quality measurement. The guard is
  `apps/napbench/src/task-commands.integration.test.ts`.
- **`required: true`** fails the run outright regardless of the score. **`build: true`** does that
  *and* caps the overall score at 40, because an application that does not compile cannot be
  three-quarters good.
- **Selectors are values**, not browser selector strings. Checks written this way survive
  restyling and are implementable by the fake.
- **`viewport` is a field on a browser check, not a kind of its own**, so the same sequence can be
  declared twice at two sizes rather than written twice. A `viewport` *step* resizes mid-check.
- **Every string a check asserts on should appear in a prompt or in the seeded source.** A test
  enforces this: a check asserting on text the agent was never asked to produce is measuring
  clairvoyance. Text the check *types in* is exempt — that is its own data.
- **Author against the scripted browser first.** `packages/bench/src/testing/scripted-browser-session.ts`
  models the browser's own behaviour (clicking something absent fails; reloading discards unsaved
  state) and lets you script the application's, so a task can be proved to *discriminate* — passing
  against an application that does what was asked and failing against one that does not — with no
  Chrome, no sandbox and no network.

---

## Scoring

Four categories, weighted by default 50 / 25 / 15 / 10:

| Category | What it means | Default weight |
|---|---|---|
| `functional` | It does what was asked. Commands default here. | 50 |
| `browser` | It behaves correctly when driven. Browser checks default here. | 25 |
| `visual` | How it looks. Judged by a visual evaluator, which today reports "not run". | 15 |
| `code` | Typecheck and the accessibility audit — the quality of what was written. | 10 |

A category's score is the weighted proportion of its checks that passed. The overall score is the
weighted mean over **the categories that actually produced results**, renormalised — so a run with
no visual judgement is scored over the other three rather than docked fifteen points for a judge
that does not exist. The effective weight vector is recorded in every report, because a score is not
interpretable without knowing what it was a mean of.

**Absent is not failed**, and the distinction is the sharp edge. *Absent* means the run never asked,
which is a property of its circumstances; *failed* means it asked and did not get what it wanted,
which is a property of the agent. Only absent renormalises. If a preview never serves, its browser
checks are recorded as **failed** — treating them as absent would redistribute the browser category's
25% to the categories that did run, and failing to start would *raise* the score. See
[ADR-0002](adr/0002-absent-scoring-categories-renormalise.md).

### Gates

Rules that constrain the outcome regardless of what the checks summed to. An ordered ladder of pure
functions, each individually tested.

| Gate | When | Effect |
|---|---|---|
| `seed_failed` | A declared starting state could not be written | Errors, kind `sandbox`, before any prompt |
| `turn_failed` | A turn did not complete | Errors, kind from the failure reason |
| `turn_cancelled` | Somebody stopped it | Cancelled — not an observation, excluded from aggregates |
| `workspace_missing` | No such session, or the sandbox went away | Errors, kind `configuration` / `sandbox` |
| `preview_not_started` | Nothing listening on the port inside the sandbox | **Fails** — the agent's application did not start |
| `preview_unreachable` | Listening inside, unreachable from the host | **Errors**, kind `sandbox` — the proxy, not the agent |
| `browser_unavailable` | No browser could be started or driven, or a check never reached the application | Errors, kind `browser` |
| `nothing_measurable` | The run produced no scoreable check at all | Errors, kind `configuration` |
| `required_check_failed` | A check marked `required` failed | Fails |
| `build_failed` | The check marked `build` failed | Fails, and caps the overall score at 40 |

### Status, and why a run may have no score

| Status | Meaning | Score | Counts in a suite? |
|---|---|---|---|
| `passed` | A result, and it was good | Yes | Yes |
| `failed` | A result, and it was not | Yes | Yes |
| `errored` | No result was obtained | `null` | Yes — into an error rate |
| `cancelled` | Somebody stopped it | `null` | **No** — neither numerator nor denominator |

An errored run carries an **error kind** — `agent`, `runtime`, `model`, `sandbox`, `browser`,
`evaluator` or `configuration` — mapped from the turn's failure *reason* rather than inferred from
the fact of failure. Only `agent` counts against the model. Everything else is infrastructure, and a
suite carrying any of it prints a banner saying it is not comparable data.

What NapBench measures is **the model, with Nap held fixed**, which is what decides that split: it
asks whether a failure is evidence about a model, not whose code was at fault. Nap's own machinery
breaking is `runtime`, and so it is infrastructure. `CONTEXT.md` defines the kinds; `docs/adr/0004`
records why.

### Suites and comparison

A suite reports the mean over **completed runs only**, with the agent-attributable and
infrastructure-attributable error rates as separate figures over the non-cancelled runs.

Comparison refuses two runs whose **effective weight vectors** differ: renormalisation means a score
is only meaningful relative to the categories that produced it. It also refuses runs of different
tasks, and runs held at different **turn budgets** — `budget_exceeded` counts against the agent, so
that attribution is only honest while the ceiling is fixed. It does *not* refuse two runs of
different models, which is what it is for. Two runs, never three.

---

## Metrics

Every figure derives from the event stream a turn already wrote — there is no second instrumentation
path, so the benchmark and the product cannot disagree about what happened.

Collected: tool calls, tool failures, commands run, distinct files changed, turn lifecycle counts,
token usage across completed turns, summed turn duration, and an **estimated** cost from a versioned
price table (labelled an estimate everywhere, because it is derived rather than measured).

**Absent rather than guessed**, and this is deliberate: agent step count (nothing in the event
contract marks the model loop's boundaries), provider retries (the provider retries inside itself
and emits nothing) and token usage on a *failed* turn (`turn.failed` carries no usage). Each is left
off entirely rather than reported as zero — a zero is a measurement, and these are absences.

Screenshots are captured at the end of each browser check, at the viewport the check *actually
finished at*, each with a sidecar naming the task, run, check, size, moment and reference. They are
evidence *about* a run rather than an observation *of* the application, so a screenshot that could
not be taken or stored degrades the report and never changes a score.

---

## What the tests need

Filename decides which suite a test belongs to; see `CLAUDE.md`. For NapBench specifically:

| Suite | Command | Needs | Costs |
|---|---|---|---|
| Unit — every task, gate, score, metric, aggregation, comparison, the whole browser executor against the scripted fake | `bun run test` | Nothing. No network, no browser, no credentials. | Free |
| `apps/napbench/src/playwright-browser-session.integration.test.ts` — the adapter against real Chrome, serving its own page on loopback | `bun run test:integration` | **A Chrome or Chromium at `NAP_CHROME_PATH`.** Skips without one. | Free |
| `apps/napbench/src/browser-driving.integration.test.ts` — the browser steps a task uses, driven against a local application | `bun run test:integration` | **A Chrome at `NAP_CHROME_PATH`.** Skips without one. | Free |
| `apps/napbench/src/task-commands.integration.test.ts` — every command every task declares, run against an untouched template | `bun run test:integration` | **`E2B_API_KEY` and the network.** Unlike the browser suites it **throws rather than skips** without them. | One sandbox, seconds. No model calls |
| `apps/napbench/scripts/preview-reachability.ts` — can a host-side browser reach an E2B preview? | `bun run napbench:preview-spike` | `E2B_API_KEY`, network, a Chrome | One sandbox |
| A dry benchmark run | `bun run napbench --suite=all` | Nothing | Free |
| A real benchmark run | `bun run napbench --real --suite=all` | `E2B_API_KEY`, a model credential for the chosen platform, `NAP_CHROME_PATH`, network | Sandboxes + model calls |

NapBench needs **no Postgres, no object storage and no Docker**: a run composes in-memory stores
with real infrastructure, so it works from a clean checkout.

Credentials are read from `apps/api/.env` by convention. A real run refuses to start when one is
missing, and names the variable — including `NAP_CHROME_PATH`, which is checked *before* the first
sandbox rather than at the first browser check, because every browser check in the suite would fail
for want of it after the turns had already been paid for.

---

## A worked example

[`napbench-example-report.json`](napbench-example-report.json) is a real report from a real run
against real E2B on `openai/gpt-5.6-luna`, committed so the repository contains evidence the
benchmark has produced numbers rather than a schema that might. It is the to-do task: two turns,
six checks, one of which fails, and every figure in it decomposes.

[`napbench-first-real-run.md`](napbench-first-real-run.md) is what those runs revealed — including
the finding that mattered most, which is that the first suite's `code` category could not have been
earned by any model, because every task ran a `lint` script the template does not have. No dry run
could have caught it: the in-memory sandbox answers an unscripted command with a success.
