import { FEATURED_REPLAY_PATH } from "../replay/featured.ts";
import { Reveal } from "./reveal.tsx";
import { SectionHead } from "./section-head.tsx";
import { ProductWindow } from "./showcase/product-window.tsx";

/** A real session, drawn as the product shows it once the work is done. */
export function SessionShowcase() {
  return (
    <section id="session" aria-labelledby="session-title" className="n1-sec n1-wrap">
      <SectionHead
        id="session-title"
        index="03"
        label="A real session"
        title={
          <>
            One prompt.
            <br />A working app.
          </>
        }
      >
        <p>
          A schema, an API, a dashboard, and every check passed.{" "}
          <a href={FEATURED_REPLAY_PATH}>Watch the replay</a> to see each step.
        </p>
      </SectionHead>
      <Reveal className="n1-frame">
        <ProductWindow />
      </Reveal>
    </section>
  );
}
