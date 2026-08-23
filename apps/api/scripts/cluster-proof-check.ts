/**
 * The two things about a multi-pod deployment that no manifest can assert.
 *
 * 1. **A turn submitted to any pod completes and streams to a socket on any other pod.** The
 *    request is admitted on API pod A, executed by a worker pod that neither of them can name, and
 *    every event of it arrives on a socket held by API pod B — which is only true because the
 *    queue and the fanout are both in Postgres.
 * 2. **A rolling restart of the API loses no events.** The socket dies mid-turn with the pod that
 *    held it; the client reconnects with the last `seq` it saw and gets exactly the gap — no
 *    missing event, no duplicate, and the turn it was watching still ends.
 *
 * Driven by `infra/k8s/proof/run.sh`, which brings up the cluster and hands this three addresses:
 * two individual API pods, and the ingress that fronts all of them. Run it against anything else
 * that satisfies those — it knows nothing about kind beyond the `kubectl rollout restart` it
 * shells out to.
 *
 * It spends nothing: the pods it talks to run `cluster-proof.ts`, whose model and sandbox are
 * fakes. What is being exercised is the layer that used to be single-process.
 */

import { type ServerFrame, ServerFrameSchema } from "@nap/shared/ws-protocol";

type Json = Record<string, unknown>;

function arg(name: string): string {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (found === undefined) {
    console.error(`usage: cluster-proof-check.ts --a=<url> --b=<url> --ingress=<url>`);
    process.exit(1);
  }
  return found.slice(name.length + 3);
}

const A = arg("a");
const B = arg("b");
const INGRESS = arg("ingress");

/** A turn against a fake model still has a sandbox to "create" and a dev server to "start". */
const TURN_TIMEOUT_MS = 120_000;

/**
 * Comfortably past ingress-nginx's own 60-second idle timeout, which is the number the manifest's
 * annotations exist to override. Nothing is sent down the socket during it except the pings the
 * server starts on its own.
 */
const IDLE_HOLD_MS = 90_000;

let failures = 0;

function pass(step: string, detail = ""): void {
  console.log(`  \x1b[32mok\x1b[0m    ${step}${detail === "" ? "" : `  ${detail}`}`);
}

