import { NapMark } from "../brand/nap-mark.tsx";
import { FEATURED_REPLAY_PATH } from "../replay/featured.ts";
import { REPO_URL } from "./github-button.tsx";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Built with nap", href: "#built" },
      { label: "Changelog", href: "#changelog" },
      { label: "Watch a real session", href: FEATURED_REPLAY_PATH },
      { label: "Get started", href: "/sign-up" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "How it works", href: "/docs" },
      { label: "Architecture", href: "/docs#architecture" },
      // The load and cluster runs: how the backend behaves at scale, measured with simulated
      // workloads. Proof for an engineer, which is why it lives here and not in the page.
      { label: "Engineering reports", href: `${REPO_URL}/blob/main/docs/scaling-cluster.md` },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "GitHub", href: REPO_URL },
      { label: "License", href: `${REPO_URL}/blob/main/LICENSE` },
      { label: "Sign in", href: "/sign-in" },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-main">
          <a href="/" className="lp-footer-brand">
            <NapMark className="size-6" />
            nap
          </a>
          <nav aria-label="Footer">
            {COLUMNS.map((column) => (
              <div key={column.title}>
                <h2>{column.title}</h2>
                {column.links.map((link) => (
                  <a key={link.label} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        </div>
        <div className="lp-footer-fine">
          <span>© 2026 nap · MIT licensed</span>
          <span>
            Photo: "Як потрапити у казку" by Misha Reme,{" "}
            <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, via
            Wikimedia Commons. Tinted and cropped.
          </span>
        </div>
      </div>
    </footer>
  );
}
