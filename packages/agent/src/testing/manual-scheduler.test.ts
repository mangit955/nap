import { describe, expect, it } from "vitest";
import { ManualScheduler } from "./manual-scheduler.ts";

describe("ManualScheduler", () => {
  it("runs nothing until time is moved, then runs what fell due in the order it fell due", () => {
    const timers = new ManualScheduler();
    const ran: string[] = [];

    timers.schedule(() => ran.push("late"), 300);
    timers.schedule(() => ran.push("early"), 100);
    expect(ran).toEqual([]);
    expect(timers.pending).toBe(2);

    timers.advance(299);
    expect(ran).toEqual(["early"]);
    timers.advance(1);

    expect(ran).toEqual(["early", "late"]);
    expect(timers.pending).toBe(0);
    expect(timers.now).toBe(300);
  });

  it("never runs a cancelled timer, and stops counting it", () => {
    const timers = new ManualScheduler();
    const ran: string[] = [];

    const cancel = timers.schedule(() => ran.push("cancelled"), 10);
    cancel();
    timers.advance(100);

    expect(ran).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it("runs a timer armed by another one when it falls due inside the same advance", () => {
    const timers = new ManualScheduler();
    const ran: number[] = [];

    timers.schedule(() => {
      ran.push(timers.now);
      timers.schedule(() => ran.push(timers.now), 50);
    }, 50);
    timers.advance(100);

    expect(ran).toEqual([50, 100]);
  });
});
