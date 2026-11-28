/**
 * A finished session in the product: the sidebar of projects, the conversation that built a
 * personal ledger, and the ledger itself running in the preview.
 *
 * **A demo-only stand-in.** Static markup with no data behind it, kept self-contained so it can be
 * swapped for the real workspace once that is redrawn in this style.
 */

import { Num1Mark } from "../num1-mark.tsx";

const SESSIONS = [
  { repo: "Scratch", title: "Personal ledger", working: false, meta: "+358 −0", selected: true },
  {
    repo: "storefront",
    title: "Email customers when a payment fails",
    working: false,
    meta: "#214 +105 −3",
  },
  { repo: "docs-site", title: "Add search to the docs", working: true, meta: "14m" },
  { repo: "storefront", title: "Fix the flaky cart test", working: false, meta: "#211 +12 −9" },
  { repo: "web", title: "Upgrade to Next 16", working: false, meta: "#88 +214 −187" },
  { repo: "Scratch", title: "Recipe planner", working: false, meta: "+1.2k −0" },
];

const PLAN = [
  "Postgres schema and first migration",
  "CSV import endpoint with validation",
  "Dashboard: balance, trend, recent activity",
  "Run migrations, tests and the build",
];

const SERIES = [
  22, 24, 23, 27, 26, 30, 29, 33, 35, 34, 38, 41, 40, 44, 47, 46, 50, 54, 53, 58, 62, 61, 66, 70,
];
const PEAK = Math.max(...SERIES);
/** Each bar snapped to eighths, so the chart steps like the rest of the page's pixel art. */
const BARS = SERIES.map((value) => Math.round((value / PEAK) * 8) * 12.5);

export function ProductWindow() {
  return (
    <div className="n1-pw" aria-hidden="true">
      <div className="n1-pw-bar">
        <span className="n1-pw-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="n1-pw-bar-title">num1 / personal-ledger</span>
        <span className="n1-pos">■ VERIFIED</span>
      </div>
      <div className="n1-pw-body">
        <div className="n1-pw-side">
          <div className="n1-pw-brand">
            <Num1Mark size={16} />
            <span>num1</span>
          </div>
          <div className="n1-pw-search">⌕ Search</div>
          {SESSIONS.map((session) => (
            <div
              key={session.title}
              className={session.selected ? "n1-pw-sess is-sel" : "n1-pw-sess"}
            >
              <div className="n1-pw-sess-top">
                <span className="n1-pw-repo">
                  <i>{session.repo[0]?.toUpperCase()}</i>
                  {session.repo}
                </span>
                <span className={session.working ? "n1-pw-work" : "n1-pos"}>
                  {session.working ? "▚ WORKING" : "■ DONE"}
                </span>
              </div>
              <div className="n1-pw-sess-title">{session.title}</div>
              <div className="n1-pw-sess-meta">{session.meta}</div>
            </div>
          ))}
        </div>

        <div className="n1-pw-chat">
          <div className="n1-pw-chat-title">Personal ledger</div>
          <div className="n1-pw-user">
            Build a personal finance dashboard with spending trends and recent transactions. Keep
            the transactions in Postgres, and let me import a CSV from my bank.
          </div>
          <p>
            I'll start with a Postgres schema for accounts and transactions, add an import endpoint
            for the CSV, then build the dashboard on top of the API.
          </p>
          <div className="n1-pw-plan">
            <div className="n1-pw-plan-h">
              <span>PLAN · 4 OF 4 DONE</span>
              <span className="n1-pw-meter">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <ul>
              {PLAN.map((step) => (
                <li key={step}>
                  <span className="n1-pos">✓</span>
                  {step}
                </li>
              ))}
            </ul>
          </div>
          <div className="n1-pw-tool">▸ Changed 3 files and ran 1 command</div>
          <p>
            The ledger is running with a real database behind it. Import a CSV from the menu and the
            balance, trend and transactions update from Postgres. Migrations, tests and the build
            all passed.
          </p>
          <div className="n1-composer">
            <span>Ask a follow-up…</span>
            <span className="n1-chip">OPUS · HIGH</span>
            <b>↑</b>
          </div>
        </div>

        <div className="n1-pw-preview">
          <div className="n1-pw-tabs">
            <span className="is-on">▣ Preview</span>
            <span>{"{}"} Code</span>
            <span className="n1-pw-url">/ overview</span>
          </div>
          <div className="n1-pw-app">
            <div className="n1-pw-app-side">
              <b>⌘ ledger</b>
              <span className="is-on">Overview</span>
              <span>Transactions</span>
              <span>Accounts</span>
              <span>Settings</span>
            </div>
            <div className="n1-pw-app-main">
              <div className="n1-pw-eyebrow">YOUR MONEY, A LITTLE CLEARER.</div>
              <div className="n1-pw-app-h">Room to do more.</div>
              <div className="n1-pw-stats">
                <div>
                  <small>Total balance</small>
                  <b>$12,684.50</b>
                  <em>+8.2% this period</em>
                </div>
                <div>
                  <small>Income</small>
                  <b>$4,850</b>
                  <em>Across accounts</em>
                </div>
                <div>
                  <small>Spending</small>
                  <b>$2,164</b>
                  <em>This month</em>
                </div>
              </div>
              <div className="n1-pw-chart">
                {BARS.map((height, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series; a bar is its position.
                  <i key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <div className="n1-pw-activity">
                <div>
                  <i>F</i>
                  <span>
                    Freelance project<small>Today · Transfer</small>
                  </span>
                  <b className="n1-pos">+$1,250.00</b>
                </div>
                <div>
                  <i>N</i>
                  <span>
                    Notion<small>Yesterday · Software</small>
                  </span>
                  <b>−$12.00</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
