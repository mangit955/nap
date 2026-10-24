import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { z } from "zod";

const DEFAULT_MEMORY_MB = 2_048;
const DEFAULT_TTL_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const ADMIN_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 130_000;
const EXEC_INNER_BOUND_MS = 123_000;
const PROCESS_DRAIN_MS = 3_000;
const MAX_EXEC_STDOUT_BYTES = 24_000_000;
const MAX_EXEC_STDERR_BYTES = 4_000_000;
const MAX_ADMIN_STDOUT_BYTES = 22_000_000;
const MAX_ADMIN_STDERR_BYTES = 2_000_000;
const MAX_COMMAND_BYTES = 256_000;
const PREVIEW_TIMEOUT_MS = 30_000;
const PREVIEW_PROBE_MS = 250;
const PREVIEW_PROBE_TIMEOUT_MS = 3_000;
const MAX_BRIDGE_CONNECTIONS = 32;
const LOCAL_PORTS = new Set([5173, 6080]);
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL_RUN = "dev.nap.local.run";
const LABEL_PROJECT = "dev.nap.local.project";
const LABEL_SANDBOX = "dev.nap.local.sandbox";
const LABEL_IMAGE_DIGEST = "dev.nap.local.image-digest";
const RUNTIME_DIRECTORY = fileURLToPath(new URL("./computer-local-runtime", import.meta.url));

type ProcessFailureReason = "cancelled" | "overflow" | "spawn" | "timeout";
type ProcessOutcome =
  | { status: "completed"; exitCode: number; stdout: string; stderr: string }
  | {
      status: "failed";
      reason: ProcessFailureReason;
      message: string;
      stdout: string;
      stderr: string;
    };

type ProcessOptions = {
  cwd?: string;
  input?: Buffer;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Bridge = {
  port: number;
  server: Server;
  sockets: Set<Socket>;
  children: Set<ChildProcessWithoutNullStreams>;
  closing?: Promise<void>;
};

type ContainerResource = {
  id: string;
  projectId: string;
  state: "cleanup_failed" | "live" | "removing";
  generation: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  bridges: Map<number, Bridge>;
  children: Set<ChildProcessWithoutNullStreams>;
  removal?: Promise<boolean>;
};

const PackageSchema = z.object({ packageManager: z.literal("bun@1.3.13") });
const LabelsSchema = z.record(z.string(), z.string()).nullish();
const ImageInspectSchema = z
  .array(z.object({ Id: z.string().min(1), Config: z.object({ Labels: LabelsSchema }) }))
  .length(1);
const ContainerInspectSchema = z
  .array(
    z.object({
      Id: z.string().regex(CONTAINER_ID),
      State: z.object({ Running: z.boolean() }),
      Config: z.object({ Image: z.string().min(1), Labels: LabelsSchema }),
    }),
  )
  .length(1);
const HelperReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["exec_failed", "file_not_found", "unavailable"]),
  }),
]);
const FileNodesSchema = z.array(
  z.strictObject({ path: z.string().max(4_096), type: z.enum(["file", "directory"]) }),
);
const ExecStatusSchema = z.strictObject({ exitCode: z.int().min(0).max(255) });

function success<T>(value: T): Result<T, SandboxError> {
  return { ok: true, value };
}

function failure(code: SandboxError["code"], message: string): Result<never, SandboxError> {
  return { ok: false, error: { code, message } };
}

function startupFailure(message: string): Result<never, { message: string }> {
  return { ok: false, error: { message } };
}

