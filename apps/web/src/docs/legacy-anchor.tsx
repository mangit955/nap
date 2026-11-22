"use client";

/**
 * Forwards `/docs#verification`, the address a section had when the docs were one page, to
 * `/docs/verification`, the page it is now.
 *
 * Those links are out in the world — old READMEs, posts, chat logs — and a fragment never reaches
 * the server, so no redirect rule can see one. Only the page can. It replaces rather than pushes,
 * so Back skips the address that no longer means anything. A fragment that names no page is left
 * alone: it is somebody else's, or a typo, and the docs home is a sensible place for either.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { hrefOf, pageById } from "./pages.ts";

export function legacyTarget(hash: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null; // A malformed escape is not an old link.
  }
  const page = pageById(id);
  return page ? hrefOf(page.id) : null;
}

export function LegacyAnchor() {
  const router = useRouter();
  useEffect(() => {
    const target = legacyTarget(window.location.hash);
    if (target) router.replace(target);
  }, [router]);
  return null;
}
