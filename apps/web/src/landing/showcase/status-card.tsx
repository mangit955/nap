/**
 * The card beside the masthead: one project, mid-task.
 *
 * **A demo-only stand-in.** Like everything under `showcase/`, it is a drawing of the product with
 * no data behind it, kept self-contained so it can be swapped for the real component once the
 * dashboard is redrawn in this style.
 */

const STEPS = [
  { label: "schema + migration", done: true },
  { label: "csv import", done: true },
  { label: "checks: 212 passed", done: true },
  { label: "testing in the browser", done: false },
] as const;

/** Nine cells of progress: six done, one in progress, two to go. */
const CELLS = ["on", "on", "on", "on", "on", "on", "ac", "off", "off"] as const;

export function StatusCard() {
  return (
    <div className="n1-status" aria-hidden="true">
      <div className="n1-status-h">
        <span>personal-ledger</span>
        <span className="n1-live">WORKING</span>
      </div>
      <div className="n1-status-b">
        <div className="n1-cells">
          {CELLS.map((cell, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row; the cell is its position.
            <i key={index} className={cell} />
          ))}
        </div>
        {STEPS.map((step) => (
          <div key={step.label} className={step.done ? "n1-status-l" : "n1-status-l now"}>
            <span>{step.label}</span>
            <b>{step.done ? "✓" : "▸"}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
