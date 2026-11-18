# Production does the whole loop on a real repository

The first time production Nap took a task for a real GitHub repository from one person's account
and went all the way to a reviewed draft pull request and a recorded test of the running app.
Nothing in this run was scripted. The model, the sandbox, GitHub and storage were all real, and the
model ran on the owner's own OpenRouter key.

**Configuration.** <https://nap-tawny.vercel.app>, 2026-11-18. Worker and API at `d88ac8f0`. Model
`openai/gpt-5.6-luna`, chosen in the composer; it is on the computer-use list. Repository
[`mangit955/tab-split`](https://github.com/mangit955/tab-split), a small Vite and TypeScript tip
calculator with typecheck, test and build scripts. Source settings: setup
`bun install --frozen-lockfile`, dev `bun run dev`, port 5173, draft pull request on.

**The task:**

> Let a group split the bill. Add a "People" stepper (1–20, default 1) under the tip, and show
> what each person pays. Round each share up to the cent so the group never comes up short. Put
> the math in src/tip.ts with tests.

**Result:** [mangit955/tab-split#1](https://github.com/mangit955/tab-split/pull/1), a draft, with 4
files changed (+87 −5).

**Model spend ≈ $0.011** by Nap's own estimate (price table `2026-11-17`): build $0.0039, review
$0.0014, first app test $0.0037, retest $0.0024. That table (`packages/shared/src/pricing.ts`)
prices `gpt-5.6-luna` at half the OpenAI rate cited in `packages/shared/src/usage.ts`, so the
charge on the key is more likely about $0.02. Both are estimates; nothing here reads the bill. E2B
was a few cents.

---

## What happened, in order

| UTC | Step | Evidence |
|---|---|---|
| 16:13 | **Attempt 1 failed** before any model call: "Could not start the repository preview." | `turn.failed`, `sandbox_unavailable`, 65 s after the turn started |
| 16:48 | Fix merged as [#289](https://github.com/mangit955/nap/pull/289) and deployed at 16:59 | release run `44351547359`, production job green |
| 17:35:22 | Attempt 2 started; workspace ready and preview up in 8 s | `job.started`, `preview.ready` on 5173 |
| 17:36:16 | The agent finished in 45 s: 3-step plan, 4 files | `turn.completed` |
| 17:36:36 | Checks passed and the reviewer passed the job | typecheck, build, test, preview and review passed; no lint script |
| 17:36:43 | Draft PR opened | `job.completed` (outcome `verified`) at 17:36:36; GitHub's `createdAt` |
| 17:37–17:38 | **Test the app** passed 3 of 3, but Nap saved no recording | `test.recording` `unavailable` |
| 17:42:25–17:42:57 | **Retest** (one, approved) passed 2 of 2, and Nap saved its recording | `test.recording` `available`, 29.4 s |

### Attempt 1: the repository never started

Every repository session with a development command failed the same way. Nap started the dev
server with `cd … && nohup sh -c '…' >log 2>&1 &`. The background subshell kept the command's own
output pipe open for as long as the server ran. E2B answers a command only when that pipe closes,
and gives up after 60 s. Fixed in [#289](https://github.com/mangit955/nap/pull/289), with a
test that runs the real command under bash and was seen failing on the old code. The trap is now
in `docs/gotchas/sandbox.md`.

### The change the agent made

`computePerPerson(totalCents, people)` in `src/tip.ts` returns `Math.ceil(totalCents / people)`.
Two new tests cover an even split ($120.00 among 3 is $40.00 each) and rounding up (1,001 cents
among 3 is 334). The UI got a People stepper whose buttons disable at 1 and 20, and an
"Each person" row.

### The review

The reviewer runs on the same model and key as the agent (ADR-0036). It ran 4 steps (17,627
input and 918 output tokens) and returned 0 blocking findings and 0 notes. With no notes there was
nothing to add to the pull request description, which is what
[#288](https://github.com/mangit955/nap/pull/288) does when there are some.

### Test the app

Nap's agent drove the running app in its own desktop browser. Its assertions:

- After a fresh load, People shows 1, the decrease button is disabled, and Each person is $0.00.
- A $10.00 bill with the default 18% tip at 3 people shows tip $1.80, total $11.80 and **$3.94
  each**, which is $11.80 ÷ 3 rounded up.

Neither test checked the upper limit of 20 people, and the agent said so.

![The last frame of Nap's own test recording: Tab Split with a $10.00 bill, 18% tip, 3 people,
total $11.80 and $3.94 each](assets/production-loop/test-recording-frame.png)

[Nap's recording of the retest](assets/production-loop/test-recording.mp4), as the app stored it:
H.264, 1024×768, 29.4 s.

The first app test saved no recording. It started the desktop cold, and the recorder never
reported `started`. The cause was swallowed, so the logs cannot say which step failed. The retest
five minutes later, with the desktop already running, recorded from 2 s in. That fits a
cold-start race on the recorder's 5-second first-frame deadline, but it is not confirmed. Filed as
[#290](https://github.com/mangit955/nap/issues/290).

## What this run proved

- **The whole loop works in production for a real person on a real repository:** connect, task,
  change, checks, review, draft PR, and a test of the running app with a recording. The change
  itself took 45 s of agent work. Everything, with the retest, cost one to two cents of model
  spend.
- **The first funded attempt found a bug that blocked every connected repository with a dev
  command.** No free path exercised it. The in-memory sandbox doesn't run a shell. The local
  rehearsal used a scratch project, whose preview starts another way. And dash, CI's `/bin/sh`,
  hides the bug.

## What it did not prove

- **The first app test on a cold desktop loses its video**
  ([#290](https://github.com/mangit955/nap/issues/290)). The video above comes from the retest.
- **One run, one model, one small repository.** It says nothing about larger apps or other models.
- **Cost is an estimate** from a price table, and the table and the vendor page disagree by a
  factor of two.
- **The in-app player failed once.** The first time the viewer opened, a minute after the retest,
  it showed "This recording could not be loaded" with a media format error. The same route then
  served the same 59,864 bytes with a `206`. Five minutes later the viewer played all 29.4 s,
  chapter by chapter, in the same browser (Electron 44, Chrome 152). The failure did not happen
  again, so it is recorded here, not filed.
