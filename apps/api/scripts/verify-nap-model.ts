/**
 * The scripted model behind the verification fixture (`verify-nap.ts`).
 *
 * It exists so an agent proving a UI change can watch a turn the way a person does — reasoning
 * streams, files appear in the tree, the reply lands — without a model call. Two things shape it:
 *
 * - Every step waits before answering, so a turn lasts long enough for somebody to steer it. A
 *   steer is read at the next step boundary (docs/adr/0028), and a turn that finished in a
 *   millisecond would leave nothing to steer.
 * - The closing answer quotes the newest user message it was shown. A steer that reached the
 *   model is therefore visible in the chat, which is the only way a browser can tell a steer
 *   that was taken from one that was queued as the next turn.
 */

import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMTurn,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";

const USAGE = { inputTokens: 1_000, outputTokens: 60 };

/**
 * The files a turn writes, in order: one per step, so the file tree changes while it runs. Later
 * turns write new files, because the agent refuses to overwrite a file it has not read this turn.
 */
function writesFor(turn: number) {
  if (turn === 1)
    return [
      {
        path: `${TEMPLATE_WORKDIR}/src/App.tsx`,
        contents:
          'import { NoteList } from "./components/NoteList";\n\nexport function App() {\n  return <NoteList />;\n}\n',
        thinking: ["The project needs an entry component, ", "so I will write App first."],
        text: "Writing the app shell.",
      },
      {
        path: `${TEMPLATE_WORKDIR}/src/components/NoteList.tsx`,
        contents: 'export function NoteList() {\n  return <ul aria-label="Notes" />;\n}\n',
        thinking: ["App imports NoteList, ", "so the list comes next."],
        text: "Adding the note list.",
      },
    ];
  return [
    {
      path: `${TEMPLATE_WORKDIR}/src/features/Change${turn}.tsx`,
      contents: `export function Change${turn}() {\n  return <section aria-label="Change ${turn}" />;\n}\n`,
      thinking: ["This asks for a new piece, ", "so I will add a component for it."],
      text: `Adding Change${turn}.`,
    },
    {
      path: `${TEMPLATE_WORKDIR}/src/features/change${turn}.css`,
      contents: `section[aria-label="Change ${turn}"] {\n  padding: 8px;\n}\n`,
      thinking: ["It needs a little styling."],
      text: "Styling it.",
    },
  ];
}

function textOf(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
}

/** The newest thing a person said, which after a steer is the steer. */
function newestUserText(messages: readonly LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    // The context engine wraps a person's words in tags and appends project context after
    // them; the first line of prose is what they actually typed.
    const text =
      textOf(message)
        .replace(/<[^>]+>/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "") ?? "";
    if (text !== "") return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }
  return "";
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function verifyNapProvider(options: { stepDelayMs: number }): LLMProvider {
  let agentTurns = 0;
  let titles = 0;
  return {
    startTurn(): LLMTurn {
      // A title or a compaction summary opens a turn of its own, so the number is taken on the
      // first agent call rather than here; otherwise titling would shift every file name.
      let writes: ReturnType<typeof writesFor> | undefined;
      let step = 0;
      let spent = { inputTokens: 0, outputTokens: 0 };
      return {
        usage: () => spent,
        async complete(request: LLMRequest): Promise<LLMTurnResult> {
          spent = {
            inputTokens: spent.inputTokens + USAGE.inputTokens,
            outputTokens: spent.outputTokens + USAGE.outputTokens,
          };
          // Numbered across the run rather than fixed, so two titled sessions never share a name,
          // and zero-padded so a loose match on one number never matches another (1 vs 10).
          if (request.purpose === "title")
            return {
              type: "message",
              text: `Fixture title ${String(++titles).padStart(3, "0")}`,
              toolCalls: [],
              usage: USAGE,
            };
          if (request.purpose === "compaction")
            return {
              type: "message",
              text: "The user asked for a notes app; App and NoteList were written.",
              toolCalls: [],
              usage: USAGE,
            };

          writes ??= writesFor(++agentTurns);
          await wait(options.stepDelayMs, request.signal);
          const write = writes[step];
          step += 1;
          if (write !== undefined) {
            for (const delta of write.thinking) request.onThinkingDelta?.(delta);
            request.onTextDelta?.(write.text);
            return {
              type: "message",
              text: write.text,
              toolCalls: [
                {
                  id: `write_${step}`,
                  name: "write_file",
                  input: { path: write.path, contents: write.contents },
                },
              ],
              usage: USAGE,
            };
          }
          const text = `Done. The newest message I read was: "${newestUserText(request.messages)}"`;
          request.onTextDelta?.(text);
          return { type: "message", text, toolCalls: [], usage: USAGE };
        },
      };
    },
  };
}
