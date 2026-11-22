/**
 * The decisions behind the verify-nap browser driver, kept apart from the browser so they are
 * tested: which commands exist, what each requires, how evidence files are named, and what a
 * fixture's run file must hold. `verify-nap.ts` beside this is the shell that acts on them.
 */
import type { Result } from "@nap/shared/result";
import { z } from "zod";

/** What `apps/api/scripts/verify-nap.ts` writes once everything it started is answering. */
export const RunFileSchema = z.object({
  pid: z.number().int().positive(),
  runDirectory: z.string(),
  evidence: z.string(),
  web: z.string().url(),
  api: z.string().url(),
  preview: z.string().url(),
  cdp: z.string().url(),
  email: z.string(),
  password: z.string(),
  model: z.string(),
  seeded: z.object({ name: z.string(), sessionId: z.string(), projectId: z.string() }),
  stepDelayMs: z.number(),
  startedAt: z.string(),
  stopsAt: z.string(),
});
export type RunFile = z.infer<typeof RunFileSchema>;

/** Up to an 8K screen: past that Chrome refuses the size, and nothing real is that wide. */
const MAX_VIEWPORT = 7680;
const viewportSide = z.number().int().positive().max(MAX_VIEWPORT);

/**
 * A viewport `resize` accepts, and the one it saves in the run directory for every command after
 * it to apply again. One schema for both, so a size the command refuses is never replayed.
 */
export const ViewportSchema = z.object({ width: viewportSide, height: viewportSide });

/**
 * What the fixture has started so far, rewritten as each thing comes up. It exists for the
 * fixture that was killed (SIGKILL, a closed session) and never ran its own cleanup: `stop` reads
 * it to find what was left. Each process carries a marker that must appear in its command line,
 * so a pid the OS has since handed to something else is never signalled.
 */
export const StartedFileSchema = z.object({
  pid: z.number().int().positive(),
  container: z.string().nullable(),
  processes: z.array(
    z.object({ name: z.string(), pid: z.number().int().positive(), marker: z.string() }),
  ),
});
export type StartedFile = z.infer<typeof StartedFileSchema>;

/** The fixture's own command line names this, which is how a reused pid is told apart. */
export const FIXTURE_MARKER = "apps/api/scripts/verify-nap.ts";

/** A run directory as the driver found it. `live` is up and ours; `stale` died without cleaning. */
export type FoundRun = { directory: string; state: "live" | "stale" };

/**
 * Which run a command acts on when none was named. Never a guess between two: with a second run
 * on other ports, the newest is not necessarily the one the caller means, and `stop` on the wrong
 * one ends somebody else's verification.
 */
export function chooseRun(
  found: readonly FoundRun[],
  kind: Command["kind"],
): Result<string, string> {
  const live = found.filter((run) => run.state === "live");
  const stale = found.filter((run) => run.state === "stale");
  // Only stop can do anything with a stale run: it is how its leftovers get removed.
  const usable = live.length > 0 || kind !== "stop" ? live : stale;
  if (usable.length === 1 && usable[0] !== undefined)
    return { ok: true, value: usable[0].directory };
  if (usable.length === 0) {
    const hint =
      stale.length > 0
        ? ` ${stale.length} stopped without cleanup; run: bun run verify-nap stop`
        : "";
    return {
      ok: false,
      error: `No running verify-nap fixture. Start one: bun run verify-nap:up.${hint}`,
    };
  }
  return {
    ok: false,
    error: `${usable.length} verify-nap runs match; pass --run=<one of>:\n${usable.map((run) => `  ${run.directory}`).join("\n")}`,
  };
}

/**
 * Roles a target may name. Closed so a typo fails at parse time with the word in the message,
 * rather than as a thirty-second wait for an element no role could ever match.
 */
const ROLES = [
  "alert",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "heading",
  "img",
  "link",
  "list",
  "listitem",
  "log",
  "main",
  "menu",
  "menuitem",
  "navigation",
  "option",
  "radio",
  "radiogroup",
  "region",
  "row",
  "searchbox",
  "status",
  "switch",
  "tab",
  "tablist",
  "tabpanel",
  "textbox",
  "toolbar",
  "tree",
  "treeitem",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * `frame` is the title of an iframe to look inside — the preview pane's is "App preview" — since
 * an accessibility query from the page stops at a frame's edge.
 */
type InFrame = { frame?: string };
export type RoleTarget = { role: Role; name: string; exact: boolean } & InFrame;
export type Target = RoleTarget | ({ text: string } & InFrame);

export type Command =
  | { kind: "doctor" }
  | { kind: "stop" }
  | { kind: "url" }
  | { kind: "signin" }
  | { kind: "goto"; path: string }
  /** `right` is the context-menu click, which is how a mouse user reaches a session's menu. */
  | { kind: "click"; target: RoleTarget; right: boolean }
  | { kind: "hover"; target: RoleTarget }
  | { kind: "fill"; target: RoleTarget; value: string }
  | { kind: "press"; key: string }
  | { kind: "wait"; target: Target; state: "visible" | "hidden"; timeoutMs: number }
  | ({ kind: "snapshot"; label: string } & InFrame)
  | { kind: "shot"; label: string; fullPage: boolean }
  /** The viewport in CSS pixels; every command after it in the run uses it too. */
  | { kind: "resize"; width: number; height: number };

const DEFAULT_WAIT_MS = 30_000;

/** Flags that take a value. The next argument is the value even when it starts with `--`. */
const VALUE_FLAGS = new Set([
  "role",
  "name",
  "value",
  "width",
  "height",
  "key",
  "text",
  "state",
  "timeout",
  "label",
  "frame",
]);
const BOOLEAN_FLAGS = new Set(["loose", "full", "right"]);

function flags(
  args: readonly string[],
): Result<{ values: Map<string, string>; bare: string[] }, string> {
  const values = new Map<string, string>();
  const bare: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      bare.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) return { ok: false, error: `--${key} takes no value` };
      values.set(key, "true");
      continue;
    }
    // An unknown flag is refused rather than ignored: `--lose` for `--loose` would otherwise
    // quietly turn into an exact match that fails for a reason nobody can see.
    if (!VALUE_FLAGS.has(key)) return { ok: false, error: `unknown flag --${key}` };
    if (eq !== -1) {
      values.set(key, arg.slice(eq + 1));
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) return { ok: false, error: `--${key} needs a value` };
    values.set(key, next);
    i += 1;
  }
  return { ok: true, value: { values, bare } };
}

