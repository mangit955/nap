import { describe, expect, it } from "vitest";
import { InProcessNotifyTransport } from "./in-process-notify-transport.ts";

describe("InProcessNotifyTransport", () => {
  it("delivers a notification to every listener on its channel, and only that channel", async () => {
    const transport = new InProcessNotifyTransport();
    const heard: string[] = [];
    await transport.listen("nap_session_list", (payload) => heard.push(`a:${payload}`));
    await transport.listen("nap_session_list", (payload) => heard.push(`b:${payload}`));
    await transport.listen("nap_events", (payload) => heard.push(`events:${payload}`));

    await transport.notify("nap_session_list", "user-1");

    expect(heard).toEqual(["a:user-1", "b:user-1"]);
  });

  it("stops delivering to a listener that unlistened", async () => {
    const transport = new InProcessNotifyTransport();
    const heard: string[] = [];
    const unlisten = await transport.listen("nap_session_list", (payload) => heard.push(payload));

    await unlisten();
    await transport.notify("nap_session_list", "user-1");

    expect(heard).toEqual([]);
  });
});
