import { createHash } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { TOOL_NAMES } from "@nap/shared/events";
import type { NativeWorkspaceTools } from "@nap/shared/ports/native-workspace-tools";
import { z } from "zod";
import { TOOL_DEFINITIONS, TOOL_SCHEMAS } from "./tools/definitions.ts";

const Context = z.object({
  requestId: z.union([z.string().min(1).max(1000), z.int()]),
  signal: z.instanceof(AbortSignal),
});

/** SDK-owned MCP tools forward every operation to an already-scoped project client. */
export async function createNativeWorkspaceTools(options: {
  runId: string;
  remote: NativeWorkspaceTools;
  signal: AbortSignal;
  onUncertain: () => void;
}) {
  const runId = z.uuid().parse(options.runId);
  let poisoned = false;
  const uncertain = () => {
    if (poisoned) return;
    poisoned = true;
    try {
      options.onUncertain();
    } catch {}
  };
  return TOOL_NAMES.map((name) => {
    const definition = TOOL_DEFINITIONS.find((item) => item.name === name);
    if (definition === undefined) throw new Error(`Missing project tool definition: ${name}`);
    return tool(name, definition.description, TOOL_SCHEMAS[name].shape, async (input, extra) => {
      if (poisoned || options.signal.aborted)
        return {
          isError: true,
          content: [{ type: "text", text: "Native workspace execution has stopped." }],
        };
      const context = Context.safeParse(extra);
      const args = TOOL_SCHEMAS[name].safeParse(input);
      if (!context.success || !args.success)
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid workspace tool request." }],
        };
      const id = createHash("sha256")
        .update(JSON.stringify([runId, context.data.requestId]))
        .digest("hex");
      try {
        const reply = await options.remote.execute(
          { id, tool: name, input: args.data },
          AbortSignal.any([options.signal, context.data.signal]),
        );
        if (reply.ok)
          return {
            isError: !reply.value.ok,
            content: [{ type: "text", text: reply.value.output }],
          };
        if (reply.error.code === "execution_uncertain") uncertain();
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                reply.error.code === "execution_uncertain"
                  ? "The operation's receipt is uncertain. Native execution has stopped; it was not retried."
                  : "The workspace operation was not authorized or could not start.",
            },
          ],
        };
      } catch {
        uncertain();
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "The operation's receipt is uncertain. Native execution has stopped; it was not retried.",
            },
          ],
        };
      }
    });
  });
}
