# Local Docker computer app candidate A

## Use it

```text
bun run computer:local
# UI:      http://127.0.0.1:3047
# API:     http://127.0.0.1:3048
# MODEL:   SCRIPTED LOCAL (no model or cloud call)
# STORAGE: RAM ONLY (recordings disappear when this launcher exits)
# RUNTIME: real Docker Chrome, container network=none
```

The launcher fails before allocating anything if 3047 or 3048 is occupied. It creates a new owner, project, database container, sandbox container, and temp web directory.
It never probes, stops, or reuses the processes, database, or build output serving 3037, 3038, or 3039. The project title is `Local Docker / SCRIPTED MODEL / RAM RECORDINGS`, and every scripted assistant message carries the same label.
The walkthrough is Build buggy app, Test with live Chrome, watch failed MP4, Fix it through the normal turn path, then Test again and watch the passing MP4.

## Exact seam

Add one deep adapter, `LocalDockerSandboxManager implements SandboxManager`. Everything above that boundary stays production code: `E2BSandboxDesktop` is passed unchanged as both `desktop` and `recordings`;
`PostgresProjectComputerAccess` protects owner-only stream and idle-only input; `composeApp` supplies the real queue, lease, event, snapshot, turn, test, and recording routes. Keep the E2B-specific class name for now.

The sandbox is not a fixture. `/home/user/app` contains the real template, `.git`, installed packages, and Vite process. File methods, exec, snapshot restore, git diff/commit, and checks all operate there.
Nonzero commands remain typed command results, not transport failures. No edit counter, fake file map, fake shell output, fake browser, or synthetic video is used.

## Caller first

```ts
const manager = unwrap(await LocalDockerSandboxManager.open({ repoRoot, runId, timeoutMs: 15 * 60_000 }));
const desktop = new E2BSandboxDesktop({ sandbox: manager });
const app = await composeApp({
  sandbox: manager, desktop, recordings: desktop,
  computerAccess: { access: new PostgresProjectComputerAccess(db), secret },
  objects: new InMemoryObjectStore(), provider: createLocalScriptedProvider(), role: "all",
});
const launched = unwrap(await launchLocalComputer({ app, manager, webPort: 3047, apiPort: 3048 }));
await launched.close();
```

## Public shape, bodies deliberately absent

```ts
type LocalDockerOptions = Readonly<{ repoRoot: string; runId: string; timeoutMs: number }>;
type LocalDockerError = Readonly<{
  kind: "docker_unavailable" | "image_build" | "container" | "bridge" | "cleanup";
  message: string; cause?: unknown;
}>;
type LocalAppHandle = Readonly<{ uiUrl: `http://127.0.0.1:${number}`; close(): Promise<void> }>;
const notImplemented = (): never => { throw new Error("not implemented"); };

