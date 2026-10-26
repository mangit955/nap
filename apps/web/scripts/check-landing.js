/** Run this expression in a browser console on `/`, or with preview_evaluate.
 * Checks the real page at its current viewport, including every story chapter.
 */
(async () => {
  const checks = [];
  const check = (condition, name) => {
    if (!condition) throw new Error(`Landing check failed: ${name}`);
    checks.push(name);
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (predicate()) return;
      await wait(50);
    }
    throw new Error("Landing check timed out waiting for the next state");
  };
  const story = document.querySelector(".lp-story");
  check(story instanceof HTMLElement, "story is present");
  check(document.querySelectorAll("h1").length === 1, "one main heading");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal page overflow");
  for (const heading of document.querySelectorAll("main h1, main h2")) {
    const bounds = heading.getBoundingClientRect();
    check(
      bounds.left >= -1 && bounds.right <= innerWidth + 1,
      `heading fits: ${heading.textContent.trim()}`,
    );
  }
  const hero = document.querySelector(".lp-hero");
  const rail = document.querySelector(".lp-hero-rail");
  const session = document.querySelector(".lp-session-shell");
  const copy = document.querySelector(".lp-hero-copy");
  const foreground = document.querySelector(".lp-hero-mountains");
  check(
    session?.getAttribute("aria-label").includes("session demo"),
    "hero has an active session demo",
  );
  check(
    session.querySelector('[role="log"]')?.textContent.includes("Build a cabin booking app"),
    "session contains the user prompt",
  );
  check(
    session.querySelector(".workspace-header") !== null,
    "session uses the current workspace header",
  );
  check(
    session.querySelector(".lp-workspace") === null,
    "old finance workspace is absent from hero",
  );
  check(
    document.querySelectorAll(".lp-mountain-texture").length === 2,
    "both foreground slopes use planted photography",
  );
  const motionReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  scrollTo({ top: 0, behavior: "instant" });
  await waitFor(() => getComputedStyle(copy).opacity === "1");
  if (!motionReduced) {
    const initial = foreground.getBoundingClientRect().top;
    const travel = rail.offsetHeight - innerHeight;
    scrollTo({ top: travel * 0.4, behavior: "instant" });
    await waitFor(() => session.dataset.phase === "building");
    check(session.dataset.phase === "building", "scroll advances the session to building");
    scrollTo({ top: travel, behavior: "instant" });
    await waitFor(() => hero.dataset.revealed === "true" && session.dataset.phase === "ready");
    check(hero.dataset.revealed === "true", "session is revealed at the end of hero scroll");
    check(
      foreground.getBoundingClientRect().top > initial + innerHeight * 0.8,
      "mountains move down independently of the page",
    );
    const bounds = session.getBoundingClientRect();
    check(bounds.top >= 72 && bounds.bottom <= innerHeight + 1, "full session fits after reveal");
    check(
      getComputedStyle(copy).opacity === "0" && copy.inert,
      "hero copy and buttons stop behind the session after reveal",
    );
    check(hero.offsetHeight === rail.offsetHeight, "no extra scroll space repeats the hero copy");
    for (const extra of [120, 280, 420]) {
      scrollTo({ top: travel + extra, behavior: "instant" });
      await wait(80);
      check(
        getComputedStyle(copy).opacity === "0" && copy.inert,
        "hero copy stays hidden on the way to the next section",
      );
    }
    check(
      story.getBoundingClientRect().top < innerHeight,
      "next section follows the session directly",
    );
    scrollTo({ top: travel, behavior: "instant" });
    await wait(100);
  }
  check(session.dataset.phase === "ready", "completed build renders the app preview");
  session.querySelector('[aria-label="Arrive November 9"]').click();
  const length = session.querySelector('[aria-label="Length of stay"]');
  length.value = "4";
  length.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(100);
  check(
    session.querySelector(".lp-booking-options").textContent.includes("$780 total"),
    "length of stay updates the live price",
  );
  session.querySelector(".lp-booking-reserve").click();
  await wait(100);
  const confirmation = session.querySelector(".lp-booking-confirmation");
  check(
    confirmation?.textContent.includes("November 9 to 13") &&
      confirmation.textContent.includes("$780 total"),
    "reservation confirms the chosen dates and price",
  );
  confirmation.querySelector("button").click();
  await wait(100);
  check(
    session.querySelector('[aria-label="Arrive November 9"]').getAttribute("aria-pressed") ===
      "true",
    "returning to booking preserves the selection",
  );
  if (!motionReduced) {
    scrollTo({ top: 0, behavior: "instant" });
    await waitFor(() => hero.dataset.revealed === "false" && session.dataset.phase === "prompt");
    check(
      hero.dataset.revealed === "false" && session.dataset.phase === "prompt",
      "scrolling back restores the mountains and original prompt",
    );
    check(
      getComputedStyle(copy).opacity === "1" && !copy.inert,
      "returning to the top restores hero text and buttons",
    );
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const compact = matchMedia("(max-height: 700px)").matches;
  const chapters = ["describe", "build", "ready"];
  const stages = [];
  const demo = document.querySelector(".ps-demo");
  const appFrame = story.querySelector(".ps-desktop-iframe");
  const appDocument = () => appFrame.contentDocument;
  check(getComputedStyle(story).position === "relative", "story uses normal page scrolling");
  for (const chapter of chapters) {
    document.getElementById(`chapter-${chapter}`).click();
    demo.scrollIntoView({ behavior: "instant", block: "center" });
    await waitFor(
      () =>
        story.dataset.chapter === chapter &&
        appDocument()?.querySelector("[data-demo-chapter]")?.dataset.demoChapter === chapter,
    );
    await wait(350);
    const panel = document.getElementById(`scene-${chapter}`);
    check(
      panel.getAttribute("aria-hidden") === "false" && !panel.inert,
      `${chapter} chapter is accessible`,
    );
    check(
      [...document.querySelectorAll(".lp-story-scene")].filter((el) => !el.inert).length === 1,
      "only active scene is interactive",
    );
    const bounds = demo.getBoundingClientRect();
    check(bounds.left >= -1 && bounds.right <= innerWidth + 1, `${chapter} demo fits its viewport`);
    check(bounds.height < innerHeight - 72, `${chapter} demo fits below the navigation`);
    stages.push({ chapter, top: Math.round(bounds.top), bottom: Math.round(bounds.bottom) });
  }
  check(
    appDocument().querySelector(".dashboard-frame") !== null,
    "walkthrough mounts the actual dashboard component",
  );
  check(
    appFrame.contentWindow.getComputedStyle(appDocument().querySelector(".dashboard-frame"))
      .backgroundColor === "rgb(10, 10, 10)",
    "embedded app preserves the native dark surface color",
  );
  const previewDocument = (id) =>
    appDocument()?.querySelector(`[data-preview-thread="${id}"] iframe`)?.contentDocument;
  const switchThread = async (id) => {
    const ids = ["finance", "cabins", "launch"];
    story.querySelectorAll(".ps-thread-switcher button")[ids.indexOf(id)].click();
    await waitFor(
      () =>
        story.dataset.thread === id &&
        appDocument()?.querySelector("[data-demo-thread]")?.dataset.demoThread === id,
    );
    await wait(100);
  };
  await waitFor(() => previewDocument("finance")?.querySelector(".ps-periods button:last-child"));
  const financeFrame = appDocument().querySelector('[data-preview-thread="finance"] iframe');
  previewDocument("finance").querySelector(".ps-periods button:last-child").click();
  await wait(100);
  check(
    previewDocument("finance").querySelector(".ps-ledger-stats").textContent.includes("$48,260.80"),
    "finance app updates its balance and chart for the selected period",
  );
  await switchThread("cabins");
  await waitFor(() => previewDocument("cabins")?.querySelector('[aria-label="Arrive November 9"]'));
  previewDocument("cabins").querySelector('[aria-label="Arrive November 9"]').click();
  const nights = previewDocument("cabins").querySelector('[aria-label="Length of stay"]');
  nights.value = "4";
  nights.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(100);
  previewDocument("cabins").querySelector(".lp-booking-reserve").click();
  await wait(100);
  check(
    previewDocument("cabins")
      .querySelector(".lp-booking-confirmation")
      ?.textContent.includes("$780 total"),
    "booking thread has a working reservation flow",
  );
  await switchThread("launch");
  await waitFor(() => previewDocument("launch")?.querySelector('[aria-label="Check onboarding"]'));
  previewDocument("launch").querySelector('[aria-label="Check onboarding"]').click();
  await wait(100);
  check(
    previewDocument("launch").querySelector('[role="status"]').textContent.includes("3 of 6"),
    "launch thread updates the completed task count",
  );
  await switchThread("cabins");
  check(
    previewDocument("cabins")
      .querySelector(".lp-booking-confirmation")
      ?.textContent.includes("November 9 to 13"),
    "switching threads preserves the booking confirmation",
  );
  await switchThread("launch");
  check(
    previewDocument("launch")
      .querySelector('[aria-label="Check onboarding"]')
      .getAttribute("aria-pressed") === "true",
    "switching threads preserves completed tasks",
  );
  const nativeFinance = [...appDocument().querySelectorAll('a[href^="/p/"]')].find((link) =>
    link.textContent.includes("Personal finance"),
  );
  nativeFinance.click();
  await waitFor(() => story.dataset.thread === "finance");
  check(
    story.querySelector(".ps-thread-switcher button").getAttribute("aria-pressed") === "true",
    "native sidebar and outside thread controls stay in sync",
  );
  check(
    appDocument().querySelector('[data-preview-thread="finance"] iframe') === financeFrame,
    "thread switching keeps the running app mounted",
  );
  check(
    previewDocument("finance").querySelector(".ps-ledger-stats").textContent.includes("$48,260.80"),
    "switching threads preserves the selected finance period",
  );
  previewDocument("finance").querySelector(".ps-periods button:first-child").click();
  const storyTitle = story.querySelector("#why-title");
  check(storyTitle instanceof HTMLElement, "story headline is present");
  const titleSpans = [...storyTitle.querySelectorAll(".ps-title-mask > span")];
  check(
    titleSpans.length === 2 && titleSpans.every((span) => span.textContent.trim().length > 0),
    "both story headline lines contain text",
  );
  storyTitle.scrollIntoView({ behavior: "instant", block: "center" });
  const headlineRendered = () =>
    titleSpans.every((span) => {
      const style = getComputedStyle(span);
      const bounds = span.getBoundingClientRect();
      const mask = span.parentElement.getBoundingClientRect();
      return (
        span.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        }) &&
        Number.parseFloat(style.opacity) === 1 &&
        style.transform === "none" &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > Math.max(0, mask.top) &&
        bounds.top < Math.min(innerHeight, mask.bottom) &&
        bounds.right > Math.max(0, mask.left) &&
        bounds.left < Math.min(innerWidth, mask.right)
      );
    });
  if (!reduced) {
    await waitFor(() => story.dataset.entered === "true");
    check(story.dataset.entered === "true", "headline reveal runs when the story enters view");
  }
  await waitFor(headlineRendered);
  check(headlineRendered(), "both story headline lines are visible and settled in the viewport");
  if (reduced)
    check(
      getComputedStyle(story.querySelector(".ps-active-copy")).animationName === "none",
      "reduced motion disables text animation",
    );
  for (const [selector, minimum] of [
    [".lp-footer nav a", 16],
    [".lp-footer nav h2", 14],
    [".lp-footer-main > div > p", 16],
    [".lp-photo-credit", 12],
    [".lp-proof-source", 12],
    [".nf-heading-aside p", 16],
    [".lp-proof-grid p", 16],
    [".lp-hero-copy .lp-eyebrow", 12],
    [".ps-demo-caption", 12],
    [".lp-benefit-card p", 16],
    [".ps-active-copy p", 16],
    [".ps-step-label", 14],
    [".ps-thread-switcher button", 12],
  ]) {
    const matches = document.querySelectorAll(selector);
    check(matches.length > 0, `readable text is present: ${selector}`);
    for (const text of matches) {
      check(
        Number.parseFloat(getComputedStyle(text).fontSize) >= minimum,
        `readable text size: ${selector}`,
      );
      check(
        text.scrollWidth <= text.clientWidth + 1,
        `text fits without horizontal clipping: ${selector}`,
      );
    }
  }
  for (const section of document.querySelectorAll("main > section")) {
    section.scrollIntoView({ behavior: "instant", block: "center" });
    await wait(100);
  }
  await wait(800);
  const repeating = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity,
    );
  check(repeating.length === 0, "no continuous decorative animation at rest");
  check(
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    "all image assets load",
  );
  scrollTo({ top: 0, behavior: "instant" });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    reducedMotion: reduced,
    compact,
    checks,
    stages,
  };
})();
