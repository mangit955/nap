"use client";

import {
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  FileJson,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Globe2,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { Reveal } from "./parts.tsx";
import "./features.css";

export function Features() {
  const [run, setRun] = useState(0);
  return (
    <section id="features" aria-labelledby="features-title" className="lp-benefits lp-container">
      <Reveal className="nf-heading">
        <div>
          <span className="lp-eyebrow">LESS SUPERVISION. MORE MAKING.</span>
          <h2 id="features-title" className="lp-serif">
            Built to work alone.
            <br />
            <span>Designed to earn your trust.</span>
          </h2>
        </div>
        <div className="nf-heading-aside">
          <p>
            Space to step away.
            <br />
            Every detail when you return.
          </p>
          <button
            type="button"
            className="nf-replay"
            onClick={() => setRun((current) => current + 1)}
          >
            <RotateCcw size={12} /> Replay animations
          </button>
        </div>
      </Reveal>
      <div className="lp-benefit-grid">
        <Reveal>
          <article className="lp-benefit-card">
            <Persistence key={run} />
            <div className="nf-card-copy">
              <span className="nf-card-index">
                01 <i /> PERSISTENCE
              </span>
              <h3>
                Close the tab.
                <br />
                It keeps going.
              </h3>
              <p>The job runs in its own sandbox. Your laptop can rest while nap does the work.</p>
            </div>
          </article>
        </Reveal>
        <Reveal delayMs={70}>
          <article className="lp-benefit-card">
            <Verification key={run} />
            <div className="nf-card-copy">
              <span className="nf-card-index">
                02 <i /> VERIFICATION
              </span>
              <h3>
                "Done" comes
                <br />
                with evidence.
              </h3>
              <p>
                Your project's own checks decide what passes. A failed check starts a repair turn.
              </p>
            </div>
          </article>
        </Reveal>
        <Reveal delayMs={140}>
          <article className="lp-benefit-card">
            <Ownership key={run} />
            <div className="nf-card-copy">
              <span className="nf-card-index">
                03 <i /> OWNERSHIP
              </span>
              <h3>
                Your project.
                <br />
                All the way down.
              </h3>
              <p>
                Real files, a live event log, and git history. See every change and keep building on
                it.
              </p>
            </div>
          </article>
        </Reveal>
      </div>
      <div className="nf-section-foot">
        <NapMark className="size-4" />
        <span>Independent work. A complete record.</span>
        <span>BUILT INTO NAP</span>
      </div>
    </section>
  );
}

function Persistence() {
  return (
    <div className="nf-art nf-persistence" aria-hidden="true">
      <div className="nf-browser">
        <div>
          <Globe2 size={11} />
          <span>nap / personal-finance</span>
          <X size={11} />
        </div>
        <span className="nf-browser-line" />
        <span className="nf-browser-line" />
      </div>
      <div className="nf-tab-closed">
        <Globe2 size={12} />
        <span>Tab closed</span>
        <span className="nf-offline-dot" />
      </div>
      <div className="nf-connection">
        <span />
      </div>
      <div className="nf-sandbox">
        <div className="nf-window-bar">
          <NapMark className="size-4" />
          <span>Cloud workspace</span>
          <span className="nf-working-label">
            <i /> Working
          </span>
        </div>
        <div className="nf-sandbox-body">
          <span className="nf-command">
            <Terminal size={12} /> Updating your app
          </span>
          <div className="nf-process-row nf-process-first">
            <Check size={11} />
            <span>Read project files</span>
            <span>12 files</span>
          </div>
          <div className="nf-process-row nf-process-second">
            <Check size={11} />
            <span>Update App.tsx</span>
            <span>+46 −8</span>
          </div>
          <div className="nf-process-row nf-process-third">
            <GitCommitHorizontal size={12} />
            <span>Save progress</span>
            <span>Just now</span>
          </div>
        </div>
        <div className="nf-sandbox-footer">
          <span className="nf-activity-track">
            <span />
          </span>
          <span>Work continues independently</span>
        </div>
      </div>
    </div>
  );
}

function Verification() {
  return (
    <div className="nf-art nf-verification" aria-hidden="true">
      <div className="nf-checks-window">
        <div className="nf-window-bar">
          <Terminal size={13} />
          <span>Project checks</span>
          <span className="nf-window-hint">~/workspace</span>
        </div>
        <div className="nf-check-row nf-check-first">
          <span className="nf-check-icon">
            <Check size={13} />
          </span>
          <div>
            <span>Typecheck</span>
            <code>tsc --noEmit</code>
          </div>
          <span className="nf-check-result">
            Passed<small>0 errors</small>
          </span>
        </div>
        <div className="nf-check-row nf-check-second">
          <span className="nf-check-icon">
            <Check size={13} />
          </span>
          <div>
            <span>Production build</span>
            <code>vite build</code>
          </div>
          <span className="nf-check-result">
            Passed<small>1.2s</small>
          </span>
        </div>
        <div className="nf-checkpoint">
          <GitCommitHorizontal size={15} />
          <div>
            Checkpoint saved<span>All checks passed</span>
          </div>
          <code>8f2c6a1</code>
        </div>
      </div>
      <div className="nf-verification-note">
        <Check size={11} /> Verified against your project's checks
      </div>
    </div>
  );
}

const VIEWS = ["Files", "Changes", "History"] as const;
type View = (typeof VIEWS)[number];
function Ownership() {
  const [view, setView] = useState<View>("Files");
  return (
    <div className="nf-art nf-ownership">
      <div className="nf-inspector">
        <div
          className="nf-inspector-tabs"
          role="tablist"
          aria-label="Explore your project"
          data-view={view}
        >
          {VIEWS.map((item, index) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`feature-tab-${item}`}
              aria-controls="feature-project-panel"
              aria-selected={item === view}
              tabIndex={item === view ? 0 : -1}
              onClick={() => setView(item)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? VIEWS[(index + 1) % VIEWS.length]
                    : event.key === "ArrowLeft"
                      ? VIEWS[(index + VIEWS.length - 1) % VIEWS.length]
                      : event.key === "Home"
                        ? VIEWS[0]
                        : event.key === "End"
                          ? VIEWS[2]
                          : undefined;
                if (next) {
                  event.preventDefault();
                  setView(next);
                  document.getElementById(`feature-tab-${next}`)?.focus({ preventScroll: true });
                }
              }}
            >
              {item === "Files" ? (
                <Folder size={11} />
              ) : item === "Changes" ? (
                <Code2 size={12} />
              ) : (
                <GitBranch size={11} />
              )}
              {item}
            </button>
          ))}
        </div>
        <div
          id="feature-project-panel"
          role="tabpanel"
          aria-labelledby={`feature-tab-${view}`}
          className="nf-inspector-panel"
        >
          <div className="nf-inspector-content" key={view}>
            {view === "Files" ? (
              <>
                <div className="nf-folder-row">
                  <ChevronRight size={11} />
                  <Folder size={12} /> src <span>2 files</span>
                </div>
                <div className="nf-file-row nf-file-selected">
                  <FileCode2 size={13} />
                  <span>App.tsx</span>
                  <span>M</span>
                </div>
                <div className="nf-file-row">
                  <FileCode2 size={13} />
                  <span>index.css</span>
                  <span>M</span>
                </div>
                <div className="nf-file-row">
                  <FileJson size={13} />
                  <span>package.json</span>
                  <span />
                </div>
              </>
            ) : view === "Changes" ? (
              <>
                <div className="nf-diff-title">
                  <FileCode2 size={12} /> src/App.tsx <span>+46 −8</span>
                </div>
                <div className="nf-code-line">
                  <span>18</span>
                  <code> {'<main className="app">'}</code>
                </div>
                <div className="nf-code-line nf-code-removed">
                  <span>19</span>
                  <code>− {"<Placeholder />"}</code>
                </div>
                <div className="nf-code-line nf-code-added">
                  <span>19</span>
                  <code>+ {"<Dashboard />"}</code>
                </div>
                <div className="nf-code-line">
                  <span>20</span>
                  <code> {"</main>"}</code>
                </div>
              </>
            ) : (
              <div className="nf-git-log">
                <div>
                  <GitCommitHorizontal size={14} />
                  <span>
                    Checkpoint saved<small>All checks passed · just now</small>
                  </span>
                  <code>8f2c6a1</code>
                </div>
                <div>
                  <GitCommitHorizontal size={14} />
                  <span>
                    Build dashboard<small>2 files changed</small>
                  </span>
                  <code>c4e90b2</code>
                </div>
                <div>
                  <GitCommitHorizontal size={14} />
                  <span>
                    Start project<small>Your first idea</small>
                  </span>
                  <code>a1d73e8</code>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="nf-inspector-footer">
          <GitBranch size={11} />
          <span>main</span>
          <span>Everything stays yours</span>
        </div>
      </div>
      <span className="nf-inspector-hint">Explore the files, changes, and history above.</span>
    </div>
  );
}