function inFrame(values: Map<string, string>): InFrame {
  const frame = values.get("frame");
  return frame === undefined ? {} : { frame };
}

function roleTarget(values: Map<string, string>): Result<RoleTarget, string> {
  const role = values.get("role");
  const name = values.get("name");
  if (role === undefined || name === undefined)
    return { ok: false, error: "needs --role <role> --name <accessible name>" };
  if (!(ROLES as readonly string[]).includes(role))
    return { ok: false, error: `unknown role "${role}"; one of: ${ROLES.join(", ")}` };
  return {
    ok: true,
    value: { role: role as Role, name, exact: !values.has("loose"), ...inFrame(values) },
  };
}

function label(values: Map<string, string>): Result<string, string> {
  const value = values.get("label");
  return value === undefined || value.trim() === ""
    ? { ok: false, error: "needs --label <what this shows>" }
    : { ok: true, value };
}

export function parseCommand(args: readonly string[]): Result<Command, string> {
  const [name, ...rest] = args;
  const parsed = flags(rest);
  if (!parsed.ok) return parsed;
  const { values, bare } = parsed.value;
  switch (name) {
    case "doctor":
    case "stop":
    case "url":
    case "signin":
      return { ok: true, value: { kind: name } };
    case "goto": {
      const path = bare[0];
      if (path === undefined || !path.startsWith("/"))
        return { ok: false, error: "goto needs a path on the web app, starting with /" };
      return { ok: true, value: { kind: "goto", path } };
    }
    case "click": {
      const target = roleTarget(values);
      return target.ok
        ? { ok: true, value: { kind: "click", target: target.value, right: values.has("right") } }
        : target;
    }
    case "hover": {
      const target = roleTarget(values);
      return target.ok ? { ok: true, value: { kind: "hover", target: target.value } } : target;
    }
    case "fill": {
      const target = roleTarget(values);
      if (!target.ok) return target;
      const value = values.get("value");
      if (value === undefined) return { ok: false, error: "fill needs --value <text>" };
      return { ok: true, value: { kind: "fill", target: target.value, value } };
    }
    case "press": {
      const key = values.get("key");
      return key === undefined
        ? { ok: false, error: "press needs --key <key>, e.g. Enter or Meta+K" }
        : { ok: true, value: { kind: "press", key } };
    }
    case "wait": {
      const state = values.get("state") ?? "visible";
      if (state !== "visible" && state !== "hidden")
        return { ok: false, error: "--state is visible or hidden" };
      const timeoutMs = Number(values.get("timeout") ?? DEFAULT_WAIT_MS);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return { ok: false, error: "--timeout is a positive number of milliseconds" };
      const text = values.get("text");
      if (text !== undefined)
        return {
          ok: true,
          value: { kind: "wait", target: { text, ...inFrame(values) }, state, timeoutMs },
        };
      const target = roleTarget(values);
      if (!target.ok) return { ok: false, error: `wait needs --text <text>, or ${target.error}` };
      return { ok: true, value: { kind: "wait", target: target.value, state, timeoutMs } };
    }
    case "snapshot": {
      const named = label(values);
      return named.ok
        ? { ok: true, value: { kind: "snapshot", label: named.value, ...inFrame(values) } }
        : named;
    }
    case "shot": {
      const named = label(values);
      return named.ok
        ? { ok: true, value: { kind: "shot", label: named.value, fullPage: values.has("full") } }
        : named;
    }
    case "resize": {
      const viewport = ViewportSchema.safeParse({
        width: Number(values.get("width")),
        height: Number(values.get("height")),
      });
      return viewport.success
        ? { ok: true, value: { kind: "resize", ...viewport.data } }
        : {
            ok: false,
            error: `resize needs --width and --height, whole pixels up to ${MAX_VIEWPORT}, e.g. 390 and 844`,
          };
    }
    default:
      return {
        ok: false,
        error: `unknown command "${name ?? ""}"; one of: doctor, signin, goto, click, hover, fill, press, wait, snapshot, shot, resize, url, stop`,
      };
  }
}

/** `NN-label`: the next number after what the evidence directory already holds. */
export function evidenceName(existing: readonly string[], label: string): string {
  const taken = existing.flatMap((file) => {
    const match = /^(\d+)-/.exec(file);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  const next = (taken.length === 0 ? 0 : Math.max(...taken)) + 1;
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "capture";
  return `${String(next).padStart(2, "0")}-${slug}`;
}
