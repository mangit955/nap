import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { SETUP_EXEC_TIMEOUT_MS, SETUP_TIMEOUT_SECONDS } from "@nap/shared/command-windows";
import type { RepositoryError, RepositorySource } from "@nap/shared/ports/repository-workspace";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";

const PREVIEW_CONFIGURATION = "/tmp/nap-repository-preview.json";

/** What `timeout(1)` exits with when it had to stop the command. */
const TIMEOUT_EXIT_CODE = 124;

export async function prepareRepositoryEnvironment(options: {
  sandbox: SandboxManager;
  sandboxId: string;
  source: RepositorySource;
  signal?: AbortSignal | undefined;
}): Promise<Result<void, RepositoryError>> {
  const { sandbox, sandboxId, source, signal } = options;
  if (signal?.aborted) return cancelled();
  const stopped = await sandbox.exec(
    sandboxId,
    "pkill -f '[b]un run dev' || true; pkill -f '[v]ite' || true",
  );
  if (!stopped.ok) return failed("Could not stop the starter preview.");

  if (source.setupCommand !== null) {
    const marker = `/tmp/nap-setup-${crypto.randomUUID()}`;
    let cancellation: Promise<unknown> | undefined;
    const abort = () => {
      cancellation = sandbox.exec(
        sandboxId,
        `touch ${marker}.cancel; if test -f ${marker}.pid; then kill -TERM -- -$(cat ${marker}.pid) 2>/dev/null || true; fi`,
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) return cancelled();
      const script =
        `cd ${TEMPLATE_WORKDIR} || exit 1; test ! -f ${marker}.cancel || exit 143; ` +
        `setsid timeout ${SETUP_TIMEOUT_SECONDS}s sh -c ${shellQuote(source.setupCommand)} & nap_setup_pid=$!; ` +
        `printf '%s' "$nap_setup_pid" > ${marker}.pid; ` +
        `if test -f ${marker}.cancel; then kill -TERM -- -"$nap_setup_pid" 2>/dev/null || true; fi; ` +
        `wait "$nap_setup_pid"; nap_setup_status=$?; rm -f ${marker}.pid ${marker}.cancel; exit "$nap_setup_status"`;
      // The signal only stops the wait. `abort` above is what stops setup, because it signals the
      // whole process group and a provider's kill of this shell would not.
      const setup = await sandbox.exec(sandboxId, script, undefined, {
        signal,
        timeoutMs: SETUP_EXEC_TIMEOUT_MS,
      });
      if (signal?.aborted) return cancelled();
      if (setup.ok && setup.value.exitCode === TIMEOUT_EXIT_CODE)
        return failed(
          `Repository setup did not finish within ${SETUP_TIMEOUT_SECONDS / 60} minutes. Shorten the configured setup command and retry.`,
        );
      if (!setup.ok || setup.value.exitCode !== 0)
        return failed("Repository setup failed. Check the configured setup command and retry.");
    } finally {
      signal?.removeEventListener("abort", abort);
      await cancellation;
    }
  }

  if (signal?.aborted) return cancelled();
  const clean = await sandbox.exec(
    sandboxId,
    `cd ${TEMPLATE_WORKDIR} && git -c core.hooksPath=/dev/null status --porcelain`,
  );
  if (signal?.aborted) return cancelled();
  if (!clean.ok || clean.value.exitCode !== 0)
    return failed("Could not check the repository after setup. Check the setup command and retry.");
  if (clean.value.stdout.trim() !== "")
    return failed(
      "Repository setup must preserve tracked files and ignore generated output. Use a dependency command such as bun install --frozen-lockfile or npm ci, update .gitignore, and retry.",
    );
  if (source.devCommand !== null) {
    const started = await sandbox.exec(
      sandboxId,
      `cd ${TEMPLATE_WORKDIR} && nohup sh -c ${shellQuote(source.devCommand)} </dev/null >/tmp/nap-preview.log 2>&1 &`,
    );
    if (!started.ok || started.value.exitCode !== 0)
      return failed("Could not start the repository preview.");
  }
  if (signal?.aborted) return cancelled();
  const recorded = await sandbox.writeFile(
    sandboxId,
    PREVIEW_CONFIGURATION,
    JSON.stringify({ previewPort: source.previewPort }),
  );
  if (!recorded.ok) return failed("Could not record the running repository preview configuration.");
  return signal?.aborted ? cancelled() : { ok: true, value: undefined };
}

export async function readRepositoryPreviewPort(options: {
  sandbox: SandboxManager;
  sandboxId: string;
  fallback: number | null;
}): Promise<Result<number | null, RepositoryError>> {
  const saved = await options.sandbox.readFile(options.sandboxId, PREVIEW_CONFIGURATION);
  if (!saved.ok)
    return saved.error.code === "file_not_found"
      ? { ok: true, value: options.fallback }
      : failed("Could not read the running repository preview configuration.");
  let configuration: unknown;
  try {
    configuration = JSON.parse(saved.value);
  } catch {
    return failed(
      "The running repository preview configuration is invalid. Restart the workspace.",
    );
  }
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    !("previewPort" in configuration) ||
    (configuration.previewPort !== null &&
      (typeof configuration.previewPort !== "number" ||
        !Number.isInteger(configuration.previewPort) ||
        configuration.previewPort < 1024 ||
        configuration.previewPort > 65535))
  )
    return failed(
      "The running repository preview configuration is invalid. Restart the workspace.",
    );
  return { ok: true, value: configuration.previewPort };
}

function failed(message: string): Result<never, RepositoryError> {
  return { ok: false, error: { code: "unavailable", message } };
}

function cancelled(): Result<never, RepositoryError> {
  return { ok: false, error: { code: "cancelled", message: "Repository setup was cancelled." } };
}
