const MESSAGES = {
  lease_lost: "the lease on this session was lost",
  cancelled: "the turn was cancelled",
  shutdown: "the worker is shutting down",
};

/** Runtime cleanup can distinguish lost authority from an owner's requested cancellation. */
export class TurnAbortError extends Error {
  #lostLease = false;
  get leaseLost(): boolean {
    return this.code === "lease_lost" || this.#lostLease;
  }
  /** AbortSignal keeps its first reason while cleanup can outlive that first cancellation. */
  markLeaseLost(): void {
    this.#lostLease = true;
  }
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = "TurnAbortError";
  }
}
