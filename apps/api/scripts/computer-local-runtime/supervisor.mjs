import { spawn } from "node:child_process";

const vite = spawn(
  "bun",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  {
    cwd: "/home/user/app",
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  },
);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (vite.pid !== undefined) process.kill(-vite.pid, signal);
  setTimeout(() => {
    if (vite.pid !== undefined) {
      try {
        process.kill(-vite.pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
    }
  }, 3_000).unref();
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
vite.on("error", (error) => {
  process.stderr.write(`Vite startup failed: ${error.message}\n`);
  process.exitCode = 1;
});
vite.on("exit", (code, signal) => {
  if (!stopping && (code !== 0 || signal !== null)) process.exitCode = code ?? 1;
  process.exit();
});
