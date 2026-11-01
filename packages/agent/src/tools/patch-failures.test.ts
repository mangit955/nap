import type { PendingEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { LocalShellSandbox } from "../testing/local-shell-sandbox.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";
import { FileLedger } from "./ledger.ts";

const SOURCE = `${PROJECT_ROOT}/source.txt`;
const TARGET = `${PROJECT_ROOT}/target.txt`;
const BEFORE = "uncommitted source\n";
const AFTER = "updated source\n";

describe("patch move failures on a real filesystem", () => {
  it.each(["none", "destination write", "source deletion"] as const)(
    "keeps bytes, ledger and change events honest after %s failure",
    async (failure) => {
      const sandbox = await LocalShellSandbox.create();
      try {
        await sandbox.writeFile(sandbox.id, SOURCE, BEFORE);
        const ledger = new FileLedger();
        ledger.remember(SOURCE);
        const events: PendingEvent[] = [];
        const write = sandbox.writeFile.bind(sandbox);
        sandbox.writeFile = async (id, path, contents) =>
          failure === "destination write" && path === TARGET
            ? { ok: false, error: { code: "unavailable", message: "Destination unavailable" } }
            : write(id, path, contents);
        const exec = sandbox.exec.bind(sandbox);
        sandbox.exec = (id, command, onOutput, options) =>
          failure === "source deletion" && command.startsWith("rm -f")
            ? Promise.resolve({
                ok: true,
                value: { exitCode: 1, stdout: "", stderr: "Source permission denied" },
              })
            : exec(id, command, onOutput, options);

        const result = await executeTool(
          {
            id: "move",
            name: "apply_patch",
            input: {
              patch: [
                "*** Begin Patch",
                "*** Update File: source.txt",
                "*** Move to: target.txt",
                "-uncommitted source",
                "+updated source",
                "*** End Patch",
              ].join("\n"),
            },
          },
          {
            sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
            turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
            sandboxId: sandbox.id,
            sandbox,
            ledger,
            emit: (event) => events.push(event),
          },
        );

        expect(result.ok).toBe(failure === "none");
        const source = await sandbox.readFile(sandbox.id, SOURCE);
        const target = await sandbox.readFile(sandbox.id, TARGET);
        expect(source).toEqual(
          failure === "none"
            ? { ok: false, error: expect.objectContaining({ code: "file_not_found" }) }
            : { ok: true, value: BEFORE },
        );
        expect(target).toEqual(
          failure === "destination write"
            ? { ok: false, error: expect.objectContaining({ code: "file_not_found" }) }
            : { ok: true, value: AFTER },
        );
        expect(ledger.knows(SOURCE)).toBe(failure !== "none");
        expect(ledger.knows(TARGET)).toBe(failure !== "destination write");
        const changes = events.flatMap((event) =>
          event.type === "file.changed" ? [event.payload] : [],
        );
        expect(changes).toHaveLength(
          failure === "none" ? 2 : failure === "source deletion" ? 1 : 0,
        );
        if (failure !== "destination write")
          expect(changes).toContainEqual(
            expect.objectContaining({ path: TARGET, changeType: "created" }),
          );
        if (failure !== "none") {
          expect(changes.some((change) => change.path === SOURCE)).toBe(false);
          expect(result.output).toContain(
            failure === "destination write"
              ? "Destination unavailable"
              : "Source permission denied",
          );
          if (failure === "source deletion")
            expect(result.output).not.toMatch(/Nothing was changed/i);
        }
      } finally {
        await sandbox.dispose();
      }
    },
  );
});
