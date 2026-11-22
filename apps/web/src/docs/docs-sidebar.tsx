"use client";

/**
 * The docs' sidebar: every page, in its group, with the current one marked and opened out into its
 * own headings.
 *
 * The headings repeat the "On this page" list on purpose. That list is the first thing to go as
 * the window narrows, and between a laptop's width and a tablet's this is the only place left
 * that says where in a long page the reader is. Both mark the same heading, from the same
 * measurement (`use-active-heading.ts`).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { REPO_URL } from "../landing/github-button.tsx";
import { GithubIcon } from "../ui/icons.tsx";
import type { Heading } from "./outline.ts";
import { GROUPS, READING_ORDER, type SectionId } from "./pages.ts";
import { useActiveHeading } from "./use-active-heading.ts";

export type HeadingsByPage = Partial<Record<SectionId, Heading[]>>;

export function DocsSidebar({
  headings,
  onNavigate,
}: {
  headings: HeadingsByPage;
  /** Called when a link is followed — the phone menu closes itself with it. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const currentId = pathname.split("/")[2] as SectionId | undefined;
  const current = currentId ? (headings[currentId] ?? []) : [];
  const active = useActiveHeading(current.map((heading) => heading.id));

  return (
    <nav aria-label="Docs" className="docs-sidebar">
      {GROUPS.map((group) => (
        <div key={group} className="docs-sidebar-group">
          <h2>{group}</h2>
          <ul>
            {READING_ORDER.filter((page) => page.group === group).map(({ href, title, Icon }) => {
              const here = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={here ? "page" : undefined}
                    className="docs-sidebar-item"
                    onClick={() => onNavigate?.()}
                  >
                    <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
                    {title}
                  </Link>
                  {here && current.length > 0 && (
                    <ul className="docs-sidebar-headings">
                      {current.map((heading) => (
                        <li key={heading.id}>
                          <a
                            href={`#${heading.id}`}
                            aria-current={heading.id === active ? "location" : undefined}
                            onClick={() => onNavigate?.()}
                          >
                            {heading.text}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="docs-sidebar-foot">
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          <GithubIcon className="size-[15px]" />
          Source on GitHub
        </a>
      </div>
    </nav>
  );
}
