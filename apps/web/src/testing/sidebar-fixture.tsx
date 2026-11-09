/**
 * The session sidebar on a page of its own, for the browser proof of dragging
 * (`dashboard/sidebar-drag.integration.test.ts`): the real `Sidebar`, the real navigation hook
 * and its optimistic queue, against `navigationServer` instead of the API. The test bundles this
 * file and drives it with real pointer events, which jsdom cannot — it lays nothing out.
 *
 * `window.__navigation` is the server, so the test can read what was sent and how it stands.
 */

import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { navigationServer } from "./navigation-server.ts";

const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
let counter = 0;
const row = (
  name: string,
  navigation: Partial<SessionSummary["navigation"]>,
  extra: Partial<SessionSummary> = {},
): SessionSummary => {
  counter += 1;
  return {
    projectId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name,
    status: "ready",
    sandboxId: "sandbox",
    sessionIds: [],
    createdAt: minutes(600),
    updatedAt: minutes(600),
    navigation: NavigationSchema.parse({ readAt: minutes(1), ...navigation }),
    revision: 0,
    activity: "completed",
    activityAt: minutes(30),
    requestedAt: minutes(30 + counter),
    repository: counter % 2 ? "example/storefront" : null,
    branch: counter % 2 ? `nap/change-${counter}` : null,
    pullRequest: null,
    pendingFeedback: 0,
    ...extra,
  };
};

const server = navigationServer([
  row("Header polish", { position: 0 }),
  row("Checkout flow", { position: 1 }),
  row("Search results", { position: 2 }),
  row("Pricing page", { position: 3 }),
  // Settled after their last request, as a settled session always is.
  row("Shipped landing page", { doneAt: minutes(5) }, { requestedAt: minutes(90) }),
  row("Old onboarding", { doneAt: minutes(50) }, { requestedAt: minutes(120) }),
]);
Object.assign(window, { __navigation: server });
// Every load starts from the same page: shelves shut, nothing remembered from the last case.
localStorage.clear();

function Fixture() {
  const navigation = useSessionNavigation({ fetchJson: server.fetchJson, baseUrl: "" });
  return (
    <div className="h-dvh w-64">
      <Sidebar
        navigation={navigation}
        ownerId="fixture"
        persistScroll={false}
        name="Fixture"
        email={undefined}
        recents={[]}
        keyHint={undefined}
        onNewProject={() => {}}
        onApiKey={() => {}}
        onSignOut={() => {}}
        loading={navigation.status === "loading"}
        error={navigation.actionError}
        onRename={(id, name) => void navigation.rename(id, name)}
        onDelete={(id) => void navigation.remove(id)}
        onClose={(id) => void navigation.close(id)}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
