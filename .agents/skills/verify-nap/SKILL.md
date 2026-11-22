---
name: verify-nap
description: Drive Nap's real web app in a headless Chrome the way a user does, against a fake model and a fake sandbox, and capture screenshots and ARIA snapshots as proof. Use to prove a UI change in apps/web (dashboard, session list, starting a project, the workspace chat and steering, the preview pane, the file tree) before opening or merging a PR. Costs $0, needs Docker and Chrome.
---

# verify-nap

Mocked component tests pass on timing and lifecycle bugs that a person sees in seconds. This skill
runs the whole app and drives it through the browser, so a UI change is proven against what a user
would actually see.

What is real: the Next web app, the API, auth, Postgres (a throwaway Docker container), the turn
queue, the worker, the event log and the WebSocket. What is fake: the model (scripted), the sandbox
(in memory), object storage, and the app a project previews (one static page). Nothing reaches E2B,
OpenRouter, R2 or GitHub, so a run costs nothing. Never add `--real` or any real credential to this.

## Launch

```bash
bun run verify-nap:up            # web :3057, API :3058, previewed app :3059, Chrome DevTools :3060
bun run verify-nap:up --port=4057      # a second run beside the first: all four ports move together
bun run verify-nap:up --ttl-minutes=30 # stops itself after this long (default 120)
bun run verify-nap:up --production     # next build + next start: for timing navigation, which
                                       # Next prefetches only in a production build
```

Run it in the background, because it stays up until you stop it or its `--ttl-minutes` pass. It is ready when it prints
`verify-nap ready` followed by the run file, which is also written to `.scratch/verify-nap-<id>/run.json`.
The first start takes 1 to 3 minutes: it pulls up Postgres, runs a seed turn, copies the web app and
waits for Next's first compile.

On startup it:

- signs up `verify@nap.test` with a password generated for the run, kept in `run.json`
  (`signin` reads it from there);
- seeds one finished session, **Seeded notes app**, with `src/App.tsx` and `src/components/NoteList.tsx`;
- serves the web app from a copy under the run directory. Next allows one dev server per app
  directory, so this does not collide with a `bun run dev` you already have open;
- starts its own headless Chrome with its own profile. Every driver command attaches to that
  Chrome, so the sign-in and the open page carry over from one command to the next.

If a port is taken it refuses to start and names the port. Pass `--port`; never stop somebody
else's server to free it.

## Doctor

```bash
bun run verify-nap doctor
```

This is read-only. It checks that the fixture process is alive and still the one that wrote the
run, that the web app, the API's `/health`, the previewed app and Chrome's DevTools all answer, and,
by signing in and asking the API's `/models`, that every model it offers is a scripted `verify/`
fake. Run it first, and again whenever anything looks wrong.

Each driver command finds the run by itself when exactly one is up. With two up it refuses and
lists them; pass `--run=.scratch/verify-nap-<id>` or set `VERIFY_NAP_RUN`.

## Drive

Each command does one thing, prints the page URL, and exits non-zero on failure. Targets are ARIA
roles plus accessible names, matched exactly unless you add `--loose`. Do not use CSS selectors.

```bash
bun run verify-nap signin                                   # idempotent; lands on /dashboard
bun run verify-nap goto /dashboard
bun run verify-nap click --role button --name "New session"
bun run verify-nap hover --role link --name "Seeded notes app" --loose  # reveals Snooze/Settle
bun run verify-nap click --role link --name "Seeded notes app" --loose --right  # the session menu
bun run verify-nap fill  --role textbox --name "Message" --value "Add a search box"
bun run verify-nap press --key Enter
bun run verify-nap wait  --role button --name "Stop" --state hidden --timeout 30000
bun run verify-nap wait  --text "Read at this step"
bun run verify-nap snapshot --label "chat after steer"     # prints the ARIA tree and saves it
bun run verify-nap shot  --label "chat after steer" [--full]   # PNG + ARIA tree side by side
bun run verify-nap click --role button --name "Add note" --frame "App preview"  # inside the preview
bun run verify-nap resize --width 390 --height 844       # a phone; later commands keep it
bun run verify-nap url
```

