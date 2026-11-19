"use client";

/**
 * What belongs to the signed-in account rather than to a project, read once per tab and shared.
 *
 * Two answers live here: the models this caller may run (`GET /models`) and the key they have saved
 * (`GET /account/api-key`). Both used to be fetched by whichever component drew them, on every
 * mount — and the workspace is keyed by project (`workspace/live-workspace.tsx`), so every switch
 * in the sidebar threw them away and asked again, and the composer jumped when the model picker
 * came back a round trip later. The sidebar and the composer also asked for the key side by side.
 * Held here, a switch draws them at once and asks for neither.
 *
 * **Module state rather than a provider above the keyed shell**, because the readers are spread
 * over trees that never share a parent below the root layout: the workspace, its sidebar, the
 * dashboard and the settings pages. A provider would cover the `/p` layout and nothing else.
 *
 * **When it is read again.** The model list is per caller — which models are available, and the
 * fallback, depend on the saved key — so a save or a removal of the key replaces the key here and
 * reads the models again, in this tab and, through a broadcast, in every other tab of this browser.
 * A read that failed is not kept: the next component to mount asks again, as before this cache.
 * Sign-out drops both (`auth/forget-signed-out.ts`).
 *
 * In memory and in this tab only, like the remembered logs: a reload starts empty.
 */

import type { ModelList } from "@nap/shared/models-protocol";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { KeyState } from "./api-key-form.tsx";

export type Cached<T> = {
  value: T | undefined;
  /** Whether a read has finished, however it finished: `value` alone cannot say "stop waiting". */
  loaded: boolean;
};

type Load<T> = () => Promise<T | undefined>;

export type AccountResource<T> = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => Cached<T>;
  /** Reads through `load` when nothing usable is held and nothing is on its way. */
  ensure: (load: Load<T>) => void;
  /** Puts an answer the server already gave (a save's reply) in place of whatever was held. */
  set: (value: T) => void;
  /** Reads again for everyone subscribed, keeping what is held until the answer is in. */
  refresh: () => void;
  forget: () => void;
};

const EMPTY: Cached<never> = { value: undefined, loaded: false };

function accountResource<T>(): AccountResource<T> {
  let held: Cached<T> = EMPTY;
  /** Nothing usable is held, so the next subscriber reads. */
  let stale = true;
  let reading = false;
  /** Moves on every write, so an answer to a read made before it is dropped. */
  let generation = 0;
  /** How the last read was made, for a refresh nobody's render asked for. */
  let lastLoad: Load<T> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: Cached<T>) => {
    held = next;
    for (const listener of listeners) listener();
  };

  const read = (load: Load<T>) => {
    lastLoad = load;
    const mine = ++generation;
    stale = false;
    reading = true;
    // Asking again after a failure is not "done asking": a caller that waits on `loaded` — the
    // welcome step, deciding whether to show the paste form — must wait for this answer too.
    if (held.value === undefined && held.loaded) publish(EMPTY);
    void (async () => {
      let value: T | undefined;
      try {
        value = await load();
      } catch {
        value = undefined;
      }
      if (mine !== generation) return;
      reading = false;
      if (value === undefined) stale = true;
      publish({ value: value ?? held.value, loaded: true });
    })();
  };

  // Coming back to the tab is when something may have changed elsewhere — a key saved on another
  // device, a deploy that changed the allowlist — so anything held is read again then: once per
  // return, rather than once per project opened as before this cache.
  const revalidate = () => {
    if (document.visibilityState === "visible" && lastLoad !== undefined && !reading)
      read(lastLoad);
  };

  return {
    subscribe(listener) {
      if (listeners.size === 0) document.addEventListener("visibilitychange", revalidate);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) document.removeEventListener("visibilitychange", revalidate);
      };
    },
    snapshot: () => held,
    ensure(load) {
      if (stale && !reading) read(load);
    },
    set(value) {
      generation += 1;
      reading = false;
      stale = false;
      publish({ value, loaded: true });
    },
    refresh() {
      if (lastLoad !== undefined) read(lastLoad);
      else stale = true;
    },
    forget() {
      generation += 1;
      reading = false;
      stale = true;
      lastLoad = undefined;
      publish(EMPTY);
    },
  };
}

const serverSnapshot = () => EMPTY;

/** Subscribes to a resource, and reads it on mount when nothing usable is held. */
export function useAccountResource<T>(resource: AccountResource<T>, load: Load<T>): Cached<T> {
  const cached = useSyncExternalStore(resource.subscribe, resource.snapshot, serverSnapshot);
  // The newest render's way of reading, without making the read depend on its identity: an
  // injected `fetchJson` is often an inline arrow, new on every render.
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    accountChannel();
    resource.ensure(latest.current);
  }, [resource]);
  return cached;
}

/** The models this caller may run. Per caller: availability and the fallback follow the key. */
export const accountModels = accountResource<ModelList>();
/** The key this caller has saved, as the form draws it. */
export const accountKey = accountResource<KeyState>();

/**
 * A save or a removal of the key, which the server answered with `state`. The models are read
 * again, here and in every other tab of this browser, since what they offer depends on the key.
 */
export function keyChanged(state: KeyState): void {
  accountKey.set(state);
  accountModels.refresh();
  accountChannel()?.postMessage("key");
}

/** Drops everything held for the account — on sign-out, so the next person reads their own. */
export function forgetAccount(): void {
  accountModels.forget();
  accountKey.forget();
}

let channel: BroadcastChannel | null | undefined;
/** Opened by the first reader of either resource: a tab that never shows the account never listens. */
function accountChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("nap-account");
    if (channel !== null)
      channel.onmessage = () => {
        accountKey.refresh();
        accountModels.refresh();
      };
  }
  return channel;
}
