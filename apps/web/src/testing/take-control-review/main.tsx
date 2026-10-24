import { ComputerInputSchema } from "@nap/shared/computer-access";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerInputSurface } from "../../computer/computer-input-surface.tsx";
import { useComputerControl } from "../../computer/use-computer-control.ts";
import type { FetchJson } from "../../files/use-project-files.ts";
import "./review.css";

function Review() {
  const [busy, setBusy] = useState(false);
  const [leased, setLeased] = useState(false);
  const [connected, setConnected] = useState(true);
  const [active, setActive] = useState(true);
  const [fail, setFail] = useState(false);
  const [count, setCount] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [lastAction, setLastAction] = useState("No input");
  const fixture = useRef({ leased, fail });
  fixture.current = { leased, fail };
  const fetcher = useRef<FetchJson>(async (url, init) => {
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (fixture.current.leased) return respond({ code: "busy" }, 409);
    if (url.endsWith("/input")) {
      if (fixture.current.fail) return respond({ applied: 0 }, 503);
      const body = ComputerInputSchema.parse(JSON.parse(String(init?.body)));
      setCount((value) => value + body.actions.length);
      // The fixture reports action kinds only. Typed values and grants are never displayed.
      setLastAction(
        body.actions
          .map(
            (action) =>
              action.action +
              ("coordinate" in action && action.coordinate
                ? `@${action.coordinate.join(",")}`
                : ""),
          )
          .join(", "),
      );
      setCounts((previous) => {
        const next = { ...previous };
        for (const action of body.actions) next[action.action] = (next[action.action] ?? 0) + 1;
        return next;
      });
      return respond({ applied: body.actions.length });
    }
    return init?.method === "POST"
      ? respond({ grant: "local-fixture-only", expiresAt: Date.now() + 60_000 })
      : respond({ available: true });
  });
  const control = useComputerControl({
    sessionId: "local-review",
    active,
    connected,
    busy,
    sourceKey: "fixture-live",
    fetch: fetcher.current,
  });
  return (
    <main>
      <header>
        <h1>Computer</h1>
        <span>Local input review</span>
      </header>
      <fieldset>
        <legend>Fixture state</legend>
        <label>
          <input
            type="checkbox"
            checked={busy}
            onChange={(event) => setBusy(event.target.checked)}
          />{" "}
          Current turn busy
        </label>
        <label>
          <input
            type="checkbox"
            checked={leased}
            onChange={(event) => setLeased(event.target.checked)}
          />{" "}
          Another session leased
        </label>
        <label>
          <input
            type="checkbox"
            checked={!connected}
            onChange={(event) => setConnected(!event.target.checked)}
          />{" "}
          Disconnected
        </label>
        <label>
          <input
            type="checkbox"
            checked={!active}
            onChange={(event) => setActive(!event.target.checked)}
          />{" "}
          History
        </label>
        <label>
          <input
            type="checkbox"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />{" "}
          Fail next input
        </label>
      </fieldset>
      <section className="stage">
        <div
          className="screen"
          role="application"
          aria-label="Remote computer"
          data-driving={control.driving || undefined}
        >
          {/* This synthetic image is centered exactly like the permanently passive live stream. */}
          {/* biome-ignore lint/performance/noImgElement: Standalone local fixture has no Next image optimizer. */}
          <img src="./fixture-desktop.jpg" alt="Synthetic desktop" draggable={false} />
          <ComputerInputSurface
            driving={control.driving}
            available={control.available}
            sourceKey={`${active}-${connected}`}
            sendActions={control.sendActions}
            takeControl={control.takeControl}
            release={control.release}
          />
        </div>
      </section>
      <footer>
        <span className="live">{active ? "Live" : "History"}</span>
        {control.driving ? (
          <button type="button" onClick={control.release}>
            Release control
          </button>
        ) : (
          <button
            type="button"
            disabled={!control.available}
            title={control.disabledReason ?? undefined}
            onClick={() => {
              void control.takeControl();
            }}
          >
            Take control of Nap’s computer
          </button>
        )}
      </footer>
      <p role="status">{control.status}</p>
      {control.disabledReason && <p>{control.disabledReason}</p>}
      {control.error && <p role="alert">{control.error}</p>}
      <output aria-label="Applied input" data-counts={JSON.stringify(counts)}>
        {count} actions applied. {lastAction}
      </output>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Review />);
