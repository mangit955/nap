/**
 * Both directions of the disambiguation, against the in-memory sandbox.
 *
 * The fake models exactly the two facts that matter independently — whether the public URL
 * serves (`listen`) and what a command inside the sandbox returns (`script`) — so the case
 * that cannot be observed in production without an outage is trivial to construct here.
 */

import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { describe, expect, it } from "vitest";
import { CURL_COULD_NOT_CONNECT, diagnosePreview, portListeningProbe } from "./preview.ts";

const PORT = 5173;

async function sandboxWith(options: {
  serving: boolean;
  probe?: { exitCode: number };
  destroyed?: boolean;
}) {
  const sandbox = new InMemorySandboxManager({
    serves: options.serving ? [PORT] : [],
    defaultExec: () => options.probe ?? { exitCode: 0 },
  });
  const created = await sandbox.create(crypto.randomUUID());
  if (!created.ok) throw new Error("the fake refused to create a sandbox");
  if (options.destroyed === true) await sandbox.destroy(created.value.id);
  return { sandbox, sandboxId: created.value.id };
}

describe("diagnosePreview", () => {
  it("reports the URL when the preview serves", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ serving: true });

    const diagnosis = await diagnosePreview(sandbox, sandboxId, PORT);

    expect(diagnosis.state).toBe("serving");
    if (diagnosis.state === "serving") expect(diagnosis.url).toContain(`${PORT}-${sandboxId}`);
  });

  it("does not probe inside the sandbox when the preview already serves", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ serving: true });

    await diagnosePreview(sandbox, sandboxId, PORT);

    expect(sandbox.commands(sandboxId)).toEqual([]);
  });

  it("says the application did not start when nothing is listening inside", async () => {
    const { sandbox, sandboxId } = await sandboxWith({
      serving: false,
      probe: { exitCode: CURL_COULD_NOT_CONNECT },
    });

    const diagnosis = await diagnosePreview(sandbox, sandboxId, PORT);

    expect(diagnosis.state).toBe("not_started");
    expect(sandbox.commands(sandboxId)).toEqual([portListeningProbe(PORT)]);
  });

  it("says the preview is unreachable when the port is listening but the URL is not", async () => {
    // The same observation from the host as the case above — the URL did not answer — and
    // the opposite attribution. Without the probe these two are one outcome, and the one it
    // would be recorded as is the agent's worst.
    const { sandbox, sandboxId } = await sandboxWith({ serving: false, probe: { exitCode: 0 } });

    const diagnosis = await diagnosePreview(sandbox, sandboxId, PORT);

    expect(diagnosis.state).toBe("unreachable");
    if (diagnosis.state === "unreachable") expect(diagnosis.detail).toContain("is listening");
  });

  it("treats any exit code other than a refused connection as the probe failing", async () => {
    // 127 is "curl: not found". An image without curl would otherwise report every
    // application in every task as one that did not start.
    const { sandbox, sandboxId } = await sandboxWith({ serving: false, probe: { exitCode: 127 } });

    const diagnosis = await diagnosePreview(sandbox, sandboxId, PORT);

    expect(diagnosis.state).toBe("unreachable");
  });

  it("treats a sandbox that refuses the probe as unreachable, not as a dead application", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ serving: false, destroyed: true });

    const diagnosis = await diagnosePreview(sandbox, sandboxId, PORT);

    expect(diagnosis.state).toBe("unreachable");
    if (diagnosis.state === "unreachable")
      expect(diagnosis.detail).toContain("could not be probed");
  });
});

describe("portListeningProbe", () => {
  it("asks about loopback inside the sandbox, not about the public address", () => {
    expect(portListeningProbe(PORT)).toContain("http://127.0.0.1:5173/");
  });

  it("does not fail on an HTTP error status", () => {
    // A dev server returning 500 has started. `curl -f` would exit non-zero on it, and the
    // run would be recorded as an application that never came up.
    expect(portListeningProbe(PORT)).not.toMatch(/(^|\s)-[a-zA-Z]*f/);
  });
});
