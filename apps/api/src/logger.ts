/**
 * Structured logging with ambient request/turn context.
 *
 * The goal this is built for: grep one `turnId` and reconstruct a whole turn from logs
 * alone. That requires `sessionId` and `turnId` to appear on lines emitted deep in the
 * stack — inside `Runtime`, inside `AgentService` — and those interfaces take no logger
 * parameter. Threading one through every signature would be the alternative, so context
 * lives in an `AsyncLocalStorage` instead and `getLogger()` reads it from anywhere.
 *
 * `AsyncLocalStorage` survives `await`, which is the only reason this works at all: a turn
 * is a long chain of async calls, and a context that evaporated on the first suspension
 * would be worse than useless.
 *
 * **No pino transports.** Transports run in worker threads, and this process runs on Bun.
 * Writing plain JSON to a stream keeps the logger dependency-light, keeps output identical
 * under Node and Bun, and is what the tests assert against. Pretty-printing, if it is ever
 * wanted, belongs in a pipe outside the process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger };

/** Fields that identify what a log line is about. */
export type LogContext = {
  requestId?: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
};

export type CreateLoggerOptions = {
  level: string;
};

const storage = new AsyncLocalStorage<Logger>();

/**
 * The logger used when nothing has established a context — a script, a test, or code that
 * runs before the first request. Replaced by `setRootLogger` at boot so those lines still
 * go to the configured destination rather than to a second, unconfigured stream.
 */
let rootLogger: Logger = pino({ level: "silent" });

export function createLogger(options: CreateLoggerOptions, stream?: DestinationStream): Logger {
  return stream === undefined
    ? pino({ level: options.level })
    : pino({ level: options.level }, stream);
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

/**
 * The logger for the current context, or the root logger outside one.
 *
 * Falling back rather than throwing is deliberate: a missing context is a wiring mistake,
 * and losing a log line's context is much better than crashing the code that was trying to
 * report something.
 */
export function getLogger(): Logger {
  return storage.getStore() ?? rootLogger;
}

/** Runs `fn` with `bindings` added to the ambient logger. Nested calls merge. */
export function withLogContext<T>(parent: Logger, bindings: LogContext, fn: () => T): T {
  return storage.run(parent.child(bindings), fn);
}
