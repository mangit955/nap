"use client";

/**
 * The docs' bar: the landing page's links on the right, so a reader who came from there is still
 * on the same site, and the search field where Cursor-style docs keep it.
 *
 * **No Sign in and no account state.** The docs never resolve a session; anything that depended on
 * one would be guessed, and the landing page's rule is that a late control beats a wrong one. Get
 * started is right for a visitor, and somebody already signed in is sent on from it.
 *
 * Below a laptop's width the links fold into a menu that holds the sidebar, and the search field
 * becomes an icon beside it.
 */

import { Menu, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { REPO_URL } from "../landing/github-button.tsx";
import { useOpenSearch, useSearchChosen } from "./docs-search.tsx";
import { DocsSidebar, type HeadingsByPage } from "./docs-sidebar.tsx";
import { DOCS_HOME } from "./pages.ts";
import { useDismiss } from "./use-dismiss.ts";

const MENU_ID = "docs-menu";
/** Where the sidebar and the bar's links come back, in step with `docs.css`. */
const WIDE = "(min-width: 1024px)";

export function DocsHeader({ headings }: { headings: HeadingsByPage }) {
  const openSearch = useOpenSearch();
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  const shortcut = useShortcutLabel();

  // A followed link closes the menu through `onNavigate`; this catches the back button too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path changing is the event.
  useEffect(() => setMenu(false), [pathname]);

  const toggle = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menu, closeMenu, toggle);
  // A followed search result closes the menu, and focus goes to the button that reopens it: the
  // field that opened search was inside the menu, and focus would otherwise fall to the body.
  const menuOpen = useRef(menu);
  menuOpen.current = menu;
  useSearchChosen(
    useCallback(() => {
      if (!menuOpen.current) return;
      setMenu(false);
      // After the dialog has handed focus back to the field it came from, which is going.
      requestAnimationFrame(() => toggle.current?.focus());
    }, []),
  );

  useEffect(() => {
    if (!menu) return;
    // The menu covers the page, so the page goes inert under it — and the skip link, which points
    // into the page: Tab cannot wander into links the reader cannot see, and the finger
    // scrolling the menu does not scroll the page.
    const under = document.querySelectorAll<HTMLElement>("[data-docs-under-menu]");
    for (const element of under) element.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Widened past the menu's breakpoint, the sidebar is back and the menu would cover it.
    const wide = window.matchMedia(WIDE);
    const onWide = () => {
      if (wide.matches) setMenu(false);
    };
    wide.addEventListener("change", onWide);
    return () => {
      for (const element of under) element.removeAttribute("inert");
      document.body.style.overflow = overflow;
      wide.removeEventListener("change", onWide);
    };
  }, [menu]);

  return (
    <>
      <header className="docs-header">
        <div className="docs-header-brand">
          <a href="/" className="docs-brand">
            <NapMark className="size-[28px]" />
            nap
          </a>
          <Link href={DOCS_HOME} className="docs-brand-tag">
            Docs
          </Link>
        </div>

        <button
          type="button"
          className="docs-search-trigger"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={openSearch}
        >
          <Search aria-hidden="true" size={16} />
          <span>Search docs…</span>
          <kbd className="docs-kbd">{shortcut}</kbd>
        </button>

        <nav aria-label="Site" className="docs-header-links">
          <a href="/#product">Product</a>
          <a href="/#changelog">Changelog</a>
          {/* "page" on the docs home; on a section page the reader is in the docs rather than on this
              link's page, and the sidebar names the page. */}
          <Link href={DOCS_HOME} aria-current={pathname === DOCS_HOME ? "page" : "true"}>
            Docs
          </Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="/sign-up" className="lp-button lp-button-light">
            Get started
          </a>
        </nav>

        <div className="docs-header-compact">
          <button
            type="button"
            className="lp-button lp-button-ghost lp-menu-toggle"
            aria-label="Search docs"
            onClick={openSearch}
          >
            <Search aria-hidden="true" size={17} />
          </button>
          <button
            ref={toggle}
            type="button"
            className="lp-button lp-button-ghost lp-menu-toggle"
            aria-label={menu ? "Close menu" : "Menu"}
            aria-expanded={menu}
            aria-controls={MENU_ID}
            onClick={() => setMenu((value) => !value)}
          >
            {menu ? <X aria-hidden="true" size={18} /> : <Menu aria-hidden="true" size={18} />}
          </button>
        </div>
      </header>

      {/* A sibling of the bar rather than inside it: the bar's backdrop blur makes it the box
          that fixed descendants are positioned against, which would pin the menu to the bar. */}
      {menu && (
        <div id={MENU_ID} className="docs-drawer">
          <button
            type="button"
            className="docs-search-trigger docs-search-field"
            onClick={openSearch}
          >
            <Search aria-hidden="true" size={16} />
            <span>Search docs…</span>
          </button>
          <DocsSidebar headings={headings} onNavigate={() => setMenu(false)} />
          <nav aria-label="Site" className="docs-drawer-links">
            <a href="/#product">Product</a>
            <a href="/#changelog">Changelog</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="/sign-up" className="lp-button lp-button-light">
              Get started
            </a>
          </nav>
        </div>
      )}
    </>
  );
}

/**
 * "⌘ K" on a Mac and "Ctrl K" elsewhere. The server cannot know which, so it renders the Mac form
 * and the browser corrects it once mounted.
 */
function useShortcutLabel(): string {
  const [label, setLabel] = useState("⌘ K");
  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setLabel("Ctrl K");
  }, []);
  return label;
}
