/**
 * Where Better Auth's own lines go: the app's logger, under the request's ids, rather than the
 * library's default of `console`.
 *
 * The default is how a session token reached the production log (#283): a failed session
 * lookup is logged with the whole Drizzle error, whose message carries the query's parameters.
 * Redacted here as well as by pino's hook in `logger.ts`, so the guarantee holds whichever
 * logger is installed as the root.
 */

import { getLogger } from "@nap/shared/logging";
import { withoutQueryParams } from "../redact-query-params.ts";

export type BetterAuthLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Logs one Better Auth line.
 *
 * `message` is typed as a string by the library and is not always one: some routes call
 * `logger.error(e)` with the error itself, which would otherwise be flattened to its message
 * and lose the cause that says why. Any error, first argument or message, becomes `err`.
 */
export function logFromBetterAuth(
  level: BetterAuthLogLevel,
  message: unknown,
  args: unknown[],
): void {
  const err = message instanceof Error ? message : args[0] instanceof Error ? args[0] : undefined;
  const others = err !== undefined && err === args[0] ? args.slice(1) : args;
  const fields = {
    ...(err === undefined ? {} : { err }),
    ...(others.length > 0 ? { args: others.map(withoutWhereValues) } : {}),
  };
  const safe = withoutQueryParams(fields);
  const text = typeof message === "string" ? withoutQueryParams(message) : "";
  getLogger()[level](
    typeof safe === "string" ? { withheld: safe } : safe,
    `[Better Auth] ${text}`.trimEnd(),
  );
}

/**
 * The library logs the `where` clause of a failed read beside its error (`{ where: [{ field,
 * value, operator }] }`), and `value` is the query's parameter by another name — a user id on
 * the session lookup's follow-up read. The field and the operator say which lookup it was.
 */
function withoutWhereValues(arg: unknown): unknown {
  if (typeof arg !== "object" || arg === null || !("where" in arg)) return arg;
  const { where } = arg;
  if (!Array.isArray(where)) return arg;
  return {
    ...arg,
    where: where.map((clause: unknown) =>
      typeof clause === "object" && clause !== null && "value" in clause
        ? { ...clause, value: "[withheld]" }
        : clause,
    ),
  };
}
