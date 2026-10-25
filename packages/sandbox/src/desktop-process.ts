import { spawn } from "node:child_process";

export function runDesktopProcess(
  program: string,
  args: readonly string[],
  options: {
    input?: string;
    signal?: AbortSignal;
    maxBytes?: number;
    inputFd?: number | undefined;
  } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fd = options.inputFd;
    const stdin = options.input === undefined ? "ignore" : "pipe";
    const child = spawn(program, [...args], {
      env: { ...process.env, DISPLAY: ":99" },
      stdio: fd === undefined ? [stdin, "pipe", "pipe"] : [stdin, "pipe", "pipe", fd],
    });
    const output: Buffer[] = [];
    let size = 0;
    let failed = false;
    const terminate = () => {
      failed = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(terminate, 45_000);
    const kill = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 47_000);
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 1_000_000)) terminate();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      collect(chunk);
      if (!failed) output.push(chunk);
    });
    child.stderr?.on("data", collect);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(kill);
      options.signal?.removeEventListener("abort", terminate);
      if (failed || code !== 0) reject(new Error("Desktop process failed."));
      else resolve(Buffer.concat(output));
    });
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    child.stdin?.on("error", terminate);
    child.stdin?.end(options.input ?? "");
  });
}
