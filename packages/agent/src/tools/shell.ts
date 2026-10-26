/**
 * Running commands: in the foreground, or in the background as a shell the model comes back to.
 *
 * A foreground command is one `exec` that streams its output and waits. That cannot run a dev
 * server, a watcher or a build longer than the wait, so a command may instead start in the
 * background and be read, typed into and stopped by id over later calls.
 *
 * **A background shell's state lives in the sandbox, not in this process.** Its output, exit
 * code, process group and read position are files under `SHELL_ROOT`, and every call is one
 * plain `exec`. So a shell outlives the turn that started it and the worker running that turn,
 * which is the point of having one — and the `SandboxManager` port needs nothing it did not
 * already have. The process runs in its own session so stopping it stops everything it started.
 *
 * Every shell script here is a constant with its arguments shell-quoted, and the model's command
 * is written to a file rather than spliced into a script: the command reaches a shell as itself,
 * exactly as it does in the foreground, and never as part of a quoting puzzle.
 */

import { randomUUID } from "node:crypto";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { shellQuote } from "@nap/shared/shell";
import { inspectCommand } from "../safety/commands.ts";
import { emit, failed, type ToolContext, type ToolOutcome } from "./context.ts";
import { PROJECT_ROOT, type ToolArgs } from "./definitions.ts";

/** Outside the project, so nothing here is committed, snapshotted or verified. */
export const SHELL_ROOT = "/tmp/nap-shells";

/** How much of a background shell's output one read returns. The rest waits for the next. */
export const SHELL_READ_BYTES = 20_000;

const STATUS = "__nap_shell_status";

export async function runCommand(
  args: ToolArgs<"run_command">,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // This is the one tool whose argument reaches a shell unquoted — quoting it would turn a
  // pipeline into a filename — so what may run is decided here instead, before anything is
  // sent. The rules live in ../safety/commands.ts; the check is made at this chokepoint so
  // no caller can reach the sandbox around it, and so a refusal comes back as an ordinary
  // failed result the model can read and work with.
  const verdict = inspectCommand(args.command);
  if (!verdict.allowed) return { ok: false, output: verdict.message };

  if (args.background === true) {
    if (ctx.backgroundShells === false)
      return {
        ok: false,
        output: "Helpers must run commands in the foreground so no command outlives its helper.",
      };
    return startShell(args.command, ctx);
  }

  const command = `cd ${PROJECT_ROOT} && ${args.command}`;
  const timeoutMs = (args.timeout_seconds ?? 60) * 1_000;

  const executed = await ctx.sandbox.exec(
    ctx.sandboxId,
    command,
    (chunk) => {
      emit(ctx, {
        type: "command.output",
        payload: { toolCallId: call.id, stream: chunk.stream, chunk: chunk.data },
      });
    },
    { signal: ctx.signal, timeoutMs },
  );
  if (!executed.ok) {
    if (executed.error.code === "timeout")
      return {
        ok: false,
        output: `The command was still running after ${timeoutMs / 1_000} seconds and was stopped. Run it with background set to let it keep going, or raise timeout_seconds.`,
      };
    return failed(executed.error);
  }

  const { exitCode, stdout, stderr } = executed.value;
  const body = [stdout, stderr].filter((part) => part !== "").join("\n");

  // A non-zero exit stays a success: a failing build is a fact the model has to read and
  // act on, not a malfunction of the tool that reported it.
  return { ok: true, output: `exit code ${exitCode}\n${body}` };
}

/**
 * What runs the model's command, in its own session.
 *
 * Holding the input pipe open from a second process is what lets the command wait for input
 * rather than read end-of-file the moment nobody is typing; it is stopped when the command
 * ends, so a later write finds no reader and fails fast instead of hanging.
 */
const RUNNER = `d="$1"
echo $$ > "$d/pid"
sleep 2147483647 > "$d/in" &
holder=$!
cd "$2" || { echo 1 > "$d/exit"; kill "$holder" 2>/dev/null; exit 1; }
bash "$d/cmd" < "$d/in" > "$d/log" 2>&1
echo $? > "$d/exit"
kill "$holder" 2>/dev/null
`;

/**
 * Prints the status line and then the output not yet read, and advances the read position.
 *
 * The exit file is checked *before* the log is read, so "exited" always comes with all of the
 * output — the other order can report an exit beside a log missing its last lines.
 */
const READ = `d="$1"; limit="$2"; wait="$3"
[ -f "$d/pid" ] || { echo "${STATUS} missing"; exit 0; }
i=0
while [ ! -f "$d/exit" ] && [ "$i" -lt "$wait" ]; do sleep 0.1; i=$((i+1)); done
if [ -f "$d/exit" ]; then status="exited $(cat "$d/exit")"; else status="running"; fi
offset=$(cat "$d/offset" 2>/dev/null || echo 0)
size=$(wc -c < "$d/log" | tr -d ' ')
available=$((size-offset))
[ "$available" -lt "$limit" ] && limit="$available"
tail -c +$((offset+1)) "$d/log" | head -c "$limit" > "$d/chunk"
read=$(wc -c < "$d/chunk" | tr -d ' ')
echo $((offset+read)) > "$d/offset"
echo "${STATUS} $status $((size-offset-read))"
cat "$d/chunk"
`;

const START = `d="$1"
mkdir -p "$d" && mkfifo "$d/in" || exit 1
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$d/run.sh" "$d" "$2" > /dev/null 2>&1 < /dev/null &
else
  set -m
  sh "$d/run.sh" "$d" "$2" > /dev/null 2>&1 < /dev/null &
fi
i=0
while [ ! -f "$d/pid" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
`;

