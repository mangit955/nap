/**
 * The only task the agent does not start from nothing: source is seeded, and it is broken.
 *
 * It measures something none of the others do — reading code somebody else wrote and finding the
 * one thing wrong with it — which is most of what using a tool like Nap actually consists of after
 * the first prompt.
 *
 * **The bug compiles.** `todo.done = false` inside a `filter` predicate is an assignment, not a
 * comparison: it returns `false` for every to-do, so the list renders empty, and it quietly
 * mutates the data on the way past. TypeScript accepts it, so `bun run build` passes and the build
 * check cannot be what catches this — the browser check is. That is deliberate: a seeded bug the
 * compiler finds would measure whether the agent can read an error message, which is a different
 * and much easier task.
 *
 * **The fix is objective and the prompt states its bounds.** Exactly two of the three to-dos are
 * unfinished, so "shows the right ones" is a count and two texts rather than a judgement. The
 * prompt forbids changing the wording and the heading, which stops an agent passing by deleting
 * the filter, rewriting the data, or hard-coding the list.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/**
 * The data, in a file of its own.
 *
 * Two files rather than one so the agent has to establish *where* the problem is before fixing
 * it. The bug is not in this file, and a task whose entire source is one screen would not be
 * asking that question at all.
 */
const TODOS_SOURCE = `export type Todo = {
  id: number;
  title: string;
  done: boolean;
};

export const TODOS: Todo[] = [
  { id: 1, title: "Write the specification", done: true },
  { id: 2, title: "Build the prototype", done: false },
  { id: 3, title: "Ship the release", done: false },
];
`;

/** The component with the bug in it: `=` where `===` was meant. */
const APP_SOURCE = `import { TODOS, type Todo } from "./todos";

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}

export default function App() {
  const unfinished = TODOS.filter((todo) => todo.done = false);

  return (
    <main>
      <h1>Still to do</h1>
      <TodoList todos={unfinished} />
    </main>
  );
}
`;

export const DEBUG_BROKEN_TASK = defineTask({
  id: "debug-broken",
  name: "Find and fix a bug in code the agent did not write",
  prompts: [
    [
      "This application is supposed to list the to-dos that are not finished yet, but the list",
      "renders empty. Find the bug and fix it.",
      "Do not change the wording of any to-do, do not change the heading, and do not replace the",
      "list with hard-coded markup.",
    ].join("\n"),
  ],
  environment: {
    files: [
      { path: "src/todos.ts", contents: TODOS_SOURCE },
      { path: "src/App.tsx", contents: APP_SOURCE },
    ],
  },
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      build: true,
    },
    {
      id: "lint",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run lint`,
      // Present on every task in the benchmark, and that is the reason rather than an interest
      // in this one's tidiness: a task with no `code` check renormalises its categories over a
      // different set, and its score would not be on the same scale as the other three.
      category: "code",
    },
    {
      id: "shows-the-unfinished-todos",
      kind: "browser",
      // Required: this is the task. Everything else here is a check, and this is the thing
      // being asked for — a run that fails it has not done the work, whatever else it scored.
      required: true,
      steps: [
        { step: "expectVisible", selector: { by: "role", role: "heading", name: "Still to do" } },
        // These three pin the *set*, and between them they need no fourth. Three to-dos are
        // seeded, so a count of two with both unfinished ones present leaves only one thing the
        // excluded item can be — an agent that "fixed" this by dropping the filter shows three
        // and fails the count. An `expectNoText` for the finished to-do was written here first
        // and then removed: a mutation showed it could not fail while these passed, and an
        // absence assertion that cannot fail is a two-second wait bought for nothing.
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },
        { step: "expectText", text: "Build the prototype" },
        { step: "expectText", text: "Ship the release" },
      ],
    },
    {
      id: "throws-nothing",
      kind: "browser",
      steps: [{ step: "expectNoConsoleErrors" }],
    },
  ],
});
