import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));

import { LoginForm } from "./LoginForm";
import { resetApiState } from "@/lib/api";

beforeEach(() => {
  replace.mockReset();
  resetApiState();
});
afterEach(() => vi.unstubAllGlobals());

async function submit(username = "admin", password = "secret-password") {
  const user = userEvent.setup();
  if (username) await user.type(screen.getByLabelText(/username/i), username);
  if (password) await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginForm", () => {
  it("asks for both fields before calling the server", async () => {
    const seen = stubFetch(() => json({}));
    render(<LoginForm next="/dashboard" />);
    await submit("", "");
    expect(await screen.findByRole("alert")).toHaveTextContent(/enter your username and password/i);
    expect(seen).toHaveLength(0);
  });

  it("shows one generic message for wrong credentials and clears the password", async () => {
    stubFetch(() => json({ error: "Invalid username or password" }, 401));
    render(<LoginForm next="/dashboard" />);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
    expect(screen.getByLabelText(/password/i)).toHaveValue("");
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains throttling (429) without echoing server details", async () => {
    stubFetch(() => json({ error: "Too many login attempts, try again later", debug: "ip=1.2.3.4" }, 429));
    render(<LoginForm next="/dashboard" />);
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too many sign-in attempts/i);
    expect(alert).not.toHaveTextContent(/1\.2\.3\.4/);
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    render(<LoginForm next="/dashboard" />);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/can.t reach the server/i);
  });

  it("goes to the requested page after signing in", async () => {
    const seen = stubFetch(() => json({ user: { id: "u", username: "admin" }, csrfToken: "n" }));
    render(<LoginForm next="/contacts" />);
    await submit();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/contacts"));
    expect(seen[0]).toMatchObject({ url: "/api/auth/login", method: "POST" });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ username: "admin", password: "secret-password" });
  });
});
