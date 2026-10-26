import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";

const operationId = process.argv[2] ?? "";
const encodedCommand = process.argv[3] ?? "";
if (!/^[0-9a-f-]{36}$/.test(operationId) || !/^[A-Za-z0-9_-]+$/.test(encodedCommand)) {
  process.stderr.write("Invalid local execution request.\n");
  process.exit(64);
}

const command = Buffer.from(encodedCommand, "base64url").toString("utf8");
const directory = "/tmp/nap-exec-results";
const resultPath = `${directory}/${operationId}.json`;
const temporaryPath = `${resultPath}.${process.pid}.tmp`;
await mkdir(directory, { recursive: true, mode: 0o700 });

const child = spawn(
  "timeout",
  ["--signal=TERM", "--kill-after=3s", "120s", "bash", "-lc", command],
  { cwd: "/home/user/app", stdio: "inherit" },
);
let exitCode = 125;
await new Promise((resolve) => {
  child.once("error", () => resolve());
  child.once("close", (code) => {
    exitCode = code ?? 125;
    resolve();
  });
});
await writeFile(temporaryPath, `${JSON.stringify({ exitCode })}\n`, { mode: 0o600 });
await rename(temporaryPath, resultPath);
