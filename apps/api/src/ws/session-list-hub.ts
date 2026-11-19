/**
 * Which of this pod's sockets want to hear that whose session list changed.
 *
 * Every API pod hears every notice on the channel (`@nap/db/postgres-session-list-channel`) and
 * hands it to the sockets it holds for that user; a notice for somebody with no socket here costs a
 * map lookup. That is the whole of how a change written on a worker reaches a tab whose socket is
 * on a different pod: no routing, no stickiness, the same shape as the event bus (`docs/adr/0010`).
 *
 * **It listens on first use, not at boot.** Only a process that serves sockets ever subscribes, so
 * a worker or a reaper composed with the same channel never `LISTEN`s to it. A listen that fails is
 * forgotten, so the next socket tries again, and the sockets that asked are told it failed: they
 * close, and their tabs fall back to polling until a reconnect finds the listener working.
 */

import type { SessionListChannel } from "@nap/shared/ports/session-list-channel";

export type SessionListHub = {
  /**
   * Calls `onChange` for every notice naming `userId`. Resolves once notices are being heard, and
   * rejects when they cannot be. Unsubscribing is idempotent.
   */
  subscribe(userId: string, onChange: () => void): Promise<() => void>;
};

export function createSessionListHub(channel: Pick<SessionListChannel, "listen">): SessionListHub {
  const subscribers = new Map<string, Set<() => void>>();
  let listening: Promise<unknown> | null = null;

  const deliver = (userId: string): void => {
    for (const onChange of [...(subscribers.get(userId) ?? [])]) onChange();
  };

  const listen = (): Promise<unknown> => {
    listening ??= channel.listen(deliver).catch((error: unknown) => {
      listening = null;
      throw error;
    });
    return listening;
  };

  return {
    async subscribe(userId, onChange) {
      const own = subscribers.get(userId) ?? new Set<() => void>();
      own.add(onChange);
      subscribers.set(userId, own);
      const unsubscribe = () => {
        own.delete(onChange);
        if (own.size === 0 && subscribers.get(userId) === own) subscribers.delete(userId);
      };
      try {
        await listen();
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    },
  };
}
