import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { ComputerAction } from "@nap/shared/computer";
import type { LLMProvider, LLMTurn } from "@nap/shared/ports/llm-provider";

/** A local demonstration of the tool protocol. It makes no inference or vendor requests. */
export function computerPreviewProvider(delayMs = 0): LLMProvider {
  let edits = 0;
  const computer = (id: string, actions: ComputerAction[]) => ({
    id,
    name: "computer",
    input: { actions },
  });
  return {
    startTurn(options) {
      let turn: LLMTurn | undefined;
      return {
        usage: () => turn?.usage() ?? { inputTokens: 0, outputTokens: 0 },
        async complete(request) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (!turn) {
            const editing = request.tools.some((tool) => tool.name === "write_file");
            if (editing) edits += 1;
            const assertion = {
              type: "assertion",
              id: "save",
              expectation: "The saved note appears in the list.",
              result: "untested",
            } as const;
            const script = editing
              ? [
                  {
                    toolCalls: [
                      computer("screen", [
                        { action: "left_click", coordinate: [512, 384] },
                        { action: "screenshot" },
                      ]),
                    ],
                  },
                  {
                    toolCalls: [
                      {
                        id: "write",
                        name: "write_file",
                        input: {
                          path: `${TEMPLATE_WORKDIR}/src/Notes.tsx`,
                          contents: "export function Notes() { return <main>Notes</main>; }\n",
                        },
                      },
                    ],
                  },
                  {
                    text: "Local fixture completed. Open Computer for screenshots, or choose Test the app. This is a scripted model and desktop.",
                  },
                ]
              : [
                  {
                    text: "I’ll try saving a note and check whether it appears in the list. I’ll state the expected result before clicking.",
                    toolCalls: [
                      computer("test-action", [
                        {
                          action: "annotate",
                          annotation: {
                            type: "test_start",
                            id: "main",
                            description: "Save a note",
                          },
                        },
                        { action: "annotate", annotation: assertion },
                        { action: "left_click", coordinate: [512, 384] },
                      ]),
                    ],
                  },
                  {
                    toolCalls: [
                      computer("test-result", [
                        {
                          action: "annotate",
                          annotation: { ...assertion, result: edits > 1 ? "passed" : "failed" },
                        },
                      ]),
                    ],
                  },
                  {
                    text: "The recorded assertions are ready to review. Repairs wait for your explicit request.",
                  },
                ];
            turn = new ScriptedLLMProvider([script]).startTurn(options);
          }
          return turn.complete(request);
        },
      };
    },
  };
}
