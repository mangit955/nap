/** Installed only in the private authenticated runtime, never in a project's workspace. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { encodeNativeFrame, NativeFrameDecoder } from "@nap/shared/native-process-protocol";
import { ClaudeNativeHelper } from "./claude-native-helper.ts";
import { ClaudeNativeCommandSchema } from "./claude-native-wire.ts";

export async function main(): Promise<void> {
  const decoder = new NativeFrameDecoder(ClaudeNativeCommandSchema, 4 * 1024 * 1024);
  const helper = new ClaudeNativeHelper({
    query,
    write: async (frame) => {
      const line = encodeNativeFrame(frame);
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Native output exceeded its frame limit.");
      await new Promise<void>((done, reject) => {
        process.stdout.write(line, (error) => (error ? reject(error) : done()));
      });
    },
  });
  let closing = false;
  let invalidInput = false;
  const input = (async () => {
    try {
      for await (const chunk of process.stdin) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Invalid native input bytes.");
        for (const command of decoder.push(chunk)) await helper.accept(command);
      }
      decoder.finish();
    } catch {
      if (!closing) invalidInput = true;
    } finally {
      helper.stop();
    }
  })();
  try {
    await Promise.race([input, helper.closed]);
    helper.stop();
    await helper.closed;
  } finally {
    helper.stop();
    closing = true;
    process.stdin.destroy();
    await input;
  }
  if (invalidInput) throw new Error("Invalid native command channel.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
