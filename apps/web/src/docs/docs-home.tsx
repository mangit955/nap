/**
 * The docs home: what the docs are for, the recorded session, and a card for every page.
 *
 * Each card's sentence is that page's own opening sentence, read out of its prose, so the home page
 * cannot promise something the page it links to has stopped saying.
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { REPO_URL } from "../landing/github-button.tsx";
import { GithubIcon } from "../ui/icons.tsx";
import { HOME_INTRO } from "./home-copy.ts";
import { LegacyAnchor } from "./legacy-anchor.tsx";
import { outlineOf } from "./outline.ts";
import { hrefOf, type SectionId } from "./pages.ts";
import { type DocSection, SECTIONS } from "./sections.tsx";
import { WallRecording } from "./wall-recording.tsx";

/** The three pages that give the whole shape of it; the rest follow under it. */
const START_HERE: readonly SectionId[] = ["how-nap-works", "architecture", "decisions"];

export function DocsHome() {
  const start = SECTIONS.filter((section) => START_HERE.includes(section.id));
  const underneath = SECTIONS.filter((section) => !START_HERE.includes(section.id));

  return (
    <div className="docs-home">
      <LegacyAnchor />
      <p className="docs-crumb">{HOME_INTRO.eyebrow}</p>
      <h1 className="lp-serif docs-home-title">{HOME_INTRO.title}</h1>
      <p className="docs-home-intro">{HOME_INTRO.body}</p>
      <div className="lp-actions">
        <Link href={hrefOf("how-nap-works")} className="lp-button lp-button-light">
          How Nap works
          <ArrowRight aria-hidden="true" size={15} />
        </Link>
        <Link href={hrefOf("decisions")} className="lp-button lp-button-ghost">
          Read the decisions
        </Link>
      </div>

      <WallRecording
        src="/demo.mp4"
        poster="/demo-poster.jpg"
        label="A recorded Nap session, from an empty dashboard to a finished app"
        cue="Watch one session, uncut · 2 min"
      />

      <section aria-labelledby="docs-start-here">
        <h2 id="docs-start-here" className="docs-home-heading">
          Start here
        </h2>
        <p className="docs-home-lede">Three pages that give you the whole shape of it.</p>
        <div className="docs-cards">
          {start.map((section) => (
            <Card key={section.id} section={section} />
          ))}
        </div>
      </section>

      <section aria-labelledby="docs-underneath">
        <h2 id="docs-underneath" className="docs-home-heading">
          How it works underneath
        </h2>
        <p className="docs-home-lede">
          One page per mechanism, each linking to the source that decides it.
        </p>
        <div className="docs-cards">
          {underneath.map((section) => (
            <Card key={section.id} section={section} />
          ))}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="docs-card">
            <span className="docs-card-icon">
              <GithubIcon className="size-[17px]" />
            </span>
            <span className="docs-card-title">Source</span>
            <span className="docs-card-body">
              Nap is open source and MIT licensed. The code these pages describe is on GitHub.
            </span>
            <span className="docs-card-more">
              Open on GitHub
              <ArrowRight aria-hidden="true" size={13} />
            </span>
          </a>
        </div>
      </section>
    </div>
  );
}

function Card({ section: { id, title, Icon, Body } }: { section: DocSection }) {
  return (
    <Link href={hrefOf(id)} className="docs-card">
      <span className="docs-card-icon">
        <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
      </span>
      <span className="docs-card-title">{title}</span>
      <span className="docs-card-body">{outlineOf(Body).lede}</span>
      <span className="docs-card-more" aria-hidden="true">
        Read
        <ArrowRight size={13} />
      </span>
    </Link>
  );
}
