import { Pane } from "./pane.tsx";

/**
 * Placeholder. Becomes a sandboxed iframe pointed at the sandbox's dev server, with
 * loading and error states, once preview URLs exist.
 */
export function PreviewPane() {
  return (
    <Pane
      id="preview"
      title="Preview"
      action={<span className="font-mono text-muted text-xs">localhost:5173</span>}
    >
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-edge border-dashed p-10 text-center">
          <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
          <p className="text-muted text-sm">Your app appears here once the sandbox boots.</p>
        </div>
      </div>
    </Pane>
  );
}
