"use client";

import {
  type ComputerControlGrant,
  ComputerControlGrantSchema,
  ComputerControlStatusSchema,
  ComputerInputResultSchema,
  ComputerInputSchema,
  type HumanComputerAction,
} from "@nap/shared/computer-access";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const BUSY = "A turn is running in this project. Wait for it to finish.";
const UNAVAILABLE = "Nap's computer is unavailable. Reconnect to take control.";
const INPUT_FAILED = "Input may have been partly applied. Take control again before continuing.";
type View = {
  available: boolean;
  disabledReason: string | null;
  driving: boolean;
  status: string;
  error: string | null;
};
type Commands = {
  takeControl: () => Promise<boolean>;
  release: () => void;
  sendActions: (actions: readonly HumanComputerAction[]) => Promise<boolean>;
};
type Pending = { actions: HumanComputerAction[]; settle: (applied: boolean) => void };

/** Owner input stays on the guarded HTTP path; the desktop stream remains view-only. */
export function useComputerControl({
  sessionId,
  active,
  connected,
  busy,
  sourceKey,
  fetch: fetchJson = credentialedFetch,
}: {
  sessionId: string | null;
  /** True only for the visible live source, never a historical screenshot. */
  active: boolean;
  connected: boolean;
  busy: boolean;
  /** Stream generation or source identity, independent of private transport credentials. */
  sourceKey?: string;
  fetch?: FetchJson;
}) {
  const scope = useMemo(
    () => ({ sessionId, active, connected, busy, sourceKey }),
    [sessionId, active, connected, busy, sourceKey],
  );
  const localReason = !sessionId
    ? "Open a session to take control."
    : !active
      ? "Go to the live desktop to take control."
      : !connected
        ? "Connect to Nap's computer to take control."
        : busy
          ? BUSY
          : null;
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; view: View } | null>(null);
  const commands = useRef<{ scope: typeof scope; value: Commands } | null>(null);

  useEffect(() => {
    if (!scope.sessionId || !scope.active || !scope.connected || scope.busy) return;
    const base = `${BASE_URL}/sessions/${encodeURIComponent(scope.sessionId)}/computer`;
    let alive = true;
    let generation = 0;
    let grant: ComputerControlGrant | null = null;
    let taking = false;
    let queue: Pending[] = [];
    let inflight: Pending | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const controllers = new Set<AbortController>();
    let view: View = {
      available: false,
      disabledReason: "Checking whether control is available…",
      driving: false,
      status: "Checking availability…",
      error: null,
    };
    const publish = (patch: Partial<View>) => {
      if (!alive) return;
      view = { ...view, ...patch };
      setSnapshot({ scope, view });
    };
    const current = (version: number) => alive && version === generation;
    const revoke = () => {
      generation++;
      grant = null;
      taking = false;
      clearTimeout(expiryTimer);
      for (const controller of controllers) controller.abort();
      controllers.clear();
      inflight?.settle(false);
      inflight = null;
      for (const item of queue) item.settle(false);
      queue = [];
    };
    const fail = (reason: string, error: string = reason) => {
      revoke();
      publish({ driving: false, available: false, disabledReason: reason, status: reason, error });
    };
    const request = async (path: "control" | "input", body?: unknown) => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await fetchJson(`${base}/${path}`, {
          method: body === undefined ? "GET" : "POST",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
      } finally {
        controllers.delete(controller);
      }
    };
    const poll = async () => {
      const version = generation;
      try {
        const response = await request("control");
        if (!current(version)) return;
        if (!response.ok) {
          fail(response.status === 409 ? BUSY : UNAVAILABLE);
          return;
        }
        const parsed = ComputerControlStatusSchema.safeParse(await response.json());
        if (!current(version)) return;
        if (!parsed.success) {
          fail(UNAVAILABLE);
          return;
        }
        publish({ available: true, disabledReason: null });
      } catch {
        if (current(version)) fail(UNAVAILABLE);
      } finally {
        if (alive)
          pollTimer = setTimeout(() => {
            void poll();
          }, 5000);
      }
    };
    const drain = async () => {
      if (inflight || !alive) return;
      const item = queue.shift();
      if (!item) return;
      if (!grant || grant.expiresAt <= Date.now()) {
        item.settle(false);
        fail("Control expired. Take control again.");
        return;
      }
      inflight = item;
      const version = generation;
      try {
        const response = await request("input", { grant: grant.grant, actions: item.actions });
        if (!current(version)) return;
        if (!response.ok) {
          fail(
            response.status === 409
              ? "Control is no longer available. Take control again when Nap is idle."
              : UNAVAILABLE,
            INPUT_FAILED,
          );
          return;
        }
        const parsed = ComputerInputResultSchema.safeParse(await response.json());
        if (!current(version)) return;
        if (!parsed.success || parsed.data.applied !== item.actions.length) {
          fail(INPUT_FAILED);
          return;
        }
        item.settle(true);
      } catch {
        if (current(version)) fail(INPUT_FAILED);
      } finally {
        if (current(version)) {
          inflight = null;
          void drain();
        }
      }
    };
    const value: Commands = {
      async takeControl() {
        if (!alive || taking || !view.available || grant) return false;
        taking = true;
        const version = generation;
        publish({ status: "Taking control…", error: null });
        try {
          const response = await request("control", {});
          if (!current(version)) return false;
          if (!response.ok) {
            fail(response.status === 409 ? BUSY : UNAVAILABLE);
            return false;
          }
          const parsed = ComputerControlGrantSchema.safeParse(await response.json());
          if (!current(version)) return false;
          if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
            fail("Control expired. Take control again.");
            return false;
          }
          grant = parsed.data;
          taking = false;
          publish({
            driving: true,
            status: "You are driving. Shift+Escape releases control.",
            error: null,
          });
          expiryTimer = setTimeout(
            () => fail("Control expired. Take control again."),
            grant.expiresAt - Date.now(),
          );
          return true;
        } catch {
          if (current(version)) fail(UNAVAILABLE);
          return false;
        }
      },
      release() {
        revoke();
        publish({ driving: false, status: "Control released.", error: null });
      },
      sendActions(actions) {
        if (!alive || !grant || !view.driving) return Promise.resolve(false);
        const parsed = ComputerInputSchema.safeParse({ grant: grant.grant, actions });
        if (!parsed.success) {
          publish({ error: "This input exceeds the allowed computer actions." });
          return Promise.resolve(false);
        }
        return new Promise<boolean>((settle) => {
          const item = { actions: parsed.data.actions, settle };
          const last = queue.at(-1);
          if (
            item.actions.length === 1 &&
            item.actions[0]?.action === "mouse_move" &&
            last?.actions.length === 1 &&
            last.actions[0]?.action === "mouse_move"
          ) {
            last.settle(false);
            queue[queue.length - 1] = item;
          } else {
            if (queue.length >= 64) {
              settle(false);
              fail("Too much pending input. Take control again.");
              return;
            }
            queue.push(item);
          }
          void drain();
        });
      },
    };
    commands.current = { scope, value };
    publish({});
    void poll();
    return () => {
      alive = false;
      revoke();
      clearTimeout(pollTimer);
      if (commands.current?.scope === scope) commands.current = null;
    };
  }, [scope, fetchJson]);

  const takeControl = useCallback(
    () =>
      commands.current?.scope === scope
        ? commands.current.value.takeControl()
        : Promise.resolve(false),
    [scope],
  );
  const release = useCallback(() => {
    if (commands.current?.scope === scope) commands.current.value.release();
  }, [scope]);
  const sendActions = useCallback(
    (actions: readonly HumanComputerAction[]) =>
      commands.current?.scope === scope
        ? commands.current.value.sendActions(actions)
        : Promise.resolve(false),
    [scope],
  );
  const view: View = localReason
    ? {
        available: false,
        disabledReason: localReason,
        driving: false,
        status: localReason,
        error: null,
      }
    : snapshot?.scope === scope
      ? snapshot.view
      : {
          available: false,
          disabledReason: "Checking whether control is available…",
          driving: false,
          status: "Checking availability…",
          error: null,
        };
  return { ...view, takeControl, release, sendActions };
}
