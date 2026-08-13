/**
 * The two ways in, in one place because the page offers them twice.
 *
 * Two links rather than one: signing up and signing in are different intentions, and a single
 * button asks the person who already has an account to guess that it means them too. They lead to
 * the same page, which opens on the half they asked for.
 *
 * It is repeated at the foot of the page rather than being made sticky at the top, which is the
 * bargain the header takes: the bar scrolls away and gives the first screen back to the hero, so
 * something has to offer the way in again once somebody has read to the end.
 */

export function WayIn() {
  return (
    <div className="flex items-center gap-3">
      <a
        href="/sign-up"
        className="rounded-full bg-[var(--s-text-primary)] px-5 py-2.5 font-medium text-[var(--s-text-inverse)] text-sm transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
      >
        Sign up
      </a>
      <a
        href="/sign-in"
        className="rounded-full border border-[var(--s-border-1)] px-5 py-2.5 font-medium text-[var(--s-text-body)] text-sm transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
      >
        Sign in
      </a>
    </div>
  );
}
