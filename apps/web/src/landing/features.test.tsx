import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Features } from "./features.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("what nap does", () => {
  it("gives each row one heading and a link onward", () => {
    render(<Features />);
    const rows = screen.getAllByRole("article");
    expect(rows.map((row) => within(row).getByRole("heading", { level: 2 }).textContent)).toEqual([
      "Hand it your repo. Come back to a pull request.",
      "It checks its own work.",
      "Review it like a teammate's work.",
    ]);
    expect(rows.map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual([
      "/sign-up",
      "/docs/verification",
      "/sign-up",
    ]);
  });

  it("names each row's picture and offers nothing inside it to click", () => {
    render(<Features />);
    for (const row of screen.getAllByRole("article")) {
      const picture = within(row).getByRole("img");
      expect(picture).toHaveAccessibleName();
      expect(within(picture).queryAllByRole("button")).toHaveLength(0);
      expect(within(picture).queryAllByRole("link")).toHaveLength(0);
    }
  });

  it("shows the pull request from the sample data, and asks nothing of the network", async () => {
    const network = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", network);
    render(<Features />);
    const [repo, , review] = screen.getAllByRole("article");
    if (repo === undefined || review === undefined) throw new Error("rows are missing");
    await waitFor(() =>
      expect(repo.querySelector(".lp-pane-pr")).toHaveTextContent(
        "Email customers when a payment fails",
      ),
    );
    await waitFor(() => expect(review).toHaveTextContent(/link straight to the billing page/));
    expect(network).not.toHaveBeenCalled();
  });

  it("draws no raw timestamps, copy buttons or avatars in the pictures", async () => {
    render(<Features />);
    await waitFor(() =>
      expect(document.body).toHaveTextContent(/link straight to the billing page/),
    );
    expect(document.querySelector(".lp-review-pr time")).toBeNull();
    expect(document.querySelector("[aria-label='Copy response']")).toBeNull();
    expect(document.querySelector("img[src*='github.com']")).toBeNull();
  });

  it("opens the failed test with its output showing", () => {
    render(<Features />);
    expect(document.body).toHaveTextContent("expected 1 email, received 4");
  });

  it("types nothing out: no message in a picture is drawn as still arriving", () => {
    // The transcript fades in the words of a message it thinks is still streaming, which on a
    // still picture reads as letter-by-letter typing. A finished turn ends the sample data.
    render(<Features />);
    expect(document.querySelector("[data-streaming]")).toBeNull();
  });
});