/**
 * Stops the whole process group, politely and then not. A negative pid names the group; it is
 * written without `--` because dash — `/bin/sh` on Debian, and so on the sandbox — refuses that
 * spelling and the stop would quietly fall back to the runner alone, leaving its children alive.
 */
const KILL = `d="$1"
[ -f "$d/pid" ] || { echo missing; exit 0; }
[ -f "$d/exit" ] && { echo "exited $(cat "$d/exit")"; exit 0; }
pid=$(cat "$d/pid")
kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
i=0
while kill -0 "-$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i+1)); done
kill -KILL "-$pid" 2>/dev/null
[ -f "$d/exit" ] || echo 143 > "$d/exit"
echo stopped
`;

const INPUT = `d="$1"
[ -f "$d/pid" ] || { echo missing; exit 0; }
[ -f "$d/exit" ] && { echo "exited $(cat "$d/exit")"; exit 0; }
printf '%s' "$2" > "$d/in" && echo sent
`;

function script(body: string, ...args: (string | number)[]): string {
  return `sh -c ${shellQuote(body)} sh ${args.map((arg) => shellQuote(String(arg))).join(" ")}`;
}

function directory(shellId: string): string {
  return `${SHELL_ROOT}/${shellId}`;
}

async function startShell(command: string, ctx: ToolContext): Promise<ToolOutcome> {
  const shellId = randomUUID().replaceAll("-", "").slice(0, 12);
  const dir = directory(shellId);
  for (const [name, contents] of [
    ["cmd", command],
    ["run.sh", RUNNER],
  ] as const) {
    const written = await ctx.sandbox.writeFile(ctx.sandboxId, `${dir}/${name}`, contents);
    if (!written.ok) return failed(written.error);
  }
  const started = await ctx.sandbox.exec(ctx.sandboxId, script(START, dir, PROJECT_ROOT));
  if (!started.ok) return failed(started.error);
  if (started.value.exitCode !== 0)
    return { ok: false, output: `Could not start the command: ${started.value.stderr}` };

  // A typo or a missing script fails at once, and saying so now saves a round trip.
  const first = await read(shellId, 1, ctx);
  if (!first.ok) return first;
  return {
    ok: true,
    output: `Started in the background as shell ${shellId}. Read it with shell_output.\n${first.output}`,
  };
}

export async function shellOutput(
  args: ToolArgs<"shell_output">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  return read(args.shell_id, args.wait_seconds ?? 0, ctx);
}

async function read(shellId: string, waitSeconds: number, ctx: ToolContext): Promise<ToolOutcome> {
  const executed = await ctx.sandbox.exec(
    ctx.sandboxId,
    script(READ, directory(shellId), SHELL_READ_BYTES, waitSeconds * 10),
    undefined,
    { signal: ctx.signal, timeoutMs: (waitSeconds + 30) * 1_000 },
  );
  if (!executed.ok) return failed(executed.error);
  const { stdout } = executed.value;
  const newline = stdout.indexOf("\n");
  const head = newline === -1 ? stdout : stdout.slice(0, newline);
  const body = newline === -1 ? "" : stdout.slice(newline + 1);
  const status = /^__nap_shell_status (missing|running|exited (-?\d+)) ?(\d+)?$/.exec(head);
  if (status === null)
    return {
      ok: false,
      output: `Could not read shell ${shellId}: ${executed.value.stderr || head}`,
    };
  if (status[1] === "missing") return missing(shellId);
  const remaining = Number(status[3] ?? 0);
  const state = status[2] === undefined ? "Still running." : `Exited with code ${status[2]}.`;
  return {
    ok: true,
    output: [
      state,
      body === "" ? "(no new output)" : body,
      ...(remaining > 0 ? [`… ${remaining} more bytes; call shell_output again to read on.`] : []),
    ].join("\n"),
  };
}

export async function shellInput(
  args: ToolArgs<"shell_input">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // What is typed into a shell prompt is a command, so it answers to the same guard.
  const verdict = inspectCommand(args.text);
  if (!verdict.allowed) return { ok: false, output: verdict.message };
  const executed = await ctx.sandbox.exec(
    ctx.sandboxId,
    `timeout 10 ${script(INPUT, directory(args.shell_id), args.text)}`,
    undefined,
    { signal: ctx.signal, timeoutMs: 20_000 },
  );
  if (!executed.ok) return failed(executed.error);
  const said = executed.value.stdout.trim();
  if (said === "missing") return missing(args.shell_id);
  if (said.startsWith("exited"))
    return { ok: false, output: `Shell ${args.shell_id} has already ${said}; nothing is reading.` };
  if (said !== "sent")
    return {
      ok: false,
      output: `Shell ${args.shell_id} did not take the input within 10 seconds; it may not be reading.`,
    };
  return { ok: true, output: `Sent to shell ${args.shell_id}. Read the reply with shell_output.` };
}

export async function shellKill(
  args: ToolArgs<"shell_kill">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const executed = await ctx.sandbox.exec(ctx.sandboxId, script(KILL, directory(args.shell_id)));
  if (!executed.ok) return failed(executed.error);
  const said = executed.value.stdout.trim();
  if (said === "missing") return missing(args.shell_id);
  if (said.startsWith("exited"))
    return { ok: true, output: `Shell ${args.shell_id} had already ${said}.` };
  return { ok: true, output: `Stopped shell ${args.shell_id}.` };
}

function missing(shellId: string): ToolOutcome {
  return {
    ok: false,
    output: `No shell ${shellId} in this workspace. It may be from a sandbox that has since been replaced.`,
  };
}
