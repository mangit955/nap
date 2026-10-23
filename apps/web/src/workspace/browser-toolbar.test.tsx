import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BrowserToolbar } from "./browser-toolbar.tsx";

describe("BrowserToolbar", () => {
  it("submits a normalized route and uses the committed route for the external link", () => {
    function Browser() {
      const [route, setRoute] = useState("/");
      return (
        <BrowserToolbar
          route={route}
          previewUrl="https://preview.example"
          onRouteChange={setRoute}
          onReload={() => {}}
        />
      );
    }
    render(<Browser />);
    const input = screen.getByRole("textbox", { name: "Page to show" });
    fireEvent.change(input, { target: { value: " https://other.example/settings?q=1 " } });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(input).toHaveValue("/settings?q=1");
    const link = screen.getByRole("link", { name: "Open the preview in a new tab" });
    expect(link).toHaveAttribute("href", "https://preview.example/settings?q=1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.change(input, { target: { value: "/unsaved" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("/settings?q=1");
  });
  it("reloads once without changing the route", () => {
    const onReload = vi.fn();
    const onRouteChange = vi.fn();
    render(
      <BrowserToolbar
        route="/settings"
        previewUrl="https://preview.example"
        onRouteChange={onRouteChange}
        onReload={onReload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload the preview" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onRouteChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Page to show" })).toHaveValue("/settings");
  });
  it("disables navigation until a preview is available and follows external route changes", () => {
    const props = { onRouteChange: vi.fn(), onReload: vi.fn() };
    const { rerender } = render(<BrowserToolbar {...props} route="/" previewUrl={undefined} />);
    expect(screen.getByRole("textbox", { name: "Page to show" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reload the preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    rerender(<BrowserToolbar {...props} route="/new" previewUrl="https://preview.example" />);
    expect(screen.getByRole("textbox", { name: "Page to show" })).toHaveValue("/new");
    expect(screen.getByRole("textbox", { name: "Page to show" })).toBeEnabled();
  });
});
