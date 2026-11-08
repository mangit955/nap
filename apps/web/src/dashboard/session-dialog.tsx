"use client";

import { useEffect, useRef, useState } from "react";

export type SessionDialogRequest =
  | { kind: "snooze"; ids: readonly string[]; names: readonly string[] }
  | { kind: "delete"; ids: readonly string[]; names: readonly string[] };

/**
 * The two questions the sidebar has to ask before acting: when a custom snooze should wake, and
 * whether a delete — which cannot be undone — is meant. A native `<dialog>`, for its focus trap,
 * Escape and inert backdrop; closing gives focus back to whatever had it before it opened.
 */
export function SessionDialog({
  request,
  onSnooze,
  onDelete,
  onClose,
}: {
  request: SessionDialogRequest;
  onSnooze: (ids: readonly string[], until: string) => void;
  onDelete: (ids: readonly string[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [until, setUntil] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const many = request.names.length > 1;
  const subject = many ? `${request.names.length} sessions` : `“${request.names[0] ?? ""}”`;
  const title =
    request.kind === "delete"
      ? many
        ? `Delete ${request.names.length} sessions?`
        : "Delete session?"
      : "Snooze until";
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      closedby="any"
      onClose={onClose}
      className="nap-dialog dialog-glass m-auto w-[calc(100%_-_32px)] max-w-sm rounded-[18px] border p-6 text-ink"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (request.kind === "delete") onDelete(request.ids);
          else {
            const time = Date.parse(until);
            if (!Number.isFinite(time) || time <= Date.now()) {
              setInvalid(true);
              return;
            }
            onSnooze(request.ids, new Date(time).toISOString());
          }
          dialog.current?.close();
        }}
      >
        <h2 className="mb-4 text-sm font-medium">{title}</h2>
        {request.kind === "delete" ? (
          <p className="text-[13px] leading-relaxed text-muted">
            {subject} and {many ? "their" : "its"} files will be permanently deleted. This cannot be
            undone.
          </p>
        ) : (
          <label className="flex flex-col gap-2 text-xs text-muted">
            Wake time
            <input
              type="datetime-local"
              required
              value={until}
              aria-invalid={invalid || undefined}
              onChange={(event) => {
                setUntil(event.target.value);
                setInvalid(false);
              }}
              className="rounded-lg border border-edge bg-field px-3 py-2 text-sm text-ink"
            />
            {invalid && <span className="text-danger">Choose a time in the future.</span>}
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="rounded-lg px-3 py-2 text-xs text-muted hover:bg-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`rounded-lg px-3 py-2 text-xs font-medium text-white ${request.kind === "delete" ? "bg-danger" : "bg-accent"}`}
          >
            {request.kind === "delete"
              ? many
                ? `Delete ${request.names.length}`
                : "Delete"
              : "Snooze"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
