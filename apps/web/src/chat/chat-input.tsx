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
 *
 * **While a turn runs, the box is not there at all** — the working indicator stands in its
 * place. A disabled two-row field is the largest thing in this footer and the least
 * informative: it cannot be typed into and says only "Working…", where the same space spent on
 * the indicator says which tool is out and how long it has been. The words already typed
 * survive because they live in this component's state rather than in the DOM, and the box
 * takes back the focus it had, so sending two messages in a row does not involve hunting for
 * the cursor.
 */

import { useEffect, useRef, useState } from "react";
import { WorkingIndicator } from "./working-indicator.tsx";

/**
 * The shell both states wear.
 *
 * Shared so the footer keeps its height when a turn starts — a box that shrinks to a single
 * line on send shoves the whole transcript down and then pulls it back a minute later. The
 * minimum is the height `rows={2}` renders at, measured rather than derived.
 */
const FIELD = "min-h-[58px] flex-1 rounded-md border border-edge bg-surface px-3 py-2";

export function ChatInput({
  running,
  error,
  onSubmit,
  onCancel,
  label = "Working",
  startedAt,
}: {
  running: boolean;
  error: string | undefined;
  onSubmit: (message: string) => void;
  onCancel: () => void;
  /** What the agent is doing, for the indicator. Defaulted so render tests need not supply it. */
  label?: string;
  startedAt?: string | undefined;
}) {
  const [text, setText] = useState("");
  /** The message currently in flight, kept only so a failure can hand it back. */
  const inFlight = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);
  /** Whether the box held the cursor when it was taken away, which is the only case that may take it back. */
  const hadFocus = useRef(false);

  useEffect(() => {
    if (error === undefined || inFlight.current === "") return;
    setText(inFlight.current);
    inFlight.current = "";
  }, [error]);

  useEffect(() => {
    if (running) return;
    if (!hadFocus.current) return;
    hadFocus.current = false;
    box.current?.focus();
  }, [running]);

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
        {running ? (
          <div className={`${FIELD} flex items-center`}>
            <WorkingIndicator label={label} {...(startedAt === undefined ? {} : { startedAt })} />
          </div>
        ) : (
          <textarea
            ref={box}
            aria-label="Message"
            rows={2}
            value={text}
            // A browser does not fire blur when the focused element is removed — focus simply
            // falls to the body — so this flag survives the box being taken away, which is the
            // whole case it exists for. Clicking elsewhere *does* blur, and clears it.
            onFocus={() => {
              hadFocus.current = true;
            }}
            onBlur={() => {
              hadFocus.current = false;
            }}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // Otherwise the newline is inserted as well as the message being sent.
              event.preventDefault();
              send();
            }}
            placeholder="Describe the app you want"
            className={`${FIELD} resize-none text-ink text-sm placeholder:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent`}
          />
        )}

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
