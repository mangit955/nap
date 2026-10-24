/** Exercises the shipped supervisor bundle without credentials, a model, or an E2B sandbox. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  type NativeHostEvent,
  NativeHostEventSchema,
} from "@nap/shared/native-process-protocol";

const artifact = fileURLToPath(new URL("../dist/native-process-host.mjs", import.meta.url));
for (const terminalSize of [undefined, { columns: 80, rows: 24 }]) {
  const child = spawn("node", [artifact], { stdio: ["pipe", "pipe", "inherit"] });
  const token = randomBytes(32).toString("hex");
  const decoder = new NativeFrameDecoder(NativeHostEventSchema, 1024 * 1024);
  const events: NativeHostEvent[] = [];
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.stdout.on("data", (chunk: Buffer) => {
    for (const event of decoder.push(chunk)) {
      events.push(event);
      if (event.type === "ready")
        child.stdin.write(
          encodeNativeFrame({ type: "input", token, data: "sandbox transport works\n" }),
        );
      if (event.type === "output")
        child.stdin.write(encodeNativeFrame({ type: "ack", token, sequence: event.seq }));
    }
  });
  child.stdin.write(
    encodeNativeFrame({
      type: "start",
      token,
      executable: process.execPath,
      ...(terminalSize === undefined ? {} : { terminal: terminalSize }),
      args: [
        "-e",
        terminalSize === undefined
          ? 'process.stdin.once("data", data => { process.stdout.write(data); process.stdin.destroy(); });'
          : 'if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(9); process.stdin.once("data", data => process.stdout.write("RECEIVED:" + data, () => process.exit(0)));',
      ],
      cwd: process.cwd(),
      env: {},
      leaseMs: 2000,
      maxOutputBytes: 65536,
      maxReplayBytes: 65536,
      containment: { kind: "process_group" },
    }),
  );
  try {
    await closed;
    decoder.finish();
    const text = events
      .filter((event) => event.type === "output")
      .map((event) => Buffer.from(event.data, "base64").toString())
      .join("");
    const terminal = events.at(-1);
    if (
      (terminalSize === undefined
        ? text !== "sandbox transport works\n"
        : !text.includes("RECEIVED:sandbox transport works")) ||
      terminal?.type !== "exit" ||
      terminal.code !== 0 ||
      terminal.reason !== "exited"
    )
      throw new Error("Native supervisor smoke check failed");
    console.log(
      JSON.stringify({
        passed: true,
        output: text.trim(),
        terminal: terminalSize !== undefined,
        termination: terminal.containment,
      }),
    );
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
  }
}
