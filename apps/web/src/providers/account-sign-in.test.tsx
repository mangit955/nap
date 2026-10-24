import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AccountSignIn } from "./account-sign-in.tsx";

const flowId = "00000000-0000-4000-8000-000000000001";
const account: ProviderAccountView = {
  id: "00000000-0000-4000-8000-000000000002",
  driver: "claude",
  label: null,
  enabled: true,
  auth: { status: "unauthenticated", email: null, plan: null },
  createdAt: "2026-10-24T00:00:00Z",
  signIn: {
    flowId,
    phase: "waiting",
    interaction: { type: "terminal", output: "Open the provider's login page", input: "code" },
    message: null,
  },
};
it("privately submits one terminal code for the current flow and clears it before the request finishes", async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onSubmitCode = vi.fn(async () => {
    await pending;
    return { ok: true as const, value: null };
  });
  const unused = async () => ({ ok: true as const, value: null });
  render(
    <AccountSignIn
      account={account}
      signInAvailable
      onStart={unused}
      onCancel={unused}
      onComplete={unused}
      onSubmitCode={onSubmitCode}
      onSignOut={unused}
    />,
  );
  const code = screen.getByLabelText("Sign-in code");
  expect(code).toHaveAttribute("type", "password");
  expect(code).toHaveAttribute("autoComplete", "off");
  expect(screen.getByRole("button", { name: "Submit sign-in code" })).toBeDisabled();
  fireEvent.change(code, { target: { value: "  fixture-code#state  " } });
  fireEvent.click(screen.getByRole("button", { name: "Submit sign-in code" }));
  expect(onSubmitCode).toHaveBeenCalledWith({ flowId, code: "fixture-code#state" });
  expect(code).toHaveValue("");
  expect(screen.getByRole("button", { name: "Submit sign-in code" })).toBeDisabled();
  finish();
  await waitFor(() => expect(code).not.toBeDisabled());
  expect(onSubmitCode).toHaveBeenCalledTimes(1);
});
it("keeps noninteractive terminal output read-only and drops a code when its flow is replaced", () => {
  const unused = async () => ({ ok: true as const, value: null });
  const props = {
    signInAvailable: true,
    onStart: unused,
    onCancel: unused,
    onComplete: unused,
    onSubmitCode: unused,
    onSignOut: unused,
  };
  const { rerender } = render(<AccountSignIn {...props} account={account} />);
  fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "old-flow-code" } });
  rerender(
    <AccountSignIn
      {...props}
      account={{ ...account, signIn: { ...account.signIn!, flowId: crypto.randomUUID() } }}
    />,
  );
  expect(screen.getByLabelText("Sign-in code")).toHaveValue("");
  rerender(
    <AccountSignIn
      {...props}
      account={{
        ...account,
        signIn: {
          flowId,
          phase: "waiting",
          interaction: { type: "terminal", output: "Waiting for provider status" },
          message: null,
        },
      }}
    />,
  );
  expect(screen.queryByLabelText("Sign-in code")).not.toBeInTheDocument();
});
