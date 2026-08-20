import { describe, expect, it } from "vitest";
import { InMemorySandboxCapacity } from "./in-memory-sandbox-capacity.ts";

/**
 * The fake every caller of `SandboxCapacity` is tested against, so its own behaviour has to be
 * right or those tests are agreeing with a mistake.
 *
 * What is asserted here is only what a *caller* can observe: that a reservation is held until it
 * is released, that a limit refuses with the reason the real one would, and that unlimited is the
 * default. It says nothing about atomicity, which is a property of a transaction and belongs to
 * `postgres-sandbox-capacity.db.test.ts`.
 */

const USER = "8f0a1b2c-3d4e-4f50-9a6b-7c8d9e0f1a2b";
const OTHER = "9a0b1c2d-3e4f-4051-9b6c-7d8e9f0a1b2c";

describe("InMemorySandboxCapacity", () => {
  it("admits anybody when no limits were asked for", async () => {
    // The default most callers want: they are testing something else, and a ceiling they did not
    // ask for would refuse a turn for a reason their test never mentions.
    const capacity = new InMemorySandboxCapacity();

    for (let i = 0; i < 50; i += 1) {
      expect((await capacity.reserve({ projectId: `p-${i}`, userId: USER })).ok).toBe(true);
    }
  });

  it("holds a reservation until it is released", async () => {
    const capacity = new InMemorySandboxCapacity({ total: 1 });

    const first = await capacity.reserve({ projectId: "p-1", userId: USER });
    expect((await capacity.reserve({ projectId: "p-2", userId: OTHER })).ok).toBe(false);

    if (first.ok) await capacity.release(first.value.id);
    expect((await capacity.reserve({ projectId: "p-2", userId: OTHER })).ok).toBe(true);
  });

  it("refuses for the reason the real one would", async () => {
    const perUser = new InMemorySandboxCapacity({ perUser: 1 });
    await perUser.reserve({ projectId: "p-1", userId: USER });

    const mine = await perUser.reserve({ projectId: "p-2", userId: USER });
    expect(mine.ok).toBe(false);
    if (!mine.ok) expect(mine.error.reason).toBe("per_user");

    // The same user's cap says nothing about anybody else's.
    expect((await perUser.reserve({ projectId: "p-3", userId: OTHER })).ok).toBe(true);

    const held = new InMemorySandboxCapacity();
    await held.reserve({ projectId: "p-1", userId: USER });
    const twice = await held.reserve({ projectId: "p-1", userId: USER });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.reason).toBe("project_held");
  });

  it("shows an activated reservation as active against its sandbox", async () => {
    const capacity = new InMemorySandboxCapacity();

    const reserved = await capacity.reserve({ projectId: "p-1", userId: USER });
    if (!reserved.ok) throw new Error("expected the reservation to be admitted");
    await capacity.activate(reserved.value.id, "sb-1");

    expect(capacity.held()).toEqual([
      { id: reserved.value.id, projectId: "p-1", userId: USER, state: "active", sandboxId: "sb-1" },
    ]);
  });

  it("releases by project, whatever state the reservation is in", async () => {
    const capacity = new InMemorySandboxCapacity();
    const reserved = await capacity.reserve({ projectId: "p-1", userId: USER });
    if (reserved.ok) await capacity.activate(reserved.value.id, "sb-1");
    await capacity.reserve({ projectId: "p-2", userId: USER });

    await capacity.releaseForProject("p-1");

    expect(capacity.held()).toMatchObject([{ projectId: "p-2", state: "reserved" }]);
  });
});
