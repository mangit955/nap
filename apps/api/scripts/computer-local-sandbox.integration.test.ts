import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import type { Result } from "@nap/shared/result";
import { describe, expect, it } from "vitest";
import { LocalDockerSandboxManager } from "./computer-local-sandbox.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const enabled = process.env.NAP_RUN_LOCAL_DOCKER_INTEGRATION === "1";

function unwrap<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe.skipIf(!enabled)("LocalDockerSandboxManager real Docker", () => {
  it("runs the real template, Git, checks, bridges, production desktop, cancellation, and recording", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "nap-local-docker-integration-"));
    const manager = unwrap(
      await LocalDockerSandboxManager.open({
        repositoryRoot,
        memoryMB: 2_048,
        ttlMs: 10 * 60_000,
        evidenceDirectory,
      }),
    );
    let sandboxId: string | undefined;
    try {
      const created = unwrap(await manager.create("integration-local-docker"));
      sandboxId = created.id;
      expect(sandboxId).toMatch(/^[0-9a-f]{64}$/);

      const versions = unwrap(
        await manager.exec(
          sandboxId,
          "printf 'node='; node --version; printf 'bun='; bun --version; printf 'chrome='; google-chrome-stable --product-version",
        ),
      );
      expect(versions).toMatchObject({ exitCode: 0 });
      expect(versions.stdout).toContain("bun=1.3.13");
      expect(versions.stdout).toContain("chrome=156.0.8078.47");

      expect(unwrap(await manager.readFile(sandboxId, "/home/user/app/src/App.tsx"))).toContain(
        "function App",
      );
      unwrap(
        await manager.writeFile(
          sandboxId,
          "/home/user/app/local-proof.txt",
          "real local Docker sandbox\n",
        ),
      );
      expect(unwrap(await manager.readFile(sandboxId, "/home/user/app/local-proof.txt"))).toBe(
        "real local Docker sandbox\n",
      );
      expect(unwrap(await manager.listFiles(sandboxId, "/home/user/app"))).toContainEqual({
        path: "/home/user/app/local-proof.txt",
        type: "file",
      });

      const nonzero = unwrap(
        await manager.exec(sandboxId, "printf 'expected failure\\n' >&2; exit 3"),
      );
      expect(nonzero).toEqual({ exitCode: 3, stdout: "", stderr: "expected failure\n" });
      const checks = unwrap(
        await manager.exec(
          sandboxId,
          "git add local-proof.txt && git commit -m 'Local proof' && bun run typecheck && bun run build && git status --porcelain",
        ),
      );
      expect(checks.exitCode, checks.stderr).toBe(0);
      expect(unwrap(await manager.exec(sandboxId, "git rev-parse --verify HEAD"))).toMatchObject({
        exitCode: 0,
        stderr: "",
      });

      const previewUrl = unwrap(
        await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 120_000 }),
      );
      expect(new URL(previewUrl).hostname).toBe("127.0.0.1");
      expect((await fetch(previewUrl)).ok).toBe(true);

      const desktop = new E2BSandboxDesktop({ sandbox: manager });
      expect(
        unwrap(
          await desktop.start({
            sandboxId,
            devServerUrl: "http://127.0.0.1:5173/",
          }),
        ),
      ).toEqual({ width: 1024, height: 768 });
      const dom = unwrap(await desktop.act(sandboxId, { action: "read_dom" }));
      expect(dom.kind).toBe("text");
      const frame = unwrap(await desktop.screenshot(sandboxId));
      expect(frame).toMatchObject({ width: 1024, height: 768 });
      expect(frame.bytes.byteLength).toBeGreaterThan(1_000);

      const credentials = unwrap(await desktop.streamCredentials(sandboxId));
      const streamUrl = new URL(credentials.url);
      expect(streamUrl.protocol).toBe("ws:");
      expect(streamUrl.hostname).toBe("127.0.0.1");
      expect(streamUrl.pathname).toBe("/websockify");
      const vnc = new URL(unwrap(await manager.getPreviewUrl(sandboxId, 6080)));
      vnc.pathname = "/vnc.html";
      expect((await fetch(vnc)).ok).toBe(true);

      const cancellation = new AbortController();
      const waiting = desktop.act(sandboxId, { action: "wait", duration: 10 }, cancellation.signal);
      setTimeout(() => cancellation.abort(), 250);
      await expect(waiting).resolves.toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });

      const recordingId = crypto.randomUUID();
      unwrap(await desktop.begin({ sandboxId, recordingId }));
      unwrap(await desktop.act(sandboxId, { action: "wait", duration: 0.5 }));
      expect(unwrap(await desktop.timestamp({ sandboxId, recordingId }))).toBeGreaterThan(0);
      const video = unwrap(await desktop.finish({ sandboxId, recordingId }));
      expect(video.bytes.byteLength).toBeGreaterThan(1_000);
      expect(Buffer.from(video.bytes).toString("ascii", 4, 8)).toBe("ftyp");
    } finally {
      if (sandboxId !== undefined) await manager.destroy(sandboxId);
      const firstClose = manager.close();
      expect(manager.close()).toBe(firstClose);
      expect(await firstClose).toEqual({ ok: true, value: undefined });
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  }, 1_200_000);
});
