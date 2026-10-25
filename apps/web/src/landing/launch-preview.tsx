"use client";

import { ArrowUpRight, Check, Circle, Flag } from "lucide-react";
import { useState } from "react";
import "./launch-preview.css";

const TASKS = [
  { id: "story", title: "Write the launch story", area: "Marketing", person: "AM", done: true },
  { id: "pricing", title: "Publish pricing", area: "Product", person: "JL", done: true },
  { id: "onboarding", title: "Check onboarding", area: "Product", person: "JL", done: false },
  {
    id: "email",
    title: "Send the early-access email",
    area: "Marketing",
    person: "AM",
    done: false,
  },
  { id: "analytics", title: "Connect analytics", area: "Engineering", person: "SK", done: false },
  {
    id: "feedback",
    title: "Open the feedback channel",
    area: "Community",
    person: "AM",
    done: false,
  },
];

export function LaunchPreview() {
  const [completed, setCompleted] = useState(
    () => new Set(TASKS.filter((task) => task.done).map((task) => task.id)),
  );
  return (
    <main className="launch-app">
      <nav>
        <span className="launch-brand">
          <Flag size={14} /> runway
        </span>
        <span>Workspace / Launch</span>
        <span className="launch-person">AM</span>
      </nav>
      <div className="launch-content">
        <div className="launch-eyebrow">THE NEXT CHAPTER</div>
        <h1>
          A small launch.
          <br />
          <span>A good beginning.</span>
        </h1>
        <p>Everything the team needs to get the first version out.</p>
        <div className="launch-summary">
          <span>
            <Circle size={10} /> November 12
          </span>
          <span role="status">
            {completed.size} of {TASKS.length} complete
          </span>
        </div>
        <div
          className="launch-progress"
          role="progressbar"
          aria-label="Launch progress"
          aria-valuemin={0}
          aria-valuemax={TASKS.length}
          aria-valuenow={completed.size}
        >
          <span style={{ width: `${(completed.size / TASKS.length) * 100}%` }} />
        </div>
        <div className="launch-task-heading">
          <span>Launch checklist</span>
          <ArrowUpRight size={13} />
        </div>
        <ul>
          {TASKS.map((task) => (
            <li key={task.id} data-complete={completed.has(task.id)}>
              <button
                type="button"
                aria-label={task.title}
                aria-pressed={completed.has(task.id)}
                onClick={() =>
                  setCompleted((current) => {
                    const next = new Set(current);
                    if (next.has(task.id)) next.delete(task.id);
                    else next.add(task.id);
                    return next;
                  })
                }
              >
                <span className="launch-checkbox">
                  {completed.has(task.id) && <Check size={10} />}
                </span>
                <span>
                  {task.title}
                  <small>{task.area}</small>
                </span>
              </button>
              <span className="launch-assignee">{task.person}</span>
            </li>
          ))}
        </ul>
        <footer>
          <span>Made for a team of three.</span>
          <span>Keep moving, together.</span>
        </footer>
      </div>
    </main>
  );
}
