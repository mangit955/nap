/** Run this expression on `/` in the browser console or with preview_evaluate. */
(async () => {
  const checks = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(`Feature check failed: ${message}`);
    checks.push(message);
  };
  const section = document.querySelector("#features");
  section.scrollIntoView({ block: "start", behavior: "instant" });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cards = [...section.querySelectorAll(".lp-benefit-card")];
  check(cards.length === 3, "all three capabilities are present");
  check(document.documentElement.scrollWidth <= innerWidth, "page has no horizontal overflow");
  for (const card of cards) {
    // Each card starts its sequence only after it is reached, including stacked mobile cards.
    card.scrollIntoView({ block: "center", behavior: "instant" });
    await wait(150);
    const bounds = card.getBoundingClientRect();
    check(bounds.left >= 0 && bounds.right <= innerWidth, "feature card fits the viewport");
    check(
      getComputedStyle(card).backgroundColor === "rgb(16, 16, 16)",
      "card uses Nap's panel token",
    );
    check(
      getComputedStyle(card.querySelector(".nf-art")).backgroundColor === "rgb(10, 10, 10)",
      "scene uses Nap's surface token",
    );
    const art = card.querySelector(".nf-art").getBoundingClientRect();
    const window = card
      .querySelector(".nf-sandbox, .nf-checks-window, .nf-inspector")
      .getBoundingClientRect();
    check(
      window.left >= art.left && window.right <= art.right && window.bottom <= art.bottom,
      "product scene fits inside the card",
    );
  }
  const tab = (name) => section.querySelector(`#feature-tab-${name}`);
  const panel = () => section.querySelector("#feature-project-panel");
  tab("Changes").click();
  await wait(200);
  check(panel().textContent.includes("<Dashboard />"), "Changes opens the code diff");
  check(
    panel().getAttribute("aria-labelledby") === "feature-tab-Changes",
    "inspector has the selected tab's accessible name",
  );
  tab("History").click();
  await wait(200);
  check(panel().textContent.includes("8f2c6a1"), "History opens saved checkpoints");
  section.querySelector(".nf-replay").click();
  await wait(100);
  check(
    tab("Files").getAttribute("aria-selected") === "true",
    "replay returns the inspector to Files",
  );
  const motion = [...section.getAnimations({ subtree: true })].filter((animation) =>
    animation.effect?.target.closest(".nf-art"),
  );
  check(
    motion.every((animation) => animation.effect.getTiming().iterations !== Infinity),
    "product motion never loops indefinitely",
  );
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    check(
      motion.some((animation) => animation.animationName === "nf-close-tab"),
      "replay starts the tab-closing sequence",
    );
    check(
      getComputedStyle(section.querySelector(".nf-browser")).opacity > 0.9,
      "browser window is visible before the tab closes",
    );
    check(
      getComputedStyle(section.querySelector(".nf-checkpoint")).opacity < 0.1,
      "checkpoint waits for the checks",
    );
    for (const animation of motion) animation.finish();
    check(
      getComputedStyle(section.querySelector(".nf-browser")).opacity === "0",
      "browser closes at the end of the sequence",
    );
    check(
      getComputedStyle(section.querySelector(".nf-checkpoint")).opacity === "1",
      "verified checkpoint is the final state",
    );
  }
  // Force the actual reduced-motion media rules on, then restore the browser's media settings.
  const media = [];
  const visit = (rules) => {
    for (const rule of rules) {
      if (
        rule instanceof CSSMediaRule &&
        rule.conditionText.includes("prefers-reduced-motion: reduce")
      ) {
        media.push({ rule, original: rule.media.mediaText });
      } else if ("cssRules" in rule) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* Cross-origin fonts do not contain component styles. */
    }
  }
  try {
    for (const { rule } of media) rule.media.mediaText = "all";
    check(
      getComputedStyle(section.querySelector(".nf-replay")).display === "none",
      "reduced motion removes the replay control",
    );
    check(
      getComputedStyle(section.querySelector(".nf-checkpoint")).animationName === "none",
      "reduced motion displays the final checkpoint immediately",
    );
    check(
      getComputedStyle(section.querySelector(".nf-inspector-content")).animationName === "none",
      "reduced motion disables inspector transitions",
    );
  } finally {
    for (const { rule, original } of media) rule.media.mediaText = original;
  }
  section.scrollIntoView({ block: "start", behavior: "instant" });
  return { viewport: { width: innerWidth, height: innerHeight }, checks };
})();
