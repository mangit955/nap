# How often "Test the app" passes

**On `openai/gpt-5.6-luna`, "Test the app" passed 21 of 30 runs against three correct apps.
After one fix, the app it failed most on went from 5 of 10 to 9 of 10.** Cart and notes were not
re-run after the fix, so there is no measured "after" figure for all 30.

Measured on 2026-11-15 on the local Docker desktop, not on E2B. What that does and does not
establish is under [Limits](#limits). How the desktop and the test turn work is in
[computer-use.md](computer-use.md) and [ADR-0018](adr/0018-the-agent-gets-a-computer.md).

## What was run

```sh
bun run computer:reliability                       # scripted model: free
bun run computer:reliability --model=openai/gpt-5.6-luna --allow-spend --max-spend=0.8
```

Each run gets a fresh machine from the local desktop image (`LocalDockerSandboxManager`): the real
template, Chrome, the desktop driver and the recorder, at **2 GiB and 2 CPUs**, as production's
template is. The app's files are written over the template, its checks run, and the result is
committed and recorded as a verified job, so no build turn is paid for. The desktop is left cold:
the test starts it, as it does for someone who presses the button. Then the production runtime runs
one `kind: "test"` turn, with production's test budget and context settings. The turn builds its own
prompt from the job's goal and diff. Every run's events, screenshots, recording, peak memory and
classification are kept under `computer-reliability-results/`, which git ignores.

All three apps are **correct**, so a run passes only if the test completes, records at least one
assertion, and every assertion passes. A failed assertion on a correct app counts as a failure, as
does one left untested. This measures whether the flow finishes with a right answer. It does not
measure whether the agent catches a planted bug; NapBench's app-test tasks are for that.

| App | Weight | What it is | Goal the test is given |
|---|---|---|---|
| cart | light | NapBench's correct cart specimen: plain HTML and JS | Changing quantity to 3 shows a total of $36.00 |
| notes | medium | NapBench's correct notes specimen: saves to `localStorage` | A saved note is still listed after a reload |
| kanban | heavy | React on the template's own components: add, move, delete, counts | Adding, moving and deleting tasks keeps the column counts right |

## Results

| Pass | Model | cart | notes | kanban | Total |
|---|---|---:|---:|---:|---:|
| Before the fix | `openai/gpt-5.6-luna` | 6/10 | 10/10 | 5/10 | **21/30** |
| After the fix | `openai/gpt-5.6-luna` | not re-run | not re-run | **9/10** | — |
| Scripted control | none (fixed script) | 10/10 | 10/10 | 10/10 | **30/30** |

The scripted control makes no judgement: it sets up, declares one assertion, clicks, looks and
passes. Its pass rate is the machinery's alone: machine start, checks, desktop cold start, input,
screenshots reaching the model, the ledger and the recording. All 30 passed, each with its
recording, so in these runs the machinery never failed on its own; every Luna failure involved the
model's choices. The harness can report a machinery failure: a three-run scripted smoke pass before
these failed two of three at its own dev-server check, which fetched a file that does not carry the
app's heading, and the check was corrected before the passes above.

Across the 40 Luna runs, no process was killed for memory and every run kept its recording. The
largest memory sample was 1,310 MiB, on kanban, against the 2,048 MiB limit; the per-pass medians
were 995 and 1,216 MiB. Samples are every two seconds, so a brief peak between them is missed.
Before the fix, the median test turn took 75 s (from `turn.completed`, over the 29 turns that
completed), against 48 s for the one hosted test turn in computer-use.md; a whole run, machine start
and checks included, took a median 102 s. This machine emulates x86-64, so the local times are not
a production figure.

### Why the nine failed, before the fix

| Failure | Runs | Whose |
|---|---:|---|
| The assertion ledger refused a call, and the test ended with an assertion untested | 8 | Nap's feedback; see below |
| The turn's token budget ran out after one reply of about 66,000 output tokens | 1 | The model's |

None was a desktop or VNC start failure, a dev server that was not ready, a timeout, an
out-of-memory kill, or a recording or storage failure.

Every refusal was correct by the ledger's own rules (ADR-0018 D9). What turned a refusal into a
failed test was the batch around it. A batch stops at its first refusal, and the result said
nothing about the actions after it. Read call by call, the eight ledger failures began like this:

| How the run's first refusal happened | Runs |
|---|---:|
| A refused verdict at the head of a batch that also declared the next assertion and acted on it; neither ran | 5 |
| A refused verdict at the head of a batch whose input then did not run | 1 |
| A verdict for an assertion about the starting state, which had had no input since it was declared | 1 |
| An action described before any assertion was declared | 1 |

In the first six, the model went on as if the rest of the batch had run. It gave verdicts for ids
that were never recorded, and the test ended with real assertions untested. The refusals it hit:

| Refusal message, before the fix | Times |
|---|---:|
| A verdict must match an untested assertion in the current test | 17 |
| Perform the action and inspect a new screenshot before assigning a verdict | 12 |
| State an untested assertion before describing the action | 2 |
| Assertion IDs must be unique | 1 |
| Start a test before declaring its assertion | 1 |

The first wrong verdict in each run was the model's mistake. The silent drop was Nap's, and it is
what turned one recoverable refusal into a failed test.

A second, smaller fault was also Nap's. When the model sent `CTRL+A`, the desktop received
`ctrl+A`, and xdotool sends an uppercase letter with Shift, so Chrome received Ctrl+Shift+A. Nothing
was selected, typing "3" appended to "1", and the action still reported success. Driven directly on
the desktop without a model, the cart's total read $156.00 after `ctrl+A` and $36.00 after `ctrl+a`.
Luna sent such a chord in 11 of the 30 runs. It usually recovered with a triple-click; in one run the
confusion that followed led to a failure. All 11 were on cart or notes; no kanban run sent one,
before or after the fix, so the kanban re-check below measures the batch change alone.

## The fix

All three are in the agent's `computer` tool and the ledger's messages. The ledger's rules are
unchanged.

- A computer call that stops early now says which of its actions did not run, naming any assertion
  declarations among them.
- A refused verdict lists the assertions still untested in the test, with their exact ids and
  expectations. A verdict sent with no input since its declaration is told so.
- A modifier chord ending in an uppercase letter is lowercased before the desktop sees it, so
  `CTRL+A` is select-all. This is done outside the desktop's key map, which is part of the desktop
  build: changing that would mark every running machine outdated until the template is republished.

`computer.test.ts`, `app-test-run.test.ts` and `computer-key.test.ts` cover each, and each test was
seen failing before its change. In the kanban re-run, three runs hit a refusal that stopped a
batch, and in each the model sent again what the result said had not run. Two of them (kanban 5 and
9) finished with every assertion passed. The third is the failure below.

**What the fix does not cover.** The one kanban failure left after it is the rule underneath. The
model declared an assertion about the board's starting state and could not give it a verdict,
because a verdict needs input made after the declaration. An assertion about what is already on
screen can never pass, and the model left it untested. Allowing it would change ADR-0018 D9, which
is a design decision rather than a fix.

## Cost

Measured from the OpenRouter key's usage before and after each pass: **US$0.234** for the 30-run
pass and **US$0.075** for the 10-run re-check, **US$0.309** in total. The scripted control cost
nothing. The key's usage updates with a lag, so per-run figures in each
`summary.json` can land on the run after the one that spent them. The totals bracket whole passes
and do not have that problem. The key is the development one, and nothing else is known to have
used it during the passes. These are usage figures, not an invoice.

## Limits

- **Local Docker, not E2B.** The image is built from the same template and desktop sources, at
  production's memory and CPU, but it runs under x86-64 emulation on an ARM Mac. Times are slower
  than production, and E2B's own failure modes (proxy, cold VM, network) are not exercised.
- **Ten runs per app, one model.** 21 of 30 is consistent with a true rate from about 52 % to about
  83 % (Wilson 95 %). The re-check is 10 runs of one app; 5 to 9 out of 10 is a large
  move, but on a sample that small it is evidence, not proof.
- **Correct apps only.** This measures false failures and unfinished tests, not missed bugs.
- **Fixed goals.** Each goal names a concrete outcome. A vaguer goal from a real job may do worse.

## Reproducing it

The scripted pass needs only Docker. The first run builds the local image, which took about 25
minutes here. A real model needs `OPENROUTER_API_KEY`. Anything not `:free` also needs
`--allow-spend` with a `--max-spend` ceiling, which is checked against the key's usage before each
run; a pass stops if that usage cannot be read, and a run already started can take it a little
over. `--apps` and `--runs` narrow a pass. The classifier's kinds are in
`apps/api/scripts/computer-reliability-classify.ts`.
