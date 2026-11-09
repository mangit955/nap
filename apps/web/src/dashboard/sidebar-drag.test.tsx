/**
 * The drag layer's measuring timer, in jsdom.
 *
 * Where a drop lands is proven in a real Chrome by `sidebar-drag.integration.test.ts`; jsdom lays
 * nothing out, so every rect here is zero and only *when* the drop targets are measured can be
 * seen. That is what these pin: a measurement 50ms after movement, one per 50ms however many
 * moves arrive, none while nothing moves — and no timer left behind when the layer unmounts,
 * which would otherwise fire after the DOM has been torn down.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DragLayer, SortableShell } from "./sidebar-drag.tsx";

/** jsdom does not implement it, and the layer's collision check calls it on every move. */
const nativeElementFromPoint = "elementFromPoint" in document;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  if (!nativeElementFromPoint) {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (!nativeElementFromPoint) {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});

function Sidebar() {
  return (
    <DragLayer
      ids={["alpha", "beta"]}
      container={{ current: null }}
      fixed={new Set()}
      onDragStart={() => {}}
      onDragOver={() => {}}
      onDragEnd={() => {}}
    >
      <ul aria-label="Sessions">
        <SortableShell id="alpha">Alpha</SortableShell>
        <SortableShell id="beta">Beta</SortableShell>
      </ul>
    </DragLayer>
  );
}

/** How many times the row nobody is holding has had its rect read — a drop target measured. */
function watchMeasurements(row: HTMLElement) {
  const read = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  return () => read.mock.contexts.filter((element) => element === row).length;
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("leaves no measurement waiting after the drag layer unmounts", () => {
  const view = render(<Sidebar />);
  expect(screen.getByRole("list", { name: "Sessions" })).toBeVisible();
  // Mounting arms one, as dnd-kit's own frequency does — the thing that must not outlive it.
  expect(vi.getTimerCount()).toBe(1);

  view.unmount();

  expect(vi.getTimerCount()).toBe(0);
});

it("measures once after mounting, then leaves an idle sidebar alone", () => {
  render(<Sidebar />);
  const beta = rowNamed("Beta");
  const measured = watchMeasurements(beta);

  wait(49);
  expect(measured()).toBe(0);
  wait(1);
  expect(measured()).toBe(1);

  wait(1000);
  expect(measured()).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("measures the drop targets once per 50ms while the pointer moves, and once after the drop", () => {
  render(<Sidebar />);
  const alpha = rowNamed("Alpha");
  const beta = rowNamed("Beta");
  wait(50);

  fireEvent.mouseDown(alpha, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(document, { clientX: 10, clientY: 20 });
  wait(50);
  const measured = watchMeasurements(beta);

  // A move every 5ms for 100ms: one measurement per 50ms window, not one per move, and not
  // held back until the pointer stops.
  const counts: number[] = [];
  for (let step = 1; step <= 20; step += 1) {
    fireEvent.mouseMove(document, { clientX: 10, clientY: 20 + step });
    wait(5);
    counts.push(measured());
  }
  expect(counts[8]).toBe(0);
  expect(counts[9]).toBe(1);
  expect(counts[18]).toBe(1);
  expect(counts[19]).toBe(2);

  // Standing still mid-drag measures nothing more.
  wait(500);
  expect(measured()).toBe(2);

  // Letting go puts the rows back, so the targets are measured once more after the drop.
  fireEvent.mouseUp(document, { clientX: 10, clientY: 40 });
  const dropped = measured();
  wait(49);
  expect(measured()).toBe(dropped);
  wait(1);
  expect(measured()).toBe(dropped + 1);
});

/** A row by its text: a list item takes no accessible name from what it contains. */
function rowNamed(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((item) => item.textContent === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}
