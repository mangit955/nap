/** Limits server-side authentication work even if an adapter fails to observe cancellation. */
export async function withAuthDeadline<T>(input: {
  expiresAt: string;
  maxDurationMs: number;
  action: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => {
      controller.abort();
      timeout.reject(new Error("Provider authentication deadline reached"));
    },
    Math.max(1, Math.min(input.maxDurationMs, Date.parse(input.expiresAt) - Date.now())),
  );
  try {
    return await Promise.race([input.action(controller.signal), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
