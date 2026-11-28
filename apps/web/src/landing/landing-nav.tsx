/**
 * The bar across the top of the front page: the mark, the page's own sections, and a way in.
 *
 * **Nothing that signs you in is drawn until the session has resolved.** Guessing wrong puts a
 * Sign in link under the cursor of somebody who is already signed in and about to be redirected,
 * and a slightly late control beats an early wrong one. The section links, the docs and the
 * repository do not wait: they are the right answer either way.
 *
 * Below 860px the links fold into a `<details>` menu, which opens and closes with no script.
 */

import type { MouseEvent } from "react";
import { REPO_URL } from "./github-button.tsx";
import type { AuthState } from "./landing.tsx";
import { Num1Mark } from "./num1-mark.tsx";

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "/docs", label: "Docs" },
  { href: "#changelog", label: "Changelog" },
  { href: REPO_URL, label: "GitHub", external: true },
] as const;

function NavLink({
  link,
  onClick,
}: {
  link: (typeof LINKS)[number];
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const external = "external" in link;
  return (
    <a
      href={link.href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      onClick={onClick}
    >
      {link.label}
    </a>
  );
}

/** A link in the menu jumps within the page, so the menu has to close itself behind it. */
function closeMenu(event: MouseEvent<HTMLAnchorElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export function LandingNav({ auth }: { auth: AuthState }) {
  return (
    <header className="n1-nav">
      <div className="n1-wrap">
        <a href="/" className="n1-brand">
          <Num1Mark tile />
          num1
        </a>
        <nav aria-label="Front page" className="n1-links">
          {LINKS.map((link) => (
            <NavLink key={link.label} link={link} />
          ))}
        </nav>
        <span className="n1-sp" />
        {auth === "signed-out" && (
          <>
            <a href="/sign-in" className="n1-signin">
              Sign in
            </a>
            <a href="/sign-up" className="n1-btn n1-btn-dark n1-btn-sm n1-nav-cta">
              Get started
            </a>
          </>
        )}
        <details className="n1-menu">
          <summary>
            <span aria-hidden="true">[ menu ]</span>
            <span className="sr-only">Menu</span>
          </summary>
          <nav aria-label="Mobile front page" className="n1-menu-panel">
            {LINKS.map((link) => (
              <NavLink key={link.label} link={link} onClick={closeMenu} />
            ))}
            {auth === "signed-out" && (
              <>
                <a href="/sign-in" onClick={closeMenu}>
                  Sign in
                </a>
                <a href="/sign-up" onClick={closeMenu}>
                  Get started
                </a>
              </>
            )}
          </nav>
        </details>
      </div>
    </header>
  );
}
