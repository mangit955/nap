import { NapMark } from "../brand/nap-mark.tsx";
import { GithubIcon } from "../ui/icons.tsx";
import { REPO_URL } from "./github-button.tsx";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#why" },
      { label: "Features", href: "#features" },
      { label: "Get started", href: "/sign-up" },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Architecture", href: "/docs#architecture" },
      { label: "NapBench", href: "/docs#napbench" },
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
    <footer className="lp-footer lp-container">
      <div className="lp-footer-main">
        <div>
          <a href="/" className="lp-footer-brand">
            <NapMark className="nap-mark-awake size-10" />
            nap
          </a>
          <p>
            A little less work.
            <br />A little more possibility.
          </p>
          <a href={REPO_URL} className="lp-text-link">
            <GithubIcon className="size-4" /> Follow the build
          </a>
        </div>
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
      <div className="lp-footer-bottom">
        <span>© 2026 nap</span>
        <span>Open source. MIT licensed.</span>
      </div>
      <p className="lp-photo-credit">
        Landscape: "Як потрапити у казку" by Misha Reme,{" "}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, via Wikimedia
        Commons. Tinted and cropped.
      </p>
    </footer>
  );
}
