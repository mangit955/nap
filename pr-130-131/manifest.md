# Evidence manifest: session card data, search, auto-settle settings, Regenerate title

Branch `feat/130-131-card-data-and-titles` (mangit955/nap), captured 2026-11-09.

| Label | SHA |
|---|---|
| Before (base, origin/main) | `ab47193266b7af3da45b0b4d7d24915cfb67e4f7` |
| After (head) | `25d714190f7ee7ed3f0f3e0f30da53d812b20d3f` |

## Environment (both phases)

- Checkout: the run-owned worktree `wt-v3`, detached at the SHA above. `bun.lock` is the same at both SHAs, so no install was needed.
- Harness: `evidence-preview.ts` (kept here), an extended copy of `apps/api/scripts/navigation-preview.ts`. It was copied into `wt-v3/apps/api/scripts/` for each run and deleted afterwards. The web app (Next dev, :3037), the API and composition (:3038), and Postgres (a throwaway Docker container) are real. GitHub, the sandbox (`InMemorySandboxManager`), the model and the blob store are synthetic. No real model, E2B, or `--real` path was used, and nothing was spent.
- Browser: headless Chrome (`/Applications/Google Chrome.app`, `--headless=new`) with a throwaway `--user-data-dir` under `evidence/` (deleted after the runs), driven over CDP by `driver.ts` (kept here). Viewport 1280x800, deviceScaleFactor 1, dark theme (the app's default here).
- Runner: each phase ran as one command, `run_check.py --timeout 900 -- bun driver.ts <phase> wt-v3 evidence`. The driver starts the harness and Chrome as children and stops both at the end. Logs are in `run-before.log` and `run-after.log`.
- Sign-in: `reader@navigation.test` / `Navigation-preview-42`, through the real `/api/auth/sign-in/email` endpoint from the page.
- The driver only navigates, types (`Input.insertText`), clicks (`Input.dispatchMouseEvent`) and captures. It never writes to the DOM.

## How the states were reached (the same at both SHAs)

What the original harness seeds (115 sessions, 2 pinned repository sessions and so on) is unchanged, except that the sessions at positions 5–8 are given readable names. After boot, the harness signs in and sends real turns through `POST /sessions/:id/turns`. They go through the real queue and the real worker (concurrency 1) and are run by a scripted provider:

1. **Revenue dashboard**: prompt "Add a quarterly revenue chart with a CSV download under it". The scripted model writes one file and the fake commit reports `2 files changed, 412 insertions(+), 88 deletions(-)`. The turn runs to `done`. The harness then marks it read through the real `PostgresSessionNavigationStore.change({kind:"read"})`, as opening the session would, so the row shows a plain time.
2. **Standup reminder emails**: prompt "Email each teammate a reminder fifteen minutes before the standup starts". The commit reports +48 −12. It runs to `done` and is left unread, so the row shows **Done**.
3. **Weekly digest export**: the scripted model holds this prompt until the turn is cancelled, so the request stays `leased`, which is a running turn.
4. **Onboarding checklist**: sent after (3) is leased. With worker concurrency 1 it stays `queued`.

Every turn ran on `openai/gpt-5.6-luna`, the deployment's free model in the harness config. Sandbox quotas were raised to 10 per user so four sessions could hold fake sandboxes.

For Regenerate title (head only), the copy passes `titles: new PostgresProjectTitleStore(db)` and `autoSettle` to `composeNap`, as `boot.ts` does in production. The base composition ignores them, because the module is imported dynamically and is absent there. A `purpose: "title"` request to the scripted provider waits 4 s, so the dimmed row stays on screen long enough to capture, and then answers "Standup Reminder Email Schedule". That answer passes the real `cleanTitle` checks and is applied by the real titler, store and route.

## Files

### Before (base `ab471932`)

| File | Scenario | Notes |
|---|---|---|
| `b1-sidebar.png` | `/dashboard` sidebar with one running, one queued, one finished-unread and one finished-read session | The queued **Onboarding checklist** shows *Working 9s*, a timer that counts from the request even though nothing has started. **Weekly digest export** shows *Working 11s*. **Standup reminder emails** shows *Done*. No row shows `+N −M` or a model. The row text is dumped in `b1-sidebar.txt`. |
| `b2-search.png` | "quarterly" typed into *Search sessions*. The word appears only in Revenue dashboard's message, not in any name | The local filter shows "No matching sessions." and there is no listbox. Dumped in `b2-search.txt`. |

### After (head `25d71419`)

| File | Scenario | Notes |
|---|---|---|
| `a1-sidebar.png` | Same four sessions | **Onboarding checklist**: *Queued* with a clock icon and no timer. **Weekly digest export**: *Working 9s*, counting from the claim; line 3 shows the model `gpt-5.6-luna` and no diff yet. **Standup reminder emails**: *Done*, with line 3 `+48 −12 gpt-5.6-luna`. **Revenue dashboard** (read): a plain time, with line 3 `+412 −88 gpt-5.6-luna`. Dumped in `a1-sidebar.txt`. |
| `a2-search.png` | "quarterly" typed into *Search sessions* | A listbox ("Search results") with one option, Revenue dashboard, and the snippet "Add a **quarterly** revenue chart with a CSV download under it". The match is wrapped in `<mark>`; the markup is in `a2-search.txt`. |
| `a3-settings.png` | `/settings/sidebar` | Settings → Sidebar → Auto-settle. Both rules are unchecked (off by default), and the days field shows 7. |
| `a4-menu.png` | Right-click (CDP right mouse button) on the Standup reminder emails row | The context menu, including **Regenerate title** under Rename. |
| `a5-regenerate.gif` | Choosing Regenerate title, through to the new name | About 8.9 s, built from 22 CDP `Page.captureScreenshot` frames taken about every 330 ms (`a5-frames/`, with their real timings in `frames.txt`), encoded with ffmpeg (concat demuxer, fps 8, generated palette). It shows the menu open, the menu closing on click, the title dimmed and pulsing while it is written, and then *Standup Reminder Email Sched…* (truncated by the card width). |
| `a5a-dimmed.png` | Still: the first frame in which the row's title had `aria-busy="true"` | The title is at half opacity (`animate-pulse opacity-50`). The effect is subtle at this zoom; the crops in `a5-contact.png` show it more clearly. |
| `a5b-renamed.png` | Still: after the new name arrived | The row reads *Standup Reminder Email Sched…*. The full name is in the DOM; the driver waited for that exact text. |
| `a5-contact.png` | Crops of frames 1, 6, 12 and 21 side by side | Shows the menu, the dimmed title (two frames) and the renamed row. Made with ffmpeg from the recorded frames, as a quick check. |

### Supporting

- `evidence-preview.ts`: the extended harness copy.
- `driver.ts`: the CDP driver.
- `run-before.log`, `run-after.log`: harness and driver output, including the `EVIDENCE …` scenario lines.
- `docker-before.txt`: containers present before the runs.

## Skipped or caveats

- Nothing in the requested list was skipped.
- The first "before" attempt failed on the sandbox quota (`sandbox_quota_exceeded`, the harness limit of 2 projects per user). The harness crashed before stopping its container, so the driver timed out and one container was left behind; I removed it with `docker rm -f`. The quota was raised and both phases then ran cleanly. Only the second run's captures are kept.
- The Next.js dev-mode "N" indicator shows in the bottom-left corner of every capture. It comes from `next dev`, not from the app.
- The working row shows the model on line 3 at head because the running request already names it, which is what the query does. This is not an artefact of the harness.

## Cleanup

- `wt-v3` is left detached at the head, `25d714190f7ee7ed3f0f3e0f30da53d812b20d3f`, with a clean status. The untracked harness copy was deleted.
- No harness, Next or Chrome processes remain, and ports 3037, 3038 and 9333 are free. The throwaway Chrome profiles were deleted.
- Every Postgres container the runs started has been removed. The two `nap-postgres-*` containers created at 15:02 belong to another session and were left alone.
