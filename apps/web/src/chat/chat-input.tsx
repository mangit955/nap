"use client";

/**
 * Where the user says what they want.
 *
 * **One action, never two.** While a turn is running the box is disabled and the button says
 * Stop rather than Send. A Send sitting beside a Cancel invites someone to queue a message
 * the server would refuse, and the runtime runs one turn per session — so the interface
 * should not imply otherwise.
 *
 * Enter sends and Shift+Enter makes a newline, which is the convention every chat interface
 * has settled on. It matters more here than usual: a prompt is often several sentences, and
 * losing one to a stray Enter is the kind of thing people stop trusting an input over.
 *
 * The text is cleared on send and **put back if the send failed**, because the hook rolls the
 * optimistic message back and the words have to survive somewhere the user will look for
 * them.
 */

import { useEffect, useRef, useState } from "react";

export function ChatInput({
  running,
  error,
  onSubmit,
  onCancel,
}: {
  running: boolean;
  error: string | undefined;
  onSubmit: (message: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  /** The message currently in flight, kept only so a failure can hand it back. */
  const inFlight = useRef("");

  useEffect(() => {
    if (error === undefined || inFlight.current === "") return;
    setText(inFlight.current);
    inFlight.current = "";
  }, [error]);

  const send = () => {
    const message = text.trim();
    if (message === "" || running) return;

    inFlight.current = message;
    setText("");
    onSubmit(message);
  };

  return (
    <div className="shrink-0 border-edge border-t p-3">
      {error !== undefined && (
        // `alert` so it is announced: the message the user just sent has vanished from the
        // screen, and nothing else on the page explains why.
        <p role="alert" className="pb-2 text-danger text-xs">
          {error}
        </p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          rows={2}
          value={text}
          disabled={running}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // Otherwise the newline is inserted as well as the message being sent.
            event.preventDefault();
            send();
          }}
          placeholder={running ? "Working…" : "Describe the app you want"}
          className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface px-3 py-2 text-ink text-sm placeholder:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:text-muted"
        />

        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-md border border-edge px-3 py-2 text-muted text-xs hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={text.trim() === ""}
            className="shrink-0 rounded-md bg-accent px-3 py-2 font-medium text-white text-xs disabled:bg-edge disabled:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
