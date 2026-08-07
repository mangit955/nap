import { Pane } from "./pane.tsx";

/**
 * Placeholder. The real transcript — user and agent messages, collapsible tool calls,
 * streamed command output, file-change chips — replaces the body of this file wholesale
 * once the event stream exists.
 */
export function ChatPane() {
  return (
    <Pane id="chat" title="Chat">
      <div className="flex h-full flex-col justify-between p-4">
        <p className="text-muted text-sm leading-relaxed">
          Describe the app you want. Every file the agent writes and every command it runs will
          stream here as it happens.
        </p>
        <div
          aria-hidden="true"
          className="mt-4 rounded-lg border border-edge bg-surface px-3 py-2.5 text-muted text-sm"
        >
          Build a todo list with add, complete and delete…
        </div>
      </div>
    </Pane>
  );
}
