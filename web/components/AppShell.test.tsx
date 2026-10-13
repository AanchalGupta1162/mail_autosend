import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import { AppShell } from "./AppShell";
import { resetApiState } from "@/lib/api";

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("AppShell mode indicator", () => {
  it("shows the dry-run banner and chip when the server is in dry run", async () => {
    stubFetch(() => json({ dryRun: true, followupsHeld: false }));
    render(<AppShell>page</AppShell>);
    expect(await screen.findByText(/never delivered/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=mode-chip]")).toHaveTextContent("Dry run");
  });

  it("says the mode is unknown when the dashboard cannot be loaded, instead of showing nothing", async () => {
    stubFetch(() => json({ error: "Internal server error" }, 500));
    render(<AppShell>page</AppShell>);
    expect(await screen.findByText(/mode unknown/i)).toBeInTheDocument();
    expect(screen.queryByText("Live sending")).toBeNull();
  });
});

describe("AppShell navigation", () => {
  it("marks only the current page in the main navigation", async () => {
    stubFetch(() => json({ dryRun: false, followupsHeld: false }));
    render(<AppShell>page</AppShell>);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    for (const other of ["Upload", "Contacts", "Settings"]) {
      expect(within(nav).getByRole("link", { name: other })).not.toHaveAttribute("aria-current");
    }
    expect(await screen.findByText("Live sending")).toBeInTheDocument();
  });

  it("collapses to icons and remembers it, keeping the links reachable by name", async () => {
    window.localStorage.clear();
    stubFetch(() => json({ dryRun: false, followupsHeld: false }));
    render(<AppShell>page</AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Contacts" })).toBeInTheDocument();
    expect(window.localStorage.getItem("outbox-sidebar-collapsed")).toBe("1");
    window.localStorage.clear();
  });

  it("shows who is signed in in the account menu", async () => {
    stubFetch((c) => (c.url === "/api/auth/me" ? json({ user: { id: "u", username: "aanchal" } }) : json({ dryRun: false, followupsHeld: false })));
    render(<AppShell>page</AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(await screen.findByText("aanchal")).toBeInTheDocument();
  });
});
