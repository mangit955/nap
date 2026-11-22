/**
 * The docs' pages, in reading order, and the groups the sidebar shows them in — names and places
 * only, no prose.
 *
 * Kept apart from `sections.tsx`, which pairs each id with its prose, because the sidebar, the
 * search box and the "On this page" list are client components, and anything they import ships to
 * the browser. Importing the prose from here would put all eight sections into the bundle a second
 * time on top of the HTML they already arrive as.
 *
 * Every derived thing reads this list: the routes (`/docs/<id>`), the sidebar, the previous and
 * next links, the home page's cards and the search index. A link that points at a renamed page
 * cannot happen, because no link is written by hand. Reordering the docs is reordering this array.
 *
 * **The ids are the anchors of the single-page docs this replaced.** `/docs#verification` was a
 * link people sent and old copies of the README still carry, so the route keeps its name and
 * `legacy-anchor.tsx` forwards the old form.
 *
 * **The titles are the flat technical names, deliberately.** The joke lives in the home page's
 * title. A reader here is scanning for a noun, and every noun in this list is one `CONTEXT.md`
 * already fixed; renaming Verification to something funnier would be inventing a second
 * vocabulary for a concept that has one.
 */

import {
  BookOpen,
  Box,
  ChartLine,
  CircleCheck,
  Clock,
  FileText,
  House,
  Layers,
  List,
  type LucideIcon,
} from "lucide-react";

export const GROUPS = ["Get started", "Core concepts", "The work", "Operating"] as const;
export type DocGroup = (typeof GROUPS)[number];

type PageSpec = {
  /** The route segment, and once the anchor. Kebab-case, and stable: sent links must keep working. */
  id: string;
  title: string;
  group: DocGroup;
  Icon: LucideIcon;
  /** The file under `apps/web/src/docs/` that holds the prose, for the page's edit link. */
  file: string;
};

export const PAGES = [
  {
    id: "how-nap-works",
    title: "How Nap Works",
    group: "Get started",
    Icon: BookOpen,
    file: "how-nap-works.tsx",
  },
  {
    id: "architecture",
    title: "Architecture",
    group: "Core concepts",
    Icon: Layers,
    file: "architecture.tsx",
  },
  {
    id: "event-model",
    title: "Runtime & the Event Model",
    group: "Core concepts",
    Icon: List,
    file: "event-model.tsx",
  },
  {
    id: "durable-jobs",
    title: "Durable Jobs",
    group: "The work",
    Icon: Clock,
    file: "durable-jobs.tsx",
  },
  {
    id: "verification",
    title: "Verification & Repair",
    group: "The work",
    Icon: CircleCheck,
    file: "verification.tsx",
  },
  {
    id: "sandbox",
    title: "Sandbox & Snapshots",
    group: "The work",
    Icon: Box,
    file: "sandbox.tsx",
  },
  { id: "scale", title: "Scale", group: "Operating", Icon: ChartLine, file: "scale.tsx" },
  {
    id: "decisions",
    title: "Decisions",
    group: "Operating",
    Icon: FileText,
    file: "decisions.tsx",
  },
] as const satisfies readonly PageSpec[];

export type SectionId = (typeof PAGES)[number]["id"];
export type DocPage = (typeof PAGES)[number];

export const DOCS_HOME = "/docs";

/** The docs home: the way in, with no prose of its own beyond its introduction. */
export const OVERVIEW = { title: "Overview", group: "Get started", Icon: House } as const;

export function hrefOf(id: SectionId): string {
  return `${DOCS_HOME}/${id}`;
}

export function pageById(id: string): DocPage | undefined {
  return PAGES.find((page) => page.id === id);
}

/** One stop in the reading order: the home page, then the eight sections. */
export type Stop = { href: string; title: string; group: DocGroup; Icon: LucideIcon };

export const READING_ORDER: readonly Stop[] = [
  { href: DOCS_HOME, ...OVERVIEW },
  ...PAGES.map(({ id, title, group, Icon }) => ({ href: hrefOf(id), title, group, Icon })),
];
