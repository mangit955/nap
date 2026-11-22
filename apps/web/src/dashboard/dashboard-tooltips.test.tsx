import {
  NavigationSchema,
  type SessionNavigation,
  type SessionSummary,
} from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { navigationServer } from "../testing/navigation-server.ts";
import { TOOLTIP_DELAY_MS } from "../ui/tooltip.tsx";
import { ThreadDetailsToggle } from "../workspace/thread-details.tsx";
import { Dashboard } from "./dashboard.tsx";
import { Sidebar } from "./sidebar.tsx";

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (name: string, navigation: Partial<SessionNavigation> = {}): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: ago(600),
  updatedAt: ago(600),
  navigation: NavigationSchema.parse(navigation),
  revision: 0,
  activity: "completed",
  activityAt: null,
  requestedAt: ago(120),
  repository: "example/storefront",
  branch: "nap/fix-header",
  pullRequest: { number: 7, state: "open", url: "https://github.com/example/storefront/pull/7" },
  pendingFeedback: 0,
  runStartedAt: null,
  turnFinishedAt: null,
  diff: { added: 3, removed: 1 },
  model: "verify/scripted",
  titling: false,
});

/** One row in each state that draws a different set of hover controls. */
const ROWS = [
  row("Plain"),
  row("Sleeping", { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
  row("Finished", { doneAt: ago(1) }),
  row("Awake", { snoozedUntil: ago(5) }),
];

function Harness({ server }: { server: ReturnType<typeof navigationServer> }) {
  const navigation = useSessionNavigation({ fetchJson: server.fetchJson });
  return (
    <Dashboard
      hero={<p>Hero</p>}
      details={<ThreadDetailsToggle open={false} onToggle={vi.fn()} />}
      sidebar={
        <Sidebar
          navigation={navigation}
          ownerId="tooltip-reader"
          persistScroll={false}
          name="Reader"
          email={undefined}
          recents={[]}
          keyHint={undefined}
          onNewProject={vi.fn()}
          onApiKey={vi.fn()}
          onSignOut={vi.fn()}
          loading={navigation.status === "loading"}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      }
    />
  );
}

async function mount() {
  const view = render(<Harness server={navigationServer(ROWS)} />);
  await screen.findByRole("link", { name: /Plain/ });
  // The two shelves start folded; open them so their rows' controls are drawn.
  fireEvent.click(screen.getByRole("button", { name: /^Snoozed \(/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Settled \(/ }));
  await screen.findByRole("link", { name: /Sleeping/ });
  // Timers go fake only once the list has loaded: the load itself waits on real ones.
  vi.useFakeTimers();
  return view;
}

/** A mouse coming to rest on the control for the tooltip's delay. */
function rest(element: Element) {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  fireEvent.mouseEnter(element);
  fireEvent.mouseMove(element);
  act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
}

/** The tooltip is drawn into `document.body`, outside the frame, which is how it is told apart. */
function tooltip(container: HTMLElement, text: string) {
  return screen.queryAllByText(text).find((element) => !container.contains(element)) ?? null;
}

const control = (name: string) =>
  screen.queryByRole("button", { name }) ?? screen.getByRole("link", { name });

describe("the dashboard's icon-only controls", () => {
  // A row's link keeps its `title`: it has words of its own, and the title adds the repository,
  // branch and workspace state to them. A control with only an icon has nothing but its name.
  it("leave none of them the browser's own `title` tooltip", async () => {
    const { container } = await mount();
    const iconOnly = [...container.querySelectorAll(":is(a, button, summary)")].filter(
      (element) => element.textContent?.trim() === "",
    );
    expect(iconOnly.length).toBeGreaterThanOrEqual(10);
    expect(iconOnly.filter((element) => element.hasAttribute("title"))).toEqual([]);
  });

  // Each control the browser's `title` used to name, by its accessible name, and the shorter
  // label the tooltip draws. The accessible name stays the control's own `aria-label`.
  it.each([
    ["Collapse sidebar", "Collapse sidebar"],
    ["New session", "New session"],
    ["Filter by source", "Filter by source"],
    ["Settings", "Settings"],
    ["Help", "Help"],
    ["More actions for Plain", "More actions"],
    ["Snooze Plain", "Snooze"],
    ["Wake Sleeping", "Wake"],
    ["Un-settle Finished", "Un-settle"],
    ["Dismiss Woke for Awake", "Dismiss"],
    ["Toggle thread details panel", "Thread details"],
  ])("%s shows “%s” once the pointer rests on it", async (name, text) => {
    const { container } = await mount();
    const target = control(name);
    expect(tooltip(container, text)).toBeNull();
    rest(target);
    expect(tooltip(container, text)).not.toBeNull();
  });

  // A control whose own words say what it does gets no tooltip repeating them.
  it("Settle, which says so on the button, has none", async () => {
    const { container } = await mount();
    rest(screen.getByRole("button", { name: "Settle Plain" }));
    expect(tooltip(container, "Settle")).toBeNull();
  });

  it.each([
    ["Settings", "Settings"],
    ["Filter by source", "Filter by source"],
    ["Snooze Plain", "Snooze"],
  ])("%s keeps its tooltip shut while its own menu is open", async (name, text) => {
    const { container } = await mount();
    const target = control(name);
    fireEvent.click(target);
    expect(target).toHaveAttribute("aria-expanded", "true");
    rest(target);
    expect(tooltip(container, text)).toBeNull();
  });
});
