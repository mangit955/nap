import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runDesktopProcess } from "./desktop-process.ts";

function node(script: string, options?: Parameters<typeof runDesktopProcess>[2]) {
  return runDesktopProcess(process.execPath, ["--input-type=commonjs", "-e", script], options);
}

it("gives a no-input helper devnull stdin and accepts its successful close", async () => {
  const output = await node(`
    const { fstatSync, closeSync, writeSync } = require('node:fs');
    const devnull = fstatSync(0).isCharacterDevice();
    closeSync(0);
    writeSync(1, JSON.stringify({ devnull }));
  `);
  expect(output.toString()).toBe('{"devnull":true}');
});

it.each([
  { name: "empty input", input: "" },
  { name: "complete Unicode and NUL bytes", input: "hello π🙂\u0000\n".repeat(4096) },
])("pipes $name without replacing it with devnull", async ({ input }) => {
  const output = await node(
    `
    const { fstatSync } = require('node:fs');
    const devnull = fstatSync(0).isCharacterDevice();
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ devnull, bytes: Buffer.concat(chunks).toString('base64') }));
    });
  `,
    { input },
  );
  expect(output.toString()).toBe(
    JSON.stringify({
      devnull: false,
      bytes: Buffer.from(input).toString("base64"),
    }),
  );
});

it("waits for CLOSE after exit while a descendant still owns the output pipe", async () => {
  const output = await node(
    `
    const { spawn } = require('node:child_process');
    const { writeSync } = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      writeSync(1, 'parent-exit;');
      spawn(process.execPath, ['--input-type=commonjs', '-e',
        "setTimeout(() => require('node:fs').writeSync(1, 'descendant-close'), 80)"
      ], { stdio: ['ignore', 1, 2] });
      process.exit(0);
    });
  `,
    { input: "" },
  );
  expect(output.toString()).toBe("parent-exit;descendant-close");
});

it("rejects failed explicit input delivery only after the child output has closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "nap-desktop-process-"));
  const marker = join(root, "descendant-closed");
  let descendantClosedAtRejection = false;
  try {
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed'), 80)`;
    await expect(
      node(
        `
      const { spawn } = require('node:child_process');
      const { closeSync } = require('node:fs');
      spawn(process.execPath, ['--input-type=commonjs', '-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', 1, 2],
      });
      closeSync(0);
      setTimeout(() => process.exit(0), 1000);
    `,
        { input: "x".repeat(2_000_000) },
      ),
    ).rejects.toThrow("Desktop process failed.");
    descendantClosedAtRejection = existsSync(marker);
  } finally {
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 1500 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  expect(descendantClosedAtRejection).toBe(true);
});
