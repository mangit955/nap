/** Run this expression in a browser console on `/`, or with preview_evaluate / CDP
 * `Runtime.evaluate` (awaiting the promise), at each width you care about (1440, 1024, 768 and
 * 390 at least), on a fresh load. It checks what component tests cannot, because jsdom does no
 * layout, applies no stylesheet and does no hit-testing:
 *
 * - nothing runs off the side of the page, and every heading fits its column;
 * - every heading on the page is set in the dot-matrix face (Doto), and the text in Geist Mono;
 * - the masthead's wordmark is square-celled (the grid did not collapse);
 * - every in-page link leads to something on the page;
 * - every focus ring can be seen against the ground it is drawn on (3:1);
 * - every link and control gets its own clicks rather than a sibling laid over it.
 *
 * A hit test sees only what takes clicks, so a layer with `pointer-events: none` laid over a
 * control passes here; look at the screenshots for that. Links inside the closed mobile menu have
 * no box to hit and are skipped; open the menu and run it again to cover them. Resolves to the
 * list of checks that passed, or throws on the first one that did not.
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
  await document.fonts.ready;

  const page = document.querySelector(".num1");
  check(page !== null, "the Num1 page is on screen");
  check(document.querySelectorAll("h1").length === 1, "one main heading");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal page overflow");

  for (const heading of document.querySelectorAll("main :is(h1, h2)")) {
    const box = heading.getBoundingClientRect();
    const name = heading.textContent;
    check(box.left >= -1 && box.right <= innerWidth + 1, `heading fits: ${name}`);
    check(getComputedStyle(heading).fontFamily.includes("Doto"), `heading in Doto: ${name}`);
  }
  for (const text of document.querySelectorAll(".n1-sub, .n1-head-aside p, .n1-cap p")) {
    check(getComputedStyle(text).fontFamily.includes("Geist Mono"), "text set in Geist Mono");
  }

  const cell = document.querySelector(".n1-wm i");
  const cellBox = cell.getBoundingClientRect();
  check(
    cellBox.width > 4 && Math.abs(cellBox.width - cellBox.height) < 0.5,
    "the wordmark's cells are square",
  );

  for (const anchor of page.querySelectorAll('a[href^="#"]')) {
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
  const groundOf = (element) => {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      if (!/rgba\(.*,\s*0\)$/.test(colour) && colour !== "transparent") return colour;
    }
    return "rgb(255, 255, 255)";
  };

  const controls = [...page.querySelectorAll("a, button, summary")].filter(
    (control) =>
      control.getBoundingClientRect().width > 0 &&
      !control.closest("[aria-hidden='true']") &&
      !(control.closest("details:not([open])") && !control.matches("summary")),
  );

  // Script focus draws the keyboard ring only until the page has seen a pointer, so run this on
  // a fresh load; a control the browser would not ring is skipped, and at least one must count.
  let rings = 0;
  // `preventScroll`: the page scrolls smoothly, so focusing would start a scroll that is still
  // moving when the hit tests below run, and they would test points off the screen.
  for (const control of controls) {
    control.focus({ preventScroll: true });
    if (control.matches(":focus-visible")) {
      rings++;
      const style = getComputedStyle(control);
      const drawn = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1;
      check(
        drawn && contrast(style.outlineColor, groundOf(control)) >= 3,
        `"${control.textContent.trim().slice(0, 40)}" has a visible focus ring`,
      );
    }
    control.blur();
  }
  check(rings > 0, "focus rings were checked");

  for (const control of controls) {
    control.scrollIntoView({ block: "center", behavior: "instant" });
    await settle();
    const name = (control.textContent || control.getAttribute("aria-label") || "").trim();
    const hit = centre(control);
    const over =
      hit === null ? "nothing" : `<${hit.tagName.toLowerCase()} class="${hit.className}">`;
    check(owns(control, hit), `"${name.slice(0, 40)}" gets its own clicks (got ${over})`);
  }

  scrollTo({ top: 0, behavior: "instant" });
  return checks;
})();
