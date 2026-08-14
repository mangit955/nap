/**
 * Telling "the app never started" apart from "nobody could reach the app".
 *
 * This is the most consequential distinction in the benchmark, because the two look
 * identical from the host: the preview URL does not answer. One of them is the agent's worst
 * possible outcome — it built something that does not run — and the other is the most likely
 * infrastructure fault in the whole system, since the address is served through a public
 * proxy that becomes ready separately from the dev server behind it. Guessing means recording
 * a proxy hiccup as a broken application, on the task where the agent had the most to lose.
 *
 * So the question is asked from *inside*. A dev server that is up answers on loopback whatever
 * the proxy is doing, and one that never started does not answer anywhere.
 *
 * **Doubt resolves towards infrastructure.** If the probe itself cannot be run, or answers in
 * a way that is not a clean "nothing is listening", the run errors rather than failing. An
 * error costs a re-run; a wrong failure is a permanent, plausible-looking libel of the agent
 * sitting in an archived report.
 */

import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";

/**
 * curl's "could not connect to host", which is the only answer that means the application
 * did not start. Every other non-zero exit — curl missing (127), a signal, a DNS oddity — is
 * the probe failing rather than the port being shut, and is treated as such.
 *
 * See `curl(1)`. Deliberately *not* extended to 28 (timeout): something that accepts a
 * connection and then hangs is a started application behaving badly, which is the agent's.
 */
export const CURL_COULD_NOT_CONNECT = 7;

/** How long the in-sandbox probe waits before giving up, in seconds. */
const PROBE_TIMEOUT_SECONDS = 5;

/**
 * A command that answers "is anything serving this port inside the sandbox?".
 *
 * No `-f`, so any HTTP status counts as listening: a dev server returning 500 has started,
 * and the question here is connectivity rather than health. Output is discarded because only
 * the exit code is read — a page of HTML in a report explains nothing.
 */
export function portListeningProbe(port: number): string {
  return `curl -s -o /dev/null --max-time ${PROBE_TIMEOUT_SECONDS} http://127.0.0.1:${port}/`;
}

export type PreviewDiagnosis =
  /** Something answered at the public URL. The address is included; browser checks need it. */
  | { state: "serving"; url: string }
  /** Nothing is listening inside the sandbox: the application did not start. The agent's. */
  | { state: "not_started"; detail: string }
  /** It is listening but the host cannot get to it, or the probe could not be run. Ours. */
  | { state: "unreachable"; detail: string };

export type DiagnosePreviewOptions = {
  /** How long to wait for the public URL before probing from inside. */
  timeoutMs?: number;
};

export async function diagnosePreview(
  sandbox: SandboxManager,
  sandboxId: string,
  port: number,
  options: DiagnosePreviewOptions = {},
): Promise<PreviewDiagnosis> {
  // `waitForPreview` rather than `getPreviewUrl`: the second only composes an address and
  // says nothing about whether anything answers at it.
  const served = await sandbox.waitForPreview(
    sandboxId,
    port,
    options.timeoutMs ? { timeoutMs: options.timeoutMs } : {},
  );
  if (served.ok) return { state: "serving", url: served.value };

  const probe = await sandbox.exec(sandboxId, portListeningProbe(port));

  if (!probe.ok) {
    return {
      state: "unreachable",
      detail:
        `the preview did not answer (${served.error.code}: ${served.error.message}) and the ` +
        `port could not be probed inside the sandbox: ${probe.error.code} — ${probe.error.message}`,
    };
  }

  if (probe.value.exitCode === CURL_COULD_NOT_CONNECT) {
    return {
      state: "not_started",
      detail: `nothing is listening on port ${port} inside the sandbox: the application did not start`,
    };
  }

  if (probe.value.exitCode !== 0) {
    // Not a refused connection, so the probe itself is what went wrong. Charging this to the
    // agent would mean a sandbox without curl scores every application as broken.
    return {
      state: "unreachable",
      detail:
        `the preview did not answer (${served.error.code}) and the probe exited ` +
        `${probe.value.exitCode}, which is not a refused connection — the port's state is unknown`,
    };
  }

  return {
    state: "unreachable",
    detail:
      `port ${port} is listening inside the sandbox but the preview URL did not answer ` +
      `(${served.error.code}: ${served.error.message})`,
  };
}