function processMessage(outcome: ProcessOutcome): string {
  if (outcome.status === "completed") return outcome.stderr.trim() || `exit ${outcome.exitCode}`;
  return outcome.message;
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessOutcome> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: "failed",
      reason: "cancelled",
      message: "Process cancelled before startup.",
      stdout: "",
      stderr: "",
    });
  }

  return new Promise((resolveProcess) => {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const maxStdout = options.maxStdoutBytes ?? MAX_ADMIN_STDOUT_BYTES;
    const maxStderr = options.maxStderrBytes ?? MAX_ADMIN_STDERR_BYTES;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failureState: { reason: ProcessFailureReason; message: string } | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcessWithoutNullStreams;

    const clearTimers = () => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    };
    const complete = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal?.removeEventListener("abort", abort);
      const finalStdout = stdoutDecoder.end();
      const finalStderr = stderrDecoder.end();
      if (finalStdout) stdout.push(finalStdout);
      if (finalStderr) stderr.push(finalStderr);
      const output = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (failureState !== undefined)
        resolveProcess({ status: "failed", ...failureState, ...output });
      else resolveProcess({ status: "completed", exitCode, ...output });
    };
    const stop = (reason: ProcessFailureReason, message: string) => {
      if (failureState !== undefined || settled) return;
      failureState = { reason, message };
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer = setTimeout(() => complete(125), PROCESS_DRAIN_MS);
      killTimer.unref();
      forceTimer.unref();
    };
    const abort = () => stop("cancelled", "Process cancelled.");
    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const limit = stream === "stdout" ? maxStdout : maxStderr;
      const remaining = Math.max(0, limit - current);
      const accepted = remaining === 0 ? Buffer.alloc(0) : chunk.subarray(0, remaining);
      const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
      const decoded = decoder.write(accepted);
      if (stream === "stdout") {
        stdoutBytes += accepted.byteLength;
        if (decoded) stdout.push(decoded);
      } else {
        stderrBytes += accepted.byteLength;
        if (decoded) stderr.push(decoded);
      }
      try {
        if (decoded) {
          if (stream === "stdout") options.onStdout?.(decoded);
          else options.onStderr?.(decoded);
        }
      } catch {
        stop("overflow", "Output consumer failed.");
        return;
      }
      if (accepted.byteLength !== chunk.byteLength)
        stop("overflow", `${stream} exceeded its limit.`);
    };

    try {
      child = spawn(executable, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      resolveProcess({ status: "failed", reason: "spawn", message, stdout: "", stderr: "" });
      return;
    }
    options.onSpawn?.(child);
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
    child.stdin.once("error", (cause) => stop("spawn", cause.message));
    child.once("error", (cause) => stop("spawn", cause.message));
    child.once("close", (code) => complete(code ?? 125));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(
        () => stop("timeout", `Process exceeded ${options.timeoutMs} ms.`),
        options.timeoutMs,
      );
      timeoutTimer.unref();
    }
    try {
      if (options.input === undefined) child.stdin.end();
      else child.stdin.end(options.input);
    } catch (cause) {
      stop("spawn", cause instanceof Error ? cause.message : String(cause));
    }
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hashDirectory(directory: string): string {
  const hash = createHash("sha256");
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Local image context contains a symbolic link.");
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(relative(directory, full).split(sep).join("/"));
        hash.update("\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  walk(directory);
  return hash.digest("hex");
}

function copyTemplate(repositoryRoot: string, context: string): void {
  cpSync(join(repositoryRoot, "packages/sandbox/template"), join(context, "app"), {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return (
        ![".git", ".DS_Store", "dist", "node_modules"].includes(name) &&
        (!name.startsWith(".env") || name === ".env.example")
      );
    },
  });
  for (const name of [
    "Dockerfile",
    "exec.mjs",
    "file-helper.mjs",
    "supervisor.mjs",
    "tcp-forward.mjs",
  ]) {
    cpSync(join(RUNTIME_DIRECTORY, name), join(context, name));
  }
  cpSync(
    join(repositoryRoot, "packages/sandbox/desktop/start-desktop.sh"),
    join(context, "start-desktop.sh"),
  );
  chmodSync(join(context, "start-desktop.sh"), 0o755);
}

function allowedSandboxPath(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  return normalized === "/home/user/app" || normalized.startsWith("/home/user/app/")
    ? normalized
    : undefined;
}

