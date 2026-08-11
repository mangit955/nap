/**
 * The concrete logger: pino, writing JSON to a stream.
 *
 * The context plumbing that makes ids reach code deep in the stack is not here — it is in
 * `@nap/shared/logging`, because the runtime and the agent need it too and the dependency
 * direction gives them one shared home. This module is only the half that picks a library and
 * a destination, which is a decision for whatever boots the process.
 *
 * **No pino transports.** Transports run in worker threads, and this process runs on Bun.
 * Writing plain JSON to a stream keeps the logger dependency-light, keeps output identical
 * under Node and Bun, and is what the tests assert against. Pretty-printing, if it is ever
 * wanted, belongs in a pipe outside the process.
 */

import type { Logger } from "@nap/shared/logging";
import { type DestinationStream, pino } from "pino";

export type CreateLoggerOptions = {
  level: string;
};

/**
 * A pino logger, typed as the narrow interface the rest of the repo is written against.
 *
 * The annotation is the point: it is what fails to compile if pino's shape and ours ever drift
 * apart, and it is checked here — at the one place the two meet — rather than at every call
 * site. No cast, because a cast would assert the compatibility instead of proving it.
 */
export function createLogger(options: CreateLoggerOptions, stream?: DestinationStream): Logger {
  return stream === undefined
    ? pino({ level: options.level })
    : pino({ level: options.level }, stream);
}
