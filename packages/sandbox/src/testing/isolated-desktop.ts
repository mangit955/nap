import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import type { SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";

/** Standalone driver tests own their entire sandbox and explicitly close this scope. */
export function isolatedDesktop(transport: DesktopInputTransport): SandboxDesktop & {
  close(sandboxId: string): ReturnType<DesktopInputTransport["closeAndDrain"]>;
} {
  const scopeId = crypto.randomUUID();
  return {
    start: (request) => transport.start(request),
    screenshot: (id, signal) => transport.screenshot(id, signal),
    streamCredentials: (id) => transport.streamCredentials(id),
    act: (sandboxId, action, signal) =>
      ["read_dom", "console", "cursor_position", "zoom", "wait"].includes(action.action)
        ? transport.observe({ sandboxId, action, signal })
        : transport.act({ sandboxId, scopeId, action, signal }),
    close: (sandboxId) => transport.closeAndDrain({ sandboxId, scopeId }),
  };
}
