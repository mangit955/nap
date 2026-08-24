/**
 * The nine sections, in order, as one list.
 *
 * The sidebar and the document body are both derived from this, which is the point: an anchor
 * that points at a section that has been renamed is not a thing that can happen here, because
 * neither the link nor the heading is written by hand. Reordering the page is reordering this
 * array.
 *
 * **The headings are the flat technical names, deliberately.** The joke lives in the frame of the
 * page — its title, the line under it, the way out at the end. A reader here is scanning for a
 * noun, and every noun in this list is one `CONTEXT.md` already fixed; renaming Verification to
 * something funnier would be inventing a second vocabulary for a concept that has one.
 */

import type { ComponentType } from "react";
import { Architecture } from "./architecture.tsx";
import { Decisions } from "./decisions.tsx";
import { DurableJobs } from "./durable-jobs.tsx";
import { EventModel } from "./event-model.tsx";
import { HowNapWorks } from "./how-nap-works.tsx";
import { NapBench } from "./napbench.tsx";
import { Sandbox } from "./sandbox.tsx";
import { Scale } from "./scale.tsx";
import { Verification } from "./verification.tsx";

export type DocSectionSpec = {
  /** The anchor. Kebab-case, and stable — a link somebody sent should keep working. */
  id: string;
  title: string;
  Body: ComponentType;
};

export const SECTIONS: readonly DocSectionSpec[] = [
  { id: "how-nap-works", title: "How Nap Works", Body: HowNapWorks },
  { id: "architecture", title: "Architecture", Body: Architecture },
  { id: "event-model", title: "Runtime & the Event Model", Body: EventModel },
  { id: "durable-jobs", title: "Durable Jobs", Body: DurableJobs },
  { id: "verification", title: "Verification & Repair", Body: Verification },
  { id: "sandbox", title: "Sandbox & Snapshots", Body: Sandbox },
  { id: "scale", title: "Scale", Body: Scale },
  { id: "napbench", title: "NapBench", Body: NapBench },
  { id: "decisions", title: "Decisions", Body: Decisions },
];
