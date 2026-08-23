/**
 * The line a process prints when it starts, for each of the processes Nap runs.
 *
 * A module of its own rather than part of `boot.ts` for two reasons, one of which is only a
 * reason because of the other. It changes for different causes — what an operator needs to read
 * is not the same question as which clients this process opens — and `boot.ts` imports
 * `hono/bun`, which does not exist under Node, so anything living beside it cannot be tested by a
 * suite that runs on Node. This has no such import and is therefore held to the ordinary rule.
 */

import type { Logger } from "@nap/shared/logging";
import type { NapRole } from "./compose.ts";
import type { Env } from "./env.ts";

/**
 * What a boot line is written from: the settings it names, which part of the deployment this is,
 * and where to write it. Narrower than the whole process on purpose — what gets printed is not a
 * question about the connection pool or the claiming loop.
 */
export type Announcing = {
  env: Pick<Env, "NODE_ENV" | "NAP_PLATFORM" | "NAP_EVENT_BUS" | "NAP_MODEL" | "NAP_EFFORT">;
  role: NapRole;
  logger: Logger;
};

/**
 * What this process is about to spend money on, said out loud at startup.
 *
 * Every message a user sends spends money on whatever is named here — that is not something anyone
 * should first learn from an invoice. Shared by every entrypoint so that the lines can be read side
 * by side in one log stream and compared: two pods disagreeing about the model or the event bus is
 * the sort of thing a deploy does quietly.
 */
export function announce(nap: Announcing, message: string, extra: Record<string, unknown>): void {
  const { env, logger } = nap;
  logger.info(
    {
      role: nap.role,
      nodeEnv: env.NODE_ENV,
      platform: env.NAP_PLATFORM,
      // Whether this process can share a session with another one. `in-process` and two replicas
      // is a chat that stops moving, and that is worth being able to read off a boot line.
      eventBus: env.NAP_EVENT_BUS,
      model: env.NAP_MODEL,
      effort: env.NAP_EFFORT,
      ...extra,
    },
    message,
  );
}
