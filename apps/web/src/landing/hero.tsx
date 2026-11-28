import { StatusCard } from "./showcase/status-card.tsx";
import { Wordmark } from "./wordmark.tsx";

/**
 * The first screen: the block-built wordmark beside a project mid-task, then what Num1 does and
 * the two ways in.
 *
 * The claims are the product's: it works on its own sandbox machine, the project's checks decide
 * when work is done, it clicks through the running app ("Test the app"), and connected repos end
 * in a draft pull request.
 */
export function Hero() {
  return (
    <section id="hero" aria-labelledby="hero-title" className="n1-hero n1-grid">
      <div className="n1-wrap">
        <div className="n1-kick">
          <span className="n1-label">
            <i className="n1-kick-dot" />
            The coding agent with its own computer
          </span>
          <span className="n1-label n1-kick-meta">Open source · MIT</span>
        </div>
        <div className="n1-masthead">
          <Wordmark />
          <StatusCard />
        </div>
        <div className="n1-intro">
          <h1 id="hero-title" className="n1-dot">
            Describe an app.
            <br />
            <span>Get verified code.</span>
          </h1>
          <div>
            <p className="n1-sub">
              Num1 builds the frontend and the backend on its own cloud computer, runs your checks,
              clicks through the app like a user, and hands back a pull request.
            </p>
            <div className="n1-cta">
              <a href="/sign-up" className="n1-btn n1-btn-dark">
                Start building
              </a>
              <a href="/sign-up" className="n1-btn">
                Connect a repo
              </a>
            </div>
            <ul className="n1-meta">
              <li>Your checks decide</li>
              <li>Tests like a user</li>
              <li>Ends in a draft PR</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
