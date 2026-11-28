import { FEATURED_REPLAY_PATH } from "../replay/featured.ts";
import { REPO_URL } from "./github-button.tsx";
import { Num1Mark } from "./num1-mark.tsx";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Changelog", href: "#changelog" },
      { label: "Watch a session", href: FEATURED_REPLAY_PATH },
      { label: "Get started", href: "/sign-up" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "How it works", href: "/docs" },
      { label: "Architecture", href: "/docs/architecture" },
      // The load and cluster runs: how the backend behaves at scale, measured with simulated
      // workloads. Proof for an engineer, which is why it lives here and not in the page.
      { label: "Reports", href: `${REPO_URL}/blob/main/docs/scaling-cluster.md` },
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
    <footer className="n1-footer">
      <div className="n1-wrap">
        <div className="n1-foot">
          <div>
            <a href="/" className="n1-brand">
              <Num1Mark tile />
              num1
            </a>
            <p>A coding agent with its own computer. Open source, MIT licensed.</p>
          </div>
          <nav aria-label="Footer" className="contents">
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
        <div className="n1-fine">
          <span>© 2026 num1</span>
          <span>Open source · MIT</span>
        </div>
      </div>
    </footer>
  );
}