export class LocalDockerSandboxManager implements SandboxManager {
  static open(_o: LocalDockerOptions): Promise<Result<LocalDockerSandboxManager, LocalDockerError>> {
    return notImplemented();
  }
  create(..._a: Parameters<SandboxManager["create"]>): ReturnType<SandboxManager["create"]> { return notImplemented(); }
  resume(..._a: Parameters<SandboxManager["resume"]>): ReturnType<SandboxManager["resume"]> { return notImplemented(); }
  destroy(..._a: Parameters<SandboxManager["destroy"]>): ReturnType<SandboxManager["destroy"]> { return notImplemented(); }
  extendTimeout(..._a: Parameters<SandboxManager["extendTimeout"]>): ReturnType<SandboxManager["extendTimeout"]> { return notImplemented(); }
  writeFile(..._a: Parameters<SandboxManager["writeFile"]>): ReturnType<SandboxManager["writeFile"]> { return notImplemented(); }
  readFile(..._a: Parameters<SandboxManager["readFile"]>): ReturnType<SandboxManager["readFile"]> { return notImplemented(); }
  listFiles(..._a: Parameters<SandboxManager["listFiles"]>): ReturnType<SandboxManager["listFiles"]> { return notImplemented(); }
  exec(..._a: Parameters<SandboxManager["exec"]>): ReturnType<SandboxManager["exec"]> { return notImplemented(); }
  getPreviewUrl(..._a: Parameters<SandboxManager["getPreviewUrl"]>): ReturnType<SandboxManager["getPreviewUrl"]> { return notImplemented(); }
  waitForPreview(..._a: Parameters<SandboxManager["waitForPreview"]>): ReturnType<SandboxManager["waitForPreview"]> { return notImplemented(); }
  close(): Promise<Result<void, LocalDockerError>> { return notImplemented(); }
}
export function createLocalScriptedProvider(): LLMProvider { return notImplemented(); }
export function launchLocalComputer(_o: LocalLaunchOptions): Promise<Result<LocalAppHandle, LocalLaunchError>> {
  return notImplemented();
}
```

## Docker and bridge

Build a content-addressed image from existing `TEMPLATE_FILES`, desktop driver/start script, and the smoke test's pinned Node 24, Bun, Chrome version, and Chrome SHA. Initialize real git and install real dependencies.
Retain the shared image cache; it is not run-owned. A cold build may use public package repositories but no paid service. Runtime uses `--network none --cpus 2 --memory 1g --memory-swap 1g --init`.

Start `docker run --rm -i` attached to a tiny supervisor that starts Vite, waits on stdin, and stops children on EOF. A killed launcher closes the pipe and normally removes the container.
Normal cleanup closes stdin, waits with a bound, then applies `docker rm -f` only to the recorded container ID.

`getPreviewUrl(port)` lazily binds `127.0.0.1:0`. Each socket starts `docker exec -i CONTAINER node /usr/local/lib/nap-local/tcp-forward.mjs 127.0.0.1 PORT` and pipes bytes with backpressure and half-close.
There is no protocol parser, TTY, published port, or host fixture route. It carries Vite and `/websockify`; Chrome reaches Vite through container loopback. Only authenticated `/stream` reveals VNC URL/password.
x11vnc stays view-only, so input still crosses the owner and idle-project guard.

File operations call a fixed in-image helper with validated path arguments and stdin bytes. Commands use
`docker exec -i -w /home/user/app ... sh -lc COMMAND`, passed as argv without a host shell, and stream
stdout/stderr separately. Resume verifies container ID plus run/project labels. Destroy tombstones IDs,
closes listeners and active execs, and is idempotent. Extend resets the local expiry timer.

## Scripted proof and real media

The transcript-driven provider uses ordinary write/exec tools to create buggy `src/App.tsx`, inspect the real diff, and accept only real typecheck/build exit zero. Fix-it replaces the bug through the same path.

Each app test calls `read_dom`, emits the named untested expectation before input, performs labeled mouse/keyboard actions, takes a post-input screenshot, calls `read_dom`, then decides only from `<li>Nap local proof</li>`.
The buggy source clears without appending; the fixed source appends. No JavaScript, test-time source edit, or hidden counter is used. Existing runtime records real ffmpeg/encoder-clock MP4 bytes and serves those same RAM-store bytes through existing range/download/playback routes.

## Isolated Nap UI

Do not use programmatic `next({ conf: { distDir } })` or a tiny dev config in the original app directory. Installed Next exposes `conf` only on the custom server path and replaces the loaded config; both variants retain the app identity/lock risk, and the prototype rejected a second server after detecting PID 31917. Leave it untouched.

Make a run-owned temp mirror of `apps/web`: copy `src`, `public`, package/config files, symlink repo `node_modules`, and generate a tsconfig extending the original by absolute path with `baseUrl` rebased to the mirror.
Run normal Next CLI under Node from the mirror. Its `.next` and lock are isolated; set API origin 3048 and delete only this exact directory at cleanup.

## Module map and implementation order

1. `packages/sandbox/src/local-docker-sandbox-manager.ts`: the sole new exported infrastructure module;
   image build, attached container, file helper calls, raw bridges, timers, tombstones, and close ledger.
2. `packages/sandbox/scripts/local-runtime/`: supervisor plus byte-forward/file helpers copied into image.
3. `apps/api/scripts/computer-local.ts`: scripted provider, web mirror, real composition, labels, and cleanup.
4. Adjacent `*.test.ts` files first: every export above starts red before its body is written. Cover argv
   safety, byte fidelity, streaming/nonzero results, labels/resume, timeout, tombstone, and double cleanup;
   cover transcript-derived fail/pass, real tool-result gating, mirror isolation, and occupied-port rollback.
5. Generalize the existing sandbox conformance assertion from E2B-shaped HTTPS names to a valid HTTP(S)
   URL, then run it against a real local container. Keep Docker/browser acceptance outside the unit suite.
6. Acceptance: real DOM screenshot; authenticated view stream; idle input succeeds and leased input is 409;
   failed then passing tests; MP4 has encoder timestamps; seek triggers a valid range; download bytes equal
   stored bytes; actual git diff/check output is visible. Finish with test, typecheck, lint, and build gates.

## Failure cleanup and rejected growth

Allocation records exact child PIDs, container IDs, listeners, temp paths, and unique Postgres ID. On error or signal: stop work, close Next/API and manager, stop only that database, remove only owned temp paths, and TERM-then-KILL recorded PIDs within bounds.
Repeating cleanup succeeds. The labeled cache image is deliberately retained.

Rejected: host/fake filesystem and shell because snapshots and checks would lie; a new desktop/VNC/recording
stack because production already supplies it; Docker port publishing because runtime must stay network-none;
a local E2B-shaped HTTP service because it adds a second protocol; R2/MinIO because RAM storage proves the
real media route with less machinery; and renaming/generalizing production desktop classes before this seam
works. The accepted cost is slow cold image build and one `docker exec` per bridged TCP connection.
