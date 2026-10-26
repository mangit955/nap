import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type DesktopStreamCredentials,
  LiveDesktopFrame,
  type RfbConnection,
  type RfbFactory,
} from "./live-desktop-frame.tsx";

const credentials: DesktopStreamCredentials = {
  url: "wss://desktop.invalid/private?token=secret-address",
  password: "secret-password",
};

function client() {
  return {
    viewOnly: false,
    resizeSession: true,
    scaleViewport: false,
    focusOnClick: true,
    background: "",
    qualityLevel: 0,
    compressionLevel: 0,
    addEventListener: vi.fn<RfbConnection["addEventListener"]>(),
    removeEventListener: vi.fn<RfbConnection["removeEventListener"]>(),
    disconnect: vi.fn(),
  } satisfies RfbConnection;
}

function callback(rfb: ReturnType<typeof client>, type: string) {
  const listener = rfb.addEventListener.mock.calls.find(([name]) => name === type)?.[1];
  if (!listener) throw new Error(`Missing ${type} listener`);
  return () => listener(new CustomEvent(type, { detail: credentials }));
}

function harness() {
  const clients: ReturnType<typeof client>[] = [];
  const createRfb = vi.fn<RfbFactory>(() => {
    const rfb = client();
    clients.push(rfb);
    return rfb;
  });
  return { clients, createRfb };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("connects a named, view-only remote computer and reports only status", async () => {
  const { clients, createRfb } = harness();
  const onConnectionChange = vi.fn();
  render(
    <LiveDesktopFrame
      credentials={credentials}
      quality="auto"
      createRfb={createRfb}
      onConnectionChange={onConnectionChange}
    />,
  );
  expect(screen.getByRole("application", { name: "Remote computer" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
  await waitFor(() => expect(createRfb).toHaveBeenCalledTimes(1));
  expect(createRfb).toHaveBeenCalledWith(expect.any(HTMLElement), credentials.url, {
    shared: true,
    credentials: { username: "", target: "", password: credentials.password },
  });
  const rfb = clients[0]!;
  expect(rfb).toMatchObject({
    viewOnly: true,
    resizeSession: false,
    scaleViewport: true,
    focusOnClick: false,
    qualityLevel: 6,
    compressionLevel: 2,
  });
  expect(rfb.addEventListener.mock.calls.map(([name]) => name).sort()).toEqual([
    "connect",
    "credentialsrequired",
    "disconnect",
    "securityfailure",
  ]);
  act(callback(rfb, "connect"));
  expect(screen.getByRole("status")).toHaveTextContent("Live");
  expect(screen.getByRole("application", { name: "Remote computer" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(onConnectionChange.mock.calls).toEqual([["connecting"], ["connected"]]);
  expect(screen.getByRole("application", { name: "Remote computer" })).not.toHaveTextContent(
    credentials.password,
  );
});

it("updates all quality presets without opening another connection or enabling input", async () => {
  const { clients, createRfb } = harness();
  const view = render(
    <LiveDesktopFrame credentials={credentials} quality="auto" createRfb={createRfb} />,
  );
  await waitFor(() => expect(clients).toHaveLength(1));
  const rfb = clients[0]!;
  for (const [quality, qualityLevel, compressionLevel] of [
    ["sharp", 9, 2],
    ["data-saver", 3, 6],
    ["auto", 6, 2],
  ] satisfies ["auto" | "sharp" | "data-saver", number, number][]) {
    view.rerender(
      <LiveDesktopFrame credentials={{ ...credentials }} quality={quality} createRfb={createRfb} />,
    );
    expect(rfb).toMatchObject({
      qualityLevel,
      compressionLevel,
      viewOnly: true,
      resizeSession: false,
      scaleViewport: true,
    });
  }
  expect(createRfb).toHaveBeenCalledTimes(1);
  expect(rfb.disconnect).not.toHaveBeenCalled();
});

it.each(["securityfailure", "credentialsrequired", "disconnect"])(
  "cleans up %s once, shows safe copy and retries",
  async (type) => {
    const { clients, createRfb } = harness();
    const onConnectionChange = vi.fn();
    const view = render(
      <LiveDesktopFrame
        credentials={credentials}
        quality="auto"
        createRfb={createRfb}
        onConnectionChange={onConnectionChange}
      />,
    );
    await waitFor(() => expect(clients).toHaveLength(1));
    const old = clients[0]!;
    const staleConnect = callback(old, "connect");
    const terminal = callback(old, type);
    act(terminal);
    expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
    expect(onConnectionChange).toHaveBeenLastCalledWith(
      type === "disconnect" ? "disconnected" : "failed",
    );
    expect(old.disconnect).toHaveBeenCalledTimes(1);
    expect(old.removeEventListener.mock.calls).toEqual(old.addEventListener.mock.calls);
    expect(createRfb.mock.calls[0]?.[0].isConnected).toBe(false);
    act(terminal);
    act(staleConnect);
    expect(old.disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(clients).toHaveLength(2));
    act(staleConnect);
    act(terminal);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
    act(callback(clients[1]!, "connect"));
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(onConnectionChange.mock.calls.flat()).not.toContain(credentials.password);
    view.unmount();
    expect(old.disconnect).toHaveBeenCalledTimes(1);
    expect(clients[1]?.disconnect).toHaveBeenCalledTimes(1);
  },
);

it.each(["url", "password"])(
  "replaces a changed %s and rejects every old callback",
  async (key) => {
    const { clients, createRfb } = harness();
    const onConnectionChange = vi.fn();
    const view = render(
      <LiveDesktopFrame
        credentials={credentials}
        quality="auto"
        createRfb={createRfb}
        onConnectionChange={onConnectionChange}
      />,
    );
    await waitFor(() => expect(clients).toHaveLength(1));
    const old = clients[0]!;
    const stale = ["connect", "disconnect", "securityfailure", "credentialsrequired"].map((type) =>
      callback(old, type),
    );
    act(callback(old, "connect"));
    view.rerender(
      <LiveDesktopFrame
        credentials={{
          ...credentials,
          [key]: `${credentials[key === "url" ? "url" : "password"]}-new`,
        }}
        quality="sharp"
        createRfb={createRfb}
        onConnectionChange={onConnectionChange}
      />,
    );
    await waitFor(() => expect(clients).toHaveLength(2));
    const count = onConnectionChange.mock.calls.length;
    for (const emit of stale) act(emit);
    expect(onConnectionChange).toHaveBeenCalledTimes(count);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
    expect(old.disconnect).toHaveBeenCalledTimes(1);
    expect(old.removeEventListener.mock.calls).toEqual(old.addEventListener.mock.calls);
    expect(createRfb.mock.calls[0]?.[0].isConnected).toBe(false);
    expect(createRfb.mock.calls[1]?.[0].isConnected).toBe(true);
    act(callback(clients[1]!, "connect"));
    for (const emit of stale) act(emit);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
  },
);

it("releases listeners and transport on unmount without notifying a retired parent", async () => {
  const { clients, createRfb } = harness();
  const onConnectionChange = vi.fn();
  const view = render(
    <LiveDesktopFrame
      credentials={credentials}
      quality="auto"
      createRfb={createRfb}
      onConnectionChange={onConnectionChange}
    />,
  );
  await waitFor(() => expect(clients).toHaveLength(1));
  const rfb = clients[0]!;
  const stale = ["connect", "disconnect", "securityfailure", "credentialsrequired"].map((type) =>
    callback(rfb, type),
  );
  view.unmount();
  const count = onConnectionChange.mock.calls.length;
  for (const emit of stale) act(emit);
  expect(onConnectionChange).toHaveBeenCalledTimes(count);
  expect(rfb.disconnect).toHaveBeenCalledTimes(1);
  expect(rfb.removeEventListener.mock.calls).toEqual(rfb.addEventListener.mock.calls);
});

it("uses the latest status callback without reconnecting", async () => {
  const { clients, createRfb } = harness();
  const first = vi.fn();
  const next = vi.fn();
  const view = render(
    <LiveDesktopFrame
      credentials={credentials}
      quality="auto"
      createRfb={createRfb}
      onConnectionChange={first}
    />,
  );
  await waitFor(() => expect(clients).toHaveLength(1));
  view.rerender(
    <LiveDesktopFrame
      credentials={credentials}
      quality="auto"
      createRfb={createRfb}
      onConnectionChange={next}
    />,
  );
  act(callback(clients[0]!, "connect"));
  expect(first.mock.calls).toEqual([["connecting"]]);
  expect(next.mock.calls).toEqual([["connected"]]);
  expect(createRfb).toHaveBeenCalledTimes(1);
});

it("cleans up both Strict Mode effect generations", async () => {
  const { clients, createRfb } = harness();
  const view = render(
    <StrictMode>
      <LiveDesktopFrame credentials={credentials} quality="auto" createRfb={createRfb} />
    </StrictMode>,
  );
  await waitFor(() => expect(clients.length).toBeGreaterThan(0));
  view.unmount();
  for (const rfb of clients) {
    expect(rfb.disconnect).toHaveBeenCalledTimes(1);
    expect(rfb.removeEventListener.mock.calls).toEqual(rfb.addEventListener.mock.calls);
  }
});

it("sanitizes a constructor failure and allows a local retry", async () => {
  const createRfb = vi
    .fn<RfbFactory>()
    .mockImplementationOnce(() => {
      throw new Error(`${credentials.url} ${credentials.password}`);
    })
    .mockReturnValue(client());
  const log = vi.spyOn(console, "error");
  render(<LiveDesktopFrame credentials={credentials} quality="auto" createRfb={createRfb} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
  expect(screen.getByRole("application", { name: "Remote computer" })).not.toHaveTextContent(
    credentials.password,
  );
  expect(log).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(createRfb).toHaveBeenCalledTimes(2));
});

it("ignores retired sources after a delayed factory loads and applies the latest quality", async () => {
  let resolve: (factory: RfbFactory) => void = () => {};
  const loading = new Promise<RfbFactory>((done) => {
    resolve = done;
  });
  const { clients, createRfb } = harness();
  const abandoned = render(
    <LiveDesktopFrame credentials={credentials} quality="auto" createRfb={loading} />,
  );
  abandoned.unmount();
  const view = render(
    <LiveDesktopFrame credentials={credentials} quality="auto" createRfb={loading} />,
  );
  view.rerender(
    <LiveDesktopFrame
      credentials={{ ...credentials, url: "wss://new.invalid" }}
      quality="auto"
      createRfb={loading}
    />,
  );
  view.rerender(
    <LiveDesktopFrame
      credentials={{ ...credentials, url: "wss://new.invalid" }}
      quality="data-saver"
      createRfb={loading}
    />,
  );
  expect(createRfb).not.toHaveBeenCalled();
  await act(async () => {
    resolve(createRfb);
  });
  await waitFor(() => expect(createRfb).toHaveBeenCalledTimes(1));
  expect(createRfb.mock.calls[0]?.[1]).toBe("wss://new.invalid");
  expect(clients[0]).toMatchObject({ qualityLevel: 3, compressionLevel: 6, viewOnly: true });
});

it("sanitizes a rejected factory load", async () => {
  let reject: (error: Error) => void = () => {};
  const loading = new Promise<RfbFactory>((_, fail) => {
    reject = fail;
  });
  render(<LiveDesktopFrame credentials={credentials} quality="auto" createRfb={loading} />);
  await act(async () => {
    reject(new Error(credentials.password));
  });
  expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
