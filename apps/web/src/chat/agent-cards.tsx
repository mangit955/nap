"use client";

/**
 * The things the agent hands the person rather than the project: its checklist, a question, and
 * a plan proposed for approval.
 *
 * All drawn from validated events (`plan.updated`, `agent.question`, `plan.proposed`), never from
 * a tool call's arguments, so what renders here is exactly what the agent was allowed to send.
 */

import type { PlanItem, QuestionOption } from "@nap/shared/agent-plan";
import type { PlanStatus } from "@nap/shared/plan-mode";
import { Check, Circle, CircleDot } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ChatMarkdown } from "./chat-markdown.tsx";

/**
 * The checklist, as a list a screen reader counts. Status is said in words as well as shapes,
 * because a ticked circle and an empty one are the same thing read aloud.
 */
export function PlanCard({ items }: { items: readonly PlanItem[] }) {
  const done = items.filter((item) => item.status === "completed").length;
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-1.5 rounded-xl border border-edge bg-field/50 px-3 py-2.5"
    >
      <h3 id={heading} className="font-medium text-[11.5px] text-muted uppercase tracking-wide">
        Plan · {done} of {items.length} done
      </h3>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            // Position is the identity: a plan is replaced whole, and two steps may read the same.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list has no other stable identity.
            key={index}
            className={`flex items-start gap-2 text-[13px] leading-snug ${
              item.status === "completed" ? "text-muted line-through" : "text-ink"
            }`}
          >
            <StatusIcon status={item.status} />
            <span>
              <span className="sr-only">{STATUS_WORDS[item.status]}: </span>
              {item.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_WORDS: Record<PlanItem["status"], string> = {
  pending: "To do",
  in_progress: "In progress",
  completed: "Done",
};

function StatusIcon({ status }: { status: PlanItem["status"] }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  if (status === "completed")
    return <Check aria-hidden="true" className={`${className} text-accent`} />;
  if (status === "in_progress")
    return <CircleDot aria-hidden="true" className={`${className} text-ink`} />;
  return <Circle aria-hidden="true" className={`${className} text-muted`} />;
}

/**
 * A question the turn ended on. While it is open and somebody can answer, each option is a
 * button that sends its label as the next message — the same message typing it would send. With
 * several answers allowed, options are checkboxes and one button sends the selection.
 */
export function QuestionCard({
  question,
  options,
  multiSelect,
  answer,
  busy,
  onAnswer,
}: {
  question: string;
  options: readonly QuestionOption[];
  multiSelect: boolean;
  answer: string | null;
  busy: boolean;
  onAnswer?: ((text: string) => void) | undefined;
}) {
  const heading = useId();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const open = answer === null && onAnswer !== undefined && !busy;

  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2 rounded-xl border border-edge bg-field/50 px-3 py-2.5"
    >
      <h3 id={heading} className="text-[13px] text-ink leading-snug">
        {question}
      </h3>
      {answer !== null ? (
        <p className="text-[12px] text-muted">Answered: {answer}</p>
      ) : multiSelect ? (
        <fieldset className="flex flex-col gap-1.5" disabled={!open}>
          <legend className="sr-only">Choose any that apply</legend>
          {options.map((option) => (
            <label key={option.label} className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={chosen.has(option.label)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(option.label);
                  else next.delete(option.label);
                  setChosen(next);
                }}
              />
              <OptionText option={option} />
            </label>
          ))}
          <button
            type="button"
            disabled={!open || chosen.size === 0}
            onClick={() =>
              onAnswer?.(
                options
                  .filter((option) => chosen.has(option.label))
                  .map((o) => o.label)
                  .join(", "),
              )
            }
            className="self-start rounded-chip border border-edge px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-hover disabled:opacity-50"
          >
            Send answer
          </button>
        </fieldset>
      ) : (
        <div className="flex flex-col gap-1.5">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={!open}
              onClick={() => onAnswer?.(option.label)}
              className="flex flex-col items-start rounded-lg border border-edge px-2.5 py-1.5 text-left transition-colors hover:bg-hover disabled:opacity-50"
            >
              <OptionText option={option} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function OptionText({ option }: { option: QuestionOption }) {
  return (
    <span className="flex flex-col">
      <span className="text-[13px] text-ink">{option.label}</span>
      {option.description !== null && (
        <span className="text-[12px] text-muted">{option.description}</span>
      )}
    </span>
  );
}

const PLAN_STATUS_WORDS: Record<Exclude<PlanStatus, "awaiting">, string> = {
  drafting: "Still being written",
  approved: "Approved",
  revised: "Changes requested",
  superseded: "Set aside",
  interrupted: "This plan was never finished",
};

/**
 * A plan proposed for approval (ADR-0025). Nothing is built until the person approves it here.
 *
 * Approve sends the approval as the next message; Request changes opens a box whose words go out
 * as the next plan mode message, so the agent plans again with them. Typing anything else in the
 * composer moves on, and the card settles as set aside — the next message is the answer, as it is
 * for a question. Whether it is still open is `status`, folded from the log, never local state:
 * reloading, or opening the session in another tab, draws the same card.
 */
export function ProposedPlanCard({
  turnId,
  title,
  plan,
  status,
  busy,
  actions,
}: {
  turnId: string;
  title: string;
  plan: string;
  status: PlanStatus;
  busy: boolean;
  actions?: PlanActions | undefined;
}) {
  const heading = useId();
  const changesId = useId();
  const [revising, setRevising] = useState(false);
  const [changes, setChanges] = useState("");
  const open = status === "awaiting" && actions !== undefined;
  const settled = status !== "awaiting";
  // The button that opens the box and the box itself swap places, so focus would fall to the page
  // on both clicks. It follows the swap instead: into the box, and back to the button that opened
  // it. Skipped on mount, so drawing a card never pulls focus from wherever somebody is.
  const box = useRef<HTMLTextAreaElement>(null);
  const requestChanges = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    if (revising) box.current?.focus();
    else requestChanges.current?.focus();
  }, [revising]);
  const revise = (next: boolean) => {
    toggled.current = true;
    setRevising(next);
  };

  return (
    <section
      aria-labelledby={heading}
      className={`flex flex-col gap-2.5 rounded-xl border px-3.5 py-3 ${
        settled ? "border-edge bg-field/30" : "border-accent/40 bg-field/60"
      }`}
    >
      <header className="flex flex-col gap-0.5">
        <p className="font-medium text-[11.5px] text-muted uppercase tracking-wide">Plan</p>
        <h3 id={heading} className="text-[14px] text-ink leading-snug">
          {title}
        </h3>
      </header>
      <div className={`text-[13px] ${settled ? "text-muted" : "text-ink"}`}>
        <ChatMarkdown text={plan} streaming={false} />
      </div>
      {settled ? (
        <p className="text-[12px] text-muted">{PLAN_STATUS_WORDS[status]}</p>
      ) : (
        <p className="text-[12px] text-muted">
          Waiting for your approval. Nothing is built until then.
        </p>
      )}
      {open && revising && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const text = changes.trim();
            if (text === "" || busy) return;
            actions.propose(text);
            setChanges("");
            setRevising(false);
          }}
        >
          <label htmlFor={changesId} className="text-[12px] text-muted">
            What should change?
          </label>
          <textarea
            ref={box}
            id={changesId}
            value={changes}
            onChange={(event) => setChanges(event.target.value)}
            rows={3}
            className="w-full resize-y rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-accent"
          />
          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={busy || changes.trim() === ""}
              className="rounded-chip bg-accent px-2.5 py-1 text-[12px] text-white transition-colors disabled:opacity-50"
            >
              Send changes
            </button>
            <button
              type="button"
              onClick={() => revise(false)}
              className="rounded-chip border border-edge px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-hover"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {open && !revising && (
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.approve(turnId)}
            className="rounded-chip bg-accent px-3 py-1 text-[12px] text-white transition-colors disabled:opacity-50"
          >
            Approve plan
          </button>
          <button
            ref={requestChanges}
            type="button"
            disabled={busy}
            onClick={() => revise(true)}
            className="rounded-chip border border-edge px-3 py-1 text-[12px] text-ink transition-colors hover:bg-hover disabled:opacity-50"
          >
            Request changes
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * What a plan card can do: approve the plan a turn proposed, or send words as another plan mode
 * message. Requested changes go out through `propose`, and so does the answer to a question a plan
 * mode turn asked, because neither may start a build.
 */
export type PlanActions = {
  approve: (planTurnId: string) => void;
  propose: (message: string) => void;
};
