/**
 * Each page's prose, by id. The page list itself — order, titles, groups — is `pages.ts`, which
 * the client components read without pulling this in.
 */

import type { ComponentType } from "react";
import { Architecture } from "./architecture.tsx";
import { Decisions } from "./decisions.tsx";
import { DurableJobs } from "./durable-jobs.tsx";
import { EventModel } from "./event-model.tsx";
import { HowNapWorks } from "./how-nap-works.tsx";
import { type DocPage, PAGES, type SectionId } from "./pages.ts";
import { Sandbox } from "./sandbox.tsx";
import { Scale } from "./scale.tsx";
import { Verification } from "./verification.tsx";

const BODIES: Record<SectionId, ComponentType> = {
  "how-nap-works": HowNapWorks,
  architecture: Architecture,
  "event-model": EventModel,
  "durable-jobs": DurableJobs,
  verification: Verification,
  sandbox: Sandbox,
  scale: Scale,
  decisions: Decisions,
};

export type DocSection = DocPage & { Body: ComponentType };

export const SECTIONS: readonly DocSection[] = PAGES.map((page) => ({
  ...page,
  Body: BODIES[page.id],
}));
