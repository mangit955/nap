/**
 * Ambient log context: the ids a line is about, available to code that was never given a
 * logger.
 *
 * The goal this is built for: grep one `turnId` and reconstruct a whole turn from logs alone.
 * That requires `sessionId` and `turnId` to appear on lines emitted deep in the stack —
 * inside the runtime, inside the agent — and those interfaces take no logger parameter.
 * Threading one through every signature would be the alternative, so context lives in an
 * `AsyncLocalStorage` instead and `getLogger()` reads it from anywhere.
 *
 * `AsyncLocalStorage` survives `await` and is captured by a promise created inside a context,
 * which is the only reason this works at all: a turn is a long chain of async calls started by
 * a request that has already been answered, and a context that evaporated on the first
 * suspension would be worse than useless.
 *
 * **Why this is in the base package rather than in the API app.** Every layer needs to report
 * under the same ids, and the dependency direction only allows one shared home for that. What
 * lives here is the seam — an interface and the context plumbing — not a logging library: the
 * choice of pino, the output stream and the level all stay in the app that boots, which calls
 * `setRootLogger` once. Nothing here writes anything until it does.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Fields that identify what a log line is about. */
export type LogContext = {
  requestId?: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
};

/**
 * What this repo needs of a logger, and no more.
 *
 * Deliberately narrow so the base package depends on no logging library and a test can pass a
 * recorder. A real pino logger satisfies it structurally, with no adapter and no cast.
 */
export interface Logger {
  child(bindings: LogContext): Logger;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

/** Fields-then-message, or just a message — pino's own shape, and the useful one. */
export type LogMethod = {
  (message: string): void;
  (fields: object, message: string): void;
};

/**
 * The store is mutable so `addLogContext` can enrich a context that is already open. A
 * `Logger` is immutable — `child()` returns a new one — so the mutable thing has to be the box
 * around it rather than the logger itself.
 */
type Store = { logger: Logger };

const storage = new AsyncLocalStorage<Store>();

/** Discards everything. The default root, so importing this module never writes anywhere. */
const SILENT: Logger = {
  child: () => SILENT,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The logger used when nothing has established a context — a script, a test, or code that runs
 * before the first request. Replaced by `setRootLogger` at boot so those lines still go to the
 * configured destination rather than being silently dropped.
 */
let rootLogger: Logger = SILENT;

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

/**
 * The logger for the current context, or the root logger outside one.
 *
 * Falling back rather than throwing is deliberate: a missing context is a wiring mistake, and
 * losing a log line's context is much better than crashing the code that was trying to report
 * something.
 */
export function getLogger(): Logger {
  return storage.getStore()?.logger ?? rootLogger;
}

/** Runs `fn` with `bindings` added to the ambient logger. Nested calls merge. */
export function withLogContext<T>(parent: Logger, bindings: LogContext, fn: () => T): T {
  return storage.run({ logger: parent.child(bindings) }, fn);
}

/**
 * Adds `bindings` to the context that is already open, for everything logged after this point.
 *
 * The case this exists for is a request: the context is opened by the first middleware, but
 * *who* is asking is only known once authentication has run, and the request's own summary line
 * is written last of all. Opening a nested scope for the caller's id would leave that summary —
 * the one line carrying the status code — as the only line in the request that cannot say who
 * it belonged to.
 *
 * Enriching in place rather than nesting, so the addition is visible to the enclosing scope but
 * still bounded by it: a `withLogContext` inside gets its own store, and what is added there
 * does not leak back out. Outside any context this does nothing, for the same reason
 * `getLogger` falls back rather than throwing.
 */
export function addLogContext(bindings: LogContext): void {
  const store = storage.getStore();
  if (store !== undefined) store.logger = store.logger.child(bindings);
}
