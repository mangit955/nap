import { REPO_URL } from "./github-button.tsx";

/**
 * The four most recent changes a builder would notice, each linked to the pull request that made it.
 *
 * Written by hand, not generated from git: a merge title is written for whoever reviews the code,
 * and most merges are not news to somebody deciding whether to build here. Nap has no changelog
 * page, so "everything new" is the repository's merged pull requests.
 */
const ENTRIES = [
  { date: "2026-11-21", title: "Choose the model and how hard it thinks, per turn", pr: 314 },
  { date: "2026-11-20", title: "Your message stays in view while the reply streams in", pr: 306 },
  { date: "2026-11-19", title: "Projects open from the sidebar without a page load", pr: 293 },
  { date: "2026-11-18", title: "Connected repos end in a reviewed draft pull request", pr: 288 },
] as const;

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function Changelog() {
  return (
    <section id="changelog" aria-labelledby="changelog-title" className="lp-section lp-container">
      <div className="lp-section-head">
        <h2 id="changelog-title" className="lp-heading">
          Changelog
        </h2>
        <a
          href={`${REPO_URL}/pulls?q=is%3Apr+is%3Amerged`}
          target="_blank"
          rel="noreferrer"
          className="lp-more"
        >
          See everything new <span aria-hidden="true">→</span>
        </a>
      </div>
      <ol className="lp-changelog">
        {ENTRIES.map((entry) => (
          <li key={entry.pr}>
            <a href={`${REPO_URL}/pull/${entry.pr}`} target="_blank" rel="noreferrer">
              <time dateTime={entry.date}>{DAY.format(new Date(entry.date))}</time>
              <span>{entry.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
