import type { ComputerAction } from "@nap/shared/computer";
import { computerScreenshotKey } from "@nap/shared/computer-artifacts";
import type { ToolContext, ToolOutcome } from "./execute.ts";

/** Validate the entire batch before this function; a bad final action must have no effects. */
export async function runComputer(
  actions: ComputerAction[],
  toolCallId: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const access = ctx.computer;
  if (!access) return { ok: false, output: "Computer is unavailable for this model or workspace." };
  if (actions.some((action) => action.action === "annotate") && !access.annotate)
    return { ok: false, output: "Annotations are available only during an app test." };
  const status = (state: "starting" | "ready") =>
    ctx.emit({
      type: "computer.status",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      createdAt: ctx.now?.() ?? new Date().toISOString(),
      payload: { toolCallId, state },
    });
  if (ctx.signal?.aborted) return { ok: false, output: "Computer action cancelled." };
  status("starting");
  const started = await access.desktop.start({
    sandboxId: ctx.sandboxId,
    devServerUrl: access.devServerUrl,
    signal: ctx.signal,
  });
  if (!started.ok) return { ok: false, output: started.error.message };
  status("ready");
  const observations: string[] = [];
  for (const action of actions) {
    if (ctx.signal?.aborted) return { ok: false, output: "Computer action cancelled." };
    if (action.action === "screenshot") continue;
    if (action.action === "annotate") {
      const result = await access.annotate?.(action.annotation);
      if (!result?.ok)
        return { ok: false, output: result?.error.message ?? "Annotations are unavailable." };
      continue;
    }
    const allowed = access.beforeAction?.(action);
    if (allowed && !allowed.ok) return { ok: false, output: allowed.error.message };
    let result: Awaited<ReturnType<typeof access.desktop.act>>;
    try {
      result = await access.desktop.act(ctx.sandboxId, action, ctx.signal);
    } catch {
      access.afterAction?.(action, false);
      return { ok: false, output: "Computer input completion is unknown. No action was replayed." };
    }
    access.afterAction?.(action, result.ok);
    if (!result.ok) return { ok: false, output: result.error.message };
    if (result.value.kind === "text") observations.push(result.value.text.slice(0, 30000));
    if (result.value.kind === "cursor")
      observations.push(`Cursor at (${result.value.coordinate.join(", ")}).`);
  }
  if (ctx.signal?.aborted) return { ok: false, output: "Computer action cancelled." };
  const screenshot = await access.desktop.screenshot(ctx.sandboxId, ctx.signal);
  if (!screenshot.ok) return { ok: false, output: screenshot.error.message };
  const { bytes, width, height } = screenshot.value;
  await access.beforeStore();
  const key = computerScreenshotKey({
    projectId: access.projectId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    toolCallId,
  });
  const stored = await access.objects.put(key, bytes);
  if (!stored.ok) return { ok: false, output: "Could not store the computer screenshot." };
  ctx.emit({
    type: "computer.screenshot",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    createdAt: ctx.now?.() ?? new Date().toISOString(),
    payload: { toolCallId, key, width, height },
  });
  access.screenshotStored?.(toolCallId);
  const output = [
    `Completed ${actions.length} computer actions. Screenshot ${width}×${height}.`,
    ...observations,
  ]
    .join("\n")
    .slice(0, 30000);
  return {
    ok: true,
    output,
    content: [
      { type: "text", text: output },
      { type: "image", mediaType: "image/jpeg", data: Buffer.from(bytes).toString("base64") },
    ],
  };
}
