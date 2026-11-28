"use client";

import { Toast } from "@base-ui/react/toast";
import { Check, CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribeToToasts } from "./toasts.ts";

const manager = Toast.createToastManager();

/**
 * Draws the toasts `showToast` raises: the bottom right, over everything but a modal dialog.
 * Mounted once, in the frame the dashboard and each project's workspace share. The settings pages
 * and `/welcome` are drawn without it, so a toast raised there is not shown.
 *
 * An error is high priority, which Base UI reads out at once through an alert of its own rather
 * than waiting for the reader to be idle, and stays twice as long, since nothing pauses it.
 *
 * A toast takes no pointer events: it says something and goes, and never takes a click meant for
 * what it covers. The cost is Base UI's pause on hover and its swipe to dismiss, neither of which
 * a line with nothing to press needs. A toast with an action is the exception: it has buttons, so
 * it takes the pointer, and a press elsewhere leaves it up — the reader carrying on with their
 * work has not answered it. It goes on its timeout, on its action, or on its close button.
 *
 * Below `md` the stack sits 4rem up. There the open sidebar is a drawer as tall as the screen,
 * with Settings and Help in its last 3rem, and a toast at the foot covered both.
 */
export function Toaster() {
  // The toasts a press anywhere clears: every one with nothing to press.
  const [plain] = useState(() => new Set<string>());
  useEffect(
    () =>
      subscribeToToasts(({ title, description, tone, action }) => {
        const id: string = manager.add({
          title,
          description,
          onClose: () => plain.delete(id),
          ...(tone === "error" && { type: "error", priority: "high" as const, timeout: 8000 }),
          ...(tone === "finished" && { type: "finished", timeout: 8000 }),
          ...(action && {
            actionProps: {
              children: action.label,
              onClick: () => {
                action.onClick();
                manager.close(id);
              },
            },
          }),
        });
        if (!action) plain.add(id);
      }),
    [plain],
  );
  // Any press clears the plain toasts showing. Taps pass through one, so on a phone one opening
  // the sidebar's Settings, whose menu rises from the foot of the screen, would otherwise act on
  // rows drawn under the toast without their labels showing. The press that copies comes before
  // the toast it raises, so it never clears its own.
  useEffect(() => {
    const clear = () => {
      for (const id of plain) manager.close(id);
    };
    document.addEventListener("pointerdown", clear, true);
    return () => document.removeEventListener("pointerdown", clear, true);
  }, [plain]);
  return (
    <Toast.Provider toastManager={manager} timeout={4000} limit={3}>
      <Toast.Portal>
        <Toast.Viewport
          data-toast-viewport
          className="pointer-events-none fixed right-4 bottom-4 z-[60] max-md:bottom-16 flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  return Toast.useToastManager().toasts.map((toast) =>
    toast.type === "finished" ? (
      <Toast.Root key={toast.id} toast={toast} className={FINISHED}>
        <Toast.Content className="flex min-w-0 items-start gap-2.5 py-3 pr-3 pl-3.5 text-sm">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <Toast.Title className="font-medium leading-5 text-ink" />
            <Toast.Description className="truncate text-[13px] leading-5 text-muted" />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {toast.actionProps && (
              <Toast.Action className="h-[26px] rounded-md border border-ink/10 px-[9px] text-[12.5px] text-ink outline-none hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-accent" />
            )}
            <Toast.Close
              aria-label="Dismiss"
              className="grid size-[26px] place-items-center rounded-md text-muted outline-none hover:bg-ink/5 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X aria-hidden className="size-3.5" />
            </Toast.Close>
          </div>
        </Toast.Content>
      </Toast.Root>
    ) : (
      <PlainToast key={toast.id} toast={toast} />
    ),
  );
}

function PlainToast({ toast }: { toast: Toast.Root.ToastObject }) {
  return (
    <Toast.Root toast={toast} className={ROOT}>
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
  );
}

/**
 * The menus' raised panel, without their glass: a toast can land over the white preview of the
 * user's app, where a translucent surface would take on the page behind it.
 *
 * It arrives up 8px from transparent over 200ms and leaves the same way. Reduced motion keeps only
 * the appearing and the leaving, with no movement and no fade. Past the limit of three the oldest
 * is hidden.
 */
const ROOT =
  "pointer-events-none relative rounded-[10px] bg-panel px-3 py-2.5 shadow-raised outline-none focus-visible:ring-1 focus-visible:ring-accent transition-[opacity,translate] duration-200 ease-out data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[limited]:hidden motion-reduce:transition-none";

/**
 * T3 Code's toast for a session that finished out of sight, value for value: the menus' glass
 * (`.composer-surface`, T3's `dropdown-glass`), an 8px corner and `shadow-xl` at 25% black. It
 * rises from below the screen's edge — its own height plus the 1rem inset — over 500ms on
 * T3's `cubic-bezier(.22,1,.36,1)`, and leaves the same way, fading as it goes. Reduced motion
 * shows and hides it without the slide or the fade. It takes the pointer, since it has buttons.
 * Adapted from T3 Code (MIT — see apps/web/THIRD_PARTY_NOTICES.md).
 */
const FINISHED =
  "composer-surface pointer-events-auto relative rounded-[8px] shadow-xl shadow-black/25 outline-none focus-visible:ring-1 focus-visible:ring-accent transition-[opacity,translate] duration-500 ease-[cubic-bezier(.22,1,.36,1)] data-[starting-style]:translate-y-[calc(100%+1rem)] data-[ending-style]:translate-y-[calc(100%+1rem)] data-[ending-style]:opacity-0 data-[limited]:hidden motion-reduce:transition-none";
