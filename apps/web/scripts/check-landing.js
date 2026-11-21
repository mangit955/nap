/** Run this expression in a browser console on `/`, or with preview_evaluate, at each width you
 * care about (1440, 1024, 768 and 390 at least). It checks what component tests cannot, because
 * jsdom does no layout and no hit-testing:
 *
 * - the photograph is behind the product, never in front of it: the hero's session and each
 *   feature drawing receive the hit at their own centre;
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
      const ring = getComputedStyle(control).outlineColor;
      check(
        contrast(ring, ground) >= 3,
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
