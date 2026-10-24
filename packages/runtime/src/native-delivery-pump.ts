import { createHash } from "node:crypto";
import {
  type NativeOutputEvent,
  NativeStoredFrameSchema,
} from "@nap/shared/native-delivery-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type {
  NativeDeliveryCipher,
  NativeDeliveryScope,
} from "@nap/shared/ports/native-delivery-cipher";
import {
  type NativeRunBinding,
  NativeRunBindingSchema,
  type NativeRunHandle,
  type NativeRunStore,
} from "@nap/shared/ports/native-run-store";
import type { ProcessEvent } from "@nap/shared/ports/sandbox-process";

export type NativeOutputDecoder = { accept(event: ProcessEvent): NativeOutputEvent[] };
type Options = {
  store: Pick<NativeRunStore, "read" | "deliveries" | "append">;
  cipher: NativeDeliveryCipher;
  handle: NativeRunHandle;
  binding: NativeRunBinding;
  decoder: NativeOutputDecoder;
  publish: (event: StoredEvent) => void | Promise<void>;
  now?: () => string;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function storedFrame(event: ProcessEvent, createdAt: string) {
  return NativeStoredFrameSchema.parse({
    createdAt,
    frame:
      event.kind === "output"
        ? { ...event, data: Buffer.from(event.data).toString("base64") }
        : event,
  });
}

/** Feed this awaited callback directly to SandboxProcessHost. Resolution permits its ACK. */
export class NativeDeliveryPump {
  #cursor = 0;
  #hashes = new Map<number, string>();
  #tail: Promise<void> = Promise.resolve();
  private constructor(private readonly options: Options) {}

  static async open(options: Options): Promise<NativeDeliveryPump> {
    const pump = new NativeDeliveryPump(options);
    const record = await options.store.read(options.handle);
    if (
      record === null ||
      record.phase !== "started" ||
      JSON.stringify(NativeRunBindingSchema.parse(record.binding)) !==
        JSON.stringify(NativeRunBindingSchema.parse(options.binding))
    )
      throw new Error("Native delivery binding is unavailable.");
    const deliveries = await options.store.deliveries(options.handle, 0);
    if (deliveries === null || deliveries.length !== record.cursor)
      throw new Error("Native delivery history is incomplete.");
    for (const delivery of deliveries) {
      if (delivery.sequence !== pump.#cursor + 1)
        throw new Error("Native delivery history is out of order.");
      const opened = options.cipher.open(
        pump.#scope(delivery.sequence, delivery.rawHash),
        delivery.raw,
      );
      if (!opened.ok) throw new Error("Native delivery state could not be verified.");
      const saved = NativeStoredFrameSchema.parse(JSON.parse(opened.value));
      if (
        saved.frame.sequence !== delivery.sequence ||
        hash(JSON.stringify(saved.frame)) !== delivery.rawHash
      )
        throw new Error("Native delivery state conflicts with its receipt.");
      options.decoder.accept(
        saved.frame.kind === "output"
          ? { ...saved.frame, data: Buffer.from(saved.frame.data, "base64") }
          : saved.frame,
      );
      pump.#cursor = delivery.sequence;
      pump.#hashes.set(delivery.sequence, delivery.rawHash);
    }
    return pump;
  }

  readonly accept = (event: ProcessEvent): Promise<void> => {
    const accepted = this.#tail.then(() => this.#accept(event));
    // A failure poisons this decoder. Reconnect reconstructs it from committed raw frames.
    this.#tail = accepted;
    return accepted;
  };

  async #accept(event: ProcessEvent): Promise<void> {
    const { store, handle, decoder, cipher, publish, binding } = this.options;
    const saved = storedFrame(event, this.options.now?.() ?? new Date().toISOString());
    const rawHash = hash(JSON.stringify(saved.frame));
    if (event.sequence <= this.#cursor) {
      if (this.#hashes.get(event.sequence) !== rawHash)
        throw new Error("Native delivery replay conflict.");
      return;
    }
    if (event.sequence !== this.#cursor + 1) throw new Error("Native delivery is out of order.");
    const decoded = decoder.accept(event);
    const result = await store.append(handle, {
      sequence: event.sequence,
      rawHash,
      raw: cipher.seal(this.#scope(event.sequence, rawHash), JSON.stringify(saved)),
      events: decoded.map((output) => ({
        ...output,
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        createdAt: saved.createdAt,
      })),
    });
    if (result.kind !== "appended" && result.kind !== "duplicate")
      throw new Error(`Native delivery was refused: ${result.kind}.`);
    this.#cursor = event.sequence;
    this.#hashes.set(event.sequence, rawHash);
    for (const stored of result.delivery.events) await publish(stored);
  }

  #scope(sequence: number, rawHash: string): NativeDeliveryScope {
    return {
      kind: "native_delivery",
      binding: this.options.binding,
      runId: this.options.handle.id,
      sequence,
      rawHash,
    };
  }
}
