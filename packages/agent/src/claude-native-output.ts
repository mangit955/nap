import type { NativeOutputEvent } from "@nap/shared/native-delivery-protocol";
import { NativeFrameDecoder } from "@nap/shared/native-process-protocol";
import type { ProcessEvent } from "@nap/shared/ports/sandbox-process";
import { z } from "zod";
import { type ClaudeNativeFrame, ClaudeNativeFrameSchema } from "./claude-native-wire.ts";

const Message = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
});
const Delta = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
]);
const Stream = z.object({
  type: z.literal("stream_event"),
  event: z.object({ type: z.string() }).passthrough(),
});
const Start = z.object({
  type: z.literal("message_start"),
  message: z.object({ id: z.string().min(1) }),
});
const BlockStart = z.object({
  type: z.literal("content_block_start"),
  content_block: z.object({ type: z.string(), text: z.string().optional() }),
});
const BlockDelta = z.object({ type: z.literal("content_block_delta"), delta: z.unknown() });
const Assistant = z.object({
  type: z.literal("assistant"),
  message: z.object({
    id: z.string().min(1),
    content: z.array(
      z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional() }),
    ),
  }),
});
type Finished = Extract<ClaudeNativeFrame, { type: "finished" }>;
type Control = Extract<ClaudeNativeFrame, { type: "tool_call" }>;

/** Rebuilt from encrypted frames on reconnect; raw provider diagnostics never become public events. */
export class ClaudeNativeOutput {
  readonly #decoder = new NativeFrameDecoder(ClaudeNativeFrameSchema, 1024 * 1024);
  readonly #streamedText = new Set<string>();
  readonly #streamedThinking = new Set<string>();
  readonly #complete = new Set<string>();
  #current: string | null = null;
  #control: Control[] = [];
  #result: Finished["result"] | null = null;
  constructor(private readonly sessionId: string) {
    z.uuid().parse(sessionId);
  }
  get result() {
    return this.#result;
  }
  takeControl(): Control[] {
    const result = this.#control;
    this.#control = [];
    return result;
  }
  accept(event: ProcessEvent): NativeOutputEvent[] {
    if (event.kind === "exit") {
      this.#decoder.finish();
      if (this.#result === null)
        throw new Error("Native process exited without a completion receipt.");
      return [];
    }
    if (event.stream === "stderr") return [];
    const output: NativeOutputEvent[] = [];
    for (const frame of this.#decoder.push(event.data)) {
      if (this.#result !== null) throw new Error("Native output followed its completion receipt.");
      if (frame.type === "finished") {
        this.#result = frame.result;
        continue;
      }
      if (frame.type === "tool_call") {
        if (this.#control.length >= 8) throw new Error("Too many pending native operations.");
        this.#control.push(frame);
        continue;
      }
      const message = Message.parse(frame.message);
      if (message.session_id !== undefined && message.session_id !== this.sessionId)
        throw new Error("Native output session mismatch.");
      if (message.parent_tool_use_id != null)
        throw new Error("Nested native agents are unavailable.");
      if (message.type === "stream_event") {
        const event = Stream.parse(frame.message).event;
        if (event.type === "message_start") this.#current = Start.parse(event).message.id;
        else if (event.type === "content_block_start") {
          const block = BlockStart.parse(event).content_block;
          if (block.type === "text" && block.text) this.#text("agent.message", block.text, output);
        } else if (event.type === "content_block_delta") {
          const delta = Delta.safeParse(BlockDelta.parse(event).delta);
          if (delta.success) {
            if (delta.data.type === "text_delta")
              this.#text("agent.message", delta.data.text, output);
            else this.#text("agent.thinking", delta.data.thinking, output);
          }
        }
      } else if (message.type === "assistant") {
        const assistant = Assistant.parse(frame.message).message;
        if (this.#complete.has(assistant.id)) continue;
        this.#complete.add(assistant.id);
        for (const block of assistant.content) {
          if (block.type === "text" && block.text && !this.#streamedText.has(assistant.id))
            output.push({ type: "agent.message", payload: { text: block.text } });
          else if (
            block.type === "thinking" &&
            block.thinking &&
            !this.#streamedThinking.has(assistant.id)
          )
            output.push({ type: "agent.thinking", payload: { text: block.thinking } });
        }
      }
    }
    return output;
  }
  #text(type: "agent.message" | "agent.thinking", text: string, output: NativeOutputEvent[]) {
    if (this.#current === null) throw new Error("Native text arrived before its message identity.");
    (type === "agent.message" ? this.#streamedText : this.#streamedThinking).add(this.#current);
    if (text.length > 0) output.push({ type, payload: { text } });
  }
}
