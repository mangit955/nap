import type { Metadata } from "next";
import { DocsPage } from "../../docs/docs-page.tsx";

/**
 * The engineering half of the public site.
 *
 * The landing page answers what Nap is and why anybody would want it; this answers how it works
 * and why it is built this way. The split is deliberate and the README states the rule: the
 * README carries the compressed story, this carries the mechanisms, and specific numbers live
 * only here.
 */
export const metadata: Metadata = {
  title: "Docs — nap",
  description:
    "How Nap works: durable jobs, the event model, verification and repair, sandboxes and snapshots, and how the agent is measured.",
};

export default function Page() {
  return <DocsPage />;
}
