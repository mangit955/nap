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
bun run napbench --suite=hard              # built to separate two models — but see the write-up:
                                           # a strong enough model clears it 3/3 with no spread
bun run napbench --suite=smoke             # the tracer task alone: "is the machinery joined up?"
bun run napbench --suite=product           # the tasks scored on both halves — what it does, and
                                           # whether it is a product anybody would want to use

bun run napbench --real --suite=all        # real E2B, a real model, a real browser. Spends money.
bun run napbench --real todo-crud --model=anthropic/claude-opus-5 --effort=high

bun run napbench --baseline=<ref> --candidate=<ref>   # what moved between two finished runs
```

**Fakes by default; `--real` is the only way to spend.** A dry run drives every stage — seeding,
turns, the preview probe, the checks, the report and trajectory files, the suite aggregation —
against a scripted model, an in-memory sandbox, a scripted browser and a scripted product judge. It
costs nothing and needs no network. Its scores mean nothing: the scripted model does not attempt the
task and the judge's grades are fixed in advance and describe no image, so what a dry run proves is
that the apparatus works, not that an agent does.

The judge is the one fake composed on a dry run and *absent* on a real one, which is honest rather
than backwards: a scripted judgement costs nothing and drives the whole product half — the schema,
the fold over the dimensions, the geometric combination, the report's product section — while a real
judge is a vision model that does not exist here yet. Until it does, a paid run scores its objective
half alone, which is exactly what every archived run was scored as.

Unknown flags are refused rather than ignored. A forgiving parser would let `--budget-tokens` be
mistyped on a paid run and silently use the default.

| Flag | Meaning |
|---|---|
| `--suite=<name>` | Run a named suite serially. `all` (the four, frozen), `hard` (built to separate models), `smoke` (the tracer) or `product` (scored on both halves). |
| `--real` | Real E2B, real model, real Chrome. Also requires `NAP_CHROME_PATH`. |
| `--platform=<name>` | `openrouter` (default), `anthropic` or `bedrock` — which account pays. |
| `--model=<id>` | Model for a real run. Also what the cost estimate is priced against. |
| `--effort=<level>` | `low` … `max`. |
| `--max-steps=<n>` | Model calls allowed within one turn. |
| `--budget-tokens=<n>` | Context budget per turn. |
| `--repeat=<n>` | Run each task n times and report the spread per task. Multiplies a real run's cost by n. |
| `--keep` | Leave each sandbox running instead of destroying it. Billed until destroyed. |
| `--no-verify` | Do not arbitrate what a turn claims — commit it and believe it, as v1 did. The control arm of a before/after measurement, and recorded on every report it produces. |
| `--baseline=` / `--candidate=` | Compare two finished runs. Reads reports; runs nothing. |

Exit code answers *did the benchmark run*, not *did the agent do well*: a low score exits 0, and a
run that produced no score at all exits 1.

Everything a run produces — reports, trajectories, screenshots and their sidecars — is written to
`napbench-results/`, which is gitignored. Running the benchmark never dirties the tree.

---

## Architecture

Two units, per [ADR-0001](adr/0001-napbench-splits-into-a-pure-package-and-an-app.md), over a
shared primitive, per [ADR-0007](adr/0007-the-check-primitive-moves-below-both.md).

**`packages/bench`** is the pure half: tasks, checks, gates, scoring, metrics, reports,
trajectories, the CLI's argument parsing, suite aggregation and comparison. Its runtime workspace
dependencies are `@nap/shared` and `@nap/verify`. It is written against ports — `Runtime`,
`SandboxManager`, `SessionStore`, `EventStore`, `BrowserSession` — which is what lets the whole
evaluation be driven by a unit test with no network, no model and no database.

**`packages/verify`** sits below it, and below the runtime too: the preview probe, the captured
output of a failed command, and the passed/failed/absent answer. NapBench's `Check` is one of these
plus a category, a weight and a required flag — the scoring metadata was never part of running the
check. Nap's own verifier uses the same primitive to arbitrate whether a turn's claim of success
holds. What must never exist is the reverse edge: the runtime importing the benchmark that grades
it.

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
7. Run the **capture pass**: walk the task's declared surfaces and photograph each at mobile and
   desktop, in a browser session per image. Changes no score, whatever it managed — and runs
   *after* the checks precisely so that it cannot: a surface's steps drive the application, and a
   pass that ran first could add the row a check was about to assert was absent. The price is that
   a surface is photographed as the *checks* leave the application, not as the agent did; a task
   whose checks persist state should name its surfaces knowing that.
8. Ask the visual evaluator, which today always answers "not run".
9. Apply the gate ladder, score what is left, read the trajectory back out of the event store, and
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
  // Optional, and the only thing that makes a task judged as well as checked. One neutral
  // sentence about what the application is for — the whole of what a judge is told, and never
  // the prompts. A task without it is scored on its checks alone, whatever judge is composed.
  intent: "a place to keep track of what still needs doing",
  // Optional. The views a judge should be shown, each photographed at mobile and desktop.
  // Absent gets `/` at both. At most four, because each one is two images and every image is
  // vision-model tokens. Steps may not assert and may not resize — see the screenshots section.
  surfaces: [
    { id: "empty" },
    {
      id: "populated",
      steps: [
        { step: "fill", selector: { by: "label", text: "Task" }, value: "Buy milk" },
        { step: "press", key: "Enter" },
      ],
    },
  ],
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
      // The binary, not a package script: a script is a file the agent under test can edit,
      // and a grader that asks a project how it should be graded is not grading it. The
      // template's scripts have already moved once for this reason — see the bullet below.
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
- **Run your command against an untouched template before trusting it, and do not assume its
  scripts.** They are `dev`, `typecheck`, `build` and `preview` today; there is still no `lint`,
  and there was no `typecheck` either until the verification loop needed one. A check spelled
  `bun run lint` fails on every run for every model while looking like a code-quality
  measurement — which is what a funded run cost to learn (`docs/napbench-first-real-run.md`).
  That the list moved afterwards is the second reason a task invokes the binary instead. The
  guard is `apps/napbench/src/task-commands.integration.test.ts`.
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

Two arithmetics, and a report says which one produced its number. **`v1`** is the four-category
weighted mean below; every archived run and every task that declares no `intent` is scored under it,
and it is what the frozen `all` suite goes on being scored under. **`v2`** splits a run into that
objective half and a product half graded by a judge, and combines them — see [the product
half](#the-product-half). `compare` refuses to put a number from one beside a number from the other:
the scale is the same 0–100 and the meaning is not.

### The four categories

Weighted by default 50 / 25 / 15 / 10:

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

### The product half

A task that declares an `intent` — one neutral sentence about what the application is for — is
scored on two halves rather than four categories. The objective half is the weighted mean above.
The product half is a judge's answer on nine equally weighted dimensions, each graded on an ordinal
scale and each carrying the evidence and the screenshot it was drawn from; a tenth, `polish`, is
reported and never scored. The two are combined **geometrically**, so neither half can carry the
other: an application that does exactly what was asked and looks terrible lands in the forties
rather than the eighties.

Three properties are worth knowing before reading one of these reports.

- **The judge sees screenshots and the intent, and nothing else** — no prompts, no source. A person
  opening the finished application has no specification, and a judge shown the prompts would start
  grading feature completion, which the checks already measure and measure better.
- **An unjudged run is scored on its objective half alone**, never on a product half of zero.
  Absence renormalises, exactly as it does for a category. That covers every run of the frozen
  suite, every real run until a vision judge exists, and every run that photographed nothing.
- **The gates arbitrate the combined number.** A judge cannot rescue an application that does not
  compile; the build cap still applies, after the halves are combined.

`intent` is what makes a task judgeable, rather than a flag on the run: a task that says nothing
about itself gives a judge nothing to look at, so the runner does not ask one. The `product` suite
is the tasks that declare one, kept apart from `all` because the two are scored under different
arithmetics.

### The fixture corpus, and how the judge is checked

Everything above describes a judge's output being turned into a number. None of it says whether the
judge *works*, and an evaluator nobody has watched discriminate is a check that has never been
observed failing — it may be returning `moderate` to everything, and no report would look any
different.

So there is a corpus: nine hand-written applications in `apps/napbench/fixtures/corpus/`, declared
in `packages/bench/src/product/corpus.ts`. Every one of them renders **the same task tracker with
the same content**, so the only variable between two fixtures is the design, and every one is told
**the same single sentence of intent**. They range from a restrained professional layout through
the generated house style — purple hero, emoji headings, three identical cards — to a page with no
stylesheet at all, and they include three deliberate pairs: an icon-drowned interface against a
two-icon one, a fixed-width layout against a responsive one, and a correct-but-unstyled application
against a beautiful hollow one.

They are static files with their CSS inline, photographed **once** at mobile and desktop by
`bun run napbench:corpus` and committed as PNGs. No sandbox, no agent, no model, and no network —
which is what makes the corpus free to keep and cheap to grade. The capture goes through
`PlaywrightBrowserSession`, the same adapter a real run drives, so the images are produced by the
code path under test rather than by a script with its own opinions about screenshots.

**What is asserted are orderings and bounds, never absolute numbers.** `CORPUS_EXPECTATIONS` in
`packages/bench/src/product/discrimination.ts` holds seven claims of the form "minimalist beats
slop by at least a real margin" and "`restraint` on `excessive-gradient` is at most `weak`".
Asserting that a fixture scores 62 would be this repo's *never assert on model prose* rule broken
in numeric form: an exact anchor is the judge's phrasing, and a run one grade lower on two
dimensions would fail a test while having discriminated perfectly well. Each claim is one half of a
*pair*, which is what makes it a test of discrimination rather than of severity — a judge that
marks every icon down passes the `excessive-icon` bound alone and fails once `icons-restrained` has
to come back `good`.

Absence is a third outcome, neither pass nor failure. A dimension the judge could not assess, a
fixture nobody judged and a run with no judge composed all produce nothing to compare, and scoring
those as failures would make the check loudest exactly where it learned least.

The free suite runs `checkDiscrimination` against scripted judgements, including one that grades
every fixture identically — which must fail all seven expectations, because that is the failure
mode the corpus exists to catch. The paid suite,
`apps/napbench/src/corpus-discrimination.integration.test.ts`, runs the identical claims against a
real judge over the committed images: eighteen images through a vision model, and nothing else. It
skips, with the reason printed, while `resolveProductJudge` has nothing to compose.

**Follow-up: harvesting real screenshots.** A hand-written fixture is a designer's idea of slop
rather than a specimen of it. The next step is to promote screenshots from funded runs into the
same corpus — a run whose grade a reader disagreed with is exactly the specimen worth keeping — by
copying the surface captures out of `napbench-results/` into a fixture directory, writing the
fixture into `CORPUS_FIXTURES`, and adding whatever ordering it is evidence for. Harvested fixtures
have no `index.html` and cannot be re-photographed, so `missingCorpusArtefacts` will need to learn
that a fixture may be images-only. They *extend* the hand-written nine rather than replacing them:
a generated application is a moving target, and something in the corpus has to stay still.

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
infrastructure-attributable error rates as separate figures over the non-cancelled runs, and a
success rate beside them — a configuration scoring 85 every time and one alternating 100 and 70
have the same mean and are not the same thing to depend on.

**`all` is frozen.** Three funded runs are recorded against exactly its four tasks, and a suite is
a name for a fixed list precisely so that adding a task cannot silently reprice a result already
taken under that name. Harder tasks go in `hard`, which is funded separately — `all` is cheap and
comparable with history; `hard` is where a real model comparison would be bought. `suite.test.ts`
asserts `all`'s membership exactly, so growing it fails a test rather than passing unnoticed. The
`product` suite is kept apart for a stronger reason still: its runs are scored under a different
arithmetic, so a task in both would be quoted under two.

**One run is an anecdote.** Two runs of `todo-crud` under one model and one configuration scored 88
and 74, so a comparison drawn from a single run each is noise presented as a finding. `--repeat=<n>`
runs each task n times and prints mean, median, sample standard deviation and range **per task** —
per task because a spread across *different* tasks measures how much the tasks differ in difficulty,
which is a fact about the benchmark rather than about the model. A task run once reports no standard
deviation at all rather than zero: zero would read as perfect consistency when nothing was measured
twice. Repetitions are scheduled round-robin, so a provider having a bad ten minutes does not land
entirely on one task.

Comparison refuses two runs whose **effective weight vectors** differ: renormalisation means a score
is only meaningful relative to the categories that produced it. It also refuses runs of different
tasks, and runs held at different **turn budgets** — `budget_exceeded` counts against the agent, so
that attribution is only honest while the ceiling is fixed. It does *not* refuse two runs of
different models, which is what it is for. Two runs, never three.

**A differing harness is reported, never refused.** Every report records a *harness identity* — the
commit Nap was running at, whether that tree was modified, and whether verification was on — because
ADR-0004 fixed the frame as the model with Nap held fixed, and V2 moves Nap. By the letter of the
rule above a differing harness belongs with the weight vector; it is deliberately not, because
comparing two Naps is the question V2 asks, and refusing it would refuse the only comparison the
identity was recorded for while stranding the whole pre-V2 archive as well. So `compare` prints the
two identities above the numbers they explain, and says plainly that what moved is not only the
model's doing. An absent identity is *unrecorded* rather than *none*, and never reads as a
difference — the same rounding the turn budget uses, for the same reason.

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

Screenshots come from two places, and a report says which of the two each one is.

The first is a by-product: one at the end of each browser check, at the viewport the check
*actually finished at*. That is the right evidence about a check and the wrong thing entirely for a
judge — a check is named for what it asserts rather than for what it is looking at, so nobody can
say what view its image is of, and a task whose checks are all desktop leaves no pair to compare.

The second is the **capture pass**, which is deliberate. A task declares `surfaces`: named views
with the steps needed to reach a meaningful state, drawn from the same browser-step vocabulary
checks use — minus assertions, which a pass has nowhere to put, and minus resizes, which belong to
the pass rather than to the view. Every surface is photographed at **mobile and desktop**, so
"was the small viewport designed for, or the large one squashed" is answerable. A task that
declares none still gets the default pair, `/` at both sizes; no run ends with nothing to judge.

**The image count is bounded and it is worth stating, because every image is vision-model tokens on
every real run.** A task may declare at most **four** surfaces, so the pass takes at most **eight**
images — and that, not the checks' by-products, is the whole of what a judge is shown. The bound is
enforced by the task schema rather than by anybody remembering.

Every image gets a sidecar naming the task, run, whichever of the check and the surface it is of,
size, moment and reference, so a picture copied out of the directory still says what it is. All of
it is evidence *about* a run rather than an observation *of* the application, so a screenshot that
could not be taken — an unreachable surface, an absent browser, a full disk — degrades the report
and never changes a score.

---

## What the tests need

Filename decides which suite a test belongs to; see `CLAUDE.md`. For NapBench specifically:

| Suite | Command | Needs | Costs |
|---|---|---|---|
| Unit — every task, gate, score, metric, aggregation, comparison, the whole browser executor against the scripted fake | `bun run test` | Nothing. No network, no browser, no credentials. | Free |
| `apps/napbench/src/playwright-browser-session.integration.test.ts` — the adapter against real Chrome, serving its own page on loopback | `bun run test:integration` | **A Chrome or Chromium at `NAP_CHROME_PATH`.** Skips without one. | Free |
| `apps/napbench/src/browser-driving.integration.test.ts` — the browser steps a task uses, driven against a local application | `bun run test:integration` | **A Chrome at `NAP_CHROME_PATH`.** Skips without one. | Free |
| `apps/napbench/src/task-commands.integration.test.ts` — every command every task declares, run against an untouched template | `bun run test:integration` | **`E2B_API_KEY` and the network.** Unlike the browser suites it **throws rather than skips** without them. | One sandbox, seconds. No model calls |
| `apps/napbench/src/corpus-discrimination.integration.test.ts` — can a real judge tell the nine fixtures apart? | `bun run test:integration` | **A composed product judge.** Skips, with the reason printed, while there is none. No sandbox, no agent. | Eighteen images through a vision model |
| `apps/napbench/scripts/preview-reachability.ts` — can a host-side browser reach an E2B preview? | `bun run napbench:preview-spike` | `E2B_API_KEY`, network, a Chrome | One sandbox |
| `apps/napbench/scripts/capture-corpus.ts` — re-photographs the fixture corpus | `bun run napbench:corpus` | **A Chrome at `NAP_CHROME_PATH`.** Nothing else. | Free |
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

[`napbench-verification-measurement.md`](napbench-verification-measurement.md) is the funded
before/after measurement of the verification loop: the `hard` suite, n=3 per arm, verification off
against on, model held fixed. Worth reading for the two ways the experiment failed rather than for
its number — the control arm ceilinged, and the loop turned out to be blind to the only check that
broke, for the same reason the first funded run found and by the same route the fakes cannot reach.

[`napbench-luna-remeasurement.md`](napbench-luna-remeasurement.md) is the same experiment re-run
on the model the tasks were calibrated against, after the template gained the `typecheck` script.
It confirms the loop now arbitrates that check on real projects, and is otherwise a record of why
the measurement still cannot be taken: the run that separated the two arms failed only browser
checks while building and typechecking clean, so the loop was blind to it as well. Twelve funded
runs across both measurements have fired zero repair turns.
