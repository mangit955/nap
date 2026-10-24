import type { DesktopAction, DesktopObservation } from "@nap/shared/ports/sandbox-desktop";

export type DesktopActionHost = {
  xdotool(
    args: readonly string[],
    options?: { input?: string; signal?: AbortSignal },
  ): Promise<string>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  observe(kind: "dom" | "console"): Promise<string>;
  zoom(region: [number, number, number, number]): Promise<void>;
};
const aliases: Record<string, string> = {
  CTRL: "ctrl",
  CONTROL: "ctrl",
  ALT: "alt",
  SHIFT: "Shift_L",
  SUPER: "super",
  META: "super",
  CMD: "super",
  ENTER: "Return",
  RETURN: "Return",
  ESC: "Escape",
  ESCAPE: "Escape",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  TAB: "Tab",
  SPACE: "space",
  LEFT: "Left",
  RIGHT: "Right",
  UP: "Up",
  DOWN: "Down",
  HOME: "Home",
  END: "End",
  PAGEUP: "Prior",
  PAGEDOWN: "Next",
  PLUS: "plus",
};
const key = (text: string) =>
  text
    .split("+")
    .map((part) => aliases[part.toUpperCase()] ?? part)
    .join("+");

/** Physical input uses argv/stdin, never shell or page JavaScript. */
export async function performDesktopAction(
  action: DesktopAction,
  host: DesktopActionHost,
  signal?: AbortSignal,
): Promise<DesktopObservation> {
  signal?.throwIfAborted();
  const options = signal ? { signal } : undefined;
  const run = (args: readonly string[]) => host.xdotool(args, options);
  // Chained X11 requests retain their order. --sync hangs when the pointer is already there.
  const move = (coordinate: [number, number]) => ["mousemove", ...coordinate.map(String)];
  switch (action.action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const button =
        action.action === "right_click" ? "3" : action.action === "middle_click" ? "2" : "1";
      const count =
        action.action === "double_click" ? "2" : action.action === "triple_click" ? "3" : "1";
      await run([...move(action.coordinate), "click", "--repeat", count, "--delay", "100", button]);
      break;
    }
    case "mouse_move":
      await run(move(action.coordinate));
      break;
    case "left_mouse_down":
      await run(["mousedown", "1"]);
      break;
    case "left_mouse_up":
      await run(["mouseup", "1"]);
      break;
    case "left_click_drag":
      try {
        await run([
          ...move(action.start_coordinate),
          "mousedown",
          "1",
          ...move(action.coordinate),
          "mouseup",
          "1",
        ]);
      } finally {
        await host.xdotool(["mouseup", "1"]);
      }
      break;
    case "key":
      await run(["key", "--clearmodifiers", key(action.text)]);
      break;
    case "hold_key": {
      const chord = key(action.text);
      try {
        await run(["keydown", chord]);
        await host.sleep(action.duration * 1000, signal);
      } finally {
        await host.xdotool(["keyup", chord]);
      }
      break;
    }
    case "type":
      await host.xdotool(["type", "--clearmodifiers", "--delay", "1", "--file", "-"], {
        input: action.text,
        ...(signal ? { signal } : {}),
      });
      break;
    case "scroll": {
      const buttons = { up: "4", down: "5", left: "6", right: "7" };
      await run([
        ...(action.coordinate ? move(action.coordinate) : []),
        "click",
        "--repeat",
        String(action.scroll_amount),
        "--delay",
        "15",
        buttons[action.scroll_direction],
      ]);
      break;
    }
    case "wait":
      await host.sleep(action.duration * 1000, signal);
      break;
    case "cursor_position": {
      const output = await run(["getmouselocation", "--shell"]);
      const x = Number(output.match(/^X=(\d+)$/m)?.[1]);
      const y = Number(output.match(/^Y=(\d+)$/m)?.[1]);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= 1024 || y < 0 || y >= 768)
        throw new Error("Invalid desktop cursor response.");
      return { kind: "cursor", coordinate: [x, y] };
    }
    case "zoom":
      await host.zoom(action.region);
      break;
    case "read_dom":
      return { kind: "text", text: (await host.observe("dom")).slice(0, 120000) };
    case "console":
      return { kind: "text", text: (await host.observe("console")).slice(-120000) };
    case "screenshot":
      break;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  return { kind: "none" };
}
