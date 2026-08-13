"use client";

/**
 * The front page's one screen: a lit stage, a sentence, and an object that keeps changing what
 * it is.
 *
 * The stage is light and the rest of the page is near-black, which is not a decoration — it is
 * what gives the rim light somewhere to land. On a dark page a coloured glow is just a glow; on
 * a pale one it reads as light falling on a surface. The surface itself is a fixed neutral and
 * deliberately so: it used to drift through the same arc as the rim, which read as the page
 * tinting itself rather than as anything being lit.
 *
 * **This page is a pitch, and its audience has no account yet.** Anybody who is signed in is
 * sent to the dashboard, where the lit object is the box they type into and their projects are
 * underneath it. So the one lit thing here is the card: a picture of software working, cycling
 * through four surfaces of the sort of interface that sits around a model, responding to
 * nothing — because there is nothing of theirs to show, and the way in sits under it.
 *
 * There is deliberately no input before sign-in — a prompt typed by a stranger would have to be
 * stored somewhere, carried across an authentication redirect and handed back, and every one of
 * those steps is a place to lose somebody's sentence.
 */

import { useRef } from "react";
import { BadgeTrail } from "../badge-trail/badge-trail.tsx";
import { MorphCard } from "../glow/morph-card.tsx";
import { Doodles } from "./doodles.tsx";
import { Headline } from "./headline.tsx";
import { WayIn } from "./way-in.tsx";

/**
 * The sentence, and where it breaks.
 *
 * It is an instruction and a joke in that order, which is the order that works: the first line
 * says what to do here and the second says what the product is *for*, by name. Written the other
 * way round the name lands before anything has explained it, and reads as whimsy rather than as
 * a claim. The old pair — describe an app, watch it get built — was accurate about the mechanism
 * and said nothing about why anybody would want it.
 */
const LINES = ["Describe an app.", "Then go take a nap."] as const;
const SUB = "It'll be running by the time you're back — written in a live sandbox you can watch.";
/** The word the sentence turns on, and the only one set heavy. */
const EMPHASIS = "nap";

/** What raises the card off the stage — the light is what makes it read as raised at all. */
const RAISED = "shadow-[0_1px_2px_rgba(12,38,77,0.06),0_10px_30px_-12px_rgba(12,38,77,0.18)]";

export function Hero() {
  // The palette is rolled onto the stage, not onto the card: custom properties inherit, so one
  // roll lights the rim *and* the surface it stands on. Two rolls would be two arcs drifting
  // out of step with each other.
  const stage = useRef<HTMLElement>(null);

  return (
    <section
      ref={stage}
      className="ai-stage relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-24"
    >
      <Doodles />
      <BadgeTrail />

      {/*
        `data-no-trail`: the badge trail drops nothing that would land on this column. It is one
        attribute on the whole column rather than one per element, because the gaps between a
        headline, a card and a button are not places a badge should sit either.
      */}
      <div data-no-trail className="relative z-10 flex w-full max-w-2xl flex-col items-center">
        <Headline lines={LINES} sub={SUB} emphasis={EMPHASIS} />

        {/*
          The halo paints over a hundred pixels outside the body, so this wrapper exists purely
          to keep that clearance — anything that clipped here would cut the soft edge square.

          Exactly one lit object: the pulse is what makes the whole stage look lit, and a second
          one is a second arc beating out of step with the first.
        */}
        <div className="mt-14 flex w-full justify-center px-1">
          <MorphCard paletteRef={stage} faceClassName={RAISED} />
        </div>

        <div className="mt-10">
          <WayIn />
        </div>
      </div>

      {/*
        Inside the stage rather than under it. The hero fills the viewport, so a line placed after
        it would sit in the gap between the first screen and the next section — where it reads as
        the top of that section rather than as the foot of this one.
      */}
      <p className="absolute inset-x-0 bottom-6 text-center text-[var(--s-text-subtle)] text-xs">
        {/* The span, not the paragraph: the paragraph is the full width of the stage and would
            cost the trail the whole bottom band to protect one sentence. */}
        <span data-no-trail>Every app is built in its own sandbox, and only you can open it.</span>
      </p>
    </section>
  );
}
