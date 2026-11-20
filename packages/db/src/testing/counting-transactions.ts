/**
 * A database that counts its own open transactions, so a test can say whether something happened
 * inside one.
 *
 * For announcements that must come after a commit (`@nap/shared/ports/session-list-channel`): the
 * count drops only once `transaction` has returned, which is after the commit, so a store that
 * announces from inside its callback is caught however fast the commit that follows it is. A race
 * against another connection's read would only catch it sometimes.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export function countingTransactions(base: PostgresJsDatabase): {
  db: PostgresJsDatabase;
  /** Transactions open on `db` right now. */
  open: () => number;
} {
  let open = 0;
  const db = new Proxy(base, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: Parameters<PostgresJsDatabase["transaction"]>) => {
          open += 1;
          try {
            return await target.transaction(...args);
          } finally {
            open -= 1;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, open: () => open };
}
