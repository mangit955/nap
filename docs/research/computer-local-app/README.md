# Real local computer integration

Status: the actual authenticated UI completed the local Test → recording → explicit Fix it → owner input → passing retest flow. See [native integration evidence](integration/README.md).

Run `bun run computer:local` from the repository root with Docker running. It builds or reuses a local image, creates its own disposable Postgres and Docker sandbox, seeds the Notes app through Nap's runtime, then prints the workspace URL at `http://127.0.0.1:3047/p/<project-id>`. Sign in with `reader@computer.test` / `Computer-local-42`. The API is on 3048. Occupied launcher ports cause startup to fail rather than replace another service.

Open Computer through the right panel's Add panel menu. Live view, idle Take control, physical input, screenshots, source files, Git, Vite checks and ffmpeg recordings use the real Docker machine. Click Test the app to detect the deliberately broken Save action. Watch recording plays the actual capture. Fix it explicitly changes `src/App.tsx`; the next Test the app should pass. The project name and transcript disclose that the model follows a fixed Notes scenario. This is an integration environment, not a general-purpose autonomous model. Objects and recordings are RAM-only and disappear when the launcher stops.

Stop the launcher with Ctrl-C. It closes its exact owned containers, bridges, database client, worker, isolated Next copy and server. Shared Docker image caches remain. The old demo's ports and database are outside its ownership.

The opt-in free browser check runs against a freshly seeded launcher, using its printed run directory:

```sh
NAP_COMPUTER_LOCAL_MANIFEST=<run-directory>/run.json \
NAP_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
bunx vitest run --project integration apps/napbench/src/computer-local.integration.test.ts --maxWorkers=1
```

A repeated identical source-writing turn has no new checkpoint and is unverified. The acceptance harness therefore starts from a fresh seeded launcher, rather than rewriting identical code before testing.

## Design decision

Use [candidate A](design/candidate-a.md), as the [independent judge](design/judge.md) recommends. Candidate B's simulated files cannot repair the app Chrome displays. Graft B's concurrent cancellation exec, raw TCP bridging, shared shutdown promise, immediate resource registration and negative acceptance cases. Reject its production desktop type change and fake source/check pipeline.

Keep LocalDockerSandboxManager in API scripts, implementing the existing full SandboxManager port. Reuse E2BSandboxDesktop unchanged as desktop and recordings, PostgresProjectComputerAccess unchanged as the input authority, and composeNap as the only app composition. No production provider, dependencies, shared contract or conformance rules change merely to support this dev launcher.

Build a local image from the real template and existing desktop assets. Install Bun 1.3.13 from the repository's packageManager plus the verified Chrome156/Node24 recipe. Runtime is network-none with raw loopback TCP bridges for Vite5173 and VNC6080. Each command remains independent so cancellation can run beside an action. The local dev profile starts at 2 GiB, explicitly separate from production's unchanged 1-GiB template. Prior local 1-GiB peak saturation is not safe-headroom evidence.

Copy the actual web source/config into a run-owned ignored directory, symlink its node_modules, and use the normal installed Next CLI with API3048/UI3047. Use a relative tsconfig extends. The prototype proved programmatic conf.distDir did not bypass the original app-directory guard; an absolute tsconfig base caused Turbopack500. The corrected isolated copy returned200 while original3037 also returned200. Its exact owned process was stopped afterward.

Model disclosure must appear in the project name, launcher and scripted messages. Source changes and checks must run in the same container serving the browser. The scripted test states expectations before physical actions and derives its verdict only from its own subsequent read_dom tool result, never an edit counter. A buggy Notes source fails, explicit Fix it changes actual source, and the next test passes. RAM recordings disappear when the launcher stops.

The architecture skill's preferred Claude grounding runner hit the API rate limit, and Grok is disabled. Available Codex models produced the two isolated designs and judge; this is not a cross-family result. Both candidates were read fully. The parent corrected both designs' unsupported absolute-tsconfig advice using the actual prototype. The original smoke image has no Bun; the new image must install the pinned version.

## Execution and acceptance

1. Implement and test the Docker sandbox/bridge lifecycle and the independent transcript-driven scripted provider in isolated seams. Lead owns the actual composition, copied-web lifecycle and integration harness.
2. Start a disposable replacement on unused ports, leaving the old demo unchanged. Watch the actual Nap Computer pane, drive real Chrome through guarded owner input, and see its current framebuffer change. Another owner must receive404, unauthenticated access401, leased input409, and stale grants rejection.
3. Test the planted Notes bug, watch/seek/download its real ffmpeg capture, explicitly fix actual source, and retest successfully. Compare downloaded MP4 bytes with stored media and inspect timestamps. Exercise cancellation, encoder failure, lease loss and startup/shutdown rollback; inspect the real artifacts. Repeat cleanup and launch once more.
4. Verify new suites are collected in their intended projects and new scripts enter typecheck/Biome. Run full test, typecheck, lint, normal hooks, and a browser/production-build check appropriate to the web changes. Record guard failures. Commit local evidence and update existing open tickets.

The whole is VERIFIED only if the actual authenticated Nap UI completes that source-to-browser-to-recording path and owned cleanup succeeds while old3037–3039 remain healthy. E2B publication/proxy/SDK behavior, paid model capability trials, production memory headroom, and missing passive UI reference states remain separate open criteria. No paid operation, push or PR is authorized by this local plan.
