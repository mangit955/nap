import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { ComputerAction, ComputerAnnotation } from "@nap/shared/computer";
import type {
  LLMContentBlock,
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { computerLocalAppSource } from "./computer-local-fixture.ts";

type ToolResult = Extract<LLMContentBlock, { type: "tool_result" }>;
type Assertion = Extract<ComputerAnnotation, { type: "assertion" }>;
type State =
  | { kind: "start" }
  | { kind: "source"; call: LLMToolCall; version: "buggy" | "fixed" }
  | { kind: "written" | "setup" | "input" | "dom" | "verdict"; call: LLMToolCall }
  | { kind: "done" };

const APP_PATH = `${TEMPLATE_WORKDIR}/src/App.tsx`;
const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

function message(text: string, toolCalls: LLMToolCall[] = []): LLMTurnResult {
  return {
    type: "message",
    text: `Scripted local demo: ${text}`,
    toolCalls,
    usage: { ...NO_USAGE },
  };
}

function error(message: string): LLMTurnResult {
  return {
    type: "error",
    message: `Scripted local demo: ${message}`,
    retryable: false,
    usage: { ...NO_USAGE },
  };
}

/** Require one complete, ordered exchange. Older turns and ambiguous duplicates are not evidence. */
function resultFor(request: LLMRequest, call: LLMToolCall): ToolResult | undefined {
  let uses = 0;
  let results = 0;
  let used = false;
  let result: ToolResult | undefined;
  for (const msg of request.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id === call.id) {
        uses += 1;
        used =
          msg.role === "assistant" &&
          block.name === call.name &&
          JSON.stringify(block.input) === JSON.stringify(call.input);
      }
      if (block.type === "tool_result" && block.toolCallId === call.id) {
        results += 1;
        if (used && msg.role === "user" && !block.isError) result = block;
      }
    }
  }
  return uses === 1 && results === 1 ? result : undefined;
}

function hasFrame(result: ToolResult | undefined): boolean {
  return (
    result !== undefined &&
    typeof result.content !== "string" &&
    result.content.some((block) => block.type === "image" && block.data.length > 0)
  );
}

function savedNoteVerdict(
  result: ToolResult | undefined,
  note: string,
): "passed" | "failed" | "untested" {
  if (!result) return "untested";
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  // Both markers must be real elements in this DOM result, with a complete list after input.
  if (!text.includes('<main data-testid="notes-app">')) return "untested";
  const lists = [
    ...text.matchAll(/<ul data-testid="saved-notes" aria-label="Saved notes">([\s\S]*?)<\/ul>/g),
  ];
  const list = lists.length === 1 ? lists[0]?.[1] : undefined;
  if (list === undefined) return "untested";
  return list.includes(`<li data-testid="saved-note">${note}</li>`) ? "passed" : "failed";
}

function explicitRepair(request: LLMRequest): boolean {
  for (const msg of request.messages.toReversed()) {
    if (msg.role !== "user") continue;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    if (!text.trim()) continue;
    return (
      /^\s*fix it[.!]?\s*$/i.test(text) ||
      text.startsWith("Fix the failures found while testing this app.")
    );
  }
  return false;
}

