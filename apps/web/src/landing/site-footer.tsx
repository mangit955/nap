/**
 * The foot of the page.
 *
 * No column nav. The usual four columns of links are for a site with somewhere to send people,
 * and this one has a sign-in, a repository and nothing else — four headings over one link each
 * would be a picture of a company rather than a way to get anywhere.
 *
 * What it does say is what the thing is built on, because whoever reads a footer on a developer
 * tool is usually asking exactly that.
 */

import { NapMark } from "../brand/nap-mark.tsx";
import { GithubButton } from "./github-button.tsx";

export function SiteFooter() {
  return (
    <footer className="border-[var(--s-border-1)] border-t px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2">
          <NapMark className="size-8 text-[var(--s-text-primary)]" />
          <p className="text-[var(--s-text-muted)] text-sm">
            <span className="font-semibold text-[var(--s-text-primary)]">nap</span> — describe an
            app, don't watch it get built.
          </p>
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-6">
          <p className="text-[var(--s-text-subtle)] text-xs">
            Built on E2B, OpenRouter, Bun and Postgres.
          </p>
          <GithubButton />
        </div>
      </div>
    </footer>
  );
}
