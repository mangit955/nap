/** Run this expression in a browser console on `/`, or with preview_evaluate, at each width you
 * care about (1440, 1024, 768 and 390 at least). It checks what component tests cannot, because
 * jsdom does no layout and no hit-testing:
 *
 * - the backdrop is behind the product, never in front of it: the hero's session and each
 *   feature's window receive the hit at their own centre;
 * - the repo row's crop shows the pull request's passing checks;
 * - every window of the product is drawn large enough to read: the text that tells its story
 *   (the transcript, the plan's count, the pane's tabs, a panel's title) renders at 9px or more
 *   on any screen from a 360px phone up, and none of it larger than the product draws it;
 * - every link and button on the page gets its own clicks rather than a sibling laid over it;
 * - every focus ring on the page's dark ground can be seen (3:1 against the ground);
 * - the serif is set on the hero and the closing line and nowhere else in the page's own copy;
 * - nothing runs off the side of the page.
 *
 * A hit test sees only what takes clicks, so a layer with `pointer-events: none` laid over a
 * window passes here; look at the screenshots for that.
 *
 * Links inside the closed mobile menu have no box to hit and are skipped; open the menu and run
 * it again to cover them. Resolves to the list of checks that passed, or throws on the first one
 * that did not.
 */
(async () => {
  const checks = [];
  const check = (condition, name) => {
    if (!condition) throw new Error(`Landing check failed: ${name}`);
    checks.push(name);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const centre = (element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  };
  const owns = (element, hit) => hit !== null && (hit === element || element.contains(hit));

  check(document.querySelectorAll("h1").length === 1, "one main heading");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal page overflow");
  for (const heading of document.querySelectorAll("main h1, main h2")) {
    const box = heading.getBoundingClientRect();
    check(box.left >= -1 && box.right <= innerWidth + 1, `heading fits: ${heading.textContent}`);
  }

  const serif = [...document.querySelectorAll("main :is(h1, h2)")]
    .filter((heading) => getComputedStyle(heading).fontFamily.includes("Newsreader"))
    .map((heading) => heading.id);
  check(
    serif.join() === "hero-title,start-title",
    `serif only on the hero and the closing line (got ${serif.join()})`,
  );

  for (const window of document.querySelectorAll(".lp-wall > *")) {
    window.scrollIntoView({ block: "center" });
    await settle();
    check(owns(window, centre(window)), `nothing drawn over ${window.className}`);
  }

  // The demos draw the product's text at the scale `useSpaceScale` measured. What is read is the
  // rendered size of the text that tells each one's story, wherever it is on screen.
  const story = '[role="log"] :is(p, h3), .lp-pane-tabs > span, .lp-panel-head > span';
  for (const demo of document.querySelectorAll(".lp-demo")) {
    const name = demo.getAttribute("aria-label");
    // Unmeasured, a demo is still hidden (`demo.css`) and its scale means nothing.
    check(demo.hasAttribute("data-space"), `${name} was measured`);
    const scale = Number(demo.style.getPropertyValue("--space-k") || Number.NaN);
    const sizes = [...demo.querySelectorAll(story)]
      .filter((text) => text.getClientRects().length > 0)
      .map((text) => Number.parseFloat(getComputedStyle(text).fontSize) * scale);
    check(sizes.length > 0, `${name} has text to read`);
    const smallest = Math.min(...sizes);
    check(smallest >= 9, `${name} is readable (its smallest text at ${smallest.toFixed(1)}px)`);
    check(scale <= 1.0001, `${name} is not drawn larger than the product (scale ${scale})`);
  }

  // The repo row is about a pull request whose checks pass: its crop must show them.
  const repo = document.querySelector(".lp-repo-demo");
  if (repo) {
    const crop = repo.querySelector(".lp-demo-crop").getBoundingClientRect();
    const build = [...repo.querySelectorAll(".lp-pane-pr *")].find(
      (text) => text.children.length === 0 && text.textContent.trim() === "build",
    );
    check(
      build !== undefined && build.getBoundingClientRect().bottom <= crop.bottom,
      "the repo demo shows its passing checks",
    );
  }

  for (const anchor of document.querySelectorAll('.landing a[href^="#"]')) {
    const target = anchor.getAttribute("href").slice(1);
    check(document.getElementById(target) !== null, `#${target} leads somewhere`);
  }

  // Contrast of two `rgb()`/`rgba()` strings, as WCAG computes it.
  const luminance = (colour) => {
    const [r, g, b] = colour
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map((value) => {
        const c = Number(value) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  // Script focus draws the keyboard ring only until the page has seen a pointer, so run this on
  // a fresh load; a control the browser would not ring is skipped, and at least one must count.
  const ground = getComputedStyle(document.querySelector(".landing")).backgroundColor;
  let rings = 0;
  for (const control of document.querySelectorAll(".landing .lp-button")) {
    if (control.getBoundingClientRect().width === 0) continue;
    control.focus();
    if (control.matches(":focus-visible")) {
      rings++;
      const style = getComputedStyle(control);
      const drawn = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1;
      check(
        drawn && contrast(style.outlineColor, ground) >= 3,
        `"${control.textContent.trim()}" has a visible focus ring`,
      );
    }
    control.blur();
  }
  check(rings > 0, "focus rings were checked");

  for (const control of document.querySelectorAll(".landing :is(a, button, summary, select)")) {
    if (control.closest("[inert], [aria-hidden='true']")) continue;
    if (control.getBoundingClientRect().width === 0) continue;
    if (control.closest("details:not([open])") && !control.matches("summary")) continue;
    if (!control.closest(".lp-nav")) control.scrollIntoView({ block: "center" });
    await settle();
    const name = (control.textContent || control.getAttribute("aria-label") || "").trim();
    check(owns(control, centre(control)), `"${name.slice(0, 40)}" gets its own clicks`);
  }

  scrollTo(0, 0);
  return checks;
})();
