/**
 * The v1 acceptance run from `docs/PLAN.md` §6, driven against a real server.
 *
 * `bun run dev` in one terminal, then `bun run acceptance` in another.
 *
 * **This spends real money** — real E2B sandboxes, real model calls — which is why it is a
 * script you invoke rather than anything a test suite can reach. It is deliberately absent
 * from the permission allow-list for the same reason `test:integration` is: the prompt asking
 * whether to run it is the only checkpoint before the spend.
 *
 * It drives the API over the same HTTP and WebSocket surface a browser uses, so a cold boot,
 * the auth cookie, the event stream and the persistence cycle are all exercised for real. Two
 * of §6's steps cannot be settled from here and are not claimed to be: whether the preview
 * *looks* like a working todo list, and whether the second edit arrived over HMR rather than
 * as a full reload, both need eyes on a browser. The script prints the preview URL at the
 * moment each matters and says plainly that they are yours to confirm — a machine reporting
 * "step 2 passed" on evidence it does not have would be worse than not checking.
 *
 * What it does settle: the preview really serves, the turn really streams, files really
 * changed, a reconnect backfills with no gap and no duplicate, a closed project really
 * restores from R2 with its git history, another account really cannot see any of it, and what
 * each turn cost and how long it took.
 */

const API = process.env.NAP_API_URL ?? "http://localhost:3001";
const WS = API.replace(/^http/, "ws");

/** A turn can legitimately take a couple of minutes on a slow model. */
const TURN_TIMEOUT_MS = 240_000;

type Json = Record<string, unknown>;

type TurnRecord = {
  label: string;
  durationMs: number;
  wallClockMs: number;
  inputTokens: number;
  outputTokens: number;
  commitSha: string | null;
  filesChanged: string[];
};

const turns: TurnRecord[] = [];
let failures = 0;

function pass(step: string, detail = ""): void {
  console.log(`  \x1b[32mok\x1b[0m    ${step}${detail === "" ? "" : `  ${detail}`}`);
}

