import { ArrowRightIcon } from "../ui/icons.tsx";
import { Reveal } from "./parts.tsx";

export function StartNow() {
  return (
    <section id="start" aria-labelledby="start-title" className="lp-start">
      <div className="lp-start-photo" aria-hidden="true" />
      <Reveal className="lp-start-copy">
        <span className="lp-eyebrow">YOU'VE HAD THAT IDEA LONG ENOUGH.</span>
        <h2 id="start-title" className="lp-serif">
          Describe it tonight.
          <br />
          <span>See what comes next.</span>
        </h2>
        <p>Give your next idea somewhere to start.</p>
        <a href="/sign-up" className="lp-pill lp-pill-light">
          Start building <ArrowRightIcon className="size-4" />
        </a>
      </Reveal>
    </section>
  );
}
