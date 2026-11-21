"use client";

/**
 * The bar across the top of the front page: dark glass that fades into the page below.
 *
 * **Nothing on the right is drawn until the session has resolved.** Guessing wrong puts a Sign in
 * link under the cursor of somebody who is already signed in and about to be redirected, and a
 * slightly late control beats an early wrong one. The repository and the docs do not wait: they
 * are the right answer either way.
 */

import { useEffect, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { REPO_URL } from "./github-button.tsx";
import type { AuthState } from "./landing.tsx";

/** Strengthen the glass as content starts moving behind the bar. */
const SCROLLED_AT = 24;

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "#built", label: "Built with nap" },
  { href: "#changelog", label: "Changelog" },
  { href: "/docs", label: "Docs" },
] as const;

export function LandingNav({ auth }: { auth: AuthState }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > SCROLLED_AT);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header className="lp-nav fixed inset-x-0 top-0 z-50" data-scrolled={scrolled}>
      <div className="lp-container flex h-[68px] items-center justify-between gap-4">
        <a
          href="/"
          className="flex items-center gap-2 font-semibold text-[21px] tracking-[-0.03em] focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-4"
        >
          <NapMark className="size-[30px] text-white" />
          nap
        </a>

        <nav aria-label="Front page" className="hidden items-center gap-8 lg:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-[14.5px] text-[var(--lp-ink-2)] transition-colors hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <details className="group lg:hidden">
            <summary className="lp-button lp-button-ghost lp-menu-toggle cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="sr-only">Menu</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M3 6h14M3 13h14" />
              </svg>
            </summary>
            <nav
              aria-label="Mobile front page"
              className="lp-nav-menu absolute inset-x-5 top-[64px] flex flex-col gap-1 rounded-2xl p-3"
            >
              {LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="rounded-xl px-4 py-3 text-[15px] text-white/80 hover:bg-white/5 hover:text-white"
                  onClick={(event) =>
                    event.currentTarget.closest("details")?.removeAttribute("open")
                  }
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </details>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="lp-text-link mr-3 hidden sm:inline-flex"
          >
            GitHub
          </a>
          {auth === "signed-out" && (
            <>
              <a href="/sign-in" className="lp-text-link mr-3 hidden sm:inline-flex">
                Sign in
              </a>
              <a href="/sign-up" className="lp-button lp-button-light">
                Get started
              </a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