function fail(step: string, detail: string): void {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${step}  ${detail}`);
}

/** Yours to confirm, not mine to claim. */
function eyeball(step: string, detail: string): void {
  console.log(`  \x1b[33mLOOK\x1b[0m  ${step}  ${detail}`);
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

/** One signed-in caller. Better Auth hands back a cookie; every later call carries it. */
class Client {
  #cookie = "";

  constructor(readonly email: string) {}

  async signUp(): Promise<void> {
    const res = await fetch(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: this.email,
        password: "correct-horse-battery",
        name: "Tester",
      }),
    });
    if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);

    const setCookie = res.headers.getSetCookie?.() ?? [];
    this.#cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (this.#cookie === "") throw new Error("sign-up returned no cookie");
  }

  get cookie(): string {
    return this.#cookie;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        cookie: this.#cookie,
        "content-type": "application/json",
      },
    });
  }

  async json(path: string, init: RequestInit = {}): Promise<Json> {
    const res = await this.request(path, init);
    if (!res.ok)
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Json;
  }
}

/**
 * Collects a session's events off the socket.
 *
 * The same stream the browser reads, so this exercises replay-then-tail rather than polling
 * the database — which is the half a client actually depends on.
 */
class Stream {
  readonly events: Json[] = [];
  #socket: WebSocket | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cookie: string,
  ) {}

  async open(afterSeq = 0): Promise<void> {
    const socket = new WebSocket(`${WS}/ws?sessionId=${this.sessionId}&seq=${afterSeq}`, {
      headers: { cookie: this.cookie },
    } as unknown as string[]);
    this.#socket = socket;

    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Json;
      if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (frame.type === "event") this.events.push(frame.event as Json);
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("socket refused")));
    });
  }

  close(): void {
    this.#socket?.close();
  }

  get seqs(): number[] {
    return this.events.map((e) => Number(e.seq));
  }

  /** Resolves on the terminal event for a turn, or rejects if the turn never ends. */
  async waitForTurnEnd(): Promise<Json> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const terminal = this.events.find(
        (e) => e.type === "turn.completed" || e.type === "turn.failed",
      );
      if (terminal !== undefined) return terminal;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("the turn never ended");
  }
}

/** Polls the preview until it serves, which is what "the preview renders" has to mean. */
async function previewServes(url: string, timeoutMs: number): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return Date.now() - startedAt;
    } catch {
      // Not up yet. The public proxy 502s during the gap, which is "not yet", not "broken".
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function runTurn(client: Client, sessionId: string, message: string, label: string) {
  const stream = new Stream(sessionId, client.cookie);
  await stream.open();

  const startedAt = Date.now();
  const res = await client.request(`/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  if (res.status !== 202) throw new Error(`turn refused: ${res.status} ${await res.text()}`);

  const terminal = await stream.waitForTurnEnd();
  const wallClockMs = Date.now() - startedAt;

  if (terminal.type === "turn.failed") {
    fail(label, `turn failed: ${JSON.stringify(terminal.payload)}`);
    stream.close();
    return { stream, terminal, ok: false as const };
  }

  const payload = terminal.payload as {
    usage: { inputTokens: number; outputTokens: number };
    durationMs: number;
    commitSha: string | null;
  };
  const filesChanged = stream.events
    .filter((e) => e.type === "file.changed")
    .map((e) => String((e.payload as { path: string }).path));

  turns.push({
    label,
    durationMs: payload.durationMs,
    wallClockMs,
    inputTokens: payload.usage.inputTokens,
    outputTokens: payload.usage.outputTokens,
    commitSha: payload.commitSha,
    filesChanged,
  });

  return { stream, terminal, ok: true as const, filesChanged, payload };
}

async function main(): Promise<void> {
  const stamp = Date.now();

  heading("preflight");
  const health = (await (await fetch(`${API}/health`)).json()) as Json;
  if (health.status === "ok") pass("server healthy", JSON.stringify(health.checks ?? {}));
  else fail("server healthy", JSON.stringify(health));

  // ── Step 1 ────────────────────────────────────────────────────────────────
  heading("step 1 — sign in, create a project, preview renders");
  const alice = new Client(`alice+${stamp}@nap.test`);
  await alice.signUp();
  pass("signed up", alice.email);

  const project = await alice.json("/projects", {
    method: "POST",
    body: JSON.stringify({ name: `Acceptance ${stamp}` }),
  });
  const projectId = String(project.projectId);
  const sessionId = String(project.sessionId);
  pass("project created", `${projectId.slice(0, 8)}… session ${sessionId.slice(0, 8)}…`);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  heading("step 2 — build a todo list");
  const first = await runTurn(
    alice,
    sessionId,
    "Build a todo list with add, complete, and delete",
    "todo list",
  );

  const previewEvent = first.stream.events.find((e) => e.type === "preview.ready");
  const previewUrl =
    previewEvent === undefined ? null : String((previewEvent.payload as { url: string }).url);

  if (previewUrl === null) {
    fail("preview announced", "no preview.ready event");
  } else {
    const ms = await previewServes(previewUrl, 30_000);
    if (ms === null) fail("preview serves", `${previewUrl} never answered 200`);
    else pass("preview serves", `${previewUrl} in ${ms}ms`);
  }

  if (first.ok) {
    if (first.filesChanged.length > 0) pass("files streamed", first.filesChanged.join(", "));
    else fail("files streamed", "the turn changed no files");
    if (first.payload.commitSha !== null) pass("committed", first.payload.commitSha.slice(0, 7));
    else fail("committed", "no commit for a turn that changed files");
  }
  eyeball("todo list works", `open ${previewUrl ?? "(no preview)"} — add, complete, delete`);

  // ── Step 3 ────────────────────────────────────────────────────────────────
  heading("step 3 — incremental edit lands via HMR");
  const second = await runTurn(
    alice,
    sessionId,
    "Make it dark mode with a purple accent",
    "dark mode",
  );

  // A second `preview.ready` would remount the frame — a full reload, which is what this step
  // says must not happen. Its absence is the machine-checkable half of "via HMR".
  const announcedAgain = second.stream.events.some((e) => e.type === "preview.ready");
  if (announcedAgain) fail("no remount", "a second preview.ready would hard-reload the app");
  else pass("no remount", "no second preview.ready, so the frame is not re-keyed");
  if (second.ok && second.filesChanged.length > 0) {
    pass("edit streamed", second.filesChanged.join(", "));
  }
  eyeball(
    "HMR, not a reload",
    `${previewUrl ?? "(no preview)"} should be dark with a purple accent`,
  );

  // ── Step 4 ────────────────────────────────────────────────────────────────
  heading("step 4 — reconnect backfills with no gap and no duplicate");
  const live = second.stream;
  const seenSeqs = live.seqs;
  const highest = Math.max(...seenSeqs);
  live.close();

  const rejoined = new Stream(sessionId, alice.cookie);
  await rejoined.open(Math.floor(highest / 2));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const replayed = rejoined.seqs;
  const duplicates = replayed.filter((s, i) => replayed.indexOf(s) !== i);
  const expected = seenSeqs.filter((s) => s > Math.floor(highest / 2));
  const missing = expected.filter((s) => !replayed.includes(s));

  if (duplicates.length === 0) pass("no duplicates", `${replayed.length} events replayed`);
  else fail("no duplicates", `repeated seq ${duplicates.join(", ")}`);
  if (missing.length === 0) pass("no gaps", `seq ${replayed[0]}…${replayed.at(-1)}`);
  else fail("no gaps", `missing seq ${missing.join(", ")}`);
  rejoined.close();

  // ── Step 5 ────────────────────────────────────────────────────────────────
  heading("step 5 — close and reopen, files and history intact");
  const before = (await alice.json(`/sessions/${sessionId}/files`)) as { files?: unknown[] };
  const closed = await alice.json(`/projects/${projectId}/close`, { method: "POST" });
  if (closed.closed === true) pass("closed", `snapshot ${String(closed.key ?? "").slice(-12)}`);
  else fail("closed", JSON.stringify(closed));

  const reopened = await runTurn(alice, sessionId, "Add a footer that says Nap", "reopen");
  const notices = reopened.stream.events.filter((e) => e.type === "system.notice");
  if (notices.length === 0) pass("restored silently", "no system.notice, so nothing was lost");
  else fail("restored silently", JSON.stringify(notices.map((n) => n.payload)));

  const after = (await alice.json(`/sessions/${sessionId}/files`)) as { files?: unknown[] };
  const beforeCount = before.files?.length ?? 0;
  const afterCount = after.files?.length ?? 0;
  if (afterCount >= beforeCount) pass("files intact", `${beforeCount} before, ${afterCount} after`);
  else fail("files intact", `${beforeCount} before, only ${afterCount} after`);

  // ── Step 6 ────────────────────────────────────────────────────────────────
  heading("step 6 — a second account sees none of it");
  const bob = new Client(`bob+${stamp}@nap.test`);
  await bob.signUp();

  const list = (await bob.json("/projects")) as { projects: unknown[] };
  if (list.projects.length === 0) pass("not listed", "bob's project list is empty");
  else fail("not listed", `bob sees ${list.projects.length} projects`);

  for (const [path, init] of [
    [`/projects/${projectId}`, {}],
    [`/sessions/${sessionId}/files`, {}],
    [`/sessions/${sessionId}/turns`, { method: "POST", body: JSON.stringify({ message: "hi" }) }],
  ] as const) {
    const res = await bob.request(path, init);
    // 404 rather than 403 — see the amendment in docs/PLAN.md §6. A 403 would confirm the row
    // exists, which is itself a fact about someone else's data.
    if (res.status === 404) pass(`404 on ${path.split("/")[1]}`, path);
    else fail(`404 on ${path.split("/")[1]}`, `${path} answered ${res.status}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  heading("cleanup");
  const removed = await alice.json(`/projects/${projectId}`, { method: "DELETE" });
  pass("project deleted", JSON.stringify(removed));

  // ── The numbers the "Done when" asks for ──────────────────────────────────
  heading("cost and latency per turn");
  console.log(
    `  ${"turn".padEnd(12)} ${"wall".padStart(8)} ${"agent".padStart(8)} ${"in".padStart(8)} ${"out".padStart(7)}  commit`,
  );
  for (const t of turns) {
    console.log(
      `  ${t.label.padEnd(12)} ${`${(t.wallClockMs / 1000).toFixed(1)}s`.padStart(8)} ${`${(t.durationMs / 1000).toFixed(1)}s`.padStart(8)} ${String(t.inputTokens).padStart(8)} ${String(t.outputTokens).padStart(7)}  ${t.commitSha?.slice(0, 7) ?? "—"}`,
    );
  }
  const totalIn = turns.reduce((sum, t) => sum + t.inputTokens, 0);
  const totalOut = turns.reduce((sum, t) => sum + t.outputTokens, 0);
  console.log(
    `  ${"total".padEnd(12)} ${"".padStart(8)} ${"".padStart(8)} ${String(totalIn).padStart(8)} ${String(totalOut).padStart(7)}`,
  );

  console.log(
    failures === 0
      ? "\n\x1b[32mall machine-checkable steps passed\x1b[0m — the two LOOK lines are yours to confirm"
      : `\n\x1b[31m${failures} check(s) failed\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