When you don't know a control's name, run `snapshot` and read it off the tree. Don't guess from the
source, because the tree is what a user's screen reader gets. Every recipe is in
[`features/`](features/README.md).

Flags are strict: an unknown flag is an error, and a value flag takes the next argument even when it
starts with `--`.

Every action waits for React to hydrate first. Before hydration, text typed into a field is wiped
and a click submits the form natively. On a first `next dev` request that can last several
seconds while the page already looks ready.

**What a turn looks like on the fakes.** Every turn takes about 7.5 s: two steps that each write a
file (`src/App.tsx` and `src/components/NoteList.tsx` on the first turn of the run, and
`src/features/Change<n>.tsx` plus `change<n>.css` after that, with `<n>` counting agent turns), then
an answer that begins
`Done. The newest message I read was: "<your words>"`. Each step waits 2.5 s, which leaves room to
steer. If a steer was read, the answer quotes the steer. A session started from the dashboard is
titled by the fake model `Fixture title <nnn>`: one counter for the whole run, zero-padded
(`Fixture title 001`), so no two sessions match. "Test the app" stays
disabled because the fake model is not image-capable.

## Evidence

Everything goes in `.scratch/verify-nap-<id>/evidence/`, which is gitignored, numbered in capture
order:

- `NN-<label>.png`: the screenshot, from `shot`.
- `NN-<label>.aria.yml`: the ARIA tree with its URL and time, from `shot` and `snapshot`.
- `NN-failed-<command>.png` / `.aria.yml`: written on its own whenever an action fails.

Screenshots hide Next's dev-mode badge, which is not part of the app.

Proof standards:

- Go through the user's path: sign in, click and type. Don't write to the database and don't call
  the API directly to set up the state you want to show.
- Capture the action as well as its result. For a steer that means the composer with the text in
  it, the steer waiting, and the steer read, not just the last screen.
- Check the side effect from a second view. A file the turn wrote should appear in the Files tab
  and open with its contents; a settled session should move under **Settled**.
- Put the screenshots in the PR. To attach them, copy the PNGs into `docs/assets/<topic>/` (as
  `docs/assets/computer-use/` does) or upload them to the PR. Don't commit `.scratch/`.
- Say which entry point you drove. A feature file that lists three entry points is not proven by
  driving one of them.

## Cleanup

```bash
bun run verify-nap stop
```

This sends SIGTERM to the fixture's own pid from `run.json` and waits. The fixture then stops
Chrome, Next, the API, the worker and the preview server, removes the Postgres container, the web
copy and the Chrome profile, and writes `cleanup.json`. It keeps `evidence/`, `run.json`,
`cleanup.json` and `web.log`, and `stop` prints how many evidence files survived. Don't kill
processes by name: a person's own Chrome or `next dev` may be running. If `stop` reports a failure,
`cleanup.json` names what is left.

Ctrl-C works too when the fixture is in the foreground. A run that fails during startup cleans up
after itself.

If the fixture was killed without cleaning up (SIGKILL, or the session that started it ended), run
`bun run verify-nap stop` anyway. The fixture records what it starts in `started.json` as it goes,
and `stop` removes what is left: the Postgres container, Next and Chrome. It first checks that each
pid's command line still names this run, so a pid the OS has reused is never signalled. A run you
forget stops itself after `--ttl-minutes`.

## Files

- `apps/api/scripts/verify-nap.ts` is the fixture: the composition, the seed, the processes and cleanup.
- `apps/api/scripts/verify-nap-model.ts` is the scripted model.
- `apps/verify-nap/scripts/verify-nap.ts` is the driver. It lives in `apps/verify-nap` because
  `test/architecture.ts` keeps `playwright-core` there, out of anything that ships.
- `apps/verify-nap/scripts/verify-nap-cli.ts` holds the command grammar and the run-file schema.

## Keeping the map true

A feature file that no longer matches the app claims coverage that isn't there. When a change
renames a control or moves a flow, update its feature file in the same PR, and only with names you
have just driven. To maintain the whole map, read each feature file against the current source,
drive every one of them in a single run, and keep only the corrections you proved.
