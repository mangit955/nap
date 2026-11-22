"use client";

import { Toast } from "@base-ui/react/toast";
import { Check, CircleAlert } from "lucide-react";
import { useEffect } from "react";
import { subscribeToToasts } from "./toasts.ts";

const manager = Toast.createToastManager();

/**
 * Draws the toasts `showToast` raises: the bottom right, over everything but a modal dialog.
 * Mount it once, in the frame every signed-in page shares.
 *
 * An error is high priority, which Base UI reads out at once through an alert of its own rather
 * than waiting for the reader to be idle.
 */
export function Toaster() {
  useEffect(
    () =>
      subscribeToToasts(({ title, description, tone }) => {
        manager.add({
          title,
          description,
          ...(tone === "error" && { type: "error", priority: "high" as const }),
        });
      }),
    [],
  );
  return (
    <Toast.Provider toastManager={manager} timeout={4000} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  return Toast.useToastManager().toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className={ROOT}>
      <Toast.Content className="flex min-w-0 items-start gap-2.5">
        {toast.type === "error" ? (
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
        ) : (
          <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
        )}
        <div className="min-w-0">
          <Toast.Title
            className={`text-[13px] leading-5 ${toast.type === "error" ? "text-danger" : "text-ink"}`}
          />
          <Toast.Description className="truncate text-xs leading-4 text-muted" />
        </div>
      </Toast.Content>
    </Toast.Root>
  ));
}

/**
 * The menus' raised panel, without their glass: a toast can land over the white preview of the
 * user's app, where a translucent surface would take on the page behind it.
 *
 * It arrives up 8px from transparent over 200ms and leaves the same way; a swipe moves it with
 * the finger (`--toast-swipe-movement-*`). Reduced motion keeps only the appearing and the
 * leaving, with no movement and no fade. Past the limit of three the oldest is hidden.
 */
const ROOT =
  "relative rounded-[10px] bg-panel px-3 py-2.5 shadow-raised outline-none focus-visible:ring-1 focus-visible:ring-accent [transform:translate(var(--toast-swipe-movement-x,0px),var(--toast-swipe-movement-y,0px))] transition-[opacity,translate] duration-200 ease-out data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[swiping]:transition-none data-[limited]:hidden motion-reduce:transition-none";