function noSuchContainer(outcome: ProcessOutcome): boolean {
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  return /no such (?:object|container)/i.test(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export class LocalDockerSandboxManager implements SandboxManager {
  readonly #runId: string;
  readonly #image: string;
  readonly #imageDigest: string;
  readonly #memoryMB: number;
  readonly #ttlMs: number;
  readonly #evidenceFile: string | undefined;
  readonly #resources = new Map<string, ContainerResource>();
  readonly #destroyed = new Set<string>();
  readonly #pendingCreates = new Set<Promise<Result<Sandbox, SandboxError>>>();
  #closing = false;
  #closePromise: Promise<Result<void, { message: string }>> | undefined;

  private constructor(options: {
    runId: string;
    image: string;
    imageDigest: string;
    memoryMB: number;
    ttlMs: number;
    evidenceFile?: string;
  }) {
    this.#runId = options.runId;
    this.#image = options.image;
    this.#imageDigest = options.imageDigest;
    this.#memoryMB = options.memoryMB;
    this.#ttlMs = options.ttlMs;
    this.#evidenceFile = options.evidenceFile;
  }

  static async open(options: {
    repositoryRoot: string;
    memoryMB?: number;
    ttlMs?: number;
    evidenceDirectory?: string;
    signal?: AbortSignal;
  }): Promise<Result<LocalDockerSandboxManager, { message: string }>> {
    if (options.signal?.aborted) return startupFailure("Local Docker startup was cancelled.");

    const repositoryRoot = resolve(options.repositoryRoot);
    const memoryMB = options.memoryMB ?? DEFAULT_MEMORY_MB;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(memoryMB) || memoryMB < 512 || memoryMB > 32_768)
      return startupFailure("Local Docker memory must be an integer from 512 to 32768 MB.");
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000)
      return startupFailure("Local Docker TTL must be an integer from 1 to 86400000 ms.");
    try {
      const manifest = PackageSchema.safeParse(
        parseJson(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
      );
      if (!manifest.success)
        return startupFailure("The repository must use packageManager bun@1.3.13.");
      lstatSync(join(repositoryRoot, "packages/sandbox/template"));
      lstatSync(join(repositoryRoot, "packages/sandbox/scripts/desktop-driver.ts"));
      lstatSync(join(repositoryRoot, "packages/sandbox/desktop/start-desktop.sh"));
    } catch {
      return startupFailure("The local Docker repository root is invalid.");
    }

    const docker = await runProcess("docker", ["version", "--format", "{{.Server.Version}}"], {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: ADMIN_TIMEOUT_MS,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 16_384,
    });
    if (docker.status === "failed" && docker.reason === "cancelled")
      return startupFailure("Local Docker startup was cancelled.");
    if (docker.status !== "completed" || docker.exitCode !== 0)
      return startupFailure(`Local Docker is unavailable: ${processMessage(docker)}`);

    const context = mkdtempSync(join(tmpdir(), "nap-local-image-"));
    let result: Result<LocalDockerSandboxManager, { message: string }> | undefined;
    let cleanupFailed = false;
    try {
      copyTemplate(repositoryRoot, context);
      const bundle = await runProcess(
        "bun",
        [
          "build",
          join(repositoryRoot, "packages/sandbox/scripts/desktop-driver.ts"),
          "--target=node",
          "--format=esm",
          `--outfile=${join(context, "driver.mjs")}`,
        ],
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: ADMIN_TIMEOUT_MS,
          maxStdoutBytes: 1_000_000,
          maxStderrBytes: 1_000_000,
        },
      );
      if (bundle.status === "failed" && bundle.reason === "cancelled") {
        result = startupFailure("Local Docker startup was cancelled.");
      } else if (bundle.status !== "completed" || bundle.exitCode !== 0) {
        result = startupFailure(`Desktop driver bundling failed: ${processMessage(bundle)}`);
      } else if (options.signal?.aborted) {
        result = startupFailure("Local Docker startup was cancelled.");
      } else {
        const imageDigest = hashDirectory(context);
        const image = `nap-local-sandbox:${imageDigest.slice(0, 24)}`;
        const inspect = await runProcess("docker", ["image", "inspect", image], {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
        const inspected =
          inspect.status === "completed" && inspect.exitCode === 0
            ? ImageInspectSchema.safeParse(parseJson(inspect.stdout))
            : undefined;
        const cached =
          inspected?.success === true &&
          inspected.data[0]?.Config.Labels?.[LABEL_IMAGE_DIGEST] === imageDigest;
        let built: ProcessOutcome | undefined;
        if (!cached && !options.signal?.aborted) {
          built = await runProcess(
            "docker",
            [
              "build",
              "--platform",
              "linux/amd64",
              "--label",
              `${LABEL_IMAGE_DIGEST}=${imageDigest}`,
              "--tag",
              image,
              context,
            ],
            {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              timeoutMs: BUILD_TIMEOUT_MS,
              maxStdoutBytes: MAX_ADMIN_STDOUT_BYTES,
              maxStderrBytes: MAX_ADMIN_STDERR_BYTES,
            },
          );
        }
        if (
          options.signal?.aborted ||
          (built?.status === "failed" && built.reason === "cancelled")
        ) {
          result = startupFailure("Local Docker startup was cancelled.");
        } else if (built !== undefined && (built.status !== "completed" || built.exitCode !== 0)) {
          result = startupFailure(`Local Docker image build failed: ${processMessage(built)}`);
        } else {
          const verified = await runProcess("docker", ["image", "inspect", image], {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            timeoutMs: ADMIN_TIMEOUT_MS,
          });
          const imageRecord =
            verified.status === "completed" && verified.exitCode === 0
              ? ImageInspectSchema.safeParse(parseJson(verified.stdout))
              : undefined;
          if (
            options.signal?.aborted ||
            (verified.status === "failed" && verified.reason === "cancelled")
          ) {
            result = startupFailure("Local Docker startup was cancelled.");
          } else if (
            imageRecord?.success !== true ||
            imageRecord.data[0]?.Config.Labels?.[LABEL_IMAGE_DIGEST] !== imageDigest
          ) {
            result = startupFailure("Local Docker image verification failed.");
          } else {
            const runId = randomUUID();
            let evidenceFile: string | undefined;
            if (options.evidenceDirectory !== undefined) {
              const evidenceDirectory = resolve(options.evidenceDirectory);
              mkdirSync(evidenceDirectory, { recursive: true });
              evidenceFile = join(evidenceDirectory, `manager-${runId}.ndjson`);
              writeFileSync(
                evidenceFile,
                `${JSON.stringify({ event: "opened", image, imageDigest, memoryMB, runId, ttlMs })}\n`,
                { flag: "wx", mode: 0o600 },
              );
            }
            if (options.signal?.aborted) {
              result = startupFailure("Local Docker startup was cancelled.");
            } else {
              result = {
                ok: true,
                value: new LocalDockerSandboxManager({
                  runId,
                  image,
                  imageDigest,
                  memoryMB,
                  ttlMs,
                  ...(evidenceFile === undefined ? {} : { evidenceFile }),
                }),
              };
            }
          }
        }
      }
    } catch (cause) {
      result = startupFailure(
        `Local Docker startup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      try {
        rmSync(context, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) return startupFailure("Local Docker startup context cleanup failed.");
    return result ?? startupFailure("Local Docker startup failed.");
  }

  create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    if (this.#closing)
      return Promise.resolve(failure("destroyed", "Local Docker manager is closed."));
    if (!PROJECT_ID.test(projectId))
      return Promise.resolve(failure("exec_failed", "Project id is invalid for a Docker label."));
    const operation = this.#create(projectId);
    this.#pendingCreates.add(operation);
    operation.finally(() => this.#pendingCreates.delete(operation)).catch(() => undefined);
    return operation;
  }

  async #create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    const cidDirectory = mkdtempSync(join(tmpdir(), "nap-local-cid-"));
    const cidfile = join(cidDirectory, "container-id");
    const sandboxLabel = randomUUID();
    const name = `nap-local-${this.#runId.slice(0, 8)}-${sandboxLabel.slice(0, 8)}`;
    let containerId: string | undefined;
    try {
      const launched = await runProcess(
        "docker",
        [
          "container",
          "run",
          "--detach",
          "--rm",
          "--init",
          "--platform",
          "linux/amd64",
          "--cidfile",
          cidfile,
          "--name",
          name,
          "--network",
          "none",
          "--cpus",
          "2",
          "--memory",
          `${this.#memoryMB}m`,
          "--memory-swap",
          `${this.#memoryMB}m`,
          "--label",
          `${LABEL_RUN}=${this.#runId}`,
          "--label",
          `${LABEL_PROJECT}=${projectId}`,
          "--label",
          `${LABEL_SANDBOX}=${sandboxLabel}`,
          "--label",
          `${LABEL_IMAGE_DIGEST}=${this.#imageDigest}`,
          this.#image,
        ],
        { timeoutMs: ADMIN_TIMEOUT_MS, maxStdoutBytes: 4_096, maxStderrBytes: 65_536 },
      );
      const cidText = (() => {
        try {
          return readFileSync(cidfile, "utf8").trim();
        } catch {
          return "";
        }
      })();
      const stdoutId = launched.stdout.trim();
      const candidate = CONTAINER_ID.test(cidText) ? cidText : stdoutId;
      if (CONTAINER_ID.test(candidate)) {
        containerId = candidate;
        this.#register(containerId, projectId);
      }
      if (
        launched.status !== "completed" ||
        launched.exitCode !== 0 ||
        containerId === undefined ||
        (stdoutId !== "" && stdoutId !== containerId)
      ) {
        if (containerId !== undefined) await this.#remove(containerId);
        return failure(
          "unavailable",
          `Local Docker container startup failed: ${processMessage(launched)}`,
        );
      }
      const verified = await this.#inspect(containerId);
      const labels = verified?.Config.Labels;
      if (
        verified === undefined ||
        !verified.State.Running ||
        verified.Id !== containerId ||
        verified.Config.Image !== this.#image ||
        labels?.[LABEL_RUN] !== this.#runId ||
        labels?.[LABEL_PROJECT] !== projectId ||
        labels?.[LABEL_SANDBOX] !== sandboxLabel ||
        labels?.[LABEL_IMAGE_DIGEST] !== this.#imageDigest
      ) {
        await this.#remove(containerId);
        return failure("unavailable", "Local Docker rejected an unverified container.");
      }
      if (this.#closing) {
        await this.#remove(containerId);
        return failure("destroyed", "Local Docker manager is closed.");
      }
      const resource = this.#resources.get(containerId);
      if (resource === undefined)
        return failure("unavailable", "Local Docker lost its registered container.");
      this.#resetTimer(resource, this.#ttlMs);
      this.#evidence({ event: "created", containerId, projectId });
      return success({ id: containerId, projectId });
    } catch (cause) {
      if (containerId !== undefined) await this.#remove(containerId);
      return failure(
        "unavailable",
        `Local Docker container startup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      rmSync(cidDirectory, { recursive: true, force: true });
    }
  }

  async resume(sandboxId: string): Promise<Result<Sandbox, SandboxError>> {
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const resource = found.value;
    if (resource.state !== "live") return failure("destroyed", "Sandbox is being destroyed.");
    const inspected = await this.#inspect(resource.id);
    const labels = inspected?.Config.Labels;
    if (
      inspected === undefined ||
      !inspected.State.Running ||
      labels?.[LABEL_RUN] !== this.#runId ||
      labels?.[LABEL_PROJECT] !== resource.projectId ||
      labels?.[LABEL_IMAGE_DIGEST] !== this.#imageDigest
    ) {
      return failure("unavailable", "Local Docker sandbox identity could not be verified.");
    }
    return success({ id: resource.id, projectId: resource.projectId });
  }

  async destroy(sandboxId: string): Promise<Result<void, SandboxError>> {
    if (this.#destroyed.has(sandboxId)) return success(undefined);
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    return (await this.#remove(sandboxId))
      ? success(undefined)
      : failure("unavailable", "Local Docker could not verify sandbox removal.");
  }

  async extendTimeout(sandboxId: string, ms: number): Promise<Result<void, SandboxError>> {
    if (!Number.isInteger(ms) || ms < 1 || ms > 86_400_000)
      return failure("exec_failed", "Sandbox TTL must be an integer from 1 to 86400000 ms.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    if (found.value.state !== "live") return failure("destroyed", "Sandbox is being destroyed.");
    this.#resetTimer(found.value, ms);
    return success(undefined);
  }

  async writeFile(
    sandboxId: string,
    path: string,
    contents: string,
  ): Promise<Result<void, SandboxError>> {
    const normalized = allowedSandboxPath(path);
    if (normalized === undefined)
      return failure("exec_failed", "Sandbox file path is outside the app.");
    const input = Buffer.from(contents);
    if (input.byteLength > 16_000_000)
      return failure("exec_failed", "Sandbox file exceeds the 16 MB limit.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const reply = await this.#helper(
      found.value,
      "write",
      Buffer.from(normalized).toString("base64url"),
      input,
    );
    if (!reply.ok) return reply;
    return reply.value === null
      ? success(undefined)
      : failure("unavailable", "Local Docker file helper returned an invalid reply.");
  }

  async readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    const normalized = allowedSandboxPath(path);
    if (normalized === undefined)
      return failure("exec_failed", "Sandbox file path is outside the app.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const reply = await this.#helper(
      found.value,
      "read",
      Buffer.from(normalized).toString("base64url"),
    );
    if (!reply.ok) return reply;
    const encoded = z.string().max(21_400_000).safeParse(reply.value);
    if (
      !encoded.success ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded.data)
    )
      return failure("unavailable", "Local Docker file helper returned invalid file bytes.");
    return success(Buffer.from(encoded.data, "base64").toString("utf8"));
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    const normalized = allowedSandboxPath(path);
    if (normalized === undefined)
      return failure("exec_failed", "Sandbox file path is outside the app.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const reply = await this.#helper(
      found.value,
      "list",
      Buffer.from(normalized).toString("base64url"),
    );
    if (!reply.ok) return reply;
    const files = FileNodesSchema.safeParse(reply.value);
    if (!files.success || files.data.some((file) => allowedSandboxPath(file.path) === undefined))
      return failure("unavailable", "Local Docker file helper returned an invalid listing.");
    return success(files.data);
  }

  async exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>> {
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
      return failure("exec_failed", "Sandbox command exceeds the 256 KB limit.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const resource = found.value;
    if (resource.state !== "live") return failure("destroyed", "Sandbox is being destroyed.");
    const operationId = randomUUID();
    const physicalDeadline = Date.now() + EXEC_INNER_BOUND_MS;
    const executed = await this.#containerProcess(
      resource,
      [
        "container",
        "exec",
        "-i",
        "--user",
        "user",
        "--workdir",
        "/home/user/app",
        resource.id,
        "node",
        "/usr/local/lib/nap-local/exec.mjs",
        operationId,
        Buffer.from(command).toString("base64url"),
      ],
      {
        timeoutMs: EXEC_TIMEOUT_MS,
        maxStdoutBytes: MAX_EXEC_STDOUT_BYTES,
        maxStderrBytes: MAX_EXEC_STDERR_BYTES,
        ...(onOutput === undefined
          ? {}
          : {
              onStdout: (data: string) => onOutput({ stream: "stdout", data }),
              onStderr: (data: string) => onOutput({ stream: "stderr", data }),
            }),
      },
    );
    if (executed.status !== "completed" || executed.exitCode !== 0) {
      await this.#failClosed(resource, physicalDeadline);
      return failure(
        "unavailable",
        `Local Docker command transport failed: ${processMessage(executed)}`,
      );
    }
    const statusReply = await this.#helper(resource, "exec-result", operationId);
    if (!statusReply.ok) return statusReply;
    const status = ExecStatusSchema.safeParse(statusReply.value);
    if (!status.success) {
      await this.#failClosed(resource, physicalDeadline);
      return failure("unavailable", "Local Docker command status was unavailable.");
    }
    return success({
      exitCode: status.data.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
    });
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>> {
    if (!LOCAL_PORTS.has(port))
      return failure("exec_failed", "Only the local Vite and VNC ports can be bridged.");
    const found = this.#find(sandboxId);
    if (!found.ok) return found;
    const resource = found.value;
    if (resource.state !== "live") return failure("destroyed", "Sandbox is being destroyed.");
    const existing = resource.bridges.get(port);
    if (existing !== undefined) {
      const address = existing.server.address();
      return typeof address === "object" && address !== null
        ? success(`http://127.0.0.1:${address.port}`)
        : failure("unavailable", "Local Docker bridge address is unavailable.");
    }
    return this.#openBridge(resource, port);
  }

  async waitForPreview(
    sandboxId: string,
    port: number,
    opts?: { timeoutMs?: number },
  ): Promise<Result<string, SandboxError>> {
    const timeoutMs = opts?.timeoutMs ?? PREVIEW_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      return failure("exec_failed", "Preview timeout is invalid.");
    const url = await this.getPreviewUrl(sandboxId, port);
    if (!url.ok) return url;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PREVIEW_PROBE_TIMEOUT_MS);
      try {
        await fetch(url.value, { signal: controller.signal });
        return url;
      } catch {
        await delay(Math.min(PREVIEW_PROBE_MS, Math.max(0, deadline - Date.now())));
      } finally {
        clearTimeout(timer);
      }
    }
    return failure("timeout", "Local Docker preview did not become ready before its deadline.");
  }

  close(): Promise<Result<void, { message: string }>> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      this.#closePromise = this.#close();
    }
    return this.#closePromise;
  }

  async #close(): Promise<Result<void, { message: string }>> {
    await Promise.allSettled([...this.#pendingCreates]);
    const failed: string[] = [];
    for (const id of [...this.#resources.keys()]) {
      if (!(await this.#remove(id))) failed.push(id);
    }
    this.#evidence({ event: "closed", failedContainers: failed.length });
    return failed.length === 0
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: { message: `Could not verify removal of ${failed.length} local container(s).` },
        };
  }

  #find(sandboxId: string): Result<ContainerResource, SandboxError> {
    if (this.#destroyed.has(sandboxId)) return failure("destroyed", "Sandbox was destroyed.");
    if (!CONTAINER_ID.test(sandboxId)) return failure("not_found", "Sandbox id is invalid.");
    const resource = this.#resources.get(sandboxId);
    return resource === undefined
      ? failure("not_found", "Sandbox was not created by this local manager.")
      : success(resource);
  }

  #register(id: string, projectId: string): void {
    const startupTtl = Math.max(this.#ttlMs, ADMIN_TIMEOUT_MS);
    const resource: ContainerResource = {
      id,
      projectId,
      state: "live",
      generation: 1,
      expiresAt: Date.now() + startupTtl,
      timer: setTimeout(() => this.#expire(id, 1), startupTtl),
      bridges: new Map(),
      children: new Set(),
    };
    resource.timer.unref();
    this.#resources.set(id, resource);
  }

  #resetTimer(resource: ContainerResource, ms: number): void {
    clearTimeout(resource.timer);
    resource.generation += 1;
    resource.expiresAt = Date.now() + ms;
    const generation = resource.generation;
    resource.timer = setTimeout(() => this.#expire(resource.id, generation), ms);
    resource.timer.unref();
  }

  #expire(id: string, generation: number): void {
    const resource = this.#resources.get(id);
    if (resource === undefined || resource.generation !== generation || resource.state !== "live")
      return;
    this.#remove(id).catch(() => undefined);
  }

  async #inspect(id: string): Promise<z.infer<typeof ContainerInspectSchema>[number] | undefined> {
    const inspected = await runProcess("docker", ["container", "inspect", id], {
      timeoutMs: ADMIN_TIMEOUT_MS,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 65_536,
    });
    if (inspected.status !== "completed" || inspected.exitCode !== 0) return undefined;
    const parsed = ContainerInspectSchema.safeParse(parseJson(inspected.stdout));
    return parsed.success ? parsed.data[0] : undefined;
  }

  async #helper(
    resource: ContainerResource,
    operation: "exec-result" | "list" | "read" | "write",
    argument: string,
    input?: Buffer,
  ): Promise<Result<unknown, SandboxError>> {
    if (resource.state !== "live") return failure("destroyed", "Sandbox is being destroyed.");
    const outcome = await this.#containerProcess(
      resource,
      [
        "container",
        "exec",
        "-i",
        "--user",
        "user",
        "--workdir",
        "/home/user/app",
        resource.id,
        "node",
        "/usr/local/lib/nap-local/file-helper.mjs",
        operation,
        argument,
      ],
      {
        timeoutMs: ADMIN_TIMEOUT_MS,
        maxStdoutBytes: MAX_ADMIN_STDOUT_BYTES,
        maxStderrBytes: MAX_ADMIN_STDERR_BYTES,
        ...(input === undefined ? {} : { input }),
      },
    );
    if (outcome.status !== "completed" || outcome.exitCode !== 0) {
      await this.#failClosed(resource, Date.now());
      return failure(
        "unavailable",
        `Local Docker file transport failed: ${processMessage(outcome)}`,
      );
    }
    const reply = HelperReplySchema.safeParse(parseJson(outcome.stdout));
    if (!reply.success)
      return failure("unavailable", "Local Docker file helper returned malformed output.");
    if (!reply.data.ok) return failure(reply.data.code, "Local Docker file operation failed.");
    return success(reply.data.value);
  }

  async #containerProcess(
    resource: ContainerResource,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessOutcome> {
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      return await runProcess("docker", args, {
        ...options,
        onSpawn: (spawned) => {
          child = spawned;
          resource.children.add(spawned);
        },
      });
    } finally {
      if (child !== undefined) resource.children.delete(child);
    }
  }

  async #failClosed(resource: ContainerResource, physicalDeadline: number): Promise<void> {
    if (await this.#remove(resource.id)) return;
    const remaining = physicalDeadline - Date.now();
    if (remaining > 0) await delay(remaining);
  }

  async #openBridge(
    resource: ContainerResource,
    port: number,
  ): Promise<Result<string, SandboxError>> {
    const sockets = new Set<Socket>();
    const children = new Set<ChildProcessWithoutNullStreams>();
    let bridge: Bridge;
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      this.#connectBridge(resource, bridge, socket);
    });
    bridge = { port, server, sockets, children };
    resource.bridges.set(port, bridge);
    const listening = await new Promise<Result<void, SandboxError>>((resolveListening) => {
      const error = () => {
        resource.bridges.delete(port);
        resolveListening(failure("unavailable", "Local Docker bridge could not bind loopback."));
      };
      server.once("error", error);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", error);
        resolveListening(success(undefined));
      });
    });
    if (!listening.ok) return listening;
    if (resource.state !== "live") {
      await this.#closeBridge(bridge);
      return failure("destroyed", "Sandbox is being destroyed.");
    }
    const address = server.address();
    return typeof address === "object" && address !== null
      ? success(`http://127.0.0.1:${address.port}`)
      : failure("unavailable", "Local Docker bridge address is unavailable.");
  }

  #connectBridge(resource: ContainerResource, bridge: Bridge, socket: Socket): void {
    if (resource.state !== "live" || bridge.sockets.size >= MAX_BRIDGE_CONNECTIONS) {
      socket.destroy();
      return;
    }
    bridge.sockets.add(socket);
    const child = spawn(
      "docker",
      [
        "container",
        "exec",
        "-i",
        "--user",
        "user",
        resource.id,
        "node",
        "/usr/local/lib/nap-local/tcp-forward.mjs",
        String(bridge.port),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    bridge.children.add(child);
    resource.children.add(child);
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 65_536) {
        child.kill("SIGKILL");
        socket.destroy();
      }
    });
    child.stdin.once("error", () => {
      socket.destroy();
      child.kill("SIGTERM");
    });
    child.once("error", () => socket.destroy());
    child.once("close", (code) => {
      bridge.children.delete(child);
      resource.children.delete(child);
      if (code === 0) socket.end();
      else socket.destroy();
    });
    socket.once("error", () => child.kill("SIGTERM"));
    socket.once("close", () => {
      bridge.sockets.delete(socket);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.resume();
  }

  #closeBridge(bridge: Bridge): Promise<void> {
    if (bridge.closing !== undefined) return bridge.closing;
    bridge.closing = new Promise((resolveClose) => {
      let done = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (force !== undefined) clearTimeout(force);
        resolveClose();
      };
      for (const socket of bridge.sockets) socket.destroy();
      for (const child of bridge.children) child.kill("SIGTERM");
      bridge.server.close(finish);
      force = setTimeout(() => {
        for (const child of bridge.children) child.kill("SIGKILL");
        finish();
      }, 1_000);
      force.unref();
    });
    return bridge.closing;
  }

  #remove(id: string): Promise<boolean> {
    const resource = this.#resources.get(id);
    if (resource === undefined) return Promise.resolve(this.#destroyed.has(id));
    if (resource.removal !== undefined) return resource.removal;
    const removal = this.#removeResource(resource);
    resource.removal = removal;
    removal
      .finally(() => {
        if (resource.removal === removal) delete resource.removal;
      })
      .catch(() => undefined);
    return removal;
  }

  async #removeResource(resource: ContainerResource): Promise<boolean> {
    resource.state = "removing";
    clearTimeout(resource.timer);
    await Promise.all([...resource.bridges.values()].map((bridge) => this.#closeBridge(bridge)));
    resource.bridges.clear();
    for (const child of resource.children) child.kill("SIGTERM");
    if (resource.children.size > 0) {
      await delay(250);
      for (const child of resource.children) child.kill("SIGKILL");
    }
    const removed = await runProcess("docker", ["container", "rm", "--force", resource.id], {
      timeoutMs: ADMIN_TIMEOUT_MS,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 65_536,
    });
    const inspected = await runProcess("docker", ["container", "inspect", resource.id], {
      timeoutMs: ADMIN_TIMEOUT_MS,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 65_536,
    });
    const absent =
      inspected.status === "completed" && inspected.exitCode !== 0 && noSuchContainer(inspected);
    if (
      absent &&
      ((removed.status === "completed" && removed.exitCode === 0) || noSuchContainer(removed))
    ) {
      this.#resources.delete(resource.id);
      this.#destroyed.add(resource.id);
      this.#evidence({
        event: "destroyed",
        containerId: resource.id,
        projectId: resource.projectId,
      });
      return true;
    }
    resource.state = "cleanup_failed";
    this.#evidence({
      event: "cleanup_failed",
      containerId: resource.id,
      projectId: resource.projectId,
    });
    return false;
  }

  #evidence(event: Record<string, number | string>): void {
    if (this.#evidenceFile === undefined) return;
    try {
      appendFileSync(
        this.#evidenceFile,
        `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
      );
    } catch {
      // Evidence cannot be allowed to interrupt exact resource cleanup.
    }
  }
}
