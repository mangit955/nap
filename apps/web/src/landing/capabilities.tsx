import type { ReactNode } from "react";
import { PIXEL_ICONS, type PixelIcon, PixelSprite } from "./pixel-sprite.tsx";
import { Reveal } from "./reveal.tsx";
import { SectionHead } from "./section-head.tsx";

/**
 * What it does, as six capabilities with a line of proof each. Every one is a feature the product
 * has: a sandbox per task, the project's checks as the bar, "Test the app" with **Fix it**
 * (`docs/computer-use.md`), draft pull requests, `/num1` follow-ups on review, and several tasks
 * at once on machines of their own.
 */
const CAPABILITIES: readonly {
  icon: PixelIcon;
  label: string;
  title: string;
  text: string;
  proof: ReactNode;
}[] = [
  {
    icon: "machine",
    label: "Sandbox",
    title: "It has its own computer",
    text: "Every task runs on an isolated cloud machine with files, a terminal and a browser, so it keeps going after you close the tab.",
    proof: (
      <>
        <span className="bl">■</span> fresh machine per task
      </>
    ),
  },
  {
    icon: "check",
    label: "Verify",
    title: "It checks its own work",
    text: "Your project's typecheck, tests and build decide when a change is done. A failure goes back into the loop.",
    proof: (
      <>
        <span className="ok">✓</span> typecheck · test · build
      </>
    ),
  },
  {
    icon: "look",
    label: "Test",
    title: "It tests the app like a user",
    text: "It writes down what should happen, clicks through the running app, and marks each step. Fix it sends failures back.",
    proof: (
      <>
        <span className="ok">✓</span> 3 passed <span className="bad">✗</span> 1 failed
      </>
    ),
  },
  {
    icon: "repo",
    label: "Repo",
    title: "Hand it your repo",
    text: "Connect GitHub and give it a task. The verified result lands as a draft pull request against main.",
    proof: (
      <>
        <span className="bl">◆</span> PR #214 · draft · verified
      </>
    ),
  },
  {
    icon: "talk",
    label: "Review",
    title: "Review it like a teammate's",
    text: "Comment on the pull request the way you always do. Approved follow-ups go to the same branch.",
    proof: (
      <>
        <span className="bl">/num1</span> link the email to billing
      </>
    ),
  },
  {
    icon: "many",
    label: "Parallel",
    title: "Hand it the backlog",
    text: "Start several tasks at once. Each has its own machine, so they don't step on each other.",
    proof: (
      <>
        <span className="bl">▸</span> 3 running · 2 ready
      </>
    ),
  },
];

export function Capabilities() {
  return (
    <section id="product" aria-labelledby="product-title" className="n1-sec n1-sec-tight n1-wrap">
      <SectionHead
        id="product-title"
        index="02"
        label="What it does"
        title={
          <>
            Everything a<br />
            developer does.
          </>
        }
      >
        <p>
          Give it an idea or a repo, then close the tab. It keeps working on a machine of its own,
          and you come back to work you can check.
        </p>
      </SectionHead>
      <Reveal className="n1-caps">
        {CAPABILITIES.map((capability) => (
          <article key={capability.label} className="n1-cap">
            <div className="n1-cap-top">
              <PixelSprite rows={PIXEL_ICONS[capability.icon]} colors={{ X: "#121110" }} unit={4} />
              <span className="n1-label">{capability.label}</span>
            </div>
            <h3>{capability.title}</h3>
            <p>{capability.text}</p>
            <div className="n1-proof">{capability.proof}</div>
          </article>
        ))}
      </Reveal>
    </section>
  );
}
