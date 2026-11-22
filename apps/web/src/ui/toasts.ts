/** What a toast says. An `error` is drawn in the danger colour and announced at once. */
export type ToastMessage = {
  title: string;
  description?: string | undefined;
  tone?: "error" | undefined;
};

const listeners = new Set<(message: ToastMessage) => void>();

/**
 * Raises a toast from any code, without a hook. With no `Toaster` mounted it is not shown, which
 * is what the landing page's demos and the tests that render a sidebar alone want.
 *
 * Kept apart from `Toaster` (`toast.tsx`), and free of Base UI, so that raising a toast does not
 * bring the code that draws one: Base UI's `Toast` is one namespace the bundler cannot split, and
 * importing even its manager put all of it on the landing page, whose sidebar raises toasts and
 * never shows them.
 */
export function showToast(message: ToastMessage): void {
  for (const listener of listeners) listener(message);
}

/** For `Toaster` alone: hears every toast raised while it is mounted. */
export function subscribeToToasts(listener: (message: ToastMessage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
