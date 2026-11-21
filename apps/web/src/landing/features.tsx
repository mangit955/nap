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
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { Reveal } from "./parts.tsx";
import "./features.css";

/**
 * What nap does, one row each: a plain heading, one sentence, a link to how it works, and a drawing
 * of the product doing it. The drawings sit on the dusk photograph, as the hero's session does, so
 * the photograph is a backdrop the product stands on and never a scene in front of it.
 */
const ROWS = [
  {
    id: "persistence",
    title: "It keeps working after you close the tab.",
    body: "Every project runs in its own cloud sandbox, so the build carries on while your laptop sleeps.",
    link: { label: "How sessions run", href: "/docs#durable-jobs" },
    Art: Persistence,
  },
  {
    id: "verification",
    title: "It checks its own work.",
    body: "Your project's typecheck and build decide when a change is done. When one fails, nap reads the error and fixes it.",
    link: { label: "How verification works", href: "/docs#verification" },
    Art: Verification,
  },
  {
    id: "ownership",
    title: "The code is yours.",
    body: "Real files, a git history for every change, and a repo you can push to GitHub and keep building without nap.",
    link: { label: "Connect GitHub", href: "/sign-up" },
    Art: Ownership,
  },
] as const;

export function Features() {
  return (
    <section id="product" aria-label="Product" className="lp-rows lp-container">
      {ROWS.map(({ id, title, body, link, Art }) => (
        <article key={id} className="lp-row" aria-labelledby={`${id}-title`}>
          <div className="lp-row-copy">
            <h2 id={`${id}-title`}>{title}</h2>
            <p>{body}</p>
            <a href={link.href} className="lp-more">
              {link.label} <span aria-hidden="true">→</span>
            </a>
          </div>
          <Reveal className="lp-wall lp-row-art">
            <Art />
          </Reveal>
        </article>
      ))}
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
