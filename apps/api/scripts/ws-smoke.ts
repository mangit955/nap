/**
 * Drives `/ws` over a real WebSocket, under Bun.
 *
 * `bun run ws:smoke`
 *
 * Everything the endpoint decides — what to replay, what to tail, when to close a silent
 * connection — is unit-tested against a fake socket, because Vitest runs under Node and the
 * upgrade needs a running `Bun.serve`. What is left over is exactly what this exercises: the
 * upgrade itself, the `websocket` handler that `index.ts` exports, and that Hono's
 * `WSContext` really satisfies the two methods the connection expects.
 *
 * Free and repeatable: an in-memory store, an ephemeral port, no database and no network.
 * It exits non-zero on the first thing that does not hold, so it is worth running after any
 * change to the route or the connection.
 */

import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { type ServerFrame, ServerFrameSchema, WS_CLOSE } from "@nap/shared/ws-protocol";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const PROJECT = "1f2e3d4c-5b6a-4798-8765-43210fedcba9";
const OWNER = "00000000-0000-4000-8000-000000000001";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

/** Short enough to watch a connection die, long enough not to race the handshake. */
const HEARTBEAT = { intervalMs: 250, timeoutMs: 1000 };

const store = new InMemoryEventStore();
const bus = new InProcessEventBus();

function message(text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId: SESSION,
    turnId: TURN,
    createdAt: new Date().toISOString(),
    payload: { text },
  };
}

async function emit(text: string): Promise<StoredEvent> {
  const stored = await store.append(message(text));
  bus.publish(stored);
  return stored;
}

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok    ${name}${detail === "" ? "" : `  ${detail}`}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail === "" ? "" : `  ${detail}`}`);
}

/** Resolves once `predicate` holds over the frames received so far, or rejects on timeout. */
function waitFor(
  received: ServerFrame[],
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll);
        reject(
          new Error(`timed out waiting for ${what}; frames so far: ${JSON.stringify(received)}`),
        );
      }
    }, 10);
  });
}

async function main(): Promise<void> {
  for (let i = 1; i <= 10; i++) await store.append(message(`event ${i}`));

  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    // `/ws` is a guarded route: it streams everything that happens in somebody's project, so
    // it needs a caller and a way to check the session belongs to them. Standing both in here
    // keeps this script about the socket rather than about sign-in.
    authenticate: async () => ({ userId: OWNER, isAnonymous: false }),
    // A heartbeat measured in milliseconds rather than the half-minute a real deployment
    // uses, so a silent connection can be watched dying inside one run.
    stream: {
      store,
      bus,
      sessions: new InMemorySessionStore([
        { sessionId: SESSION, projectId: PROJECT, userId: OWNER },
      ]),
      upgradeWebSocket,
      heartbeat: HEARTBEAT,
    },
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  const base = `ws://localhost:${server.port}/ws`;
  console.log(`serving on ${server.url}`);

  // A bad query is refused before any upgrade, with a readable reason.
  const bad = await fetch(`http://localhost:${server.port}/ws?sessionId=nope`);
  check("bad query refused", bad.status === 400, `status ${bad.status}`);

  const received: ServerFrame[] = [];
  const events = () => received.flatMap((f) => (f.type === "event" ? [f.event.seq] : []));
  let closed: { code: number; reason: string } | undefined;

  const socket = new WebSocket(`${base}?sessionId=${SESSION}&seq=5`);
  socket.addEventListener("message", (event) => {
    // Parsed, not trusted: a frame the client cannot understand is a failed smoke test.
    const frame = ServerFrameSchema.parse(JSON.parse(String(event.data)));
    received.push(frame);
    // What the browser client will do, and what keeps this connection alive below.
    if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
  });
  socket.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the socket failed to open")));
  });
  check("upgraded", true, `${base}?sessionId=…&seq=5`);

  await waitFor(received, () => events().length >= 5, "the replay");
  check("replayed", JSON.stringify(events()) === "[6,7,8,9,10]", `seq ${events().join(" ")}`);

  // The frame that says the log is complete, and *where* it lands: after the last replayed
  // event. A client uses it to tell a conversation still arriving from one that never existed,
  // so one sent early would have panes calling half-delivered logs empty.
  await waitFor(received, () => received.some((f) => f.type === "ready"), "the ready frame");
  check(
    "announced the end of the replay",
    received.findIndex((f) => f.type === "ready") === 5,
    `at index ${received.findIndex((f) => f.type === "ready")}`,
  );

  await emit("live one");
  await emit("live two");
  await waitFor(received, () => events().length >= 7, "the live tail");
  check(
    "tailed live",
    JSON.stringify(events()) === "[6,7,8,9,10,11,12]",
    `seq ${events().join(" ")}`,
  );

  // A frame the server cannot parse is answered, and the connection survives it.
  socket.send("not json");
  await waitFor(received, () => received.some((f) => f.type === "error"), "an error frame");
  check("malformed frame answered", true);

  await emit("after the bad frame");
  await waitFor(received, () => events().length >= 8, "an event after the bad frame");
  check("still streaming", events().at(-1) === 13, `seq ${events().at(-1)}`);

  // Answered pings have kept it alive well past the timeout by now.
  await waitFor(received, () => received.some((f) => f.type === "ping"), "a heartbeat");
  await Bun.sleep(HEARTBEAT.timeoutMs + HEARTBEAT.intervalMs);
  check("answered heartbeats keep it open", closed === undefined);

  socket.close();
  await waitFor(received, () => closed !== undefined, "the close");
  check("closed cleanly", closed?.code === 1000 || closed?.code === 1005, `code ${closed?.code}`);

  // A second connection that never answers must be closed by the heartbeat.
  const silentFrames: ServerFrame[] = [];
  let silentClose: number | undefined;
  const mute = new WebSocket(`${base}?sessionId=${SESSION}`);
  mute.addEventListener("message", (event) => {
    silentFrames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
  });
  mute.addEventListener("close", (event) => {
    silentClose = event.code;
  });

  // Thirteen events plus the frame that closes the replay.
  await waitFor(silentFrames, () => silentFrames.length >= 14, "the replay on the second socket");
  check("second connection replayed the whole log", true, `${silentFrames.length} frames`);

  await waitFor(silentFrames, () => silentClose !== undefined, "the heartbeat to give up", 5000);
  check(
    "silent connection closed",
    silentClose === WS_CLOSE.heartbeatTimeout,
    `code ${silentClose}`,
  );

  server.stop(true);

  console.log(
    failures === 0
      ? "\nok — the Bun upgrade path works end to end"
      : `\n${failures} check(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
