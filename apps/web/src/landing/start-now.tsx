import { ArrowRightIcon } from "../ui/icons.tsx";
import { REPO_URL } from "./github-button.tsx";

/** The last word before the footer: one serif line and the same two ways in as the hero. */
export function StartNow() {
  return (
    <section id="start" aria-labelledby="start-title" className="lp-close lp-container">
      <h2 id="start-title" className="lp-serif">
        Build your first app.
      </h2>
      <div className="lp-actions">
        <a href="/sign-up" className="lp-button lp-button-light lp-button-large">
          Start building <ArrowRightIcon className="size-4" />
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="lp-button lp-button-ghost lp-button-large"
        >
          Star on GitHub
        </a>
      </div>
    </section>
  );
}
