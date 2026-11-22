import type { Metadata } from "next";
import { DocsHome } from "../../../docs/docs-home.tsx";

/**
 * The engineering half of the public site.
 *
 * The landing page answers what Nap is and why anybody would want it; the docs answer how it works
 * and why it is built this way. The split is deliberate and the README states the rule: the README
 * carries the compressed story, the docs carry the mechanisms, and specific numbers live only here.
 */
export const metadata: Metadata = {
  title: "Docs — nap",
  description:
    "How Nap works: durable jobs, the event model, verification and repair, sandboxes and snapshots, and how it scales.",
};

export default function Page() {
  return <DocsHome />;
}
