/**
 * The repository, in the bar and again in the footer.
 *
 * Starring happens on GitHub — nothing here can star for you without an authenticated GitHub
 * session — so this is a link that lands on the repo and says what to do once you are there.
 * Squared off rather than a pill: the pills on this page are the product's own actions, and this
 * one leaves it.
 *
 * The URL lives here because two places link to it, and a repository that moves should move once.
 */

import { GithubIcon } from "../ui/icons.tsx";

export const REPO_URL = "https://github.com/mangit955/nap";

export function GithubButton({ className = "" }: { className?: string }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-1.5 rounded-sm border border-[var(--s-border-1)] px-2.5 py-1.5 text-[var(--s-text-muted)] text-xs transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)] ${className}`}
    >
      <GithubIcon className="size-3.5" />
      Star on GitHub
    </a>
  );
}
