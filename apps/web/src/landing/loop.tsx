import { PIXEL_ICONS, type PixelIcon, PixelSprite } from "./pixel-sprite.tsx";
import { Reveal } from "./reveal.tsx";
import { SectionHead } from "./section-head.tsx";

/**
 * How it works, as the loop it is: six steps, with Fix feeding back into Check until the
 * project's checks pass. "Look" is lit because that is the step the stage above shows.
 */
const STEPS: readonly { icon: PixelIcon; title: string; text: string }[] = [
  { icon: "plan", title: "Plan", text: "Reads the repo and writes the steps down first." },
  { icon: "build", title: "Build", text: "Edits frontend and backend on its machine." },
  { icon: "check", title: "Check", text: "Runs your typecheck, tests and build." },
  { icon: "look", title: "Look", text: "Opens the app in its browser and clicks through." },
  { icon: "fix", title: "Fix", text: "Reads the failure and fixes the cause." },
  { icon: "ship", title: "Ship", text: "Commits verified work and opens a draft PR." },
];

const NOW: PixelIcon = "look";

export function Loop() {
  return (
    <section id="how-it-works" aria-labelledby="loop-title" className="n1-sec n1-wrap">
      <SectionHead
        id="loop-title"
        index="01"
        label="How it works"
        title={
          <>
            A loop,
            <br />
            not one shot.
          </>
        }
      >
        <p>
          Num1 keeps going until your checks pass and the app does what you asked. Then it opens the
          pull request.
        </p>
      </SectionHead>
      <Reveal>
        <ol className="n1-loop">
          {STEPS.map((step, index) => {
            const now = step.icon === NOW;
            return (
              <li key={step.title} className={now ? "n1-step now" : "n1-step"}>
                {now && <span className="n1-tag n1-step-badge">now</span>}
                <div className="n1-step-n">0{index + 1}</div>
                <PixelSprite
                  rows={PIXEL_ICONS[step.icon]}
                  colors={{ X: now ? "#2f45ff" : "#121110" }}
                  unit={4}
                />
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            );
          })}
        </ol>
        <div className="n1-back">
          <div />
          <span className="n1-back-label">↺ until it's green</span>
        </div>
      </Reveal>
    </section>
  );
}
