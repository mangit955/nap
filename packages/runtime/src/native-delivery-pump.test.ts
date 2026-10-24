import { createHash } from "node:crypto";
import type {
  NativeDelivery,
  NativeRunBinding,
  NativeRunStore,
  StoredNativeDelivery,
} from "@nap/shared/ports/native-run-store";
import type { NativeStateCipher } from "@nap/shared/ports/native-state-cipher";
import type { ProcessEvent } from "@nap/shared/ports/sandbox-process";
import { expect, it } from "vitest";
import { NativeDeliveryPump } from "./native-delivery-pump.ts";

const binding: NativeRunBinding = {
  userId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  requestId: "00000000-0000-4000-8000-000000000004",
  turnId: "00000000-0000-4000-8000-000000000005",
  target: {
    kind: "subscription",
    accountId: "00000000-0000-4000-8000-000000000006",
    driver: "claude",
    model: "native",
    generation: 1,
  },
};
const handle = { id: "00000000-0000-4000-8000-000000000007", token: "a".repeat(64) };
const cipher: NativeStateCipher = {
  seal: (scope, value) => ({
    ciphertext: Buffer.from(value).toString("base64"),
    iv: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
  }),
  open: (scope, value) =>
    value.iv === createHash("sha256").update(JSON.stringify(scope)).digest("hex")
      ? { ok: true, value: Buffer.from(value.ciphertext, "base64").toString() }
      : { ok: false, reason: "scope_mismatch" },
};

class Ledger implements Pick<NativeRunStore, "read" | "deliveries" | "append"> {
  frames: StoredNativeDelivery[] = [];
  failAfterCommit = false;
  beforeAppend: () => Promise<void> = async () => {};
  async read() {
    return {
      binding,
      cursor: this.frames.length,
      phase: "started" as const,
      nativeSessionId: "native-session",
      receipt: { ciphertext: "private-reference", iv: "iv" },
    };
  }
  async deliveries() {
    return structuredClone(this.frames);
  }
  async append(
    _handle: typeof handle,
    value: NativeDelivery,
  ): ReturnType<NativeRunStore["append"]> {
    await this.beforeAppend();
    const delivery = {
      ...value,
      events: value.events.map((event, index) => ({
        ...event,
        seq: this.frames.flatMap((frame) => frame.events).length + index + 1,
      })),
    };
    this.frames.push(delivery);
    if (this.failAfterCommit) throw new Error("Lost database receipt");
    return { kind: "appended", delivery };
  }
}
class Lines {
  decoder = new TextDecoder("utf-8", { fatal: true });
  pending = "";
  accept(event: ProcessEvent) {
    if (event.kind !== "output" || event.stream !== "stdout") return [];
    this.pending += this.decoder.decode(event.data, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.map((text) => ({ type: "agent.message" as const, payload: { text } }));
  }
}
const frame = (sequence: number, data: number[] | Uint8Array): ProcessEvent => ({
  kind: "output",
  sequence,
  stream: "stdout",
  data: new Uint8Array(data),
});

it("restores an acknowledged partial UTF-8 frame after worker replacement without replaying output", async () => {
  const store = new Ledger();
  const published: unknown[] = [];
  const options = {
    store,
    cipher,
    handle,
    binding,
    publish: (event: unknown) => {
      published.push(event);
    },
  };
  const first = await NativeDeliveryPump.open({ ...options, decoder: new Lines() });
  const bytes = new TextEncoder().encode("héllo\n");
  await first.accept(frame(1, bytes.slice(0, 2)));
  expect(published).toEqual([]);
  const second = await NativeDeliveryPump.open({ ...options, decoder: new Lines() });
  await second.accept(frame(1, bytes.slice(0, 2)));
  await second.accept(frame(2, bytes.slice(2)));
  expect(published).toMatchObject([{ type: "agent.message", payload: { text: "héllo" }, seq: 1 }]);
  expect(store.frames).toHaveLength(2);
  await expect(second.accept(frame(1, [0]))).rejects.toThrow(/conflict/i);
});

it("does not acknowledge before persistence and recovers a lost database receipt without duplicate events", async () => {
  const store = new Ledger();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.beforeAppend = () => gate;
  const published: unknown[] = [];
  const options = {
    store,
    cipher,
    handle,
    binding,
    publish: (event: unknown) => {
      published.push(event);
    },
    decoder: new Lines(),
  };
  const first = await NativeDeliveryPump.open(options);
  let acknowledged = false;
  const accepted = first.accept(frame(1, new TextEncoder().encode("once\n"))).then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(published).toEqual([]);
  store.failAfterCommit = true;
  release();
  await expect(accepted).rejects.toThrow("Lost database receipt");
  expect(acknowledged).toBe(false);
  store.failAfterCommit = false;
  const replacement = await NativeDeliveryPump.open({ ...options, decoder: new Lines() });
  await replacement.accept(frame(1, new TextEncoder().encode("once\n")));
  expect(store.frames.flatMap((item) => item.events)).toHaveLength(1);
  expect(published).toEqual([]);
});

it("rejects swapped encrypted frames and incomplete recovery history before publishing anything", async () => {
  const store = new Ledger();
  const published: unknown[] = [];
  const options = {
    store,
    cipher,
    handle,
    binding,
    publish: (event: unknown) => {
      published.push(event);
    },
  };
  const pump = await NativeDeliveryPump.open({ ...options, decoder: new Lines() });
  await pump.accept(frame(1, [104]));
  store.frames[0]!.raw.iv = "copied-from-another-run";
  await expect(NativeDeliveryPump.open({ ...options, decoder: new Lines() })).rejects.toThrow(
    /verified/i,
  );
  store.deliveries = async () => [];
  await expect(NativeDeliveryPump.open({ ...options, decoder: new Lines() })).rejects.toThrow(
    /incomplete/i,
  );
  expect(published).toEqual([]);
});

it("rejects an oversized frame and poisons the decoder after the first failed delivery", async () => {
  const store = new Ledger();
  const pump = await NativeDeliveryPump.open({
    store,
    cipher,
    handle,
    binding,
    decoder: new Lines(),
    publish: () => {},
  });
  await expect(pump.accept(frame(1, new Uint8Array(300_000)))).rejects.toThrow();
  await expect(pump.accept(frame(1, [104, 10]))).rejects.toThrow();
  expect(store.frames).toEqual([]);
});