function fail(step: string, detail: string): void {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${step}  ${detail}`);
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

/**
 * One caller, whose cookie works against every pod.
 *
 * That it does is itself part of what is being proven: the session is a row, so any pod can
 * verify it, and the `base` this is pointed at is free to change between requests.
 */
class Client {
  #cookie = "";

  async signIn(base: string): Promise<void> {
    const res = await fetch(`${base}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`anonymous sign-in failed: ${res.status} ${await res.text()}`);
    this.#cookie = (res.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    if (this.#cookie === "") throw new Error("sign-in returned no cookie");
  }

  get cookie(): string {
    return this.#cookie;
  }

  async json(base: string, path: string, init: RequestInit = {}): Promise<Json> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        cookie: this.#cookie,
        "content-type": "application/json",
      },
    });
    if (!res.ok)
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Json;
  }

  async post(base: string, path: string, body: Json): Promise<Response> {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: this.#cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

type Storedish = { seq: number; type: string; turnId: string | null };

/**
 * One socket, reconnectable — which is the whole subject of the second check.
 *
 * It remembers the highest `seq` it has seen, so a reconnect asks for exactly the gap. That is
 * what a browser does, and what makes a rolling restart survivable rather than merely quick.
 */
class Stream {
  readonly events: Storedish[] = [];
  #socket: WebSocket | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cookie: string,
  ) {}

  get lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  async open(base: string): Promise<void> {
    const url = `${base.replace(/^http/, "ws")}/ws?sessionId=${this.sessionId}&seq=${this.lastSeq}`;
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    this.#socket = socket;

    socket.addEventListener("message", (message) => {
      const frame: ServerFrame = ServerFrameSchema.parse(JSON.parse(String(message.data)));
      // Answering the heartbeat is not optional: a client that never speaks is closed at 150s,
      // and the restart check holds this socket open for longer than that.
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "event") {
        this.events.push({
          seq: frame.event.seq,
          type: frame.event.type,
          turnId: frame.event.turnId ?? null,
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error(`the socket to ${base} failed`)));
    });
  }

  close(): void {
    this.#socket?.close();
  }

  /** Waits for whichever event ends the turn, and reports which one it was. */
  async waitForTurnEnd(from: number): Promise<Storedish> {
    const terminal = new Set(["turn.completed", "turn.failed"]);
    const startedAt = Date.now();
    for (;;) {
      const found = this.events.slice(from).find((event) => terminal.has(event.type));
      if (found !== undefined) return found;
      if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
        throw new Error(
          `no terminal event within ${TURN_TIMEOUT_MS}ms; saw ${this.events
            .slice(from)
            .map((event) => event.type)
            .join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** `seq` must be contiguous from the client's point of view: nothing missed, nothing twice. */
function gapsIn(events: Storedish[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]?.seq ?? 0;
    const current = events[index]?.seq ?? 0;
    if (current === previous) problems.push(`seq ${current} arrived twice`);
    else if (current !== previous + 1) problems.push(`seq jumped ${previous} → ${current}`);
  }
  return problems;
}

async function kubectl(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["kubectl", ...args], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`kubectl ${args.join(" ")} exited ${code}`);
}

async function main(): Promise<void> {
  heading("preflight");
  for (const [label, base] of [
    ["pod A", A],
    ["pod B", B],
    ["ingress", INGRESS],
  ] as const) {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as Json;
    if (res.ok && body.status === "ok") pass(`${label} healthy`, base);
    else fail(`${label} healthy`, `${res.status} ${JSON.stringify(body)}`);
  }

  // ── one ───────────────────────────────────────────────────────────────────
  heading("a turn crosses pods");
  const client = new Client();
  // Signed in on A, and every later request is made against B or the ingress: the session is a
  // row, so no pod has to have seen this caller before.
  await client.signIn(A);
  pass("signed in anonymously", "on pod A");

  const project = await client.json(B, "/projects", {
    method: "POST",
    body: JSON.stringify({ name: "cluster proof" }),
  });
  const sessionId = String(project.sessionId);
  pass("project created", `on pod B, session ${sessionId.slice(0, 8)}…`);

  // The socket is on B. The turn will be submitted to A and executed by a worker that is neither.
  const stream = new Stream(sessionId, client.cookie);
  await stream.open(B);
  pass("socket opened", "on pod B");

  const from = stream.events.length;
  const submitted = await client.post(A, `/sessions/${sessionId}/turns`, {
    message: "add a toggle",
  });
  if (submitted.status === 202) pass("turn accepted", "on pod A, 202");
  else fail("turn accepted", `${submitted.status} ${await submitted.text()}`);

  const terminal = await stream.waitForTurnEnd(from);
  if (terminal.type === "turn.completed") {
    pass("turn completed", `${stream.events.length - from} events, all of them on pod B's socket`);
  } else {
    fail("turn completed", `ended as ${terminal.type}`);
  }

  const crossPodGaps = gapsIn(stream.events);
  if (crossPodGaps.length === 0) pass("no gaps in the stream", `seq 1..${stream.lastSeq}`);
  else fail("no gaps in the stream", crossPodGaps.join("; "));

  // ── two ───────────────────────────────────────────────────────────────────
  heading("a rolling restart of the API loses nothing");
  const restartStream = new Stream(sessionId, client.cookie);
  // Through the ingress this time, because a client reconnecting has no idea which pod it lands
  // on — and must not need one.
  await restartStream.open(INGRESS);
  const before = restartStream.lastSeq;
  pass("socket opened", `through the ingress, caught up to seq ${before}`);

  const during = await client.post(INGRESS, `/sessions/${sessionId}/turns`, {
    message: "add another toggle",
  });
  if (during.status !== 202)
    fail("second turn accepted", `${during.status} ${await during.text()}`);

  await kubectl("-n", "nap", "rollout", "restart", "deployment/nap-api");
  pass("rollout restarted", "every API pod replaced under a live socket");

  // The socket dies with the pod that held it. A browser notices and reconnects from the last
  // `seq` it saw; so does this.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  restartStream.close();

  let reconnected = false;
  for (let attempt = 0; attempt < 60 && !reconnected; attempt += 1) {
    try {
      await restartStream.open(INGRESS);
      reconnected = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  if (reconnected) pass("reconnected", `asked for everything after seq ${restartStream.lastSeq}`);
  else fail("reconnected", "the ingress never came back");

  const secondTurn = await restartStream.waitForTurnEnd(0);
  if (secondTurn.type === "turn.completed")
    pass("the interrupted turn still ended", secondTurn.type);
  else fail("the interrupted turn still ended", `ended as ${secondTurn.type}`);

  const restartGaps = gapsIn(restartStream.events);
  if (restartGaps.length === 0) {
    pass("no event lost or repeated across the restart", `up to seq ${restartStream.lastSeq}`);
  } else {
    fail("no event lost or repeated across the restart", restartGaps.join("; "));
  }

  await kubectl("-n", "nap", "rollout", "status", "deployment/nap-api", "--timeout=180s");
  restartStream.close();

  // ── three ─────────────────────────────────────────────────────────────────
  heading("the ingress outlasts an idle socket");
  // The claim the annotations make, exercised rather than read. ingress-nginx closes an idle
  // upstream connection after 60 seconds by default, and a Nap socket is idle by design between
  // turns — so this waits past that default, with nothing but the application's own heartbeat
  // keeping the connection interesting, and then puts a turn down it.
  const idle = new Stream(sessionId, client.cookie);
  await idle.open(INGRESS);
  const idleFrom = idle.events.length;
  await new Promise((resolve) => setTimeout(resolve, IDLE_HOLD_MS));

  const afterIdle = await client.post(INGRESS, `/sessions/${sessionId}/turns`, {
    message: "and one more",
  });
  if (afterIdle.status !== 202) {
    fail("a turn after the idle wait", `${afterIdle.status} ${await afterIdle.text()}`);
  }

  try {
    const third = await idle.waitForTurnEnd(idleFrom);
    if (third.type === "turn.completed") {
      pass(
        "the socket survived the wait",
        `${Math.round(IDLE_HOLD_MS / 1000)}s idle, then streamed a whole turn`,
      );
    } else {
      fail("the socket survived the wait", `the turn ended as ${third.type}`);
    }
  } catch (error) {
    fail("the socket survived the wait", String(error));
  }

  idle.close();
  stream.close();

  heading(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
