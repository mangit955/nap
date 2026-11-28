/**
 * The "live" window under the hero: the agent's session mid-task, with its chat and plan on the
 * left and its computer on the right, where its browser is about to click "Import 214 rows" while
 * the terminal shows the test run that got it there.
 *
 * **A demo-only stand-in.** Static markup with no data behind it, kept self-contained so it can be
 * swapped for the real workspace once that is redrawn in this style.
 *
 * Its motion (terminal lines arriving, the cursor gliding in and clicking) is pure CSS keyed on the
 * stage's `data-reveal` (`num1.css`), so the at-rest frame is the mockup's frame and a reader with
 * reduced motion, or no script, sees exactly that.
 */

import type { CSSProperties } from "react";
import { PixelSprite } from "../pixel-sprite.tsx";

const CURSOR = [
  "B..........",
  "BB.........",
  "BWB........",
  "BWWB.......",
  "BWWWB......",
  "BWWWWB.....",
  "BWWWWWB....",
  "BWWWWWWB...",
  "BWWWWWWWB..",
  "BWWWWWWWWB.",
  "BWWWWWBBBBB",
  "BWWBWWB....",
  "BWB.BWWB...",
  "BB..BWWB...",
  "B....BWWB..",
  ".....BWWB..",
  "......BB...",
];

const PLAN = [
  { text: "Postgres schema and migration", done: true },
  { text: "CSV import with validation", done: true },
  { text: "Dashboard: balance, trend, activity", done: true },
  { text: "Test the import like a user", done: false },
] as const;

const ROWS = [
  ["Nov 03", "Freelance project", "+1,250.00"],
  ["Nov 04", "Notion", "−12.00"],
  ["Nov 05", "Groceries", "−64.20"],
] as const;

const TERMINAL = [
  { tone: "cmd", text: "bun test" },
  { tone: "ok", text: "✓ ledger.test.ts (14)" },
  { tone: "bad", text: "✗ csv › rejects bad dates" },
  { tone: "b", text: "→ fix src/import/parse.ts" },
  { tone: "ok", text: "✓ csv.test.ts (9)" },
] as const;

export function SessionStage() {
  return (
    <div className="n1-sess" aria-hidden="true">
      <div className="n1-sess-chat">
        <div className="n1-sess-h">
          <span>personal-ledger</span>
          <span className="n1-live">STEP 7 / 9</span>
        </div>
        <div className="n1-you">
          Build a personal finance dashboard. Keep transactions in Postgres and let me import a CSV
          from my bank.
        </div>
        <div>
          Schema and import are in, and the checks pass. Now I'm trying the import in the browser.
        </div>
        <div className="n1-plan">
          <div className="n1-plan-h">
            <span>PLAN</span>
            <span>3 / 4</span>
          </div>
          <ul>
            {PLAN.map((step) => (
              <li key={step.text} className={step.done ? undefined : "now"}>
                <i>{step.done ? "✓" : "▸"}</i>
                {step.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="n1-think">
          ▸ Ran <b>bun test</b> · 212 passed
        </div>
        <div className="n1-composer">
          <span>Ask a follow-up…</span>
          <span className="n1-chip">OPUS · HIGH</span>
          <b>↑</b>
        </div>
      </div>

      <div className="n1-comp">
        <div className="n1-comp-h">
          <span className="on">Browser</span>
          <span>Terminal</span>
          <span>Files</span>
          <span className="sp" />
          <span className="n1-rec">● REC 00:14</span>
        </div>
        <div className="n1-desk n1-grid">
          <div className="n1-browser">
            <div className="n1-url">
              ← → ↻<span>localhost:3000/import</span>
            </div>
            <div className="n1-app">
              <div className="n1-app-nav">
                <b>ledger</b>
                <span>Overview</span>
                <span>Transactions</span>
                <span className="on">Import</span>
              </div>
              <h4>Import transactions</h4>
              <div className="n1-drop">
                <span>bank-export-nov.csv</span>
                <span>214 rows</span>
              </div>
              <div className="n1-tbl">
                <div className="h">
                  <span>DATE</span>
                  <span>DESCRIPTION</span>
                  <span>AMOUNT</span>
                </div>
                {ROWS.map(([date, what, amount]) => (
                  <div key={date}>
                    <span>{date}</span>
                    <span>{what}</span>
                    <span>{amount}</span>
                  </div>
                ))}
              </div>
              {/* The cursor is placed against the button it clicks, not measured, so it lands
                  on it at every width without a layout read. */}
              <span className="n1-target">
                <span className="n1-app-btn">Import 214 rows</span>
                <span className="n1-cursor">
                  <PixelSprite rows={CURSOR} colors={{ B: "#fff", W: "#2f45ff" }} unit={2} />
                  <span className="n1-ctag">num1 · click</span>
                </span>
              </span>
            </div>
          </div>
          <div className="n1-term">
            <div className="n1-term-h">
              <span>TERMINAL</span>
              <span>~/workspace</span>
            </div>
            {TERMINAL.map((line, index) => (
              <div
                key={line.text}
                className={`n1-term-l ${line.tone}`}
                style={{ "--i": index } as CSSProperties}
              >
                {line.tone === "cmd" ? (
                  <>
                    <span>$</span> <span className="c">{line.text}</span>
                  </>
                ) : (
                  line.text
                )}
              </div>
            ))}
            <div className="n1-term-l" style={{ "--i": TERMINAL.length } as CSSProperties}>
              <span>$</span> <span className="n1-caret" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
