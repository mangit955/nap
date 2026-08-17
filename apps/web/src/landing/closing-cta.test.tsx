import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClosingCta } from "./closing-cta.tsx";
import { REPO_URL } from "./github-button.tsx";
import { SiteFooter } from "./site-footer.tsx";

describe("the closing band", () => {
  it("offers both halves of getting an account again, after the header has scrolled away", () => {
    render(<ClosingCta />);

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("offers the way in and nothing else", () => {
    // The repository sits a line below in the footer. Repeated here, the last thing on the page
    // would be a choice of three rather than the one it wants somebody to make.
    render(<ClosingCta />);

    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("does not repeat the pitch at somebody who has read the whole page", () => {
    render(<ClosingCta />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/right then\.\s*nap\./i);
  });
});

describe("the footer", () => {
  it("is the page's one contentinfo landmark", () => {
    render(<SiteFooter />);

    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it("offers the two places there are to go, rather than columns of pages that do not exist", () => {
    // The count is the assertion, not the links: the rule this footer is written to is that it
    // has somewhere to send people or it has nothing, never four headings over one link each.
    // It grew a second link when there was a second destination, and should not grow a third
    // without one.
    render(<SiteFooter />);

    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /star on github/i })).toHaveAttribute("href", REPO_URL);
    expect(screen.getByRole("link", { name: /^docs$/i })).toHaveAttribute("href", "/docs");
  });
});