/** Free model protocol demonstration. Files, Git, checks, screenshots and DOM remain real. */
export function computerLocalProvider(delayMs = 350): LLMProvider {
  return {
    startTurn() {
      const turnId = randomUUID().replaceAll("-", "");
      const note = `Note${turnId}`;
      const assertion: Assertion = {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears in the list.",
        result: "untested",
      };
      let state: State = { kind: "start" };
      const call = (name: string, step: string, input: LLMToolCall["input"]): LLMToolCall => ({
        id: `local${turnId}${step}`,
        name,
        input,
      });
      const computer = (step: string, actions: ComputerAction[]) =>
        call("computer", step, { actions });
      const finishUntested = () => {
        state = { kind: "done" };
        return message(
          "The observation was unavailable or ambiguous. The save expectation remains untested; no repair was requested.",
        );
      };
      const emit = (
        request: LLMRequest,
        next: Exclude<State, { kind: "start" | "done" }>,
        text: string,
      ): LLMTurnResult => {
        if (!request.tools.some((tool) => tool.name === next.call.name)) {
          state = { kind: "done" };
          return error(`The required ${next.call.name} tool is unavailable.`);
        }
        state = next;
        return message(text, [next.call]);
      };
      return {
        usage: () => ({ ...NO_USAGE }),
        async complete(request) {
          if (request.purpose === "compaction")
            return error("Conversation compaction is not scripted.");
          try {
            if (delayMs > 0)
              await delay(
                delayMs,
                undefined,
                request.signal ? { signal: request.signal } : undefined,
              );
          } catch (cause) {
            if (!(cause instanceof Error) || cause.name !== "AbortError") throw cause;
            state = { kind: "done" };
            return error("Cancelled.");
          }
          if (request.signal?.aborted) {
            state = { kind: "done" };
            return error("Cancelled.");
          }
          switch (state.kind) {
            case "start": {
              if (request.tools.some((tool) => tool.name === "write_file")) {
                return emit(
                  request,
                  {
                    kind: "source",
                    call: call("read_file", "source", { path: APP_PATH }),
                    version: explicitRepair(request) ? "fixed" : "buggy",
                  },
                  "Read the actual App.tsx before writing the Notes component.",
                );
              }
              return emit(
                request,
                {
                  kind: "setup",
                  call: computer("setup", [
                    {
                      action: "annotate",
                      annotation: {
                        type: "setup",
                        description: "Open the local Notes app before the save test.",
                      },
                    },
                    { action: "key", text: "ctrl+l" },
                    { action: "type", text: "http://localhost:5173/" },
                    { action: "key", text: "Return" },
                    { action: "wait", duration: 1 },
                    { action: "screenshot" },
                  ]),
                },
                "Open Notes, declare a save expectation, type one unique note and inspect its saved list.",
              );
            }
            case "source": {
              if (!resultFor(request, state.call)) {
                state = { kind: "done" };
                return error("Could not read App.tsx. Source was not changed.");
              }
              return emit(
                request,
                {
                  kind: "written",
                  call: call("write_file", "write", {
                    path: APP_PATH,
                    contents: computerLocalAppSource(state.version),
                  }),
                },
                state.version === "fixed"
                  ? "Apply the explicitly requested save repair to App.tsx."
                  : "Write the Notes app with its deliberate save bug to App.tsx.",
              );
            }
            case "written": {
              const written = resultFor(request, state.call);
              state = { kind: "done" };
              return written
                ? message(
                    "App.tsx was written. The normal runtime owns Git and project checks. Choose Test the app to exercise saving.",
                  )
                : error("The App.tsx write was not confirmed.");
            }
            case "setup": {
              if (!hasFrame(resultFor(request, state.call))) return finishUntested();
              return emit(
                request,
                {
                  kind: "input",
                  call: computer("input", [
                    {
                      action: "annotate",
                      annotation: {
                        type: "test_start",
                        id: "save-note",
                        description: "Save one note",
                      },
                    },
                    { action: "annotate", annotation: assertion },
                    {
                      action: "annotate",
                      annotation: {
                        type: "action",
                        description: "Type a unique note in Your note, then click Save.",
                      },
                    },
                    { action: "left_click", coordinate: [448, 330] },
                    { action: "key", text: "ctrl+a" },
                    { action: "type", text: note },
                    { action: "left_click", coordinate: [744, 330] },
                    { action: "wait", duration: 0.3 },
                    { action: "screenshot" },
                  ]),
                },
                "Record the expectation before typing the note and clicking Save.",
              );
            }
            case "input": {
              if (!hasFrame(resultFor(request, state.call))) return finishUntested();
              return emit(
                request,
                { kind: "dom", call: computer("dom", [{ action: "read_dom" }]) },
                "The input returned a screenshot. Read the browser DOM in this later step to check the saved list.",
              );
            }
            case "dom": {
              const verdict = savedNoteVerdict(resultFor(request, state.call), note);
              if (verdict === "untested") return finishUntested();
              return emit(
                request,
                {
                  kind: "verdict",
                  call: computer("verdict", [
                    { action: "annotate", annotation: { ...assertion, result: verdict } },
                  ]),
                },
                "Record the result from this turn's observed saved list.",
              );
            }
            case "verdict":
              state = { kind: "done" };
              return message(
                "Review the recorded save assertion. Source repairs require an explicit Fix it request.",
              );
            case "done":
              return message("This scripted turn is complete.");
          }
        },
      };
    },
  };
}
