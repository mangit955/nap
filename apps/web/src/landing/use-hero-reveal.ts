"use client";

import { type RefObject, useEffect, useState } from "react";

import type { DemoStage } from "./session-preview.tsx";

/** Write scroll transforms once per frame without re-rendering the dashboard. */
export function useHeroReveal(section: RefObject<HTMLElement | null>) {
  const [demoStage, setDemoStage] = useState<DemoStage>("prompt");
  useEffect(() => {
    const root = section.current;
    const rail = root?.querySelector<HTMLElement>(".lp-hero-rail");
    const copy = root?.querySelector<HTMLElement>(".lp-hero-copy");
    const stage = root?.querySelector<HTMLElement>(".lp-hero-stage");
    const product = root?.querySelector<HTMLElement>(".lp-hero-product");
    if (!root || !stage || !product || !rail || !copy) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let visible = true;
    let currentStage: DemoStage = "prompt";
    let copyDrop = 0;
    let lift = 0;
    let drop = 0;
    let travel = 1;
    const paint = () => {
      frame = 0;
      if (!visible) return;
      const progress = motion.matches
        ? 1
        : Math.max(0, Math.min(1, -rail.getBoundingClientRect().top / travel));
      const copyProgress = Math.min(1, progress / 0.42);
      copy.inert = !motion.matches && progress > 0.12;
      const nextStage = progress < 0.18 ? "prompt" : progress < 0.7 ? "building" : "ready";
      if (nextStage !== currentStage) {
        currentStage = nextStage;
        setDemoStage(nextStage);
      }
      root.style.setProperty("--lp-copy-drop", `${copyDrop * copyProgress}px`);
      root.style.setProperty("--lp-copy-opacity", String(1 - copyProgress));
      root.style.setProperty("--lp-hero-progress", String(progress));
      root.style.setProperty("--lp-hero-lift", `${-lift * progress}px`);
      root.style.setProperty("--lp-mountain-drop", `${drop * progress}px`);
      root.dataset.revealed = progress >= 0.99 ? "true" : "false";
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const measure = () => {
      travel = Math.max(1, rail.offsetHeight - stage.offsetHeight);
      const target = Math.max(96, (stage.offsetHeight - product.offsetHeight) / 2);
      lift = Math.max(0, product.offsetTop - target);
      copyDrop = Math.min(140, copy.offsetHeight * 0.4);
      drop = stage.offsetHeight * 0.9;
      schedule();
    };
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? false;
            if (visible) schedule();
          })
        : null;
    intersection?.observe(root);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resize?.observe(stage);
    resize?.observe(product);
    resize?.observe(copy);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    motion.addEventListener("change", measure);
    measure();
    return () => {
      intersection?.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
      motion.removeEventListener("change", measure);
    };
  }, [section]);
  return demoStage;
}
