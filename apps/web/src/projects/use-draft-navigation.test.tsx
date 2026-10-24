import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SAVE_DEADLINE_MS, useDraftNavigation } from "./use-draft-navigation.ts";

function pendingWrite() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Page({
  save,
  navigate,
  onError = vi.fn(),
}: {
  save: () => Promise<void>;
  navigate: (href: string) => void;
  onError?: () => void;
}) {
  useDraftNavigation(save, onError, navigate);
  return <a href="/p/next">Next session</a>;
}

it("holds a real anchor navigation until the latest draft finishes saving", async () => {
  const write = pendingWrite();
  const save = vi.fn(() => write.promise);
  const navigate = vi.fn();
  const view = render(<Page save={async () => {}} navigate={navigate} />);
  view.rerender(<Page save={save} navigate={navigate} />);
  expect(fireEvent.click(screen.getByRole("link"))).toBe(false);
  fireEvent.click(screen.getByRole("link"));
  expect(save).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => write.resolve());
  expect(navigate).toHaveBeenCalledWith(new URL("/p/next", window.location.href).href);
});

it("stays on the page after a failed save and permits retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Storage full"))
    .mockResolvedValue(undefined);
  const navigate = vi.fn();
  const onError = vi.fn();
  render(<Page save={save} navigate={navigate} onError={onError} />);
  fireEvent.click(screen.getByRole("link"));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link"));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
});

it("does not follow a pending link after the composer unmounts", async () => {
  const write = pendingWrite();
  const navigate = vi.fn();
  const view = render(<Page save={() => write.promise} navigate={navigate} />);
  fireEvent.click(screen.getByRole("link"));
  view.unmount();
  await act(async () => write.resolve());
  expect(navigate).not.toHaveBeenCalled();
});

it("leaves modified, cancelled, download, other-target and fragment links alone", () => {
  const save = vi.fn(async () => {});
  render(<Page save={save} navigate={vi.fn()} />);
  const link = screen.getByRole("link");
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ])
    fireEvent.click(link, options);
  link.setAttribute("download", "");
  fireEvent.click(link);
  link.removeAttribute("download");
  link.setAttribute("target", "_blank");
  fireEvent.click(link);
  link.removeAttribute("target");
  link.setAttribute("href", "#section");
  fireEvent.click(link);
  link.setAttribute("href", "mailto:help@example.com");
  fireEvent.click(link);
  link.setAttribute("href", "/p/next");
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  fireEvent.click(link);
  expect(save).not.toHaveBeenCalled();
});

it("reports a save that never settles instead of swallowing every later click", async () => {
  vi.useFakeTimers();
  try {
    const save = vi
      .fn()
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockResolvedValue(undefined);
    const navigate = vi.fn();
    const onError = vi.fn();
    render(<Page save={save} navigate={navigate} onError={onError} />);
    fireEvent.click(screen.getByRole("link"));
    await act(async () => vi.advanceTimersByTime(SAVE_DEADLINE_MS));
    expect(onError).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link"));
    await act(async () => {});
    expect(navigate).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
