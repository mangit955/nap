"use client";

/**
 * The two things the agent hands the person rather than the project: its plan, and a question.
 *
 * Both are drawn from validated events (`plan.updated`, `agent.question`), never from a tool
 * call's arguments, so what renders here is exactly what the agent was allowed to send.
 */

import type { PlanItem, QuestionOption } from "@nap/shared/agent-plan";
import { Check, Circle, CircleDot } from "lucide-react";
import { useId, useState } from "react";

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
