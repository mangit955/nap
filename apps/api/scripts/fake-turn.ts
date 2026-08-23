/**
 * One turn, with nothing behind it: a scripted model and a sandbox that only pretends to exist.
 *
 * Shared by everything that has to run a real turn through the real composition without spending
 * anything — the load harness (`loadgen-composition.ts`) and the multi-pod proof
 * (`cluster-proof.ts`). Two copies of this would eventually become two different systems and the
 * measurements taken through them would stop being comparable, which is the same argument that
 * keeps one composition for three processes.
 *
 * Nothing here reaches E2B, OpenRouter or R2. What the callers exercise is the layer that was
 * single-process — admission, the queue, the event log, fanout — and vendor concurrency is a quota
 * question rather than an architecture one.
 */

import { TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";

/** What the project template declares, so the verifier finds checks to run. */
const TEMPLATE_MANIFEST = { scripts: { build: "vite build", dev: "vite --host" } };

/**
 * Think, write a file, answer.
 *
 * Handed to `loopingLLMProvider`, so every turn gets this script from the beginning and a turn
 * that runs long keeps receiving the last, tool-free answer — which ends the agent's loop. A
 * caller cannot know in advance how many turns it will start, and a provider that throws past a
 * fixed count fails the harness rather than the system under test.
 */
export function scriptedTurn() {
  return [
    {
      thinking: ["The project has no toggle yet, ", "so I will add one."],
      streamedText: ["I'll add ", "the component."],
      text: "I'll add the component.",
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          input: {
            path: `${TEMPLATE_WORKDIR}/src/DarkModeToggle.tsx`,
            contents:
              "export function DarkModeToggle() {\n  return <button>Toggle theme</button>;\n}\n",
          },
        },
      ],
      usage: { inputTokens: 1_200, outputTokens: 90 },
    },
    {
      text: "Added the toggle component.",
      usage: { inputTokens: 1_400, outputTokens: 20 },
    },
  ];
}

/** An in-memory sandbox answering the commands a turn actually runs, git included. */
export function fakeSandbox(): InMemorySandboxManager {
  return (
    new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
      serves: [TEMPLATE_DEV_PORT],
      seed: { [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify(TEMPLATE_MANIFEST) },
    })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: 1 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` })
  );
}
